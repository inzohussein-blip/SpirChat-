import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const hub = process.env.HUB ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2020', chunkSizeWarningLimit: 800 },
  server: {
    host: true,
    proxy: {
      '/api': hub,
      '/ws': { target: hub.replace(/^http/, 'ws'), ws: true },
    },
  },
});
