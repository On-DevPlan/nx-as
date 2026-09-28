import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function SettingsView() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setS(await api('GET', '/api/settings'));
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    setErr('');
    setSaved(false);
    try {
      const patch = {
        bearerProvider: s.bearerProvider,
        bearerBaseUrl: s.bearerBaseUrl,
        bearerModels: s.bearerModels,
      };
      // 只有用户真改了 token 才提交（展示的是掩码）
      if (s.bearerTokenInput) patch.bearerToken = s.bearerTokenInput;
      await api('PATCH', '/api/settings', patch);
      setSaved(true);
      setS({ ...s, bearerTokenInput: '' });
      setTimeout(() => setSaved(false), 2000);
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  const clearToken = async () => {
    if (!confirm('清除已保存的 Bearer token？（代理模型将不可用）')) return;
    try {
      await api('PATCH', '/api/settings', { bearerToken: '' });
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!s) return <Card title="设置">加载中{err ? ` — ${err}` : ''}</Card>;

  return (
    <Card title="设置">
      <div className="colhead">Anthropic 兼容代理（MiniMax 等）</div>
      <Row label="provider">
        <Input value={s.bearerProvider} onChange={(v) => setS({ ...s, bearerProvider: v })} placeholder="MiniMax" />
      </Row>
      <Row label="baseUrl">
        <Input value={s.bearerBaseUrl} onChange={(v) => setS({ ...s, bearerBaseUrl: v })} placeholder="https://api.minimaxi.com/anthropic" />
      </Row>
      <Row label="模型列表">
        <Input value={s.bearerModels} onChange={(v) => setS({ ...s, bearerModels: v })} placeholder="逗号分隔，如 MiniMax-M3" />
      </Row>
      <Row label="token">
        <Input
          value={s.bearerTokenInput ?? ''}
          onChange={(v) => setS({ ...s, bearerTokenInput: v })}
          placeholder={s.hasBearerToken ? `已保存: ${s.bearerToken}（留空则不改）` : 'sk-cp-...'}
        />
        {s.hasBearerToken && <button className="linkbtn" onClick={clearToken}>清除</button>}
      </Row>
      <Row label="">
        <Btn onClick={save}>保存</Btn>
        {saved && <span className="tag strong">已保存</span>}
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}
      <Row label="">
        <span className="mid">
          保存后 nx-as 重新生成 pi 扩展，pi-web 新会话即用新配置。模型/插件管理请用 pi-web 自带的设置页。
        </span>
      </Row>
    </Card>
  );
}
