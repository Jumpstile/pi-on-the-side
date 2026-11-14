import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main } from '../src/cli.mjs';
import { readConnections, registerConnection, identity, MAX_CONNECTIONS } from '../src/connections.mjs';
import { loadSetup } from '../src/setup.mjs';

const quiet = { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' };
const HOUR = 3600000;
const pad = i => String(i).padStart(2, '0');

async function base(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-slots-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // The install folder: `connections` holds the list, `launchers` the one Setup saves for each lane.
  await fs.mkdir(path.join(dir, 'install', 'connections'), { recursive: true });
  return dir;
}
const hubOf = dir => path.join(dir, 'install', 'connections');
// One saved lane: its session file and state folder. `hours` is how long ago its files last changed;
// `running` writes the lock a live OMP would hold.
async function lane(dir, name, { hours = 3, running = false } = {}) {
  const cwd = path.join(dir, 'project-' + name); await fs.mkdir(cwd);
  const session = path.join(dir, name + '.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
  const state = path.join(dir, 'state-' + name);
  assert.equal(await main(['setup', session, state], quiet), 0);
  const loaded = await loadSetup(state);
  const when = new Date(Date.now() - hours * HOUR);
  for (const item of ['config.json', 'plans', 'receipts']) await fs.utimes(path.join(state, item), when, when);
  if (running) await fs.writeFile(loaded.lockFile, JSON.stringify({ version: 1, pid: process.pid }));
  return { name, session, state, loaded };
}
// What Setup saves for a lane so that `pots lane restore` can find its state folder again.
const saveLauncher = (dir, row) => fs.mkdir(path.join(dir, 'install', 'launchers', row.name), { recursive: true })
  .then(() => fs.writeFile(path.join(dir, 'install', 'launchers', row.name, 'launch-settings.json'), JSON.stringify({ state: row.state })));
// A full list written directly, so the test does not pay for 64 registrations. lane-NN has the NN-th oldest files.
async function fullList(dir, options = () => ({})) {
  const rows = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) rows.push(await lane(dir, 'lane-' + pad(i), { hours: 100 - i, ...options(i) }));
  const hub = hubOf(dir);
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  return { hub, rows };
}
const names = async hub => (await readConnections(hub)).connections.map(row => row.name);
// The pots command as an installed copy runs it; the fake OMP only records how it was started.
const pots = dir => async argv => {
  const out = [], err = [], calls = [];
  const code = await main(argv, { ...quiet, managed: path.join(dir, 'install', 'runtime', 'current'), stdout: text => out.push(text), stderr: text => err.push(text),
    watch: async () => ({ status: 'off', setChildPid() {}, stop: async () => {} }), launch: async call => { calls.push(call); return 0; }, lease: async () => ({ held: [], unknown: [] }) });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
};

test('a full list drops only finished lanes, oldest first, and keeps every saved session', async t => {
  const dir = await base(t);
  // lane-00 is the oldest but running, lane-01 stopped only a few minutes ago, lane-20 is running.
  const { hub, rows } = await fullList(dir, i => i === 0 || i === 20 ? { running: true } : i === 1 ? { hours: 0.1 } : {});
  const fresh = await lane(dir, 'fresh-lane');
  const result = await registerConnection(hub, 'fresh-lane', fresh.state);
  const expectedGone = Array.from({ length: 16 }, (_, i) => 'lane-' + pad(i + 2));
  assert.deepEqual(result.retiredFinishedLanes, expectedGone);
  const left = await names(hub);
  assert.equal(left.length, 49);
  for (const name of ['lane-00', 'lane-01', 'lane-20', 'fresh-lane']) assert.ok(left.includes(name), name);
  for (const name of expectedGone) assert.ok(!left.includes(name), name);
  // Only rows moved: every session file and state folder is still there, and the old list is kept.
  for (const row of rows) { await fs.stat(row.session); await fs.stat(path.join(row.state, 'config.json')); }
  assert.equal(JSON.parse(await fs.readFile(path.join(hub, 'connections.json.bak1'), 'utf8')).connections.length, 64);
});

test('a full list of running lanes says so in plain words and removes nothing', async t => {
  const dir = await base(t), { hub } = await fullList(dir, () => ({ running: true })), fresh = await lane(dir, 'fresh-lane');
  const before = await fs.readFile(path.join(hub, 'connections.json'), 'utf8');
  await assert.rejects(registerConnection(hub, 'fresh-lane', fresh.state), error => {
    assert.match(error.message, /64 are running now and 0 stopped less than 2 hours ago/);
    assert.match(error.message, /pots lane close <lane-name>/);
    assert.doesNotMatch(error.message, /too many connections/);
    return true;
  });
  assert.equal(await fs.readFile(path.join(hub, 'connections.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(hub)).sort(), ['connections.json']);
  // The command line prints the same plain sentence.
  const shown = await pots(dir)(['connect', hub, 'fresh-lane', fresh.state]);
  assert.equal(shown.code, 1);
  assert.match(shown.err, /all of them are in use/);
});

test('pots lane close removes one finished lane, refuses a running one and the last one, and restore brings it back', async t => {
  const dir = await base(t), hub = hubOf(dir), run = pots(dir);
  const done = await lane(dir, 'done'), busy = await lane(dir, 'busy', { running: true });
  await saveLauncher(dir, done);
  await registerConnection(hub, 'busy', busy.state); await registerConnection(hub, 'done', done.state);

  const refused = await run(['lane', 'close', 'busy']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Lane busy is running, so it was not closed/);
  assert.deepEqual(await names(hub), ['busy', 'done']);

  const closed = await run(['lane', 'close', 'done']);
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /pots lane restore done/);
  assert.deepEqual(await names(hub), ['busy']);
  await fs.stat(done.session); await fs.stat(path.join(done.state, 'config.json'));
  // The last lane on the list cannot be closed: the list may not be empty.
  const last = await run(['lane', 'close', 'busy']);
  assert.equal(last.code, 1);
  assert.deepEqual(await names(hub), ['busy']);

  // restore: the lane goes back on the list and is then continued with OMP's --restore, like any stopped lane.
  const back = await run(['lane', 'restore', 'done']);
  assert.equal(back.code, 0, back.err);
  assert.match(back.err, /Lane done was not on the list, so it was put back/);
  assert.deepEqual(await names(hub), ['busy', 'done']);
  assert.ok(back.calls[0].args.includes('--restore'));
});

test('restore still works when the list is full: finished lanes make room', async t => {
  const dir = await base(t), { hub } = await fullList(dir), extra = await lane(dir, 'extra-lane'), run = pots(dir);
  await saveLauncher(dir, extra);
  const back = await run(['lane', 'restore', 'extra-lane']);
  assert.equal(back.code, 0, back.err);
  assert.match(back.err, /The list was full, so these finished lanes were taken off it: lane-00, lane-01/);
  const left = await names(hub);
  assert.equal(left.length, 49);
  assert.ok(left.includes('extra-lane'));
  assert.ok(back.calls[0].args.includes('--restore'));
  const unknown = await run(['lane', 'restore', 'never-saved']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /There is no lane called never-saved/);
  assert.equal(unknown.calls.length, 0);
});

test('a write that does not read back puts the old list back and says so', async t => {
  const dir = await base(t), { hub } = await fullList(dir), fresh = await lane(dir, 'fresh-lane');
  const before = await fs.readFile(path.join(hub, 'connections.json'), 'utf8');
  await assert.rejects(registerConnection(hub, 'fresh-lane', fresh.state, { write: file => fs.writeFile(file, '{"broken"') }),
    /put the old list back/);
  assert.equal(await fs.readFile(path.join(hub, 'connections.json'), 'utf8'), before);
  assert.equal((await names(hub)).length, 64);
});

test('one finished lane among running ones is dropped and the old list is still backed up', async t => {
  const dir = await base(t), { hub } = await fullList(dir, i => i === 7 ? {} : { running: true }), fresh = await lane(dir, 'fresh-lane');
  const result = await registerConnection(hub, 'fresh-lane', fresh.state);
  assert.deepEqual(result.retiredFinishedLanes, ['lane-07']);
  assert.equal((await names(hub)).length, 64);
  assert.equal(JSON.parse(await fs.readFile(path.join(hub, 'connections.json.bak1'), 'utf8')).connections.some(row => row.name === 'lane-07'), true);
});

test('closing a lane that has no launcher record still offers a restore, because the kept list names its folder', async t => {
  const dir = await base(t), hub = hubOf(dir), run = pots(dir);
  const done = await lane(dir, 'done'), other = await lane(dir, 'other', { running: true });
  await registerConnection(hub, 'other', other.state); await registerConnection(hub, 'done', done.state);
  const closed = await run(['lane', 'close', 'done']);
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /Lane done is off the list/);
  assert.match(closed.out, /pots lane restore done/);
  assert.deepEqual(await names(hub), ['other']);
  await fs.stat(path.join(done.state, 'config.json'));
});

test('pots lane list shows each lane as running, finished or stopped recently, and names the lanes that are off the list', async t => {
  const dir = await base(t), run = pots(dir);
  const rows = [await lane(dir, 'alpha', { running: true }), await lane(dir, 'bravo', { hours: 5 }), await lane(dir, 'charlie', { hours: 0.1 }), await lane(dir, 'delta', { hours: 9 })];
  const hub = hubOf(dir);
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  assert.equal((await run(['lane', 'close', 'delta'])).code, 0);
  const listed = await run(['lane', 'list']);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /Lanes on the list \(3 of 64\)/);
  assert.match(listed.out, /alpha: running/);
  assert.match(listed.out, /bravo: finished/);
  assert.match(listed.out, /charlie: stopped less than 2 hours ago/);
  assert.match(listed.out, /pots lane restore <lane-name>:\s+delta/);
});

test('pots lane close --finished takes every finished lane off in one step, keeps running and recent ones, and always leaves one', async t => {
  const dir = await base(t), run = pots(dir), hub = hubOf(dir);
  const rows = [await lane(dir, 'alpha', { running: true }), await lane(dir, 'bravo', { hours: 5 }), await lane(dir, 'charlie', { hours: 0.1 }), await lane(dir, 'delta', { hours: 9 })];
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  const done = await run(['lane', 'close', '--finished']);
  assert.equal(done.code, 0);
  assert.deepEqual(await names(hub), ['alpha', 'charlie']);
  assert.match(done.out, /2 finished lanes are off the list: delta, bravo/);
  for (const row of rows) { await fs.stat(row.session); await fs.stat(path.join(row.state, 'config.json')); }
  // Nothing finished is left: a plain message, nothing changed.
  const again = await run(['lane', 'close', '--finished']);
  assert.match(again.err + again.out, /No lane could be taken off the list/);
  assert.deepEqual(await names(hub), ['alpha', 'charlie']);
});

test('when every lane is finished, close --finished still leaves the most recently used one', async t => {
  const dir = await base(t), run = pots(dir), hub = hubOf(dir);
  const rows = [await lane(dir, 'old', { hours: 50 }), await lane(dir, 'middle', { hours: 20 }), await lane(dir, 'newest', { hours: 3 })];
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  assert.equal((await run(['lane', 'close', '--finished'])).code, 0);
  assert.deepEqual(await names(hub), ['newest']);
});

test('a closed lane without a launcher record can still be brought back with pots lane restore', async t => {
  const dir = await base(t), run = pots(dir), hub = hubOf(dir);
  const rows = [await lane(dir, 'scripted'), await lane(dir, 'other')];
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  const closed = await run(['lane', 'close', 'scripted']);
  assert.match(closed.out, /Bring it back with: pots lane restore scripted/);
  assert.ok(!(await names(hub)).includes('scripted'));
  const restored = await run(['lane', 'restore', 'scripted']);
  assert.equal(restored.code, 0, restored.err);
  assert.ok((await names(hub)).includes('scripted'));
});

test('a lane that was never on any kept list cannot be restored and says so in plain words', async t => {
  const dir = await base(t), run = pots(dir), hub = hubOf(dir);
  const rows = [await lane(dir, 'alpha'), await lane(dir, 'bravo')];
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: rows.map(r => ({ name: r.name, root: r.state, binding: identity(r.loaded) })) }) + '\n');
  const result = await run(['lane', 'restore', 'nowhere']);
  assert.equal(result.code, 1);
  assert.match(result.err, /There is no lane called nowhere\. Next: run pots lane list/);
});

test('a session saved in two places is skipped with a reason that says so', async t => {
  const dir = await base(t);
  const row = await lane(dir, 'twin');
  const copy = path.join(dir, 'twin-copy.jsonl');
  await fs.copyFile(row.session, copy);
  const err = [];
  const code = await main(['setup', copy, row.state], { ...quiet, stderr: text => err.push(text) });
  assert.notEqual(code, 0);
  assert.match(err.join('\n'), /already connected through another saved copy of its file/);
});
