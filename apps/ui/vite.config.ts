import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwind()],
  // Both listeners' CSP refuses data: fonts, so every asset ships as a file.
  build: { outDir: '../../dist/ui', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: '127.0.0.1' },
});
