// 视图注册表：模块 id → 懒加载的 view 组件
// 后端有 view 的模块必须在这里登记（一致性测试对账）

export const VIEWS = {
  auth: () => import('../../modules/auth/view.jsx'),
  tasks: () => import('../../modules/tasks/view.jsx'),
  prompts: () => import('../../modules/prompts/view.jsx'),
  models: () => import('../../modules/models/view.jsx'),
  settings: () => import('../../modules/settings/view.jsx'),
  plugins: () => import('../../modules/plugins/view.jsx'),
};
