import React, { Suspense, lazy, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { VIEWS } from './registry.js';
import { api, setUnauthorizedHandler, getToken } from './api/client.js';

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

function TokenGate({ children }) {
  const [ok, setOk] = useState(null); // null = 检查中
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');

  const check = async (token) => {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/auth/verify', { headers });
      const data = await res.json();
      if (data.valid) {
        localStorage.setItem('nxas_token', token);
        setOk(true);
      } else {
        setOk(false);
        setErr(token ? '密钥不正确' : '请输入密钥（serve 启动时终端会打印，或 auth status 查看）');
      }
    } catch {
      setOk(false);
      setErr('无法连接服务');
    }
  };

  useEffect(() => {
    check(getToken());
  }, []);

  if (ok === null) return <div className="card">连接中...</div>;
  if (!ok) {
    return (
      <Card title="密钥">
        <Row label="密钥">
          <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="nxas_..." />
        </Row>
        {err && <Row label=""><span className="bad">{err}</span></Row>}
        <Row label="">
          <button className="btn" onClick={() => check(input)}>验证</button>
        </Row>
      </Card>
    );
  }
  return children;
}

function App() {
  const tabs = Object.keys(LAZY);
  const [active, setActive] = useState(tabs[0]);
  const Active = LAZY[active];

  return (
    <TokenGate>
      <header>
        <span className="brand">nx-as</span>
        <nav>
          {tabs.map((t) => (
            <button key={t} className={t === active ? 'tab active' : 'tab'} onClick={() => setActive(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main>
        <ErrorBoundary>
          <Suspense fallback={<div className="card">加载中...</div>}>
            <Active />
          </Suspense>
        </ErrorBoundary>
      </main>
    </TokenGate>
  );
}

setUnauthorizedHandler(() => {
  localStorage.removeItem('nxas_token');
  location.reload();
});

createRoot(document.getElementById('root')).render(<App />);
