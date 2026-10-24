# A02 · gost 相关使用方法（relay / 隧道 / 守卫）

> 场景：注册一条内网穿透、本地常驻转发、观察 bind 守卫。设计背景见 [[B01-网络模型]]。

## 前置凭据

- relay 账号口令：服务器 `/opt/gost-as/data/gost-auth.env`（首启生成：`NXAS_GOST_USER` / `NXAS_GOST_PASS`）
- server 面板地址：`http://<server>:8090/_nxas`；登录 = 浏览器 SSO（白名单邮箱）

## 注册一条隧道（两种姿势）

```bash
# 姿势一：全流程（本机清单 + gost -L + server conf 一次到位）——先配对
nx-as client login --server http://<server>:8090/_nxas     # 浏览器 SSO 配对（无独立 token）
nx-as client register <名> <本地端口> [--public-port P]     # 例：nx-as client register sqlh 7877

# 姿势二：只写 server 侧 conf（本地转发自己管）
nx-as nginx tunnel apply <名> --public-port <P>            # 服务端单一模板渲染（备份→nginx -t→reload）
nx-as nginx tunnel remove <名>                             # 注销（conf 先备份）
```

安全组记得放行公网端口 `<P>`（阿里云控制台）。

## 本地 gost 常驻转发（关键：必须独立进程）

```powershell
# Windows 隐藏窗口常驻（端口约定：rtcp 回环监听 = 10000 + 公网端口）
gost -L "rtcp://127.0.0.1:17877/127.0.0.1:7877" -F "relay://gost:<密码>@<server>:8442"
# 多隧道就加多组 -L；gost ≥3.2
```

> ⚠️ **别用一次性命令注册后指望它常驻**：`nx-as client register` 由 CLI 进程拉起的 gost 会随 CLI 退出而断开（server 日志 EOF 实锤）。常驻三种方式：手动命令 / `nx-as client serve` 面板管理 / 计划任务开机启动。
> ⚠️ **bind 地址永远带 `127.0.0.1:` 前缀**——写裸 `:端口` 会在服务器开全接口监听 = 绕过鉴权的裸穿透（bind-audit 守卫会告警，见下）。

## 验证与排查

```bash
# 三态验证（公网端口）
curl -o /dev/null -w '%{http_code} %{redirect_url}\n' http://<server>:<P>/          # 未登录 → 302 /_nxas/login
curl -H "Cookie: nxas_session=<token>" -o /dev/null -w '%{http_code}\n' http://<server>:<P>/  # 带会话 → 非 401/302
# server 侧
ssh <server> "ss -tln | grep <P>; docker logs gost-as --since 10m | grep -E 'bind|bind-audit' | tail -5"
```

## bind 守卫（安全自检）

```bash
# 观察：每 60s 一轮；安静=无未授权公网监听
docker logs gost-as --since 5m | grep bind-audit
docker exec gost-as tail -3 /data/audit.jsonl        # gost.bind_abuse = 抓到越权 bind
# 自测（在自己的服务器上验证守卫活着）：本地起一个全接口 bind，60s 内应告警
gost -L "rtcp://:23499/127.0.0.1:9999" -F "relay://gost:<密码>@<server>:8442"   # 测完 Ctrl+C
```

新增**合法**公网端口：走 nginx conf（tunnel apply 自动被守卫收集）或加 compose 的 `NXAS_BIND_AUDIT_ALLOW`。
