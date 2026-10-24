import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

// 登录与会话（SSO）：会话（登出）+ OIDC 接入配置 + 全端下线
// 静态密钥与设备 token 已废除——这里只管「接入配置」与「会话运维」。
// 身份（邮箱/名称）只在顶栏展示，本页不再重复。
export default function AuthView() {
  const [status, setStatus] = useState(null);
  const [probe, setProbe] = useState(null);
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [emails, setEmails] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(''); // 保存配置的成功反馈（错误走 err，成功也得有回音）
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api('GET', '/api/auth/status');
      setStatus(s);
      setIssuer(s.issuer || '');
      setClientId(s.clientId || '');
      setRedirectUri(s.redirectUri?.startsWith('(') ? '' : s.redirectUri || '');
      setEmails((s.allowedEmails || []).join(','));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveConfig = async () => {
    setBusy(true);
    setErr('');
    setSaved('');
    try {
      await api('POST', '/api/oidc/config', {
        issuer,
        'client-id': clientId,
        'redirect-uri': redirectUri,
        'allowed-emails': emails,
      });
      await refresh();
      setSaved('已保存：接入配置立即生效；登录白名单对下一次登录生效（未注册 client 时先在服务器执行 nx-as oidc register）');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const runProbe = async () => {
    setBusy(true);
    setErr('');
    setSaved('');
    try {
      setProbe(await api('GET', '/api/oidc/probe'));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!confirm('轮换会话密钥将让所有已登录会话（浏览器/CLI）立即失效，确定？')) return;
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/api/auth/rotate');
      // 本会话也一并失效：回登录页重新走 SSO
      location.href = `${location.pathname.startsWith('/_nxas') ? '/_nxas' : ''}/oidc/login`;
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const logout = () => {
    location.href = `${location.pathname.startsWith('/_nxas') ? '/_nxas' : ''}/auth/logout`;
  };

  return (
    <>
      <Card title="会话">
        <Row label="">
          <span className="mid">会话由 go-ah 签发、nx-as 校验，7 天有效；过期访问任意页面会自动跳转重新登录。</span>
        </Row>
        <Row label="">
          <Btn onClick={logout}>登出（本浏览器）</Btn>
        </Row>
      </Card>
      <Card title="OIDC 接入配置">
        <Row label="issuer"><Input value={issuer} onChange={setIssuer} placeholder="http://47.110.80.47:8082" /></Row>
        <Row label="client_id"><Input value={clientId} onChange={setClientId} placeholder="nx-as（go-ah 侧注册的 public+PKCE 客户端）" /></Row>
        <Row label="回调地址"><Input value={redirectUri} onChange={setRedirectUri} placeholder="留空 = 按请求动态构造（回环部署自动适配）" /></Row>
        <Row label="登录白名单"><Input value={emails} onChange={setEmails} placeholder="逗号分隔邮箱；留空 = 放行全部 go-ah 用户" /></Row>
        {err && <Row label="错误"><span className="bad">{err}</span></Row>}
        {saved && <Row label="结果"><span>{saved}</span></Row>}
        <Row label="">
          <Btn onClick={saveConfig} disabled={busy}>保存配置</Btn>
          <Btn onClick={runProbe} disabled={busy}>探测（零凭据）</Btn>
          <span className="mid">client 未注册时先在服务器执行 nx-as oidc register</span>
        </Row>
        {status && (
          <Row label="状态">
            <span className={`tag ${status.complete ? 'strong' : ''}`}>{status.complete ? '已配置' : '未配置'}</span>{' '}
            <span className="tag">scopes: {status.scopes}</span>{' '}
            <span className="tag">会话密钥: {status.hasSessionSecret ? '已生成' : '未生成'}</span>
          </Row>
        )}
        {probe && (
          <Row label="探测">
            <span className={`tag ${probe.ok ? 'strong' : ''}`}>{probe.ok ? '通过' : '未通过'}</span>
            <ul className="mid" style={{ margin: '4px 0 0 16px' }}>
              {probe.checks.map((c, i) => (
                <li key={i}>[{c.ok ? '✓' : '✗'}] {c.name}: {c.note}</li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="危险区">
          <Btn className="danger" onClick={rotate} disabled={busy}>全端下线（轮换会话密钥）</Btn>
          <span className="mid">让所有已登录会话（浏览器 / CLI）立即失效，需重新走 SSO 登录——低频应急操作。</span>
        </Row>
      </Card>
    </>
  );
}
