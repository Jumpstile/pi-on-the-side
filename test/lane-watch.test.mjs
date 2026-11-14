import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { main } from '../src/cli.mjs';
const FIXTURE_HOST = 'omp/1.2.3';
import { writeJson } from '../src/control.mjs';
import { WATCH_DEFAULTS, WATCH_FILES, WATCH_LIMITS, createLaneWatch, createWatchMachine, ensureWatchSettings, formatWatchLine, groupResultFiles,
  ompLogSignal, parseWatchLine, readNewWatchLines, readWatchSettings, readWatchState, readWatchStates, startLaneWatch,
  stepWatchMachine, validateWatchSettings } from '../src/lane-watch.mjs';

const T0 = 1800000000000;
const sessionId = '00000000-0000-4000-8000-000000000011';


test('a lane the watcher has not seen yet is not_seen_yet, and a state file an older version wrote as unknown reads the same', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lane watch legacy ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'control'));
  const old = { version: 1, updatedAt: T0, state: 'unknown', since: null, pid: null, source: null, watcherPid: 1, startedAt: T0, lastSeq: 0, pollMs: 5000, idleMs: 8000, lastResult: null, error: null };
  await writeJson(path.join(root, 'control', WATCH_FILES.state), old);
  assert.equal((await readWatchState(root)).state, 'not_seen_yet');
  assert.equal(createWatchMachine({ idleMs: 8000 }).phase, 'new');
});

// A lane root with a control folder, a project folder for result files and a fake clock.
async function lane(t, settings = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lane watch ')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state'), cwd = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'control'), { recursive: true }); await fs.mkdir(cwd);
  const clock = { t: T0 }, now = () => clock.t;
  const resolved = validateWatchSettings({ resultFolders: [cwd], ...settings });
  const events = path.join(root, 'control', 'lane-events.jsonl');
  let seq = 0;
  const emit = (event, time = clock.t, pid = 4242) => fs.appendFile(events, JSON.stringify({ version: 1, seq: ++seq, time, pid, sessionId, event }) + '\n');
  const writeFile = async (name, text = 'x', mtime = clock.t) => {
    const file = path.join(cwd, name); await fs.writeFile(file, text); await fs.utimes(file, mtime / 1000, mtime / 1000);
  };
  const log = async () => (await fs.readFile(path.join(root, 'control', WATCH_FILES.log), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const make = (extra = {}) => createLaneWatch({ root, sessionId, settings: resolved, now, ompLogFolder: path.join(base, 'no-omp-logs'), ...extra });
  const loaded = { settings: { root, sessionId, cwd } };
  return { base, root, cwd, clock, emit, writeFile, log, make, loaded, settings: resolved };
}
const kinds = rows => rows.map(row => row.split(' ')[2]);

test('log line format: stable fields round-trip; anything else is refused', () => {
  const line = formatWatchLine({ time: T0, seq: 41, kind: 'IDLE', fields: { pid: 4242, since: new Date(T0 - 10000).toISOString(), src: 'events', skipped: undefined } });
  assert.equal(line, '2027-01-15T08:00:00.000Z 41 IDLE pid=4242 since=2027-01-15T07:59:50.000Z src=events');
  assert.deepEqual(parseWatchLine(line), { time: T0, seq: 41, kind: 'IDLE', fields: { pid: '4242', since: '2027-01-15T07:59:50.000Z', src: 'events' } });
  assert.deepEqual(parseWatchLine('2027-01-15T08:00:00.000Z 1 STOP'), { time: T0, seq: 1, kind: 'STOP', fields: {} });
  for (const bad of ['', 'x', '2027-01-15T08:00:00Z 1 IDLE', '2027-01-15T08:00:00.000Z 0 IDLE', '2027-01-15T08:00:00.000Z 1 NOPE',
    '2027-01-15T08:00:00.000Z 1 IDLE pid', '2027-01-15T08:00:00.000Z 1 IDLE pid=1 pid=2', '2027-01-15T08:00:00.000Z 1 IDLE a=b c', '2027-01-15T08:00:00.000Z 1 IDLE Pid=1',
    '2027-01-15T08:00:00.000Z 1 IDLE ' + 'x=1 '.repeat(200)]) assert.equal(parseWatchLine(bad), null, bad);
  for (const bad of [{ time: T0, seq: 0, kind: 'IDLE' }, { time: T0, seq: 1, kind: 'WAKE' }, { time: T0, seq: 1, kind: 'IDLE', fields: { prefix: 'two words' } },
    { time: T0, seq: 1, kind: 'IDLE', fields: { Prefix: 'x' } }, { time: T0, seq: 1, kind: 'IDLE', fields: { prefix: 'a/b' } }]) assert.throws(() => formatWatchLine(bad), /invalid lane watch line/);
});

test('settings: defaults, bounds, unknown keys; the installer default file is created once and never overwritten', async t => {
  assert.deepEqual(validateWatchSettings(), { ...WATCH_DEFAULTS, resultFiles: ['RESULT.md', 'HASHES.json'], resultFolders: [] });
  assert.equal(validateWatchSettings({ pollMs: 1000 }).pollMs, 1000);
  for (const bad of [null, [], { extra: 1 }, { version: 2 }, { pollMs: 999 }, { pollMs: 60001 }, { pollMs: 5.5 }, { idleMs: 1999 }, { idleMs: 600001 }, { enabled: 'yes' },
    { resultFiles: [] }, { resultFiles: ['../RESULT.md'] }, { resultFiles: ['a', 'A'] }, { resultFiles: ['a', 'b', 'c', 'd', 'e'] },
    { resultFolders: ['relative'] }, { resultFolders: [os.tmpdir() + path.sep + '..' + path.sep + 'x'] }]) assert.throws(() => validateWatchSettings(bad), /invalid lane watch settings/, JSON.stringify(bad));
  const f = await lane(t);
  assert.deepEqual(await readWatchSettings(f.root), validateWatchSettings());
  assert.equal((await ensureWatchSettings(f.root)).created, true);
  const file = path.join(f.root, 'control', WATCH_FILES.settings);
  await fs.writeFile(file, JSON.stringify({ version: 1, pollMs: 3000 }) + '\n');
  assert.equal((await ensureWatchSettings(f.root)).created, false);
  assert.equal((await readWatchSettings(f.root)).pollMs, 3000, 'owner edit survives a repeated install');
  await fs.writeFile(file, '{"pollMs":1}\n');
  await assert.rejects(readWatchSettings(f.root), /invalid lane watch settings/);
});

test('state machine: turn end becomes IDLE only after N quiet seconds, once; a new turn is BUSY once', () => {
  const m = createWatchMachine({ idleMs: 10000 });
  const step = (offset, input = {}) => stepWatchMachine(m, { now: T0 + offset, src: 'events', ...input });
  assert.deepEqual(step(0), [], 'no signal, nothing to report');
  assert.deepEqual(step(0, { signal: { kind: 'busy', time: T0, pid: 7 } }), [], 'first sighting of busy is not a change');
  assert.deepEqual(step(1000, { signal: { kind: 'idle', time: T0 + 1000, pid: 7 } }), [], 'turn ended, still inside the quiet period');
  assert.deepEqual(step(10999, { signal: { kind: 'idle', time: T0 + 1000, pid: 7 } }), []);
  assert.deepEqual(step(11000, { signal: { kind: 'idle', time: T0 + 1000, pid: 7 } }),
    [{ kind: 'IDLE', fields: { pid: 7, since: new Date(T0 + 1000).toISOString(), src: 'events' } }]);
  assert.deepEqual(step(16000, { signal: { kind: 'idle', time: T0 + 1000, pid: 7 } }), [], 'repeat observations never repeat the line');
  assert.deepEqual(step(17000, { signal: { kind: 'busy', time: T0 + 17000, pid: 7 } }), [{ kind: 'BUSY', fields: { pid: 7, src: 'events' } }]);
  assert.deepEqual(step(18000, { signal: { kind: 'busy', time: T0 + 17000, pid: 7 } }), []);
});

test('state machine: a bounce inside the quiet period never reports; a turn missed between polls reports BUSY then IDLE', () => {
  const m = createWatchMachine({ idleMs: 10000 });
  const step = (offset, signal, extra = {}) => stepWatchMachine(m, { now: T0 + offset, src: 'events', signal, ...extra });
  step(0, { kind: 'idle', time: T0, pid: 1 });
  assert.deepEqual(step(5000, { kind: 'busy', time: T0 + 5000, pid: 1 }), [], 'busy before IDLE was ever reported is not news');
  assert.deepEqual(step(6000, { kind: 'idle', time: T0 + 6000, pid: 1 }), []);
  assert.deepEqual(step(15999, { kind: 'idle', time: T0 + 6000, pid: 1 }), [], 'quiet period restarts from the newest turn end');
  assert.equal(step(16000, { kind: 'idle', time: T0 + 6000, pid: 1 })[0].kind, 'IDLE');
  // Whole busy->idle cycle happened between two polls: only the newer idle event is visible.
  const lines = step(35000, { kind: 'idle', time: T0 + 30000, pid: 1 });
  assert.deepEqual(lines.map(line => line.kind), ['BUSY']);
  assert.deepEqual(step(40000, { kind: 'idle', time: T0 + 30000, pid: 1 }).map(line => line.kind), ['IDLE']);
});

test('state machine: result groups are baseline at start, reported once when new or rewritten; process gone is terminal', () => {
  const m = createWatchMachine({ idleMs: 10000 });
  const row = (key, signature, extra = {}) => ({ key, prefix: key, complete: true, settled: true, files: 2, signature, ...extra });
  assert.deepEqual(stepWatchMachine(m, { now: T0, results: [row('old', 'a')] }), [], 'a result that exists at start is not news');
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 1, results: [row('old', 'a')] }), []);
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 2, results: [row('new', 'b', { complete: false })] }), [], 'RESULT without HASHES is not done');
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 3, results: [row('new', 'b', { settled: false })] }), [], 'still being written');
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 4, results: [row('new', 'b')] }), [{ kind: 'RESULT', fields: { prefix: 'new', files: 2 } }]);
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 5, results: [row('new', 'b')] }), []);
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 6, results: [row('new', 'c')] }).map(line => line.kind), ['RESULT'], 'rewritten result');
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 7, results: null }), [], 'a failed scan changes nothing');
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 8, alive: false, goneReason: 'exit', code: 3, pid: 9 }),
    [{ kind: 'GONE', fields: { pid: 9, reason: 'exit', code: 3 } }]);
  assert.deepEqual(stepWatchMachine(m, { now: T0 + 9, signal: { kind: 'busy', time: T0 + 9, pid: 9 }, alive: false }), [], 'GONE is terminal');
});

test('result files: bare and prefixed names group by prefix; incomplete and unrelated names are not results', () => {
  const entry = (name, mtimeMs = 5) => ({ name, size: 1, mtimeMs });
  const groups = groupResultFiles([entry('RESULT.md'), entry('HASHES.json'), entry('FIX12-RESULT.md'), entry('fix12-hashes.json'), entry('POTSWATCH_RESULT.md'),
    entry('README.md'), entry('NOTRESULT.md'), entry('X-RESULT.md.bak')], ['RESULT.md', 'HASHES.json']);
  const by = Object.fromEntries(groups.map(group => [group.key, group]));
  assert.deepEqual(Object.keys(by).sort(), ['0:', '0:fix12', '0:potswatch']);
  assert.equal(by['0:'].complete, true); assert.equal(by['0:'].prefix, '-');
  assert.equal(by['0:fix12'].complete, true); assert.equal(by['0:fix12'].prefix, 'FIX12');
  assert.equal(by['0:potswatch'].complete, false);
  assert.equal(groupResultFiles([entry('RESULT.md')], ['RESULT.md'])[0].complete, true, 'patterns are configurable');
});

test('OMP log fallback: turn end, quiet, then later activity', () => {
  const row = (offset, message, extra = {}) => JSON.stringify({ timestamp: new Date(T0 + offset).toISOString(), message, ...extra });
  const end = row(0, 'agent_end maintenance routing', { route: 'entered', stopReason: 'stop' });
  assert.equal(ompLogSignal(''), null);
  assert.equal(ompLogSignal(row(0, 'something else')), null, 'no turn end seen: cannot tell');
  assert.deepEqual(ompLogSignal([row(-1000, 'work'), end, row(500, 'Usage fetch ok'), row(14000, 'ui.loop-blocked'), 'not json'].join('\n')), { kind: 'idle', time: T0 });
  assert.deepEqual(ompLogSignal([end, row(16000, 'tool call')].join('\n')), { kind: 'busy', time: T0 + 16000 });
  assert.equal(ompLogSignal([row(0, 'agent_end maintenance routing', { route: 'skipped' })].join('\n')), null);
});

test('watcher end to end on synthetic files: START, IDLE, BUSY, RESULT, GONE, STOP and the latest-state file', async t => {
  const f = await lane(t);
  const watch = f.make();
  await watch.start();
  assert.deepEqual(kinds(await f.log()), ['START']);
  await f.emit('busy'); f.clock.t += 5000; await watch.tick();
  await f.emit('idle'); f.clock.t += 5000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START'], 'idle for 5 s of 8 s: nothing yet');
  f.clock.t += 5000; await watch.tick();
  let rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'IDLE']);
  const idle = parseWatchLine(rows[1]);
  assert.equal(idle.fields.pid, '4242'); assert.equal(idle.fields.src, 'events'); assert.equal(idle.fields.since, new Date(T0 + 5000).toISOString());
  assert.equal((await readWatchState(f.root)).state, 'idle');
  await f.emit('busy'); f.clock.t += 5000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'IDLE', 'BUSY']);
  assert.equal((await readWatchState(f.root)).state, 'busy');
  // A result group written by the lane: RESULT first, then HASHES.
  await f.writeFile('FIX1-RESULT.md'); f.clock.t += 5000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'IDLE', 'BUSY'], 'RESULT alone is not complete');
  await f.writeFile('FIX1-HASHES.json'); f.clock.t += 1000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'IDLE', 'BUSY'], 'inside the settle window');
  f.clock.t += 2000; await watch.tick();
  rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'IDLE', 'BUSY', 'RESULT']);
  assert.match(rows[3], /^\S+ 4 RESULT prefix=FIX1 files=2$/);
  assert.equal((await readWatchState(f.root)).lastResult.prefix, 'FIX1');
  watch.setChildPid(4242);
  await watch.stop({ exitCode: 0 });
  rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'IDLE', 'BUSY', 'RESULT', 'GONE', 'STOP']);
  assert.match(rows[4], / GONE pid=4242 reason=exit code=0$/);
  assert.deepEqual(rows.map(row => parseWatchLine(row).seq), [1, 2, 3, 4, 5, 6], 'one contiguous sequence');
  const state = await readWatchState(f.root);
  assert.equal(state.state, 'gone'); assert.equal(state.lastSeq, 6); assert.equal(state.error, null);
  await watch.stop(); // idempotent
  assert.equal((await f.log()).length, 6);
});

test('watcher: events from before this start are ignored, a result present at start is baseline, a result written just before exit is still reported', async t => {
  const f = await lane(t);
  await f.emit('idle', T0 - 60000); await f.writeFile('RESULT.md', 'old', T0 - 60000); await f.writeFile('HASHES.json', 'old', T0 - 60000);
  const watch = f.make();
  await watch.start();
  f.clock.t += 20000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START'], 'stale idle event and stale result are not news');
  await f.writeFile('RESULT.md', 'new'); await f.writeFile('HASHES.json', 'new');
  f.clock.t += 100;
  await watch.stop({ exitCode: 1 }); // exit settles files immediately
  assert.deepEqual(kinds(await f.log()), ['START', 'RESULT', 'GONE', 'STOP']);
});

test('watcher: a read or scan problem is reported once per episode and clears; the machine keeps working', async t => {
  const f = await lane(t);
  let broken = true;
  const watch = f.make({ readEvents: async () => { if (broken) throw new Error('PRIVATE-DETAIL'); return []; } });
  await watch.start(); await watch.tick(); await watch.tick();
  const rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'ERROR']);
  assert.match(rows[1], / ERROR reason=read$/);
  assert.equal(rows.join('\n').includes('PRIVATE'), false);
  assert.equal((await readWatchState(f.root)).error, 'read');
  broken = false; await watch.tick();
  assert.equal((await readWatchState(f.root)).error, null);
  await watch.stop();
});

test('watcher: the log is bounded (two files) and the sequence continues across a restart', async t => {
  const f = await lane(t);
  const dir = path.join(f.root, 'control'), file = path.join(dir, WATCH_FILES.log);
  // Seed a log that is nearly full, as a long-running lane would leave it.
  let seeded = '', n = 0;
  const row = () => formatWatchLine({ time: T0 - 1000000 + n, seq: ++n, kind: 'BUSY', fields: { pid: 1, src: 'events' } }) + '\n';
  for (let line = row(); Buffer.byteLength(seeded) + Buffer.byteLength(line) <= WATCH_LIMITS.logBytes; line = row()) seeded += line;
  n--; // the last row built did not fit and was not written
  await fs.writeFile(file, seeded);
  let watch = f.make(); await watch.start();
  assert.ok((await fs.stat(path.join(dir, WATCH_FILES.log + '.1'))).size > 0, 'the full file rotated to .1');
  assert.ok((await fs.stat(file)).size < 200, 'a fresh file started');
  await watch.stop({ exitCode: 0 });
  for (const name of [WATCH_FILES.log, WATCH_FILES.log + '.1']) assert.ok((await fs.stat(path.join(dir, name))).size <= WATCH_LIMITS.logBytes, name);
  assert.equal((await readWatchState(f.root)).lastSeq, n + 3, 'START, GONE, STOP continue the old sequence');
  watch = f.make(); await watch.start(); await watch.stop();
  assert.equal((await readWatchState(f.root)).lastSeq, n + 6, 'a restart continues it again');
});

test('no stray timer: the poll timer is unref-ed, scheduled only while the lane runs, and cleared at stop', async t => {
  const f = await lane(t);
  const live = new Set(); let scheduled = 0, unrefed = 0;
  const setTimer = (fn, ms) => { const handle = { fn, ms, unref() { unrefed++; } }; live.add(handle); scheduled++; return handle; };
  const clearTimer = handle => live.delete(handle);
  const watch = f.make({ setTimer, clearTimer });
  await watch.start();
  assert.equal(live.size, 1); assert.equal([...live][0].ms, f.settings.pollMs);
  const [handle] = live; live.delete(handle); handle.fn();
  for (let i = 0; i < 100 && live.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(live.size, 1, 'each poll schedules exactly the next one');
  await watch.stop({ exitCode: 0 });
  assert.equal(live.size, 0, 'stop clears the pending timer');
  const after = scheduled; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scheduled, after, 'nothing is scheduled after stop');
  assert.equal(unrefed, scheduled, 'every timer is unref-ed so it can never keep a process alive');
});

test('no stray process or handle: a real process that starts the watcher and forgets to stop it still exits by itself; a stopped one exits at once', async t => {
  const f = await lane(t);
  const module = path.resolve(import.meta.dirname, '..', 'src', 'lane-watch.mjs');
  const script = `import { startLaneWatch } from ${JSON.stringify(new URL('file:///' + module.replaceAll('\\', '/')).href)};
    const watch = await startLaneWatch({ root: process.argv[1], sessionId: process.argv[2], cwd: process.argv[3] });
    process.stdout.write(watch.status + '\\n');
    if (process.argv[4] === 'stop') await watch.stop({ exitCode: 0 });`;
  // A 60 s poll: if the timer could keep the process alive, the child would run into the 50 s kill below (a busy PC can take 25 s just to start node).
  await fs.writeFile(path.join(f.root, 'control', WATCH_FILES.settings), JSON.stringify({ version: 1, pollMs: 60000 }) + '\n');
  for (const mode of ['forget', 'stop']) {
    const result = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script, f.root, sessionId, f.cwd, mode],
      { timeout: 50000, windowsHide: true }, (error, stdout) => error ? reject(new Error(`${mode}: process did not exit by itself`)) : resolve(stdout)));
    assert.equal(result.trim(), 'running');
  }
  // The unstopped one was killed by exit, not by the test: the log shows START twice and a single STOP.
  assert.deepEqual(kinds(await f.log()), ['START', 'START', 'GONE', 'STOP']);
  // A control folder that does not exist: reported as failed, never thrown, nothing left running.
  const bad = await startLaneWatch({ root: path.join(f.base, 'missing'), sessionId, cwd: f.cwd });
  assert.equal(bad.status, 'failed'); await bad.stop({ exitCode: 0 });
});

test('startLaneWatch: disabled and invalid settings never start a watcher and never throw', async t => {
  const f = await lane(t);
  const file = path.join(f.root, 'control', WATCH_FILES.settings);
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: false }) + '\n');
  const off = await startLaneWatch({ root: f.root, sessionId, cwd: f.cwd });
  assert.equal(off.status, 'disabled'); await off.stop();
  await fs.writeFile(file, '{"version":1,"pollMs":"fast"}\n');
  const bad = await startLaneWatch({ root: f.root, sessionId, cwd: f.cwd });
  assert.equal(bad.status, 'invalid'); await bad.stop();
  await assert.rejects(fs.stat(path.join(f.root, 'control', WATCH_FILES.log)), { code: 'ENOENT' });
});

// Real clock, smallest allowed settings: measures the actual notice delay. It can never be earlier than the quiet time; the exact
// "quiet + one poll" upper bound is proved with a simulated clock in the next test, so a busy PC only gets generous slack here.
test('measured detection delay on synthetic data (real timers, poll 1 s, quiet 2 s)', async t => {
  const f = await lane(t, { pollMs: 1000, idleMs: 2000 });
  const watch = f.make({ now: Date.now });
  await watch.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  const wroteAt = Date.now();
  await fs.appendFile(path.join(f.root, 'control', 'lane-events.jsonl'), JSON.stringify({ version: 1, seq: 1, time: wroteAt, pid: 1, sessionId, event: 'idle' }) + '\n');
  let seenAt;
  while (!seenAt && Date.now() - wroteAt < 60000) {
    if ((await f.log()).some(row => row.includes(' IDLE '))) seenAt = Date.now();
    else await new Promise(resolve => setTimeout(resolve, 20));
  }
  await watch.stop();
  assert.ok(seenAt, 'IDLE was logged');
  const delay = seenAt - wroteAt;
  t.diagnostic(`idle notice delay ${delay} ms at poll 1000 ms / quiet 2000 ms`);
  assert.ok(delay >= 2000 && delay <= 3300 + 10000, `delay ${delay} ms is at least the quiet time and not seconds late`);
});

test('simulated default settings (poll 5 s, quiet 8 s): notice delay is always between quiet and quiet + one poll', async t => {
  const delays = [];
  for (const offset of [0, 1, 2001, 4999]) { // 2001 ms is the worst phase: the event lands just too early for the tick that would be 8 s later
    const f = await lane(t);
    const watch = f.make(); await watch.start();
    const eventAt = T0 + offset; await f.emit('idle', eventAt);
    let ticks = 0;
    while (!(await f.log()).some(row => row.includes(' IDLE ')) && ticks < 10) { f.clock.t = T0 + 5000 * ++ticks; await watch.tick(); }
    delays.push(f.clock.t - eventAt);
    await watch.stop();
  }
  t.diagnostic(`simulated delays ms: ${delays.join(', ')}`);
  for (const delay of delays) assert.ok(delay >= WATCH_DEFAULTS.idleMs && delay <= WATCH_DEFAULTS.idleMs + WATCH_DEFAULTS.pollMs, `${delay}`);
});

test('coordinator reader: prints each new line once, hides START/STOP, peek does not consume, nothing new prints nothing', async t => {
  const f = await lane(t);
  const watch = f.make(); await watch.start();
  assert.deepEqual((await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { alive: () => true })).lines, [], 'START alone is silent');
  await f.emit('idle'); f.clock.t += 10000; await watch.tick();
  const peek = await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { peek: true, alive: () => true });
  assert.equal(peek.lines.length, 1); assert.match(peek.lines[0], /^alpha \S+ 2 IDLE pid=4242 since=\S+ src=events$/);
  const first = await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { alive: () => true });
  assert.deepEqual(first.lines, peek.lines, 'peek left the cursor alone');
  assert.deepEqual((await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { alive: () => true })).lines, [], 'consumed');
  await watch.stop({ exitCode: 0 });
  const rest = await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }]);
  assert.deepEqual(rest.lines.map(line => line.split(' ')[3]), ['GONE'], 'STOP is hidden');
  // A deleted log restarts the sequence: the stale cursor must not hide new lines forever.
  await fs.rm(path.join(f.root, 'control', WATCH_FILES.log));
  const again = f.make(); await again.start(); await f.emit('idle', f.clock.t + 1); f.clock.t += 20000; await again.tick();
  assert.deepEqual((await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { alive: () => true })).lines.map(line => line.split(' ')[3]), ['IDLE']);
  await again.stop();
});

test('coordinator reader: several lanes merge by time; a watcher that died without a trace gets exactly one GONE reason=lost', async t => {
  const a = await lane(t), b = await lane(t);
  const wa = a.make({ watcherPid: 111 }), wb = b.make({ watcherPid: 222 });
  await wa.start(); await wb.start();
  await a.emit('idle'); await b.emit('idle', T0 + 500);
  a.clock.t += 11000; b.clock.t += 11000; await wa.tick(); await wb.tick();
  const rows = [{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }];
  const alive = pid => pid === 222; // alpha's wrapper was killed
  const out = await readNewWatchLines(rows, { alive, now: () => T0 + 30000 });
  assert.deepEqual(out.lines.map(line => `${line.split(' ')[0]} ${line.split(' ')[3]}`), ['alpha IDLE', 'bravo IDLE', 'alpha GONE']);
  assert.match(out.lines.find(line => line.includes('GONE')), /^alpha \S+ 3 GONE pid=4242 reason=lost$/);
  assert.equal((await readWatchState(a.root)).state, 'gone');
  assert.deepEqual((await readNewWatchLines(rows, { alive, now: () => T0 + 60000 })).lines, [], 'reported once only');
  assert.deepEqual((await readWatchStates(rows)).map(row => [row.connection, row.state]), [['alpha', 'gone'], ['bravo', 'idle']]);
  await wb.stop();
});

test('coordinator reader: a lane whose log cannot be read is named, and the other lanes are still shown', async t => {
  const a = await lane(t), b = await lane(t);
  const wa = a.make({ watcherPid: 111 }), wb = b.make({ watcherPid: 222 });
  await wa.start(); await wb.start();
  await a.emit('idle'); await b.emit('idle', T0 + 500);
  a.clock.t += 11000; b.clock.t += 11000; await wa.tick(); await wb.tick();
  const logFile = path.join(a.root, 'control', WATCH_FILES.log);
  await fs.rm(logFile); await fs.mkdir(logFile);
  const out = await readNewWatchLines([{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }], { alive: () => true });
  assert.deepEqual([out.unreadable, out.unsaved], [['alpha'], []]);
  assert.ok(out.lines.length > 0 && out.lines.every(line => line.startsWith('bravo ')), out.lines.join('\n'));
  await wb.stop();
});

test('coordinator reader: a cursor that cannot be saved holds back only that lane, and no line is skipped or shown twice', async t => {
  const a = await lane(t), b = await lane(t);
  const wa = a.make({ watcherPid: 111 }), wb = b.make({ watcherPid: 222 });
  await wa.start(); await wb.start();
  await a.emit('idle'); await b.emit('idle', T0 + 500);
  a.clock.t += 11000; b.clock.t += 11000; await wa.tick(); await wb.tick();
  const rows = [{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }], rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === path.join(b.root, 'control', WATCH_FILES.cursor)) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let first;
  try { first = await readNewWatchLines(rows, { alive: () => true }); } finally { fs.rename = rename; }
  assert.deepEqual([first.unreadable, first.unsaved], [[], ['bravo']]);
  assert.ok(first.lines.length > 0 && first.lines.every(line => line.startsWith('alpha ')), first.lines.join('\n'));
  const second = await readNewWatchLines(rows, { alive: () => true });
  assert.deepEqual([second.unreadable, second.unsaved], [[], []]);
  assert.ok(second.lines.length > 0 && second.lines.every(line => line.startsWith('bravo ')), second.lines.join('\n'));
  await wb.stop();
});

test('coordinator reader: a lane over the line cap whose cursor cannot be saved never keeps "more" on, but is still named', async t => {
  const a = await lane(t), wa = a.make({ watcherPid: 111 });
  await wa.start();
  await a.emit('idle'); a.clock.t += 11000; await wa.tick();
  await a.emit('busy'); a.clock.t += 1000; await wa.tick();
  await a.emit('idle'); a.clock.t += 11000; await wa.tick();
  const rows = [{ name: 'alpha', loaded: a.loaded }], rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === path.join(a.root, 'control', WATCH_FILES.cursor)) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let out;
  try { out = await readNewWatchLines(rows, { alive: () => true, max: 1 }); } finally { fs.rename = rename; }
  assert.deepEqual([out.lines, out.more, out.unsaved], [[], false, ['alpha']]);
  const next = await readNewWatchLines(rows, { alive: () => true, max: 1 });
  assert.equal(next.more, true, 'once the cursor can be saved, calling again does bring the rest');
  await wa.stop();
});

test('coordinator reader: a lane whose cursor cannot be saved takes no room in the line cap, so the other lanes are still shown', async t => {
  const a = await lane(t), b = await lane(t), wa = a.make({ watcherPid: 111 }), wb = b.make({ watcherPid: 222 });
  await wa.start(); await wb.start();
  for (const [lane, watch, time] of [[a, wa, T0], [b, wb, T0 + 500]]) {
    await lane.emit('idle', lane.clock.t); lane.clock.t += 11000; await watch.tick();
    await lane.emit('busy', lane.clock.t); lane.clock.t += 1000; await watch.tick();
  }
  const rows = [{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }], rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === path.join(a.root, 'control', WATCH_FILES.cursor)) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let out;
  try { out = await readNewWatchLines(rows, { alive: () => true, max: 1 }); } finally { fs.rename = rename; }
  assert.deepEqual([out.unsaved, out.lines.length, out.lines.every(line => line.startsWith('bravo '))], [['alpha'], 1, true]);
  assert.equal(out.more, true, 'bravo has more lines to fetch');
  await wa.stop(); await wb.stop();
});

test('coordinator reader: a cursor saved in one pass and not saved in the next loses no line and shows none twice', async t => {
  const a = await lane(t), b = await lane(t), wa = a.make({ watcherPid: 111 }), wb = b.make({ watcherPid: 222 });
  await wa.start(); await wb.start();
  for (let i = 0; i < 3; i++) for (const [lane, watch] of [[a, wa], [b, wb]]) {
    await lane.emit('idle', lane.clock.t); lane.clock.t += 11000; await watch.tick();
    await lane.emit('busy', lane.clock.t); lane.clock.t += 1000; await watch.tick();
  }
  const rows = [{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }];
  const expected = (await readNewWatchLines(rows, { peek: true, alive: () => true, max: 1000 })).lines;
  assert.ok(expected.length > 4, 'the lanes have enough lines to cross the cap');
  const cursorOf = lane => path.join(lane.root, 'control', WATCH_FILES.cursor), rename = fs.rename; let alphaWrites = 0;
  // bravo can never save, so a second pass runs; there alpha's second save fails after its first one worked.
  fs.rename = async (from, to) => {
    if (String(to) === cursorOf(b)) throw Object.assign(new Error('disk'), { code: 'EIO' });
    if (String(to) === cursorOf(a) && ++alphaWrites > 1) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return rename.call(fs, from, to);
  };
  const seen = [];
  try { const out = await readNewWatchLines(rows, { alive: () => true, max: 3 }); seen.push(...out.lines); assert.ok(out.unsaved.includes('alpha'), 'alpha was held in the second pass'); } finally { fs.rename = rename; }
  for (let calls = 0; calls < 20; calls++) { const out = await readNewWatchLines(rows, { alive: () => true, max: 3 }); seen.push(...out.lines); if (!out.more && !out.unsaved.length) break; }
  assert.deepEqual([...seen].sort(), [...expected].sort(), 'every line came exactly once');
  await wa.stop(); await wb.stop();
});

test('coordinator reader: two readers meeting a dead watcher at once write one GONE line, and a peek writes nothing', async t => {
  const f = await lane(t), watch = f.make({ watcherPid: 111 });
  await watch.start();
  await f.emit('idle'); f.clock.t += 11000; await watch.tick();
  const rows = [{ name: 'alpha', loaded: f.loaded }], alive = () => false, control = path.join(f.root, 'control');
  const before = { log: await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8'), state: await fs.readFile(path.join(control, WATCH_FILES.state), 'utf8') };
  const peeked = await readNewWatchLines(rows, { peek: true, alive, now: () => T0 + 30000 });
  assert.equal(peeked.lines.filter(line => line.includes(' GONE ')).length, 1, 'a peek still shows the line');
  assert.equal(await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8'), before.log, 'a peek does not write the log');
  assert.equal(await fs.readFile(path.join(control, WATCH_FILES.state), 'utf8'), before.state, 'a peek does not write the state');
  await Promise.all([1, 2, 3].map(() => readNewWatchLines(rows, { alive, now: () => T0 + 30000 })));
  const seqs = (await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8')).split('\n').filter(Boolean).map(line => Number(line.split(' ')[1]));
  assert.equal(new Set(seqs).size, seqs.length, 'no number is used twice');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal((await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8')).split('\n').filter(line => line.includes(' GONE ')).length, 1);
  await assert.rejects(fs.stat(path.join(control, 'lane-watch-gone.lock')), { code: 'ENOENT' });
});

test('coordinator reader: a GONE line that was written but whose state could not be saved is not written a second time', async t => {
  const f = await lane(t), watch = f.make({ watcherPid: 111 });
  await watch.start();
  await f.emit('idle'); f.clock.t += 11000; await watch.tick();
  const rows = [{ name: 'alpha', loaded: f.loaded }], alive = () => false, control = path.join(f.root, 'control'), stateFile = path.join(control, WATCH_FILES.state);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === stateFile) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let failed; try { failed = await readNewWatchLines(rows, { alive, now: () => T0 + 30000 }); } finally { fs.rename = rename; }
  assert.deepEqual(failed.unreadable, ['alpha']);
  const next = await readNewWatchLines(rows, { alive, now: () => T0 + 60000 });
  assert.equal(next.lines.filter(line => line.includes(' GONE ')).length, 1, 'shown once');
  assert.equal((await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8')).split('\n').filter(line => line.includes(' GONE ')).length, 1, 'written once');
  assert.equal((await readWatchState(f.root)).state, 'gone');
});

test('coordinator reader: a lock left behind by a crashed reader does not hide the GONE line, but a fresh lock is never taken from its holder', async t => {
  // A crashed reader's lock is a minute old, or a minute ahead of the clock when the clock was set back.
  for (const shift of [-120000, 120000]) {
    const f = await lane(t), watch = f.make({ watcherPid: 111 });
    await watch.start();
    await f.emit('idle'); f.clock.t += 11000; await watch.tick();
    const rows = [{ name: 'alpha', loaded: f.loaded }], alive = () => false, control = path.join(f.root, 'control'), lockFile = path.join(control, 'lane-watch-gone.lock');
    const logBefore = await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8');
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, up: os.uptime() }));
    const quiet = await readNewWatchLines(rows, { alive, now: () => T0 + 30000 });
    assert.equal(quiet.lines.some(line => line.includes(' GONE ')), false, 'a reader that is still working keeps its lock');
    assert.equal(await fs.readFile(path.join(control, WATCH_FILES.log), 'utf8'), logBefore);
    await fs.stat(lockFile);
    const stale = new Date(Date.now() + shift); await fs.utimes(lockFile, stale, stale);
    const shown = await readNewWatchLines(rows, { alive, now: () => T0 + 30000 });
    assert.equal(shown.lines.filter(line => line.includes(' GONE ')).length, 1, 'the line is written once the stale lock is gone ' + shift);
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
  }
});

test('coordinator reader: at most max lines per call, oldest first; the rest follows on the next call and nothing is skipped', async t => {
  const f = await lane(t);
  const watch = f.make(); await watch.start();
  for (let i = 0; i < 6; i++) { await f.emit(i % 2 ? 'busy' : 'idle', f.clock.t); f.clock.t += 11000; await watch.tick(); }
  const rows = [{ name: 'alpha', loaded: f.loaded }];
  const everything = await readNewWatchLines(rows, { peek: true, alive: () => true, max: 100 });
  assert.ok(everything.lines.length >= 5 && !everything.more);
  const first = await readNewWatchLines(rows, { alive: () => true, max: 2 });
  assert.deepEqual(first.lines, everything.lines.slice(0, 2)); assert.equal(first.more, true);
  const second = await readNewWatchLines(rows, { alive: () => true, max: 2 });
  assert.deepEqual(second.lines, everything.lines.slice(2, 4));
  const rest = await readNewWatchLines(rows, { alive: () => true, max: 100 });
  assert.deepEqual(rest.lines, everything.lines.slice(4)); assert.equal(rest.more, false);
  assert.deepEqual((await readNewWatchLines(rows, { alive: () => true })).lines, []);
  await watch.stop();
});

// ---- CLI -----------------------------------------------------------------------------------
async function cliFixture(t, overrides = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lane watch cli ')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd); await fs.mkdir(path.join(base, 'sessions'));
  const session = path.join(base, 'sessions', 's.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'x' } }) + '\n');
  const state = path.join(base, 'state');
  const executable = path.join(base, 'omp.exe');
  const launches = [];
  const deps = { locate: async () => executable, detect: async () => FIXTURE_HOST, launch: async spec => { launches.push(spec); return 0; }, ...overrides };
  const call = async (args, more = {}) => {
    const out = [], err = [];
    const code = await main(args, { ...deps, stdout: text => out.push(text), stderr: text => err.push(text), ...more });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  assert.equal((await call(['setup', session, state])).code, 0);
  return { base, cwd, state, call, launches };
}

test('bridge start runs the watcher for exactly the life of OMP: lines for result and exit, no timer left, exit code passed through', async t => {
  let f;
  f = await cliFixture(t, { launch: async spec => {
    f.launches.push(spec);
    spec.onSpawn(4321);
    await fs.writeFile(path.join(f.cwd, 'RESULT.md'), 'done'); await fs.writeFile(path.join(f.cwd, 'HASHES.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 150));
    return 9;
  } });
  const run = await f.call(['start', f.state, '--confirm-offline']);
  assert.equal(run.code, 9);
  assert.match(run.err, /Lane watcher on: .*Zero network, zero model calls\./);
  const rows = (await fs.readFile(path.join(f.state, 'control', WATCH_FILES.log), 'utf8')).trim().split('\n');
  assert.deepEqual(kinds(rows), ['START', 'RESULT', 'GONE', 'STOP']);
  assert.match(rows[2], / GONE pid=\d+ reason=exit code=9$/);
  assert.equal(rows.join('\n').includes(f.base), false, 'no private path in the log');
  assert.equal((await readWatchState(f.state)).state, 'gone');
  // The coordinator command prints those lines once, then nothing.
  const first = await f.call(['watch-lines', f.state]);
  assert.deepEqual(first.out.split('\n').map(line => line.split(' ')[3]), ['RESULT', 'GONE']);
  assert.ok(first.out.startsWith('default '));
  assert.deepEqual(await f.call(['watch-lines', f.state]), { code: 0, out: '', err: '' });
  const state = JSON.parse((await f.call(['watch-state', f.state])).out);
  assert.equal(state[0].state, 'gone');
});

test('watch-lines says plainly whether a lane could not be read or could not save its place', async t => {
  const f = await cliFixture(t), log = path.join(f.state, 'control', WATCH_FILES.log), cursor = path.join(f.state, 'control', WATCH_FILES.cursor);
  const row = (kind, seq) => formatWatchLine({ time: T0, seq, kind, fields: kind === 'IDLE' ? { pid: 4242, since: new Date(T0 - 10000).toISOString(), src: 'events' } : { pid: 4242 } });
  await fs.writeFile(log, row('START', 1) + '\n' + row('IDLE', 2) + '\n');
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === cursor) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let unsaved;
  try { unsaved = await f.call(['watch-lines', f.state]); } finally { fs.rename = rename; }
  assert.deepEqual(unsaved, { code: 0, out: 'default could not save its place, so the lines not shown here will come again next time.', err: '' });
  await fs.rm(log); await fs.mkdir(log);
  assert.deepEqual(await f.call(['watch-lines', f.state]), { code: 0, out: 'default could not be read.', err: '' });
});

test('watch-lines prints at most 100 lines, says when more are waiting, and the rest follows on the next call', async t => {
  const f = await cliFixture(t), log = path.join(f.state, 'control', WATCH_FILES.log);
  const row = seq => formatWatchLine({ time: T0, seq, kind: 'IDLE', fields: { pid: 4242, since: new Date(T0 - 10000).toISOString(), src: 'events' } });
  await fs.writeFile(log, Array.from({ length: 101 }, (_, i) => row(i + 1)).join('\n') + '\n');
  const peeked = (await f.call(['watch-lines', f.state, '--peek'])).out.split('\n');
  assert.equal(peeked.length, 101); assert.match(peeked[100], /^Only the first 100 new lines are shown\. Run it without --peek/);
  const first = (await f.call(['watch-lines', f.state])).out.split('\n');
  assert.equal(first.length, 101);
  assert.equal(first[100], 'More lines are waiting. Run this again.');
  assert.equal(first.filter(line => line.startsWith('default ')).length, 100);
  assert.deepEqual(await f.call(['watch-lines', f.state]), { code: 0, out: 'default ' + row(101), err: '' });
});

test('bridge start still launches OMP when the watcher is turned off or its settings are invalid', async t => {
  const f = await cliFixture(t);
  const file = path.join(f.state, 'control', WATCH_FILES.settings);
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: false }) + '\n');
  let run = await f.call(['start', f.state, '--confirm-offline']);
  assert.equal(run.code, 0); assert.match(run.err, /Lane watcher is turned off/);
  await fs.writeFile(file, '{"pollMs":0}\n');
  run = await f.call(['start', f.state, '--confirm-offline']);
  assert.equal(run.code, 0); assert.match(run.err, /Lane watcher off: lane-watch\.json is invalid/);
  run = await f.call(['start', f.state, '--confirm-offline'], { watch: async () => { throw new Error('PRIVATE-DETAIL'); } });
  assert.equal(run.code, 0); assert.equal(run.err.includes('PRIVATE'), false);
  assert.equal(f.launches.length, 3);
  await assert.rejects(fs.stat(path.join(f.state, 'control', WATCH_FILES.log)), { code: 'ENOENT' });
});

test('OMP log fallback: used only while the event feed is silent and labelled src=omplog', async t => {
  const f = await lane(t);
  const logs = path.join(f.base, 'omp-logs'); await fs.mkdir(logs);
  const row = (offset, message, extra = {}) => JSON.stringify({ timestamp: new Date(T0 + offset).toISOString(), message, ...extra });
  await fs.writeFile(path.join(logs, 'omp.2027-01-15.4321.log'), [row(1000, 'work'), row(2000, 'agent_end maintenance routing', { route: 'entered' })].join('\n') + '\n');
  const watch = f.make({ ompLogFolder: logs }); await watch.start(); watch.setChildPid(4321);
  f.clock.t += 20000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START'], 'before the 30 s silence window the fallback is not consulted');
  f.clock.t += 15000; await watch.tick();
  const rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'IDLE']);
  assert.match(rows[1], / IDLE pid=4321 since=\S+ src=omplog$/);
  await watch.stop();
});

// Never skipped: a file symlink needs a privilege some Windows accounts lack, a directory junction does not,
// so the folder-link case always runs and each link is shown to be a link before it is used.
test('a linked OMP log (file symlink or directory junction) is never read', async t => {
  const row = (offset, message, extra = {}) => JSON.stringify({ timestamp: new Date(T0 + offset).toISOString(), message, ...extra });
  const logLines = [row(1000, 'work'), row(2000, 'agent_end maintenance routing', { route: 'entered' })].join('\n') + '\n';
  const created = [];
  const attempt = async (kind) => {
    const g = await lane(t), outside = path.join(g.base, 'outside'); await fs.mkdir(outside);
    const linked = path.join(g.base, 'omp-logs');
    if (kind === 'file symlink') {
      await fs.mkdir(linked);
      await fs.writeFile(path.join(outside, 'outside.log'), logLines);
      try { await fs.symlink(path.join(outside, 'outside.log'), path.join(linked, 'omp.2027-01-15.99.log')); } catch (error) { if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return; throw error; }
      assert.equal((await fs.lstat(path.join(linked, 'omp.2027-01-15.99.log'))).isSymbolicLink(), true);
    } else {
      await fs.writeFile(path.join(outside, 'omp.2027-01-15.99.log'), logLines);
      await fs.symlink(outside, linked, 'junction');
      assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
    }
    created.push(kind);
    const w = g.make({ ompLogFolder: linked }); await w.start(); w.setChildPid(99);
    g.clock.t += 40000; await w.tick();
    assert.deepEqual(kinds(await g.log()), ['START'], `the ${kind} was not read`);
    await w.stop();
  };
  await attempt('file symlink');
  await attempt('directory junction');
  assert.ok(created.includes('directory junction'), 'the folder-link case really ran');
});

test('watch commands reject extra arguments and print usage only', async t => {
  const f = await cliFixture(t);
  for (const args of [['watch-lines', f.state, '--nope'], ['watch-lines', f.state, '--peek', 'x'], ['watch-state', f.state, 'x'], ['watch-lines']]) {
    const result = await f.call(args);
    assert.equal(result.code, 1, args.join(' '));
  }
});

test('no private path, user name or machine name is written into a shipped watcher file', async () => {
  const own = [os.userInfo().username, os.hostname()].filter(value => value && value.length >= 5).map(value => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  for (const name of ['src/lane-watch.mjs', 'src/lane-status.mjs', 'src/autosetup.mjs', 'src/cli.mjs', 'src/mcp.mjs', 'src/uninstall.mjs', 'src/update.mjs', 'manifest.json', 'scripts/install.ps1',
    'README.md', 'CHANGELOG.md', 'docs/lane-watch.md', 'docs/coordinator-wakeups.md', 'docs/operations.md', 'docs/protocol.md', 'docs/desktop.md', 'docs/client-setup.md',
    'docs/adapters.md', 'docs/collaborator-check.md', 'docs/release-quickstart.md', 'docs/windows-setup.md']) {
    const text = await fs.readFile(path.resolve(import.meta.dirname, '..', name), 'utf8');
    assert.equal(/\b[A-Za-z]:\\(Users|Windows|Program Files)|\/home\/|\/Users\//.test(text), false, `${name}: absolute private path`);
    for (const pattern of own) assert.equal(pattern.test(text), false, `${name}: contains the current user or machine name`);
  }
});

test('a queued task that never started is reported once as EXPIRED with its id, and the watcher keeps writing lines after it', async t => {
  const f = await lane(t), watch = f.make(), plan = crypto.randomUUID();
  await watch.start();
  await fs.appendFile(path.join(f.root, 'control', 'lane-events.jsonl'), JSON.stringify({ version: 1, seq: 1, time: f.clock.t, pid: 4242, sessionId, event: 'plan_done', planId: plan, state: 'expired', reason: 'expired_before_submission' }) + '\n');
  f.clock.t += 1000; await watch.tick(); await watch.tick();
  let rows = await f.log();
  assert.deepEqual(kinds(rows), ['START', 'EXPIRED']);
  assert.deepEqual(parseWatchLine(rows[1]).fields, { plan });
  await f.emit('busy'); f.clock.t += 5000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'EXPIRED'], 'no repeat');
  await f.emit('idle'); f.clock.t += 9000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'EXPIRED', 'IDLE'], 'later lines are still written');
});

test('a result group is seen even when the project folder holds more files than the scan limit', async t => {
  const f = await lane(t), watch = f.make();
  await watch.start();
  for (let i = 0; i < WATCH_LIMITS.maxEntries + 50; i++) await fs.writeFile(path.join(f.cwd, `a-file-${String(i).padStart(5, '0')}.txt`), 'x');
  await f.writeFile('zz-RESULT.md'); await f.writeFile('zz-HASHES.json');
  f.clock.t += 1000; await watch.tick(); f.clock.t += 10000; await watch.tick();
  assert.deepEqual(kinds(await f.log()), ['START', 'RESULT']);
  await watch.stop();
});

test('a log rotation while the coordinator is reading never hides lines', async t => {
  const f = await lane(t), directory = path.join(f.root, 'control'), current = path.join(directory, WATCH_FILES.log), backup = current + '.1';
  const line = seq => formatWatchLine({ time: T0 + seq, seq, kind: 'BUSY', fields: { pid: 1, src: 'events' } }) + '\n';
  await fs.writeFile(backup, line(1) + line(2)); await fs.writeFile(current, line(3) + line(4));
  const original = fs.readFile; let rotated = false;
  const spy = mock.method(fs, 'readFile', async (file, ...rest) => {
    const bytes = await original(file, ...rest);
    if (!rotated && String(file).endsWith('.1')) { // the writer rotates right after the older file was read
      rotated = true;
      await fs.rm(backup); await fs.rename(current, backup); await fs.writeFile(current, line(5));
    }
    return bytes;
  });
  let shown;
  try { shown = await readNewWatchLines([{ name: 'alpha', loaded: f.loaded }], { alive: () => true }); } finally { spy.mock.restore(); }
  assert.ok(rotated);
  assert.deepEqual(shown.lines.map(row => row.split(' ')[2]), ['3', '4', '5']);
});

test('coordinator reader: a call never returns more lines than the cap, even when lanes were held after an earlier save', async t => {
  const a = await lane(t), b = await lane(t), c = await lane(t);
  // Lines in time order: A1 B1 A2 B2 A3 C1 C2 C3.
  const put = (lane, rows) => fs.writeFile(path.join(lane.root, 'control', WATCH_FILES.log), rows.map(([n, seq]) => formatWatchLine({ time: T0 + n * 1000, seq, kind: seq % 2 ? 'IDLE' : 'BUSY' }) + '\n').join(''));
  await put(a, [[1, 1], [3, 2], [5, 3]]); await put(b, [[2, 1], [4, 2]]); await put(c, [[6, 1], [7, 2], [8, 3]]);
  const rows = [{ name: 'alpha', loaded: a.loaded }, { name: 'bravo', loaded: b.loaded }, { name: 'charlie', loaded: c.loaded }];
  const expected = (await readNewWatchLines(rows, { peek: true, alive: () => true, max: 100 })).lines;
  assert.equal(expected.length, 8);
  const cursorOf = lane => path.join(lane.root, 'control', WATCH_FILES.cursor), rename = fs.rename; let alphaWrites = 0;
  // bravo never saves; alpha saves once and then fails, so it is held after a pass that already saved its place.
  fs.rename = async (from, to) => {
    if (String(to) === cursorOf(b)) throw Object.assign(new Error('disk'), { code: 'EIO' });
    if (String(to) === cursorOf(a) && ++alphaWrites > 1) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return rename.call(fs, from, to);
  };
  const seen = [];
  try {
    const out = await readNewWatchLines(rows, { alive: () => true, max: 3 });
    assert.ok(out.lines.length <= 3, `${out.lines.length} lines came back for a cap of 3`);
    assert.equal(out.more, true);
    seen.push(...out.lines);
  } finally { fs.rename = rename; }
  for (let calls = 0; calls < 20; calls++) {
    const out = await readNewWatchLines(rows, { alive: () => true, max: 3 });
    assert.ok(out.lines.length <= 3);
    seen.push(...out.lines);
    if (!out.more && !out.unsaved.length) break;
  }
  assert.deepEqual([...seen].sort(), [...expected].sort(), 'every line came exactly once');
});
