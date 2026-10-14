import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    // API_URL points the dev proxy at a server on another port.
    proxy: Object.fromEntries(['/api', '/events', '/webhook'].map((path) => [path, process.env.API_URL ?? 'http://127.0.0.1:8080'])),
  },
});
