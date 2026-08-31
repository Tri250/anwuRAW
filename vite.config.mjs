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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-konva') || id.includes('/konva/')) return 'konva';
          if (id.includes('@clerk')) return 'clerk';
          if (id.includes('framer-motion')) return 'framer';
          if (id.includes('react-window')) return 'virtual';
          if (id.includes('simple-icons')) return 'icons';
          if (id.includes('lucide-react')) return 'lucide';
          if (id.includes('react-dom') || id.includes('/react/')) return 'react';
          if (id.includes('@tauri-apps')) return 'tauri';
        },
      },
    },
  },
}));
