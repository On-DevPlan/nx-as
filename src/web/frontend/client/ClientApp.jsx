import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Btn, Input, Row } from '../components/ui.jsx';
import { api } from './api.js';

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// nx-as client 面板：只做一件事——协调 gost 内网穿透的注册管理
// 主体是「对账表」：本地清单 ∪ server 清单按名称对齐，每条标注 两侧✓ / 仅server / 仅本地。
// 边界：不代理 server 面板（nginx 管理/设备/审计都在 server 侧）；
//       不需要注册穿透时 client 完全不必存在（按需启动，用完即走）。
function ClientApp() {
  const [cfg, setCfg] = useState(null);
  const [recon, setRecon] = useState(null);
  const [doctor, setDoctor] = useState(null);
  const [form, setForm] = useState({ name: '', local: '', public: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, rc] = await Promise.all([
        api('GET', '/api/client/config'),
        api('GET', '/api/client/reconcile'),
      ]);
      setCfg(c);
      setRecon(rc);
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

  if (!cfg || !recon) return <Card title="nx-as client">加载中{msg?.type === 'err' ? ` — ${msg.text}` : ''}</Card>;

  const has = (row) => row.localSide && row.serverSide;

  return (
    <>
      <header>
        <span className="brand">nx-as <span className="tag strong">client</span></span>
      </header>
      <main style={{ maxWidth: 960 }}>

        <Card title="穿透隧道（本地 ∪ server 对账）">
          <Row label="图例">
            <span className="mid">
              <span className="tag strong">两侧✓</span> 完整穿透（nginx 鉴权 + 本地 gost）
              <span className="tag">仅server</span> 有 nginx 鉴权、本地未接管（注册同名即接管）
              <span className="tag">仅本地</span> gost 在转发但 server 无鉴权配置（补一键注册即修复）
            </span>
          </Row>
          {recon.serverError && (
            <Row label="server"><span className="bad">拉取失败：{recon.serverError}</span></Row>
          )}
          <div className="dev-table">
            <div className="dev-row dev-head">
              <span>名称</span><span>状态</span><span>方向</span><span>server</span><span>打开</span><span>操作</span>
            </div>
            {recon.rows.length === 0 && (
              <div className="dev-row"><span className="mid">暂无隧道——下方表单注册第一条</span></div>
            )}
            {recon.rows.map((t) => (
              <div className="dev-row" key={t.name}>
                <span><code>{t.name}</code></span>
                <span>
                  {has(t) ? <span className="tag strong">两侧✓</span>
                    : t.serverSide ? <span className="tag">仅server</span>
                      : <span className="tag bad">仅本地</span>}
                  {t.enabled === false && <span className="tag bad">已停用</span>}
                </span>
                <span className="mid">
                  {t.localSide ? <>本地:{t.local} → </> : <span className="mid">本地未接管 → </span>}
                  公网:{t.public ?? '?'}
                  {t.portConflict && <span className="bad">（两侧端口不一致！server:{t.portConflict.server} / 本地:{t.portConflict.local}）</span>}
                </span>
                <span className="mid">{t.serverSide ? '鉴权 ✓' : '—'}</span>
                <span>
                  {t.url && t.enabled !== false && t.localSide
                    ? <a className="btn" href={`http://${t.url}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>打开 ↗</a>
                    : null}
                </span>
                <span className="dev-act">
                  {!t.localSide && (
                    <Btn onClick={() => act(
                      () => api('POST', '/api/client/register', { name: t.name, local: t.public ?? 80 }),
                      (r) => `已接管 ${t.name}（本地:${r.tunnel.local} → 公网:${r.tunnel.public}，默认本地端口=公网端口，可注销后重注册改）`,
                    )} disabled={busy}>接管</Btn>
                  )}
                  {!t.serverSide && (
                    <Btn onClick={() => act(
                      () => api('POST', '/api/client/register', { name: t.name, local: t.local, 'public-port': t.public }),
                      (r) => `已补 server 鉴权配置：${r.url || ''}`,
                    )} disabled={busy}>补注册</Btn>
                  )}
                  {t.localSide && (
                    <Btn className="danger" onClick={() => {
                      if (!confirm(`注销 ${t.name}？（本地 gost -L 与 server 鉴权配置一起删除）`)) return;
                      act(() => api('POST', '/api/client/unregister', { name: t.name }), `已注销 ${t.name}`);
                    }} disabled={busy}>注销</Btn>
                  )}
                </span>
              </div>
            ))}
          </div>
          <Row label="">
            {recon.gost && (
              <>
                <Btn onClick={() => act(() => api('POST', '/api/client/gost/start'), 'gost 已启动')} disabled={busy || recon.gost.running}>启动 gost</Btn>
                <Btn onClick={() => act(() => api('POST', '/api/client/gost/stop'), 'gost 已停止')} disabled={busy || !recon.gost.running}>停止 gost</Btn>
                <span className="mid">{recon.gost.running ? `运行中 pid ${recon.gost.pid} · ${recon.gost.tunnels} 条 -L` : `未运行（二进制 ${recon.gost.bin}）——「两侧✓/仅本地」的隧道需要 gost 在跑才通`}</span>
              </>
            )}
          </Row>
        </Card>

        <Card title="注册新隧道">
          <Row label="说明">
            <span className="mid">方向永远是 本地服务 → 公网端口。例：名称 sqlh、本地 7877 → 外部访问 http://server:7877（鉴权后到本地 7877）。公网端口需在 server 安全组放行。</span>
          </Row>
          <Row label="注册">
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="名称（sqlh）" style={{ width: 120 }} />
            <Input value={form.local} onChange={(v) => setForm({ ...form, local: v })} placeholder="本地端口 7877" style={{ width: 140 }} />
            <Input value={form.public} onChange={(v) => setForm({ ...form, public: v })} placeholder="公网端口（默认同本地）" style={{ width: 180 }} />
            <Btn onClick={() => act(
              () => api('POST', '/api/client/register', { name: form.name, local: Number(form.local), 'public-port': form.public ? Number(form.public) : undefined }),
              (r) => `已注册 ${r.tunnel.name}（本地:${r.tunnel.local} → 公网:${r.tunnel.public}）${r.tunnel.adopted ? '——接管了既有同名条目' : ''}`,
            )} disabled={busy || !form.name || !form.local}>一键注册（server + gost）</Btn>
          </Row>
        </Card>

        <Card title="连接配置（server / relay）">
          <Row label="server API"><Input value={cfg.server || ''} onChange={(v) => setCfg({ ...cfg, server: v })} placeholder="http://47.x.x.x:8090/_nxas（nginx 模式必须带 /_nxas）" /></Row>
          <Row label="token"><Input value={cfg.token || ''} onChange={(v) => setCfg({ ...cfg, token: v })} placeholder="server 的管理密钥" /></Row>
          <Row label="relay"><Input value={cfg.relay || ''} onChange={(v) => setCfg({ ...cfg, relay: v })} placeholder="relay://用户:密码@server:8442" /></Row>
          <Row label="gost 路径"><Input value={cfg.gostBin || ''} onChange={(v) => setCfg({ ...cfg, gostBin: v })} placeholder="gost（PATH）或绝对路径" /></Row>
          <Row label="">
            <Btn onClick={() => act(() => api('POST', '/api/client/config', { server: cfg.server, token: cfg.token, relay: cfg.relay, 'gost-bin': cfg.gostBin }), '连接配置已保存')}
                 disabled={busy}>保存配置</Btn>
            <Btn onClick={async () => {
              const r = await act(() => api('GET', '/api/client/doctor'));
              if (r) setDoctor(r);
            }} disabled={busy}>自检（doctor）</Btn>
            {doctor && <span className="mid">server: {doctor.server} · gost: {doctor.gostBin}</span>}
          </Row>
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
