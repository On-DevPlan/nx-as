import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Btn, Input, Row } from '../components/ui.jsx';
import { api } from './api.js';

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// nx-as client 面板：只做一件事——协调 gost 内网穿透的注册管理
// （连接 server 填配置 / 本地隧道注册与启停 / server 侧隧道清单对账）
// 边界：不代理 server 面板（nginx 管理/设备/审计都在 47 的 server 面板）；
//       不需要注册穿透时 client 完全不必存在（按需启动，用完即走）
function ClientApp() {
  const [cfg, setCfg] = useState(null);
  const [tunnels, setTunnels] = useState(null);
  const [gost, setGost] = useState(null);
  const [remote, setRemote] = useState(null);
  const [doctor, setDoctor] = useState(null);
  const [form, setForm] = useState({ name: '', local: '', public: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, t, r] = await Promise.all([
        api('GET', '/api/client/config'),
        api('GET', '/api/client/tunnels'),
        api('GET', '/api/client/remote').catch(() => null),
      ]);
      setCfg(c);
      setTunnels(t);
      setRemote(r);
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (okText) setMsg({ type: 'ok', text: typeof okText === 'function' ? okText(r) : okText });
      await refresh();
      return r;
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  if (!cfg) return <Card title="nx-as client">加载中{msg?.type === 'err' ? ` — ${msg.text}` : ''}</Card>;

  return (
    <>
      <header>
        <span className="brand">nx-as <span className="tag strong">client</span></span>
      </header>
      <main style={{ maxWidth: 960 }}>

        <Card title="连接配置（server / relay）">
          <Row label="server API"><Input value={cfg.server || ''} onChange={(v) => setCfg({ ...cfg, server: v })} placeholder="http://47.110.80.47:8090/_nxas" /></Row>
          <Row label="token"><Input value={cfg.token || ''} onChange={(v) => setCfg({ ...cfg, token: v })} placeholder="管理密钥（nxas_admin_...）" /></Row>
          <Row label="relay"><Input value={cfg.relay || ''} onChange={(v) => setCfg({ ...cfg, relay: v })} placeholder="relay://gost:<密码>@47.110.80.47:8442" /></Row>
          <Row label="gost 路径"><Input value={cfg.gostBin || ''} onChange={(v) => setCfg({ ...cfg, gostBin: v })} placeholder="gost（PATH）或绝对路径" /></Row>
          <Row label="">
            <Btn onClick={() => act(() => api('POST', '/api/client/config', { server: cfg.server, token: cfg.token, relay: cfg.relay, 'gost-bin': cfg.gostBin }), '连接配置已保存')}
                 disabled={busy}>保存配置</Btn>
            <Btn onClick={async () => {
              const r = await act(() => api('GET', '/api/client/doctor'));
              if (r) setDoctor(r);
            }} disabled={busy}>自检（doctor）</Btn>
            {doctor && (
              <span className="mid">
                server: {doctor.server} · gost: {doctor.gostBin}
              </span>
            )}
          </Row>
        </Card>

        <Card title="本地隧道（穿透注册）">
          <div className="dev-table">
            <div className="dev-row dev-head">
              <span>名称</span><span>本地端口</span><span>公网端口</span><span>gost</span><span></span>
            </div>
            {(tunnels?.tunnels || []).length === 0 && (
              <div className="dev-row"><span className="mid">暂无隧道——下方表单注册第一条</span></div>
            )}
            {(tunnels?.tunnels || []).map((t) => (
              <div className="dev-row" key={t.name}>
                <span><code>{t.name}</code></span>
                <span>{t.local}</span>
                <span>{t.public}</span>
                <span className="mid">{t.gostRunning ? `pid ${t.gostPid}` : '未运行'}</span>
                <span className="dev-act">
                  <Btn onClick={() => act(() => api('POST', '/api/client/unregister', { name: t.name }), `已注销 ${t.name}`)}
                       disabled={busy}>注销</Btn>
                </span>
              </div>
            ))}
          </div>
          <Row label="注册">
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="名称（sqlh）" style={{ width: 110 }} />
            <Input value={form.local} onChange={(v) => setForm({ ...form, local: v })} placeholder="本地端口 7877" style={{ width: 130 }} />
            <Input value={form['public']} onChange={(v) => setForm({ ...form, public: v })} placeholder="公网端口（默认同本地）" style={{ width: 170 }} />
            <Btn onClick={() => act(
              () => api('POST', '/api/client/register', { name: form.name, local: Number(form.local), 'public-port': form.public ? Number(form.public) : undefined }),
              (r) => `已注册 ${r.tunnel.name}：${r.url || ''}（server conf + 本地 gost 已生效）`,
            )} disabled={busy || !form.name || !form.local}>一键注册（server + gost）</Btn>
          </Row>
          <Row label="">
            {gost && (
              <>
                <Btn onClick={() => act(() => api('POST', '/api/client/gost/start'), 'gost 已启动')} disabled={busy || gost.running}>启动 gost</Btn>
                <Btn onClick={() => act(() => api('POST', '/api/client/gost/stop'), 'gost 已停止')} disabled={busy || !gost.running}>停止 gost</Btn>
                <span className="mid">{gost.running ? `运行中 pid ${gost.pid} · ${gost.tunnels} 条 -L` : `未运行（二进制 ${gost.bin}）`}</span>
              </>
            )}
          </Row>
        </Card>

        <Card title="server 侧注册（对账清单）">
          <Row label="边界">
            <span className="mid">这里只读对账：client 仅协调 gost 穿透注册。nginx 管理/设备/审计都在 server 面板（47:8090），client 不代劳。</span>
          </Row>
          {remote === null && <Row label=""><span className="mid">无法拉取（先保存连接配置）</span></Row>}
          {remote && remote.tunnels.length === 0 && <Row label=""><span className="mid">server 侧暂无 nxas-tunnel-*.conf</span></Row>}
          {remote && remote.tunnels.map((t) => (
            <Row label="" key={t.name}>
              <span className={`tag ${t.enabled ? 'strong' : ''}`}>{t.enabled ? '·' : '×'} {t.name}</span>
              <span className="mid">公网:{t.public || '?'}</span>
              {t.url && <a className="btn" href={`http://${t.url}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>打开隧道服务 ↗</a>}
              <span className="mid">{fmtTime(t.mtimeMs)}</span>
            </Row>
          ))}
        </Card>

        {msg && (
          <Card>
            <Row label={msg.type === 'ok' ? '结果' : '错误'}>
              <span className={msg.type === 'ok' ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
            </Row>
          </Card>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<ClientApp />);
