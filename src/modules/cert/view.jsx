import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function CertView() {
  const [status, setStatus] = useState(null);
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await api('GET', '/api/cert')); }
    catch (e) { setMsg({ type: 'err', text: e.message }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const importBoth = async () => {
    if (!certPem.trim() || !keyPem.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/cert/import', { cert: certPem, key: keyPem });
      setMsg({ type: 'ok', text: `已导入（subject=${r.subject}, notAfter=${r.notAfter}）。下一步：「nginx」页 Apply 启用 HTTPS。` });
      setCertPem(''); setKeyPem('');
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm('删除已导入的证书？需要 Apply nginx 才能回到纯 HTTP。')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/cert/remove');
      setMsg({ type: 'ok', text: `已删除: ${r.removed.join(', ')}` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const download = async (type) => {
    try {
      const r = await api('GET', `/api/cert/download?type=${type}`);
      const blob = new Blob([r.pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `nx-as.${type}.pem`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
  };

  if (!status) return <Card title="证书">加载中…</Card>;

  const m = status.meta || {};
  return (
    <Card title="证书">
      <Row label="状态">
        <span className={status.enabled ? 'good' : 'mid'}>
          {status.enabled ? '✅ 已启用 HTTPS' : `未启用 HTTPS（${status.message}）`}
        </span>
      </Row>
      {status.enabled && (
        <>
          <Row label="subject"><span className="mono">{m.subject}</span></Row>
          <Row label="issuer"><span className="mono">{m.issuer}</span></Row>
          <Row label="有效期"><span className="mono">{m.notBefore} → {m.notAfter}</span></Row>
          <Row label="fingerprint"><span className="mono">{m.fingerprintSha256}</span></Row>
        </>
      )}
      <Row label="certPath"><span className="mono">{status.certPath}</span></Row>
      <Row label="keyPath"><span className="mono">{status.keyPath}</span></Row>

      <div className="colhead">下载（已导入时）</div>
      <Row label="">
        <Btn onClick={() => download('cert')} disabled={!status.enabled}>下载证书 PEM</Btn>
        <Btn onClick={() => download('key')} disabled={!status.enabled}>下载私钥 PEM</Btn>
        <Btn onClick={remove} disabled={!status.enabled || busy}>删除证书</Btn>
      </Row>

      <div className="colhead">导入外部证书</div>
      <Row label="说明"><span className="mid">nx-as 不签证书；粘贴你已有的 CRT + KEY（来自 Let's Encrypt / certbot / 商业 CA / 自签）。私钥须匹配证书。</span></Row>
      <Row label="CRT">
        <textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} rows={8}
          placeholder="-----BEGIN CERTIFICATE-----..." style={{ width: '100%', fontFamily: 'monospace' }} />
      </Row>
      <Row label="KEY">
        <textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} rows={6}
          placeholder="-----BEGIN PRIVATE KEY-----..." style={{ width: '100%', fontFamily: 'monospace' }} />
      </Row>
      <Row label="">
        <Btn onClick={importBoth} disabled={busy || !certPem.trim() || !keyPem.trim()}>导入并落盘</Btn>
        {busy && <span className="mid">处理中…</span>}
      </Row>

      {msg && <Row label={msg.type === 'ok' ? '结果' : '错误'}><span className={msg.type === 'ok' ? '' : 'bad'} style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span></Row>}

      <Row label="">
        <span className="mid">导入后到「nginx」页填 certPath / keyPath 并 Apply，HTTPS 即生效。删除证书后回 HTTP。</span>
      </Row>
    </Card>
  );
}