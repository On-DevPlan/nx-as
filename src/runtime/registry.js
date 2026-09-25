import { ACTIONS } from '../index.js';

// 模块注册表：id ↔ 目录名一致；带 view 的模块必须有 view.jsx
export const MODULES = [
  { id: 'auth', view: true },
  { id: 'tasks', view: true, resource: 'task' },
  { id: 'prompts', view: true, resource: 'prompt' },
  { id: 'models', view: true },
  { id: 'settings', view: true },
  { id: 'system', view: false },
  { id: 'plugins', view: true },
];

// 装载期自检：重复 id / 缺 cli / 缺 run / 路由重复 —— 启动瞬间失败
function selfCheck(actions) {
  const seenIds = new Set();
  const seenCli = new Set();
  const seenHttp = new Set();

  for (const a of actions) {
    if (seenIds.has(a.id)) throw new Error(`action id 重复: ${a.id}`);
    seenIds.add(a.id);

    const paths = Array.isArray(a.cli?.[0]) ? a.cli : [a.cli];
    if (!paths?.length || !paths[0]?.length) throw new Error(`action 没有 CLI 命令: ${a.id}`);
    for (const p of paths) {
      const key = p.join(' ');
      if (seenCli.has(key)) throw new Error(`CLI 命令重复: ${key}`);
      seenCli.add(key);
    }

    if (!a.run) throw new Error(`action 缺少 run: ${a.id}`);

    if (a.http) {
      if (!Array.isArray(a.http) || a.http.length !== 2) {
        throw new Error(`action http 必须是 ['METHOD', '/path'] 或 null: ${a.id}`);
      }
      const key = a.http.join(' ');
      if (seenHttp.has(key)) throw new Error(`路由重复: ${key}`);
      seenHttp.add(key);
    } else if (a.http !== null && a.http !== undefined) {
      throw new Error(`action http 必须是数组或 null: ${a.id}`);
    }

    // args 与路由占位符的同名绑定检查（对不上会静默 undefined）
    // 规则：args 名要么出现在 http 路径占位符，要么在 flags 里同名，
    // 要么是 body 字段（GET/DELETE 无 body 的动作必须落在前两者之一）
    if (a.http && a.args) {
      const keys = a.http[1].split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
      const hasBody = a.http[0] !== 'GET' && a.http[0] !== 'HEAD' && a.http[0] !== 'DELETE';
      for (const arg of a.args) {
        const name = typeof arg === 'string' ? arg : arg.name;
        if (!keys.includes(name) && !(a.flags && a.flags[name]) && !hasBody) {
          throw new Error(`action ${a.id}: args 里的 ${name} 在 http 占位符/flags 里都找不到同名绑定，且该动作无 body`);
        }
      }
    }
  }
}

selfCheck(ACTIONS);
