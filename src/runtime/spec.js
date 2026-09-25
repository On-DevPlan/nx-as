// action 规格解析：校验、强转、路由编译、用法串生成
// 业务侧只声明 action；这里负责把声明变成可执行的东西

export function cliPathsOf(action) {
  if (!action.cli) return [];
  return Array.isArray(action.cli[0]) ? action.cli : [action.cli];
}

export function argSpecsOf(action) {
  return (action.args || []).map((a) => (typeof a === 'string' ? { name: a, required: true } : a));
}

export function flagSpecsOf(action) {
  return Object.entries(action.flags || {}).map(([name, spec]) => ({
    name,
    ...(typeof spec === 'string' ? { type: spec } : spec),
  }));
}

// CLI 命令路径匹配用：'skill install --list' 是一条命令路径而非 flag
export function commandTokenOf(action) {
  return cliPathsOf(action)[0].join(' ');
}

// ---------- 路由编译 ----------

// /api/tasks/:id → { regex, keys: ['id'] }
export function compileRoute([method, path]) {
  const keys = [];
  const pattern = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, path, regex: new RegExp(`^${pattern}/?$`), keys };
}

// 路由排序：字面量段优先，让声明顺序不影响匹配
// （GET /api/tasks/events 之类字面量路由不能被 GET /api/tasks/:id 遮蔽）
export function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const sa = a.path.split('/');
    const sb = b.path.split('/');
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const wa = sa[i] === undefined ? -1 : sa[i].startsWith(':') ? 1 : 0;
      const wb = sb[i] === undefined ? -1 : sb[i].startsWith(':') ? 1 : 0;
      if (wa !== wb) return wa - wb;
      if (wa === 0 && sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
    }
    return 0;
  });
}

// ---------- 校验与强转 ----------

// 把两端各自拼出来的扁平 raw ctx 过一遍规格：校验 required / enum，强转类型
// 注意：不给读命令的 flag 注入 default（「没传」是有意义的输入）
export function applySpec(action, raw) {
  const ctx = { ...raw };
  const problems = [];

  for (const spec of argSpecsOf(action)) {
    if (spec.required && (ctx[spec.name] === undefined || ctx[spec.name] === '')) {
      problems.push(`缺少参数 <${spec.name}>`);
    }
  }

  for (const spec of flagSpecsOf(action)) {
    const v = ctx[spec.name];
    if (v === undefined || v === '') continue; // 没传就保持没传
    if (spec.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) problems.push(`--${spec.name} 需要数字，收到: ${v}`);
      else ctx[spec.name] = n;
    } else if (spec.type === 'boolean') {
      ctx[spec.name] = v === true || v === 'true' || v === '';
    } else if (spec.type === 'array') {
      ctx[spec.name] = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (spec.enum) {
      if (!spec.enum.includes(v)) problems.push(`--${spec.name} 必须是 ${spec.enum.join('|')}，收到: ${v}`);
    }
    if (spec.enum && spec.type === 'string' && !spec.enum.includes(ctx[spec.name])) {
      problems.push(`--${spec.name} 必须是 ${spec.enum.join('|')}，收到: ${ctx[spec.name]}`);
    }
  }

  if (problems.length) {
    const err = new Error(`用法: ${usageOf(action)} —— ${problems.join('; ')}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return ctx;
}

export function usageOf(action, binName = 'nx-as') {
  const parts = [binName, ...cliPathsOf(action)[0]];
  for (const a of argSpecsOf(action)) {
    // 命令路径里已含参数名（如 cli: ['task','get','id'] 声明了位置参数占位）时不重复
    if (cliPathsOf(action)[0].includes(a.name)) continue;
    parts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
  }
  for (const f of flagSpecsOf(action)) {
    let token;
    if (f.type === 'boolean') token = `--${f.name}`;
    else {
      const hint = f.enum ? f.enum.join('|') : f.hint || f.name;
      token = `--${f.name} <${hint}>`;
    }
    parts.push(f.required ? token : `[${token}]`);
  }
  return parts.join(' ');
}
