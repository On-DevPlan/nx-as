import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function NginxView() {
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [raw, setRaw] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [msg, setMsg] = useState(null); // {type:'ok'|'err', text}
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [st, cf] = await Promise.all([api('GET', '/api/nginx'), api('GET', '/api/nginx/config')]);
      setStatus(st);
      setCfg(cf);
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const apply = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = advanced
        ? { rawConfig: raw }
        : { domain: cfg.domain, certPath: cfg.certPath, keyPath: cfg.keyPath, managedPath: cfg.managedPath };
      const r = await api('POST', '/api/nginx/apply', body);
      setMsg({ type: 'ok', text: `已生效: ${r.domain || r.managedPath}（nginx -t 通过 + graceful reload）` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const rollback = async () => {
    if (!confirm('回滚到上一版托管配置并 reload？')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/nginx/rollback');
      setMsg({ type: 'ok', text: `已回滚: ${r.rolledBackTo}` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const rotate = async () => {
    if (!confirm('轮换机机密码？运行中的 pi-web 需要重启才能用新密码。')) return;
    try {
      const r = await api('POST', '/api/nginx/rotate-secret');
      setMsg({ type: 'ok', text: r.note });
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  };

  if (!status || !cfg) return <Card title="nginx">加载中{msg?.type === 'err' ? ` — ${msg.text}` : ''}</Card>;

  const notLinux = status.platform !== 'linux';
  const sudoOk = status.sudoers === 'ok';

  return (
    <Card title="nginx 托管">
      <Row label="平台"><span className="mono">{status.platform}{notLinux && '  (nginx 管理仅支持 Linux 服务器)'}</span></Row>
      <Row label="nginx 服务"><span className="mono">{status.nginx?.service ?? '?'}</span></Row>
      <Row label="sudoers">
        <span className={sudoOk ? '' : 'bad'}>{status.sudoers ?? '?'}</span>
        {!sudoOk && <span className="mid">  — 服务器上执行 <code>nx-as nginx setup</code> 按引导授权</span>}
      </Row>
      <Row label="托管文件"><span className="mono">{status.managedPath}</span></Row>
      <Row label="配置漂移">
        <span className={status.drifted ? 'bad' : ''}>
          {status.drifted === null ? 'n/a' : status.drifted ? '是（磁盘≠模板，Apply 收敛）' : '否'}
        </span>
      </Row>

      <div className="colhead">配置</div>
      {!advanced && (
        <>
          <Row label="domain"><Input value={cfg.domain || ''} onChange={(v) => setCfg({ ...cfg, domain: v })} placeholder="agent.example.com" /></Row>
          <Row label="证书路径"><Input value={cfg.certPath || ''} onChange={(v) => setCfg({ ...cfg, certPath: v })} placeholder="/etc/letsencrypt/live/.../fullchain.pem" /></Row>
          <Row label="私钥路径"><Input value={cfg.keyPath || ''} onChange={(v) => setCfg({ ...cfg, keyPath: v })} placeholder="/etc/letsencrypt/live/.../privkey.pem" /></Row>
        </>
      )}
      <Row label="高级模式">
        <input type="checkbox" checked={advanced} onChange={(e) => { setAdvanced(e.target.checked); if (e.target.checked && !raw) api('GET', '/api/nginx/config?preview=1').then((c) => setRaw(c.rendered || '')).catch(() => {}); }} />
        <span className="mid">  整文件编辑托管 conf（保存前仍强制 nginx -t + 失败回滚）</span>
      </Row>
      {advanced && (
        <Row label="托管 conf">
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={18} style={{ width: '100%', fontFamily: 'monospace' }} />
        </Row>
      )}

      <Row label="">
        <Btn onClick={apply} disabled={busy || notLinux}>Apply（nginx -t + reload）</Btn>
        <Btn onClick={rollback} disabled={busy || notLinux}>回滚上一版</Btn>
        <Btn onClick={rotate} disabled={busy || notLinux}>轮换机机密码</Btn>
        {busy && <span className="mid">执行中…</span>}
      </Row>
      {msg && <Row label={msg.type === 'ok' ? '结果' : '错误'}><span className={msg.type === 'ok' ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span></Row>}

      <Row label="">
        <span className="mid">数据路径（/m/v1/*）由 nginx 直代 pi-web；鉴权经 auth_request 委托本服务 /auth/check。托管边界：仅 {status.managedPath} 一个文件。</span>
      </Row>
    </Card>
  );
}
