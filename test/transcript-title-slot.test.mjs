import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fence, reconcileAdmission } from '../src/transcript.mjs';
import { admitted } from './admitted-helper.mjs';

// Receipt shape from the lane: a fresh session whose whole file
// (title slot + header + a few rows, 4000 bytes) fits inside the 32 KiB fence
// window (start 0). OMP rewrites the fixed-width title slot in place after the
// first prompt, so a raw prefix hash over byte 0 failed with `fence_changed`
// and left the finished plan `unknown/message_not_confirmed_in_transcript`.
const sessionId = '0c0ef91f-9004-4660-a0cc-5cbe1caa3932';
const slot = (title, fields = {}) => {
  const base = { type: 'title', v: 1, title, source: 'auto', updatedAt: '2026-10-30T00:00:00.000Z', ...fields };
  const pad = 256 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }) + '\n');
  return JSON.stringify({ ...base, pad: ' '.repeat(Math.max(0, pad)) }) + '\n';
};
const row = (role, content, extra = {}) => JSON.stringify({ type: 'message', message: { role, content, ...extra } }) + '\n';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { rows = row('assistant', 'synthetic prior turn'), withSlot = true, fenceStart } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-title-slot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd);
  const file = path.join(root, 'native-session.jsonl');
  const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n';
  const head = (withSlot ? slot('New session') : '') + header;
  // fenceStart pins the fenced size to 32768 + fenceStart so the window starts exactly there.
  if (fenceStart !== undefined) rows = row('assistant', 'x'.repeat(32768 + fenceStart - Buffer.byteLength(head) - Buffer.byteLength(row('assistant', ''))));
  await fs.writeFile(file, head + rows);
  const text = '[OMP bridge 65e8fee3-fbf1-4c27-85c7-766e1ebce2bd step 0]\nSynthetic task.';
  const proof = await fence(file, { sessionId, cwd }, text);
  const writeAt = async (position, data) => {
    const handle = await fs.open(file, 'r+');
    try { await handle.write(Buffer.from(data), 0, Buffer.byteLength(data), position); } finally { await handle.close(); }
  };
  const finish = () => fs.appendFile(file, row('user', text) + row('assistant', 'done', { stopReason: 'stop' }));
  const verdicts = async () => {
    const diagnostics = [];
    const live = await reconcileAdmission(proof, { onFailure: value => diagnostics.push(value.failure) });
    return { live, diagnostics };
  };
  return { file, proof, writeAt, finish, verdicts, header };
}

// The window start is size − 32768, so sizes 32768..33023 leave start 0..255 inside the slot.
for (const start of [0, 1, 128, 254, 255]) {
  test(`title slot overlapping the fence window at start ${start}: in-place rewrite admits, everything else stays strict`, async t => {
    const f = await fixture(t, { fenceStart: start });
    assert.equal(f.proof.start, start);
    // Every byte of the slot differs (pad filled), so a hash over any slot byte in the window would break.
    const rewritten = slot('Generated automatic title', { updatedAt: '2026-10-30T00:07:00.000Z' }).replace(/ +"\}\n$/, m => 'z'.repeat(m.length - 3) + '"}\n');
    assert.equal(Buffer.byteLength(rewritten), 256); assert.notEqual(rewritten.at(-5), ' ');
    await f.writeAt(0, rewritten);
    await f.finish();
    assert.deepEqual(await f.verdicts(), { live: true, diagnostics: [] });
    await f.writeAt(Buffer.byteLength(slot('x') + f.header) + 10, 'MUTATED'); // first row after the header, inside the window
    const mutated = await f.verdicts();
    assert.equal(mutated.live, false);
  });
  test(`start ${start}: a malformed or forged head slot fails closed`, async t => {
    for (const forged of [slot('Generated automatic title', { v: 2 }), slot('Generated automatic title', { extra: 1 })]) {
      const f = await fixture(t, { fenceStart: start });
      await f.writeAt(0, forged);
      await f.finish();
      const verdict = await f.verdicts();
      assert.equal(verdict.live, false);
    }
  });
}
test('start 255: the slot newline is masked but byte 256 onward is not', async t => {
  const f = await fixture(t, { fenceStart: 255 });
  await f.writeAt(256 + 2, 'XX'); // header byte inside the window
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});
test('start 256 and above never involves the slot', async t => {
  const f = await fixture(t, { fenceStart: 256 });
  assert.equal(f.proof.start, 256);
  await f.writeAt(0, slot('Generated automatic title'));
  await f.finish();
  assert.deepEqual(await f.verdicts(), { live: true, diagnostics: [] });
});
test('start 1: a whole-window fence recorded before this masking still verifies only while the slot is unchanged', async t => {
  const f = await fixture(t, { fenceStart: 1 });
  const bytes = await fs.readFile(f.file);
  const legacy = { ...f.proof, prefix: crypto.createHash('sha256').update(bytes.subarray(f.proof.start, f.proof.offset)).digest('hex') };
  assert.notEqual(legacy.prefix, f.proof.prefix);
  await f.finish();
  assert.equal(await admitted(legacy), true);
  await f.writeAt(0, slot('Generated automatic title'));
  assert.equal(await admitted(legacy), false);
});

test('in-place title-slot rewrite during the run still admits the exact user record', async t => {
  const f = await fixture(t);
  assert.equal(f.proof.start, 0);
  assert.ok(f.proof.offset < 32768);
  await f.writeAt(0, slot('Generated automatic title', { updatedAt: '2026-10-30T00:07:00.000Z' }));
  await f.finish();
  assert.deepEqual(await f.verdicts(), { live: true, diagnostics: [] });
});

test('unchanged title slot still admits', async t => {
  const f = await fixture(t);
  await f.finish();
  assert.deepEqual(await f.verdicts(), { live: true, diagnostics: [] });
});

test('a title-slot rewrite never hides a change anywhere else in the fenced prefix', async t => {
  const f = await fixture(t);
  await f.writeAt(0, slot('Generated automatic title'));
  // Same-length edit to the prior row after the header.
  await f.writeAt(Buffer.byteLength(slot('x') + f.header) + 40, 'MUTATED');
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
  assert.deepEqual(verdict.diagnostics, ['fence_changed']);
});

test('header change still fails closed even when the title slot also changed', async t => {
  const f = await fixture(t);
  await f.writeAt(0, slot('Generated automatic title'));
  await f.writeAt(256 + 2, 'XX'); // inside the session header row
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});

test('a malformed replacement of the title slot fails closed', async t => {
  const f = await fixture(t);
  await f.writeAt(0, slot('Generated automatic title', { v: 2 })); // not the verified slot shape
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});

test('a non-slot record of the same width at byte 0 fails closed', async t => {
  const f = await fixture(t);
  const forged = JSON.stringify({ type: 'custom', pad: ' '.repeat(255 - JSON.stringify({ type: 'custom', pad: '' }).length) }) + '\n';
  assert.equal(Buffer.byteLength(forged), 256);
  await f.writeAt(0, forged);
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});

test('a session without a title slot keeps the exact whole-prefix hash', async t => {
  const f = await fixture(t, { withSlot: false });
  assert.equal(f.proof.prefix, sha(await fs.readFile(f.file).then(b => b.subarray(f.proof.start, f.proof.offset))));
  await f.writeAt(5, 'ZZ');
  await f.finish();
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});

test('a persisted whole-prefix fence from before this fix still verifies while the slot is unchanged', async t => {
  const f = await fixture(t);
  const bytes = await fs.readFile(f.file);
  const legacy = { ...f.proof, prefix: sha(bytes.subarray(f.proof.start, f.proof.offset)) };
  assert.notEqual(legacy.prefix, f.proof.prefix);
  await f.finish();
  assert.equal(await admitted(legacy), true);
  await f.writeAt(0, slot('Generated automatic title'));
  assert.equal(await admitted(legacy), false); // old whole-prefix proofs stay strict
});

test('title slot outside the fence window is irrelevant and window mutations still fail closed', async t => {
  const f = await fixture(t, { rows: row('assistant', 'x'.repeat(40000)) + row('assistant', 'tail') });
  assert.ok(f.proof.start > 0);
  await f.writeAt(0, slot('Generated automatic title'));
  await f.finish();
  assert.deepEqual(await f.verdicts(), { live: true, diagnostics: [] });
  await f.writeAt(f.proof.offset - 20, 'MUTATED');
  const verdict = await f.verdicts();
  assert.equal(verdict.live, false);
});
