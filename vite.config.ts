import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { portalApiPlugin } from './server/vite-plugin';

export default defineConfig({
  appType: 'spa',
  plugins: [react(), portalApiPlugin()],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  server: {
    host: true,
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
});
