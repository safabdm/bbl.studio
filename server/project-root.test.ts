import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from './project-root';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('resolveProjectRoot (serverless-safe)', () => {
  it('resolves a real file: URL to the repo root from server/', () => {
    const root = resolveProjectRoot(import.meta.url);
    assert.equal(root, repoRoot);
  });

  it('falls back to cwd when import.meta.url is emptied (Vercel CJS)', () => {
    assert.equal(resolveProjectRoot(undefined), process.cwd());
    assert.equal(resolveProjectRoot(''), process.cwd());
    assert.equal(resolveProjectRoot({}), process.cwd());
  });

  it('falls back when URL is not a file: scheme', () => {
    assert.equal(resolveProjectRoot('data:text/javascript,1'), process.cwd());
  });
});

describe('CRM catch-all modules under CJS empty import.meta', () => {
  it('loads after esbuild CJS bundle without throwing at module init', () => {
    const find = spawnSync(
      'bash',
      ['-lc', 'find node_modules/.pnpm -path "*/esbuild/bin/esbuild" | head -1'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const esbuild = find.stdout.trim();
    assert.ok(esbuild, 'esbuild binary must be available via pnpm store');

    const dir = mkdtempSync(join(tmpdir(), 'bbls-serverless-init-'));
    const entry = join(dir, 'entry.ts');
    const out = join(dir, 'entry.cjs');

    // Absolute imports so the temp entry can pull the real fixed modules.
    writeFileSync(
      entry,
      `
import { crmSyncStorePath } from ${JSON.stringify(join(repoRoot, 'server/crm-sync-store.ts'))};
import { listTemplates } from ${JSON.stringify(join(repoRoot, 'server/crm-campaigns.ts'))};
import { resolveProjectRoot } from ${JSON.stringify(join(repoRoot, 'server/project-root.ts'))};
import { processResendWebhook } from ${JSON.stringify(join(repoRoot, 'api/resend-webhook.ts'))};

export const root = resolveProjectRoot(import.meta.url);
export const storePath = crmSyncStorePath({
  VERCEL: '1',
  CRM_DATABASE_URL: 'memory://crm',
});
export const templates = listTemplates();
export const webhook = typeof processResendWebhook;
`,
    );

    const build = spawnSync(
      esbuild,
      [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--packages=external'],
      { encoding: 'utf8', cwd: repoRoot },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);
    // esbuild still warns that import.meta is emptied under CJS; the fix is that
    // resolveProjectRoot tolerates that and module init must not throw.

    const load = spawnSync(
      process.execPath,
      [
        '-e',
        `
          process.env.VERCEL = '1';
          const mod = require(${JSON.stringify(out)});
          if (!mod.templates?.length) throw new Error('templates missing');
          if (mod.webhook !== 'function') throw new Error('webhook missing');
          console.log('OK');
        `,
      ],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, VERCEL: '1', NODE_PATH: join(repoRoot, 'node_modules') },
      },
    );
    assert.equal(load.status, 0, load.stderr || load.stdout);
    assert.match(load.stdout, /OK/);
  });

  it('reproduces the pre-fix CJS crash for documentation', () => {
    const find = spawnSync(
      'bash',
      ['-lc', 'find node_modules/.pnpm -path "*/esbuild/bin/esbuild" | head -1'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const esbuild = find.stdout.trim();
    assert.ok(esbuild);

    const dir = mkdtempSync(join(tmpdir(), 'bbls-serverless-crash-'));
    const entry = join(dir, 'broken.ts');
    const out = join(dir, 'broken.cjs');
    writeFileSync(
      entry,
      `
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default root;
`,
    );
    const build = spawnSync(
      esbuild,
      [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`],
      { encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);
    assert.match(build.stderr || '', /empty-import-meta/);

    const load = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(out)})`], {
      encoding: 'utf8',
    });
    assert.notEqual(load.status, 0);
    assert.match(load.stderr, /path.*string|Invalid URL|Received undefined/i);
  });
});
