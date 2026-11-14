import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSavedSession } from '../src/transcript.mjs';

const sessionId = '00000000-0000-4000-8000-000000000003';
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp-bridge-header-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const identity = { sessionId, cwd: base };
  const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: base }) + '\n';
  const check = async content => {
    const file = path.join(base, 'session.jsonl'); await fs.writeFile(file, content);
    return validateSavedSession(file, identity);
  };
  return { header, check };
}
// Mirrors OMP 18.7.0 serializeTitleSlot: fixed 256-byte line including newline.
const slot = (fields = {}) => {
  const base = { type: 'title', v: 1, title: 'synthetic', source: 'auto', updatedAt: '2026-01-01T00:00:00.000Z', ...fields };
  const pad = 256 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }) + '\n');
  return JSON.stringify({ ...base, pad: ' '.repeat(Math.max(0, pad)) }) + '\n';
};
const title = slot();
const message = size => JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(size) } }) + '\n';

test('header-only transcript is accepted', async t => {
  const { header, check } = await fixture(t);
  assert.equal(await check(header), true);
});
test('second record beyond the 32 KiB window is never parsed', async t => {
  const { header, check } = await fixture(t);
  assert.equal(await check(header + message(40000)), true);
  assert.equal(await check(header + '{not json\n'), true);
});
test('title record before header remains supported', async t => {
  const { header, check } = await fixture(t);
  assert.equal(await check(title + header), true);
  assert.equal(await check(title + header + message(40000)), true);
});
test('title slot without optional source is accepted', async t => {
  const { header, check } = await fixture(t);
  assert.equal(await check(slot({ source: undefined }) + header), true);
});
test('non-title first records before the header fail closed', async t => {
  const { header, check } = await fixture(t);
  const rows = ['null', '0', '[]', '{}', '"title"', 'true',
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'x' } }),
    JSON.stringify({ type: 'compaction', summary: 's' }),
    JSON.stringify({ type: 'title_change', title: 't', source: 'user' })];
  for (const row of rows) await assert.rejects(check(row + '\n' + header), /transcript header invalid/, row);
  await assert.rejects(check('[' + header.trimEnd() + ']\n'), /transcript header invalid/);
});
test('malformed title slots fail closed', async t => {
  const { header, check } = await fixture(t);
  const bad = [
    JSON.stringify({ type: 'title', title: 'synthetic' }) + '\n', // legacy shape, not fixed width
    slot({ v: 2 }), slot({ v: '1' }), slot({ title: 7 }), slot({ title: null }), slot({ updatedAt: 0 }),
    slot({ source: 'bot' }), slot({ source: null }), slot({ extra: 1 }),
    slot().replace(/,"pad":" *"/, ''), // missing pad
    slot().replace('  "}', '"}'), // wrong width
    slot().replace(' "}', '  "}'),
  ];
  for (const row of bad) await assert.rejects(check(row + header), /transcript header invalid/, row);
});
test('incomplete, oversized, malformed or mismatched headers fail closed', async t => {
  const { header, check } = await fixture(t);
  await assert.rejects(check(header.trimEnd()), /transcript header invalid/);
  await assert.rejects(check(title + header.trimEnd()), /transcript header invalid/);
  await assert.rejects(check(JSON.stringify({ type: 'title', title: 'y'.repeat(40000) }) + '\n' + header), /transcript header invalid/);
  await assert.rejects(check(title + title + header), /transcript header invalid/);
  await assert.rejects(check('{bad\n' + header), /transcript header invalid/);
  await assert.rejects(check(''), /transcript header invalid/);
  await assert.rejects(check(header.replace(sessionId, '00000000-0000-4000-8000-000000000004')), /identity mismatch/);
  await assert.rejects(check(header.replace('"version":3', '"version":2')), /identity mismatch/);
  await assert.rejects(check(JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: path.join(os.tmpdir(), 'elsewhere') }) + '\n'), /identity mismatch/);
});
