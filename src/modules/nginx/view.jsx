import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function NginxView() {
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [tpl, setTpl] = useState('');
  const [rendered, setRendered] = useState('');
  const [showRendered, setShowRendered] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const isContainer = cfg?.mode === 'container';

  const refresh = useCallback(async () => {
    try {
      const [st, cf] = await Promise.all([api('GET', '/api/nginx'), api('GET', '/api/nginx/config')]);
      setStatus(st);
      setCfg(cf);
      if (cf.mode === 'container') {
        setTpl(cf.template || '');
        setRendered(cf.rendered || '');
      }
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const apply = async () => {
    setBusy(true); setMsg(null);
    try {
      // 容器模式：整文件模板；宿主模式：domain/certPath 表单
      const body = isContainer ? { template: tpl } : { domain: cfg.domain, certPath: cfg.certPath, keyPath: cfg.keyPath };
      const r = await api('POST', '/api/nginx/apply', body);
      setMsg({ type: 'ok', text: isContainer
        ? `已生效：模板已写入并渲染（nginx -t 通过 + reload）`
        : `已生效: ${r.domain}（nginx -t 通过 + graceful reload）` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const rollback = async () => {
    if (!confirm('回滚到上一版配置并 reload？')) return;
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

  // ── 容器模式：直接编辑生效模板 ──
  if (isContainer) {
    return (
      <Card title="nginx 配置（容器模式）">
        <Row label="平台"><span className="mono">{status.platform}</span></Row>
        <Row label="模板（可编辑）"><span className="mono">{cfg.templatePath}</span></Row>
        <Row label="生效配置（渲染后）"><span className="mono">{cfg.renderedPath}</span></Row>

        <div className="colhead">nginx.conf 模板</div>
        <Row label="说明">
          <span className="mid">
            变量：<code>{'${NXAS_LISTEN_PORT}'}</code> <code>{'${NXAS_API_PORT}'}</code> <code>{'${NXAS_TARGET_PORT}'}</code>{' '}
            <code>{'${NXAS_MACHINE_B64}'}</code> <code>{'${NXAS_TLS_BLOCK}'}</code> <code>{'${NXAS_PROTECT_BLOCKS}'}</code>{' '}
            <code>{'${NXAS_CATCHALL_BODY}'}</code>；nginx 自身变量（<code>$host</code> 等）原样保留
          </span>
        </Row>
        <Row label="模板">
          <textarea value={tpl} onChange={(e) => setTpl(e.target.value)} rows={20}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} />
        </Row>

        <Row label="">
          <Btn onClick={apply} disabled={busy}>Apply（nginx -t + reload）</Btn>
          <Btn onClick={rollback} disabled={busy}>回滚上一版</Btn>
          <Btn onClick={() => setShowRendered((v) => !v)}>{showRendered ? '隐藏' : '查看'}生效配置</Btn>
          {busy && <span className="mid">执行中…</span>}
        </Row>

        {showRendered && (
          <>
            <div className="colhead">生效配置（只读，渲染产物）</div>
            <Row label="">
              <textarea value={rendered} readOnly rows={18}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', background: '#f6f6f6' }} />
            </Row>
          </>
        )}

        {msg && <Row label={msg.type === 'ok' ? '结果' : '错误'}><span className={msg.type === 'ok' ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span></Row>}

        <Row label="">
          <span className="mid">
            改模板 → Apply（自动 nginx -t，失败回滚）→ 立即生效。模板经卷挂载持久化，容器重建不丢。
          </span>
        </Row>
      </Card>
    );
  }

  // ── 宿主模式：domain/证书表单（原逻辑） ──
  return (
    <Card title="nginx 托管">
      <Row label="平台"><span className="mono">{status.platform}</span></Row>
      <Row label="nginx 服务"><span className="mono">{status.nginx?.service ?? '?'}</span></Row>
      <Row label="sudoers"><span className={status.sudoers === 'ok' ? '' : 'bad'}>{status.sudoers ?? '?'}</span></Row>
      <Row label="托管文件"><span className="mono">{status.managedPath}</span></Row>

      <div className="colhead">配置</div>
      <Row label="domain"><Input value={cfg.domain || ''} onChange={(v) => setCfg({ ...cfg, domain: v })} placeholder="agent.example.com" /></Row>
      <Row label="证书路径"><Input value={cfg.certPath || ''} onChange={(v) => setCfg({ ...cfg, certPath: v })} /></Row>
      <Row label="私钥路径"><Input value={cfg.keyPath || ''} onChange={(v) => setCfg({ ...cfg, keyPath: v })} /></Row>

      <Row label="">
        <Btn onClick={apply} disabled={busy}>Apply（nginx -t + reload）</Btn>
        <Btn onClick={rollback} disabled={busy}>回滚上一版</Btn>
        <Btn onClick={rotate} disabled={busy}>轮换机机密码</Btn>
      </Row>
      {msg && <Row label={msg.type === 'ok' ? '结果' : '错误'}><span className={msg.type === 'ok' ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span></Row>}
    </Card>
  );
}
