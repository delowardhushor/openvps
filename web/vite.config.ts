import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs separately (npm run dev:server, port 7800) and
// Vite proxies /api to it, so the browser sees a single origin just like production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7800', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // No inline scripts/styles so the production CSP can stay strict.
    assetsInlineLimit: 0,
  },
});
