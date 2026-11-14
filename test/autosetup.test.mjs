import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { autoSetup, windowsPermissions, resultMessage, syncSessions } from '../src/autosetup.mjs';
import { loadSetup } from '../src/setup.mjs';
import { main } from '../src/cli.mjs';
import { readJson } from '../src/control.mjs';
import { readConnections } from '../src/connections.mjs';
import { registerInstallation, installationId, resumeTaskMark } from '../src/uninstall.mjs';
import { RELEASE_FILES } from '../src/update.mjs';
import { resumeOptions, installCoordinatorResume, selfTest, resumeHealth } from '../src/coordinator-resume-setup.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function fixture(t, count = 1) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-auto-')));
  t.after(async () => { const relative = path.relative(temp, base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }); });
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const choices = [];
  for (let i = 0; i < count; i++) {
    const cwd = path.join(base, 'project-' + i); await fs.mkdir(cwd);
    const file = path.join(sessions, 'saved-' + i + '.jsonl'), sessionId = crypto.randomUUID();
    await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
    choices.push({ file, cwd, sessionId });
  }
  const root = path.join(base, 'private-setup');
  const protections = [];
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base }, home: base,
    nodeVersion: process.versions.node, nodeExecutable: process.execPath, locate: async () => process.execPath,
    detect: async () => 'omp/18.8.6',
    startCheck: async () => {}, which: async () => null,
    permissions: { protect: async (p, dir) => protections.push({ p, dir }), verify: async () => {}, verifyTree: async () => {} },
    // Tests never touch the real Task Scheduler and never run the real self-test (a test sets its own fakes).
    tasks: undefined, selfTest: undefined };
  return { base, root, agent, sessions, choices, protections, deps, run: options => autoSetup({ root, ...options }, deps) };
}
function fakeTasks() {
  const tasks = new Map(), calls = [];
  return { tasks, calls, query: async name => tasks.get(name) ?? null,
    register: async (name, xml) => { calls.push(['register', name]); tasks.set(name, xml); },
    start: async name => { calls.push(['start', name]); }, stop: async name => { calls.push(['stop', name]); },
    remove: async (name, mark) => { calls.push(['remove', name]); const xml = tasks.get(name); if (xml === undefined) return 'absent'; if (!xml.includes(mark)) return 'foreign'; tasks.delete(name); return 'removed'; } };
}
// The Installed-apps list as a fake, so a run writes the same uninstall record a real install does.
const registration = () => {
  const rows = new Map();
  return (root, options) => registerInstallation(root, { ...options, registry: { read: async id => rows.get(id) ?? null,
    write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) } });
};
async function snapshot(root) {
  const rows = [];
  for (const e of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) { const file = path.join(e.parentPath ?? e.path, e.name); rows.push([path.relative(root, file), crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')]); }
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

test('automatic setup installs a bounded runtime, binds the sole session, and repeats without duplicate state or new credentials', async t => {
  const f = await fixture(t), first = await f.run({ name: 'test' });
  assert.equal(first.started, false); assert.equal(first.credentialCreated, true); assert.equal(first.sessions[0].controller.acquired, true);
  assert.equal(first.ownerOnlyPermissions, 'current Windows user only; verified during setup');
  assert.equal(first.updateChannel, 'published stable and prerelease'); assert.deepEqual(first.mcpArguments, ['mcp']);
  assert.equal(first.cliLauncher, first.mcpLauncher);
  assert.match(first.cliLauncher, /runtime[\\/]current[\\/]bridge\.mjs$/);
  assert.equal(f.protections[0].p, f.root); assert.equal(f.protections[0].dir, true);
  assert.ok(f.protections.some(({ p, dir }) => p === f.root && dir));
  assert.ok(f.protections.some(({ p, dir }) => p === first.credentialFile && !dir));
  assert.ok(f.protections.some(({ p, dir }) => p === path.join(f.root, 'coordinator-instructions') && dir));
  const registry = await readConnections(first.connectionsFolder); assert.equal(registry.connections.length, 1);
  assert.equal(registry.connections[0].binding.sessionId, f.choices[0].sessionId);
  for (const file of RELEASE_FILES) assert.deepEqual(await fs.readFile(path.join(first.runtimeFolder, file)), await fs.readFile(path.resolve(import.meta.dirname, '..', file)));
  const before = await snapshot(f.root), key = await fs.readFile(first.credentialFile);
  const repeat = await f.run({});
  assert.equal(repeat.sessions[0].name, 'test'); assert.equal(repeat.installed, false); assert.equal(repeat.sessions[0].created, false);
  assert.equal(repeat.credentialCreated, false); assert.equal(repeat.sessions[0].controller.alreadyOwned, true);
  assert.deepEqual(await fs.readFile(repeat.credentialFile), key); assert.deepEqual(await snapshot(f.root), before);
  assert.equal(JSON.stringify(first).includes(JSON.parse(key).key), false);
});

test('connecting again after Setup picked a different OMP copy keeps the project on the OMP it is bound to', async t => {
  const f = await fixture(t), first = await f.run({ name: 'test' });
  assert.equal((await f.run({ name: 'test' })).sessions[0].stateFolder, first.sessions[0].stateFolder);
  const privateCopy = path.join(f.base, 'private-omp', 'omp.exe');
  const second = await autoSetup({ root: f.root, name: 'test' }, { ...f.deps, locate: async () => privateCopy });
  assert.equal(second.sessions[0].stateFolder, first.sessions[0].stateFolder);
  assert.equal((await readJson(path.join(first.sessions[0].stateFolder, 'launch.json'))).executable, process.execPath);
});

test('if Windows refuses the Installed-apps entry, Setup puts everything back and running it again works', async t => {
  const f = await fixture(t), rows = new Map(); let blocked = true;
  const registry = { read: async id => rows.get(id) ?? null,
    write: async (id, entry) => { if (blocked) throw new Error('access denied'); rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); } };
  const registerUninstall = (root, options) => registerInstallation(root, { ...options, registry });
  const run = () => autoSetup({ root: f.root, name: 'test' }, { ...f.deps, registerUninstall });
  await assert.rejects(run(), /uninstall registration failed/);
  blocked = false;
  const again = await run();
  assert.ok(again.sessions[0].stateFolder);
  assert.equal(rows.size, 1);
});

test('a refused Installed-apps entry on a later run rolls the coordinator-resume files and the uninstall record back together, so the next run works', async t => {
  const f = await fixture(t), rows = new Map(); let blocked = false;
  const registry = { read: async id => rows.get(id) ?? null,
    write: async (id, entry) => { if (blocked) throw new Error('access denied'); rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); } };
  f.deps.registerUninstall = (root, options) => registerInstallation(root, { ...options, registry });
  const handoffFile = path.join(f.base, 'handoff.txt'), codex = path.join(f.base, 'codex.exe');
  await f.run({ clients: 'chatgpt', coordinatorResume: { cliClients: 'chatgpt', cloudClients: 'chatgpt', handoffFile, codexExecutable: codex, dryRun: true } });
  const record = await fs.readFile(path.join(f.root, 'uninstall-record.json'));
  const change = { clients: 'both', coordinatorResume: { cloudClients: 'claude', handoffFile } };
  blocked = true;
  await assert.rejects(f.run(change), /registration failed/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'uninstall-record.json')), record, 'the record describes the files that were put back');
  blocked = false;
  assert.ok((await f.run(change)).sessions[0].stateFolder);
});
test('client choice and wake-up opt-out persist, generate only selected instructions, and switch cleanly', async t => {
  const f = await fixture(t), registryRows = new Map();
  f.deps.registerUninstall = (root, options) => registerInstallation(root, { ...options, registry: {
    read: async id => registryRows.get(id) ?? null,
    write: async (id, entry) => registryRows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
  } });
  const claude = await f.run({ clients: 'claude', coordinatorWakeups: false });
  assert.equal(claude.clients, 'claude');
  assert.equal(claude.coordinatorWakeups, false);
  assert.equal(claude.coordinatorInstructionFiles.length, 1);
  const configFile = path.join(claude.sessions[0].stateFolder, 'config.json');
  assert.deepEqual(await readJson(configFile).then(value => [value.clients, value.coordinatorWakeups]), ['claude', false]);
  const instructionsInUninstall = async () => Object.keys((await readJson(path.join(f.root, 'uninstall-record.json'))).software)
    .filter(name => name.startsWith('coordinator-instructions/')).sort();
  assert.deepEqual(await instructionsInUninstall(), ['coordinator-instructions/claude-skill.md']);
  const chatgpt = await f.run({ clients: 'chatgpt', coordinatorWakeups: true });
  assert.equal(chatgpt.clients, 'chatgpt');
  assert.equal(chatgpt.coordinatorWakeups, true);
  assert.equal(chatgpt.coordinatorInstructionFiles.length, 1);
  assert.match(chatgpt.coordinatorInstructionFiles[0], /chatgpt-custom-instructions\.txt$/);
  assert.deepEqual(await instructionsInUninstall(), ['coordinator-instructions/chatgpt-custom-instructions.txt']);
  await assert.rejects(fs.stat(path.join(f.root, 'coordinator-instructions', 'claude-skill.md')), { code: 'ENOENT' });
  assert.deepEqual(await readJson(configFile).then(value => [value.clients, value.coordinatorWakeups]), ['chatgpt', true]);
});

test('legacy Muse selection returns a clear unsupported-client message', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ clients: 'muse' }), /Muse is no longer supported; choose Claude, ChatGPT, or both/);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

test('automatic setup registers only after the private setup is complete and keeps an idempotent retry path', async t => {
  const f = await fixture(t), calls = [];
  f.deps.registerUninstall = async (root, options) => {
    assert.equal(root, f.root);
    assert.equal(options.nodeExecutable, process.execPath);
    assert.ok(await fs.readFile(path.join(root, 'local-setup.json')));
    assert.ok(await fs.readFile(path.join(root, 'credentials', 'controller.json')));
    await fs.lstat(path.join(root, 'setup.lock'));
    calls.push(root);
    return { registered: true };
  };
  await f.run({ name: 'owned' });
  assert.deepEqual(calls, [f.root]);
  const second = await f.run({ name: 'owned' });
  assert.equal(second.credentialCreated, false);
  assert.deepEqual(calls, [f.root, f.root]);
  assert.ok(await fs.readFile(path.join(f.root, 'credentials', 'controller.json')));
});

test('failed uninstall registration retains the completed private setup without a stale lock', async t => {
  const f = await fixture(t);
  f.deps.registerUninstall = async () => { throw Error('synthetic registry refusal'); };
  await assert.rejects(f.run({ name: 'registration-fails' }), /synthetic registry refusal/);
  assert.ok(await fs.readFile(path.join(f.root, 'local-setup.json')));
  assert.ok(await fs.readFile(path.join(f.root, 'credentials', 'controller.json')));
  assert.equal(await fs.lstat(path.join(f.root, 'setup.lock')).then(() => true, e => e.code === 'ENOENT'), true);
});

test('every saved session is connected without a question: each gets its own state folder, connection, controller record and launcher', async t => {
  const f = await fixture(t, 2);
  const report = await f.run({});
  assert.equal(report.sessions.length, 2); assert.deepEqual(report.skipped, []);
  const registry = await readConnections(report.connectionsFolder);
  assert.deepEqual(registry.connections.map(row => row.binding.sessionId).sort(), f.choices.map(c => c.sessionId).sort());
  assert.equal(new Set(report.sessions.map(row => row.stateFolder)).size, 2);
  for (const row of report.sessions) {
    assert.ok(await fs.stat(path.join(row.stateFolder, 'controller-' + row.sessionId + '.json')), 'its own controller record');
    assert.ok(await fs.stat(row.launcher), 'its own launcher');
    assert.equal(row.controller.acquired, true);
  }
  assert.equal((await fs.readdir(path.join(f.root, 'sessions'))).length, 2);
  const again = await f.run({}), before = await snapshot(f.root);
  assert.deepEqual(again.sessions.map(row => row.created), [false, false]);
  assert.deepEqual(await snapshot(f.root), before);
});
test('missing sessions, unsupported host/Node/platform and relative paths refuse before installation', async t => {
  const f = await fixture(t, 0);
  await assert.rejects(f.run({}), /no eligible saved OMP sessions/);
  for (const overrides of [{ nodeVersion: '20.0.0' }, { platform: 'linux' }, { detect: async () => 'not-omp/18.8.7' }, { locate: async () => null }])
    await assert.rejects(autoSetup({ root: f.root }, { ...f.deps, ...overrides }));
  await assert.rejects(f.run({ session: 'relative.jsonl' }), /paths must be absolute/);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

test('CLI automatic setup parsing is strict and the one-command default performs setup without launching OMP', async t => {
  const f = await fixture(t), stdout = [], stderr = [];
  const deps = { ...f.deps, stdout: x => stdout.push(x), stderr: x => stderr.push(x), registerUninstall: async () => ({ registered: true }) };
  for (const args of [['setup-auto', '--root'], ['setup-auto', '--root', f.root, '--root', f.root], ['setup-auto', '--force', 'yes']]) {
    assert.equal(await main(args, deps), 1); assert.match(stderr.pop(), /^Setup could not use the settings[^]*\nDetails: invalid automatic setup options$/);
  }
  assert.equal(await main(['setup-auto'], deps), 0, stderr.join(''));
  const report = JSON.parse(stdout.pop()); assert.equal(report.started, false);
  assert.equal(report.connectionsFolder, path.join(f.base, 'OMP Session Bridge Local', 'connections'));
});

test('a foreign root, unsafe containment and conflicting ownership never replace existing records', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ root: path.join(f.choices[0].cwd, 'private') }), /outside the runtime and session project/);
  await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'unrelated.txt'), 'preserve');
  await assert.rejects(f.run({}), /not a managed private setup/); assert.equal(await fs.readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'preserve');
  const report = await f.run({ root: path.join(f.base, 'managed') });
  const owner = path.join(report.sessions[0].stateFolder, 'controller-' + f.choices[0].sessionId + '.json');
  const value = await readJson(owner); value.controller = 'f'.repeat(64); await fs.writeFile(owner, JSON.stringify(value));
  const before = await snapshot(path.join(f.base, 'managed'));
  await assert.rejects(f.run({ root: path.join(f.base, 'managed') }), { message: 'another controller owns this session' });
  assert.deepEqual(await snapshot(path.join(f.base, 'managed')), before);
});

test('existing installer lock, changed runtime and incomplete state require review without replacement or lost state', async t => {
  const f = await fixture(t), report = await f.run({});
  const lock = path.join(f.root, 'setup.lock'); await fs.writeFile(lock, 'synthetic crash');
  await assert.rejects(f.run({}), /Setup \(another pots install\) or the assistant connection is already working on this install.*wait a minute/); assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic crash'); await fs.unlink(lock);
  const runtimeFile = path.join(report.runtimeFolder, 'src/host.mjs'), original = await fs.readFile(runtimeFile);
  await fs.chmod(runtimeFile, 0o600);
  await fs.writeFile(runtimeFile, 'synthetic altered runtime');
  await assert.rejects(f.run({}), /installed copy failed its file check, so nothing was changed/); assert.equal(await fs.readFile(runtimeFile, 'utf8'), 'synthetic altered runtime'); await fs.writeFile(runtimeFile, original);
  await fs.unlink(path.join(report.sessions[0].stateFolder, 'launch.json')); const before = await snapshot(f.root);
  await assert.rejects(f.run({}), { message: 'not a complete bridge setup folder' }); assert.deepEqual(await snapshot(f.root), before);
});

test('a broadened existing private boundary is refused rather than silently tightened or reused', async t => {
  const f = await fixture(t); await f.run({}); const before = await snapshot(f.root);
  f.deps.permissions.verify = async () => { throw Error('private permissions require local review'); };
  await assert.rejects(f.run({}), /private permissions require local review/); assert.deepEqual(await snapshot(f.root), before);
});

test('an open OMP session never stops Setup: a repeat with a live supervisor lock changes nothing', async t => {
  const f = await fixture(t); f.deps.openSessions = async () => 1;
  const report = await f.run({});
  const lock = path.join(report.sessions[0].stateFolder, 'supervisor-' + f.choices[0].sessionId + '.lock');
  await fs.writeFile(lock, JSON.stringify({ version: 1, pid: 1234, startedAt: Date.now(), sessionId: f.choices[0].sessionId }));
  const before = await snapshot(f.root);
  const repeat = await f.run({});
  assert.equal(repeat.sessions[0].created, false); assert.match(repeat.upgrade.message, /already installed/); assert.deepEqual(await snapshot(f.root), before);
});

test('real Windows DACL setup protects only disposable local files, including literal quote/dollar paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); f.deps.permissions = windowsPermissions();
  // Real PowerShell on a PC running the whole suite at once can miss the product's 20 s answer time; that is load, not a permission result, so only a timeout is tried once more.
  const patient = step => step().catch(error => error?.kind === 'timeout' ? step() : Promise.reject(error));
  const root = path.join(f.base, "private ' $() [fixture]"), report = await patient(() => f.run({ root }));
  await patient(() => f.deps.permissions.verify(path.dirname(path.dirname(report.credentialFile))));
  await patient(() => f.deps.permissions.verify(report.credentialFile));
  assert.equal(report.credentialCreated, true);
  const before = await fs.readFile(report.credentialFile); const again = await patient(() => f.run({ root }));
  assert.equal(again.credentialCreated, false); assert.deepEqual(await fs.readFile(again.credentialFile), before);
  // The real check (PowerShell included) does not open or refuse a link named `disabled`, and still refuses any other link.
  const control = path.join(root, 'coordinator-resume', 'control'), outside = path.join(f.base, 'outside');
  await fs.mkdir(control, { recursive: true }); await fs.mkdir(outside);
  let linked = true;
  try { await fs.symlink(outside, path.join(control, 'disabled'), 'junction'); } catch { linked = false; t.diagnostic('links cannot be made here: link check skipped'); }
  if (linked) {
    await patient(() => f.deps.permissions.verifyTree(root));
    await fs.symlink(outside, path.join(root, 'elsewhere'), 'junction');
    await assert.rejects(patient(() => f.deps.permissions.verifyTree(root)), { message: 'private permissions require local review' });
  }
});

test('resume defaults create no resume artifacts when no Claude Code or Codex is found', async t => {
  const f = await fixture(t);
  const result = await f.run({});
  assert.equal(result.coordinatorResume.options.cliClients, 'none');
  assert.equal(result.coordinatorResume.options.cloudClients, 'none');
  assert.deepEqual(result.coordinatorResume.files, []);
  await assert.rejects(fs.stat(path.join(f.root, 'coordinator-resume')), { code: 'ENOENT' });
});

test('resume options reject unselected clients, relative paths and unsafe session arguments before installation', async t => {
  const f = await fixture(t), handoffFile = path.join(f.base, 'handoff.txt');
  for (const value of [
    null, [], { cliClients: 'both', handoffFile }, { cloudClients: 'chatgpt', handoffFile },
    { cliClients: 'claude' }, { cliClients: 'claude', handoffFile: 'relative.txt' },
    { cliClients: 'claude', handoffFile, claudeExecutable: 'claude.exe' },
    { cliClients: 'claude', handoffFile, claudeSession: '--unsafe' },
    { cliClients: 'claude', handoffFile, claudeSession: 'session', claudeContinue: true },
    { cliClients: 'claude', handoffFile, dryRun: 'true' }, { unknown: true },
    ...[999, 15001, 1000.5, '1000', null].map(pollMs => ({ cliClients: 'claude', handoffFile, pollMs })),
  ]) await assert.rejects(f.run({ clients: 'claude', coordinatorResume: value }), /invalid automatic setup options/);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

test('resume generated ownership switches only proven client artifacts and preserves a modified launcher', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root);
  const args = { root: f.root, cwd: f.choices[0].cwd, connectionsFolder: path.join(f.root, 'connections'),
    runtimeFolder: path.join(f.root, 'runtime'), nodeExecutable: process.execPath, permissions: f.deps.permissions, account: 'TEST\\user' };
  const handoffFile = path.join(f.base, 'handoff.txt');
  const recordProof = async result => fs.writeFile(path.join(f.root, 'uninstall-record.json'), JSON.stringify({
    version: 1, type: 'pi-on-the-side-uninstall', root: f.root, id: installationId(f.root),
    software: Object.fromEntries(result.files.map(row => [row.path, row.sha256])),
  }));
  const first = await installCoordinatorResume({ ...args, options: resumeOptions({ cliClients: 'both', cloudClients: 'both', handoffFile, dryRun: true }, 'both') });
  await recordProof(first);
  assert.deepEqual(first.external, []);
  assert.equal(first.task.name, installationId(f.root) + '-Resume');
  assert.ok(first.files.some(row => row.path.endsWith('Run-Resume.vbs')));
  assert.equal(await fs.stat(path.join(f.root, 'coordinator-resume/control/disabled')).catch(() => null), null);
  const config = await readJson(path.join(f.root, 'coordinator-resume/config.json'));
  assert.equal(config.dryRun, true); assert.equal(config.handoffFile, handoffFile);
  assert.equal(config.cwd, f.choices[0].cwd); assert.equal(config.cliClients, 'both');
  assert.ok(first.files.some(row => row.path.endsWith('claude-cloud-task.txt')));
  assert.ok(first.files.some(row => row.path.endsWith('chatgpt-cloud-task.txt')));
  const unknown = path.join(f.root, 'coordinator-resume/owner-note.txt');
  await fs.writeFile(unknown, 'owner note');
  const modified = path.join(f.root, 'coordinator-resume/claude-cloud-task.txt');
  await fs.writeFile(modified, 'owner custom task');
  const launcher = path.join(f.root, 'coordinator-resume/Run-Resume.vbs');
  await fs.writeFile(launcher, 'owner custom launcher');
  const switched = await installCoordinatorResume({ ...args, options: resumeOptions({ cloudClients: 'chatgpt', handoffFile }, 'chatgpt') });
  await recordProof(switched);
  assert.equal(switched.task, null);
  assert.ok(switched.preserved.includes(launcher));
  assert.ok(switched.preserved.includes(modified));
  assert.equal(await fs.readFile(launcher, 'utf8'), 'owner custom launcher');
  assert.equal(await fs.readFile(modified, 'utf8'), 'owner custom task');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'owner note');
  assert.equal((await fs.stat(path.join(f.root, 'coordinator-resume/control/disabled'))).size, 0, 'the pause note is there while the switch is made');
  assert.equal((await readJson(path.join(f.root, 'coordinator-resume/config.json'))).cliClients, 'none');
  await fs.writeFile(path.join(f.root, 'coordinator-resume/resume-prompt.txt'), 'owner prompt');
  assert.equal((await installCoordinatorResume({ ...args, options: resumeOptions({ cloudClients: 'chatgpt', handoffFile }, 'chatgpt') })).leftAsIs, true);
  assert.equal(await fs.readFile(path.join(f.root, 'coordinator-resume/resume-prompt.txt'), 'utf8'), 'owner prompt');
});

test('a wake-up file that cannot be written (disk full) leaves no half-written temp file behind', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root);
  const args = { root: f.root, cwd: f.choices[0].cwd, connectionsFolder: path.join(f.root, 'connections'),
    runtimeFolder: path.join(f.root, 'runtime'), nodeExecutable: process.execPath, permissions: f.deps.permissions, account: 'TEST\\user' };
  const handoffFile = path.join(f.base, 'handoff.txt');
  const first = await installCoordinatorResume({ ...args, options: resumeOptions({ cliClients: 'both', cloudClients: 'both', handoffFile, dryRun: true }, 'both') });
  await fs.writeFile(path.join(f.root, 'uninstall-record.json'), JSON.stringify({ version: 1, type: 'pi-on-the-side-uninstall', root: f.root, id: installationId(f.root),
    software: Object.fromEntries(first.files.map(row => [row.path, row.sha256])) }));
  const real = fs.writeFile;
  fs.writeFile = async (file, ...rest) => { if (String(file).endsWith('.tmp')) { await real(file, 'half'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } return real(file, ...rest); };
  try { await assert.rejects(installCoordinatorResume({ ...args, options: resumeOptions({ cliClients: 'both', cloudClients: 'both', handoffFile }, 'both') }), /disk full/); } finally { fs.writeFile = real; }
  assert.deepEqual((await fs.readdir(path.join(f.root, 'coordinator-resume'))).filter(name => name.endsWith('.tmp')), []);
});

test('setup-auto CLI passes resume configuration through: the scheduled task is made when asked for and removed when resume is switched off', async t => {
  const f = await fixture(t), output = [], fake = fakeTasks(), name = installationId(f.root) + '-Resume';
  f.deps.tasks = fake;
  const registry = new Map();
  f.deps.registerUninstall = (root, options) => registerInstallation(root, { ...options, registry: {
    read: async id => registry.get(id) ?? null,
    write: async (id, entry) => registry.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
  } });
  const handoffFile = path.join(f.base, 'handoff.txt'), codex = path.join(f.base, 'codex.exe');
  const code = await main(['setup-auto', '--root', f.root, '--clients', 'chatgpt', '--resume-cli', 'chatgpt',
    '--resume-cloud', 'chatgpt', '--handoff-file', handoffFile, '--codex-executable', codex, '--resume-dry-run', '--resume-poll-ms', '1000'],
    { ...f.deps, stdout: value => output.push(value), stderr: value => { throw Error(value); } });
  assert.equal(code, 0);
  const result = JSON.parse(output.join(''));
  const config = await readJson(path.join(f.root, 'coordinator-resume/config.json'));
  assert.equal(config.codexExecutable, codex); assert.equal(config.dryRun, true);
  assert.equal(config.pollMs, 1000);
  assert.equal(config.cliClients, 'chatgpt'); assert.deepEqual(result.coordinatorResume.external, []);
  assert.deepEqual([...fake.tasks.keys()], [name]);
  assert.ok(fake.tasks.get(name).includes(path.join(f.root, 'coordinator-resume', 'Run-Resume.vbs')));
  assert.deepEqual(fake.calls.filter(call => call[0] === 'start'), [['start', name]], 'it starts right away, not at the next log-in');
  const record = await readJson(path.join(f.root, 'uninstall-record.json'));
  assert.deepEqual(record.resumeExternal, []);
  assert.ok(record.software['coordinator-resume/ownership.json']); assert.ok(record.software['coordinator-resume/Run-Resume.vbs']);
  const switched = await f.run({ clients: 'both', coordinatorResume: { cloudClients: 'claude', handoffFile } });
  assert.equal(fake.tasks.size, 0, 'switching CLI resume off removes the task');
  await assert.rejects(fs.stat(path.join(f.root, 'coordinator-resume/Run-Resume.vbs')), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.join(f.root, 'coordinator-resume/control/disabled'))).size, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'coordinator-resume/chatgpt-cloud-task.txt')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(f.root, 'coordinator-resume/claude-cloud-task.txt'))).isFile());
  await fs.appendFile(path.join(f.root, 'coordinator-resume/resume-prompt.txt'), ' ');
  assert.equal((await f.run({ clients: 'both', coordinatorResume: { cloudClients: 'claude', handoffFile } })).coordinatorResume.leftAsIs, true);
});

test('known legacy instructions upgrade; user-modified instructions are kept untouched and do not stop the run', async t => {
  const f = await fixture(t);
  const first = await f.run({ clients: 'claude', coordinatorWakeups: false });
  const file = first.coordinatorInstructionFiles[0];
  const legacy = '# Pi on the Side coordinator\n\nCoordinator wake-ups are disabled in Setup.\nDo not schedule or re-arm visible reminders. Call bridge_lanes_status only when the user asks to inspect progress or before taking an explicitly approved next action. Pi on the Side cannot push a message into this chat.\n';
  await fs.writeFile(file, legacy);
  await f.run({ clients: 'claude', coordinatorWakeups: false });
  const upgraded = await fs.readFile(file, 'utf8');
  assert.notEqual(upgraded, legacy);
  assert.match(upgraded, /bridge_coordinator_heartbeat/);
  await fs.appendFile(file, 'Owner instructions: keep this text.\n');
  const modified = await fs.readFile(file);
  await f.run({ clients: 'claude', coordinatorWakeups: false }); // the owner's text never blocks the upgrade
  assert.deepEqual(await fs.readFile(file), modified);
});

test('upgrading with an old Startup resume entry works with resume off, and the unchanged entry is removed', async t => {
  const f = await fixture(t), old = await legacyResumeInstall(f);
  assert.equal((await fs.readdir(old.startup)).length, 1);
  const second = await f.run({ clients: 'both', coordinatorResume: { cliClients: 'none', cloudClients: 'none' } });
  assert.equal((await fs.readdir(old.startup)).length, 0);
  assert.equal(second.coordinatorResume.external.length, 0); assert.equal(second.assistants.items.length > 0, true);
});

async function legacyResumeInstall(f) {
  const startup = path.join(f.base, 'fake-startup'), handoffFile = path.join(f.base, 'handoff.txt'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const rows = new Map(), registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => { rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); } };
  f.deps.registerUninstall = (root, options) => registerInstallation(root, { ...options, registry });
  await fs.mkdir(startup);
  const first = await f.run({ clients: 'chatgpt', coordinatorResume: { cliClients: 'chatgpt', handoffFile } });
  const ownershipFile = path.join(f.root, 'coordinator-resume/ownership.json'), recordFile = path.join(f.root, 'uninstall-record.json');
  const rewrite = async change => {
    const value = await readJson(ownershipFile); change(value);
    const bytes = JSON.stringify(value, null, 2) + '\r\n'; await fs.writeFile(ownershipFile, bytes);
    const record = await readJson(recordFile); record.software['coordinator-resume/ownership.json'] = sha(bytes); await fs.writeFile(recordFile, JSON.stringify(record));
  };
  // What versions before this one left behind: one unchanged Startup file outside the install, recorded as the install's own.
  const legacy = path.join(startup, installationId(f.root) + '-Resume.cmd');
  await fs.writeFile(legacy, 'old wake-up launcher');
  await rewrite(value => { value.external = [{ path: legacy, sha256: sha('old wake-up launcher') }]; });
  return { startup, first, legacy, ownershipFile, rewrite, sha };
}

test('upgrading an install whose old wake-up Startup entry is a .vbs file works, connects both assistants and removes only that proven file', async t => {
  const f = await fixture(t), old = await legacyResumeInstall(f), vbs = path.join(old.startup, installationId(f.root) + '-Resume.vbs');
  await fs.unlink(old.legacy); await fs.writeFile(vbs, 'old wake-up launcher');
  await old.rewrite(value => { value.external = [{ path: vbs, sha256: old.sha('old wake-up launcher') }]; });
  const upgraded = await f.run({ clients: 'both' });
  assert.deepEqual(await fs.readdir(old.startup), [], 'the scheduled task replaces the Startup file');
  assert.equal(upgraded.coordinatorResume.external.length, 0); assert.equal(upgraded.assistants.items.length > 0, true);
});

test('upgrading when the old wake-up record does not match but the folder agrees with itself repairs it and still removes the old Startup file', async t => {
  const f = await fixture(t), old = await legacyResumeInstall(f);
  await fs.appendFile(old.ownershipFile, ' ');
  const upgraded = await f.run({ clients: 'both' });
  assert.equal(upgraded.assistants.items.length > 0, true);
  assert.ok(!upgraded.coordinatorResume.leftAsIs);
  assert.equal((await fs.readdir(old.startup)).length, 0);
});

test('a power cut after the wake-up files were written but before the uninstall list was: the next install repairs it; a file you changed is still left alone', async t => {
  const f = await fixture(t), fake = await withClaude(f), folder = path.join(f.root, 'coordinator-resume'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  await f.run({});
  // What the cut leaves: the settings file and the folder's own list are new, the uninstall list still describes the old ones.
  const staleRecord = async () => {
    const config = await readJson(path.join(folder, 'config.json')); config.pollMs = 3000;
    const bytes = JSON.stringify(config, null, 2) + '\r\n'; await fs.writeFile(path.join(folder, 'config.json'), bytes);
    const owned = await readJson(path.join(folder, 'ownership.json')); owned.files['config.json'] = sha(bytes);
    await fs.writeFile(path.join(folder, 'ownership.json'), JSON.stringify(owned, null, 2) + '\r\n');
  };
  await staleRecord(); fake.tasks.clear();
  const repaired = await f.run({});
  assert.ok(!repaired.coordinatorResume.leftAsIs, 'the folder agrees with its own list, so it is Setup\'s');
  assert.equal(fake.tasks.size, 1, 'the scheduled task is set up again');
  const record = await readJson(path.join(f.root, 'uninstall-record.json'));
  for (const name of ['config.json', 'ownership.json', 'resume-prompt.txt']) assert.equal(record.software['coordinator-resume/' + name], sha(await fs.readFile(path.join(folder, name))), name + ' is on the uninstall list again');
  assert.deepEqual((await fs.readdir(folder)).filter(name => name.endsWith('.tmp')), []);
  // The same cut, but the person had also changed a file: nothing is proven, nothing is touched.
  await staleRecord(); await fs.appendFile(path.join(folder, 'resume-prompt.txt'), ' my edit');
  const edited = await fs.readFile(path.join(folder, 'resume-prompt.txt'));
  assert.equal((await f.run({})).coordinatorResume.leftAsIs, true);
  assert.deepEqual(await fs.readFile(path.join(folder, 'resume-prompt.txt')), edited);
});

test('a power cut after the wake-up files were saved but before their list was: the next install finishes the job instead of leaving them alone', async t => {
  const f = await fixture(t), fake = await withClaude(f), folder = path.join(f.root, 'coordinator-resume');
  await f.run({});
  await fs.unlink(path.join(folder, 'ownership.json')); await fs.unlink(path.join(f.root, 'uninstall-record.json')); fake.tasks.clear();
  const again = await f.run({});
  assert.ok(!again.coordinatorResume.leftAsIs);
  assert.equal(fake.tasks.size, 1);
  assert.ok(Object.keys((await readJson(path.join(folder, 'ownership.json'))).files).includes('config.json'));
  assert.ok((await readJson(path.join(f.root, 'uninstall-record.json'))).software['coordinator-resume/ownership.json']);
});

test('an uninstall list cut off by a power loss is repaired by the next install', async t => {
  const f = await fixture(t), fake = await withClaude(f), recordFile = path.join(f.root, 'uninstall-record.json');
  await f.run({});
  await fs.writeFile(recordFile, (await fs.readFile(recordFile, 'utf8')).slice(0, 40)); fake.tasks.clear();
  const again = await f.run({});
  assert.ok(!again.coordinatorResume.leftAsIs);
  assert.ok((await readJson(recordFile)).software['coordinator-resume/ownership.json'], 'the list is whole again');
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.includes('uninstall-record.json.')), []);
});

test('two power cuts in a row (some files already new, the folder\'s own list still old) are repaired by the next install; a changed file is still left alone', async t => {
  const f = await fixture(t), fake = await withClaude(f), folder = path.join(f.root, 'coordinator-resume'), recordFile = path.join(f.root, 'uninstall-record.json');
  await f.run({});
  const stale = async () => {
    const owned = await readJson(path.join(folder, 'ownership.json')); owned.files['config.json'] = '0'.repeat(64);
    await fs.writeFile(path.join(folder, 'ownership.json'), JSON.stringify(owned, null, 2) + '\r\n'); await fs.rm(recordFile, { force: true }); fake.tasks.clear();
  };
  await stale();
  assert.ok(!(await f.run({})).coordinatorResume.leftAsIs, 'config.json is exactly what this version writes, so it is Setup\'s');
  await stale(); await fs.appendFile(path.join(folder, 'resume-prompt.txt'), ' my edit');
  assert.equal((await f.run({})).coordinatorResume.leftAsIs, true);
});

test('a folder or link named disabled keeps wake-ups off, so the install says so plainly and pots doctor names it', async t => {
  const f = await fixture(t), fake = await withClaude(f), marker = path.join(f.root, 'coordinator-resume', 'control', 'disabled');
  await f.run({}); fake.calls.length = 0;
  await fs.mkdir(marker);
  const again = await f.run({});
  assert.match(resultMessage(again), /Wake-ups are OFF: .*disabled is a folder or a link, not a file.*Next: delete or rename it, then run pots install again/);
  assert.equal(fake.calls.some(call => call[0] === 'start'), false);
  assert.equal((await fs.stat(marker)).isDirectory(), true, 'it is not Setup\'s to delete');
  const row = (await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).find(item => item.key === 'switch');
  assert.deepEqual([row.ok, /folder or a link.*Next: delete or rename it, then run pots install/.test(row.text)], [false, true]);
});

test('a link named disabled is never read or replaced by the install', async t => {
  const f = await fixture(t); await withClaude(f); const marker = path.join(f.root, 'coordinator-resume', 'control', 'disabled'), target = path.join(f.base, 'outside.txt');
  await f.run({});
  await fs.writeFile(target, 'not mine');
  try { await fs.symlink(target, marker, 'file'); } catch { t.diagnostic('links cannot be made here: link check skipped'); return; }
  const reads = [], original = fs.readFile;
  fs.readFile = async (file, ...rest) => { reads.push(String(file)); return original(file, ...rest); };
  try { await f.run({}); } finally { fs.readFile = original; }
  assert.deepEqual(reads.filter(file => file === marker), [], 'the link was not followed');
  assert.equal((await fs.lstat(marker)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'not mine');
});

test('a launcher folder with only one of its two files, and a first setup cut off before its records were saved, are repaired by the next install', async t => {
  const f = await fixture(t), first = await f.run({}), state = first.sessions[0].stateFolder, folder = path.dirname(first.sessions[0].launcher);
  const script = path.join(folder, 'Start-OMP.ps1'), settings = path.join(folder, 'launch-settings.json'), want = [await fs.readFile(settings), await fs.readFile(script)];
  for (const gone of [script, settings]) {
    await fs.rm(gone);
    await f.run({});
    assert.deepEqual([await fs.readFile(settings), await fs.readFile(script)], want, 'both files are written again');
  }
  // A lone script the person edited, or a lone settings file of another shape, is never deleted unread: the install stops and both stay as they are.
  const mine = '# my own edits\r\n', other = JSON.stringify({ mine: true });
  await fs.rm(settings); await fs.writeFile(script, mine);
  await assert.rejects(f.run({}), /Setup found a launcher file that it did not write \(it may be from an older version of Setup\).*Start-OMP\.ps1 or launch-settings\.json.*move or delete that file/);
  assert.equal(await fs.readFile(script, 'utf8'), mine); assert.equal(await fs.stat(settings).then(() => true, () => false), false);
  await fs.rm(script); await fs.writeFile(settings, other);
  await assert.rejects(f.run({}), /Setup found a launcher file that it did not write.*move or delete that file/);
  assert.equal(await fs.readFile(settings, 'utf8'), other); assert.equal(await fs.stat(script).then(() => true, () => false), false);
  await fs.rm(settings); await f.run({});
  assert.deepEqual([await fs.readFile(settings), await fs.readFile(script)], want, 'once the files are gone, both are written again');
  // The power went after Setup made the project folder and before it saved config.json and launch.json.
  await fs.rm(state, { recursive: true });
  for (const name of ['plans', 'receipts', 'control']) await fs.mkdir(path.join(state, name), { recursive: true });
  assert.equal((await f.run({})).sessions[0].stateFolder, state);
  assert.equal((await loadSetup(state)).settings.sessionId, f.choices[0].sessionId);
});

test('upgrading when an old generated wake-up file was edited still connects both assistants and leaves the old files alone', async t => {
  const f = await fixture(t), old = await legacyResumeInstall(f), config = path.join(f.root, 'coordinator-resume/config.json');
  await fs.appendFile(config, ' ');
  const edited = await fs.readFile(config);
  const upgraded = await f.run({ clients: 'both' });
  assert.equal(upgraded.assistants.items.length > 0, true);
  assert.deepEqual(await fs.readFile(config), edited);
  assert.equal((await fs.readdir(old.startup)).length, 1);
  assert.ok(upgraded.summary.some(line => /[Oo]ld wake-up files .* left as they are/.test(line)));
});

test('upgrading over an old file Setup cannot verify connects both assistants, keeps that file, and still refreshes the uninstall list without claiming it', async t => {
  const f = await fixture(t);
  await legacyResumeInstall(f);
  const managed = (await fs.readdir(path.join(f.root, 'runtime')))[0], leftover = path.join(f.root, 'runtime', managed, 'versions/0.2.12/src/old.mjs');
  await fs.mkdir(path.dirname(leftover), { recursive: true }); await fs.writeFile(leftover, 'old leftover');
  const upgraded = await f.run({ clients: 'both' });
  assert.equal(upgraded.assistants.items.length > 0, true);
  assert.equal(await fs.readFile(leftover, 'utf8'), 'old leftover');
  assert.ok(!upgraded.summary.some(line => /uninstall list was not updated/i.test(line)));
  const record = JSON.parse(await fs.readFile(path.join(f.root, 'uninstall-record.json'), 'utf8'));
  assert.equal(record.software[`runtime/${managed}/versions/0.2.12/src/old.mjs`], undefined, 'the leftover is not claimed, so uninstall lists it and keeps it');
});

test('a plain install finds Claude Code, turns wake-ups on by itself, makes the handoff file and one scheduled task, and a repeat makes no second one', async t => {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake; f.deps.registerUninstall = registration();
  const first = await f.run({}), dir = path.join(f.root, 'coordinator-resume'), name = installationId(f.root) + '-Resume';
  assert.equal(first.coordinatorResume.options.cliClients, 'claude');
  const config = await readJson(path.join(dir, 'config.json'));
  assert.equal(config.handoffFile, path.join(dir, 'handoff.md')); assert.equal(config.dryRun, false);
  assert.match(await fs.readFile(path.join(dir, 'handoff.md'), 'utf8'), /handoff/);
  assert.ok((await fs.readFile(path.join(dir, 'Run-Resume.vbs'), 'utf8')).includes(path.join(first.runtimeFolder, 'bin/coordinator-resume.mjs')));
  assert.deepEqual([...fake.tasks.keys()], [name]);
  const xml = fake.tasks.get(name);
  assert.match(xml, /<LogonTrigger>/); assert.match(xml, /<Interval>PT5M<\/Interval>/); assert.match(xml, /IgnoreNew/);
  assert.match(first.summary.find(line => /^Wake-ups:/.test(line)), /scheduled task keeps a small watchdog/);
  const before = await snapshot(f.root);
  await f.run({});
  assert.deepEqual(await snapshot(f.root), before, 'a repeat changes no file');
  assert.deepEqual([...fake.tasks.keys()], [name]); assert.equal(fake.tasks.get(name), xml);
  assert.equal(fake.calls.filter(call => call[0] === 'start').length, 2, 'every run starts the watchdog on the code it just installed');
  assert.equal(await fs.stat(path.join(dir, 'control', 'disabled')).catch(() => null), null, 'the pause note Setup wrote while restarting is gone');
});

test('wake-ups switched off at install leave no watchdog and no task; without Claude Code or Codex nothing is made and the result says why', async t => {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake;
  await f.run({ coordinatorWakeups: false });
  assert.equal(fake.tasks.size, 0);
  assert.deepEqual((await fs.readdir(path.join(f.root, 'coordinator-resume'), { recursive: true })).map(name => name.replaceAll('\\', '/')).sort(), ['control', 'control/wakeups-off', 'ownership.json'], 'only the stored choice and the empty record, no watchdog files');
  const g = await fixture(t); g.deps.tasks = fakeTasks();
  const none = await g.run({});
  assert.equal(g.deps.tasks.tasks.size, 0);
  assert.match(none.summary.find(line => /^Wake-ups:/.test(line)), /no Claude Code or Codex was found on this PC, so nothing can start an assistant on its own/);
});

test('a scheduled task Windows refuses is loud: in the message, in pots.log, and the install still works', async t => {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  fake.register = async () => { throw new Error('access denied'); };
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake; f.deps.registerUninstall = registration();
  const result = await f.run({});
  assert.match(resultMessage(result), /Wake-ups are NOT working: Windows would not set up the scheduled task/);
  assert.match(await fs.readFile(path.join(f.root, 'pots.log'), 'utf8'), /Wake-ups are NOT working/);
  assert.ok(result.sessions[0].stateFolder);
});

test('the wake-up self-test times a throwaway lane through the real watcher, status and decision, says what it did not prove, and leaves nothing behind', async t => {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake; f.deps.registerUninstall = registration();
  await f.run({});
  const control = path.join(f.root, 'coordinator-resume', 'control'), temp = path.join(f.base, 'selftest-tmp');
  // The self-test makes its throwaway folder in the temp folder: this test's own, so another test run at the same time cannot be counted as a leftover.
  await fs.mkdir(temp); const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP }; process.env.TEMP = process.env.TMP = temp;
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const leftovers = async () => (await fs.readdir(temp)).filter(name => name.startsWith('pots-selftest-'));
  const before = await leftovers(), run = () => selfTest({ root: f.root, tasks: fake, env: f.deps.env, watch: { pollMs: 1000, idleMs: 2000 } });
  // The watchdog has not run yet: the test fails and names it.
  const dead = await run();
  assert.equal(dead.pass, false); assert.match(dead.text, /^Wake-up self-test: FAIL\. The watchdog has never run/);
  await fs.mkdir(control, { recursive: true }); await fs.writeFile(path.join(control, 'launches.jsonl'), JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'quiet', laneCount: 0 }) + '\n');
  const ok = await run();
  assert.equal(ok.pass, true, ok.text);
  assert.ok(ok.idleSeconds >= 2 && ok.idleSeconds <= 15, 'idle noticed after ' + ok.idleSeconds);
  assert.match(ok.text, /^Wake-up self-test: PASS\. A test lane that finished was noticed after \d+\.\d seconds \(limit 15\.0\).*Not proven: that the coordinator program itself opens/);
  fake.tasks.clear();
  assert.match((await run()).text, /scheduled task that keeps the watchdog running is missing/);
  assert.deepEqual(await leftovers(), before, 'no throwaway folder is left');
});

test('Ctrl+C or a closed window during the self-test removes its throwaway folder', async t => {
  const f = await fixture(t), temp = path.join(f.base, 'selftest-tmp'); await fs.mkdir(temp);
  const leftovers = async () => (await fs.readdir(temp)).filter(name => name.startsWith('pots-selftest-')), before = await leftovers();
  const module = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'coordinator-resume-setup.mjs')).href;
  // A real signal cannot be sent on Windows without ending the child at once, so the child raises it on itself the moment its folder exists.
  const script = `import fs from 'node:fs'; import { selfTest } from ${JSON.stringify(module)};
    const names = () => fs.readdirSync(${JSON.stringify(temp)}).filter(name => name.startsWith('pots-selftest-'));
    selfTest({ root: ${JSON.stringify(f.root)}, tasks: { query: async () => null }, env: process.env, watch: { pollMs: 1000, idleMs: 2000 }, stopText: 'THE-INSTALL-IS-COMPLETE-TEXT' }).catch(() => {});
    const timer = setInterval(() => { if (names().length > ${before.length}) { clearInterval(timer); process.emit('SIGINT', 'SIGINT'); } }, 20);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: temp, TMP: temp } });
  assert.equal(run.status, 130, run.stderr);
  assert.match(run.stdout, /THE-INSTALL-IS-COMPLETE-TEXT/, 'the stop says what happened');
  assert.deepEqual(await leftovers(), before, 'the throwaway folder is gone');
});
// A real signal cannot be sent on Windows without ending the child at once, so the child raises it on itself while its
// fake scheduled-task step runs (the task file stands in for the Task Scheduler and lives outside the install folder).
async function stoppedInstall(t, how, hangAssistants = false, transientQuery = false) {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), taskFile = path.join(f.base, 'task.txt');
  if (transientQuery) await fs.writeFile(taskFile, 'x'); // a task from an earlier install, which Task Scheduler cannot be asked about right now
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  const extra = hangAssistants ? `which: async exe => exe === 'claude.exe' ? ${JSON.stringify(path.join(bin, 'claude.exe'))} : null, runClient: async () => { process.emit('SIGINT', 'SIGINT'); await new Promise(() => {}); },` : '';
  const module = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'autosetup.mjs')).href, uninstall = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'uninstall.mjs')).href;
  const script = `import fs from 'node:fs'; import { autoSetup } from ${JSON.stringify(module)}; import { registerInstallation } from ${JSON.stringify(uninstall)};
    const rows = new Map(), registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) };
    const tasks = { query: async () => ${transientQuery ? "{ throw new Error('schtasks failed'); }" : `fs.existsSync(${JSON.stringify(taskFile)}) ? 'x' : null`},
      register: async () => { fs.writeFileSync(${JSON.stringify(taskFile)}, 'x'); ${how}; await new Promise(() => {}); },
      remove: async () => { fs.rmSync(${JSON.stringify(taskFile)}); return 'removed'; }, stop: async () => {}, start: async () => {} };
    const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: ${JSON.stringify(f.agent)}, LOCALAPPDATA: ${JSON.stringify(f.base)}, PATH: ${JSON.stringify(bin)} }, home: ${JSON.stringify(f.base)},
      nodeVersion: process.versions.node, nodeExecutable: process.execPath, locate: async () => process.execPath, detect: async () => 'omp/18.8.6',
      startCheck: async () => {}, which: async () => null, tasks, stdout: text => console.log(text), ${extra}
      registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }),
      permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
    await autoSetup({ root: ${JSON.stringify(f.root)} }, deps);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 });
  return { f, run, taskFile };
}

test('Ctrl+C in the middle of pots install undoes what it had started, says so, and exits 130', async t => {
  const { f, run, taskFile } = await stoppedInstall(t, "process.emit('SIGINT', 'SIGINT')");
  assert.equal(run.status, 130, run.stderr + run.stdout);
  assert.match(run.stdout, /Install was stopped\. What it had started was undone\. Run `pots install` again when you are ready\./);
  assert.equal(await fs.stat(taskFile).then(() => true, () => false), false, 'the scheduled task is removed');
  assert.equal(await fs.stat(path.join(f.root, 'setup.lock')).then(() => true, () => false), false, 'no lock is left');
  assert.equal(await fs.stat(path.join(f.root, 'coordinator-resume', 'config.json')).then(() => true, () => false), false, 'the watchdog files are put back');
});

test('a stopped pots install prints no error line of its own; the stop line is the only text', async t => {
  const f = await fixture(t), out = [], err = [];
  const code = await main(['install'], { ...f.deps, openSessions: undefined, registerUninstall: registration(), stdout: text => out.push(text), stderr: text => err.push(text),
    startCheck: async () => { throw new Error('Install was stopped.'); } });
  assert.equal(code, 1);
  assert.deepEqual(err, [], 'no "unexpected error" and no second stop line on stderr');
});

test('Ctrl+C while the assistants are being connected says that part may not be undone, instead of claiming everything was', async t => {
  const { run } = await stoppedInstall(t, "process.emit('SIGINT', 'SIGINT')", true);
  assert.equal(run.status, 130, run.stderr + run.stdout);
  assert.match(run.stdout, /Install was stopped\. Connecting your assistants was still running after 10 seconds, so part of it may not be undone\. Run `pots install` again; that is safe and repairs it\./);
  assert.ok(!/What it had started was undone/.test(run.stdout));
});

test('after a hard kill in the middle of pots install, running pots install again repairs the half install', async t => {
  const { f, run, taskFile } = await stoppedInstall(t, "process.kill(process.pid, 'SIGKILL')");
  assert.notEqual(run.status, 0);
  assert.ok(await fs.stat(taskFile).then(() => true, () => false), 'the kill left the task half done');
  const fake = fakeTasks(); f.deps.tasks = fake; f.deps.registerUninstall = registration(); f.deps.env = { ...f.deps.env, PATH: path.join(f.base, 'bin') };
  const result = await f.run({});
  assert.ok(!result.coordinatorResume.leftAsIs, 'the leftover files are recognised as Setup\'s own');
  assert.ok(fake.tasks.size === 1, 'the repeat install put the scheduled task in place');
  assert.ok((await readConnections(path.join(f.root, 'connections'))).connections.length === 1);
});

test('a watchdog stuck in its own safety check shows as a failing row with a next step', async t => {
  const f = await fixture(t), bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake; f.deps.registerUninstall = registration();
  await f.run({});
  const control = path.join(f.root, 'coordinator-resume', 'control');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'launches.jsonl'), JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'safety', laneCount: 0 }) + '\n');
  const safety = (await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).find(row => row.key === 'safety');
  assert.equal(safety.ok, false); assert.match(safety.text, /starts nothing\. Next: run pots install\./);
  await fs.writeFile(path.join(control, 'launches.jsonl'), JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'quiet', laneCount: 0 }) + '\n');
  assert.equal((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).some(row => row.key === 'safety'), false, 'a later quiet poll clears it');
  // A coordinator note dated far in the future can stop wake-ups: doctor names that file and still shows the other advice.
  const [{ root: laneRoot }] = (await readConnections(path.join(f.root, 'connections'))).connections;
  const note = path.join(laneRoot, 'control', 'coordinator-active.json');
  await fs.writeFile(note, JSON.stringify({ version: 1, updatedAt: Date.now() + 3600000 }));
  await fs.writeFile(path.join(control, 'launches.jsonl'), JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'safety', laneCount: 0 }) + '\n');
  const named = (await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).find(row => row.key === 'safety');
  assert.ok(named.text.includes(note) && /cannot be trusted.*can stop wake-ups.*delete that file.*If wake-ups do not come back.*state\.json/.test(named.text), named.text);
});

// ---- What the person sees when wake-ups are off, paused by the owner, or blocked by an open session ----
async function withClaude(f) {
  const bin = path.join(f.base, 'bin'), fake = fakeTasks();
  await fs.mkdir(bin, { recursive: true }); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  f.deps.env = { ...f.deps.env, PATH: bin }; f.deps.tasks = fake; f.deps.registerUninstall = registration();
  return fake;
}
const savedSession = async (f, name) => {
  const cwd = path.join(f.base, name), sessionId = crypto.randomUUID(); await fs.mkdir(cwd);
  await fs.writeFile(path.join(f.sessions, name + '.jsonl'), JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  return sessionId;
};

test('wake-ups switched off stay off: a session saved later and a later plain install do not turn them back on', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({ clients: 'claude', coordinatorWakeups: false });
  await savedSession(f, 'later');
  assert.equal(await syncSessions({ connectionsFolder: first.connectionsFolder, credentialFile: first.credentialFile, env: f.deps.env, home: f.base, detect: f.deps.detect }), 1);
  const rows = (await readConnections(first.connectionsFolder)).connections;
  assert.equal(rows.length, 2);
  for (const row of rows) { const saved = await readJson(path.join(row.root, 'config.json')); assert.deepEqual([saved.coordinatorWakeups, saved.clients], [false, 'claude']); }
  const again = await f.run({});
  assert.equal(again.coordinatorWakeups, false); assert.equal(fake.tasks.size, 0);
  assert.match(resultMessage(again), /Wake-ups are off by your choice\./);
});

test('an open OMP session does not stop --no-coordinator-wakeups: the task is still removed and the session keeps its old choice until it is closed', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({}), state = first.sessions[0].stateFolder, config = path.join(state, 'config.json');
  assert.equal(fake.tasks.size, 1);
  const lock = (await loadSetup(state)).lockFile; await fs.writeFile(lock, 'open');
  const off = await f.run({ coordinatorWakeups: false });
  assert.equal(fake.tasks.size, 0, 'the scheduled task is gone');
  assert.ok(off.summary.some(line => /One OMP session is open, so it keeps the older choices until closed\. Next: close it, then run pots install again\./.test(line)), off.summary.join('\n'));
  assert.ok(!/lock/i.test(off.summary.join(' ')), 'no technical lock text');
  assert.equal((await readJson(config)).coordinatorWakeups, true);
  await fs.unlink(lock);
  await f.run({ coordinatorWakeups: false });
  assert.equal((await readJson(config)).coordinatorWakeups, false);
});

test('install after Disable-Resume says wake-ups are switched off by the owner marker, runs no self-test and does not fail', async t => {
  const f = await fixture(t), fake = await withClaude(f); let tested = 0;
  f.deps.selfTest = async () => { tested++; return { pass: false, text: 'Wake-up self-test: FAIL. nothing' }; };
  await f.run({}); tested = 0;
  const marker = path.join(f.root, 'coordinator-resume', 'control', 'disabled'); await fs.writeFile(marker, 'POTS coordinator resume disabled.\r\n');
  const starts = () => fake.calls.filter(call => call[0] === 'start').length, startsBefore = starts();
  const again = await f.run({});
  assert.equal(tested, 0, 'no self-test'); assert.equal(again.selfTest, undefined);
  assert.match(resultMessage(again), /Wake-ups are switched off by the owner marker.*delete that file and run pots install/);
  assert.ok(!/FAIL/.test(resultMessage(again)));
  assert.ok(!again.summary.some(line => /a scheduled task keeps a small watchdog running/.test(line)));
  assert.equal(await fs.readFile(marker, 'utf8'), 'POTS coordinator resume disabled.\r\n', 'the owner marker is left alone');
  assert.equal(starts(), startsBefore, 'the watchdog is not started while the owner has it switched off');
});

test('--no-coordinator-wakeups with old wake-up files Setup cannot verify says what it left alone, never "off by your choice"', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  await f.run({});
  await fs.appendFile(path.join(f.root, 'coordinator-resume', 'ownership.json'), ' '); await fs.appendFile(path.join(f.root, 'coordinator-resume', 'resume-prompt.txt'), ' '); // Setup can no longer prove the old files are its own
  const off = await f.run({ coordinatorWakeups: false });
  const text = resultMessage(off) + ' ' + off.summary.join(' ');
  assert.ok(!/off by your choice/.test(text), text);
  assert.match(resultMessage(off), /old scheduled task may still start assistants\. Next: .*Disable-Resume\.cmd/);
  assert.equal(fake.tasks.size, 1, 'the old task was not touched');
});

test('the wake-up self-test limit follows the lane\'s own timing instead of a fixed 15 seconds', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  await f.run({});
  const control = path.join(f.root, 'coordinator-resume', 'control'); await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'launches.jsonl'), JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'quiet', laneCount: 0 }) + '\n');
  // The lane waits 6 s before it counts as idle; the caller's slack is only 3 s. The limit grows with the lane's own wait.
  const result = await selfTest({ root: f.root, tasks: fake, env: f.deps.env, watch: { pollMs: 1000, idleMs: 6000 }, limitMs: 3000 });
  assert.equal(result.pass, true, result.text);
  assert.ok(result.idleSeconds >= 6, 'idle noticed after ' + result.idleSeconds);
  assert.match(result.text, /\(limit 12\.0\)/);
});

test('an old Startup launcher that does not match its record is kept, named in the install result, and recorded so uninstall names it too', async t => {
  const f = await fixture(t), old = await legacyResumeInstall(f);
  await fs.writeFile(old.legacy, 'the person changed this launcher');
  const upgraded = await f.run({ clients: 'both' });
  assert.equal(await fs.readFile(old.legacy, 'utf8'), 'the person changed this launcher');
  assert.equal(upgraded.coordinatorResume.external.length, 1);
  assert.ok(upgraded.summary.some(line => line.includes(old.legacy) && /kept because it was changed after Setup wrote it/.test(line)));
  assert.deepEqual((await readJson(path.join(f.root, 'uninstall-record.json'))).resumeExternal.map(row => row.path), [old.legacy]);
});

test('a cut-off last line in the watchdog log is reported by pots doctor and repaired by pots install', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  await f.run({});
  const log = path.join(f.root, 'coordinator-resume', 'control', 'launches.jsonl'), good = JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'quiet', laneCount: 0 });
  await fs.mkdir(path.dirname(log), { recursive: true }); await fs.writeFile(log, good + '\n' + '{"version":1,"time":12');
  const before = await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env });
  assert.match(before.find(row => row.key === 'log').text, /damaged line.*run pots install/);
  await f.run({});
  assert.equal(await fs.readFile(log, 'utf8'), good + '\n');
  assert.equal((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).some(row => row.key === 'log'), false);
});

// A lock file as a crashed lane leaves it: it names a process that no longer runs.
const crashedLock = async state => {
  const lock = (await loadSetup(state)).lockFile, finished = spawnSync(process.execPath, ['-e', '0']);
  await fs.writeFile(lock, JSON.stringify({ version: 1, pid: finished.pid }));
  return lock;
};

test('a lock left by a crashed lane is not an open session: the install changes the choice and does not ask to close anything', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({}), state = first.sessions[0].stateFolder, config = path.join(state, 'config.json');
  await crashedLock(state);
  const off = await f.run({ coordinatorWakeups: false });
  assert.equal((await readJson(config)).coordinatorWakeups, false);
  assert.ok(!off.summary.some(line => /is open|are open|close it/.test(line)), off.summary.join('\n'));
  assert.equal(fake.tasks.size, 0);
});

test('--no-coordinator-wakeups while a session is open stays off: a later plain install keeps it, pots status and pots doctor agree, and the session follows once it is closed', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({}), state = first.sessions[0].stateFolder, config = path.join(state, 'config.json');
  const lock = (await loadSetup(state)).lockFile; await fs.writeFile(lock, 'open');
  await f.run({ coordinatorWakeups: false });
  assert.equal((await readJson(config)).coordinatorWakeups, true, 'the open session itself is not changed');
  const again = await f.run({});
  assert.equal(again.coordinatorWakeups, false); assert.equal(fake.tasks.size, 0, 'the task stays removed');
  assert.match(resultMessage(again), /Wake-ups are off by your choice\./);
  assert.deepEqual((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).map(row => [row.key, row.ok]), [['off', true]]);
  await fs.unlink(lock);
  await f.run({});
  assert.equal((await readJson(config)).coordinatorWakeups, false, 'once it is closed the next install brings it in line');
  assert.equal(fake.tasks.size, 0);
});

const wakeupsFile = (f, name) => path.join(f.root, 'coordinator-resume', 'control', name);
const hasFile = file => fs.access(file).then(() => true, () => false);

test('--coordinator-wakeups turns wake-ups on again after --no-coordinator-wakeups: the task is back, the choice is gone, and a later plain install keeps it on', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({}), config = path.join(first.sessions[0].stateFolder, 'config.json');
  await f.run({ coordinatorWakeups: false });
  assert.equal(fake.tasks.size, 0); assert.equal(await hasFile(wakeupsFile(f, 'wakeups-off')), true);
  const on = await f.run({ coordinatorWakeups: true });
  assert.equal(fake.tasks.size, 1, 'the scheduled task is back'); assert.equal((await readJson(config)).coordinatorWakeups, true);
  assert.equal(await hasFile(wakeupsFile(f, 'wakeups-off')), false); assert.equal(await hasFile(wakeupsFile(f, 'wakeups-on')), false, 'nothing is left to remember: no session was open');
  assert.ok(!/off by your choice/.test(resultMessage(on) + on.summary.join(' ')), resultMessage(on));
  assert.deepEqual((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).filter(row => row.key === 'off'), []);
  assert.equal((await f.run({})).coordinatorWakeups, true); assert.equal(fake.tasks.size, 1);
});

test('--coordinator-wakeups while a session is open stays on: a later plain install keeps it, and the session follows once it is closed', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  const first = await f.run({}), state = first.sessions[0].stateFolder, config = path.join(state, 'config.json');
  await f.run({ coordinatorWakeups: false });
  const lock = (await loadSetup(state)).lockFile; await fs.writeFile(lock, 'open');
  const on = await f.run({ coordinatorWakeups: true });
  assert.equal((await readJson(config)).coordinatorWakeups, false, 'the open session itself is not changed');
  assert.equal(fake.tasks.size, 1, 'the scheduled task is back at once');
  assert.ok(on.summary.some(line => /One OMP session is open, so it keeps the older choices until closed\./.test(line)), on.summary.join('\n'));
  const again = await f.run({});
  assert.equal(again.coordinatorWakeups, true); assert.equal(fake.tasks.size, 1, 'the choice is not lost to what the open session still says');
  assert.deepEqual((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).filter(row => row.key === 'off'), []);
  await fs.unlink(lock);
  await f.run({});
  assert.equal((await readJson(config)).coordinatorWakeups, true, 'once it is closed the next install brings it in line');
  assert.equal(await hasFile(wakeupsFile(f, 'wakeups-on')), false); assert.equal(fake.tasks.size, 1);
});

test('an unreadable old wake-up record with wake-ups on says so, skips the self-test, and never claims there is no Claude Code or Codex', async t => {
  const f = await fixture(t), fake = await withClaude(f); let tested = 0;
  f.deps.selfTest = async () => { tested++; return { pass: true, text: 'Wake-up self-test: PASS.' }; };
  await f.run({}); tested = 0;
  await fs.appendFile(path.join(f.root, 'coordinator-resume', 'resume-prompt.txt'), ' '); // a changed file: Setup can no longer prove the old files are its own
  const again = await f.run({});
  const text = resultMessage(again) + ' ' + again.summary.join(' ');
  assert.match(resultMessage(again), /Wake-ups were not changed: old wake-up files .* left as they are.*no scheduled task was set up and the wake-up test did not run/);
  assert.ok(!/no Claude Code or Codex was found/.test(text), text);
  assert.equal(tested, 0); assert.equal(fake.tasks.size, 1, 'the old task was not touched');
});

test('the coordinator text of the earlier 0.2.23 build is upgraded in place to the one that names EXPIRED, not kept as an edited file', async t => {
  const f = await fixture(t); await f.run({});
  const file = path.join(f.root, 'coordinator-instructions', 'claude-skill.md'), current = await fs.readFile(file, 'utf8');
  assert.match(current, /EXPIRED line means a queued task was not started/);
  const earlier = current.replace('RESULT, GONE, ERROR and EXPIRED lines', 'RESULT, GONE and ERROR lines').replace('IDLE, RESULT, GONE or EXPIRED lines', 'IDLE, RESULT or GONE lines')
    .replace(' An EXPIRED line means a queued task was not started because its time ran out: tell the user and say it has to be queued again.', '');
  assert.notEqual(earlier, current);
  await fs.writeFile(file, earlier);
  const again = await f.run({});
  assert.equal(await fs.readFile(file, 'utf8'), current);
  assert.ok(!again.summary.some(line => /Setup did not touch/.test(line)), 'it was not treated as the person\'s own edit');
});

test('the coordinator text of the earlier builds is upgraded in place in both files, not kept as an edited file, and never tells the assistant to close a stopped lane\'s window', async t => {
  const sentence = ' A stopped lane (stopped is true) is continued with `pots lane restore <name>`, or with `/bridge status` then `/bridge enable` in its window if that window is still open; never queue a new step on it and never close its window.';
  const earlier = [' A stopped lane (stopped is true) is continued with `pots lane restore <name>`; never queue a new step on it.', ''];
  for (const before of earlier) {
    const f = await fixture(t); await f.run({ clients: 'both' });
    for (const name of ['claude-skill.md', 'chatgpt-custom-instructions.txt']) {
      const file = path.join(f.root, 'coordinator-instructions', name), current = await fs.readFile(file, 'utf8');
      assert.ok(current.includes(sentence), name + ' names the stopped-lane rule');
      await fs.writeFile(file, current.replace(sentence, before));
    }
    const again = await f.run({ clients: 'both' });
    for (const name of ['claude-skill.md', 'chatgpt-custom-instructions.txt']) assert.ok((await fs.readFile(path.join(f.root, 'coordinator-instructions', name), 'utf8')).includes(sentence), name + ' was upgraded');
    assert.ok(!again.summary.some(line => /Setup did not touch/.test(line)), 'it was not treated as the person\'s own edit');
  }
});

test('an install that already exists says only what is true when it is repeated with a different choice', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  await f.run({});
  const off = await f.run({ coordinatorWakeups: false });
  assert.equal(fake.tasks.size, 0, 'the repeat did change something');
  assert.ok(!/nothing was changed/i.test(resultMessage(off)), resultMessage(off));
  assert.match(resultMessage(off), /already installed; its program files were not changed\..*Wake-ups are off by your choice\./);
});

test('an install stopped while the scheduled task cannot be asked about does not delete a task that was already there', async t => {
  const { run, taskFile } = await stoppedInstall(t, "process.emit('SIGINT', 'SIGINT')", false, true);
  assert.equal(run.status, 130, run.stderr + run.stdout);
  assert.equal(await fs.readFile(taskFile, 'utf8'), 'x', 'the earlier task is still there');
});

test('pots status and doctor say what is true when no command-line program is selected: cloud-only is a choice, not a missing program', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-health-'))), root = path.join(base, 'root'), directory = path.join(root, 'coordinator-resume'), handoff = path.join(base, 'handoff.md');
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const health = () => resumeHealth({ root, tasks: { query: async () => null }, env: {} });
  await fs.mkdir(directory, { recursive: true });
  const bare = await health();
  assert.deepEqual(bare.map(row => [row.key, row.ok]), [['resume', false]]);
  assert.ok(!/not found/.test(bare[0].text) && /was selected for wake-ups/.test(bare[0].text), bare[0].text);
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1, cliClients: 'none', handoffFile: handoff }));
  await fs.writeFile(path.join(directory, 'chatgpt-cloud-task.txt'), 'cloud text');
  // The handoff file is part of a cloud-only setup too: missing, it is not "working", and the step names what to do for a path of your own.
  const missing = await health();
  assert.deepEqual(missing.map(row => [row.key, row.ok]), [['cloud-only', true], ['handoff', false]]);
  assert.match(missing[1].text, /\(.*handoff\.md\) is missing\. Next: create that file again, or run setup-auto with --handoff-file/);
  await fs.writeFile(handoff, 'goal');
  const cloud = await health();
  assert.deepEqual(cloud.map(row => [row.key, row.ok]), [['cloud-only', true], ['handoff', true]], 'a deliberate cloud-only setup is not "NOT WORKING"');
  assert.ok(/cloud tasks only/.test(cloud[0].text) && !/not found/.test(cloud[0].text) && !/install Claude Code/.test(cloud[0].text), cloud[0].text);
  assert.match(cloud[0].text, /--resume-cli claude, chatgpt \(Codex\) or both/, 'only values the command accepts');
});

test('the handoff file is made for a cloud-only setup too, and the step doctor prints for a missing one works', async t => {
  const f = await fixture(t), fake = await withClaude(f), handoffFile = path.join(f.root, 'coordinator-resume', 'handoff.md');
  await f.run({ coordinatorResume: { cliClients: 'none', cloudClients: 'chatgpt', handoffFile } });
  assert.ok(await hasFile(handoffFile), 'no command-line program, but the handoff file the cloud text points at exists');
  // Nothing writes the watchdog's cycle file here, so the reminder must not tell the cloud task to exit without it.
  const cloudText = await fs.readFile(path.join(f.root, 'coordinator-resume', 'chatgpt-cloud-task.txt'), 'utf8');
  assert.ok(!/state\.json|superseded or unavailable/.test(cloudText), cloudText);
  await fs.unlink(handoffFile);
  const broken = (await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).find(row => row.key === 'handoff');
  assert.equal(broken.ok, false); assert.match(broken.text, /missing\. Next: run pots install; it makes a new one\./);
  await f.run({}); // the plain install the step names keeps the stored cloud-only choice
  assert.ok(await hasFile(handoffFile), 'pots install made it again');
  assert.ok((await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env })).every(row => row.ok));
});

test('a handoff file at your own path that went missing is named, with a step you can do, and a program at your own path that went missing is named too', async t => {
  const f = await fixture(t), fake = await withClaude(f), handoffFile = path.join(f.base, 'my-notes', 'handoff.md'), claudeExecutable = path.join(f.base, 'my-tools', 'claude.exe');
  await fs.mkdir(path.dirname(handoffFile)); await fs.mkdir(path.dirname(claudeExecutable)); await fs.writeFile(handoffFile, 'goal'); await fs.writeFile(claudeExecutable, 'fake');
  await f.run({ coordinatorResume: { cliClients: 'claude', handoffFile, claudeExecutable } });
  await fs.unlink(handoffFile); await fs.unlink(claudeExecutable);
  const rows = await resumeHealth({ root: f.root, tasks: fake, env: { ...f.deps.env, PATH: path.join(f.base, 'nothing') } });
  assert.match(rows.find(row => row.key === 'handoff').text, new RegExp(`${handoffFile.replace(/[\\.]/g, '\\$&')}\\) is missing\\. Next: create that file again, or run setup-auto with --handoff-file`));
  const program = rows.find(row => row.key === 'program');
  assert.equal(program.ok, false);
  assert.match(program.text, new RegExp(`was not found at ${claudeExecutable.replace(/[\\.]/g, '\\$&')}\\. Next: put it back there, or run setup-auto with --claude-executable set to where it is now`));
  assert.ok(!/install it again/.test(program.text), program.text);
});

// The saved "off" choice next to wake-up files that could not be switched off: what is really still there decides the words.
const offOld = async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-health-'))), root = path.join(base, 'root'), directory = path.join(root, 'coordinator-resume'), control = path.join(directory, 'control');
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1, cliClients: 'claude', handoffFile: path.join(base, 'handoff.md') }));
  await fs.writeFile(path.join(control, 'wakeups-off'), '');
  const health = task => resumeHealth({ root, tasks: { query: async () => task ? resumeTaskMark(root) : null }, env: {} });
  return { root, directory, control, health };
};
test('an old wake-up setup next to a stored "off" choice names only what is really still there: the task, the running watchdog, and the file that stops it', async t => {
  const w = await offOld(t);
  const quiet = await w.health(false);
  assert.deepEqual(quiet.map(row => [row.key, row.ok]), [['off', true]], 'no task and no watchdog: nothing may start an assistant');
  assert.ok(!/may still be started|Disable-Resume/.test(quiet[0].text), quiet[0].text);
  await fs.writeFile(path.join(w.directory, 'Disable-Resume.cmd'), 'x');
  const task = await w.health(true);
  assert.deepEqual(task.map(row => [row.key, row.ok]), [['off-old', true]]);
  assert.match(task[0].text, /but the scheduled task that starts the watchdog is still in place, so an assistant may still be started\. Next: to stop it now, run Disable-Resume\.cmd in /);
  assert.ok(!/watchdog is still running/.test(task[0].text), task[0].text);
  await fs.unlink(path.join(w.directory, 'Disable-Resume.cmd'));
  await fs.writeFile(path.join(w.control, 'launches.jsonl'), '');
  const running = await w.health(false);
  assert.deepEqual(running.map(row => [row.key, row.ok]), [['off-old', true]]);
  assert.match(running[0].text, /but the watchdog is still running, so an assistant may still be started\. Next: to stop it now, create an empty file named disabled in /);
  assert.ok(!/Disable-Resume\.cmd in|scheduled task/.test(running[0].text), running[0].text);
});

test('--no-coordinator-wakeups next to a wake-up file you edited removes the task, and status says nothing may start, not that an old task may still run', async t => {
  const f = await fixture(t), fake = await withClaude(f), config = path.join(f.root, 'coordinator-resume', 'config.json');
  await f.run({});
  await fs.writeFile(config, JSON.stringify({ ...JSON.parse(await fs.readFile(config, 'utf8')), mine: true }));
  await f.run({ coordinatorWakeups: false });
  assert.equal(fake.tasks.size, 0, 'the task is gone');
  const rows = await resumeHealth({ root: f.root, tasks: fake, env: f.deps.env });
  assert.deepEqual(rows.map(row => [row.key, row.ok]), [['off', true]]);
  assert.ok(!/may still/.test(rows[0].text), rows[0].text);
});

test('the install summary says a cloud-only choice was not a missing program, --resume-cli none is not called cloud-only, and a PC with no program says it was not found', async t => {
  const f = await fixture(t), handoffFile = path.join(f.base, 'handoff.md');
  const cloud = await f.run({ coordinatorResume: { cliClients: 'none', cloudClients: 'chatgpt', handoffFile } });
  const line = cloud.summary.find(text => /^Wake-ups:/.test(text));
  assert.match(line, /\(cloud-only\)/); assert.ok(!/was found|not found|--resume-cli none/.test(line), line);
  const h = await fixture(t), off = await h.run({ coordinatorResume: { cliClients: 'none' } });
  const none = off.summary.find(text => /^Wake-ups:/.test(text));
  assert.match(none, /you chose --resume-cli none and no cloud client/); assert.ok(!/cloud-only/.test(none), none);
  const g = await fixture(t), absent = await g.run({});
  assert.match(absent.summary.find(text => /^Wake-ups:/.test(text)), /no Claude Code or Codex was found on this PC/);
});

test('a cut-off last log line is repaired even when Setup leaves the old wake-up files alone, but never while a watchdog is running', async t => {
  const f = await fixture(t), fake = await withClaude(f);
  await f.run({});
  const control = path.join(f.root, 'coordinator-resume', 'control'), log = path.join(control, 'launches.jsonl'), lock = path.join(control, 'watchdog.lock');
  const good = JSON.stringify({ version: 1, time: Date.now(), action: 'suppressed', reason: 'quiet', laneCount: 0 }), damaged = good + '\n' + '{"version":1,"time":12';
  await fs.writeFile(log, damaged);
  await fs.appendFile(path.join(f.root, 'coordinator-resume', 'resume-prompt.txt'), ' '); // a changed file: Setup can no longer prove the old files are its own
  await fs.mkdir(lock);
  assert.equal((await f.run({})).coordinatorResume.leftAsIs, true);
  assert.equal(await fs.readFile(log, 'utf8'), damaged, 'a running watchdog may be writing the log: it is not touched');
  await fs.rmdir(lock);
  assert.equal((await f.run({})).coordinatorResume.leftAsIs, true);
  assert.equal(await fs.readFile(log, 'utf8'), good + '\n', 'the damaged line is repaired');
  assert.equal(fake.tasks.size, 1, 'the old task was not touched');
});

test('a first install whose new folder cannot be made private takes that folder away again, so the next install uses the same folder and never calls it foreign', async t => {
  const f = await fixture(t), permissions = f.deps.permissions, folder = path.join(f.base, 'OMP Session Bridge Local');
  f.deps.permissions = { ...permissions, protect: async () => { throw new Error('synthetic refusal'); } };
  await assert.rejects(autoSetup({ name: 'test' }, f.deps), /synthetic refusal/);
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
  f.deps.permissions = permissions;
  const again = await autoSetup({ name: 'test' }, f.deps);
  assert.equal(again.installRoot, folder);
  assert.equal(JSON.stringify(again).includes('did not make'), false);
});

test('a scanner holding setup.lock at the end does not turn a finished install into an error', async t => {
  const f = await fixture(t), unlink = fs.unlink;
  fs.unlink = async file => { if (path.basename(String(file)) === 'setup.lock') throw Object.assign(new Error('held'), { code: 'EPERM' }); return unlink.call(fs, file); };
  let result;
  try { result = await f.run({ name: 'test' }); } finally { fs.unlink = unlink; }
  assert.ok(result.sessions[0].stateFolder);
});
