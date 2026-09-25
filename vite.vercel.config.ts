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
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'out',
    emptyOutDir: true,
    cssMinify: true,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes('portal'));
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('app/portal-screens') ||
            id.includes('app/leads-screens') ||
            id.includes('app/portal.css') ||
            id.includes('lib/portal') ||
            id.includes('server/packages')
          ) {
            return 'portal';
          }
        },
      },
    },
  },
});
