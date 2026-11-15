import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// The npm folder must be public-installable and catalog-listed while the
// repository package.json stays private for the in-app updater.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const PACK = path.join(CHECKOUT, 'scripts', 'pack-npm.mjs');
const run = (...args) => new Promise(resolve => execFile(process.execPath, [PACK, ...args], { windowsHide: true },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test('repository package.json stays private and carries the catalog fields', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.ok(pkg.keywords.includes('omp-package'));
  assert.deepEqual(pkg.omp, { extensions: ['./extension/bridge.ts'] });
});

test('npm folder is public, runtime-only, and its extension entry exists', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge npm '));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const folder = path.join(out, 'pkg');
  const result = await run(folder);
  assert.equal(result.code, 0, result.stderr);
  const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const source = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'omp-session-bridge');
  assert.equal(pkg.version, source.version);
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.runtimeFiles, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.ok(pkg.keywords.includes('omp-package'));
  for (const name of [...pkg.files, pkg.omp.extensions[0].replace('./', '')]) await fs.access(path.join(folder, ...name.split('/')));
  for (const name of pkg.files) assert.ok(!name.startsWith('test/') && !name.startsWith('docs/'), name);
  assert.equal((await run(folder)).stderr.trim(), 'output folder must be empty');
  assert.equal((await run(path.join(CHECKOUT, 'npm-out'))).stderr.trim(), 'output must be outside the checkout');
  assert.equal((await run('relative')).stderr.trim(), 'output must be an absolute path');
});
