import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
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
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        // Split large third-party libraries into cacheable vendor chunks so the
        // app shell loads first and repeat launches reuse unchanged chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('framer-motion')) return 'vendor-motion';
          if (id.includes('konva')) return 'vendor-canvas';
          if (id.includes('@dnd-kit')) return 'vendor-dnd';
          if (id.includes('i18next')) return 'vendor-i18n';
          if (id.includes('lucide-react') || id.includes('simple-icons')) return 'vendor-icons';
          if (id.includes('@clerk')) return 'vendor-clerk';
          if (id.includes('viem') || id.includes('@noble') || id.includes('@scure') || id.includes('@base-org')) {
            return 'vendor-web3';
          }
          if (id.includes('@tauri-apps')) return 'vendor-tauri';
          if (id.includes('@uiw')) return 'vendor-color';
          if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
}));
