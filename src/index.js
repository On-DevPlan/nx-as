// 库入口：导出各模块 action 与 service，供程序化调用
// ⚠️ 新增模块时必须在这里补导出（无断言，纯静默——见脚手架 A07 闭环表第 6 项）

export { default as auth } from './modules/auth/index.js';
export { default as nginx } from './modules/nginx/index.js';
export { default as system } from './modules/system/index.js';

import { auth, nginx, system } from './modules/index.js';

export const ACTIONS = [...auth.actions, ...nginx.actions, ...system.actions];
