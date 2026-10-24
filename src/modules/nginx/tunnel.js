// gost 隧道 server 块：**唯一模板源**。
// 注册方（client 域 registerTunnel / scripts/nxas-tunnel.mjs）一律调 nginx.tunnelApply
// 这条 action，不各自嵌 conf 模板——模板散落曾造成登录链路与鉴权模型分叉
//（conf 的 @nxas_login 落点、auth_check 委托必须与 server.js 的路由同步演化）。
//
// 网络模型（公网唯一暴露面 = nginx）：
//   公网 :<pubPort> → nginx(auth_request → SSO 会话校验) → 127.0.0.1:<10000+pubPort>(gost rtcp 回环绑定) → 隧道 → 本地服务
// gost relay 本体也只绑回环（公网 relay 口由 nginx stream L4 反代，见 docker/entrypoint-gost.sh）。
import { writeConfigFile, deleteConfigFile } from './files.js';
import { badInput } from '../../core/errors.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const PORT_RE = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

export function tunnelFileName(name) {
  return `nxas-tunnel-${name}.conf`;
}

/** 渲染隧道 server 块（纯函数，测试直接锚内容）。 */
export function tunnelConf({ name, pubPort, apiPort, rtcpPort }) {
  return `# nx-as gost 隧道: ${name}（公网 :${pubPort} → gost 回环 :${rtcpPort} → 本地服务）
# 由 nginx.tunnelApply 生成（服务端单一模板）。公网流量必须经 auth_request（SSO 会话）鉴权，
# gost rtcp 只绑 127.0.0.1——绕过 nginx 的直连路径不存在。
server {
    listen ${pubPort};
    server_name _;

    # /_nxas/*：登录链路与面板资产（每个隧道端口自带一份，登录后跳回原端口原路径）
    location /_nxas/ {
        proxy_pass http://127.0.0.1:${apiPort}/_nxas/;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    # 面板 SPA 静态资源（/panel 页面的 JS/CSS/favicon——没有这两段，隧道口的面板白屏：
    # index.html 经 /_nxas/ 拿得到，但 /assets/*.js 会落进下面的数据面被转发到本地服务）
    location /assets/ {
        proxy_pass http://127.0.0.1:${apiPort}/assets/;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location ~ ^/(favicon\\.ico|favicon-\\d+\\.png|logo(-rounded)?\\.png|manifest\\.webmanifest)$ {
        proxy_pass http://127.0.0.1:${apiPort};
    }

    # auth_request 委托：到 nx-as /_nxas/auth/check 验 SSO 会话（cookie 或 Bearer）
    location = /_tunnel_auth_${pubPort} {
        internal;
        proxy_pass http://127.0.0.1:${apiPort}/_nxas/auth/check;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-Uri $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location @nxas_login_${pubPort} {
        return 302 /_nxas/login?next=$request_uri;
    }

    # 数据面：先鉴权再进隧道（auth_request 401 → 跳 SSO 登录；未登录者到不了 gost）
    location / {
        auth_request /_tunnel_auth_${pubPort};
        auth_request_set $nxas_device $upstream_http_x_device_id;
        error_page 401 = @nxas_login_${pubPort};
        proxy_pass http://127.0.0.1:${rtcpPort};
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Forwarded-For $remote_addr;
        add_header X-Nxas-Device $nxas_device always;
    }
}
`;
}

/** 注册/更新隧道：单一模板渲染 → 走文件管线（备份→nginx -t 失败还原→reload）。 */
export async function upsertTunnel({ name, public: pub }) {
  if (!name || !NAME_RE.test(name)) throw badInput(`非法隧道名: ${JSON.stringify(name)}（字母数字._-，32 内）`);
  if (!PORT_RE(pub)) throw badInput('--public-port 必须是 1-65535 整数');
  const rtcpPort = 10000 + pub;
  if (rtcpPort > 65535) throw badInput(`公网端口 ${pub} 过大（10000+pub 超出范围）`);
  const apiPort = Number(process.env.NXAS_API_PORT || 7801);
  const conf = tunnelConf({ name, pubPort: pub, apiPort, rtcpPort });
  const r = await writeConfigFile(tunnelFileName(name), conf);
  return { status: 'ok', name, public: pub, rtcpPort, ...r };
}

/** 注销隧道：删除 conf（先备份；nginx -t 失败还原）。 */
export async function removeTunnel({ name }) {
  if (!name || !NAME_RE.test(name)) throw badInput(`非法隧道名: ${JSON.stringify(name)}`);
  const r = await deleteConfigFile(tunnelFileName(name));
  return { status: 'ok', name, ...r };
}
