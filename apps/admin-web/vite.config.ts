import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: 'http://localhost:3000', rewrite: (path) => path.replace(/^\/auth/, '') },
      '/data': { target: 'http://localhost:3001', rewrite: (path) => path.replace(/^\/data/, '') },
      '/control': {
        target: 'http://localhost:3002',
        rewrite: (path) => path.replace(/^\/control/, ''),
      },
      '/management': {
        target: 'http://localhost:3003',
        rewrite: (path) => path.replace(/^\/management/, ''),
      },
      '/socket.io': { target: 'http://localhost:3003', ws: true },
    },
  },
});
