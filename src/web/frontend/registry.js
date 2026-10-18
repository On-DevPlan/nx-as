// 视图注册表：模块 id → 懒加载的 view 组件
// 后端有 view 的模块必须在这里登记（一致性测试对账）；对象键顺序 = 面板 tab 顺序
// （nginx 是本工具的本职，放第一位作为默认 tab）

export const VIEWS = {
  nginx: () => import('../../modules/nginx/view.jsx'),
  gateway: () => import('../../modules/gateway/view.jsx'),
  auth: () => import('../../modules/auth/view.jsx'),
  cert: () => import('../../modules/cert/view.jsx'),
  system: () => import('../../modules/system/view.jsx'),
};
