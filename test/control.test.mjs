import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, initialize, plan, plain, QUEUE_LIMIT_MS, Store, Supervisor, writeJson } from '../src/control.mjs';
import { fence, reconcileAdmission } from '../src/transcript.mjs';
import { admitted } from './admitted-helper.mjs';

const sessionId = '00000000-0000-4000-8000-000000000001';
const now = 1800000000000;
function value(steps = 1) { return { version: 1, id: crypto.randomUUID(), sessionId, expiresAt: now + 60000,
  steps: Array.from({ length: steps }, () => ({ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: true })) }; }
async function setup(t, overrides = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-bridge-test-'));
  // node:test runs t.after hooks FIFO; keep one LIFO stack so every supervisor
  // (including ones created later in the test) closes before state is removed.
  const cleanup = [() => fs.rm(base, { recursive: true, force: true })];
  const defer = fn => cleanup.push(fn);
  t.after(async () => { while (cleanup.length) await cleanup.pop()(); });
  const root = path.join(base, 'state'); await initialize(root);
  const store = new Store({ sessionId, cwd: base, root }, () => now);
  const sent = [];
  const adapter = { isIdle: () => true, send: async text => sent.push(text), fence: async () => ({ fixture: true }), admitted: async () => true, ...overrides };
  const supervisor = new Supervisor(store, adapter);
  await supervisor.open();
  defer(() => supervisor.close().catch(() => {}));
  return { base, root, store, adapter, supervisor, sent, defer };
}
function startRun(s, token) {
  const owner = s.supervisor.active;
  return s.supervisor.started(token, {owner,sessionId:owner.row.sessionId,planId:owner.row.id,step:owner.row.nextStep});
}
function endStep(s, p, token, willContinue, step = 0) {
  return s.supervisor.ended(token, willContinue, { sessionId, planId: p.id, step });
}
test('START requires the exact callback-time owner and submitted step', async t => {
  const s = await setup(t), p = value(); await s.store.enqueue(p); await s.supervisor.tick();
  const expected = {owner:s.supervisor.active,sessionId,planId:p.id,step:0};
  for (const invalid of [undefined,{}, {...expected,owner:{}}, {...expected,sessionId:crypto.randomUUID()},
    {...expected,planId:crypto.randomUUID()}, {...expected,step:1}]) {
    await s.supervisor.started('unowned',invalid);
    assert.equal(s.supervisor.run,null);
    assert.equal((await s.store.receipt(p.id)).state,'submitted');
  }
  await s.supervisor.started('owned',expected); await endStep(s,p,'owned',false);
  assert.equal((await s.store.receipt(p.id)).state,'completed');
  assert.equal(s.sent.length,1);
});
test('canonical filesystem root is accepted, including Bun Windows realpath spelling', async () => {
  await plain(path.parse(process.cwd()).root, true);
});
test('strict schemas and finite budgets include validated coordinator preferences', () => {
  assert.throws(() => plan(value(9), now));
  assert.throws(() => plan({ ...value(), expiresAt: now }, now));
  assert.throws(() => plan({ ...value(), extra: true }, now));
  const p = value(); p.steps[0].prompt = 'x'.repeat(6001); assert.throws(() => plan(p, now));
  p.steps[0].prompt = '\0'; assert.throws(() => plan(p, now));
  assert.throws(() => config({ sessionId: '../x', root: '/x', cwd: '/y' }));
  const defaults = config({ sessionId, root: path.resolve('state'), cwd: path.resolve('project') });
  assert.deepEqual([defaults.clients, defaults.coordinatorWakeups], ['both', true]);
  assert.equal(config({ ...defaults, clients: 'claude', coordinatorWakeups: false }).coordinatorWakeups, false);
  assert.throws(() => config({ ...defaults, clients: 'muse' }), /Muse is no longer supported/);
  assert.throws(() => config({ ...defaults, coordinatorWakeups: 'false' }));
});
test('queue IDs cannot be overwritten and session isolation is exact', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p);
  await assert.rejects(s.store.enqueue(p), { message: 'plan id already used' });
  await assert.rejects(s.store.enqueue({ ...value(), sessionId: crypto.randomUUID() }), /wrong session/);
  assert.throws(() => s.store.file('plans', '../x'));
});
test('one supervisor owns a session; no automatic stale-lock stealing', async t => {
  const s = await setup(t); const other = new Supervisor(s.store, s.adapter);
  await assert.rejects(other.open(), e => e.code === 'EEXIST');
});
test('bounded continuation and terminal observation never assert task success', async t => {
  const s = await setup(t); const p = value(2); await s.store.enqueue(p);
  await s.supervisor.tick(); await startRun(s, 1); await endStep(s, p, 1, false);
  assert.equal((await s.store.receipt(p.id)).state, 'waiting');
  await s.supervisor.continue(); await startRun(s, 2); await endStep(s, p, 2, false, 1);
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'completed'); assert.equal(row.taskSuccess, 'unverified'); assert.equal(s.sent.length, 2);
  await s.supervisor.tick(); assert.equal(s.sent.length, 2);
});
test('API acceptance followed by exception is failed and never resent', async t => {
  let calls = 0; const s = await setup(t, { send: async () => { calls++; throw new Error('accepted then disconnected'); } });
  const p = value(); await s.store.enqueue(p); await s.supervisor.tick(); await s.supervisor.tick();
  assert.equal((await s.store.receipt(p.id)).state, 'failed'); assert.equal(calls, 1);
});
// Regression: a concurrent receipt reader (status poll) holding the reserved
// receipt open made the Windows `submitting` rename fail EPERM before fence/send,
// closing the lane with the receipt stuck at `reserved` and nothing submitted.
test('receipt replacement while a reader holds the reserved receipt open still submits once', async t => {
  let idle = 0; let held = false; let s;
  s = await setup(t, { isIdle: () => {
    // Call 2 is submit()'s check, after the durable reservation and before
    // the `submitting` save.
    if (++idle === 2) {
      const fd = openSync(s.store.file('receipts', p.id), 'r'); held = true;
      setTimeout(() => closeSync(fd), 50);
    }
    return true;
  } });
  const p = value(); await s.store.enqueue(p);
  await s.supervisor.tick();
  assert.ok(held); assert.equal(s.sent.length, 1);
  assert.equal((await s.store.receipt(p.id)).state, 'submitted');
  await s.supervisor.tick(); assert.equal(s.sent.length, 1);
});
// A reader that never releases the receipt exhausts the bounded retry: the
// `submitting` save fails before fence/send, the lane closes, and no later tick sends.
test('persistent receipt sharing failure closes the lane without any send', { skip: process.platform !== 'win32' && 'Windows sharing semantics only' }, async t => {
  let idle = 0; let fd = null; let s;
  s = await setup(t, { isIdle: () => {
    if (++idle === 2) fd = openSync(s.store.file('receipts', p.id), 'r');
    return true;
  } });
  t.after(() => { if (fd !== null) closeSync(fd); });
  const p = value(); await s.store.enqueue(p);
  await assert.rejects(s.supervisor.tick(), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
  assert.notEqual(fd, null); assert.equal(s.sent.length, 0);
  assert.equal((await s.store.receipt(p.id)).state, 'reserved');
  closeSync(fd); fd = null;
  await assert.rejects(s.supervisor.tick(), /supervisor stopped/); assert.equal(s.sent.length, 0);
});
test('a passing sharing error while the queue is read does not stop the lane; any other read error still does', { skip: process.platform !== 'win32' }, async t => {
  const s = await setup(t); await s.store.enqueue(value());
  const ids = s.store.ids.bind(s.store); let failures = 1;
  s.store.ids = async () => { if (failures-- > 0) throw Object.assign(new Error('scanner'), { code: 'EBUSY' }); return ids(); };
  await s.supervisor.tick();
  assert.equal(s.sent.length, 1); assert.equal(s.supervisor.closed, false);
  const broken = await setup(t);
  broken.store.ids = async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); };
  await assert.rejects(broken.supervisor.tick(), { code: 'EIO' });
  await assert.rejects(broken.supervisor.tick(), /supervisor stopped/);
});
test('the command lock is removed even when Windows holds it for a moment', { skip: process.platform !== 'win32' }, async t => {
  const s = await setup(t), id = crypto.randomUUID(), unlink = fs.unlink; let held = 2;
  await s.store.requestCommand(id, '/model gamma');
  fs.unlink = async file => { if (String(file) === s.store.commandLock(id) && held-- > 0) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file); };
  try { assert.equal((await s.store.updateCommandReceipt(id, 'dispatching', 'admitted')).state, 'dispatching'); }
  finally { fs.unlink = unlink; }
  await assert.rejects(fs.stat(s.store.commandLock(id)), { code: 'ENOENT' });
});
test('stopping the lane removes its supervisor lock even when Windows holds it for a moment, so the lane can start again', { skip: process.platform !== 'win32' }, async t => {
  const s = await setup(t), unlink = fs.unlink; let held = 2;
  fs.unlink = async file => { if (String(file) === s.supervisor.lockFile && held-- > 0) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file); };
  try { await s.supervisor.close(); } finally { fs.unlink = unlink; }
  await assert.rejects(fs.stat(s.supervisor.lockFile), { code: 'ENOENT' });
});
test('a plan that did not complete holds the next plan for the settle time, then releases it; the failed ID never replays', async t => {
  const s = await setup(t, { admitted: async () => false }); let time = now; s.store.now = () => time; const p = value(); await s.store.enqueue(p);
  await s.supervisor.tick(); await startRun(s, 1); await endStep(s, p, 1, false);
  const failed = await s.store.receipt(p.id);
  assert.deepEqual([failed.state, failed.reason], ['failed', 'message_not_confirmed_in_transcript']);
  const next = value(); await s.store.enqueue(next); await s.supervisor.tick(); assert.equal(s.sent.length, 1);
  time += 6000; await s.supervisor.tick(); assert.equal(s.sent.length, 2);
  assert.deepEqual([(await s.store.receipt(p.id)).state, (await s.store.receipt(p.id)).automaticReplay], ['failed', false]);
});
test('a receipt an older version wrote as unknown reads as failed, with the new reason, and is never replayed', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p);
  await s.store.save({ version: 1, id: p.id, sessionId, state: 'unknown', reason: 'uncorrelated_end', nextStep: 0, updatedAt: now - 60000, outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  const row = await s.store.receipt(p.id);
  assert.deepEqual([row.state, row.reason], ['failed', 'end_not_matched_to_message']);
  await s.supervisor.tick(); assert.equal(s.sent.length, 0);
  const old = value(); await s.store.enqueue(old);
  await s.store.save({ version: 1, id: old.id, sessionId, state: 'unknown', reason: 'continuation_not_authorized', nextStep: 1, updatedAt: now - 60000, outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  assert.equal((await s.store.receipt(old.id)).state, 'aborted');
});
test('a receipt an older version wrote with exhausted and unknown outcome values reads as completed and not_seen', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p);
  await s.store.save({ version: 1, id: p.id, sessionId, state: 'exhausted', reason: 'all_planned_submissions_ended_success_unverified', nextStep: 1, updatedAt: now - 60000,
    outcomes: [{ step: 0, submission: 'returned', terminalObservation: 'unknown' }, { step: 1, submission: 'unknown', terminalObservation: 'unknown' }], taskSuccess: 'unverified', automaticReplay: false });
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'completed');
  assert.deepEqual(row.outcomes, [{ step: 0, submission: 'returned', terminalObservation: 'not_seen' }, { step: 1, submission: 'not_seen', terminalObservation: 'not_seen' }]);
  await s.supervisor.tick(); assert.equal(s.sent.length, 0);
});
test('restart reconciles submitting receipt without replay', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p); await s.supervisor.close();
  await s.store.save({ version: 1, id: p.id, sessionId, state: 'submitting', outcomes: [] });
  const restarted = new Supervisor(s.store, s.adapter); await restarted.open(); s.defer(() => restarted.close());
  await restarted.tick(); assert.equal(s.sent.length, 0); assert.equal((await s.store.receipt(p.id)).reason, 'restart');
});
test('plan whose filename and embedded identity differ is never submitted', async t => {
  const s = await setup(t); const p = value(); const alias = crypto.randomUUID();
  await writeJson(s.store.file('plans', alias), p, true);
  await s.supervisor.tick();
  assert.equal(s.sent.length, 0);
  assert.equal((await s.store.receipt(alias)).reason, 'plan_identity_mismatch');
});
test('non-object plan record fails closed without stopping the lane', async t => {
  const s = await setup(t); const bad = crypto.randomUUID();
  await writeJson(s.store.file('plans', bad), null, true);
  await s.supervisor.tick();
  assert.equal((await s.store.receipt(bad)).reason, 'invalid_plan'); assert.equal(s.sent.length, 0);
});
test('abort queued work durably; abort running work only cancels future steps', async t => {
  const s = await setup(t); const p = value(2); await s.store.enqueue(p); await s.store.abort(p.id); await s.supervisor.tick();
  assert.equal(s.sent.length, 0); assert.equal((await s.store.receipt(p.id)).state, 'aborted');
  const q = value(2); await s.store.enqueue(q); await s.supervisor.tick(); await s.store.abort(q.id); await s.supervisor.tick();
  assert.equal(s.sent.length, 1); assert.match((await s.store.receipt(q.id)).reason, /execution_may_continue/);
});
test('expiry stops continuation without claiming execution stopped', async t => {
  const s = await setup(t); let time = now; s.store.now = () => time;
  const p = value(2); await s.store.enqueue(p); await s.supervisor.tick(); time += 60001; await s.supervisor.tick();
  assert.equal((await s.store.receipt(p.id)).state, 'expired'); assert.equal(s.sent.length, 1);
});
test('unmatched and overlapping lifecycle fail closed', async t => {
  for (const kind of ['mismatch', 'overlap']) {
    const s = await setup(t); const p = value(2); await s.store.enqueue(p); await s.supervisor.tick(); await startRun(s, 1);
    if (kind === 'overlap') await startRun(s, 2);
    else await endStep(s, p, 2, false);
    assert.equal((await s.store.receipt(p.id)).state, 'failed'); assert.equal(s.sent.length, 1);
  }
});
test('native nonterminal phase is retired before successor START without resubmitting', async t => {
  const s = await setup(t); const p = value(2); await s.store.enqueue(p);
  await s.supervisor.tick();
  const expected = {owner:s.supervisor.active,sessionId,planId:p.id,step:0};
  const predecessor = {epoch:4}, successor = {epoch:5};
  await s.supervisor.started(predecessor, expected);
  await endStep(s, p, predecessor, true);
  assert.equal((await s.store.receipt(p.id)).state, 'submitted');
  await s.supervisor.started(successor, expected);
  await endStep(s, p, successor, false);
  assert.equal((await s.store.receipt(p.id)).state, 'waiting');
  assert.equal(s.sent.length, 1);
});
test('fence absence prevents API invocation and no continuation permission stops plan', async t => {
  const s = await setup(t, { fence: async () => null }); const p = value(); await s.store.enqueue(p); await s.supervisor.tick();
  assert.equal(s.sent.length, 0);
  const other = await setup(t); const q = value(2); q.steps[0].continueAfterEnd = false;
  await other.store.enqueue(q); await other.supervisor.tick(); await startRun(other, 1); await endStep(other, q, 1, false);
  assert.equal((await other.store.receipt(q.id)).reason, 'continuation_not_authorized');
});
test('late run invalidation quarantines a committed terminal without replay', async t => {
  const s = await setup(t);
  const p = value(), token = { epoch: 1, valid: true };
  p.steps[0].continueAfterEnd = false;
  await s.store.enqueue(p); await s.supervisor.tick(); await startRun(s, token);
  await endStep(s, p, token, false);
  assert.equal((await s.store.receipt(p.id)).state, 'completed');
  token.valid = false;
  assert.equal(await s.supervisor.invalidateRun(token, p.id, 0), true);
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'failed'); assert.equal(row.reason, 'end_not_matched_to_message');
  assert.equal(row.nextStep, 1); assert.equal(row.automaticReplay, false);
  assert.equal(s.sent.length, 1);
});
test('late ticket cannot cancel an unrelated plan or unmatched active step', async t => {
  const s = await setup(t), first = value(), firstToken = { epoch: 1, valid: true };
  first.steps[0].continueAfterEnd = false;
  await s.store.enqueue(first); await s.supervisor.tick(); await startRun(s, firstToken); await endStep(s, first, firstToken, false);
  assert.equal((await s.store.receipt(first.id)).state, 'completed');
  const next = value(), nextToken = { epoch: 2, valid: true };
  await s.store.enqueue(next); await s.supervisor.tick(); await startRun(s, nextToken);
  await endStep(s, first, firstToken, false); // stale completion must not target the replacement plan
  assert.equal(s.supervisor.active.row.id, next.id);
  assert.equal(s.supervisor.run, nextToken);
  assert.equal((await s.store.receipt(next.id)).state, 'submitted');
  assert.equal(await s.supervisor.invalidateRun(nextToken, next.id, 99), false);
  assert.equal(nextToken.valid, true);
  assert.equal(s.supervisor.active.row.id, next.id);
  assert.equal((await s.store.receipt(next.id)).state, 'submitted');
  assert.equal(await s.supervisor.invalidateRun(firstToken, first.id, 0), true);
  assert.equal(firstToken.valid, false); assert.equal(nextToken.valid, true);
  assert.equal((await s.store.receipt(first.id)).state, 'failed');
  assert.equal(s.supervisor.active.row.id, next.id);
  assert.equal(s.supervisor.run, nextToken);
  assert.equal((await s.store.receipt(next.id)).state, 'submitted');
  assert.equal(s.sent.length, 2);
  await endStep(s, next, nextToken, false);
  assert.equal((await s.store.receipt(next.id)).state, 'completed');
});
test('receipt failure after API return stops lane; uncertain shutdown retains lock', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p);
  const save = s.store.save.bind(s.store); s.store.save = row => row.state === 'submitted' ? Promise.reject(new Error('disk fault')) : save(row);
  await assert.rejects(s.supervisor.tick(), /disk fault/); await assert.rejects(s.supervisor.tick(), /stopped/); assert.equal(s.sent.length, 1);
  s.store.save = async () => { throw new Error('disk fault'); };
  await assert.rejects(s.supervisor.close(), /lock retained/);
  await assert.rejects(new Supervisor(s.store, s.adapter).open(), e => e.code === 'EEXIST');
});
test('a stop that failed leaves this session\'s own lock, which the next open may take over; another process\'s lock is never taken', async t => {
  const s = await setup(t); const p = value(); await s.store.enqueue(p); await s.supervisor.tick();
  s.store.save = async () => { throw new Error('disk fault'); };
  await assert.rejects(s.supervisor.close(), /lock retained/);
  delete s.store.save; // back to the real save
  const lock = path.join(s.root, `supervisor-${sessionId}.lock`), mine = await fs.readFile(lock, 'utf8');
  await fs.writeFile(lock, mine.replace(`"pid":${process.pid}`, `"pid":${process.pid + 1}`));
  await assert.rejects(new Supervisor(s.store, s.adapter).open(true), e => e.code === 'EEXIST');
  await fs.writeFile(lock, mine);
  const next = new Supervisor(s.store, s.adapter); s.defer(() => next.close().catch(() => {}));
  await next.open(true);
  assert.equal(next.closed, false);
});
test('a state folder that cannot be fully made is taken away again, so the next try is not refused', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-bridge-test-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state'), mkdir = fs.mkdir;
  fs.mkdir = async (dir, ...rest) => { if (String(dir) === path.join(root, 'control')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return mkdir.call(fs, dir, ...rest); };
  try { await assert.rejects(initialize(root), { code: 'ENOSPC' }); } finally { fs.mkdir = mkdir; }
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await initialize(root);
  await fs.stat(path.join(root, 'control'));
});
test('simultaneous ticks serialize and send one request', async t => {
  const s = await setup(t); await s.store.enqueue(value()); await Promise.all([s.supervisor.tick(), s.supervisor.tick(), s.supervisor.tick()]);
  assert.equal(s.sent.length, 1);
});
test('linked state roots are rejected', async t => {
  const s = await setup(t); const link = path.join(s.base, 'linked');
  await fs.symlink(s.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new Store({ ...s.store.config, root: link }).ready(), /linked/);
});
test('transcript admission requires exact sole user record and correct identity', async t => {
  const s = await setup(t); const file = path.join(s.base, 'fixture.jsonl');
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  await fs.writeFile(file, JSON.stringify(header) + '\n' + JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'old' } }) + '\n');
  const proof = await fence(file, s.store.config, 'exact');
  const fileStat = await fs.stat(file, { bigint: true });
  assert.equal(proof.dev, fileStat.dev.toString());
  assert.equal(proof.ino, fileStat.ino.toString());
  await fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'exact' } }) + '\n');
  assert.equal(await admitted(proof), false);
  await fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'exact' }] } }) + '\n');
  assert.equal(await admitted(proof), true);
  await fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'manual input' } }) + '\n');
  assert.equal(await admitted(proof), false);
  await assert.rejects(fence(file, { ...s.store.config, sessionId: crypto.randomUUID() }, 'exact'), /identity/);
});
test('transcript-controlled streamed metadata cannot spoof exact user content', async t => {
  const s = await setup(t); const file = path.join(s.base, 'spoofed-stream-marker.jsonl');
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  await fs.writeFile(file, JSON.stringify(header) + '\n');
  const proof = await fence(file, s.store.config, 'exact');
  const forged = { type: 'message', __streamed: true,
    message: { role: 'user', contentKind: 'string', contentHash: proof.textHash, content: 'different' } };
  await fs.appendFile(file, JSON.stringify(forged) + '\n');
  assert.equal(await admitted(proof), false);
});

test('shutdown during admission cannot commit terminal advancement', async t => {
  let releaseAdmission, signalStarted;
  const gate = new Promise(resolve => { releaseAdmission = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const s = await setup(t, { admitted: async () => { signalStarted(); await gate; return true; } });
  const p = value(2); await s.store.enqueue(p); await s.supervisor.tick(); await startRun(s, 'run');
  const ending = endStep(s, p, 'run', false);
  await started;
  s.supervisor.beginClose();
  releaseAdmission();
  await ending;
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'failed'); assert.equal(row.reason, 'supervisor_shutdown');
  assert.equal(row.nextStep, 0); assert.equal(row.automaticReplay, false);
  assert.equal(row.outcomes[0].terminalObservation, 'not_seen'); assert.equal(s.sent.length, 1);
});
test('persistent abort during admission cancels observation without advancing', async t => {
  let signalStarted;
  const admissionStarted = new Promise(resolve => { signalStarted = resolve; });
  const s = await setup(t, { admitted: (_proof, { signal }) => {
    signalStarted();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  const p = value(2); await s.store.enqueue(p); await s.supervisor.tick(); await startRun(s, 'run');
  const ending = endStep(s, p, 'run', false);
  await admissionStarted;
  await s.store.abort(p.id);
  await ending;
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'aborted'); assert.equal(row.reason, 'future_steps_cancelled_execution_may_continue');
  assert.equal(row.nextStep, 0); assert.equal(row.automaticReplay, false);
  assert.equal(row.outcomes[0].terminalObservation, 'not_seen'); assert.equal(s.sent.length, 1);
  await s.supervisor.tick();
  assert.equal(s.sent.length, 1);
});
test('terminal persistence failure drains a pending cancellation monitor without an unhandled rejection', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-terminal-failure-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { initialize, Store, Supervisor } from ${JSON.stringify(new URL('../src/control.mjs', import.meta.url).href)};
    const base=${JSON.stringify(base)}, sessionId=${JSON.stringify(sessionId)}, id='00000000-0000-4000-8000-000000000002';
    const root=path.join(base,'state');await initialize(root);
    const store=new Store({sessionId,cwd:base,root});
    let sends=0,ending=false,reads=0,entered,release,drained=false,saveFailures=0;
    const held=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const cancelled=store.cancelled.bind(store),save=store.save.bind(store);
    store.cancelled=async planId=>{
      const value=await cancelled(planId);
      if(ending&&++reads===2){entered();await gate;drained=true;}
      return value;
    };
    store.save=async row=>{
      if(['aborted','failed'].includes(row.state)){
        // Drain only after a turn in which the rejected save needs a handler.
        saveFailures++;setTimeout(release,100);throw Error('terminal disk fault');
      }
      return save(row);
    };
    const supervisor=new Supervisor(store,{isIdle:()=>true,fence:async()=>({}),send:()=>{sends++;},
      admitted:async()=>{await held;await store.abort(id);return true;}});
    await supervisor.open();await store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Disposable terminal failure.',continueAfterEnd:false}]});await supervisor.tick();
    const owner=supervisor.active,token={valid:true};await supervisor.started(token,{owner,sessionId,planId:id,step:0});
    ending=true;
    await assert.rejects(supervisor.ended(token,false,{sessionId,planId:id,step:0}),/terminal disk fault/);
    assert.equal(drained,true);assert.equal(saveFailures,1);assert.equal(supervisor.closed,true);
    await assert.rejects(supervisor.tick(),/supervisor stopped/);assert.equal(sends,1);
    const receipt=await store.receipt(id);assert.equal(receipt.state,'submitted');
    assert.equal(receipt.nextStep,0);assert.equal(receipt.automaticReplay,false);
    await assert.rejects(supervisor.close(),/shutdown receipt failed; lock retained/);
    await fs.stat(supervisor.lockFile);
    console.log(JSON.stringify({closed:true,drained,sends,nextStep:receipt.nextStep,automaticReplay:receipt.automaticReplay}));
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {closed:true,drained:true,sends:1,nextStep:0,automaticReplay:false});
});

test('durable fence precedes send and verified append proof precedes admission', async t => {
  const fenceRecord = { fileDev: '1', fileIno: '2', start: 0, offset: 100,
    prefixHash: 'a'.repeat(64), textHash: 'b'.repeat(64) };
  const progress = { fileDev: '1', fileIno: '2', fenceOffset: 100, processedOffset: 1048676, appendHash: 'c'.repeat(64) };
  const proof = { fileDev: '1', fileIno: '2', fenceOffset: 100, endOffset: 1048700, appendHash: 'd'.repeat(64) };
  const p = value(); let s; let fenceAtSend;
  s = await setup(t, {
    receiptFence: () => fenceRecord,
    send: async text => {
      fenceAtSend = (await s.store.receipt(p.id)).outcomes[0].admissionFence;
      s.sent.push(text);
    },
    admitted: async (_fence, options) => {
      await options.onProgress(progress);
      await options.onVerified(proof);
      return true;
    },
  });
  await s.store.enqueue(p); await s.supervisor.tick();
  assert.deepEqual(fenceAtSend, fenceRecord);
  await startRun(s, 'run-1'); await endStep(s, p, 'run-1', false);
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'completed');
  assert.deepEqual(row.outcomes[0].admissionProof, proof);
  assert.equal(row.outcomes[0].admissionProgress, undefined);
  assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(row.taskSuccess, 'unverified');
});

test('supervisor close aborts transcript observation without replaying native work', async t => {
  let entered; const admitted = new Promise(resolve => { entered = resolve; });
  const s = await setup(t, { admitted: (_proof, options) => {
    entered();
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  const p = value(); await s.store.enqueue(p); await s.supervisor.tick(); await startRun(s, 'run-1');
  const ending = endStep(s, p, 'run-1', false);
  await admitted;
  const closing = s.supervisor.close();
  await Promise.all([ending, closing]);
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, 'supervisor_shutdown');
  assert.equal(row.taskSuccess, 'unverified');
  assert.equal(s.sent.length, 1);
  await assert.rejects(fs.stat(path.join(s.root, `supervisor-${sessionId}.lock`)), { code: 'ENOENT' });
});

test('streamed correlation admits a >342390-byte record and growth above 2 MiB', async t => {
  const s = await setup(t); const file = path.join(s.base, 'large-record.jsonl');
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  await fs.writeFile(file, JSON.stringify(header) + '\n');
  const prompt = 'exact π 😀\n"';
  const escapedPrompt = JSON.stringify(prompt).replace('😀', '\\ud83d\\ude00');
  const largeUser = `{"type":"message","message":{"role":"user","content":${escapedPrompt}},"opaque":"${'x'.repeat(342390)}"}\n`;
  assert.ok(Buffer.byteLength(largeUser) > 342390);
  const assistant = JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'x'.repeat(300000) } }) + '\n';
  const tail = largeUser + assistant.repeat(7);
  assert.ok(Buffer.byteLength(tail) > 2 * 1024 * 1024);
  const proof = await fence(file, s.store.config, prompt);
  await fs.appendFile(file, tail);
  let verified;
  assert.equal(await reconcileAdmission(proof, { onVerified: value => { verified = value; } }), true);
  assert.equal(verified.fenceOffset, proof.offset);
  assert.ok(verified.endOffset > verified.fenceOffset);
  assert.match(verified.appendHash, /^[a-f0-9]{64}$/);
});

test('streamed admission waits for a split >342390-byte JSONL row', async t => {
  const s = await setup(t); const file = path.join(s.base, 'split-large-record.jsonl');
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  await fs.writeFile(file, JSON.stringify(header) + '\n');
  const prompt = 'split exact';
  const row = JSON.stringify({ type: 'message', message: { role: 'user', content: prompt },
    opaque: 'z'.repeat(342390) }) + '\n';
  assert.ok(Buffer.byteLength(row) > 342390);
  const split = Math.floor(row.length / 2);
  const proof = await fence(file, s.store.config, prompt);
  await fs.appendFile(file, row.slice(0, split));
  let completed = false;
  assert.equal(await reconcileAdmission(proof, { testHooks: { wait: async () => {
    if (!completed) { completed = true; await fs.appendFile(file, row.slice(split)); }
    return true;
  } } }), true);
});

test('admission reconciliation fails closed for changed, malformed and ambiguous evidence', async t => {
  const s = await setup(t);
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  const cases = [
    ['malformed row', async file => fs.appendFile(file, 'not-json\n')],
    ['large malformed row', async file => fs.appendFile(file, '{"type":' + 'x'.repeat(342390) + '}\n')],
    ['nonmatching user', async file => fs.appendFile(file,
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'other' } }) + '\n')],
    ['multiple user rows', async file => fs.appendFile(file,
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'exact' } }) + '\n' +
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'exact' } }) + '\n')],
    ['excessively nested opaque row', async file => fs.appendFile(file,
      '{"type":"message","message":{"role":"user","content":"exact"},"opaque":' +
      '['.repeat(257) + '0' + ']'.repeat(257) + ',"padding":"' + 'x'.repeat(65536) + '"}\n')],
    ['changed session header', async file => fs.writeFile(file,
      JSON.stringify({ ...header, id: crypto.randomUUID() }) + '\n')],
  ];
  for (const [name, change] of cases) {
    const file = path.join(s.base, name.replaceAll(' ', '-') + '.jsonl');
    await fs.writeFile(file, JSON.stringify(header) + '\n{}\n');
    const proof = await fence(file, s.store.config, 'exact');
    await change(file);
    assert.equal(await reconcileAdmission(proof), false, name);
  }
});

test('admission rejects same-content path replacement', async t => {
  const s = await setup(t); const file = path.join(s.base, 'path-swap.jsonl');
  const content = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: s.base }) + '\n{}\n';
  await fs.writeFile(file, content);
  const proof = await fence(file, s.store.config, 'exact');
  const replacement = file + '.replacement';
  const displaced = file + '.displaced';
  await fs.writeFile(replacement, content);
  await fs.rename(file, displaced);
  await fs.rename(replacement, file);
  const diagnostics = [];
  assert.equal(await reconcileAdmission(proof, { onFailure: diagnostic => diagnostics.push(diagnostic) }), false);
  assert.equal(diagnostics[0].failure, 'file_identity_mismatch');
});

test('admission reconciliation waits beyond one second and remains abortable', async t => {
  const s = await setup(t); const file = path.join(s.base, 'delayed.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: s.base }) + '\n');
  const proof = await fence(file, s.store.config, 'exact');
  const delayedAppend = new Promise(resolve => setTimeout(resolve, 1100)).then(() =>
    fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'exact' } }) + '\n'));
  assert.equal(await reconcileAdmission(proof), true);
  await delayedAppend;

  const abortFile = path.join(s.base, 'abort.jsonl');
  await fs.writeFile(abortFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: s.base }) + '\n');
  const abortProof = await fence(abortFile, s.store.config, 'exact');
  const controller = new AbortController(); const diagnostics = [];
  const pending = reconcileAdmission(abortProof, { signal: controller.signal, onFailure: row => diagnostics.push(row) });
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(diagnostics.at(-1).failure, 'admission_aborted');
});


test('admission failure diagnostics contain bounded metadata, not transcript data or paths', async t => {
  const s = await setup(t); const file = path.join(s.base, 'diagnostic.jsonl');
  const header = { type: 'session', version: 3, id: sessionId, cwd: s.base };
  await fs.writeFile(file, JSON.stringify(header) + '\n');
  const proof = await fence(file, s.store.config, 'EXPECTED_PRIVATE_PROMPT');
  const appended = JSON.stringify({ type: 'message', message: { role: 'user', content: 'PRIVATE_TRANSCRIPT_CONTENT' } }) + '\n';
  await fs.appendFile(file, appended);
  const diagnostics = [];
  assert.equal(await reconcileAdmission(proof, { onFailure: diagnostic => diagnostics.push(diagnostic) }), false);
  assert.deepEqual(diagnostics, [{
    failure: 'user_text_mismatch', identityMatches: true, fenceMatches: true,
    processedBytes: Buffer.byteLength(appended), userCount: 1, textMatches: false,
  }]);
  const diagnosticText = JSON.stringify(diagnostics);
  assert.equal(diagnosticText.includes('EXPECTED_PRIVATE_PROMPT'), false);
  assert.equal(diagnosticText.includes('PRIVATE_TRANSCRIPT_CONTENT'), false);
  assert.equal(diagnosticText.includes(file), false);
  assert.equal(diagnosticText.includes(s.base), false);
});

test('malformed or replaced transcript evidence is failed', async t => {
  const s = await setup(t); const file = path.join(s.base, 'fixture.jsonl');
  const content = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: s.base }) + '\n' + '{}\n';
  await fs.writeFile(file, content); const proof = await fence(file, s.store.config, 'exact');
  await fs.appendFile(file, 'not-json\n'); assert.equal(await admitted(proof), false);
  await fs.writeFile(file, content.replace('version', 'changed')); assert.equal(await admitted(proof), false);
});
test('exclusive atomic publication preserves original record', async t => {
  const s = await setup(t); const file = path.join(s.root, 'control', crypto.randomUUID() + '.json');
  await writeJson(file, { original: true }, true); await assert.rejects(writeJson(file, { replaced: true }, true));
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { original: true });
});
test('post-publication cleanup failure returns committed success, without duplicate publication', async t => {
  const s = await setup(t); const file = path.join(s.root, 'control', crypto.randomUUID() + '.json');
  const io = { ...fs, unlink: async () => { throw new Error('synthetic cleanup fault'); } };
  await writeJson(file, { committed: true }, true, io);
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { committed: true });
  await assert.rejects(writeJson(file, { duplicate: true }, true), e => e.code === 'EEXIST');
});
test('hanging API invocation times out as failed and is never repeated', async t => {
  let calls = 0;
  const s = await setup(t, { send: () => { calls++; return new Promise(() => {}); } });
  const p = value(); await s.store.enqueue(p); await s.supervisor.tick(); await s.supervisor.tick();
  assert.equal(calls, 1); const row = await s.store.receipt(p.id); assert.equal(row.state, 'failed'); assert.equal(row.reason, 'submission_exception');
});
// Regression: some OMP versions keep the send call open until the run ends. START and END
// arrive while it is open (even if OMP already reads idle again); the plan must finish as
// completed, not submission_exception.
test('send call that stays open while the run starts and ends still records a completed plan', async t => {
  let finish; const runDone = new Promise(resolve => { finish = resolve; });
  const s = await setup(t, { send: () => runDone });
  const p = value(); await s.store.enqueue(p);
  const dispatch = s.supervisor.tick();
  while (!s.supervisor.active?.submissionInvoked) await new Promise(resolve => setTimeout(resolve, 10));
  const start = startRun(s, 1), end = endStep(s, p, 1, false);
  await dispatch; await start; await end; finish();
  const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'completed'); assert.equal(row.reason, 'all_planned_submissions_ended_success_unverified');
  assert.deepEqual([row.outcomes[0].submission, row.outcomes[0].terminalObservation], ['returned', 'run_end_observed']);
});
for (const stopMode of ['extension disable', 'direct close']) {
  test(`stop gate: ${stopMode} during paused admission fence never sends and holds lock until cleanup`, async t => {
    let entered, release;
    const enteredFence = new Promise(resolve => { entered = resolve; });
    const fenceGate = new Promise(resolve => { release = resolve; });
    const s = await setup(t, { fence: () => { entered(); return fenceGate; } });
    const p = value(); await s.store.enqueue(p);
    const dispatch = s.supervisor.tick(); await enteredFence;
    assert.equal(s.sent.length, 0);
    if (stopMode === 'extension disable') s.supervisor.closed = true;
    const closing = s.supervisor.close();
    assert.equal(s.supervisor.closed, true, 'close must synchronously stop admission');
    await fs.stat(path.join(s.root, 'supervisor-' + sessionId + '.lock'));
    release({ fixture: true }); await dispatch; await closing;
    assert.equal(s.sent.length, 0, 'disable cannot dispatch after its paused fence resumes');
    const row = await s.store.receipt(p.id);
    assert.equal(row.state, 'failed'); assert.equal(row.reason, 'supervisor_shutdown');
    assert.equal(row.outcomes[0].submission, 'not_seen');
    await assert.rejects(fs.stat(path.join(s.root, 'supervisor-' + sessionId + '.lock')), { code: 'ENOENT' });
  });
}

test('stop gate is checked inside the deferred API callback, not before its microtask', async t => {
  const s = await setup(t); let idleCalls = 0;
  s.adapter.isIdle = () => { if (++idleCalls === 2) queueMicrotask(() => { s.supervisor.closed = true; }); return true; };
  const p = value(); await s.store.enqueue(p); await s.supervisor.tick(); await s.supervisor.close();
  assert.equal(s.sent.length, 0);
  assert.equal((await s.store.receipt(p.id)).reason, 'supervisor_shutdown');
});
test('native binding change in the immediate dispatch gate persists failed without a send', async t => {
  let idleCalls = 0, sends = 0;
  const s = await setup(t, { isIdle: () => ++idleCalls < 4, send: async () => { sends++; } });
  const p = value(); await s.store.enqueue(p); await s.supervisor.tick();
  const row = await s.store.receipt(p.id);
  assert.equal(idleCalls, 4); assert.equal(sends, 0);
  assert.equal(row.state, 'failed'); assert.equal(row.reason, 'context_changed_before_submission');
  await s.supervisor.tick(); assert.equal(sends, 0);
  assert.equal((await s.store.receipt(p.id)).automaticReplay, false);
});

test('stop after API invocation does not claim cancellation or replay admitted native work', async t => {
  let entered, release;
  const enteredSend = new Promise(resolve => { entered = resolve; });
  const sendGate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const s = await setup(t, { send: () => { calls++; entered(); return sendGate; } });
  const p = value(); await s.store.enqueue(p); const dispatch = s.supervisor.tick(); await enteredSend;
  s.supervisor.closed = true; const closing = s.supervisor.close(); release(); await dispatch; await closing;
  assert.equal(calls, 1); const row = await s.store.receipt(p.id);
  assert.equal(row.state, 'failed'); assert.equal(row.taskSuccess, 'unverified'); assert.equal(row.automaticReplay, false);
  assert.equal(row.outcomes[0].submission, 'returned');
});

// A person queues a task behind a long-running one and walks away.
const queued = () => ({ ...value(1), expiresAt: now + QUEUE_LIMIT_MS });
test('a task queued behind a task that runs for hours still starts, once, when the lane is free', async t => {
  let idle = false; const s = await setup(t, { isIdle: () => idle }); let time = now; s.store.now = () => time;
  const p = queued(); await s.store.enqueue(p);
  await s.supervisor.tick(); assert.equal(s.sent.length, 0, 'the lane is busy');
  time += 2 * 3600000; idle = true; // past the old one-hour limit
  await s.supervisor.tick(); assert.equal(s.sent.length, 1, 'it starts');
  assert.equal((await s.store.receipt(p.id)).state, 'submitted');
  await s.supervisor.tick(); assert.equal(s.sent.length, 1, 'it is never sent twice');
});
test('a queued task whose time truly runs out is reported with its id, never runs, and is never retried', async t => {
  let idle = false; const events = []; const s = await setup(t, { isIdle: () => idle, laneEvent: (event, fields) => events.push([event, fields]) });
  let time = now; s.store.now = () => time;
  const p = queued(); await s.store.enqueue(p);
  await s.supervisor.tick();
  time += QUEUE_LIMIT_MS + 1000; idle = true;
  await s.supervisor.tick();
  const row = await s.store.receipt(p.id);
  assert.deepEqual([row.state, row.reason], ['expired', 'expired_before_submission']);
  assert.deepEqual(events, [['plan_done', { planId: p.id, state: 'expired', reason: 'expired_before_submission' }]]);
  await s.supervisor.tick(); await s.supervisor.tick();
  assert.equal(s.sent.length, 0); assert.equal(events.length, 1, 'reported once');
});

test('a supervisor lock that cannot be written is taken away again and the real cause is thrown, so the next open is not refused', async t => {
  const s = await setup(t); await s.supervisor.close();
  const lock = path.join(s.root, `supervisor-${sessionId}.lock`), open = fs.open;
  fs.open = async (file, ...rest) => {
    const handle = await open.call(fs, file, ...rest);
    if (String(file) === lock) handle.writeFile = async () => { throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }); };
    return handle;
  };
  try { await assert.rejects(new Supervisor(s.store, s.adapter).open(), { code: 'ENOSPC' }); } finally { fs.open = open; }
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  const next = new Supervisor(s.store, s.adapter); s.defer(() => next.close().catch(() => {}));
  await next.open();
  assert.equal(next.closed, false);
});
