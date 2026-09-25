// API 客户端：自动带 Bearer 密钥；401 时弹出密钥输入
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export function getToken() {
  return localStorage.getItem('nxas_token') || '';
}

export async function api(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error('密钥缺失或错误');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export { setUnauthorizedHandler as on401 };
