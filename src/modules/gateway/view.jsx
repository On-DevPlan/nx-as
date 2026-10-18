import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Row } from '../../web/frontend/components/ui.jsx';

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const shortUa = (ua) => {
  if (!ua) return '—';
  // 常见浏览器/客户端一眼可辨的短名，其余截断
  const m = /(Edg|Chrome|Safari|Firefox|curl|gost|Postman|python-requests)[^ ]*/.exec(ua);
  return m ? m[0].slice(0, 24) : ua.slice(0, 24);
};

// 设备 / 会话管理（本面板「授权管理主服务」的主 UI）
// - 设备 = 一枚可吊销的 device token（scope: admin|client）
// - 会话 = 登录后签发的无状态 HMAC cookie（7 天）；吊销设备后其已发会话经设备回查立即失效
export default function GatewayView() {
  const [devices, setDevices] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDevices(await api('GET', '/api/devices'));
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const revoke = async (d) => {
    if (!confirm(`吊销设备「${d.name}」(${d.id})？其 token 与已发会话立即失效。`)) return;
    setBusy(true); setMsg(null);
    try {
      await api('POST', `/api/devices/${encodeURIComponent(d.id)}/revoke`);
      setMsg({ type: 'ok', text: `已吊销: ${d.id}（已发会话立即失效）` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const revokeAll = async () => {
    const active = (devices || []).filter((d) => !d.revoked).length;
    if (!active) return;
    if (!confirm(`吊销全部 ${active} 台设备？所有 token 与已发会话立即失效（应急操作）。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api('POST', '/api/devices/revoke-all');
      setMsg({ type: 'ok', text: `已吊销 ${r.revoked} 台设备（全部会话立即失效）` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const active = (devices || []).filter((d) => !d.revoked).length;

  return (
    <>
      <Card title="设备（device token）">
        <Row label="签发">
          <span className="mid">
            在服务器上执行 <code>nx-as device issue --name &lt;名&gt; [--scope admin|client]</code> 签发
            （token 明文只出现一次，线下交付）。scope 目前仅落字段与徽章，不区分端点权限。
          </span>
        </Row>
        <Row label="会话说明">
          <span className="mid">
            登录会话为无状态 HMAC cookie（7 天，重启服务全失效）；吊销设备后其已发会话经
            设备回查<strong>立即失效</strong>，无需等待过期。
          </span>
        </Row>
        <Row label="">
          <Btn className="danger" onClick={revokeAll} disabled={busy || !active}>全部吊销（{active} 台活跃）</Btn>
          <span className="mid">应急用：所有 token 与会话立即失效</span>
        </Row>
      </Card>

      <Card title="设备清单">
        {devices === null && <Row label=""><span className="mid">加载中…</span></Row>}
        {devices && devices.length === 0 && (
          <Row label=""><span className="mid">无设备。在服务器上签发第一枚 token 后这里会出现清单。</span></Row>
        )}
        {devices && devices.length > 0 && (
          <div className="dev-table">
            <div className="dev-row dev-head">
              <span>名称</span><span>scope</span><span>状态</span><span>最近使用</span><span>IP / UA</span><span>创建于</span><span></span>
            </div>
            {devices.map((d) => (
              <div className={`dev-row ${d.revoked ? '' : ''}`} key={d.id}>
                <span className="dev-name" title={d.id}>
                  <code>{d.name}</code>
                  <span className="mid dev-id">{d.id}</span>
                </span>
                <span><span className={`tag ${d.scope === 'admin' ? 'strong' : ''}`}>{d.scope}</span></span>
                <span><span className={`tag ${d.revoked ? 'bad' : ''}`}>{d.revoked ? 'revoked' : 'active'}</span></span>
                <span className="mid">{fmtTime(d.lastUsedAt)}</span>
                <span className="mid dev-src" title={d.lastUa || ''}>
                  {d.lastIp || '—'}
                  {d.lastUa ? <span className="dev-ua"> · {shortUa(d.lastUa)}</span> : null}
                </span>
                <span className="mid">{fmtTime(d.createdAt)}</span>
                <span className="dev-act">
                  {!d.revoked && <Btn className="danger" onClick={() => revoke(d)} disabled={busy}>吊销</Btn>}
                </span>
              </div>
            ))}
          </div>
        )}

        {msg && (
          <Row label={msg.type === 'ok' ? '结果' : '错误'}>
            <span className={msg.type === 'ok' ? '' : 'bad'}>{msg.text}</span>
          </Row>
        )}
      </Card>
    </>
  );
}
