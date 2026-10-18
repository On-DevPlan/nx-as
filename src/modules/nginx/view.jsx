import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';
import { DiffView } from '../../web/frontend/components/diff.jsx';
import { Modal } from '../../web/frontend/components/modal.jsx';
import { diffLines, hasChanges } from '../../web/frontend/lib/diff.js';

const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '');

// nginx 模块视图：分层设计
// 主页 = 核心运维（状态 / 漂移 / Apply）；不常用管理折叠到弹窗（配置文件 / 高级 / 容器模板）
// 弹窗开关不丢内部 state（所有 useState 都在父组件；弹窗只是视觉容器）
export default function NginxView() {
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [files, setFiles] = useState(null);
  const [tpl, setTpl] = useState('');
  const [rendered, setRendered] = useState('');
  const [showRendered, setShowRendered] = useState(false);

  // 文件管理器
  const [sel, setSel] = useState(null);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState('');
  const [backups, setBackups] = useState([]);
  const [showBackups, setShowBackups] = useState(false);
  const [newName, setNewName] = useState('');

  // 托管单文件 Apply（核心）+ diff 预览
  const [diffState, setDiffState] = useState(null);
  const [diffedCfg, setDiffedCfg] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffErr, setDiffErr] = useState('');
  const diffAnchorRef = useRef(null);

  // 弹窗
  const [modal, setModal] = useState(null); // 'files' | 'template' | 'advanced' | null

  const [msg, setMsg] = useState(null);
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
      const [st, fl, cf] = await Promise.all([
        api('GET', '/api/nginx'),
        api('GET', '/api/nginx/files').catch(() => null),
        api('GET', '/api/nginx/config'),
      ]);
      setStatus(st);
      setFiles(fl);
      setCfg(cf);
      if (cf.mode === 'container') { setTpl(cf.template || ''); setRendered(cf.rendered || ''); }
      else { loadDiff(cf); }
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  }, [loadDiff]);
  useEffect(() => { refresh(); }, [refresh]);

  // ───────── 核心：Apply（带 diff 复核） ─────────
  const applyManaged = async () => {
    setBusy(true); setMsg(null);
    try {
      const rows = await loadDiff(cfg);
      if (rows && !hasChanges(rows)) {
        setMsg({ type: 'ok', text: '磁盘配置已与渲染结果一致，无需 Apply' });
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

  // ───────── 折叠到弹窗：文件管理器 ─────────
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
    if (files?.files?.some((f) => f.name === name || f.name === name + '.disabled')) {
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
  // ───────── 折叠到弹窗：模板编辑器（容器模式） ─────────
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
  // ───────── 折叠到弹窗：高级（轮换 / 回滚） ─────────
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

  if (!status || !cfg) return <Card title="nginx">加载中{msg?.type === 'err' ? ` — ${msg.text}` : ''}</Card>;

  const drift = status?.drifted;
  const selMeta = files?.files?.find((f) => f.name === sel);
  const dirty = sel !== null && content !== loaded;

  // ───────── 弹窗：文件管理器（宿主/容器通用） ─────────
  const filesModal = (
    <Modal open={modal === 'files'} onClose={() => setModal(null)} title="配置文件管理器" maxWidth={980}>
      <div className="filelist">
        {files && files.files.length === 0 && (
          <Row label=""><span className="mid">托管目录暂无 *.conf。可新建，或用下方「托管单文件」表单生成引导配置。</span></Row>
        )}
        {files?.files?.map((f) => (
          <div key={f.name} className={`file-row ${f.name === sel ? 'active' : ''}`}
            onClick={() => f.name !== sel && pick(f.name)}>
            <span className="file-name">
              {f.managed && <span className="tag strong" title="nginx apply 托管的引导配置">托管</span>}
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
        <Input value={newName} onChange={setNewName} placeholder="my-site.conf" disabled={!files?.dirWritable || busy} />
        <Btn onClick={createFile} disabled={!files?.dirWritable || busy || !newName.trim()}>创建</Btn>
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
            <Btn onClick={toggleFile} disabled={busy || !files?.dirWritable}>{sel.endsWith('.disabled') ? '启用' : '停用'}</Btn>
            <Btn className="danger" onClick={removeFile} disabled={busy || !files?.dirWritable}>删除</Btn>
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
        <Btn onClick={applyTemplate} disabled={busy}>Apply（nginx -t + reload）</Btn>
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

  // ───────── 弹窗：高级操作（回滚 / 轮换机机密码） ─────────
  const advancedModal = (
    <Modal open={modal === 'advanced'} onClose={() => setModal(null)} title="高级操作" maxWidth={620}>
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
        {drift === 'missing' && '托管配置文件不存在——尚未生成，Apply 将创建它'}
        {drift === 'unreadable' && '托管配置文件不可读（权限被变更？），无法比对漂移——请检查文件权限后重试'}
      </span>
      {drift === true && <Btn onClick={revealDiff} disabled={busy}>查看差异</Btn>}
      {drift !== 'unreadable' && (
        <Btn onClick={overwriteDisk} disabled={busy}>{drift === 'missing' ? '生成并应用' : '覆盖'}</Btn>
      )}
    </div>
  );

  // ══════════ 主页：核心运维 ══════════
  return (
    <>
      {driftBanner}
      <Card title="nginx 状态">
        <Row label="平台 / nginx">
          <span className="mono">{status.platform}</span>
          <span className="mono">{status.nginx?.version ? `v${status.nginx.version}` : ''}</span>
          <span className="mono">{status.nginx?.service ?? '?'}</span>
        </Row>
        <Row label="sudoers">
          <span className={`tag ${status.sudoers === 'ok' ? 'strong' : 'bad'}`}>{status.sudoers ?? '?'}</span>
          <span className="mid">白名单只有 nginx -t / -s reload</span>
        </Row>
        <Row label="托管目录">
          <code>{files?.dir || status.managedDir}</code>
          {files && (
            <span className={`tag ${files.dirWritable ? 'strong' : ''}`}>
              {files.dirExists ? (files.dirWritable ? '可写' : '只读') : '不存在'}
            </span>
          )}
          {files && !files.dirWritable && (
            <span className="mid">目录写权限未授权：新建/删除/停用需先执行 nx-as nginx setup 里的完整管理授权</span>
          )}
        </Row>
        <Row label="托管单文件">
          <code>{status.managedPath}</code>
          <span className={`tag ${status.enabled ? 'strong' : ''}`}>{status.enabled ? '已启用' : '未启用'}</span>
          {status.drifted === true && <span className="tag bad">漂移</span>}
          {status.drifted === 'missing' && <span className="tag bad">缺失</span>}
        </Row>
        <Row label="">
          <Btn onClick={() => setModal('files')} disabled={!files || busy}>管理所有配置</Btn>
          {isContainer && <Btn onClick={() => setModal('template')} disabled={busy}>管理模板</Btn>}
          <Btn onClick={() => setModal('advanced')} disabled={busy}>高级</Btn>
        </Row>
      </Card>

      {!isContainer && (
        <Card title="托管单文件（引导配置模板）">
          <Row label="说明">
            <span className="mid">nx-as apply 渲染的反向代理引导配置。日常站点配置用「管理所有配置」；这张表单在初次部署或换域名/证书时使用。</span>
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
            )}>Apply（nginx -t + reload）</Btn>
          </Row>
        </Card>
      )}

      {msg && (
        <Card>
          <Row label={msg.type === 'ok' ? '结果' : '错误'}>
            <span className={msg.text.startsWith('已') || msg.text.includes('一致') ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
          </Row>
        </Card>
      )}

      {filesModal}
      {templateModal}
      {advancedModal}
    </>
  );
}
