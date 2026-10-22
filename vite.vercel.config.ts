import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  plugins: [react()],
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
  build: {
    outDir: 'out',
    emptyOutDir: true,
    sourcemap: false,
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
            id.includes('app/portal-screens')
            || id.includes('app/portal.css')
            || id.includes('app/crm-dashboard')
            || id.includes('app/crm.css')
            || id.includes('lib/portal')
            || id.includes('server/packages')
            || id.includes('server/crm-types')
          ) {
            return 'portal';
          }
        },
      },
    },
  },
});
