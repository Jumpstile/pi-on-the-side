import test from 'node:test';
import { QUEUE_LIMIT_MS } from '../src/control.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main, QUEUE_REFUSED } from '../src/cli.mjs';
import { createCredential, acquireController } from '../src/controller.mjs';
import { Store, readJson } from '../src/control.mjs';
import { locateOmp, loadSetup } from '../src/setup.mjs';
const FIXTURE_HOST = 'omp/1.2.3';

// Drives the CLI module with injected host probe/launcher. Production (bin/)
// always uses the real PATH lookup, `--version` probe and foreground spawn;
// child-process coverage of those lives in cli.test.mjs.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(CHECKOUT, 'extension', 'bridge.ts');
const NOW = 1800000000000;
const sessionId = '00000000-0000-4000-8000-000000000011';
const otherId = '00000000-0000-4000-8000-000000000012';
const NO_OMP = 'OMP executable not found on PATH';
const HOST = 'unrecognized OMP executable or version response';
const INCOMPLETE = 'not a complete bridge setup folder';
const MISMATCH = 'existing bridge setup does not match this session or OMP';
const OUTSIDE = 'state folder must be outside the bridge checkout and session project';
const LOCKED = 'bridge lock present; follow offline recovery before starting';

async function fixture(t, overrides = {}) {
  // Spaces in every user-supplied path: base, project, session folder and state.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge setup ')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project dir'); await fs.mkdir(cwd);
  await fs.mkdir(path.join(base, 'saved sessions'));
  const header = id => JSON.stringify({ type: 'session', version: 3, id, cwd }) + '\n';
  const session = path.join(base, 'saved sessions', 'session one.jsonl');
  await fs.writeFile(session, header(sessionId) + JSON.stringify({ type: 'message', message: { role: 'user', content: 'x' } }) + '\n');
  const other = path.join(base, 'saved sessions', 'session two.jsonl');
  await fs.writeFile(other, header(otherId));
  const state = path.join(base, 'private state');
  const controllerFile = path.join(base, 'controller.json'); await createCredential(controllerFile);
  const executable = path.join(base, 'tools dir', process.platform === 'win32' ? 'omp.exe' : 'omp');
  const probes = [], launches = [];
  const deps = {
    locate: async () => executable,
    detect: async file => { probes.push(file); return FIXTURE_HOST; },
    launch: async spec => { launches.push(spec); return 0; },
    now: () => NOW,
    controllerFile,
    ...overrides,
  };
  const call = async (args, more = {}) => {
    // Each write fixture explicitly acquires before exercising the old behavior.
    if (['queue', 'cancel', 'abort', 'enqueue'].includes(args[0])) {
      try {
        const value = (await loadSetup(state, () => NOW)).settings;
        if (!await exists(path.join(state, `controller-${value.sessionId}.json`))) await acquireController(new Store(value), controllerFile);
      } catch { /* malformed/missing setup is intentionally tested by main */ }
    }
    const out = [], err = [];
    const code = await main(args, { ...deps, stdout: text => out.push(text), stderr: text => err.push(text), ...more });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { base, cwd, session, other, state, executable, probes, launches, call, header };
}
const refused = (result, message) => { assert.notEqual(result.code, 0); assert.equal(result.err.trim(), message); };
async function snapshot(dir) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    rows.push([path.relative(dir, file), entry.isFile() ? crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') : 'dir']);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
const exists = file => fs.lstat(file).then(() => true, () => false);

test('setup and launch preview accept any OMP version without launching work', async t => {
  const f = await fixture(t, { detect: async () => 'omp/18.8.6' });
  const result = await f.call(['setup', f.session, f.state]);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).host, 'omp/18.8.6');
  assert.equal((await f.call(['start', f.state])).code, 0);
  assert.equal(f.launches.length, 0);
});

test('setup derives exact identity and persists default coordinator choices in config', async t => {
  const f = await fixture(t);
  const result = await f.call(['setup', f.session, f.state]);
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  assert.equal(report.created, true);
  assert.equal(report.sessionId, sessionId);
  assert.equal(report.cwd, f.cwd);
  assert.equal(report.host, FIXTURE_HOST);
  assert.match(report.providerAuth, /^not verified/);
  assert.match(report.ownerOnlyPermissions, /^not verified/);
  const configText = await fs.readFile(path.join(f.state, 'config.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(configText)).sort(), ['clients', 'coordinatorWakeups', 'cwd', 'root', 'sessionId']);
  assert.deepEqual(JSON.parse(configText), { sessionId, cwd: f.cwd, root: f.state, coordinatorWakeups: true, clients: 'both' });
  for (const dir of ['plans', 'receipts', 'control']) assert.ok((await fs.lstat(path.join(f.state, dir))).isDirectory());
  assert.deepEqual(f.probes, [f.executable]);
  assert.equal(f.launches.length, 0, 'setup must never launch OMP');
});
test('legacy Muse config fails with a clear supported-client migration message', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
  const file = path.join(f.state, 'config.json');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  value.clients = 'muse';
  await fs.writeFile(file, JSON.stringify(value));
  await assert.rejects(loadSetup(f.state), /Muse is no longer supported; choose Claude, ChatGPT, or both/);
});

test('a temp file Setup itself left in the state folder does not lock the folder; a stranger\'s file still does', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
  const fresh = path.join(f.state, `controller-${sessionId}.json.${crypto.randomUUID()}.tmp`), old = path.join(f.state, `config.json.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(fresh, '{'); await fs.writeFile(old, '{');
  const past = new Date(Date.now() - 10 * 60 * 1000); await fs.utimes(old, past, past);
  assert.equal((await loadSetup(f.state)).settings.sessionId, sessionId);
  assert.equal(await exists(fresh), true, 'a recent one may belong to a write in progress');
  assert.equal(await exists(old), false, 'an old one is removed');
  const stranger = path.join(f.state, 'notes.json.' + crypto.randomUUID() + '.tmp');
  await fs.writeFile(stranger, 'mine');
  await assert.rejects(loadSetup(f.state), new RegExp(INCOMPLETE));
  assert.equal(await exists(stranger), true);
});

test('missing OMP, unsupported OMP host and old Node refuse before creating state', async t => {
  for (const [overrides, message] of [
    [{ locate: async () => null }, NO_OMP],
    [{ detect: async () => null }, HOST],
    [{ detect: async () => 'not-omp/18.8.0' }, HOST],
    [{ detect: async () => { throw new Error('probe failed'); } }, HOST],
    [{ nodeVersion: '20.18.0' }, 'unsupported Node.js; requires 22+'],
  ]) {
    const f = await fixture(t, overrides);
    refused(await f.call(['setup', f.session, f.state]), message);
    assert.equal(await exists(f.state), false, message);
    assert.equal(f.launches.length, 0);
  }
});

test('provider authentication and quota are reported not verified, never asserted', async t => {
  const f = await fixture(t);
  const setup = JSON.parse((await f.call(['setup', f.session, f.state])).out);
  const preview = JSON.parse((await f.call(['start', f.state])).out);
  for (const report of [setup, preview]) {
    assert.equal(report.providerAuth, "not verified; use OMP's normal provider login and quota workflow");
    assert.ok(!/authenticated|auth ok|logged in/i.test(JSON.stringify(report)));
  }
  // The only readiness probe is the version probe of the selected executable.
  assert.deepEqual(f.probes, [f.executable, f.executable]);
});

test('PATH lookup returns only an absolute OMP file and ignores relative entries', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge path ')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'omp.exe' : 'omp';
  const bin = path.join(base, 'bin dir'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, name), ''); await fs.chmod(path.join(bin, name), 0o755);
  await fs.mkdir(path.join(base, 'dir only')); await fs.mkdir(path.join(base, 'dir only', name));
  assert.equal(await locateOmp({ PATH: [path.join(base, 'missing'), path.join(base, 'dir only'), bin].join(path.delimiter) }), path.join(bin, name));
  // path.relative across two drives returns an absolute path, so only test this when both are on the same drive.
  if (path.parse(process.cwd()).root.toLowerCase() === path.parse(bin).root.toLowerCase()) assert.equal(await locateOmp({ PATH: path.relative(process.cwd(), bin) }), null);
  assert.equal(await locateOmp({ PATH: '' }), null);
  assert.equal(await locateOmp({}), null);
});

test('rerunning a matching complete setup is idempotent and changes nothing', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
  assert.equal((await f.call(['queue', f.state, 'Synthetic fixture prompt.'])).code, 3);
  const before = await snapshot(f.state);
  const again = await f.call(['setup', f.session, f.state]);
  assert.equal(again.code, 0, again.err);
  assert.equal(JSON.parse(again.out).created, false);
  assert.deepEqual(await snapshot(f.state), before);
});

test('a different session, OMP executable or adopted folder is refused and preserved', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
  const before = await snapshot(f.state);
  refused(await f.call(['setup', f.other, f.state]), MISMATCH);
  refused(await f.call(['setup', f.session, f.state], { locate: async () => path.join(f.base, 'elsewhere', 'omp.exe') }), 'this session was connected with a different OMP program than the one installed now');
  assert.deepEqual(await snapshot(f.state), before);
  // An existing empty folder or a bare `init` root is never adopted.
  const empty = path.join(f.base, 'empty state'); await fs.mkdir(empty);
  refused(await f.call(['setup', f.session, empty]), INCOMPLETE);
  assert.deepEqual(await fs.readdir(empty), []);
});

test('state inside the checkout or the session project is refused before creation', async t => {
  const f = await fixture(t);
  const inProject = path.join(f.cwd, 'bridge state');
  refused(await f.call(['setup', f.session, inProject]), OUTSIDE);
  assert.equal(await exists(inProject), false);
  const inCheckout = path.join(CHECKOUT, 'state-' + crypto.randomUUID());
  refused(await f.call(['setup', f.session, inCheckout]), OUTSIDE);
  assert.equal(await exists(inCheckout), false);
});

test('malformed, foreign or incomplete metadata is refused everywhere and preserved', async t => {
  const cases = [
    ['malformed launch', async state => fs.writeFile(path.join(state, 'launch.json'), '{"version":1,')],
    ['extra launch key', async state => {
      const file = path.join(state, 'launch.json'); const value = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...value, extra: true }) + '\n');
    }],
    ['relative launch path', async state => {
      const file = path.join(state, 'launch.json'); const value = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...value, executable: 'omp' }) + '\n');
    }],
    ['foreign root', async (state, f) => fs.writeFile(path.join(state, 'config.json'),
      JSON.stringify({ sessionId, cwd: f.cwd, root: path.join(f.base, 'elsewhere') }) + '\n')],
    ['missing launch (interrupted setup)', async state => fs.rm(path.join(state, 'launch.json'))],
    ['missing config', async state => fs.rm(path.join(state, 'config.json'))],
    ['stray foreign temp file', async state => fs.writeFile(path.join(state, 'notes.json.' + crypto.randomUUID() + '.tmp'), '{}')],
    ['missing queue directory', async state => fs.rm(path.join(state, 'receipts'), { recursive: true })],
  ];
  for (const [name, corrupt] of cases) {
    const f = await fixture(t);
    assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
    await corrupt(f.state, f);
    const before = await snapshot(f.state);
    for (const args of [['setup', f.session, f.state], ['start', f.state], ['start', f.state, '--confirm-offline'],
      ['queue', f.state, 'Synthetic fixture prompt.'], ['status', f.state]]) {
      refused(await f.call(args), INCOMPLETE);
    }
    assert.deepEqual(await snapshot(f.state), before, name);
    assert.equal(f.launches.length, 0, name);
  }
});

test('start previews the exact launch and never activates without confirmation', async t => {
  const f = await fixture(t);
  await f.call(['setup', f.session, f.state]);
  const result = await f.call(['start', f.state]);
  assert.equal(result.code, 0, result.err);
  const preview = JSON.parse(result.out);
  assert.equal(preview.started, false);
  assert.equal(preview.foreground, true);
  assert.equal(preview.sessionId, sessionId);
  assert.equal(preview.sessionFile, f.session);
  assert.equal(preview.cwd, f.cwd);
  assert.equal(preview.executable, f.executable);
  assert.equal(preview.extension, EXTENSION);
  assert.deepEqual(preview.args, ['--no-extensions', '--extension', EXTENSION, '--resume', f.session]);
  assert.deepEqual(preview.environment, { OMP_BRIDGE_CONFIG: path.join(f.state, 'config.json') });
  assert.match(preview.offlineOwnership, /--confirm-offline/);
  for (const args of [['start', f.state, '--confirm'], ['start', f.state, '--CONFIRM-OFFLINE'], ['start', f.state, '--confirm-offline', 'x'], ['start']])
    assert.notEqual((await f.call(args)).code, 0);
  assert.equal(f.launches.length, 0);
});

test('confirmed start rechecks target, lock and host, then launches exactly once in the foreground', async t => {
  const f = await fixture(t, { launch: async spec => { f.launches.push(spec); return 7; } });
  await f.call(['setup', f.session, f.state]);
  const result = await f.call(['start', f.state, '--confirm-offline']);
  assert.equal(result.code, 7, 'exit code of the foreground OMP process is returned');
  assert.equal(f.launches.length, 1);
  const [spec] = f.launches;
  assert.equal(spec.executable, f.executable);
  assert.equal(spec.cwd, f.cwd);
  assert.deepEqual(spec.args, ['--no-extensions', '--extension', EXTENSION, '--resume', f.session]);
  assert.equal(spec.env.OMP_BRIDGE_CONFIG, path.join(f.state, 'config.json'));
  for (const key of Object.keys(process.env)) if (key !== 'OMP_BRIDGE_CONFIG') assert.equal(spec.env[key], process.env[key], key);
  assert.equal(f.probes.length, 2, 'host is probed again at start');
});

test('start refuses an existing lock, changed session or unsupported host without launching', async t => {
  const f = await fixture(t);
  await f.call(['setup', f.session, f.state]);
  const lock = path.join(f.state, `supervisor-${sessionId}.lock`);
  await fs.writeFile(lock, '{}'); // A crashed or running supervisor: never stolen.
  refused(await f.call(['start', f.state]), LOCKED);
  refused(await f.call(['start', f.state, '--confirm-offline']), LOCKED);
  assert.equal(await fs.readFile(lock, 'utf8'), '{}');
  // Queue/status still work while a supervisor holds the lock.
  assert.equal((await f.call(['queue', f.state, 'Synthetic fixture prompt.'])).code, 3);
  await fs.rm(lock);

  refused(await f.call(['start', f.state, '--confirm-offline'], { detect: async () => null }), HOST);
  await fs.writeFile(f.session, f.header(otherId));
  refused(await f.call(['start', f.state, '--confirm-offline']), 'transcript identity mismatch');
  assert.equal(f.launches.length, 0);
});

// The host probe can take seconds. Whatever changes during it must be caught by
// a second target and lock validation immediately before launching.
test('confirmed start revalidates session, setup and lock after the host probe, immediately before launch', async t => {
  const cases = [
    ['session header changed', f => fs.writeFile(f.session, f.header(otherId)), 'transcript identity mismatch'],
    ['lock appeared', f => fs.writeFile(path.join(f.state, `supervisor-${sessionId}.lock`), '{}'), LOCKED],
    ['stray entry', f => fs.writeFile(path.join(f.state, 'stray.json'), '{}'), INCOMPLETE],
    ['launch metadata replaced', async f => {
      const file = path.join(f.state, 'launch.json'); const value = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...value, executable: path.join(f.base, 'other', 'omp.exe') }) + '\n');
    }, 'bridge setup changed during start; nothing launched'],
  ];
  for (const [name, mutate, message] of cases) {
    let during = null;
    const f = await fixture(t, { detect: async () => { if (during) await during(); return FIXTURE_HOST; } });
    assert.equal((await f.call(['setup', f.session, f.state])).code, 0);
    during = () => mutate(f);
    refused(await f.call(['start', f.state, '--confirm-offline']), message);
    assert.equal(f.launches.length, 0, name);
  }
});

test('queue creates one fresh finite 24-hour plan; status and cancel use the setup folder; there is no review command', async t => {
  const f = await fixture(t);
  await f.call(['setup', f.session, f.state]);
  const prompt = 'Inspect the synthetic fixture and report findings.';
  const first = await f.call(['queue', f.state, prompt]);
  const second = await f.call(['queue', f.state, prompt]);
  assert.equal(first.code, 3, first.err);
  const id = first.out.trim();
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.notEqual(second.out.trim(), id);
  const plan = JSON.parse(await fs.readFile(path.join(f.state, 'plans', id + '.json'), 'utf8'));
  assert.deepEqual(plan, { version: 1, id, sessionId, expiresAt: NOW + QUEUE_LIMIT_MS, steps: [{ prompt, continueAfterEnd: false }] });

  for (const bad of ['', '   ', 'x'.repeat(6001), 'bad\u0001control']) refused(await f.call(['queue', f.state, bad]), QUEUE_REFUSED['invalid step']);
  assert.notEqual((await f.call(['queue', f.state])).code, 0);
  assert.notEqual((await f.call(['queue', f.state, prompt, 'extra'])).code, 0);

  const status = JSON.parse((await f.call(['status', f.state])).out);
  assert.deepEqual(status.map(row => [row.id, row.state, row.taskSuccess]).sort(),
    [[id, 'queued', 'unverified'], [second.out.trim(), 'queued', 'unverified']].sort());

  const cancel = await f.call(['cancel', f.state, id]);
  assert.equal(cancel.code, 0, cancel.err);
  assert.match(cancel.out, /future bridge steps only/);
  assert.match(cancel.out, /OMP's own controls/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.state, 'control', id + '.json'), 'utf8')),
    { version: 1, id, sessionId, action: 'abort' });
  // A second cancel is already in place and a mistyped id names no task: each says so in plain words.
  const again = await f.call(['cancel', f.state, id]);
  assert.equal(again.code, 0, again.err); assert.match(again.out, /^Cancelling this task was already recorded earlier, so nothing more was needed\. /);
  const none = 'There is no queued task with that id. Next: run pots status <state-folder> to see the ids of the queued tasks, then try again.';
  for (const wrong of [crypto.randomUUID(), id.slice(0, 20), 'abc']) refused(await f.call(['cancel', f.state, wrong]), none);
  // Nothing needs acknowledging any more: a plan that did not complete never blocks, so the review command is gone.
  assert.notEqual((await f.call(['review', f.state, second.out.trim()])).code, 0);
  assert.equal(f.launches.length, 0, 'queue/status/cancel never activate OMP');
});

test('the README daily path runs end to end against a disposable fixture', async t => {
  const f = await fixture(t);
  const readme = await fs.readFile(path.join(CHECKOUT, 'README.md'), 'utf8');
  const lines = readme.split(/\r?\n/).filter(line => /^node bin\/bridge\.mjs (setup|start|queue|status|cancel) /.test(line));
  const commands = lines.map(line => line.match(/"[^"]*"|\S+/g).slice(2).map(token => token.replace(/^"|"$/g, '')));
  assert.deepEqual(commands.map(args => args[0] + (args.includes('--confirm-offline') ? ' --confirm-offline' : '')),
    ['setup', 'start', 'start --confirm-offline', 'queue', 'status', 'cancel']);
  const map = { 'C:\\Private Sessions\\example.jsonl': f.session, 'C:\\Private Bridge\\example-state': f.state };
  let id;
  for (const args of commands) {
    const actual = args.map(token => token === '<plan-id>' ? id : map[token] ?? token);
    const result = await f.call(actual);
    assert.equal(result.code, args[0] === 'queue' ? 3 : 0, `${args[0]}: ${result.err}`);
    if (args[0] === 'queue') id = result.out.trim();
    if (args[0] === 'status') assert.equal(JSON.parse(result.out)[0].state, 'queued');
  }
  assert.equal(f.launches.length, 1, 'only the confirmed start launches');
  assert.ok(await exists(path.join(f.state, 'control', id + '.json')));
  for (const link of [...readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(m => m[1]).filter(link => !/^https?:/.test(link)))
    await fs.access(path.join(CHECKOUT, link));
});

test('a full queue makes room from finished tasks, keeps their receipts, and 128 unfinished tasks refuse with the plain sentence', async t => {
  const f = await fixture(t); await f.call(['setup', f.session, f.state]);
  const store = new Store((await loadSetup(f.state, () => NOW)).settings, () => NOW), made = id => ({ version: 1, id, sessionId, expiresAt: NOW + 60000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
  const ids = [];
  for (let n = 0; n < 128; n++) { ids.push(crypto.randomUUID()); await store.enqueue(made(ids[n])); }
  refused(await f.call(['queue', f.state, 'one more']), QUEUE_REFUSED['queue capacity reached']);
  // A cancelled task ends once OMP reaches it: its receipt then says so, and its plan is no longer needed.
  await store.save({ version: 1, id: ids[0], sessionId, state: 'aborted', reason: 'cancelled_before_submission', nextStep: 0, updatedAt: NOW, outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  const queued = await f.call(['queue', f.state, 'one more']);
  assert.equal(queued.code, 3, queued.err);
  assert.equal(await fs.stat(path.join(f.state, 'plans', ids[0] + '.json')).then(() => 'there', e => e.code), 'ENOENT');
  assert.equal((await store.receipt(ids[0])).state, 'aborted', 'the record of how it ended stays');
  assert.equal((await store.ids()).length, 128);
  await assert.rejects(store.enqueue(made(ids[0])), e => e.code === undefined && e.message === 'plan id already used');
  refused(await f.call(['queue', f.state, 'and another']), QUEUE_REFUSED['queue capacity reached']);
});

test('a leftover temporary file in the plans folder does not take a place in the queue', async t => {
  const f = await fixture(t); await f.call(['setup', f.session, f.state]);
  const store = new Store((await loadSetup(f.state, () => NOW)).settings, () => NOW);
  for (let n = 0; n < 127; n++) await store.enqueue({ version: 1, id: crypto.randomUUID(), sessionId, expiresAt: NOW + 60000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
  await fs.writeFile(path.join(f.state, 'plans', `${crypto.randomUUID()}.json.${crypto.randomUUID()}.tmp`), '');
  const queued = await f.call(['queue', f.state, 'one more']);
  assert.equal(queued.code, 3, queued.err);
  assert.equal((await store.ids()).length, 128);
});

test('pots enqueue says in plain words that a plan id was already used', async t => {
  const f = await fixture(t); await f.call(['setup', f.session, f.state]);
  const store = new Store((await loadSetup(f.state, () => NOW)).settings, () => NOW);
  const config = path.join(f.state, 'config.json'), file = path.join(f.base, 'plan.json');
  const write = async id => fs.writeFile(file, JSON.stringify({ version: 1, id, sessionId, expiresAt: NOW + 60000, steps: [{ prompt: 'x', continueAfterEnd: false }] }));
  const queued = crypto.randomUUID(), ended = crypto.randomUUID();
  await write(queued);
  assert.equal((await f.call(['enqueue', config, file])).code, 3);
  refused(await f.call(['enqueue', config, file]), 'plan id already used');
  // A task that ended and whose plan was retired still has its receipt: the id stays spent.
  await store.save({ version: 1, id: ended, sessionId, state: 'completed', nextStep: 1, updatedAt: NOW, outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  await write(ended);
  refused(await f.call(['enqueue', config, file]), 'plan id already used');
});

test('a task queued for a lane whose session is not running is queued with a warning, exit code 3 and a not-running status', async t => {
  const f = await fixture(t);
  await f.call(['setup', f.session, f.state]);
  const queued = await f.call(['queue', f.state, 'Synthetic fixture prompt.']);
  assert.equal(queued.code, 3, queued.err);
  const id = queued.out.trim(), warning = queued.err.trim();
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.match(warning, /^Warning: this lane's session is not running/);
  const rows = JSON.parse((await f.call(['status', f.state])).out);
  assert.deepEqual(rows.map(row => [row.id, row.state, row.note]), [[id, 'queued', 'queued, session not running']]);
  // A lock whose process is gone is not a running session either.
  await fs.writeFile(path.join(f.state, `supervisor-${sessionId}.lock`), JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, sessionId }));
  assert.equal((await f.call(['queue', f.state, 'Another prompt.'])).code, 3);
});

test('a task queued for a lane whose session is running gets no warning and the usual exit code', async t => {
  const f = await fixture(t);
  await f.call(['setup', f.session, f.state]);
  await fs.writeFile(path.join(f.state, `supervisor-${sessionId}.lock`), JSON.stringify({ version: 1, pid: process.pid, sessionId }));
  const queued = await f.call(['queue', f.state, 'Synthetic fixture prompt.']);
  assert.equal(queued.code, 0, queued.err);
  assert.equal(queued.err, '');
  const rows = JSON.parse((await f.call(['status', f.state])).out);
  assert.deepEqual(rows.map(row => [row.state, row.note]), [['queued', undefined]]);
});
