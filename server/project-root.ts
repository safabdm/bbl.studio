/**
 * Resolve the repo root from a module URL without crashing under Vercel.
 *
 * `@vercel/node` / esbuild often emit API bundles as CJS, where `import.meta`
 * is emptied. Calling `fileURLToPath(import.meta.url)` at module init then
 * throws and the whole catch-all function returns FUNCTION_INVOCATION_FAILED.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveProjectRoot(moduleUrl: unknown, up = '..'): string {
  try {
    if (typeof moduleUrl === 'string' && moduleUrl.startsWith('file:')) {
      return resolve(dirname(fileURLToPath(moduleUrl)), up);
    }
  } catch {
    // Bundled / non-file URL — fall through.
  }
  return process.cwd();
}
