import { defineConfig } from 'vite';
import solidYield from 'vite-plugin-solid-yield';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  // The yield transform (`yield*` in JSX → `perform(…)`) runs before Solid's JSX compiler.
  plugins: [solidYield(), solid()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    // API_URL points the dev proxy at a server on another port.
    proxy: Object.fromEntries(['/api', '/events', '/webhook'].map((path) => [path, process.env.API_URL ?? 'http://127.0.0.1:8080'])),
  },
});
