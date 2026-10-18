import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid()],
  build: { outDir: '../server/public', emptyOutDir: true },
  worker: { format: 'es' },
  server: {
    // API_URL points the dev proxy at a server on another port.
    proxy: Object.fromEntries(['/api', '/events', '/webhook', '/bench'].map((path) => [path, process.env.API_URL ?? 'http://127.0.0.1:8080'])),
  },
});
