import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080', '/events': 'http://127.0.0.1:8080', '/webhook': 'http://127.0.0.1:8080' },
  },
});
