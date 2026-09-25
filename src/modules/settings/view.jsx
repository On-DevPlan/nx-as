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
        maxConcurrent: Number(s.maxConcurrent),
        autoRun: Boolean(s.autoRun),
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
      <Row label="并发数">
        <Input value={String(s.maxConcurrent)} onChange={(v) => setS({ ...s, maxConcurrent: Number(v) || 1 })} />
      </Row>
      <Row label="创建即执行">
        <input type="checkbox" checked={Boolean(s.autoRun)} onChange={(e) => setS({ ...s, autoRun: e.target.checked })} />
        <span className="mid"> task add 后自动开始执行</span>
      </Row>
      <Row label="">
        <Btn onClick={save}>保存</Btn>
        {saved && <span className="tag strong">已保存</span>}
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}

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
        <span className="mid">
          配置保存后立即生效（nx-as 会重新生成 pi 扩展）。任务里用 <code>model: "{s.bearerProvider || 'MiniMax'}/模型ID"</code>
        </span>
      </Row>
    </Card>
  );
}
