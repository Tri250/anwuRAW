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
    // Desktop app — a single large chunk (2.8 MB, gzip 835 kB) is acceptable.
    // Disables the >500 kB warning since code-splitting gains would be minimal
    // for a Tauri application with no route-based lazy loading.
    chunkSizeWarningLimit: 4000,
  },
}));
