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
  build: { outDir: '../public', emptyOutDir: true },
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
