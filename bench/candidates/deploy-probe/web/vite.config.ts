import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid()],
  define: { __BUILD__: JSON.stringify(process.env.BUILD ?? 'dev') },
  build: { outDir: process.env.OUT ?? '../server/public', emptyOutDir: true },
  server: {
    // API_URL points the dev proxy at a server on another port.
    proxy: Object.fromEntries(['/api', '/events', '/webhook'].map((path) => [path, process.env.API_URL ?? 'http://127.0.0.1:8080'])),
  },
});
