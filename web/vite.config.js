import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发态把 /api 代理到后端；容器内构建产物由 Express 托管
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
