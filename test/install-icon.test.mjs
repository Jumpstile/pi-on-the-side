import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { installationId, registerInstallation, uninstall, uninstallDefaults } from '../src/uninstall.mjs';

const CHECKOUT = path.resolve(import.meta.dirname, '..');
const exists = p => fs.lstat(p).then(() => true, () => false);

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-icon-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'managed-install');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'local-setup.json'), JSON.stringify({ version: 1, type: 'omp-session-bridge-local' }));
  const rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, remove: async id => rows.delete(id),
    write: async (id, value) => rows.set(id, { ...value, root: value.PiOwnedRoot, command: value.UninstallString, name: value.DisplayName }),
    list: async () => [...rows.values()].map(row => row.root) };
  return { base, root, rows, registry };
}

test('Installed apps entry shows the logo from inside the install folder, upgrades keep one entry, uninstall removes the icon', async t => {
  const f = await setup(t), icon = path.join(f.root, 'pots.ico');
  await registerInstallation(f.root, { registry: f.registry });
  assert.equal(f.rows.size, 1);
  assert.equal([...f.rows.values()][0].DisplayIcon, icon);
  assert.deepEqual(await fs.readFile(icon), await fs.readFile(path.join(CHECKOUT, 'assets', 'pots.ico')));
  const record = JSON.parse(await fs.readFile(path.join(f.root, 'uninstall-record.json'), 'utf8'));
  assert.ok(record.software['pots.ico']);

  await fs.writeFile(icon, 'stale icon from an older version'); // an upgrade refreshes it
  await fs.writeFile(path.join(f.root, 'uninstall-record.json'), JSON.stringify({ ...record, software: { ...record.software, 'pots.ico': (await import('node:crypto')).createHash('sha256').update('stale icon from an older version').digest('hex') } }));
  await registerInstallation(f.root, { registry: f.registry });
  assert.equal(f.rows.size, 1);
  assert.equal([...f.rows.values()][0].DisplayIcon, icon);
  assert.deepEqual(await fs.readFile(icon), await fs.readFile(path.join(CHECKOUT, 'assets', 'pots.ico')));

  const deps = { ...uninstallDefaults, platform: 'win32', registry: f.registry, processes: async () => [], audit: async () => [],
    permissions: { verify: async () => {}, verifyTree: async () => {}, protect: async () => {} } };
  const result = await uninstall(f.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled');
  assert.equal(await exists(icon), false);
  assert.equal(f.rows.size, 0);
});

test('a build without the icon file still installs; the entry has no icon', async t => {
  const f = await setup(t), copy = path.join(f.base, 'copy');
  await fs.cp(path.join(CHECKOUT, 'src'), path.join(copy, 'src'), { recursive: true });
  await fs.copyFile(path.join(CHECKOUT, 'package.json'), path.join(copy, 'package.json'));
  const mod = await import(pathToFileURL(path.join(copy, 'src', 'uninstall.mjs')).href);
  await mod.registerInstallation(f.root, { registry: f.registry });
  assert.equal(f.rows.size, 1);
  assert.equal(Object.hasOwn([...f.rows.values()][0], 'DisplayIcon'), false);
  assert.equal(await exists(path.join(f.root, 'pots.ico')), false);
});
