// serve 的端口协商 + 浏览器打开策略。
//
// 零业务语义：所有 nx-xx 面板共用这一份，靠环境变量 NX_SERVE_NO_OPEN 统一关闭自动开浏览器。
// 放 core/ 是因为它只依赖 Node 内置模块与「本项目的 app 名」，不涉及任何功能域。
//
// 这份文件在所有 nx-xx 项目之间**逐字节相同**——改一处就要全量同步，
// 否则「口径统一」这件事本身会悄悄分叉。
import net from 'node:net';

/**
 * 所有 nx-xx 项目共享的关闭开关。
 * 设成 1 / true / yes / on 即禁止 `serve` 自动打开浏览器（正常启动与端口复用都算）。
 * 命令行 `--no-open` 只影响这一次；这个环境变量对整个 shell 生效。
 */
export const NO_OPEN_ENV = 'NX_SERVE_NO_OPEN';

/**
 * 探测面板时给的应答窗口。
 *
 * 1500ms 而不是更短：面板的 bootstrap 不一定是纯本机计算——nx-kv 登录后要去后端
 * 拉分组，链路一慢就超过 800ms。窗口太窄的后果不是「探测失败」这么轻，
 * 而是**把自己的面板误判成别人的服务**，于是白起一个实例、占掉第二个端口——
 * 恰好是这套机制要消灭的那种体验。
 */
export const PROBE_TIMEOUT_MS = 1500;

/** 真值判定：1 / true / yes / on（大小写不敏感）算开，其他一律算关。 */
export function isEnvTruthy(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * 是否允许自动打开浏览器。
 * 优先级：`--no-open` 命令行开关 > NX_SERVE_NO_OPEN 环境变量 > 默认允许。
 */
export function autoOpenEnabled(flagNoOpen) {
  if (flagNoOpen) return false;
  return !isEnvTruthy(process.env[NO_OPEN_ENV]);
}

/**
 * 探一次端口，返回 { data, timedOut }。
 *
 * 把「超时」和「不是面板」分开，是因为两者的后续动作不同：
 * 超时说明端口上可能正是一个应答慢的面板，值得再等一次；
 * 明确不是面板就没有再等的必要。
 */
async function probePanelOnce(port, host, timeoutMs, headers) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`http://${host}:${port}/api/bootstrap`, {
        signal: controller.signal,
        headers: headers || undefined,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { data: null, timedOut: false };
    const body = await res.json();
    return { data: (body && body.data) || null, timedOut: false };
  } catch (err) {
    return { data: null, timedOut: !!(err && err.name === 'AbortError') };
  }
}

/**
 * 探测端口上有没有面板在跑：GET /api/bootstrap，短超时。
 *
 * 所有 nx-xx 面板都暴露 /api/bootstrap，响应里带 app.name / app.version ——
 * 这就是跨项目唯一的认领签名（别的服务不会恰好返回它）。
 * 不是面板、无响应、超时一律返回 null。
 *
 * headers 形参给需要鉴权的项目用（nx-as 的管理面要 Bearer 密钥）；
 * 默认不传，匿名探测。
 */
export async function probePanel(port, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS, headers = null) {
  const { data } = await probePanelOnce(port, host, timeoutMs, headers);
  return data;
}

/**
 * 从 start 起逐个试，返回第一个能监听的端口（最多试 50 个）。
 * 用临时 net.Server 探测、立刻关闭；与 startServer 走同一套 EADDRINUSE 判定。
 */
export function findFreePort(start, host = '127.0.0.1') {
  return new Promise((resolve_, reject) => {
    const tryPort = (p) => {
      if (p > start + 50) {
        reject(new Error(`找不到空闲端口（从 ${start} 起连续 50 个被占）`));
        return;
      }
      const probe = net.createServer();
      probe.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') tryPort(p + 1);
        else reject(err);
      });
      probe.listen(p, host, () => probe.close(() => resolve_(p)));
    };
    tryPort(start);
  });
}

/**
 * 端口冲突的统一决策。
 *
 * reuse —— 端口上跑的就是本项目的面板：复用它，不再起第二个进程。
 *          起第二个会让「切项目」变成「切端口」，而用户想看的其实是已经开着的那一个。
 * shift —— 端口被别的东西占着：顺延到下一个空闲端口，再起自己的面板。
 *
 * 返回 { action, port, occupant, existing }：
 *   action   'reuse' | 'shift'
 *   port     reuse 时是原端口；shift 时是下一个空闲端口
 *   occupant 占用者的 app 名（探测不到就是 null）
 */
export async function resolvePortConflict(port, appName, host = '127.0.0.1', headers = null) {
  let probe = await probePanelOnce(port, host, PROBE_TIMEOUT_MS, headers);
  if (probe.timedOut) {
    // 慢应答的面板也认：再等一次。别把「自己的面板」误判成「别人的服务」，
    // 白白再起一个实例——那正是这套机制要消灭的行为。
    probe = await probePanelOnce(port, host, PROBE_TIMEOUT_MS, headers);
  }
  const existing = probe.data;
  const occupant = existing && existing.app ? existing.app.name || null : null;
  if (existing && occupant === appName) {
    return { action: 'reuse', port, occupant, existing };
  }
  const next = await findFreePort(port + 1, host);
  return { action: 'shift', port: next, occupant, existing };
}

/** 占用者的一句话描述，用于终端提示。探测不到就是「未知服务」。 */
export function describeOccupant(occupant) {
  return occupant || '未知服务';
}
