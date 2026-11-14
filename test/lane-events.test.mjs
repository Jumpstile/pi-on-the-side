import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, LaneEvents, LANE_EVENTS, Store, Supervisor } from '../src/control.mjs';

const sessionId = '00000000-0000-4000-8000-000000000011';
const FIELDS = new Set(['version', 'seq', 'time', 'pid', 'sessionId', 'event', 'planId', 'state', 'reason', 'dropped', 'model']);
const SECRET = 'SECRET-TASK-TEXT-do-not-log';
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-lane-events-')));
  const cleanup = [() => fs.rm(base, { recursive: true, force: true })];
  t.after(async () => { while (cleanup.length) await cleanup.pop()(); });
  const root = path.join(base, 'state'); await initialize(root);
  return { base, root, defer: fn => cleanup.push(fn) };
}
const read = async (root, name = 'lane-events.jsonl') =>
  (await fs.readFile(path.join(root, 'control', name), 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
const plan = (prompt = SECRET, continueAfterEnd = false) => ({ version: 1, id: crypto.randomUUID(), sessionId,
  expiresAt: Date.now() + 60000, steps: [{ prompt, continueAfterEnd }] });

test('lane events: fixed schema, fixed vocabularies, no content', async t => {
  const f = await fixture(t), events = new LaneEvents(f.root, sessionId), id = crypto.randomUUID();
  events.record('plan_done', { planId: id, state: 'completed', reason: 'all_planned_submissions_ended_success_unverified', prompt: SECRET, text: SECRET });
  events.record('plan_done', { planId: id, state: 'failed', reason: `free text ${SECRET}`, message: SECRET });
  events.record('idle', { planId: 'not-a-uuid', state: 'completed', reason: 'native_idle' });
  events.record('plan_unknown', { planId: id, state: 'unknown' });
  events.record('queued_blocked', { planId: id, reason: 'unknown-review' });
  events.record('not_an_event', { planId: id });
  events.record('heartbeat', {});
  await events.flush();
  const rows = await read(f.root);
  assert.deepEqual(rows.map(row => row.event), ['plan_done', 'plan_done', 'idle']);
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3]);
  for (const row of rows) {
    assert.ok(Object.keys(row).every(key => FIELDS.has(key)), JSON.stringify(row));
    assert.equal(row.version, 1); assert.equal(row.sessionId, sessionId); assert.equal(row.pid, process.pid);
    assert.ok(Number.isSafeInteger(row.time) && Math.abs(row.time - Date.now()) < 5000);
  }
  assert.deepEqual([rows[0].planId, rows[0].state, rows[0].reason], [id, 'completed', 'all_planned_submissions_ended_success_unverified']);
  assert.deepEqual([rows[1].state, rows[1].reason], ['failed', 'other']);
  assert.equal(rows[2].planId, undefined); assert.equal(rows[2].state, undefined); // state only on plan_* events
  assert.equal((await fs.readFile(path.join(f.root, 'control', 'lane-events.jsonl'), 'utf8')).includes(SECRET), false);
  assert.deepEqual(LANE_EVENTS, ['idle', 'busy', 'plan_done', 'model_switched', 'model_mismatch', 'start_failed']);
  assert.throws(() => new LaneEvents(f.root, '../x'));
});

test('lane events: append-only across instances, bounded by two files', async t => {
  const f = await fixture(t);
  const first = new LaneEvents(f.root, sessionId, 1024);
  first.record('idle', { reason: 'native_idle' }); await first.flush();
  const before = await fs.readFile(path.join(f.root, 'control', 'lane-events.jsonl'), 'utf8');
  const second = new LaneEvents(f.root, sessionId, 1024);
  second.record('busy', { reason: 'native_busy' }); await second.flush();
  const after = await fs.readFile(path.join(f.root, 'control', 'lane-events.jsonl'), 'utf8');
  assert.ok(after.startsWith(before)); assert.equal((await read(f.root)).length, 2);
  for (let i = 0; i < 40; i++) { second.record(i % 2 ? 'idle' : 'busy', { planId: crypto.randomUUID(), reason: i % 2 ? 'native_idle' : 'plan_active' }); await second.flush(); }
  const names = (await fs.readdir(path.join(f.root, 'control'))).filter(name => name.startsWith('lane-events'));
  assert.deepEqual(names.sort(), ['lane-events.jsonl', 'lane-events.jsonl.1']);
  for (const name of names) assert.ok((await fs.stat(path.join(f.root, 'control', name))).size <= 1024);
  const rows = [...await read(f.root, 'lane-events.jsonl.1'), ...await read(f.root)];
  assert.deepEqual(rows.map(row => row.seq), rows.map(row => row.seq).sort((a, b) => a - b));
  assert.equal(rows.at(-1).seq, 41);
});

test('lane events: a full queue drops and reports the count instead of growing', async t => {
  const f = await fixture(t), events = new LaneEvents(f.root, sessionId);
  for (let i = 0; i < 200; i++) events.record(i % 2 ? 'idle' : 'busy', { reason: 'native_busy' });
  await events.flush();
  events.record('idle', { reason: 'native_idle' }); await events.flush();
  const rows = await read(f.root);
  assert.ok(rows.length < 200); assert.ok(rows.some(row => Number.isSafeInteger(row.dropped) && row.dropped > 0));
});

test('lane events: refuses to write through a linked control directory', async t => {
  const f = await fixture(t), elsewhere = path.join(f.base, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.rm(path.join(f.root, 'control'), { recursive: true }); await fs.symlink(elsewhere, path.join(f.root, 'control'), process.platform === 'win32' ? 'junction' : 'dir');
  const events = new LaneEvents(f.root, sessionId); events.record('idle', { reason: 'native_idle' }); await events.flush();
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

async function supervisorFixture(t, overrides = {}) {
  // The clock stands still, so the 5 second settle hold cannot run out while a slow PC is busy elsewhere.
  const f = await fixture(t), frozen = Date.now(), store = new Store({ sessionId, cwd: f.base, root: f.root }, () => frozen);
  const events = new LaneEvents(f.root, sessionId);
  const sent = [];
  const adapter = { isIdle: () => true, send: async text => sent.push(text), fence: async () => ({ fixture: true }), admitted: async () => true,
    laneEvent: (event, fields) => events.record(event, fields), ...overrides };
  const supervisor = new Supervisor(store, adapter);
  await supervisor.open(); f.defer(() => supervisor.close().catch(() => {}));
  return { ...f, store, events, sent, supervisor, adapter };
}
const startRun = (s, token) => { const owner = s.supervisor.active;
  return s.supervisor.started(token, { owner, sessionId: owner.row.sessionId, planId: owner.row.id, step: owner.row.nextStep }); };
const endRun = (s, p, token) => s.supervisor.ended(token, false, { sessionId, planId: p.id, step: 0 });

test('lane events: finished plan emits plan_done; a failed plan emits plan_done/failed once, holds the next plan for the settle time and is never replayed', async t => {
  const s = await supervisorFixture(t, { admitted: async () => false });
  const unknown = plan(); await s.store.enqueue(unknown);
  await s.supervisor.tick(); await startRun(s, 1); await endRun(s, unknown, 1);
  const row = await s.store.receipt(unknown.id);
  assert.equal(row.state, 'failed'); assert.equal(row.reason, 'message_not_confirmed_in_transcript');
  const queued = plan('another task'); await s.store.enqueue(queued);
  for (let i = 0; i < 3; i++) await s.supervisor.tick();
  await s.events.flush();
  const rows = await read(s.root);
  assert.deepEqual(rows.map(r => [r.event, r.planId, r.state, r.reason]), [
    ['plan_done', unknown.id, 'failed', 'message_not_confirmed_in_transcript'],
  ]);
  assert.equal(await s.store.receipt(queued.id), null); assert.equal(s.sent.length, 1); // held for the settle time, never replayed
  assert.equal((await s.store.receipt(unknown.id)).automaticReplay, false);
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
});

test('lane events: plan_done for completion; blocked state clears when the queue is empty', async t => {
  const s = await supervisorFixture(t);
  const done = plan(); await s.store.enqueue(done);
  await s.supervisor.tick(); await startRun(s, 1); await endRun(s, done, 1);
  assert.equal((await s.store.receipt(done.id)).state, 'completed');
  await s.supervisor.tick(); await s.events.flush();
  assert.deepEqual((await read(s.root)).map(r => [r.event, r.planId, r.state, r.reason]),
    [['plan_done', done.id, 'completed', 'all_planned_submissions_ended_success_unverified']]);
  // The next queued plan dispatches on the first idle tick: no review gate, no extra event.
  const next = plan('next task'); await s.store.enqueue(next);
  await s.supervisor.tick();
  assert.equal(s.sent.length, 2); assert.equal((await s.store.receipt(next.id)).state, 'submitted');
  await s.events.flush(); assert.equal((await read(s.root)).length, 1);
});

test('lane events: cancelled plan is plan_done/aborted', async t => {
  const s = await supervisorFixture(t), p = plan(); await s.store.enqueue(p); await s.store.abort(p.id);
  await s.supervisor.tick(); await s.events.flush();
  assert.deepEqual((await read(s.root)).map(r => [r.event, r.state, r.reason]), [['plan_done', 'aborted', 'cancelled_before_submission']]);
});

test('lane events: an in-flight receipt recovered at restart is reported as plan_done/failed/restart', async t => {
  const s = await supervisorFixture(t), p = plan(); await s.store.enqueue(p);
  await s.supervisor.tick();
  assert.equal((await s.store.receipt(p.id)).state, 'submitted');
  await s.supervisor.close(); await s.events.flush();
  await fs.rm(path.join(s.root, 'control', 'lane-events.jsonl'), { force: true });
  const events = new LaneEvents(s.root, sessionId);
  const restarted = new Supervisor(s.store, { isIdle: () => true, laneEvent: (e, f) => events.record(e, f) });
  const row = await s.store.receipt(p.id); row.state = 'submitted'; delete row.reason; await s.store.save(row);
  await restarted.open(); s.defer(() => restarted.close().catch(() => {})); await events.flush();
  assert.deepEqual((await read(s.root)).map(r => [r.event, r.planId, r.state, r.reason]), [['plan_done', p.id, 'failed', 'restart']]);
});

test('lane events: observer failure never gates dispatch', async t => {
  const s = await supervisorFixture(t, { laneEvent: () => { throw new Error('observer exploded'); } });
  const p = plan(); await s.store.enqueue(p); await s.supervisor.tick();
  assert.equal((await s.store.receipt(p.id)).state, 'submitted');
});

test('lane events: two writers that reach the rotation together lose no row', async t => {
  const f = await fixture(t), a = new LaneEvents(f.root, sessionId, 1024), b = new LaneEvents(f.root, sessionId, 1024);
  const line = tag => JSON.stringify({ tag }).padEnd(249) + '\n';
  for (const tag of ['1', '2', '3', '4']) await a.append(line(tag));
  // The second writer has measured the full file before the first one has rotated it, and removes the old backup only after the first one is done.
  const unlink = fs.unlink; let backups = 0;
  fs.unlink = async (file, ...rest) => { if (String(file).endsWith('lane-events.jsonl.1') && backups++ > 0) await new Promise(resolve => setTimeout(resolve, 100)); return unlink.call(fs, file, ...rest); };
  try { await Promise.all([a.append(line('A')), b.append(line('B'))]); } finally { fs.unlink = unlink; }
  const tags = [];
  for (const name of ['lane-events.jsonl.1', 'lane-events.jsonl']) tags.push(...(await read(f.root, name)).map(row => row.tag));
  assert.deepEqual(tags.sort(), ['1', '2', '3', '4', 'A', 'B']);
  await assert.rejects(fs.stat(path.join(f.root, 'control', 'lane-events.lock')), { code: 'ENOENT' });
});

test('lane events: a guard that something held past the retry is removed by the next write, and the row lost meanwhile is counted', async t => {
  const f = await fixture(t), events = new LaneEvents(f.root, sessionId), guard = path.join(f.root, 'control', 'lane-events.lock');
  const unlink = fs.unlink; let held = true;
  fs.unlink = async (file, ...rest) => { if (held && String(file) === guard) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file, ...rest); };
  try {
    events.record('busy'); await events.flush(); // written; its guard cannot be removed
    events.record('idle'); await events.flush(); // still held: this row is lost, and that is counted
    held = false;
    events.record('busy'); await events.flush();
  } finally { fs.unlink = unlink; }
  const rows = await read(f.root);
  assert.deepEqual(rows.map(row => row.event), ['busy', 'busy']);
  assert.equal(rows[1].dropped, 1);
  await assert.rejects(fs.stat(guard), { code: 'ENOENT' });
});

// The first instance below is thrown away after its release fails, as the MCP server does for every task it starts.
test('lane events: a guard that something held is removed by a NEW instance for the same folder, so the log does not stay frozen', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'control', 'lane-events.lock');
  const unlink = fs.unlink; let held = true;
  fs.unlink = async (file, ...rest) => { if (held && String(file) === guard) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file, ...rest); };
  try {
    const first = new LaneEvents(f.root, sessionId);
    first.record('busy'); await first.flush(); // written; its guard cannot be removed
    assert.ok(await fs.stat(guard));
    held = false;
    const second = new LaneEvents(f.root, sessionId);
    second.record('idle'); await second.flush();
  } finally { fs.unlink = unlink; }
  assert.deepEqual((await read(f.root)).map(row => row.event), ['busy', 'idle']);
  await assert.rejects(fs.stat(guard), { code: 'ENOENT' });
});

test('lane events: a guard that something held is removed by itself shortly after, even if nothing writes again', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'control', 'lane-events.lock');
  const unlink = fs.unlink; let held = true;
  fs.unlink = async (file, ...rest) => { if (held && String(file) === guard) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file, ...rest); };
  try {
    const events = new LaneEvents(f.root, sessionId);
    events.record('busy'); await events.flush();
    held = false;
    for (const deadline = Date.now() + 4000; Date.now() < deadline && await fs.stat(guard).then(() => true, () => false);) await new Promise(resolve => setTimeout(resolve, 100));
  } finally { fs.unlink = unlink; }
  await assert.rejects(fs.stat(guard), { code: 'ENOENT' });
});

test('lane events: a file with other words in it is never removed as the guard this process left, even when it has the same inode and creation time', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'control', 'lane-events.lock');
  const unlink = fs.unlink; let held = true;
  fs.unlink = async (file, ...rest) => { if (held && String(file) === guard) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file, ...rest); };
  const other = JSON.stringify({ pid: process.ppid, up: os.uptime() });
  try {
    const events = new LaneEvents(f.root, sessionId);
    events.record('busy'); await events.flush(); // written; its guard cannot be removed
    const handle = await fs.open(guard, 'r+'); // the same file, now holding another running program's words
    try { await handle.truncate(0); await handle.write(other, 0); } finally { await handle.close(); }
    held = false;
    events.record('idle'); await events.flush(); // the guard belongs to a running program: this row waits, then is lost
  } finally { fs.unlink = unlink; }
  assert.equal(await fs.readFile(guard, 'utf8'), other);
  assert.deepEqual((await read(f.root)).map(row => row.event), ['busy']);
});

test('lane events: a writer whose guard was taken over while it was frozen does not remove the new owner\'s guard when it resumes', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'control', 'lane-events.lock'), events = new LaneEvents(f.root, sessionId);
  const other = JSON.stringify({ pid: process.ppid, up: os.uptime() });
  const open = fs.open; let swapped = false;
  // While this writer is between taking the guard and releasing it, another writer takes the guard over.
  fs.open = async (file, ...rest) => {
    if (!swapped && String(file) === events.file) { swapped = true; await fs.unlink(guard); await fs.writeFile(guard, other); }
    return open.call(fs, file, ...rest);
  };
  try { events.record('busy'); await events.flush(); } finally { fs.open = open; }
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(guard, 'utf8'), other, 'the new owner\'s guard is still there');
});

test('lane events: a guard left by a program that is gone, whose process number now belongs to a running program, is taken over by the next writer', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'control', 'lane-events.lock');
  await fs.writeFile(guard, JSON.stringify({ pid: process.pid, up: os.uptime() - 60 })); // a live process number, but written a minute ago: no real writer holds it that long
  const events = new LaneEvents(f.root, sessionId);
  events.record('busy'); await events.flush();
  assert.deepEqual((await read(f.root)).map(row => row.event), ['busy']);
  await assert.rejects(fs.stat(guard), { code: 'ENOENT' });
});

test('lane events: a row that carried a dropped count and is lost itself keeps that count for the next row', async t => {
  const f = await fixture(t), events = new LaneEvents(f.root, sessionId), append = events.append.bind(events);
  let calls = 0;
  events.append = async line => { if (++calls <= 2) throw new Error('disk full'); return append(line); };
  for (const event of ['busy', 'idle', 'busy']) { events.record(event); await events.flush(); }
  const rows = await read(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dropped, 2, 'row 1 was lost, and row 2 (which carried 1) was lost too');
});
