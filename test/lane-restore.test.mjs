import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { registerConnection, loadConnections, readConnections } from '../src/connections.mjs';
import { lanesStatus } from '../src/lane-status.mjs';
import { loadSetup } from '../src/setup.mjs';

// A fake lane folder and a fake OMP: no real OMP is started and nothing outside the temporary folder is touched.
async function world(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-restore-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const session = path.join(base, 'saved.jsonl'), sessionId = crypto.randomUUID(), state = path.join(base, 'state');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  const calls = [], quiet = { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.8.6' };
  assert.equal(await main(['setup', session, state], quiet), 0);
  const root = path.join(base, 'install'); await fs.mkdir(root);
  await registerConnection(path.join(root, 'connections'), 'alpha', state);
  const out = [], err = [];
  const deps = { ...quiet, stdout: text => out.push(text), stderr: text => err.push(text), managed: path.join(root, 'runtime', 'current'),
    watch: async () => ({ status: 'off', setChildPid() {}, stop: async () => {} }),
    launch: async call => { calls.push(call); return 0; }, lease: async () => ({ held: [], unknown: [] }) };
  const run = async (args, over = {}) => { out.length = err.length = 0; calls.length = 0; const code = await main(args, { ...deps, ...over }); return { code, out: out.join('\n'), err: err.join('\n'), calls: [...calls] }; };
  const lock = path.join(state, `supervisor-${sessionId}.lock`);
  return { base, session, sessionId, state, root, lock, run };
}
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const writeLock = (w, pid) => fs.writeFile(w.lock, JSON.stringify({ version: 1, pid, up: os.uptime(), startedAt: Date.now(), sessionId: w.sessionId }));

test('a lane that was running when OMP stopped is reported as stopped and needs attention; it clears when the step is no longer running', async t => {
  const w = await world(t), { store } = await loadSetup(w.state), id = crypto.randomUUID();
  await store.enqueue({ version: 1, id, sessionId: w.sessionId, expiresAt: Date.now() + 3600000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
  const receipt = { version: 1, id, sessionId: w.sessionId, state: 'submitted', nextStep: 0, updatedAt: Date.now() };
  await store.save(receipt);
  const status = async () => (await lanesStatus((await loadConnections(await readConnections(path.join(w.root, 'connections')))).rows)).lanes[0];
  const stopped = await status();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.needsAttention, true);
  assert.match(stopped.next, /no bridge is running it any more.*pots lane restore alpha/i);
  await store.save({ ...receipt, state: 'failed', reason: 'restart' });
  assert.equal((await status()).stopped, undefined);
});

test('pots lane restore on a stopped lane whose OMP window is still open says what to do, not only that it is running', async t => {
  const w = await world(t), { store } = await loadSetup(w.state), id = crypto.randomUUID();
  await store.enqueue({ version: 1, id, sessionId: w.sessionId, expiresAt: Date.now() + 3600000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
  await store.save({ version: 1, id, sessionId: w.sessionId, state: 'submitted', nextStep: 0, updatedAt: Date.now() });
  const held = await w.run(['lane', 'restore', 'alpha'], { lease: async () => ({ held: [w.sessionId], unknown: [] }) });
  assert.equal(held.code, 1); assert.equal(held.calls.length, 0);
  assert.match(held.err, /still running in an OMP window.*\/bridge status.*\/bridge enable/);
});

test('lane start passes the optional limits to OMP, and sets none by default', async t => {
  const w = await world(t);
  const plain = await w.run(['start', w.state, '--confirm-offline']);
  assert.equal(plain.code, 0, plain.err);
  assert.ok(!plain.calls[0].args.some(arg => /^--(warn-cost|max-cost|max-time)$/.test(arg)));
  const limited = await w.run(['start', w.state, '--confirm-offline', '--warn-cost', '1.5', '--max-cost', '5', '--max-time', '2h']);
  assert.equal(limited.code, 0, limited.err);
  const args = limited.calls[0].args, at = args.indexOf('--warn-cost');
  assert.deepEqual(args.slice(at), ['--warn-cost', '1.5', '--max-cost', '5', '--max-time', '2h']);
  const bad = await w.run(['start', w.state, '--confirm-offline', '--max-cost', 'lots']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /limits were not understood/);
  assert.equal(bad.calls.length, 0);
});

test('pots lane restore continues a stopped lane with --restore, the same extension and the limits, and removes only its own dead lock', async t => {
  const w = await world(t);
  await writeLock(w, deadPid());
  const done = await w.run(['lane', 'restore', 'alpha', '--max-cost', '5']);
  assert.equal(done.code, 0, done.err);
  const args = done.calls[0].args;
  assert.deepEqual(args.slice(args.indexOf('--restore')), ['--restore', w.session, '--max-cost', '5']);
  assert.ok(args.includes('--extension') && args.includes('--no-extensions') && !args.includes('--resume'));
  await assert.rejects(fs.lstat(w.lock), e => e.code === 'ENOENT');
});

test('pots lane restore refuses, in plain words and without starting OMP, when a running OMP owns the lane, the lock is alive or foreign, the session is gone or the name is unknown', async t => {
  const w = await world(t);
  const held = await w.run(['lane', 'restore', 'alpha'], { lease: async () => ({ held: [w.sessionId], unknown: [] }) });
  assert.equal(held.code, 1); assert.match(held.err, /still running in an OMP window/); assert.equal(held.calls.length, 0);
  const unsure = await w.run(['lane', 'restore', 'alpha'], { lease: async () => { throw new Error('old omp'); } });
  assert.equal(unsure.code, 1); assert.match(unsure.err, /start a new lane/); assert.equal(unsure.calls.length, 0);
  await writeLock(w, process.pid);
  const alive = await w.run(['lane', 'restore', 'alpha']);
  assert.equal(alive.code, 1); assert.equal(alive.calls.length, 0); await fs.lstat(w.lock);
  await fs.writeFile(w.lock, JSON.stringify({ version: 1, pid: deadPid(), up: os.uptime(), sessionId: crypto.randomUUID() }));
  assert.equal((await w.run(['lane', 'restore', 'alpha'])).code, 1); await fs.lstat(w.lock);
  await fs.rm(w.lock);
  const unknown = await w.run(['lane', 'restore', 'nobody']);
  assert.equal(unknown.code, 1); assert.match(unknown.err, /no lane called nobody/);
  await fs.rm(w.session);
  const gone = await w.run(['lane', 'restore', 'alpha']);
  assert.equal(gone.code, 1); assert.match(gone.err, /start a new lane/); assert.equal(gone.calls.length, 0);
});

test('pots lane restore refuses an unsupported Node like start does, before it touches anything', async t => {
  const w = await world(t);
  await writeLock(w, deadPid());
  const old = await w.run(['lane', 'restore', 'alpha'], { nodeVersion: '20.0.0' });
  assert.equal(old.code, 1); assert.match(old.err, /unsupported Node\.js/); assert.equal(old.calls.length, 0);
  await fs.lstat(w.lock);
});

test('pots lane restore waits out a lock another program holds for a moment; a lock that stays held is refused in plain words, and one already gone is fine', async t => {
  const w = await world(t), unlink = fs.unlink;
  t.after(() => { fs.unlink = unlink; });
  await writeLock(w, deadPid());
  fs.unlink = async (file, ...rest) => { if (String(file) === w.lock) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file, ...rest); };
  const held = await w.run(['lane', 'restore', 'alpha']);
  assert.equal(held.code, 1); assert.match(held.err, /bridge lock present/); assert.equal(held.calls.length, 0);
  await fs.lstat(w.lock);
  // Someone else removed the lock between the check and the removal.
  fs.unlink = async (file, ...rest) => { if (String(file) === w.lock) { await unlink.call(fs, file); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } return unlink.call(fs, file, ...rest); };
  const gone = await w.run(['lane', 'restore', 'alpha']);
  assert.equal(gone.code, 0, gone.err); assert.equal(gone.calls.length, 1);
});
