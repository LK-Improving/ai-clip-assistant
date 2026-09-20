import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 渲染进程构建配置：React 19 + TailwindCSS 4
 *
 * 约定（与 @electron-forge/plugin-vite 对齐）：
 * - root 指向 src，入口为 src/index.html；
 * - 产物落在 .vite/renderer/main_window/，主进程以 `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html` 加载。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src'),
  // 相对资源路径：Electron 生产环境以 file:// 加载（与 Forge 默认 base 一致）
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
