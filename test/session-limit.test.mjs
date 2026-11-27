import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSessions, AUTO_ERRORS } from '../src/autosetup.mjs';

async function folderWith(t, count, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: count }, (_, i) => fs.writeFile(path.join(dir, name(i)), 'x')));
  return dir;
}

test('thousands of small files that are not saved sessions do not trip the saved-session limit', async t => {
  const dir = await folderWith(t, 10500, i => `pointer-${i}`);
  assert.deepEqual(await discoverSessions([dir]), []);
});

test('more than 10,000 saved-session files still stops safely with the plain message', async t => {
  const dir = await folderWith(t, 10001, i => `s${i}.jsonl`);
  await assert.rejects(discoverSessions([dir]), error => error.message === AUTO_ERRORS[3]);
});
