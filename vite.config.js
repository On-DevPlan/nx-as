import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端源码根下的文件会被暴露成 URL：src/web/frontend/api/client.js → /api/client.js。
// 而 /api 又是后端接口前缀，于是前端自己的模块请求会被代理吞掉——浏览器拿到 JSON、
// import 失败、整页白屏。按「是不是前端资源」决定走不走代理（A08 规范，勿删）。
const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

export function shouldServeLocally(url) {
  const path = String(url || '').split('?')[0];
  return FRONTEND_ASSET.test(path) ? path : undefined; // 真值 = 交回 Vite
}

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: {
    // 构建产物落仓库根 public/（src/web/frontend 上溯 3 层；不进 src/，git 不入库）
    outDir: '../../../public',
    // outDir 在 root 之外时 vite 默认不清空，必须显式开启（否则旧 hashed 资源残留）
    emptyOutDir: true,
    // 双 entry（input 相对 cwd=仓库根；rollup 按 inputs 公共祖先保持输出目录结构）：
    //   src/web/frontend/index.html        → public/index.html        （server 面板）
    //   src/web/frontend/client/index.html → public/client/index.html （本地 client 管理面）
    rollupOptions: {
      input: {
        main: 'src/web/frontend/index.html',
        client: 'src/web/frontend/client/index.html',
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7801',
        bypass: (req) => shouldServeLocally(req.url),
      },
    },
  },
});
