// 登录会话 cookie：浏览器场景的凭据载体
// - POST /auth/login { token } → 验 device token → Set-Cookie（HMAC 签名，7 天）
// - check.js 决策时无 Bearer 头则认 cookie（同源请求浏览器自动携带）
// - cookie 格式: nxas_s1.<deviceId>.<过期秒>.<HMAC(serverSecret)>
//   serverSecret = 进程随机（重启全员失效——与会话语义一致）
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;   // 7 天
export const SESSION_COOKIE = 'nxas_session';

const serverSecret = randomBytes(32);

function sign(payload) {
  return createHmac('sha256', serverSecret).update(payload).digest('hex');
}

// 签发：返回 cookie 值（调用方负责 Set-Cookie 头）
export function issueSessionCookie(deviceId) {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(SESSION_TTL_MS / 1000);
  const payload = `nxas_s1.${deviceId}.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

// 校验：返回 deviceId 或 null（过期/篡改/格式错一律 null）
export function verifySessionCookie(value) {
  if (typeof value !== 'string') return null;
  const m = /^(nxas_s1\.([a-z0-9_]+)\.(\d{10}))\.([0-9a-f]{64})$/i.exec(value);
  if (!m) return null;
  const [, payload, deviceId, expStr, sig] = m;
  if (Number(expStr) * 1000 < Date.now()) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? deviceId : null;
}

// 从 Cookie 头解析 nxas_session 值
export function sessionFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
  return m ? decodeURIComponent(m[1]) : null;
}

// 登录端点句柄：POST /auth/login { token }（JSON）
export async function handleLogin(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', async () => {
    let token = '';
    try { token = String(JSON.parse(body || '{}').token || ''); } catch { /* 统一 401 */ }
    const { verifyDeviceToken } = await import('../../modules/gateway/service.js');
    const device = await verifyDeviceToken(`Bearer ${token}`);
    if (!device) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'token 无效', code: 'UNAUTHORIZED' }));
    }
    const { value, maxAgeSec } = issueSessionCookie(device.id);
    const cookies = [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`,
    ];

    // 上游会话自动交接（0 感知登录）：主进程需要密码时，nx-as 用机机信任代签，
    // 浏览器无需知道主程序密码。当前实现针对 pi-web（POST /api/web-auth）。
    // 通用性：NXAS_BOOTSTRAP_PATH + NXAS_BOOTSTRAP_BODY 可指向任意上游登录端点。
    if (process.env.NXAS_BOOTSTRAP !== '0') {
      try {
        const upstreamPort = process.env.NXAS_TARGET_PORT || '30141';
        const bootstrapPath = process.env.NXAS_BOOTSTRAP_PATH || '/api/web-auth';
        const { loadStore } = await import('../../core/store.js');
        const store = await loadStore();
        const secret = store.machineSecret || '';
        const r = await fetch(`http://127.0.0.1:${upstreamPort}${bootstrapPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Host: `127.0.0.1:${upstreamPort}`,
          },
          body: JSON.stringify({ password: secret }),
        });
        const setCookie = r.headers.getSetCookie?.() || [];
        for (const c of setCookie) cookies.push(c.replace(/;\s*$/, ''));
        if (setCookie.length) {
          console.log(`[nx-as] bootstrap: 上游会话已代签（${bootstrapPath}，${setCookie.length} cookie）`);
        }
      } catch (e) {
        // 主程序不支持 bootstrap（非 pi-web / 无需登录）——静默跳过，不影响 nx-as 登录
        console.log(`[nx-as] bootstrap 跳过（上游无会话端点）：${e.message}`);
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookies,
    });
    res.end(JSON.stringify({ ok: true, device: { id: device.id, name: device.name } }));
  });
}

// 登录页（极简：粘贴 token → POST /auth/login → 写 cookie → 回 next）
export function handleLoginPage(req, res, nextUrl) {
  const safeNext = /^\/(?!\/)/.test(nextUrl || '') ? nextUrl : '/';
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>nx-as 登录</title>
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#222}
h2{font-weight:600} input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;font-family:monospace}
button{width:100%;padding:10px;background:#1a1a1a;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:15px}
.err{color:#c0392b;font-size:14px;min-height:20px} .hint{color:#888;font-size:12px;margin-top:16px}
</style></head><body>
<h2>nx-as 登录</h2>
<p class="hint">粘贴 device token（nxas_d1....，由管理员 nx-as device pair 签发）</p>
<input id="t" placeholder="nxas_d1.xxxxxxxx.yyy..." autocomplete="off">
<button onclick="doLogin()">登录</button>
<div class="err" id="e"></div>
<p class="hint">token 兑换为 7 天会话 cookie；本页不存储 token 本身。</p>
<script>
async function doLogin(){
  const e=document.getElementById('e'); e.textContent='';
  try{
    // nginx 模式部署在 /_nxas/ 前缀下：登录 API 走同前缀；直连 7801 / direct 模式不变
    const base = location.pathname.startsWith('/_nxas') ? '/_nxas' : '';
    const r=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('t').value.trim()})});
    if(!r.ok){const j=await r.json().catch(()=>({})); e.textContent=j.error||('HTTP '+r.status); return;}
    // 登录成功：浏览器已同时拿到 nx-as 会话 cookie 和上游（主程序）会话 cookie
    // —— 直接回原路径，主程序不该再拦（0 感知）
    location.href=${JSON.stringify(safeNext)};
  }catch(err){e.textContent=String(err)}
}
document.getElementById('t').addEventListener('keydown',ev=>{if(ev.key==='Enter')doLogin()});
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
