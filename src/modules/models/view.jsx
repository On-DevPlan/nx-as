import { useState, useEffect, useCallback } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Card, Btn, Input, Row } from '../../web/frontend/components/ui.jsx';

export default function ModelsView() {
  const [data, setData] = useState(null);
  const [current, setCurrent] = useState('');
  const [err, setErr] = useState('');
  const [ep, setEp] = useState({ provider: '', 'base-url': '', 'api-key-env': '', models: '' });

  const refresh = useCallback(async () => {
    try {
      setData(await api('GET', '/api/models'));
      const c = await api('GET', '/api/models/current');
      setCurrent(c.model === '(pi 默认)' ? '' : c.model);
    } catch (e) {
      setErr(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveModel = async () => {
    setErr('');
    try {
      await api('POST', '/api/models/current', { model: current });
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  const addEndpoint = async () => {
    setErr('');
    try {
      await api('POST', '/api/models/endpoints', {
        provider: ep.provider,
        'base-url': ep['base-url'],
        'api-key-env': ep['api-key-env'],
        models: ep.models.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setEp({ provider: '', 'base-url': '', 'api-key-env': '', models: '' });
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  const removeEndpoint = async (provider) => {
    if (!confirm(`删除端点 ${provider}?`)) return;
    try {
      await api('DELETE', `/api/models/endpoints/${provider}`);
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <Card title="模型">
      <Row label="默认模型">
        <Input value={current} onChange={setCurrent} placeholder="留空 = pi 默认；如 deepseek/deepseek-chat" />
      </Row>
      <Row label="">
        <Btn onClick={saveModel}>保存</Btn>
      </Row>
      {err && <Row label="错误"><span className="bad">{err}</span></Row>}

      <div className="colhead">内置 provider（密钥走环境变量）</div>
      <div className="list">
        {(data?.builtin || []).map((p) => (
          <div key={p.provider} className="row">
            <span className="mono">{p.provider}</span>
            <span className="mid">{p.envVar}</span>
            <span className="tag">{p.models.length} 模型</span>
          </div>
        ))}
      </div>

      <div className="colhead">自定义端点</div>
      <div className="list">
        {Object.entries(data?.custom || {}).map(([id, e]) => (
          <div key={id} className="row">
            <span className="mono">{id}</span>
            <span className="mid">{e.baseUrl}</span>
            <button className="linkbtn" onClick={() => removeEndpoint(id)}>删</button>
          </div>
        ))}
      </div>
      <Row label="provider"><Input value={ep.provider} onChange={(v) => setEp({ ...ep, provider: v })} placeholder="如 my-ollama" /></Row>
      <Row label="baseUrl"><Input value={ep['base-url']} onChange={(v) => setEp({ ...ep, 'base-url': v })} placeholder="http://127.0.0.1:11434/v1" /></Row>
      <Row label="密钥变量"><Input value={ep['api-key-env']} onChange={(v) => setEp({ ...ep, 'api-key-env': v })} placeholder="可选，如 MY_API_KEY" /></Row>
      <Row label="模型列表"><Input value={ep.models} onChange={(v) => setEp({ ...ep, models: v })} placeholder="逗号分隔，如 qwen2.5,llama3" /></Row>
      <Row label=""><Btn onClick={addEndpoint} disabled={!ep.provider || !ep['base-url']}>添加端点</Btn></Row>
    </Card>
  );
}
