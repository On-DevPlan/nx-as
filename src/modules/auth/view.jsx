import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function AuthView() {
  const [status, setStatus] = useState(null);
  const [newToken, setNewToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('GET', '/api/auth/status'));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const rotate = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/auth/rotate');
      setNewToken(r.token);
      // rotate 后旧密钥失效，立刻更新本地
      localStorage.setItem('nxas_token', r.token);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="密钥">
      <Row label="状态">
        {status ? (
          <>
            <span className={status.configured ? 'tag strong' : 'tag'}>
              {status.configured ? '已配置' : '未配置'}
            </span>{' '}
            <span className="mono">{status.masked || '-'}</span>{' '}
            <span className="tag">来源: {status.source}</span>
          </>
        ) : (
          '加载中'
        )}
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}
      {newToken && (
        <Row label="新密钥">
          <span className="mono copyable" onClick={() => navigator.clipboard.writeText(newToken)}>
            {newToken}（点击复制）
          </span>
        </Row>
      )}
      <Row label="">
        <Btn onClick={rotate} disabled={busy}>
          {busy ? '轮换中' : '轮换密钥'}
        </Btn>
        <span className="mid"> 轮换后旧密钥立即失效，App 需更新</span>
      </Row>
    </Card>
  );
}
