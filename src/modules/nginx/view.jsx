import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';
import { DiffView } from '../../web/frontend/components/diff.jsx';
import { Modal } from '../../web/frontend/components/modal.jsx';
import { diffLines, hasChanges } from '../../web/frontend/lib/diff.js';

const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '');

// nginx 模块视图：看板优先
// 主页 = 看板（站点反代 / 端口转发条目 ↔ 托管目录里的 conf 文件，表单保存即走
// 备份 → nginx -t → reload 管线）；网关入口（托管单文件）与原始配置文件管理器
// 降级为次级入口（卡片/弹窗保留），不常用操作折叠到「高级」。
// 弹窗开关不丢内部 state（所有 useState 都在父组件；弹窗只是视觉容器）
const KIND_LABEL = { gateway: '网关', site: '站点', port: '端口', custom: '自定义' };

// 表单 state → 保存 spec（校验在后端 assertSpec，预览/保存共用一条路）
function buildSpec(f) {
  const spec = { kind: f.kind, upstream: f.upstream.trim() };
  if (f.kind === 'site') {
    spec.domains = f.domains.split(/[,\s，]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    spec.listenPort = Number(String(f.listenPort).trim());
  }
  if (f.ws) spec.ws = true;
  if (f.tlsOn) spec.tls = { certPath: f.certPath.trim(), keyPath: f.keyPath.trim() };
  return spec;
}

function emptyForm(kind) {
  return { name: null, kind, domains: '', listenPort: '', upstream: '', ws: false, tlsOn: false, certPath: '', keyPath: '' };
}

export default function NginxView() {
  // ───────── 数据 ─────────
  const [status, setStatus] = useState(null);
  const [hosts, setHosts] = useState(null); // 看板清单（= 托管目录 conf 文件的卡片视图）
  const [cfg, setCfg] = useState(null);
  const [tpl, setTpl] = useState('');
  const [rendered, setRendered] = useState('');
  const [showRendered, setShowRendered] = useState(false);

  // 文件管理器（原始编辑，看板的兜底）
  const [sel, setSel] = useState(null);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState('');
  const [backups, setBackups] = useState([]);
  const [showBackups, setShowBackups] = useState(false);
  const [newName, setNewName] = useState('');

  // 网关入口保存并生效（托管单文件）+ diff 预览
  const [diffState, setDiffState] = useState(null);
  const [diffedCfg, setDiffedCfg] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffErr, setDiffErr] = useState('');
  const diffAnchorRef = useRef(null);

  // 看板表单（添加/编辑共用；site 与 port 一个 state，kind 区分）
  const [modal, setModal] = useState(null); // 'siteForm' | 'portForm' | 'files' | 'template' | 'advanced' | null
  const [form, setForm] = useState(null);
  const [formPreview, setFormPreview] = useState('');
  const [formErr, setFormErr] = useState('');

  const [msg, setMsg] = useState(null);
  const [cert, setCert] = useState(null);
  const [tunnels, setTunnels] = useState(null); // nxas-tunnel-*.conf 清单（穿透总览）
  const [tunnelsErr, setTunnelsErr] = useState(''); // 清单拉取失败要可见可重试（不能静默空卡）
  const [certModal, setCertModal] = useState(false);
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [busy, setBusy] = useState(false);

  const isContainer = cfg?.mode === 'container';

  // ───────── 核心：拉取与 diff ─────────
  const loadDiff = useCallback(async (c) => {
    if (!c || c.mode === 'container') return null;
    setDiffErr('');
    try {
      const name = (c.managedPath || '').split(/[\\/]/).pop() || 'nx-as-managed.conf';
      const [disk, prev] = await Promise.all([
        api('GET', `/api/nginx/files/${encodeURIComponent(name)}`)
          .catch((e) => (String(e.message).includes('不存在') ? { content: '' } : Promise.reject(e))),
        api('GET', '/api/nginx/config?preview=true'),
      ]);
      const rows = diffLines(disk.content, prev.rendered);
      setDiffState({ rows, changed: hasChanges(rows), before: disk.content, after: prev.rendered });
      setDiffedCfg({ domain: c.domain, certPath: c.certPath, keyPath: c.keyPath });
      return rows;
    } catch (e) {
      setDiffState(null);
      setDiffErr(e.message);
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [st, hs, cf] = await Promise.all([
        api('GET', '/api/nginx'),
        api('GET', '/api/nginx/hosts').catch(() => null),
        api('GET', '/api/nginx/config'),
      ]);
      setStatus(st);
      setHosts(hs);
      setCfg(cf);
      if (cf.mode === 'container') { setTpl(cf.template || ''); setRendered(cf.rendered || ''); }
      else { loadDiff(cf); }
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }, [loadDiff]);
  useEffect(() => { refresh(); }, [refresh]);

  // ───────── 看板表单：预览（防抖）与保存 ─────────
  useEffect(() => {
    if (!form) return;
    const t = setTimeout(async () => {
      try {
        const r = await api('POST', '/api/nginx/hosts', { spec: buildSpec(form), preview: true });
        setFormPreview(r.preview);
        setFormErr('');
      } catch (e) {
        setFormPreview('');
        setFormErr(e.message);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [form]);

  const openForm = (kind, h = null) => {
    // 编辑：优先 spec 回填（表单为准），无 spec 的推断字段只作展示参考
    const spec = h?.spec;
    setForm(h ? {
      name: h.name,
      kind,
      domains: (spec?.domains || h.domains || []).join(', '),
      listenPort: String(spec?.listenPort ?? h.listenPort ?? ''),
      upstream: h.upstream || '',
      ws: spec ? spec.ws === true : h.ws === true,
      tlsOn: !!(spec?.tls || h.tls),
      certPath: spec?.tls?.certPath || (h.tls?.certPath ?? ''),
      keyPath: spec?.tls?.keyPath || (h.tls?.keyPath ?? ''),
    } : emptyForm(kind));
    setFormPreview(''); setFormErr('');
    setModal(kind === 'site' ? 'siteForm' : 'portForm');
  };

  const saveForm = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/nginx/hosts', { spec: buildSpec(form), name: form.name || undefined });
      setMsg({ type: 'ok', text: `已生效: ${r.name}（${r.summary}，nginx -t 通过 + graceful reload）` });
      setModal(null); setForm(null);
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: `保存失败: ${e.message}` }); } finally { setBusy(false); }
  };

  const toggleHost = async (h) => {
    const to = h.name.endsWith('.disabled') ? '启用' : '停用';
    if (!confirm(`${to} ${h.name}？（改名即生效，nginx -t 校验失败会自动改回）`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', `/api/nginx/files/${encodeURIComponent(h.name)}/toggle`);
      setMsg({ type: 'ok', text: `${r.enabled ? '已启用' : '已停用'}: ${r.from} → ${r.to}` });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  const removeHostEntry = async (h) => {
    if (!confirm(`删除 ${h.name}？删除前自动备份（nginx -t 失败会自动还原）。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('DELETE', `/api/nginx/hosts/${encodeURIComponent(h.name)}`);
      setMsg({ type: 'ok', text: `已删除: ${r.name}${r.backedUp ? `（备份 ${r.backedUp}，可还原）` : ''}` });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  // ───────── 网关入口（托管单文件）保存并生效 ─────────
  const refreshCert = useCallback(async () => {
    try { setCert(await api('GET', '/api/nginx/cert')); } catch { setCert(null); }
  }, []);
  useEffect(() => { refreshCert(); }, [refreshCert]);

  const refreshTunnels = useCallback(async () => {
    try {
      const r = await api('GET', '/api/nginx/files');
      setTunnels((r.files || []).filter((f) => f.name.startsWith('nxas-tunnel-')));
      setTunnelsErr('');
    } catch (e) { setTunnels(null); setTunnelsErr(e.message); }
  }, []);
  useEffect(() => { refreshTunnels(); }, [refreshTunnels]);

  const importCertUi = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('POST', '/api/nginx/cert/import', { cert: certPem, key: keyPem });
      setMsg({ type: 'ok', text: '证书已导入，路径已自动填入下方表单（保存并生效后启用 HTTPS）' });
      setCertModal(false); setCertPem(''); setKeyPem('');
      await refresh();
      await refreshCert();
      await refreshTunnels();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  const applyManaged = async () => {
    setBusy(true); setMsg(null);
    try {
      const rows = await loadDiff(cfg);
      if (rows && !hasChanges(rows)) {
        setMsg({ type: 'ok', text: '磁盘配置已与渲染结果一致，无需保存' });
        return;
      }
      const r = await api('POST', '/api/nginx/apply', { domain: cfg.domain, certPath: cfg.certPath, keyPath: cfg.keyPath });
      setMsg({ type: 'ok', text: `已生效: ${r.domain}（nginx -t 通过 + graceful reload）` });
      setShowDiff(false);
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  const overwriteDisk = async () => {
    if (!confirm('以已保存配置的模板覆盖磁盘上的托管配置？（nginx -t + graceful reload）')) return;
    setBusy(true); setMsg(null);
    try {
      await api('POST', '/api/nginx/apply', {});
      setMsg({ type: 'ok', text: '已以模板覆盖磁盘配置（nginx -t 通过 + graceful reload）' });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  const revealDiff = async () => {
    setShowDiff(true);
    await loadDiff(cfg);
    requestAnimationFrame(() => diffAnchorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  // ───────── 弹窗：文件管理器（原始编辑兜底） ─────────
  const pick = async (name, { force = false } = {}) => {
    if (!force && content !== loaded && !confirm('当前文件有未保存修改，放弃并切换？')) return;
    setBusy(true); setMsg(null); setShowBackups(false);
    try {
      const r = await api('GET', `/api/nginx/files/${encodeURIComponent(name)}`);
      setSel(name); setContent(r.content); setLoaded(r.content);
      setBackups((await api('GET', `/api/nginx/files/${encodeURIComponent(name)}/backups`)).backups);
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const saveFile = async () => {
    if (!sel) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', `/api/nginx/files/${encodeURIComponent(sel)}`, { content });
      setLoaded(content);
      setMsg({ type: 'ok', text: `已生效: ${sel}（${r.created ? '新建' : '更新'}，nginx -t 通过 + reload${r.backedUp ? `，已备份 ${r.backedUp}` : ''}）` });
      await refresh();
      setBackups((await api('GET', `/api/nginx/files/${encodeURIComponent(sel)}/backups`)).backups);
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const createFile = async () => {
    const name = newName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.conf$/.test(name)) {
      setMsg({ type: 'err', text: '文件名不合法：字母/数字开头，仅含字母数字 . _ -，以 .conf 结尾' });
      return;
    }
    if (hosts?.hosts?.some((f) => f.name === name || f.name === name + '.disabled')) {
      setMsg({ type: 'err', text: `已存在同名文件: ${name}` });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      await api('POST', `/api/nginx/files/${encodeURIComponent(name)}`, { content: `# ${name}\n# 由 nx-as 面板创建；保存即 nginx -t 校验 + graceful reload\n` });
      setNewName('');
      setMsg({ type: 'ok', text: `已创建并生效: ${name}` });
      await refresh();
      await pick(name, { force: true });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const toggleFile = async () => {
    if (!sel) return;
    const to = sel.endsWith('.disabled') ? '启用' : '停用';
    if (!confirm(`${to} ${sel}？（改名即生效，nginx -t 校验失败会自动改回）`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', `/api/nginx/files/${encodeURIComponent(sel)}/toggle`);
      setMsg({ type: 'ok', text: `${r.enabled ? '已启用' : '已停用'}: ${r.from} → ${r.to}` });
      await refresh();
      await pick(r.to, { force: true });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const removeFile = async () => {
    if (!sel) return;
    if (!confirm(`删除 ${sel}？删除前自动备份（nginx -t 失败会自动还原）。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('DELETE', `/api/nginx/files/${encodeURIComponent(sel)}`);
      setMsg({ type: 'ok', text: `已删除: ${r.name}${r.backedUp ? `（备份 ${r.backedUp}，可还原）` : ''}` });
      setSel(null); setContent(''); setLoaded(''); setBackups([]);
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const restoreBackup = async (ts) => {
    if (!sel) return;
    if (!confirm(`把 ${sel} 还原到备份 ${ts}？当前内容会先再备份一份。`)) return;
    setBusy(true); setMsg(null);
    try {
      await api('POST', `/api/nginx/files/${encodeURIComponent(sel)}/restore`, { ts });
      setMsg({ type: 'ok', text: `已还原: ${sel} ← ${ts}` });
      await pick(sel, { force: true });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  // ───────── 弹窗：模板编辑器（容器模式） ─────────
  const applyTemplate = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('POST', '/api/nginx/apply', { template: tpl });
      setMsg({ type: 'ok', text: '已生效：模板已写入并渲染（nginx -t 通过 + reload）' });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const rollbackTemplate = async () => {
    if (!confirm('回滚到上一版配置并 reload？')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/nginx/rollback');
      setMsg({ type: 'ok', text: `已回滚: ${r.rolledBackTo}` });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  // ───────── 弹窗：高级（轮换 / 回滚） ─────────
  const rollbackManaged = async () => {
    if (!confirm('回滚到上一版配置并 reload？')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/nginx/rollback');
      setMsg({ type: 'ok', text: `已回滚: ${r.rolledBackTo}` });
      await refresh();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };
  const rotateSecret = async () => {
    if (!confirm('轮换机机密码？运行中的 pi-web 需要重启才能用新密码。')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/nginx/rotate-secret');
      setMsg({ type: 'ok', text: r.note });
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
  };

  // 初始加载失败不再死等整页刷新：错误 + 重试（复用 refresh）就地可行动
  if (!status || !cfg) {
    const loadErr = msg?.type === 'err';
    return (
      <Card title="nginx">加载中{loadErr ? ` — ${msg.text}` : ''}
        {loadErr && (
          <Row label="">
            <Btn onClick={() => { setMsg(null); refresh(); }}>重试</Btn>
            <span className="mid">初始加载失败——服务恢复后点重试，无需整页刷新</span>
          </Row>
        )}
      </Card>
    );
  }

  const drift = status?.drifted;
  const list = hosts?.hosts || [];
  const selMeta = list.find((f) => f.name === sel);
  const dirty = sel !== null && content !== loaded;
  const openFilesAt = (name) => { setModal('files'); requestAnimationFrame(() => pick(name)); };

  // ───────── 弹窗：看板表单（站点反代 / 端口转发） ─────────
  const isSiteForm = form?.kind === 'site';
  const formModal = form && (
    <Modal open={modal === 'siteForm' || modal === 'portForm'} onClose={() => { setModal(null); setForm(null); }}
      title={(form.name ? '编辑' : '添加') + (isSiteForm ? '反代站点' : '端口转发')} maxWidth={760}>
      <Row label={isSiteForm ? '域名' : '监听端口'}>
        {isSiteForm ? (
          <Input style={{ flex: 1 }} value={form.domains} placeholder="a.example.com, b.example.com（逗号分隔）"
            onChange={(v) => setForm({ ...form, domains: v })} />
        ) : (
          <Input style={{ width: 140 }} value={form.listenPort} placeholder="8081"
            onChange={(v) => setForm({ ...form, listenPort: v })} />
        )}
      </Row>
      {isSiteForm && (
        <Row label=""><span className="mid">不带端口的公网域名；nginx 按域名分流（80/443 入口）。</span></Row>
      )}
      <Row label="上游">
        <Input style={{ flex: 1 }} value={form.upstream} placeholder="127.0.0.1:3000（或 http://…）"
          onChange={(v) => setForm({ ...form, upstream: v })} />
      </Row>
      <Row label="选项">
        <label className="chk">
          <input type="checkbox" checked={form.ws} onChange={(e) => setForm({ ...form, ws: e.target.checked })} />
          WebSocket 升级
        </label>
        <label className="chk">
          <input type="checkbox" checked={form.tlsOn} onChange={(e) => setForm({ ...form, tlsOn: e.target.checked })} />
          TLS（证书终止在本机 nginx）
        </label>
      </Row>
      {form.tlsOn && (
        <>
          <Row label="证书路径"><Input style={{ flex: 1 }} value={form.certPath} placeholder="/etc/letsencrypt/live/<域>/fullchain.pem" onChange={(v) => setForm({ ...form, certPath: v })} /></Row>
          <Row label="私钥路径"><Input style={{ flex: 1 }} value={form.keyPath} placeholder="/etc/letsencrypt/live/<域>/privkey.pem" onChange={(v) => setForm({ ...form, keyPath: v })} /></Row>
        </>
      )}
      <div className="colhead">保存预览（映射为托管目录里的配置文件）</div>
      {formErr && <Row label=""><span className="bad">{formErr}</span></Row>}
      {formPreview && <pre className="output">{formPreview}</pre>}
      <Row label="">
        <Btn onClick={saveForm} disabled={busy}>保存并生效（nginx -t + reload）</Btn>
        <Btn onClick={() => { setModal(null); setForm(null); }} disabled={busy}>取消</Btn>
        {busy && <span className="mid">执行中…</span>}
      </Row>
      <Row label=""><span className="mid">保存 = 备份现网 → 写入托管目录 → nginx -t（失败自动还原）→ graceful reload。</span></Row>
    </Modal>
  );

  // ───────── 弹窗：文件管理器（原始编辑兜底） ─────────
  const filesModal = (
    <Modal open={modal === 'files'} onClose={() => setModal(null)} title="配置文件管理器（原始编辑）" maxWidth={980}>
      <div className="filelist">
        {hosts && list.length === 0 && (
          <Row label=""><span className="mid">托管目录暂无 *.conf。可新建，或用看板「添加」生成。</span></Row>
        )}
        {list.map((f) => (
          <div key={f.name} className={`file-row ${f.name === sel ? 'active' : ''}`}
            onClick={() => f.name !== sel && pick(f.name)}>
            <span className="file-name">
              {f.managed && <span className="tag strong" title="nginx 托管生成的引导配置">托管</span>}
              <code>{f.name}</code>
            </span>
            <span className="file-meta">
              {!f.enabled && <span className="tag">已停用</span>}
              {f.writable === false && <span className="tag bad" title="文件对 nx-as 运行用户不可写">无写权</span>}
              <span className="mid">{fmtSize(f.size)} · {fmtTime(f.mtimeMs)}</span>
              {f.backups > 0 && <span className="mid">备份 {f.backups}</span>}
            </span>
          </div>
        ))}
      </div>
      <Row label="新建">
        <Input value={newName} onChange={setNewName} placeholder="my-site.conf" disabled={!hosts?.dirWritable || busy} />
        <Btn onClick={createFile} disabled={!hosts?.dirWritable || busy || !newName.trim()}>创建</Btn>
      </Row>
      {sel && (
        <>
          <div className="colhead">
            编辑：<code>{sel}</code>
            {selMeta && <span className="mid">  {fmtSize(selMeta.size)} · 备份 {selMeta.backups} 份</span>}
            {dirty && <span className="tag bad">未保存</span>}
          </div>
          <Row label="内容">
            <textarea className="editor" value={content} onChange={(e) => setContent(e.target.value)}
              rows={20} spellCheck={false} disabled={busy || selMeta?.writable === false} />
          </Row>
          <Row label="">
            <Btn onClick={saveFile} disabled={busy || !dirty || selMeta?.writable === false}>保存并生效（nginx -t + reload）</Btn>
            <Btn onClick={toggleFile} disabled={busy || !hosts?.dirWritable}>{sel.endsWith('.disabled') ? '启用' : '停用'}</Btn>
            <Btn className="danger" onClick={removeFile} disabled={busy || !hosts?.dirWritable}>删除</Btn>
            <Btn onClick={() => setShowBackups((v) => !v)}>备份历史（{backups.length}）</Btn>
            <Btn onClick={() => pick(sel, { force: true })} disabled={busy}>重读</Btn>
          </Row>
          {showBackups && (
            <div className="filelist">
              <div className="colhead">备份历史（新→旧，最多 10 份，存于 ~/.nx-as/nginx-backups/）</div>
              {backups.length === 0 && <Row label=""><span className="mid">暂无备份（每次保存/删除/还原前自动生成）</span></Row>}
              {backups.map((b) => (
                <div className="row" key={b.ts}>
                  <span className="rowbody">
                    <code>{b.ts}</code>
                    <span className="mid">{fmtSize(b.size)}</span>
                  </span>
                  <Btn onClick={() => restoreBackup(b.ts)} disabled={busy}>还原</Btn>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <Row label="">
        <span className="mid">每次变更自动 nginx -t 校验（失败还原原文）+ graceful reload；变更前内容滚动备份（保留 10 份）。</span>
      </Row>
    </Modal>
  );

  // ───────── 弹窗：模板编辑器（容器模式） ─────────
  const templateModal = (
    <Modal open={modal === 'template'} onClose={() => setModal(null)} title="nginx 模板（容器模式）" maxWidth={960}>
      <Row label="模板路径"><code className="mono">{cfg.templatePath}</code></Row>
      <Row label="渲染产物"><code className="mono">{cfg.renderedPath}</code></Row>
      <div className="colhead">nginx.conf 模板</div>
      <Row label="说明">
        <span className="mid">变量：<code>{'${NXAS_LISTEN_PORT}'}</code> 等；nginx 自身变量原样保留</span>
      </Row>
      <Row label="模板">
        <textarea value={tpl} onChange={(e) => setTpl(e.target.value)} rows={20}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} />
      </Row>
      <Row label="">
        <Btn onClick={applyTemplate} disabled={busy}>保存并生效</Btn>
        <Btn onClick={rollbackTemplate} disabled={busy}>回滚上一版</Btn>
        <Btn onClick={() => setShowRendered((v) => !v)}>{showRendered ? '隐藏' : '查看'}生效配置</Btn>
        {busy && <span className="mid">执行中…</span>}
      </Row>
      {showRendered && (
        <Row label="">
          <textarea value={rendered} readOnly rows={18}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', background: '#f6f6f6' }} />
        </Row>
      )}
    </Modal>
  );

  // ───────── 弹窗：导入证书 ─────────
  const certImportModal = (
    <Modal open={certModal} onClose={() => setCertModal(false)} title="导入证书（HTTPS）" maxWidth={720}>
      <Row label="说明"><span className="mid">粘贴 PEM（nx-as 不签证书）。导入成功后自动填入网关入口的证书路径，保存并生效即启用 HTTPS。</span></Row>
      <div className="colhead">证书（CRT / fullchain PEM）</div>
      <Row label=""><textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} rows={7} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="-----BEGIN CERTIFICATE-----" /></Row>
      <div className="colhead">私钥（KEY PEM）</div>
      <Row label=""><textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} rows={5} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="-----BEGIN PRIVATE KEY-----" /></Row>
      <Row label="">
        <Btn onClick={importCertUi} disabled={busy || !certPem || !keyPem}>导入并自动接入</Btn>
        <Btn onClick={() => setCertModal(false)} disabled={busy}>取消</Btn>
      </Row>
    </Modal>
  );

  // ───────── 弹窗：高级操作（回滚 / 轮换机机密码） ─────────
  const advancedModal = (
    <Modal open={modal === 'advanced'} onClose={() => setModal(null)} title="高级操作" maxWidth={620}>
      {isContainer && (
        <Row label="模板">
          <Btn onClick={() => { setModal(null); setModal('template'); }} disabled={busy}>编辑 nginx 模板</Btn>
          <span className="mid">容器模式专用（envsubst 渲染）</span>
        </Row>
      )}
      <Row label="回滚">
        <Btn onClick={() => { setModal(null); rollbackManaged(); }} disabled={busy}>回滚到上一版配置</Btn>
        <span className="mid">备份文件 → 恢复并 reload（nginx -t）</span>
      </Row>
      <Row label="机机密码">
        <Btn onClick={() => { setModal(null); rotateSecret(); }} disabled={busy}>轮换机机密码</Btn>
        <span className="mid">运行中的 pi-web 需要重启才能用新密码</span>
      </Row>
    </Modal>
  );

  // ───────── 漂移横幅 ─────────
  const driftBanner = drift && drift !== false && (
    <div className={`banner ${drift === 'unreadable' ? 'danger' : 'warn'}`}>
      <span className="banner-text">
        {drift === true && '磁盘配置与模板不一致（可能被手改）'}
        {drift === 'missing' && '托管配置文件不存在——尚未生成，「保存并生效」将创建它'}
        {drift === 'unreadable' && '托管配置文件不可读（权限被变更？），无法比对漂移——请检查文件权限后重试'}
      </span>
      {drift === true && <Btn onClick={revealDiff} disabled={busy}>查看差异</Btn>}
      {drift !== 'unreadable' && (
        <Btn onClick={overwriteDisk} disabled={busy}>{drift === 'missing' ? '生成并应用' : '覆盖'}</Btn>
      )}
    </div>
  );

  // ───────── 看板行 ─────────
  const entryHead = (h) => {
    if (h.kind === 'port') return `:${h.listenPort ?? '?'}`;
    if (h.domains?.length) return h.domains.join(', ');
    return h.kind === 'gateway' ? '—' : `:${h.listenPort ?? '?'}`;
  };
  const badges = (h) => (
    <>
      {h.tls && <span className="tag" title="TLS 终止在本机 nginx">TLS</span>}
      {h.ws && <span className="tag" title="WebSocket 升级已开启">WS</span>}
      {h.auth && <span className="tag" title="走 nx-as 鉴权网关（auth_request）">鉴权</span>}
      {h.spec && h.kind !== 'gateway' && <span className="tag" title="带 nxas-spec 头：面板表单可编辑">表单</span>}
    </>
  );

  return (
    <>
      {driftBanner}
      <Card title="nginx 状态">
        <Row label="运行">
          <span className="mono">{status.platform}</span>
          <span className="mono">{status.nginx?.version ? `v${status.nginx.version}` : ''}</span>
          <span className="mono">{status.nginx?.service ?? '?'}</span>
          {status.sudoers && status.sudoers !== 'ok' && (
            <span className="bad">sudoers 未授权（详情：nx-as nginx status）</span>
          )}
          {hosts && hosts.dirExists && !hosts.dirWritable && (
            <span className="bad">托管目录只读（写授权见 nx-as nginx setup）</span>
          )}
        </Row>
        <Row label="">
          <Btn onClick={() => setModal('files')} disabled={!hosts || busy}>原始编辑</Btn>
          <Btn onClick={() => setModal('advanced')} disabled={busy}>高级</Btn>
        </Row>
      </Card>

      <Card title="穿透隧道">
        <Row label="说明">
          <span className="mid">每行 = 一条 gost 内网穿透（公网端口先过 SSO 鉴权 → gost 回环 → 本地服务）。注册走 client 面板或 nx-as tunnel add。</span>
        </Row>
        {tunnelsErr && (
          <Row label="清单">
            <span className="bad">加载失败：{tunnelsErr}</span>
            <Btn onClick={refreshTunnels} disabled={busy}>重试</Btn>
          </Row>
        )}
        {(tunnels || []).map((f) => {
          const nm = /^nxas-tunnel-(.+)\.conf(\.disabled)?$/.exec(f.name);
          return (
            <Row label={nm ? nm[1] : f.name} key={f.name}>
              <span className={`tag ${f.enabled ? 'strong' : ''}`}>{f.enabled ? '启用' : '停用'}</span>
              <span className="mid">{new Date(f.mtimeMs).toLocaleDateString()}</span>
              <Btn onClick={async () => {
                if (!confirm(`删除隧道 ${nm?.[1] || f.name}？（conf 有备份可还原）`)) return;
                setBusy(true);
                try {
                  await api('POST', '/api/nginx/tunnel/remove', { name: nm?.[1] || f.name });
                  setMsg({ type: 'ok', text: `隧道 ${nm?.[1] || f.name} 已删除` });
                  await refresh(); await refreshTunnels();
                } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
              }} disabled={busy || !hosts?.dirWritable}>删除</Btn>
            </Row>
          );
        })}
        {tunnels && !tunnels.length && <Row label=""><span className="mid">{'暂无隧道——本机 nx-as tunnel add <名> <本地端口> 即可注册'}</span></Row>}
      </Card>

      <Card title="看板">
        <div className="colhead host-toolbar">
          <span>站点与端口（{list.length}）——每行对应托管目录里的一个配置文件</span>
          <span className="host-actions">
            <Btn onClick={() => openForm('site')} disabled={busy || !hosts?.dirWritable}>添加反代站点</Btn>
            <Btn onClick={() => openForm('port')} disabled={busy || !hosts?.dirWritable}>添加端口转发</Btn>
          </span>
        </div>
        <div className="host-table">
          <div className="host-row host-head">
            <span>类型</span><span>入口</span><span>上游</span><span>特性</span><span>状态</span><span />
          </div>
          {hosts === null && (
            <div className="host-empty">看板不可用——nginx 管理仅支持 Linux 服务器（或托管目录不可读）。</div>
          )}
          {hosts && list.length === 0 && (
            <div className="host-empty">托管目录暂无配置文件。点「添加反代站点 / 添加端口转发」从表单生成，或进「配置文件」手工创建。</div>
          )}
          {list.map((h) => (
            <div className="host-row" key={h.name}>
              <span><span className={`tag ${h.kind === 'gateway' ? 'strong' : ''}`}>{KIND_LABEL[h.kind] || h.kind}</span></span>
              <span className="host-entry" title={h.name}>
                {h.kind === 'gateway' && <span className="tag" title="nginx 托管生成的引导配置">托管</span>}
                <code>{entryHead(h)}</code>
              </span>
              <span className="host-up mono">{h.upstream || '—'}</span>
              <span className="host-badges">{badges(h)}</span>
              <span>{h.enabled ? <span className="tag strong">启用</span> : <span className="tag">停用</span>}</span>
              <span className="host-ops">
                <button className="mini" onClick={() => openForm(h.kind === 'port' ? 'port' : 'site', h)}
                  disabled={busy || !h.spec || !hosts?.dirWritable} title={h.spec ? '表单编辑（保存整体重渲染该文件）' : '无 spec 头（手写文件），请用「配置」原始编辑'}>编辑</button>
                <button className="mini" onClick={() => toggleHost(h)} disabled={busy || !hosts?.dirWritable}>{h.enabled ? '停用' : '启用'}</button>
                <button className="mini danger" onClick={() => removeHostEntry(h)} disabled={busy || !hosts?.dirWritable}>删除</button>
                <button className="mini" onClick={() => openFilesAt(h.name)} disabled={busy}>配置</button>
              </span>
            </div>
          ))}
        </div>
      </Card>

      {!isContainer && (
        <Card title="域名与 HTTPS（网关入口）">
          <Row label="证书">
            {cert?.enabled
              ? <span className="tag strong" title={cert.meta?.fingerprintSha256}>已导入 · 到期 {new Date(cert.meta?.notAfter).toLocaleDateString()}</span>
              : <span className="mid">未导入（HTTP）</span>}
            <Btn onClick={() => setCertModal(true)} disabled={busy}>导入证书</Btn>
            {cert?.enabled && (
              <Btn className="danger" onClick={async () => {
                if (!confirm('删除已导入的证书？')) return;
                setBusy(true);
                try { await api('POST', '/api/nginx/cert/remove'); setMsg({ type: 'ok', text: '证书已删除' }); await refresh(); await refreshCert(); }
                catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); }
              }} disabled={busy}>删除证书</Btn>
            )}
          </Row>
          <Row label="说明">
            <span className="mid">网关入口的反代引导配置（鉴权 + 面板入口）。导入证书后路径自动填好；普通站点/端口用上方看板。</span>
          </Row>
          <Row label="domain"><Input value={cfg.domain || ''} onChange={(v) => setCfg({ ...cfg, domain: v })} placeholder="agent.example.com" /></Row>
          <Row label="证书路径"><Input value={cfg.certPath || ''} onChange={(v) => setCfg({ ...cfg, certPath: v })} /></Row>
          <Row label="私钥路径"><Input value={cfg.keyPath || ''} onChange={(v) => setCfg({ ...cfg, keyPath: v })} /></Row>

          <div className="colhead" ref={diffAnchorRef}>保存前预览（磁盘现网 ↔ 最新渲染）</div>
          <Row label="差异">
            <Btn onClick={async () => { setShowDiff(true); await loadDiff(cfg); }} disabled={busy}>预览差异</Btn>
            {diffState && (
              <span className={diffState.changed ? '' : 'mid'}>
                {diffState.changed
                  ? <>将更新托管文件（<span className="diff-stat del">-{diffState.rows.filter((r) => r.type === 'del').length}</span>{' '}<span className="diff-stat add">+{diffState.rows.filter((r) => r.type === 'add').length}</span>）</>
                  : '磁盘配置已与渲染结果一致'}
              </span>
            )}
            {diffErr && <span className="bad">{diffErr}</span>}
          </Row>
          {(showDiff || (diffState && diffState.changed)) && diffState && (
            <Row label="">
              <DiffView before={diffState.before} after={diffState.after} />
            </Row>
          )}

          <Row label="">
            <Btn onClick={applyManaged} disabled={busy || Boolean(
              diffState && !diffState.changed && diffedCfg
              && diffedCfg.domain === cfg.domain && diffedCfg.certPath === cfg.certPath && diffedCfg.keyPath === cfg.keyPath,
            )}>保存并生效</Btn>
          </Row>
        </Card>
      )}

      {msg && (
        <Card>
          <Row label={msg.type === 'ok' ? '结果' : '错误'}>
            <span className={msg.type === 'err' ? 'bad' : ''} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
          </Row>
        </Card>
      )}

      {formModal}
      {filesModal}
      {templateModal}
      {certImportModal}
      {advancedModal}
    </>
  );
}
