// API 客户端：SSO 会话 cookie 鉴权（浏览器同源自动携带）；401 时整页跳 SSO 登录
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// nginx 模式部署时面板挂在 /_nxas/ 前缀下，管理面 API 走 /_nxas/api/*；
// 直连 7801 或 direct 模式时路径不变
export function apiBaseOf() {
  return window.location.pathname.startsWith('/_nxas') ? '/_nxas' : '';
}

export async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(apiBaseOf() + path, {
    method,
    headers,
    credentials: 'same-origin', // 会话 cookie（HttpOnly）由浏览器自动带上
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error('未登录或会话已过期');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export { setUnauthorizedHandler as on401 };
