import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJson, writeJson } from '../src/control.mjs';

test('a record over 64 KiB is refused by default, kept when the caller allows up to 1 MiB, and still refused above that', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-record-size-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'big.json');
  const big = { data: 'x'.repeat(100_000) };
  await assert.rejects(writeJson(file, big), /record too large/);
  await writeJson(file, big, false, undefined, 1_048_576);
  assert.equal((await readJson(file, 1_048_576)).data.length, 100_000);
  await assert.rejects(readJson(file), /file too large/);
  await assert.rejects(writeJson(path.join(folder, 'huge.json'), { data: 'x'.repeat(1_100_000) }, false, undefined, 1_048_576), /record too large/);
});
