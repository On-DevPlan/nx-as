import React, { Suspense, lazy, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { VIEWS } from './registry.js';
import { api, setUnauthorizedHandler, apiBaseOf } from './api/client.js';
import { Card, Row } from './components/ui.jsx';

// 懒加载视图
const LAZY = Object.fromEntries(Object.entries(VIEWS).map(([id, load]) => [id, lazy(load)]));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card">
          <h3 className="colhead">视图出错了</h3>
          <div className="row">
            <span className="bad mono">{String(this.state.error?.message || this.state.error)}</span>
          </div>
          <div className="row">
            <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// 跳 SSO 登录并携带回跳地址（站内相对路径）
export function gotoLogin() {
  const next = window.location.pathname + window.location.search;
  location.href = `${apiBaseOf()}/oidc/login?next=${encodeURIComponent(next)}`;
}

// 鉴权门：SSO 会话探测。未登录不再输密钥——直接 302 去 go-ah 单点登录
//（会话 cookie HttpOnly，浏览器同源自动携带；7 天有效，过期重新走一遍静默跳转）
function AuthGate({ children, onIdentity }) {
  const [ok, setOk] = useState(null); // null = 检查中
  const [err, setErr] = useState('');

  // 探测可重入：网络/服务暂不可达时给「重试」，不逼用户整页刷新（401 由 api() 整页接管）
  const probe = () => {
    setErr(''); setOk(null);
    api('GET', '/api/auth/me')
      .then((r) => {
        onIdentity?.(r);
        setOk(true);
      })
      .catch((e) => {
        setErr(String(e.message || e));
        setOk(false);
      });
  };
  useEffect(() => { probe(); }, []);

  if (ok === null) return <div className="card">连接中...</div>;
  if (!ok) {
    // 401 已由 api() 的 onUnauthorized 接管（跳登录）；这里兜底展示网络/服务错误
    return (
      <Card title="无法确认登录状态">
        <Row label=""><span className="bad">{err}</span></Row>
        <Row label="">
          <button className="btn" onClick={probe}>重试</button>
          <button className="btn" onClick={gotoLogin}>去登录</button>
          <span className="mid">服务器暂不可达（重启中）时点重试即可，无需整页刷新</span>
        </Row>
      </Card>
    );
  }
  return children;
}

function App() {
  const tabs = Object.keys(LAZY);
  const [active, setActive] = useState(tabs[0]);
  const [me, setMe] = useState(null);
  const Active = LAZY[active];

  return (
    <AuthGate onIdentity={setMe}>
      <header>
        <span className="brand"><img src="/logo-rounded.png" alt="" />nx-as</span>
        <nav>
          {tabs.map((t) => (
            <button key={t} className={t === active ? 'tab active' : 'tab'} onClick={() => setActive(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="mid" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={gotoLogin} title="点击重新登录 / 刷新身份">
          {me?.email || me?.name || ''}
        </span>
      </header>
      <main>
        <ErrorBoundary>
          <Suspense fallback={<div className="card">加载中...</div>}>
            <Active />
          </Suspense>
        </ErrorBoundary>
      </main>
    </AuthGate>
  );
}

setUnauthorizedHandler(() => {
  // 会话缺失/过期：整页跳 SSO 登录（go-ah 全局会话 30 天内通常是无感跳转）
  gotoLogin();
});

createRoot(document.getElementById('root')).render(<App />);
