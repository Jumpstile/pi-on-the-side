import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installationId, registerInstallation } from '../src/uninstall.mjs';

// A fake Installed-apps list in the shape the real one answers with: every entry is {root, command}.
async function world(t, { listFails = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bridge-prune-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, remove: async id => rows.delete(id),
    list: async () => { if (listFails) throw Error('synthetic list failure'); return [...rows.values()].map(row => row.root); },
    write: async (id, entry) => rows.set(id, { name: entry.DisplayName, root: entry.PiOwnedRoot, command: entry.UninstallString }) };
  const folder = async name => { const root = path.join(base, name); await fs.mkdir(root); await fs.writeFile(path.join(root, 'local-setup.json'), JSON.stringify({ version: 1, type: 'omp-session-bridge-local' })); return root; };
  // An entry exactly as an earlier install wrote it; its folder is only created when asked.
  const listed = async (name, { exists = false } = {}) => {
    const root = path.join(base, name); if (exists) await folder(name);
    rows.set(installationId(root), { name: 'Pi on the Side!', root, command: `"node.exe" "${path.join(root, 'uninstall.mjs')}" "${root}" --all --ui` }); return root;
  };
  return { base, rows, registry, folder, listed, install: root => registerInstallation(root, { registry }) };
}

test('installing into a new folder leaves exactly one entry when older entries point at folders that are gone', async t => {
  const w = await world(t);
  for (const n of ['gone-1', 'gone-2', 'gone-3']) await w.listed(n);
  const root = await w.folder('real');
  await w.install(root);
  assert.deepEqual([...w.rows.keys()], [installationId(root)]);
});

test('an entry whose folder still exists is not removed', async t => {
  const w = await world(t);
  const other = await w.listed('other-real-install', { exists: true }); await w.listed('gone');
  const root = await w.folder('real');
  await w.install(root);
  assert.deepEqual([...w.rows.keys()].sort(), [installationId(root), installationId(other)].sort());
  await fs.access(other);
});

test('an entry that is not Pi on the Side\'s own record is left alone even when its folder is gone', async t => {
  const w = await world(t);
  const foreign = path.join(w.base, 'foreign-gone');
  w.rows.set(installationId(foreign), { name: 'Pi on the Side!', root: foreign, command: 'someone else' });
  await w.install(await w.folder('real'));
  assert.equal(w.rows.size, 2);
});

test('an entry with another display name is left alone even when its folder is gone', async t => {
  const w = await world(t);
  const odd = await w.listed('odd-gone'); w.rows.get(installationId(odd)).name = 'Something else';
  await w.install(await w.folder('real'));
  assert.ok(w.rows.has(installationId(odd)));
});

test('upgrading over the same folder keeps exactly one entry', async t => {
  const w = await world(t);
  const root = await w.folder('real');
  await w.install(root); await w.install(root);
  assert.deepEqual([...w.rows.keys()], [installationId(root)]);
});

test('the install still succeeds when cleaning up old entries fails', async t => {
  const w = await world(t, { listFails: true });
  await w.listed('gone');
  const root = await w.folder('real');
  assert.equal((await w.install(root)).registered, true);
  assert.ok(w.rows.has(installationId(root)));
});
