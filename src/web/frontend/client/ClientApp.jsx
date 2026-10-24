import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Btn, Input, Row } from '../components/ui.jsx';
import { api } from './api.js';

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// nx-as client 面板：只做一件事——协调 gost 内网穿透的注册管理
// 主体是「对账表」：本地清单 ∪ server 清单按名称对齐，每条标注 通 / 仅 server / 仅本地。
// 边界：不代理 server 面板（nginx 管理/设备/审计都在 server 侧）；
//       不需要注册穿透时 client 完全不必存在（按需启动，用完即走）。
function ClientApp() {
  const [cfg, setCfg] = useState(null);
  const [recon, setRecon] = useState(null);
  const [doctor, setDoctor] = useState(null);
  const [form, setForm] = useState({ name: '', local: '', public: '', adv: false });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  // 三步向导步：0 = 等首份 cfg 定初始步（已存过 server 的直接从第 2 步开始）；
  // 保存成功 → 2；配对成功 → 3，refresh 回来 cfg.paired=true 整卡隐藏
  const [step, setStep] = useState(0);

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
  // 初始步只随首份 cfg 定一次（不随输入重推，避免打字时跳步）
  useEffect(() => { if (cfg && step === 0) setStep(cfg.server ? 2 : 1); }, [cfg, step]);

  const act = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (okText) setMsg({ type: 'ok', text: typeof okText === 'function' ? okText(r) : okText });
      await refresh();
      return r;
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  // 初始加载失败不再死等整页刷新：错误 + 重试（复用 refresh）就地可行动
  if (!cfg || !recon) {
    const loadErr = msg?.type === 'err';
    return (
      <Card title="nx-as client">加载中{loadErr ? ` — ${msg.text}` : ''}
        {loadErr && (
          <Row label="">
            <Btn onClick={() => { setMsg(null); refresh(); }}>重试</Btn>
            <span className="mid">初始加载失败——服务恢复后点重试，无需整页刷新</span>
          </Row>
        )}
      </Card>
    );
  }

  const has = (row) => row.localSide && row.serverSide;

  return (
    <>
      <header>
        <span className="brand">nx-as <span className="tag strong">client</span></span>
      </header>
      <main style={{ maxWidth: 960 }}>

        {!cfg.paired && (
          <Card title="开始内网穿透（3 步）">
            <Row label="步骤">
              <span className={`tag ${step === 1 ? 'strong' : ''}`}>① 服务器地址</span>
              <span className={`tag ${step === 2 ? 'strong' : ''}`}>② 配对登录</span>
              <span className={`tag ${step === 3 ? 'strong' : ''}`}>③ 已配对</span>
            </Row>
            {step === 1 && (
              <>
                <Row label="① 服务器">
                  <Input value={cfg.server || ''} onChange={(v) => setCfg({ ...cfg, server: v })} placeholder="http://服务器:8090/_nxas" style={{ width: 260 }} />
                  <Btn onClick={async () => {
                    const r = await act(() => api('POST', '/api/client/config', { server: cfg.server }), '已保存服务器地址');
                    if (r) setStep(2);
                  }} disabled={busy || !cfg.server}>保存</Btn>
                </Row>
                <Row label="">
                  <span className="mid">前提：部署 gost-as 容器 + 在 go-ah 注册 client（nx-as oidc register）——只需一次</span>
                </Row>
              </>
            )}
            {step === 2 && (
              <Row label="② 配对">
                <Btn onClick={async () => {
                  const r = await act(
                    () => api('POST', '/api/client/login', { server: cfg.server }),
                    (r) => `已配对（${r.identity?.email || ''}）——可以注册穿透了`,
                  );
                  if (r) setStep(3);
                }} disabled={busy || !cfg.server}>配对登录（浏览器跳 go-ah）</Btn>
                <span className="mid">浏览器完成 go-ah 登录后自动回到这里，无需贴 token</span>
              </Row>
            )}
            {step === 3 && (
              <Row label="③ 完成">
                <span className="tag strong">已配对</span>
                <span className="mid">去下方「注册新隧道」注册第一条穿透</span>
              </Row>
            )}
            <Row label="">
              <span className="mid">{'也可以直接命令行一条龙：nx-as tunnel add <名> <本地端口>'}</span>
            </Row>
          </Card>
        )}

        <Card title="穿透隧道（本地 ∪ server 对账）">
          <Row label="状态说明">
            <span className="mid">通 = nginx 鉴权 + 本地转发都在；仅 server = 缺本地接管；仅本地 = 缺 server 鉴权（点补注册修复）</span>
          </Row>
          {recon.serverError && (
            <Row label="server">
              <span className="bad">拉取失败：{recon.serverError}</span>
              <span className="mid">检查 server 地址与网络连通；会话过期就重新「配对登录」，改完点下方「保存配置」再试</span>
            </Row>
          )}
          <div className="dev-table">
            <div className="dev-row dev-head">
              <span>名称</span><span>状态</span><span>方向</span><span>鉴权</span><span>打开</span><span>操作</span>
            </div>
            {recon.rows.length === 0 && (
              <div className="dev-row"><span className="mid">暂无隧道——下方表单注册第一条</span></div>
            )}
            {recon.rows.map((t) => (
              <div className="dev-row" key={t.name}>
                <span><code>{t.name}</code></span>
                <span>
                  {has(t) ? <span className="tag strong">通</span>
                    : t.serverSide ? <span className="mid">仅 server</span>
                      : <span className="bad">仅本地</span>}
                  {t.enabled === false && <span className="bad">已停用</span>}
                </span>
                <span className="mid">
                  {t.localSide ? <>本地:{t.local} → </> : <span className="mid">本地未接管 → </span>}
                  公网:{t.public ?? '?'}
                  {t.portConflict && <span className="bad">（两侧端口不一致！server:{t.portConflict.server} / 本地:{t.portConflict.local}）</span>}
                </span>
                <span className="mid">{t.serverSide ? '有' : '无'}</span>
                <span>
                  {t.url && t.enabled !== false && t.localSide
                    ? <a className="btn" href={`http://${t.url}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>打开</a>
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
                <span className="mid">{recon.gost.running ? `运行中（${recon.gost.tunnels} 条）` : `未运行（二进制 ${recon.gost.bin}）——「通/仅本地」的隧道需要 gost 在跑才通`}</span>
              </>
            )}
          </Row>
        </Card>

        <Card title="注册新隧道">
          <Row label="说明">
            <span className="mid">本地服务 → 公网同端口。例：sqlh / 7877 → http://服务器:7877（鉴权后到本地 7877；安全组需放行该端口）</span>
          </Row>
          <Row label="注册">
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="名称（sqlh）" style={{ width: 120 }} />
            <Input value={form.local} onChange={(v) => setForm({ ...form, local: v })} placeholder="本地端口" style={{ width: 110 }} />
            {form.adv ? (
              <Input value={form.public} onChange={(v) => setForm({ ...form, public: v })} placeholder="公网端口" style={{ width: 110 }} />
            ) : (
              <Btn onClick={() => setForm({ ...form, adv: true })} disabled={busy}>改公网端口</Btn>
            )}
            <Btn onClick={() => act(
              () => api('POST', '/api/client/register', { name: form.name, local: Number(form.local), 'public-port': form.public ? Number(form.public) : undefined }),
              (r) => `已注册 ${r.tunnel.name}（本地:${r.tunnel.local} → 公网:${r.tunnel.public}）${r.tunnel.adopted ? '——接管了既有同名条目' : ''}`,
            )} disabled={busy || !form.name || !form.local}>注册穿透</Btn>
            <span className="mid">公网端口默认同本地端口</span>
          </Row>
        </Card>

        <Card title="连接配置（relay / gost / 配对状态）">
          <Row label="server"><span className="mono">{cfg.server || '(未配置——见上方三步)'}</span></Row>
          <Row label="配对">
            {cfg.paired
              ? <span className="tag strong">已配对 · {cfg.identity?.email || cfg.identity?.sub || 'SSO 会话'}</span>
              : <span className="tag">未配对</span>}
            {' '}
            <Btn onClick={() => act(
              () => api('POST', '/api/client/login', { server: cfg.server }),
              (r) => `已配对 ${r.server}（${r.identity?.email || r.identity?.sub || ''}）；浏览器完成 go-ah 登录后自动生效`,
            )} disabled={busy || !cfg.server}>配对登录（浏览器 SSO）</Btn>
            <span className="mid">填好 server 后点击——浏览器跳 go-ah 登录，回来即完成配对（不再贴 token）</span>
          </Row>
          <Row label="relay"><Input value={cfg.relay || ''} onChange={(v) => setCfg({ ...cfg, relay: v })} placeholder="relay://用户:密码@server:8442" /></Row>
          <Row label="gost 路径"><Input value={cfg.gostBin || ''} onChange={(v) => setCfg({ ...cfg, gostBin: v })} placeholder="gost（PATH）或绝对路径" /></Row>
          <Row label="">
            <Btn onClick={() => act(() => api('POST', '/api/client/config', { server: cfg.server, relay: cfg.relay, 'gost-bin': cfg.gostBin }), '连接配置已保存')}
                 disabled={busy}>保存配置</Btn>
            <Btn onClick={async () => {
              const r = await act(() => api('GET', '/api/client/doctor'));
              if (r) setDoctor(r);
            }} disabled={busy}>自检（doctor）</Btn>
            {doctor && <span className="mid">server: {doctor.server} · 会话: {doctor.session || '未配对'} · gost: {doctor.gostBin}</span>}
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
