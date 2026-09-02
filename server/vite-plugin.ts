import type { Connect, Plugin, ViteDevServer } from 'vite';
import { getRequestListener } from '@hono/node-server';

async function attach(server: ViteDevServer | { middlewares: ViteDevServer['middlewares']; ssrLoadModule?: ViteDevServer['ssrLoadModule'] }) {
  server.middlewares.use(async (req: Parameters<Connect.NextHandleFunction>[0], res: Parameters<Connect.NextHandleFunction>[1], next: Connect.NextFunction) => {
    if (!req.url?.startsWith('/api')) {
      next();
      return;
    }
    try {
      const mod = server.ssrLoadModule
        ? await server.ssrLoadModule('/server/app.ts')
        : await import('./app.ts');
      getRequestListener(mod.app.fetch)(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, message: 'Portal API failed to start.' }));
      }
    }
  });
}

export function portalApiPlugin(): Plugin {
  return {
    name: 'bbls-portal-api',
    configureServer(server) {
      return attach(server);
    },
    configurePreviewServer(server) {
      return attach(server as unknown as ViteDevServer);
    },
  };
}
