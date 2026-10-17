/**
 * Regression: Vercel Node ESM cannot resolve bare relative imports.
 * Production error (POST /api/crm/sync):
 *   Cannot find module '/var/task/server/crm-campaigns'
 *   imported from /var/task/server/crm-api.js
 *
 * Catch-all lazy-loads ../server/crm-api.js; that module and its CRM graph
 * must use .js extensions so Node's ESM resolver finds the sibling files.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** CRM + webhook modules that ship into the Vercel catch-all CRM load graph. */
const CRM_ESM_GRAPH = [
  'server/crm-api.ts',
  'server/crm-campaigns.ts',
  'server/crm-lead-client.ts',
  'server/crm-sync-ingest.ts',
  'server/crm-sync-store.ts',
  'server/crm-sync-store-empty.ts',
  'server/crm-db.ts',
  'server/crm-freshness.ts',
  'server/crm-webhook-apply.ts',
  'server/crm-safety.ts',
  'server/crm-types.ts',
  'server/crm-discovery-api.ts',
  'server/crm-discovery-runner.ts',
  'server/crm-discovery-store.ts',
  'server/crm-discovery-places.ts',
  'server/crm-discovery-qualify.ts',
  'server/crm-discovery-enrich.ts',
  'server/crm-discovery-types.ts',
  'server/project-root.ts',
  'api/resend-webhook.ts',
] as const;

const BARE_RELATIVE = /from\s+['"](\.\.?\/[^'"]+)['"]/g;

function findEsbuild(): string {
  const find = spawnSync(
    'bash',
    ['-lc', 'find node_modules/.pnpm -path "*/esbuild/bin/esbuild" | head -1'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const esbuild = find.stdout.trim();
  assert.ok(esbuild, 'esbuild binary must be available via pnpm store');
  return esbuild;
}

describe('CRM ESM relative imports (Vercel Node)', () => {
  it('documents bare-import failure matching Production', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbls-crm-esm-bare-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'crm-campaigns.js'), 'export const ok = true;\n');
    writeFileSync(join(dir, 'crm-api.js'), "import { ok } from './crm-campaigns';\nexport { ok };\n");

    const bare = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(dir, 'crm-api.js')).href)})`],
      { encoding: 'utf8' },
    );
    assert.notEqual(bare.status, 0);
    assert.match(
      bare.stderr,
      /Cannot find module ['"].*crm-campaigns['"] imported from .*crm-api\.js/,
    );

    writeFileSync(join(dir, 'crm-api-fixed.js'), "import { ok } from './crm-campaigns.js';\nexport { ok };\n");
    const fixed = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(dir, 'crm-api-fixed.js')).href)})`],
      { encoding: 'utf8' },
    );
    assert.equal(fixed.status, 0, fixed.stderr);
  });

  it('CRM serverless graph sources use .js on relative imports', () => {
    const offenders: string[] = [];
    for (const rel of CRM_ESM_GRAPH) {
      const text = readFileSync(join(repoRoot, rel), 'utf8');
      for (const match of text.matchAll(BARE_RELATIVE)) {
        const spec = match[1];
        if (!/\.(js|ts|json|mjs|cjs)$/.test(spec)) {
          offenders.push(`${rel}: ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `bare relative imports break Vercel ESM:\n${offenders.join('\n')}`);
  });

  it('transpiled CRM graph resolves under Node ESM (sync entry loads)', () => {
    const esbuild = findEsbuild();
    const dir = mkdtempSync(join(tmpdir(), 'bbls-crm-esm-graph-'));
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'api'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const entryPoints = CRM_ESM_GRAPH.map((rel) => join(repoRoot, rel));
    const build = spawnSync(
      esbuild,
      [
        ...entryPoints,
        '--platform=node',
        '--format=esm',
        `--outdir=${dir}`,
        '--outbase=' + repoRoot,
        '--packages=external',
      ],
      { encoding: 'utf8', cwd: repoRoot },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);
    assert.ok(
      readdirSync(join(dir, 'server')).includes('crm-api.js'),
      'crm-api.js must be emitted',
    );
    // ESM package resolution ignores NODE_PATH; mirror Vercel /var/task layout.
    symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));

    const load = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          process.env.VERCEL = '1';
          process.env.CRM_DATABASE_URL = 'memory://crm';
          const mod = await import(${JSON.stringify(pathToFileURL(join(dir, 'server/crm-api.js')).href)});
          if (typeof mod.handleCrmSyncIngest !== 'function') {
            throw new Error('handleCrmSyncIngest missing');
          }
          if (typeof mod.handleCrmOverview !== 'function') {
            throw new Error('handleCrmOverview missing');
          }
          console.log('OK');
        `,
      ],
      {
        encoding: 'utf8',
        cwd: dir,
      },
    );
    assert.equal(load.status, 0, load.stderr || load.stdout);
    assert.match(load.stdout, /OK/);
    assert.doesNotMatch(load.stderr || '', /Cannot find module/);
  });
});
