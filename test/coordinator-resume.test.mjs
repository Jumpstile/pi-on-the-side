import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createResumeWatchdog, runResumeWatchdog, repairLaunchLog, RESUME_LIMITS, validateResumeConfig, cloudResumePrompt,
  sanitizedResumeEnvironment, isElevatedResumeToken, resolveResumeExecutable } from '../src/coordinator-resume.mjs';
import { applyResumeTask } from '../src/coordinator-resume-setup.mjs';
import { coordinatorHeartbeatFresh } from '../src/coordinator-heartbeat.mjs';
import { lanesStatus } from '../src/lane-status.mjs';
import { writeJson } from '../src/control.mjs';

const eventId = value => crypto.createHash('sha256').update(String(value)).digest('hex');
async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-resume-')));
  const root = path.join(base, 'resume'), cwd = path.join(base, 'project'), state = path.join(base, 'lane');
  await fs.mkdir(root); await fs.mkdir(cwd); await fs.mkdir(state); await fs.mkdir(path.join(state, 'control'));
  const configFile = path.join(root, 'config.json'), promptFile = path.join(root, 'resume-prompt.txt');
  const handoffFile = path.join(cwd, 'handoff.txt');
  await fs.writeFile(handoffFile, 'fixture handoff PRIVATE-CONTENT');
  await fs.writeFile(promptFile, 'fixture resume PRIVATE-PROMPT');
  const config = { version: 1, cwd, connectionsFolder: path.join(base, 'connections'), handoffFile,
    promptFile, cliClients: 'both', dryRun: false, ...options };
  await fs.writeFile(configFile, JSON.stringify(config));
  let now = 10000000, lanes = [{ connection: 'alpha', lane: 'fixture-lane', status: 'idle',
    lastPlanState: 'completed', needsAttention: true, eventId: eventId('initial') }];
  const launches = [], rows = [{ name: 'alpha', loaded: { settings: { root: state } } }];
  const deps = { now: () => now, elevated: async () => false, loadConnections: async () => rows,
    status: async () => ({ lanes }), heartbeat: async () => false,
    resolve: async () => ({ executable: path.join(base, 'coordinator.exe'), prefix: [] }),
    launch: async request => { launches.push(request); },
    env: { PATH: 'fixture-path', USERPROFILE: cwd, ANTHROPIC_API_KEY: 'PRIVATE-KEY', OPENAI_API_KEY: 'PRIVATE-KEY', NODE_OPTIONS: '--require malicious.js' } };
  let watchdog;
  const open = async extra => { watchdog = await createResumeWatchdog(configFile, { ...deps, ...extra }); return watchdog; };
  t.after(async () => {
    try { if (watchdog) await watchdog.close(); }
    finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  return { base, root, cwd, state, configFile, config, launches, deps, rows, open,
    advance: ms => { now += ms; }, setLanes: value => { lanes = value; }, now: () => now,
    marker: () => path.join(root, 'control', 'disabled'),
    logs: async () => (await fs.readFile(path.join(root, 'control', 'launches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('resume is opt-in and a quiet/busy lane does not launch', async t => {
  const f = await fixture(t, { cliClients: 'none' });
  const w = await f.open(); assert.equal((await w.tick()).reason, 'unconfigured');
  assert.equal(f.launches.length, 0);
  const q = await fixture(t);
  q.setLanes([{ connection: 'alpha', lane: 'fixture', status: 'busy', needsAttention: false }]);
  assert.equal((await (await q.open()).tick()).reason, 'quiet'); assert.equal(q.launches.length, 0);
});
for (const attention of [
  { status: 'idle', lastPlanState: 'completed' },
  { status: 'idle', lastPlanState: 'failed' },
  { status: 'idle', lastPlanState: 'malformed' },
  { status: 'gone' },
]) test('attention launches one directing client without reviewing/replaying: ' + JSON.stringify(attention), async t => {
  const f = await fixture(t);
  f.setLanes([{ connection: 'alpha', lane: 'fixture', needsAttention: true, eventId: eventId('alpha'), ...attention },
    { connection: 'beta', lane: 'fixture2', needsAttention: true, eventId: eventId('beta'), ...attention }]);
  assert.equal((await (await f.open()).tick()).action, 'launched');
  assert.equal(f.launches.length, 1); assert.deepEqual(f.launches[0].args, ['-p']);
  assert.match(f.launches[0].prompt, /PRIVATE-PROMPT/);
  assert.equal(f.launches[0].env.ANTHROPIC_API_KEY, undefined);
  const log = JSON.stringify(await f.logs());
  for (const secret of ['PRIVATE','handoff.txt','fixture-lane','fixture2']) assert.equal(log.includes(secret), false);
});

test('heartbeat suppresses fresh activity; malformed/future marker fails closed; stale marker permits launch', async t => {
  for (const kind of ['fresh','drift','future','malformed','stale','oversize']) {
    await t.test(kind, async t => {
      const f = await fixture(t), marker = path.join(f.state, 'control', 'coordinator-active.json');
      const content = kind === 'malformed' ? '{}' : kind === 'oversize' ? 'x'.repeat(70000) : JSON.stringify({ version: 1,
        updatedAt: f.now() + (kind === 'future' ? 300001 : kind === 'drift' ? 60000 : kind === 'stale' ? -180001 : 0) });
      await fs.writeFile(marker, content);
      const result = await (await f.open({ heartbeat: coordinatorHeartbeatFresh })).tick();
      assert.equal(result.action, kind === 'stale' ? 'launched' : 'suppressed');
      if (kind === 'drift') assert.equal(result.reason, 'heartbeat', 'a small clock drift is still an active coordinator, not a safety stop');
      assert.equal(f.launches.length, kind === 'stale' ? 1 : 0);
    });
  }
});

test('a cloud reminder only asks for the watchdog\'s cycle file when a watchdog exists to write it', () => {
  const handoffFile = path.join(os.tmpdir(), 'handoff.md'), cycleFile = path.join(os.tmpdir(), 'state.json');
  const withWatchdog = cloudResumePrompt({ client: 'claude', handoffFile, cycleFile });
  assert.ok(withWatchdog.includes(JSON.stringify(cycleFile)) && withWatchdog.includes('superseded or unavailable'));
  const cloudOnly = cloudResumePrompt({ client: 'claude', handoffFile });
  assert.ok(!/state\.json|superseded or unavailable|cycleId/.test(cloudOnly), cloudOnly);
  assert.ok(cloudOnly.includes(JSON.stringify(handoffFile)));
});

test('the reminder tells the coordinator to restore a stopped lane and never to queue a new step on it', () => {
  const prompt = cloudResumePrompt({ client: 'claude', handoffFile: path.join(os.tmpdir(), 'handoff.md') });
  assert.match(prompt, /stopped lane.*pots lane restore <name>.*\/bridge status.*never queue a new step.*never close its window/);
});

test('any active coordinator blocks launching for other attention lanes', async t => {
  const f = await fixture(t); let calls = 0;
  f.rows.push({ name: 'beta', loaded: { settings: { root: path.join(f.base, 'second-lane') } } });
  const w = await f.open({ heartbeat: async () => ++calls === 2 });
  assert.equal((await w.tick()).reason, 'heartbeat'); assert.equal(f.launches.length, 0);
});

test('heartbeat refreshed during launch preparation is rechecked', async t => {
  const f = await fixture(t); let fresh = false;
  const w = await f.open({ heartbeat: async () => fresh, resolve: async () => {
    fresh = true; return { executable: 'unused', prefix: [] };
  } });
  assert.equal((await w.tick()).reason, 'heartbeat'); assert.equal(f.launches.length, 0);
});

test('with Claude Code gone but Codex still there, the watchdog starts Codex instead of failing every poll', async t => {
  const f = await fixture(t), asked = [];
  const w = await f.open({ resolve: async client => { asked.push(client); if (client === 'claude') throw new Error('not found'); return { executable: 'codex.exe', prefix: [] }; } });
  assert.equal((await w.tick()).action, 'launched');
  assert.deepEqual(asked, ['claude', 'chatgpt']);
  assert.equal(f.launches[0].command, 'codex.exe'); assert.deepEqual(f.launches[0].args, ['exec', '-']);
});
test('with none of the configured programs found the watchdog starts nothing and reserves nothing', async t => {
  const f = await fixture(t);
  const w = await f.open({ resolve: async () => { throw new Error('not found'); } });
  const result = await w.tick();
  assert.equal(result.reason, 'safety'); assert.equal(f.launches.length, 0);
  assert.equal(await fs.stat(path.join(f.root, 'control', 'state.json')).then(() => true, () => false), false, 'no wake-up was charged');
});

test('a lock left by a crash or a restart is taken over only with proof; a live or unproven lock is never taken', async t => {
  const f = await fixture(t), lock = path.join(f.root, 'control', 'watchdog.lock'), w = await f.open();
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' }, 'a running watchdog keeps its lock');
  await w.close();
  // Left by a process that is gone (a crash or a kill): the next watchdog takes it over.
  const dead = spawnSync(process.execPath, ['-e', '0']);
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: dead.pid ?? 2147483646 }));
  await (await createResumeWatchdog(f.configFile, f.deps)).close();
  // Left from before this boot, with no owner recorded: also taken over, so a restart never stops the watchdog for good.
  await fs.mkdir(lock); await fs.utimes(lock, new Date(0), new Date(0));
  await (await createResumeWatchdog(f.configFile, f.deps)).close();
  // A recent lock with no owner, or with the owner still alive, is never taken.
  await fs.mkdir(lock);
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' });
  await fs.rm(lock, { recursive: true });
});

test('a lock whose recorded number belongs to a live program again is taken once its log is silent; an owner note that stays empty is cleared', async t => {
  const f = await fixture(t), lock = path.join(f.root, 'control', 'watchdog.lock'), owner = path.join(lock, 'owner.json'), w = await f.open();
  await w.close();
  // Windows hands a dead watchdog's number to another program after a restart: only the silent log can tell.
  await fs.mkdir(lock); await fs.writeFile(owner, JSON.stringify({ pid: process.pid })); await fs.utimes(lock, new Date(0), new Date(0));
  await (await createResumeWatchdog(f.configFile, { ...f.deps, sleep: async () => {} })).close();
  await fs.mkdir(lock); await fs.writeFile(owner, '');
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' }, 'a fresh empty note may still be being written');
  const old = new Date(Date.now() - 10 * 60000); await fs.utimes(lock, old, old);
  await (await createResumeWatchdog(f.configFile, f.deps)).close();
});

// Windows Fast Startup keeps the uptime running through a "shutdown", and a clock set forward makes any lock look older than the boot,
// so only the watchdog's own log can tell a live watchdog from a lock whose number was reused.
test('a lock whose number is alive but whose log went quiet is taken; a live, a just-started or a clock-jumped watchdog is never taken', async t => {
  const f = await fixture(t), control = path.join(f.root, 'control'), lock = path.join(control, 'watchdog.lock'), log = path.join(control, 'launches.jsonl');
  const sleeps = [], deps = { ...f.deps, sleep: async ms => { sleeps.push(ms); } };
  const at = async (file, ms) => { const when = new Date(Date.now() + ms); await fs.utimes(file, when, when); };
  const hour = 3600000, mine = JSON.stringify({ pid: process.pid });
  const stale = async () => { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), mine); await fs.writeFile(log, '\n'); await at(lock, -hour); await at(log, -hour); };
  // The number was reused after a "shutdown"; nothing has written the log for an hour: the next watchdog takes over (after one look one poll later).
  await fs.mkdir(control, { recursive: true }); await stale();
  await (await createResumeWatchdog(f.configFile, deps)).close();
  assert.deepEqual(sleeps, [2 * RESUME_LIMITS.pollMs]);
  // Same after the clock was set back an hour: nothing is written, so lock and log lie in the future and still prove nothing.
  await stale(); await at(lock, hour); await at(log, hour);
  await (await createResumeWatchdog(f.configFile, deps)).close();
  // A watchdog that keeps writing its log is never taken from, however old its lock.
  const live = await f.open(deps); await live.tick(); await at(lock, -hour);
  await assert.rejects(createResumeWatchdog(f.configFile, deps), { code: 'EEXIST' });
  // Clock set forward an hour: lock and log look old, but the running watchdog writes its next row before the second look.
  await at(log, -hour); sleeps.length = 0;
  await assert.rejects(createResumeWatchdog(f.configFile, { ...deps, sleep: async () => { await live.tick(); } }), { code: 'EEXIST' });
  // Clock set back an hour: the lock lies in the future, the log is fresh.
  await at(lock, hour);
  await assert.rejects(createResumeWatchdog(f.configFile, deps), { code: 'EEXIST' });
  assert.deepEqual(sleeps, [], 'a fresh log needs no second look');
  await live.close();
  // A watchdog that has only just started has written no row yet (the log is still the old one, or missing): never taken.
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), mine);
  await assert.rejects(createResumeWatchdog(f.configFile, deps), { code: 'EEXIST' });
  await fs.writeFile(log, '\n'); await at(log, -hour);
  await assert.rejects(createResumeWatchdog(f.configFile, deps), { code: 'EEXIST' });
  await fs.rm(lock, { recursive: true });
});

// Two starts find the same dead lock. One is still waiting for its second look while the other finishes taking the lock: the late one
// must back off, not take or remove the new lock, so only one watchdog runs.
test('two starts that find the same dead lock: one wins, the other backs off and never removes the winner\'s lock', async t => {
  const f = await fixture(t), control = path.join(f.root, 'control'), lock = path.join(control, 'watchdog.lock'), owner = path.join(lock, 'owner.json');
  const litter = async () => (await fs.readdir(control)).filter(name => name.startsWith('watchdog.lock.'));
  const hourAgo = new Date(Date.now() - 3600000);
  // The number was reused and the log is silent, so the second look (one sleep) is needed before the lock is proven dead.
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'launches.jsonl'), '\n'); await fs.utimes(path.join(control, 'launches.jsonl'), hourAgo, hourAgo);
  await fs.mkdir(lock); await fs.writeFile(owner, JSON.stringify({ pid: process.pid })); await fs.utimes(lock, hourAgo, hourAgo);
  let looking, release;
  const isLooking = new Promise(resolve => { looking = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const late = createResumeWatchdog(f.configFile, { ...f.deps, sleep: async () => { looking(); await gate; } }).then(value => ({ value }), error => ({ error }));
  await isLooking;
  const winner = await createResumeWatchdog(f.configFile, { ...f.deps, sleep: async () => {} });
  release();
  const result = await late;
  if (result.value) await result.value.close();
  assert.equal(result.error?.code, 'EEXIST', 'the late start backs off');
  assert.equal((await fs.stat(lock)).isDirectory(), true, 'the winner\'s lock is still there');
  assert.deepEqual(await litter(), [], 'nothing is left beside the lock');
  // The lock is removed only by the watchdog that owns it.
  await fs.writeFile(owner, JSON.stringify({ pid: 1, token: 'someone else' }));
  await winner.close();
  assert.equal((await fs.stat(lock)).isDirectory(), true, 'a lock with another owner note is left alone');
  await fs.rm(lock, { recursive: true });
  // Two starts at once on a lock whose watchdog is gone: exactly one gets it.
  const gone = spawnSync(process.execPath, ['-e', '0']).pid ?? 2147483646;
  await fs.mkdir(lock); await fs.writeFile(owner, JSON.stringify({ pid: gone }));
  const both = await Promise.allSettled([createResumeWatchdog(f.configFile, f.deps), createResumeWatchdog(f.configFile, f.deps)]);
  assert.deepEqual(both.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(both.find(item => item.status === 'rejected').reason.code, 'EEXIST');
  await both.find(item => item.status === 'fulfilled').value.close();
  assert.deepEqual(await litter(), []);
});

// A PC with many lanes: 17 or more finished lanes in one check used to write a log row the watchdog then refused to read, for good.
for (const count of [17, 64]) test(`${count} finished lanes in one check are logged and the watchdog keeps running`, async t => {
  const f = await fixture(t, { dryRun: true });
  f.setLanes(Array.from({ length: count }, (_, i) => ({ connection: 'alpha', lane: 'lane-' + i, needsAttention: true, eventId: eventId('many' + i) })));
  const w = await f.open();
  const first = await w.tick();
  assert.equal(first.action, 'dry-run'); assert.equal(first.laneCount, count);
  f.advance(1000);
  assert.equal((await w.tick()).reason, 'duplicate', 'the next check reads the log again and carries on');
  assert.ok(!(await f.logs()).some(row => row.reason === 'safety'));
});

test('a log an older build poisoned (17 lanes) or filled with impossible rows is repaired by dropping those rows, and a check no longer fails on it', async t => {
  const f = await fixture(t), control = path.join(f.root, 'control'), file = path.join(control, 'launches.jsonl');
  const row = extra => JSON.stringify({ version: 1, time: 5, action: 'reserved', reason: 'launch', client: 'claude', laneCount: 1, ...extra });
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(file, [row(), row({ laneCount: 17 }), row({ laneCount: 65 }), row({ laneCount: -1 }), row({ action: 'bogus' }), 'null', row({ time: 6 })].join('\n') + '\n');
  assert.equal(await repairLaunchLog(control), true);
  assert.deepEqual((await f.logs()).map(item => [item.time, item.laneCount]), [[5, 1], [5, 17], [6, 1]]);
  assert.equal(await repairLaunchLog(control), false, 'a clean log is left alone');
  await fs.writeFile(file, row({ laneCount: 65 }) + '\n');
  const w = await f.open();
  assert.equal((await w.tick()).action, 'launched', 'a bad row is dropped, not a reason to stop');
});

test('single instance lock is exclusive, and a recent lock nobody can vouch for is not stolen', async t => {
  const f = await fixture(t); const w = await f.open();
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' });
  await w.close();
  await fs.mkdir(path.join(f.root, 'control', 'watchdog.lock'));
  await assert.rejects(createResumeWatchdog(f.configFile, f.deps), { code: 'EEXIST' });
  await fs.rmdir(path.join(f.root, 'control', 'watchdog.lock'));
});

test('concurrent ticks serialize; per-lane cooldown and hourly limit survive restart', async t => {
  const f = await fixture(t); let w = await f.open();
  await Promise.all([w.tick(), w.tick(), w.tick()]); assert.equal(f.launches.length, 1);
  await w.close(); f.advance(RESUME_LIMITS.globalCooldownMs);
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('second') }]);
  w = await f.open(); assert.equal((await w.tick()).reason, 'rate-limit');
  f.advance(RESUME_LIMITS.laneCooldownMs); assert.equal((await w.tick()).action, 'launched');
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('third') }]);
  f.advance(RESUME_LIMITS.laneCooldownMs); await w.tick(); assert.equal(f.launches.length, 3);
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('fourth') }]);
  f.advance(RESUME_LIMITS.laneCooldownMs); assert.equal((await w.tick()).reason, 'rate-limit');
  f.advance(RESUME_LIMITS.windowMs); assert.equal((await w.tick()).action, 'launched');
});

test('global rate limit prevents storms even when lane identity changes', async t => {
  const f = await fixture(t), w = await f.open();
  for (let i = 0; i < RESUME_LIMITS.globalPerHour + 1; i++) {
    f.setLanes([{ connection: 'alpha', lane: 'lane-' + i, needsAttention: true, eventId: eventId(i) }]);
    const result = await w.tick();
    assert.equal(result.action, i < RESUME_LIMITS.globalPerHour ? 'launched' : 'suppressed');
    f.advance(RESUME_LIMITS.globalCooldownMs);
  }
  assert.equal(f.launches.length, RESUME_LIMITS.globalPerHour);
});

test('failed launch consumes persistent quota rather than retrying in a storm', async t => {
  const f = await fixture(t); let attempts = 0;
  const w = await f.open({ launch: async () => { attempts++; throw new Error('PRIVATE-ERROR'); } });
  assert.equal((await w.tick()).action, 'failed'); assert.equal((await w.tick()).reason, 'duplicate');
  assert.equal(attempts, 1); assert.equal(JSON.stringify(await f.logs()).includes('PRIVATE'), false);
});

test('persisted malformed or future launch-control state blocks rather than resetting rate limits', async t => {
  const f = await fixture(t), w = await f.open();
  const file = path.join(f.root, 'control', 'state.json');
  for (const state of [{ version: 1, global: [f.now() + 1], lanes: {} }, {}, { version: 1, global: Array(7).fill(f.now()), lanes: {} }]) {
    await fs.writeFile(file, JSON.stringify(state));
    assert.equal((await w.tick()).reason, 'safety');
  }
  assert.equal(f.launches.length, 0);
});

test('disable is respected before launch including a marker created during resolution', async t => {
  const f = await fixture(t);
  const w = await f.open({ resolve: async () => {
    await fs.writeFile(f.marker(), 'disabled'); return { executable: 'unused', prefix: [] };
  } });
  assert.equal((await w.tick()).reason, 'disabled'); assert.equal(f.launches.length, 0);
});

test('elevated and indeterminate token checks block launch', async t => {
  const f = await fixture(t); assert.equal((await (await f.open({ elevated: async () => true })).tick()).reason, 'elevated');
  assert.equal(f.launches.length, 0);
  const env = { SystemRoot: path.parse(f.base).root };
  for (const sid of ['S-1-16-12288', 'S-1-16-16384', '', 'S-1-16-8192 S-1-16-12288']) {
    assert.equal(await isElevatedResumeToken({ platform: 'win32', env, exec: async () => ({ stdout: sid }) }), true);
  }
  assert.equal(await isElevatedResumeToken({ platform: 'win32', env, exec: async () => ({ stdout: 'S-1-16-8192' }) }), false);
  assert.equal(await isElevatedResumeToken({ platform: 'win32', env, exec: async () => { throw Error(); } }), true);
});

test('CLI dry-run overrides live config without resolution, launch or config mutation', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.configFile, 'utf8');
  const result = await runResumeWatchdog(['--config', f.configFile, '--once', '--dry-run'], { ...f.deps,
    elevated: async () => assert.fail('dry-run must not spawn a token probe'),
    resolve: async () => assert.fail('dry-run must not resolve or probe assistants'),
    launch: async () => assert.fail('dry-run must not start child') });
  assert.equal(result.action, 'dry-run'); assert.equal(await fs.readFile(f.configFile, 'utf8'), before);
  assert.equal((await f.logs()).at(-1).action, 'dry-run');
  await assert.rejects(fs.stat(path.join(f.root, 'control', 'watchdog.lock')), { code: 'ENOENT' });
});

test('runtime dry-run logs intent and reserves cooldown without spawning', async t => {
  const f = await fixture(t, { dryRun: true }); const w = await f.open();
  assert.equal((await w.tick()).action, 'dry-run'); assert.equal((await w.tick()).reason, 'duplicate');
  assert.equal(f.launches.length, 0);
});

test('loop exits on disable and releases its lock', async t => {
  const f = await fixture(t, { cliClients: 'none' }); let sleeps = 0;
  await runResumeWatchdog(['--config', f.configFile], { ...f.deps, sleep: async ms => {
    assert.equal(ms, RESUME_LIMITS.pollMs); sleeps++; await fs.writeFile(f.marker(), 'disabled');
  } });
  assert.equal(sleeps, 1);
  await assert.rejects(fs.stat(path.join(f.root, 'control', 'watchdog.lock')), { code: 'ENOENT' });
});

test('log is bounded and contains no task/prompt/handoff/credential contents', async t => {
  const f = await fixture(t); f.setLanes([]); const w = await f.open();
  for (let i = 0; i < 140; i++) await w.tick();
  const records = await f.logs(); assert.equal(records.length, RESUME_LIMITS.logRecords);
  assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
  assert.ok((await fs.stat(path.join(f.root, 'control', 'launches.jsonl'))).size < 65536);
});

test('client launch arguments keep prompt and credentials off command line, without bypass approvals', async t => {
  for (const options of [{ cliClients: 'claude', claudeSession: 'session_123' },
    { cliClients: 'claude', claudeContinue: true }, { cliClients: 'chatgpt' }]) {
    const f = await fixture(t, options); await (await f.open()).tick();
    const args = f.launches[0].args;
    assert.deepEqual(args, options.claudeSession ? ['-p','--resume','session_123'] : options.claudeContinue ? ['-p','--continue'] : ['exec','-']);
    assert.equal(args.join(' ').includes('PRIVATE'), false);
    assert.equal(args.some(x => /bypass|dangerously|approval|yolo/i.test(x)), false);
  }
});

test('environment strips ambient secrets and code-injection hooks while preserving normal home and PATH', () => {
  assert.deepEqual(sanitizedResumeEnvironment({ Path: 'native-path', USERPROFILE: 'home', SYSTEMROOT: 'windows',
    ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
    NODE_OPTIONS: '--require evil', BASH_ENV: 'evil', CODEX_HOME: 'override', CUSTOM_PASSWORD: 'secret' }),
  { Path: 'native-path', USERPROFILE: 'home', SYSTEMROOT: 'windows' });
});

test('safe npm shim resolution uses fixed package entrypoint, never interpolates shim text', async t => {
  const f = await fixture(t), shim = path.join(f.base, 'codex.cmd');
  await fs.writeFile(shim, '@echo malicious & untrusted text %*');
  const pkg = path.join(f.base, 'node_modules', '@openai', 'codex');
  await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
  const script = path.join(pkg, 'bin', 'codex.js'); await fs.writeFile(script, '// fixture only');
  assert.deepEqual(await resolveResumeExecutable('chatgpt', shim, { platform: 'win32' }), { executable: process.execPath, prefix: [script] });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: '../untrusted.js' } }));
  await assert.rejects(resolveResumeExecutable('chatgpt', shim, { platform: 'win32' }));
  const arbitrary = path.join(f.base, 'arbitrary.cmd'); await fs.writeFile(arbitrary, 'arbitrary');
  await assert.rejects(resolveResumeExecutable('chatgpt', arbitrary, { platform: 'win32' }));
  const native = path.join(f.base, 'codex.exe'); await fs.writeFile(native, 'fixture-not-executed');
  assert.deepEqual(await resolveResumeExecutable('chatgpt', native, { platform: 'win32' }), { executable: native, prefix: [] });
});

test('invalid config and mutually exclusive session flags are rejected before acquiring a lock', async t => {
  const f = await fixture(t);
  for (const extra of [{ claudeSession: 'session', claudeContinue: true }, { claudeSession: '--unsafe' },
    { cliClients: 'unknown' }, { handoffFile: 'relative' }, { promptFile: f.config.handoffFile },
    { claudeExecutable: 'claude.cmd' }, { unknown: true }]) {
    assert.throws(() => validateResumeConfig({ ...f.config, ...extra }, f.configFile));
  }
  await assert.rejects(runResumeWatchdog(['--config', f.configFile, '--unknown'], f.deps));
});

test('changing config while watcher runs stops launch rather than adopting new authority', async t => {
  const f = await fixture(t), w = await f.open();
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, cliClients: 'chatgpt' }));
  assert.equal((await w.tick()).reason, 'config-changed'); assert.equal(f.launches.length, 0);
});

test('failed durable pre-launch reservation fails closed without launching', async t => {
  const f = await fixture(t); let writes = 0;
  const w = await f.open({ persistState: async () => { writes++; throw new Error('PRIVATE-DISK-ERROR'); } });
  assert.equal((await w.tick()).reason, 'safety');
  assert.equal(writes, 1); assert.equal(f.launches.length, 0);
  assert.equal((await f.logs()).some(row => row.action === 'launched'), false);
  assert.equal(JSON.stringify(await f.logs()).includes('PRIVATE'), false);
});

test('existing user disable marker is preserved verbatim and prevents resolution or launching', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'control'));
  await fs.writeFile(f.marker(), 'owner supplied disable marker');
  const w = await f.open({ resolve: async () => assert.fail('disabled helper must not resolve a client') });
  assert.equal((await w.tick()).reason, 'disabled'); assert.equal(f.launches.length, 0);
  assert.equal(await fs.readFile(f.marker(), 'utf8'), 'owner supplied disable marker');
});

test('CLI disable creates an exclusive marker without reading config or starting any child', async t => {
  const f = await fixture(t, { cliClients: 'none' });
  await fs.writeFile(f.configFile, 'malformed configuration does not prevent disabling');
  const result = await runResumeWatchdog(['--config', f.configFile, '--disable'], {
    elevated: async () => assert.fail('disable must not probe token'),
    loadConnections: async () => assert.fail('disable must not load lanes'),
    launch: async () => assert.fail('disable must not launch'),
  });
  assert.equal(result.action, 'disabled');
  assert.match(await fs.readFile(f.marker(), 'utf8'), /disabled/);
  const stat = await fs.stat(f.marker());
  await fs.writeFile(f.marker(), 'existing user marker');
  await runResumeWatchdog(['--config', f.configFile, '--disable']);
  assert.equal(await fs.readFile(f.marker(), 'utf8'), 'existing user marker');
  assert.equal((await fs.stat(f.marker())).ino, stat.ino);
  await assert.rejects(fs.stat(path.join(f.root, 'control', 'watchdog.lock')), { code: 'ENOENT' });
});

test('Disable-Resume after a cut-off install keeps wake-ups off through the next install', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-resume-cut-off-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const control = path.join(base, 'coordinator-resume', 'control'), marker = path.join(control, 'disabled');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(marker, '', { flag: 'wx' }); // what an install that was cut off leaves behind
  await runResumeWatchdog(['--config', path.join(base, 'coordinator-resume', 'config.json'), '--disable']);
  assert.match(await fs.readFile(marker, 'utf8'), /disabled/);
  const started = [];
  const tasks = { stop: async () => {}, register: async () => {}, start: async name => started.push(name) };
  const result = await applyResumeTask({ root: base, task: { xml: '<Task/>' }, tasks, pollMs: 1, sleep: async () => {} });
  assert.equal(result.status, 'disabled-by-owner');
  assert.deepEqual(started, [], 'the wake-up task is not started');
  assert.match(await fs.readFile(marker, 'utf8'), /disabled/, 'the owner\'s marker stays');
});

test('Disable-Resume run while an install is registering its task is not undone by that install', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-resume-race-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const marker = path.join(base, 'coordinator-resume', 'control', 'disabled');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, '', { flag: 'wx' }); // empty, so the install treats it as its own
  const started = [];
  const tasks = { stop: async () => {}, start: async name => started.push(name),
    register: async () => { await runResumeWatchdog(['--config', path.join(base, 'coordinator-resume', 'config.json'), '--disable']); } };
  const result = await applyResumeTask({ root: base, task: { xml: '<Task/>' }, tasks, pollMs: 1, sleep: async () => {} });
  assert.equal(result.status, 'disabled-by-owner');
  assert.deepEqual(started, [], 'the wake-up task is not started');
  assert.match(await fs.readFile(marker, 'utf8'), /disabled/, 'the owner\'s marker stays');
});

test('CLI disable does not steal an active watchdog lock and rejects nonplain marker shapes', async t => {
  const f = await fixture(t), w = await f.open();
  await runResumeWatchdog(['--config', f.configFile, '--disable']);
  assert.equal((await fs.stat(path.join(f.root, 'control', 'watchdog.lock'))).isDirectory(), true);
  assert.equal((await w.tick()).reason, 'disabled'); assert.equal(f.launches.length, 0);
  await w.close();
  await fs.unlink(f.marker()); await fs.mkdir(f.marker());
  await assert.rejects(runResumeWatchdog(['--config', f.configFile, '--disable']));
  assert.equal((await fs.stat(f.marker())).isDirectory(), true);
  await assert.rejects(runResumeWatchdog(['--config', f.configFile, '--disable', '--once']));
});

test('final launch barrier catches heartbeat or config changes during durable reservation', async t => {
  for (const change of ['heartbeat','config']) await t.test(change, async t => {
    const f = await fixture(t);
    const w = await f.open({
      heartbeat: coordinatorHeartbeatFresh,
      persistState: async (file, state) => {
        await writeJson(file, state);
        if (change === 'heartbeat') await writeJson(path.join(f.state, 'control', 'coordinator-active.json'),
          { version: 1, updatedAt: f.now() });
        else await writeJson(f.configFile, { ...f.config, cliClients: 'chatgpt' });
      },
    });
    assert.equal((await w.tick()).reason, change === 'heartbeat' ? 'heartbeat' : 'config-changed');
    assert.equal(f.launches.length, 0);
    const state = JSON.parse(await fs.readFile(path.join(f.root, 'control', 'state.json'), 'utf8'));
    assert.equal(state.global.length, 1, 'reserved attempt remains charged after a late safety barrier');
    assert.equal((await f.logs()).some(row => row.action === 'launched'), false);
  });
});

test('poll interval defaults to two seconds and accepts only bounded integer milliseconds', async t => {
  const f = await fixture(t);
  assert.equal(validateResumeConfig(f.config, f.configFile).pollMs, 2000);
  for (const pollMs of [1000, 2000, 15000]) {
    assert.equal(validateResumeConfig({ ...f.config, pollMs }, f.configFile).pollMs, pollMs);
  }
  for (const pollMs of [0, 999, 15001, -1, 1000.5, '2000', null, NaN, Infinity]) {
    assert.throws(() => validateResumeConfig({ ...f.config, pollMs }, f.configFile));
  }
});

test('continuous polling reuses one locked watchdog and follows configured cadence without model detection', async t => {
  for (const pollMs of [1000, 2000, 15000]) await t.test(String(pollMs), async t => {
    const f = await fixture(t, { pollMs }), signal = new AbortController();
    let checks = 0, sleeps = 0, lockInode;
    await runResumeWatchdog(['--config', f.configFile], { ...f.deps, signal: signal.signal,
      status: async () => { checks++; return { lanes: [] }; },
      resolve: async () => assert.fail('quiet detection must not resolve a model'),
      elevated: async () => assert.fail('quiet detection must not probe a child'),
      launch: async () => assert.fail('quiet detection must not launch a model'),
      sleep: async ms => {
        assert.equal(ms, pollMs);
        const stat = await fs.stat(path.join(f.root, 'control', 'watchdog.lock'));
        if (lockInode === undefined) lockInode = stat.ino;
        assert.equal(stat.ino, lockInode);
        f.advance(ms);
        if (++sleeps === 3) signal.abort();
      },
    });
    assert.equal(checks, 3); assert.equal(sleeps, 3);
    await assert.rejects(fs.stat(path.join(f.root, 'control', 'watchdog.lock')), { code: 'ENOENT' });
  });
});

test('unchanged events never relaunch after cooldown, hourly expiration, restart, or another event', async t => {
  const f = await fixture(t); let w = await f.open();
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.laneCooldownMs);
  assert.equal((await w.tick()).reason, 'duplicate');
  await w.close(); f.advance(RESUME_LIMITS.windowMs);
  w = await f.open();
  assert.equal((await w.tick()).reason, 'duplicate');
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('changed') }]);
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.windowMs);
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('initial') }]);
  assert.equal((await w.tick()).reason, 'duplicate');
  assert.equal(f.launches.length, 2);
});

test('identical event hashes on different lanes remain distinct events', async t => {
  const f = await fixture(t), w = await f.open();
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.globalCooldownMs);
  f.setLanes([{ connection: 'alpha', lane: 'another-lane', needsAttention: true, eventId: eventId('initial') }]);
  assert.equal((await w.tick()).action, 'launched');
  assert.equal(f.launches.length, 2);
});

test('missing or malformed actionable identities fail closed before resolution or reservation', async t => {
  const f = await fixture(t), w = await f.open({ resolve: async () => assert.fail('bad identity must not resolve') });
  for (const id of [undefined, null, '', 'event-1', 'a'.repeat(65), 123]) {
    f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: id }]);
    assert.equal((await w.tick()).reason, 'safety');
  }
  assert.equal(f.launches.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'control', 'state.json')), { code: 'ENOENT' });
});

test('global and lane cooldowns retain their exact 120-second and 300-second boundaries', async t => {
  assert.equal(RESUME_LIMITS.globalCooldownMs, 120000);
  assert.equal(RESUME_LIMITS.laneCooldownMs, 300000);
  assert.equal(RESUME_LIMITS.globalPerHour, 6); assert.equal(RESUME_LIMITS.lanePerHour, 3);
  for (const sameLane of [false, true]) await t.test(String(sameLane), async t => {
    const f = await fixture(t), w = await f.open();
    assert.equal((await w.tick()).action, 'launched');
    f.setLanes([{ connection: 'alpha', lane: sameLane ? 'fixture-lane' : 'other',
      needsAttention: true, eventId: eventId('next') }]);
    f.advance((sameLane ? 300000 : 120000) - 1);
    assert.equal((await w.tick()).reason, 'rate-limit');
    f.advance(1);
    assert.equal((await w.tick()).action, 'launched');
  });
});

test('cycle authority is the atomic reservation and increments across failure and restart', async t => {
  const f = await fixture(t); let reserved;
  let w = await f.open({ launch: async request => {
    f.launches.push(request);
    reserved = JSON.parse(await fs.readFile(w.cycleFile, 'utf8'));
    throw new Error('fixture failed launch');
  } });
  assert.equal((await w.tick()).action, 'failed');
  const bound = Number(f.launches[0].prompt.match(/resume cycle cycleId=(\d+)/)?.[1]);
  assert.equal(bound, reserved.cycleId);
  assert.equal(reserved.version, 2);
  assert.equal(reserved.global.length, 1);
  assert.equal(Object.values(reserved.events).flat().length, 1);
  assert.ok(f.launches[0].prompt.includes(JSON.stringify(w.cycleFile)));
  const oldPrompt = f.launches[0].prompt, cycleFile = w.cycleFile;
  await w.close(); f.advance(RESUME_LIMITS.windowMs);
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('next-cycle') }]);
  w = await f.open();
  assert.equal((await w.tick()).action, 'launched');
  const authority = JSON.parse(await fs.readFile(cycleFile, 'utf8'));
  assert.equal(authority.cycleId, 2);
  const originalCycle = Number(oldPrompt.match(/resume cycle cycleId=(\d+)/)?.[1]);
  const currentCycle = Number(f.launches[1].prompt.match(/resume cycle cycleId=(\d+)/)?.[1]);
  assert.equal(originalCycle, 1);
  assert.notEqual(originalCycle, authority.cycleId, 'old wake-up remains bound to its superseded cycle');
  assert.equal(currentCycle, authority.cycleId);
});

test('legacy reservations preserve quota and baseline current attention without replay', async t => {
  const f = await fixture(t), w = await f.open();
  const key = crypto.createHash('sha256').update('alpha\0fixture-lane').digest('hex');
  const file = w.cycleFile;
  await writeJson(file, { version: 1, global: [f.now()], lanes: { [key]: [f.now()] } });
  assert.equal((await w.tick()).reason, 'duplicate');
  const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(migrated.version, 2); assert.equal(migrated.cycleId, 0);
  assert.deepEqual(migrated.global, [f.now()]);
  assert.deepEqual(migrated.lanes[key], [f.now()]);
  assert.deepEqual(migrated.events[key], [eventId('initial')]);
  f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).reason, 'duplicate');
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('after-upgrade') }]);
  assert.equal((await w.tick()).action, 'launched');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).cycleId, 1);
});

test('a full event ledger drops its oldest identities, keeps the new one, and never resets or replays', async t => {
  const f = await fixture(t), w = await f.open();
  const key = crypto.createHash('sha256').update('alpha\0fixture-lane').digest('hex');
  const full = { version: 2, cycleId: 9, global: [], lanes: {},
    events: { [key]: Array.from({ length: RESUME_LIMITS.eventRecords }, (_, i) => eventId(i)) } };
  await writeJson(w.cycleFile, full);
  assert.equal((await w.tick()).action, 'launched', 'a busy install keeps waking its coordinator after 512 events');
  const state = JSON.parse(await fs.readFile(w.cycleFile, 'utf8'));
  assert.equal(state.cycleId, 10);
  assert.equal(state.events[key].length, RESUME_LIMITS.eventRecords);
  assert.ok(state.events[key].includes(eventId('initial')) && !state.events[key].includes(eventId(0)) && state.events[key].includes(eventId(RESUME_LIMITS.eventRecords - 1)));
  assert.equal((await w.tick()).reason, 'duplicate', 'the event that was just handled is not launched again');
  for (const invalid of [
    { ...full, cycleId: Number.MAX_SAFE_INTEGER, events: {} },
    { ...full, cycleId: -1 }, { ...full, cycleId: 1.5 },
    { ...full, events: { [key]: ['bad'] } },
    { ...full, events: { [key]: [eventId('same'), eventId('same')] } },
  ]) {
    await writeJson(w.cycleFile, invalid);
    assert.equal((await w.tick()).reason, 'safety');
  }
  assert.equal(f.launches.length, 1);
});

test('final atomic reservation barriers reject disable, changed authority, and newly elevated token', async t => {
  for (const change of ['disable','authority','elevated']) await t.test(change, async t => {
    const f = await fixture(t); let elevated = false;
    const w = await f.open({
      elevated: async () => elevated,
      persistState: async (file, state) => {
        await writeJson(file, state);
        if (change === 'disable') await fs.writeFile(f.marker(), 'fixture disabled');
        else if (change === 'authority') await writeJson(file, { ...state, cycleId: state.cycleId + 1 });
        else elevated = true;
      },
    });
    const result = await w.tick();
    assert.equal(result.reason, change === 'disable' ? 'disabled' : change === 'authority' ? 'safety' : 'elevated');
    assert.equal(f.launches.length, 0);
    const state = JSON.parse(await fs.readFile(w.cycleFile, 'utf8'));
    assert.equal(state.global.length, 1);
    assert.equal(Object.values(state.events).flat().length, 1);
    assert.equal((await f.logs()).some(row => row.action === 'launched'), false);
  });
});

test('lane event identity survives refreshed diagnostics, idle sampling, and receipt timestamps', async t => {
  const f = await fixture(t), lane = '11111111-1111-4111-8111-111111111111';
  const plan = '22222222-2222-4222-8222-222222222222';
  let receipt = { version: 1, id: plan, sessionId: lane, state: 'completed', updatedAt: f.now() };
  const loaded = { lockFile: path.join(f.state, 'supervisor.lock'), store: {
    config: { root: f.state, sessionId: lane }, ids: async () => [plan], receipt: async () => receipt, reviewed: async () => false,
  } };
  const rows = [{ name: 'alpha', loaded }], control = path.join(f.state, 'control');
  const status = async () => (await lanesStatus(rows)).lanes[0];
  const first = await status();
  assert.equal(first.needsAttention, true); assert.match(first.eventId, /^[a-f0-9]{64}$/);
  for (let seq = 1; seq <= 3; seq++) {
    f.advance(2000); receipt = { ...receipt, updatedAt: f.now() };
    await writeJson(path.join(control, 'dispatch-diagnostic.json'), { version: 1, observedAt: f.now(),
      supervisorClosed: false, supervisorLockHeld: true });
    await fs.writeFile(path.join(control, 'lane-events.jsonl'), JSON.stringify({
      version: 1, seq, time: f.now(), pid: process.pid, sessionId: lane, event: 'idle',
    }) + '\n');
    assert.equal((await status()).eventId, first.eventId);
  }
  const w = await f.open({ status: async () => lanesStatus(rows, { internal: true }) });
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).reason, 'duplicate');
  receipt = { ...receipt, state: 'failed', updatedAt: f.now() };
  const changed = await status();
  assert.notEqual(changed.eventId, first.eventId);
  assert.equal((await w.tick()).action, 'launched');
  receipt = { ...receipt, id: 'malformed' };
  const bad = await status();
  assert.deepEqual(bad.unreadable.map(row => [row.id, row.state]), [[plan, 'unreadable']]);
  assert.equal(bad.needsAttention, true);
  assert.equal(f.launches.length, 2);
});

test('a lane that cannot be read wakes the coordinator again the next time, after it was read normally in between', async t => {
  const f = await fixture(t), lane = '22222222-2222-4222-8222-222222222222';
  const broken = (await lanesStatus([{ name: 'alpha', loaded: { store: { config: { root: f.state, sessionId: lane } } } }], { internal: true })).lanes[0];
  assert.equal(broken.needsAttention, true); assert.match(broken.eventId, /^[a-f0-9]{64}$/);
  const fine = { connection: 'alpha', lane, status: 'idle', needsAttention: false, eventId: null };
  let lanes = [broken];
  const w = await f.open({ status: async () => ({ lanes }) });
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).reason, 'duplicate', 'still unreadable: the coordinator is not woken again for it');
  lanes = [fine]; f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).reason, 'quiet');
  lanes = [broken]; f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).action, 'launched', 'unreadable again after being fine: woken again');
  assert.equal(f.launches.length, 2);
});

test('gone-lane event identity does not follow diagnostic refresh time', async t => {
  const f = await fixture(t), lane = '11111111-1111-4111-8111-111111111111';
  const loaded = { lockFile: path.join(f.state, 'missing-supervisor.lock'), store: {
    config: { root: f.state, sessionId: lane }, ids: async () => [], receipt: async () => null,
  } };
  const control = path.join(f.state, 'control');
  const busy = { version: 1, seq: 1, time: f.now(), pid: process.pid, sessionId: lane, event: 'busy' };
  await fs.writeFile(path.join(control, 'lane-events.jsonl'), JSON.stringify(busy) + '\n');
  const status = async () => (await lanesStatus([{ name: 'alpha', loaded }])).lanes[0];
  const first = await status();
  assert.equal(first.status, 'gone'); assert.match(first.eventId, /^[a-f0-9]{64}$/);
  f.advance(2000);
  await writeJson(path.join(control, 'dispatch-diagnostic.json'), { version: 1, observedAt: f.now(),
    supervisorClosed: true, supervisorLockHeld: false });
  assert.equal((await status()).eventId, first.eventId);
  await fs.writeFile(path.join(control, 'lane-events.jsonl'), JSON.stringify({ ...busy, seq: 2, time: f.now() }) + '\n');
  assert.notEqual((await status()).eventId, first.eventId);
});

test('lane status: a cancelled plan does not make a busy OMP look idle; a killed OMP is reported gone', async t => {
  const f = await fixture(t), lane = '11111111-1111-4111-8111-111111111111', plan = '22222222-2222-4222-8222-222222222222';
  const lockFile = path.join(f.state, 'supervisor.lock'); await fs.writeFile(lockFile, '{}');
  const loaded = { lockFile, store: { config: { root: f.state, sessionId: lane }, ids: async () => [], receipt: async () => null } };
  const control = path.join(f.state, 'control'), time = f.now();
  const row = (seq, event, extra = {}) => JSON.stringify({ version: 1, seq, time: time + seq, pid: process.pid, sessionId: lane, event, ...extra }) + '\n';
  const status = async () => (await lanesStatus([{ name: 'alpha', loaded }])).lanes[0];
  await fs.writeFile(path.join(control, 'lane-events.jsonl'), row(1, 'busy') + row(2, 'plan_done', { planId: plan, state: 'aborted' }));
  assert.equal((await status()).status, 'busy', 'OMP has not reported idle yet');
  await fs.appendFile(path.join(control, 'lane-events.jsonl'), row(3, 'idle'));
  assert.equal((await status()).status, 'idle');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  await fs.writeFile(path.join(control, 'lane-events.jsonl'), JSON.stringify({ version: 1, seq: 1, time, pid: Number(dead), sessionId: lane, event: 'busy' }) + '\n');
  const crashed = await status();
  assert.equal(crashed.status, 'gone'); assert.equal(crashed.needsAttention, true);
});

test('lane status: a malformed end is shown as its own finished state, needs attention, and does not hold the queue', async t => {
  const f = await fixture(t), lane = '11111111-1111-4111-8111-111111111111', plan = '22222222-2222-4222-8222-222222222222', queued = '33333333-3333-4333-8333-333333333333';
  const receipt = { version: 1, id: plan, sessionId: lane, state: 'malformed', reason: 'malformed_end', nextStep: 0, updatedAt: f.now(), outcomes: [], taskSuccess: 'unverified', automaticReplay: false };
  const loaded = { lockFile: path.join(f.state, 'absent.lock'), store: {
    config: { root: f.state, sessionId: lane }, ids: async () => [plan, queued],
    receipt: async id => id === plan ? receipt : null,
  } };
  const time = f.now();
  const row = (seq, event, extra = {}) => JSON.stringify({ version: 1, seq, time: time + seq, pid: process.pid, sessionId: lane, event, ...extra }) + '\n';
  await fs.writeFile(path.join(f.state, 'control', 'lane-events.jsonl'), row(1, 'busy') + row(2, 'plan_done', { planId: plan, state: 'malformed', reason: 'malformed_end' }) + row(3, 'idle'));
  const lane0 = (await lanesStatus([{ name: 'alpha', loaded }])).lanes[0];
  assert.equal(lane0.status, 'idle'); assert.equal(lane0.needsAttention, true);
  assert.equal(lane0.lastPlanState, 'malformed');
  assert.equal(lane0.queuedCount, 1);
  assert.match(lane0.eventId, /^[a-f0-9]{64}$/);
});

test('receipt ordering and diagnostic refresh do not manufacture new events; a plan that did not complete is a new event', async t => {
  const f = await fixture(t), lane = '11111111-1111-4111-8111-111111111111';
  const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const receipts = ids.map(id => ({ version: 1, id, sessionId: lane, state: 'completed', updatedAt: f.now() }));
  const queued = '44444444-4444-4444-8444-444444444444';
  const loaded = { lockFile: path.join(f.state, 'absent.lock'), store: {
    config: { root: f.state, sessionId: lane }, ids: async () => [...ids, queued],
    receipt: async id => receipts.find(row => row.id === id) ?? null,
  } };
  const status = async () => (await lanesStatus([{ name: 'alpha', loaded }])).lanes[0];
  const finished = await status();
  receipts[0].updatedAt++; receipts.reverse();
  assert.equal((await status()).eventId, finished.eventId);
  receipts[1].state = 'failed';
  const failed = await status();
  assert.equal(failed.lastPlanState, 'failed');
  assert.notEqual(failed.eventId, finished.eventId);
  receipts[1].updatedAt += 10000;
  assert.equal((await status()).eventId, failed.eventId);
});

test('one eligible lane does not reserve or authorize another lane inside its cooldown', async t => {
  const f = await fixture(t), w = await f.open();
  assert.equal((await w.tick()).action, 'launched');
  f.advance(RESUME_LIMITS.globalCooldownMs);
  const first = { connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('waiting-next') };
  const second = { connection: 'beta', lane: 'second-lane', needsAttention: true, eventId: eventId('ready') };
  f.setLanes([first, second]);
  assert.equal((await w.tick()).action, 'launched');
  const state = JSON.parse(await fs.readFile(w.cycleFile, 'utf8'));
  assert.equal(Object.values(state.events).flat().includes(first.eventId), false);
  assert.equal(Object.values(state.events).flat().includes(second.eventId), true);
  const allowed = JSON.parse(f.launches[1].prompt.match(/reserved lane events: (\[[^\r\n]+\])/)[1]);
  assert.deepEqual(allowed, [{ connection: second.connection, eventId: second.eventId }], 'the lane identity is never put in the prompt');
  f.advance(RESUME_LIMITS.laneCooldownMs - RESUME_LIMITS.globalCooldownMs);
  assert.equal((await w.tick()).action, 'launched');
  assert.equal(Object.values(JSON.parse(await fs.readFile(w.cycleFile, 'utf8')).events).flat().includes(first.eventId), true);
});

const keyOf = (connection, lane) => crypto.createHash('sha256').update(connection + '\0' + lane).digest('hex');
test('an event that is still finished is never launched again after other lanes filled the ledger', async t => {
  const f = await fixture(t), w = await f.open(), alpha = keyOf('alpha', 'fixture-lane'), beta = keyOf('beta', 'fixture2');
  // alpha's finished event was handled long ago; beta has already used up the whole ledger.
  await writeJson(w.cycleFile, { version: 2, cycleId: 1, global: [], lanes: {},
    events: { [alpha]: [eventId('initial')], [beta]: Array.from({ length: RESUME_LIMITS.eventRecords - 1 }, (_, i) => eventId('old-' + i)) } });
  f.setLanes([{ connection: 'alpha', lane: 'fixture-lane', needsAttention: true, eventId: eventId('initial') },
    { connection: 'beta', lane: 'fixture2', needsAttention: true, eventId: eventId('beta-new') }]);
  assert.equal((await w.tick()).action, 'launched', 'only the new event of beta');
  assert.equal(f.launches.length, 1);
  f.advance(RESUME_LIMITS.windowMs);
  assert.equal((await w.tick()).reason, 'duplicate', 'alpha is not launched a second time');
  assert.equal(f.launches.length, 1);
});

test('more than 64 lane rate records drop the oldest ones and the watchdog keeps launching', async t => {
  const f = await fixture(t), w = await f.open();
  const keys = Array.from({ length: 64 }, (_, i) => eventId('lane-' + i));
  await writeJson(w.cycleFile, { version: 2, cycleId: 1, global: [], events: {},
    lanes: Object.fromEntries(keys.map((key, i) => [key, [f.now() - 1000 - i]])) });
  assert.equal((await w.tick()).action, 'launched', 'a 65th lane key does not stop the watchdog');
  const state = JSON.parse(await fs.readFile(w.cycleFile, 'utf8'));
  assert.equal(Object.keys(state.lanes).length, 64);
  assert.ok(state.lanes[keyOf('alpha', 'fixture-lane')], 'the new charge is kept');
  assert.equal(state.lanes[keys[63]], undefined, 'the oldest charge went');
});

test('a cut-off last line in the launch log is skipped and the log is written whole again; nothing is left half written', async t => {
  const f = await fixture(t), w = await f.open();
  const good = { version: 1, time: f.now() - 5000, action: 'suppressed', reason: 'quiet', laneCount: 0 };
  await fs.mkdir(path.join(f.root, 'control'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'control', 'launches.jsonl'), JSON.stringify(good) + '\n{"version":1,"time":12');
  assert.equal((await w.tick()).action, 'launched', 'a damaged log no longer stops the watchdog');
  const logs = await f.logs();
  assert.deepEqual(logs[0], good); assert.equal(logs.at(-1).action, 'launched');
  assert.deepEqual((await fs.readdir(path.join(f.root, 'control'))).filter(name => name.endsWith('.tmp')), []);
});

test('a quiet check is not ended by a state file that cannot be read right now, while a check that needs the state still fails closed', async t => {
  const f = await fixture(t), w = await f.open(), state = path.join(f.root, 'control', 'state.json');
  await fs.writeFile(state, '{ damaged');
  f.setLanes([{ connection: 'alpha', lane: 'fixture', status: 'busy', needsAttention: false }]);
  assert.equal((await w.tick()).reason, 'quiet');
  f.setLanes([{ connection: 'alpha', lane: 'fixture', status: 'idle', lastPlanState: 'completed', needsAttention: true, eventId: eventId('x') }]);
  assert.equal((await w.tick()).reason, 'safety');
  assert.equal(f.launches.length, 0);
});
