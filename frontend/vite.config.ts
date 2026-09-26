import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname),
  base: './',
  server: {
    // Bind on all interfaces so the dashboard is reachable from outside the
    // container, and honour an injected PORT so it does not fight a managed
    // preview for 5173. Local development still lands on 5173.
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    cors: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
