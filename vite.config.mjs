import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // Tauri 使用 custom protocol (tauri://localhost/)，必须用相对路径
  // 否则 dist/index.html 中 /assets/xxx.js 的绝对路径在 custom protocol 下找不到
  base: './',

  plugins: [tailwindcss(), react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Tauri 桌面端通过 tauri://localhost/ custom protocol 加载，无法走 HTTP 多路并行拉取。
    // 将体积最大的第三方运行库拆成独立 chunk，从而复用缓存并减少首屏需解析的主 chunk 体积。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules\/(react|react-dom|react-is|scheduler|i18next|react-i18next|zustand|framer-motion|clsx)\//,
            },
            {
              name: 'canvas-vendor',
              test: /node_modules\/(konva|react-konva|js-yaml)\//,
            },
          ],
        },
      },
    },
  },
}));
