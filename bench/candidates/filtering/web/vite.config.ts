import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    // One entry per variant; the server serves the one BENCH_VARIANT names at `/`.
    rollupOptions: { input: { server: 'server.html', client: 'client.html', worker: 'worker.html', hybrid: 'hybrid.html' } },
  },
  worker: { format: 'es' },
  server: {
    // API_URL points the dev proxy at a server on another port.
    proxy: Object.fromEntries(['/api', '/events', '/webhook'].map((path) => [path, process.env.API_URL ?? 'http://127.0.0.1:8080'])),
  },
});
