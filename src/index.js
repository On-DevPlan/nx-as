// 库入口：导出各模块 action 与 service，供程序化调用
// ⚠️ 新增模块时必须在这里补导出（无断言，纯静默——见脚手架 A07 闭环表第 6 项）

export { default as auth } from './modules/auth/index.js';
export { default as tasks } from './modules/tasks/index.js';
export { default as prompts } from './modules/prompts/index.js';
export { default as models } from './modules/models/index.js';
export { default as settings } from './modules/settings/index.js';
export { default as system } from './modules/system/index.js';
export { default as plugins } from './modules/plugins/index.js';

import { auth, tasks, prompts, models, settings, system, plugins } from './modules/index.js';

export const ACTIONS = [...auth.actions, ...tasks.actions, ...prompts.actions, ...models.actions, ...settings.actions, ...system.actions, ...plugins.actions];
