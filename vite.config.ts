import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@stream-player': path.resolve('node_modules/.cache/vct-mpegts/player.js') } },
  plugins: [
    {
      name: 'production-content-security-policy',
      apply: 'build',
      transformIndexHtml: html => html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' media: data:; media-src 'self' media: blob:; connect-src 'self' media:; object-src 'none'; frame-src 'none'; base-uri 'none'">`),
    },
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          // 插件默认附加 --no-sandbox，与主进程 enableSandbox 冲突；显式保持沙箱启动。
          options.startup(['.']);
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          // 首次启动也可能由 preload 构建触发，不能走 reload 内部的默认启动参数。
          options.startup(['.']);
        },
        vite: {
          build: {
            rollupOptions: {
              // 使用输出数组覆盖库模式默认的 ES 格式，确保沙箱 preload 始终为 CommonJS。
              output: [{
                format: 'cjs',
                entryFileNames: 'preload.cjs',
              }],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
});
