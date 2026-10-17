import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const studioOrigin = 'http://127.0.0.1:4310';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('../src/domain', import.meta.url)),
      '@api': fileURLToPath(new URL('../src/studio/api-types.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': studioOrigin,
      '/media': studioOrigin,
      '/fonts': studioOrigin,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
