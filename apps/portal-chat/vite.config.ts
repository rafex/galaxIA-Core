import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      // DEC-0035: Atlas y Navigator son procesos separados en dev también —
      // /api/fhs/* (catálogo) va a Atlas, el resto de /api (chat) a Navigator.
      '/api/fhs': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8083',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
