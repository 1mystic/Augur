import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, rollupOptions: { input: { home: 'index.html', app: 'app.html' } } },
  worker: { format: 'es' },
  // cross-origin isolation -> SharedArrayBuffer -> multi-threaded stockfish
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
