import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { autoSetup } from '../src/autosetup.mjs';
import { main } from '../src/cli.mjs';
import { LAUNCHER, LAUNCHER_HASHES, RELEASE_FILES, UPGRADE_ERRORS, startCheck } from '../src/update.mjs';
import { listedRoots, registerInstallation, uninstall } from '../src/uninstall.mjs';
import { unzip, zip } from '../src/zip.mjs';

// Fake older installs are built in a disposable folder from the real runtime files, then the real installer
// upgrades them. Nothing here touches a real install, a real lane, a network or a real assistant app.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8')).version;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.lstat(file).then(() => true, () => false);
const read = file => fs.readFile(file);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-upgrade-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const file = path.join(sessions, 'saved.jsonl'), sessionId = crypto.randomUUID();
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  const root = path.join(base, 'private-setup');
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base }, home: base,
    nodeVersion: process.versions.node, nodeExecutable: process.execPath, locate: async () => process.execPath,
    detect: async () => 'omp/18.8.6',
    startCheck: async () => {}, which: async () => null,
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  const f = { base, root, file, cwd, sessionId, deps, run: (options = {}, over = {}) => autoSetup({ root, name: 'lane', ...options }, { ...deps, ...over }) };
  f.runtime = path.join(root, 'runtime');
  f.managed = path.join(f.runtime, 'current');
  f.state = path.join(root, 'sessions', sessionId);
  f.launcherFolder = path.join(root, 'launchers', 'lane');
  f.pointer = () => json(path.join(f.managed, 'current.json'));
  return f;
}
async function snapshot(dir, skip = () => false) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name), rel = path.relative(dir, full).split(path.sep).join('/');
    if (skip(rel)) continue;
    rows.push([rel, entry.isFile() ? sha(await fs.readFile(full)) : 'dir']);
  }
  return rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

// The file set of an older release: the current files without `drop`, plus `extra`, under the version `label`.
async function olderFiles(label, { drop = [], extra = {}, declare = false } = {}) {
  const files = new Map();
  for (const name of RELEASE_FILES.filter(name => !drop.includes(name))) files.set(name, await read(path.join(CHECKOUT, name)));
  const pkg = JSON.parse(files.get('package.json'));
  delete pkg.runtimeFiles;
  files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, version: label, ...(declare ? { runtimeFiles: [...files.keys(), ...Object.keys(extra)].sort() } : {}) }, null, 2) + '\n'));
  for (const [name, text] of Object.entries(extra)) files.set(name, Buffer.from(text));
  return files;
}
// Released 0.2.11 had 27 files: no lane watcher and no assistant connection module.
const OLDER = { drop: ['src/lane-watch.mjs', 'src/clients.mjs'] };
async function writeVersion(dir, label, files) {
  const record = { version: 1, release: label, digest: 'sha256:' + sha(zip([...files].map(([name, data]) => ({ name, data })))), files: {} };
  for (const [name, data] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
    record.files[name] = sha(data);
    await fs.mkdir(path.dirname(path.join(dir, ...name.split('/'))), { recursive: true });
    await fs.writeFile(path.join(dir, ...name.split('/')), data);
  }
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify(record) + '\n');
  for (const name of [...files.keys(), 'release.json']) await fs.chmod(path.join(dir, ...name.split('/')), 0o444);
}
// Turns the freshly installed managed runtime into an older layout (the launcher, state and launcher folder stay as installed).
async function becomeOlder(f, label, options = OLDER, { previous = null } = {}) {
  await fs.rm(path.join(f.managed, 'versions', VERSION), { recursive: true, force: true });
  await writeVersion(path.join(f.managed, 'versions', label), label, await olderFiles(label, options));
  await fs.writeFile(path.join(f.managed, 'current.json'), JSON.stringify({ version: 1, current: label, previous }) + '\n');
}
// A fixed-folder runtime from before managed installs (runtime/<name>/ with runtime-files.json) and a launcher that uses it.
async function becomeLegacy(f, name, { scriptNote = '' } = {}) {
  const files = await olderFiles('0.2.11', OLDER), dir = path.join(f.runtime, name);
  await fs.rm(f.managed, { recursive: true, force: true });
  const rows = [];
  for (const [file, data] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
    await fs.mkdir(path.dirname(path.join(dir, ...file.split('/'))), { recursive: true });
    await fs.writeFile(path.join(dir, ...file.split('/')), data); rows.push({ name: file, sha256: sha(data) });
  }
  await fs.writeFile(path.join(dir, 'runtime-files.json'), JSON.stringify(rows) + '\n');
  const settingsFile = path.join(f.launcherFolder, 'launch-settings.json'), settings = await json(settingsFile);
  await fs.writeFile(settingsFile, JSON.stringify({ ...settings, cli: path.join(dir, 'bin', 'bridge.mjs') }) + '\n');
  if (scriptNote) await fs.appendFile(path.join(f.launcherFolder, 'Start-OMP.ps1'), scriptNote);
  return dir;
}
const backups = async f => { try { return (await fs.readdir(path.join(f.root, 'backups'), { recursive: true, withFileTypes: true })).filter(e => e.isFile()); } catch { return []; } };

test('upgrade from the released 0.2.11 managed layout: one run, new folder beside the old, pointer backed up and switched, old version untouched', async t => {
  const f = await fixture(t);
  await f.run(); await becomeOlder(f, '0.2.11');
  const oldFolder = path.join(f.managed, 'versions', '0.2.11'), oldBefore = await snapshot(oldFolder), pointerBefore = await read(path.join(f.managed, 'current.json'));
  const launcherBefore = await snapshot(f.launcherFolder), stateBefore = await snapshot(f.state, rel => rel.includes('lane-watch'));
  const result = await f.run();
  assert.equal(result.upgraded, true); assert.equal(result.installed, false);
  assert.equal(result.upgrade.kind, 'upgrade'); assert.equal(result.upgrade.from, '0.2.11'); assert.equal(result.upgrade.to, VERSION);
  assert.equal(result.upgrade.message, `Upgraded to ${VERSION}.`);
  assert.deepEqual(await f.pointer(), { version: 1, current: VERSION, previous: '0.2.11' });
  assert.deepEqual(await snapshot(oldFolder), oldBefore, 'the old version folder is byte-identical');
  assert.equal(path.basename(result.runtimeFolder), VERSION);
  for (const name of RELEASE_FILES) assert.deepEqual(await read(path.join(result.runtimeFolder, name)), await read(path.join(CHECKOUT, name)));
  assert.deepEqual(await snapshot(f.launcherFolder), launcherBefore, 'a managed upgrade needs no launcher change');
  assert.deepEqual(await snapshot(f.state, rel => rel.includes('lane-watch')), stateBefore, 'state, receipts and plans are untouched');
  const kept = await backups(f);
  assert.deepEqual(kept.map(e => e.name).sort(), ['backup-manifest.json', 'current-current.json'], 'the pointer copy and the manifest that proves Setup wrote it');
  const pointerCopy = kept.find(e => e.name !== 'backup-manifest.json');
  assert.deepEqual(await read(path.join(pointerCopy.parentPath ?? pointerCopy.path, pointerCopy.name)), pointerBefore, 'the pointer was backed up before it changed');
  assert.equal(result.summary[0], `Upgraded to ${VERSION}.`);
  // The same setup again changes nothing at all.
  const after = await snapshot(f.root);
  const again = await f.run();
  assert.equal(again.upgrade.kind, 'unchanged'); assert.equal(again.upgraded, false);
  assert.deepEqual(await snapshot(f.root), after);
  // The retained previous version can still be rolled back to by the ordinary command.
  const out = [], code = await main(['update', 'rollback', f.state, '--confirm-offline'], { managed: f.managed, stdout: text => out.push(text), stderr: () => {}, now: () => Date.now(), io: fs, nodeVersion: process.versions.node });
  assert.equal(code, 0, out.join('\n')); assert.equal(JSON.parse(out.join('\n')).status, 'rolled-back');
  assert.equal((await f.pointer()).current, '0.2.11');
});

// A real 0.2.12 Setup that failed late rolled back the new project's config.json, leaving a project folder
// (launch.json, controller record, empty record folders) without it. Connecting again must finish that folder.
test('upgrading a 0.2.11/0.2.12 install whose project folder lost its config.json completes the folder and keeps the project connected', async t => {
  for (const [label, options, run] of [['0.2.12', { declare: true }, {}], ['0.2.11', OLDER, {}], ['0.2.12', { declare: true }, { clients: 'claude', coordinatorWakeups: false }]]) {
    const f = await fixture(t);
    await f.run(run);
    // The failed attempt of the new Setup also left its verified, unused version folder next to the old one.
    const unused = path.join(f.base, 'unused'); await fs.cp(path.join(f.managed, 'versions', VERSION), unused, { recursive: true });
    await becomeOlder(f, label, options); await fs.cp(unused, path.join(f.managed, 'versions', VERSION), { recursive: true });
    await fs.rm(path.join(f.state, 'config.json'));
    const result = await f.run(run);
    assert.equal(result.upgrade.kind, 'upgrade'); assert.equal(result.upgrade.from, label);
    assert.deepEqual(await f.pointer(), { version: 1, current: VERSION, previous: label });
    for (const name of RELEASE_FILES) assert.deepEqual(await read(path.join(result.runtimeFolder, name)), await read(path.join(CHECKOUT, name)));
    assert.equal((await json(path.join(f.state, 'config.json'))).sessionId, f.sessionId);
    assert.ok((await backups(f)).length > 0, 'what was replaced is kept in a backup');
    assert.equal((await f.run(run)).upgrade.kind, 'unchanged');
  }
});

test('upgrade works from any older file list, a dated build folder, or a bigger old list', async t => {
  for (const [label, options] of [['0.2.20', {}], ['0.2.19', {}], ['0.2.18', {}], ['0.2.11-1105', OLDER], ['0.2.10', { drop: [...OLDER.drop, 'src/coordinator-resume.mjs', 'src/coordinator-resume-setup.mjs', 'src/coordinator-heartbeat.mjs', 'src/lane-status.mjs', 'bin/coordinator-resume.mjs'] }],
    ['0.2.9', { ...OLDER, extra: { 'src/retired-module.mjs': 'export const retired = true;\n' } }]]) {
    const f = await fixture(t);
    await f.run(); await becomeOlder(f, label, options);
    const oldFolder = path.join(f.managed, 'versions', label), oldBefore = await snapshot(oldFolder);
    const result = await f.run();
    assert.equal(result.upgrade.kind, 'upgrade', label);
    assert.deepEqual(await f.pointer(), { version: 1, current: VERSION, previous: label }, label);
    assert.deepEqual(await snapshot(oldFolder), oldBefore, label);
    assert.equal((await f.run()).upgrade.kind, 'unchanged', label);
  }
});

test('a lane running from the old files is never touched: its open files keep their bytes and the upgrade still completes', async t => {
  const f = await fixture(t);
  await f.run(); await becomeOlder(f, '0.2.11');
  const oldFolder = path.join(f.managed, 'versions', '0.2.11');
  const held = ['src/cli.mjs', 'extension/bridge.ts', 'src/control.mjs'].map(name => path.join(oldFolder, ...name.split('/')));
  const expected = await Promise.all(held.map(async file => sha(await read(file))));
  const lane = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'), crypto = require('node:crypto');
    const handles = process.argv.slice(1).map(file => fs.openSync(file, 'r'));
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      process.stdout.write(JSON.stringify(handles.map(fd => crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex'))) + '\\n');
      process.exit(0);
    });`, ...held], { cwd: oldFolder, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => lane.kill());
  let output = ''; lane.stdout.on('data', chunk => { output += chunk; });
  const until = async predicate => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(predicate()); };
  await until(() => output.includes('ready'));
  // The lane's own supervisor lock, as the real bridge holds it.
  await fs.writeFile(path.join(f.state, `supervisor-${f.sessionId}.lock`), JSON.stringify({ version: 1, pid: lane.pid, startedAt: 1, sessionId: f.sessionId }));
  const oldBefore = await snapshot(oldFolder);
  const result = await f.run({}, { openSessions: async () => 1 });
  assert.equal(result.upgrade.kind, 'upgrade');
  assert.equal(result.upgrade.message, `Upgraded to ${VERSION}. A session is open, so the new version starts with the next session.`);
  assert.deepEqual(await f.pointer(), { version: 1, current: VERSION, previous: '0.2.11' });
  assert.deepEqual(await snapshot(oldFolder), oldBefore);
  lane.stdin.write('go\n');
  await until(() => output.trim().split('\n').length >= 2);
  assert.deepEqual(JSON.parse(output.trim().split('\n')[1]), expected, 'the running lane still reads the original bytes through its handles');
  assert.equal(await exists(path.join(f.state, `supervisor-${f.sessionId}.lock`)), true, 'its lock was not touched');
});

test('a fixed-folder runtime (any folder name) is left in place; the new copy is built beside it and the launcher is switched with a backup', async t => {
  for (const name of ['0.2.11', 'fix15-20261030']) {
    const f = await fixture(t);
    await f.run();
    const oldDir = await becomeLegacy(f, name, { scriptNote: '# older launcher text\n' });
    const oldBefore = await snapshot(oldDir), settingsBefore = await read(path.join(f.launcherFolder, 'launch-settings.json')), scriptBefore = await read(path.join(f.launcherFolder, 'Start-OMP.ps1'));
    const result = await f.run();
    assert.equal(result.upgrade.kind, 'fresh', name); assert.equal(result.upgrade.launcherSwitched, true, name);
    assert.deepEqual(await snapshot(oldDir), oldBefore, name + ': the old folder is byte-identical');
    assert.equal((await json(path.join(f.launcherFolder, 'launch-settings.json'))).cli, path.join(f.managed, 'bridge.mjs'), name);
    assert.ok((await read(path.join(f.launcherFolder, 'Start-OMP.ps1'))).toString().startsWith("$ErrorActionPreference='Stop'"), name);
    const kept = new Map(await Promise.all((await backups(f)).map(async e => [e.name, await read(path.join(e.parentPath ?? e.path, e.name))])));
    assert.deepEqual(kept.get('launcher-lane-launch-settings.json'), settingsBefore, name);
    assert.deepEqual(kept.get('launcher-lane-Start-OMP.ps1'), scriptBefore, name);
    const done = await snapshot(f.root), again = await f.run();
    assert.equal(again.upgrade.kind, 'unchanged', name); assert.deepEqual(await snapshot(f.root), done, name);
  }
});

test('an interrupted runtime folder is moved aside and rebuilt; one that is not ours stops the setup', async t => {
  const f = await fixture(t);
  await f.run();
  await fs.writeFile(path.join(f.managed, 'current.json'), '{ not json');
  const before = await snapshot(f.managed);
  const result = await f.run();
  assert.equal(result.upgrade.kind, 'fresh'); assert.equal(result.cliLauncher, path.join(f.managed, 'bridge.mjs'));
  const aside = (await fs.readdir(f.runtime)).filter(n => n.startsWith('managed-'));
  assert.equal(aside.length, 1); assert.deepEqual(await snapshot(path.join(f.runtime, aside[0])), before, 'the unreadable folder is kept as it was');
  assert.equal((await f.run()).upgrade.kind, 'unchanged');

  const g = await fixture(t);
  await g.run();
  await fs.writeFile(path.join(g.managed, 'bridge.mjs'), 'someone else\n');
  await fs.writeFile(path.join(g.managed, 'current.json'), '{ not json');
  const frozen = await snapshot(g.root);
  await assert.rejects(g.run(), /was not created by this Setup, so nothing was changed/);
  assert.deepEqual(await snapshot(g.root), frozen);
});

test('same version number with different files is refused with nothing changed; a newer installed version is kept', async t => {
  const f = await fixture(t);
  await f.run();
  await fs.chmod(path.join(f.managed, 'versions', VERSION, 'src', 'zip.mjs'), 0o666);
  const rows = await json(path.join(f.managed, 'versions', VERSION, 'release.json'));
  const altered = Buffer.from('export const different = true;\n');
  await fs.writeFile(path.join(f.managed, 'versions', VERSION, 'src', 'zip.mjs'), altered);
  rows.files['src/zip.mjs'] = sha(altered);
  await fs.chmod(path.join(f.managed, 'versions', VERSION, 'release.json'), 0o666);
  await fs.writeFile(path.join(f.managed, 'versions', VERSION, 'release.json'), JSON.stringify(rows) + '\n');
  const before = await snapshot(f.root);
  await assert.rejects(f.run(), error => error.message === UPGRADE_ERRORS.sameVersion);
  assert.deepEqual(await snapshot(f.root), before);

  const g = await fixture(t);
  await g.run();
  const newer = await olderFiles('99.0.0'); await writeVersion(path.join(g.managed, 'versions', '99.0.0'), '99.0.0', newer);
  await fs.writeFile(path.join(g.managed, 'current.json'), JSON.stringify({ version: 1, current: '99.0.0', previous: VERSION }) + '\n');
  const kept = await snapshot(g.root), result = await g.run();
  assert.equal(result.upgrade.kind, 'newer-kept'); assert.equal(path.basename(result.runtimeFolder), '99.0.0');
  assert.deepEqual(await snapshot(g.root), kept);
});

// Every failing step leaves the old version working and every owned file byte-identical.
test('failure at each step switches nothing and leaves the old install exactly as it was', async t => {
  const stateSkip = rel => rel.includes('lane-watch');
  const steps = [
    ['start check fails', { startCheck: async () => { throw new Error(UPGRADE_ERRORS.startCheck); } }, UPGRADE_ERRORS.startCheck, false],
    ['the pointer cannot be written', { updateIo: { ...fs, rename: async (from, to) => { if (String(to).endsWith('current.json')) throw Object.assign(new Error('fake'), { code: 'EPERM' }); return fs.rename(from, to); } } }, UPGRADE_ERRORS.switched, false],
    ['a later step fails after the switch', { registerUninstall: async () => { throw new Error('synthetic registry refusal'); } }, 'synthetic registry refusal', true],
    ['the new copy is damaged before the switch', { startCheck: async dir => { const file = path.join(dir, 'src', 'zip.mjs'); await fs.chmod(file, 0o666); await fs.writeFile(file, 'damaged in between'); } }, UPGRADE_ERRORS.stage, false, false],
  ];
  for (const [label, over, message, switched, completes = true] of steps) {
    const f = await fixture(t);
    await f.run(); await becomeOlder(f, '0.2.11');
    const before = await snapshot(f.root, stateSkip);
    await assert.rejects(f.run({}, over), error => error.message === message, label);
    assert.deepEqual(await f.pointer(), { version: 1, current: '0.2.11', previous: null }, label);
    const after = await snapshot(f.root, stateSkip);
    // The only difference allowed is the verified, unused new version folder (and the pointer backup that was taken before the switch).
    const extra = after.filter(([rel]) => !before.some(([old]) => old === rel)).map(([rel]) => rel);
    assert.ok(extra.every(rel => rel.startsWith(`runtime/current/versions/${VERSION}`) || rel.startsWith('backups')), label + ': ' + extra.join(','));
    assert.deepEqual(before.filter(([rel]) => !rel.startsWith('backups')).filter(row => !after.some(([rel, hash]) => rel === row[0] && hash === row[1])), [], label + ': nothing that existed changed');
    assert.equal(await exists(path.join(f.managed, 'activate.lock')), false, label + ': no stale install lock');
    // The next run, with nothing failing, completes the upgrade; a damaged new folder is reported, never trusted or replaced.
    if (completes) assert.equal((await f.run()).upgrade.kind, 'upgrade', label);
    else await assert.rejects(f.run(), error => error.message === UPGRADE_ERRORS.damaged, label);
  }
});

test('a failure after a legacy launcher switch puts the old launcher files back', async t => {
  const f = await fixture(t);
  await f.run(); const oldDir = await becomeLegacy(f, '0.2.11', { scriptNote: '# older launcher text\n' });
  const oldBefore = await snapshot(oldDir), launcherBefore = await snapshot(f.launcherFolder);
  await assert.rejects(f.run({}, { registerUninstall: async () => { throw new Error('synthetic registry refusal'); } }), /synthetic registry refusal/);
  assert.deepEqual(await snapshot(f.launcherFolder), launcherBefore);
  assert.deepEqual(await snapshot(oldDir), oldBefore);
});

test('the real start check accepts the installed copy and refuses a broken one', async t => {
  const f = await fixture(t);
  await f.run({}, { startCheck: undefined });
  await startCheck(path.join(f.managed, 'versions', VERSION));
  const broken = path.join(f.base, 'broken'); await fs.cp(path.join(f.managed, 'versions', VERSION), broken, { recursive: true });
  await fs.chmod(path.join(broken, 'src', 'zip.mjs'), 0o666); await fs.writeFile(path.join(broken, 'src', 'zip.mjs'), 'throw new Error("broken");\n');
  await assert.rejects(startCheck(broken), error => error.message === UPGRADE_ERRORS.startCheck);
});

test('the packaged runtime list and the list the bundle declares are one list', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8'));
  assert.deepEqual([...pkg.runtimeFiles].sort(), [...RELEASE_FILES]);
  for (const name of RELEASE_FILES) assert.ok(await exists(path.join(CHECKOUT, name)), name);
  const entries = unzip(zip(RELEASE_FILES.map(name => ({ name, data: Buffer.from('x') }))));
  assert.equal(entries.length, RELEASE_FILES.length);
});

test('an update that is already running (or was interrupted) is never stolen from: the upgrade stops, switches nothing and leaves its lock', async t => {
  const f = await fixture(t);
  await f.run(); await becomeOlder(f, '0.2.11');
  const lock = path.join(f.managed, 'activate.lock'); await fs.writeFile(lock, '');
  const pointer = await read(path.join(f.managed, 'current.json'));
  await assert.rejects(f.run(), error => error.message === UPGRADE_ERRORS.busy);
  assert.deepEqual(await read(path.join(f.managed, 'current.json')), pointer);
  assert.equal(await exists(lock), true, 'the other update lock was left alone');
  await fs.unlink(lock);
  assert.equal((await f.run()).upgrade.kind, 'upgrade');
});

test('an upgrade lock left by a process that no longer exists does not block the upgrade; one held by a running process still does', async t => {
  const f = await fixture(t);
  await f.run(); await becomeOlder(f, '0.2.11');
  const lock = path.join(f.managed, 'activate.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.run(), error => error.message === UPGRADE_ERRORS.busy);
  assert.equal(await exists(lock), true, 'a live owner keeps its lock');
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise(resolve => child.on('exit', resolve));
  await fs.writeFile(lock, JSON.stringify({ pid: child.pid }));
  assert.equal((await f.run()).upgrade.kind, 'upgrade');
  assert.equal(await exists(lock), false, 'the upgrade took the dead owner\'s lock over and released it');
});

test('the uninstall program copied into the install folder starts from there (every file it imports is next to it)', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) };
  await f.run({}, { registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) });
  const out = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(f.root, 'uninstall.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
    child.on('exit', code => resolve({ code, text }));
  });
  assert.match(out.text, /^uninstall usage:/, out.text);
});

test('a Setup run that fails after the helper files were copied does not block the next run or uninstall', async t => {
  const f = await fixture(t), rows = new Map(); let refuse = false;
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => { if (refuse) throw new Error('synthetic registry refusal'); rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); },
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const register = (root, options) => registerInstallation(root, { ...options, registry });
  await f.run({}, { registerUninstall: register });
  // An install made by 0.2.17: only uninstall.mjs next to the record, the two imports not there yet.
  const recordFile = path.join(f.root, 'uninstall-record.json'), record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  for (const name of ['clients.mjs', 'control.mjs']) { await fs.unlink(path.join(f.root, name)); delete record.software[name]; }
  await fs.writeFile(recordFile, JSON.stringify(record, null, 2) + '\n');
  await becomeOlder(f, '0.2.11');
  refuse = true;
  await assert.rejects(f.run({}, { registerUninstall: register }), /uninstall registration failed/);
  assert.equal(await exists(path.join(f.root, 'clients.mjs')), false, 'the failed run took its copy back out');
  refuse = false;
  const again = await f.run({}, { registerUninstall: register });
  assert.ok(!again.summary.some(line => /could not be checked/.test(line)), 'the record was updated, not skipped');
  const after = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  assert.ok(after.software['clients.mjs'] && after.software['control.mjs'], 'both helper files are listed again');
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => root + '-recovered',
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const preview = await uninstall(f.root, {}, deps);
  assert.equal(preview.status, 'preview', JSON.stringify(preview));
});

// A second build whose three helper files have other bytes: a copy of src with a comment added to each.
async function otherBuild(f) {
  const dir = path.join(f.base, 'build-a'); await fs.cp(path.join(CHECKOUT, 'src'), path.join(dir, 'src'), { recursive: true });
  await fs.copyFile(path.join(CHECKOUT, 'package.json'), path.join(dir, 'package.json'));
  for (const name of ['uninstall.mjs', 'clients.mjs', 'control.mjs']) await fs.appendFile(path.join(dir, 'src', name), '\n// build A\n');
  return (await import(pathToFileURL(path.join(dir, 'src', 'uninstall.mjs')).href)).registerInstallation;
}

test('a failed Setup run of one build does not block a retry with a different build or uninstall', async t => {
  const f = await fixture(t), rows = new Map(); let refuse = false;
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => { if (refuse) throw new Error('synthetic registry refusal'); rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); },
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const registerB = (root, options) => registerInstallation(root, { ...options, registry });
  await f.run({}, { registerUninstall: registerB }); await becomeOlder(f, '0.2.11');
  const registerA = await otherBuild(f); refuse = true;
  await assert.rejects(f.run({}, { registerUninstall: (root, options) => registerA(root, { ...options, registry }) }), /uninstall registration failed/);
  refuse = false;
  const again = await f.run({}, { registerUninstall: registerB });
  assert.ok(!again.summary.some(line => /could not be checked/.test(line)), 'the record was updated, not skipped');
  const after = await json(path.join(f.root, 'uninstall-record.json'));
  for (const name of ['uninstall.mjs', 'clients.mjs', 'control.mjs']) assert.ok(after.software[name], name + ' is listed');
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => root + '-recovered',
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const preview = await uninstall(f.root, {}, deps);
  assert.equal(preview.status, 'preview', JSON.stringify(preview));
});

test('an edited helper file is kept as it is, not claimed, and uninstall lists it instead of deleting it', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) };
  await f.run({}, { registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) });
  const file = path.join(f.root, 'control.mjs'); await fs.appendFile(file, '\n// edited by hand\n');
  const edited = await read(file);
  await registerInstallation(f.root, { registry });
  assert.deepEqual(await read(file), edited, 'the edited file was not overwritten');
  assert.equal((await json(path.join(f.root, 'uninstall-record.json'))).software['control.mjs'], undefined, 'and it is not claimed');
  const deps = { platform: 'win32', registry: { ...registry, list: async () => [...rows.values()].map(row => row.root) }, processes: async () => [], permissions: f.deps.permissions, recover: async root => root + '-recovered',
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const preview = await uninstall(f.root, {}, deps);
  assert.deepEqual([preview.status, preview.installations[0].reason, preview.installations[0].items.includes('control.mjs')], ['blocked', 'unverified-files', true]);
});

test('a failed registration leaves the install folder exactly as it was', async t => {
  const f = await fixture(t), rows = new Map(); let refuse = false;
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => { if (refuse) throw new Error('synthetic registry refusal'); rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); } };
  await f.run({}, { registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) });
  // An older install: clients.mjs missing (and unlisted), uninstall.mjs different but listed.
  const recordFile = path.join(f.root, 'uninstall-record.json'), record = await json(recordFile);
  await fs.unlink(path.join(f.root, 'clients.mjs')); delete record.software['clients.mjs'];
  await fs.writeFile(path.join(f.root, 'uninstall.mjs'), 'older uninstall program\n'); record.software['uninstall.mjs'] = sha(Buffer.from('older uninstall program\n'));
  await fs.writeFile(recordFile, JSON.stringify(record, null, 2) + '\n');
  const before = await snapshot(f.root); refuse = true;
  await assert.rejects(registerInstallation(f.root, { registry }), /uninstall registration failed/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('a Setup run that fails after registration finished also takes the helper copies back out', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) };
  await f.run({}, { registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) }); await becomeOlder(f, '0.2.11');
  const skip = rel => !/^(uninstall|clients|control)\.mjs$|^uninstall-record\.json$/.test(rel), before = await snapshot(f.root, skip);
  const registerA = await otherBuild(f), later = async (root, options) => { await registerA(root, { ...options, registry }); throw new Error('synthetic late failure'); };
  await assert.rejects(f.run({}, { registerUninstall: later }), /synthetic late failure|registration failed/);
  assert.deepEqual(await snapshot(f.root, skip), before);
});

test('when a rollback step itself fails, the plain registration message is kept and the files not put back are named', async t => {
  const f = await fixture(t), rows = new Map(); let refuse = false;
  const file = name => path.join(f.root, name);
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => { if (refuse) { await fs.chmod(file('uninstall.mjs'), 0o444); throw new Error('synthetic registry refusal'); } rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); } };
  await f.run({}, { registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) });
  const recordFile = file('uninstall-record.json'), record = await json(recordFile);
  await fs.unlink(file('clients.mjs')); delete record.software['clients.mjs'];
  await fs.writeFile(file('uninstall.mjs'), 'older uninstall program\n'); record.software['uninstall.mjs'] = sha(Buffer.from('older uninstall program\n'));
  await fs.writeFile(recordFile, JSON.stringify(record, null, 2) + '\n');
  refuse = true;
  try {
    await assert.rejects(registerInstallation(f.root, { registry }), error => /uninstall registration failed; setup retained, rerun setup to repair/.test(error.message) && JSON.stringify(error.left) === '["uninstall.mjs"]');
    assert.equal(await exists(file('clients.mjs')), false, 'the other files were still put back after one could not be');
  } finally { await fs.chmod(file('uninstall.mjs'), 0o666); }
});

test('a half-written Installed-apps entry (no root, no command) is repaired by the next Setup run and does not block uninstall', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const register = (root, options) => registerInstallation(root, { ...options, registry });
  await f.run({}, { registerUninstall: register });
  const [id] = [...rows.keys()]; rows.set(id, { root: null, command: null });
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => root + '-recovered',
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  assert.equal((await uninstall(f.root, {}, deps)).status, 'preview', 'a half-written entry does not block the uninstall preview');
  assert.equal((await uninstall(f.root, { all: true }, deps)).status, 'preview', 'the command Windows runs (--all) is not blocked by a half-written entry');
  assert.deepEqual(await listedRoots(deps), [], 'the --ui window reads the same list and gets no empty entry to trip over');
  await f.run({}, { registerUninstall: register });
  assert.equal(rows.get(id).root, f.root, 'the entry was written again');
  assert.equal((await uninstall(f.root, {}, deps)).status, 'preview');
});

test('an upgraded install uninstalls cleanly: both versions and the backups are recognised as owned', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const register = (root, options) => registerInstallation(root, { ...options, registry });
  await f.run({}, { registerUninstall: register }); await becomeOlder(f, '0.2.11');
  await f.run({}, { registerUninstall: register });
  assert.ok((await backups(f)).length > 0);
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const preview = await uninstall(f.root, {}, deps);
  assert.equal(preview.status, 'preview', JSON.stringify(preview));
  const done = await uninstall(f.root, { confirmOffline: true }, deps);
  assert.equal(done.status, 'uninstalled', JSON.stringify(done));
});

test('a runtime-shaped file that no release manifest lists is never claimed as owned software', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }), remove: async id => rows.delete(id) };
  let options; await f.run({}, { registerUninstall: async (root, given) => { options = given; return {}; } });
  // Control: the genuine install registers; then the record is dropped so the next registration classifies every file afresh.
  await registerInstallation(f.root, { ...options, registry });
  await fs.unlink(path.join(f.root, 'uninstall-record.json'));
  const stray = path.join(f.managed, 'versions', VERSION, 'src', 'stray.mjs');
  await fs.writeFile(stray, 'export const stray = true;\n');
  await registerInstallation(f.root, { ...options, registry });
  const record = JSON.parse(await fs.readFile(path.join(f.root, 'uninstall-record.json'), 'utf8'));
  assert.equal(Object.keys(record.software).some(name => name.endsWith('stray.mjs')), false, 'the stray file is not recorded as ours, so uninstall will list it and leave it');
  assert.ok(Object.keys(record.software).some(name => name.endsWith('src/cli.mjs')), 'the genuine files still are');
});

test('a failed attempt removes only what it created: a file somebody added meanwhile is never deleted', async t => {
  const failing = async () => { throw new Error(UPGRADE_ERRORS.startCheck); };
  const f = await fixture(t);
  await assert.rejects(f.run({}, { startCheck: failing }), error => error.message === UPGRADE_ERRORS.startCheck);
  assert.equal(await exists(f.managed), false, 'nothing half-made is left after a failed first install');
  const g = await fixture(t), note = path.join(g.managed, 'note.txt');
  await assert.rejects(g.run({}, { startCheck: async () => { await fs.writeFile(note, 'mine'); throw new Error(UPGRADE_ERRORS.startCheck); } }), error => error.message === UPGRADE_ERRORS.startCheck);
  assert.equal(await read(note).then(String), 'mine', 'a file added meanwhile survives a failed first install');
  assert.equal(await exists(path.join(g.managed, 'bridge.mjs')), true, 'everything of ours stays when something foreign is present, so the next run still recognises the folder');
  const again = await g.run();
  assert.equal(again.upgrade.kind, 'fresh');
  const moved = (await fs.readdir(g.runtime)).find(n => n.startsWith('managed-'));
  assert.equal(await read(path.join(g.runtime, moved, 'note.txt')).then(String), 'mine', 'the foreign file is kept in the moved folder');
  const h = await fixture(t);
  await h.run(); await becomeOlder(h, '0.2.11');
  const extra = path.join(h.managed, 'versions', VERSION, 'src', 'added-meanwhile.mjs');
  await assert.rejects(h.run({}, { startCheck: async dir => { await fs.writeFile(extra, 'mine'); throw new Error(UPGRADE_ERRORS.startCheck); } }), error => error.message === UPGRADE_ERRORS.startCheck);
  assert.equal(await read(extra).then(String), 'mine', 'a file added meanwhile survives a failed upgrade');
  assert.deepEqual(await h.pointer(), { version: 1, current: '0.2.11', previous: null });
  // Edited rather than added: a staged file that no longer matches what Setup wrote is not Setup's to delete either.
  const k = await fixture(t);
  await assert.rejects(k.run({}, { startCheck: async dir => { const file = path.join(dir, 'src', 'zip.mjs'); await fs.chmod(file, 0o666); await fs.writeFile(file, 'edited by the owner'); throw new Error(UPGRADE_ERRORS.startCheck); } }), error => error.message === UPGRADE_ERRORS.startCheck);
  assert.equal(await read(path.join(k.managed, 'versions', VERSION, 'src', 'zip.mjs')).then(String), 'edited by the owner');
  assert.equal(await exists(path.join(k.managed, 'versions', VERSION, 'src', 'autosetup.mjs')), true, 'cleanup that declines leaves the other staged files in place');
});

// ---------------------------------------------------------------------------------------------------- backups folder
const NEWER = 'T000000Z';
const backupFolders = async f => (await fs.readdir(path.join(f.root, 'backups'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
// One upgrade from a distinct older version, at a chosen time, so that it writes one new backup folder named after that time.
// Backups are only removed by a run that has a process finder; these tests give it one that sees nothing running.
const FINDER = { processes: async () => [] };
async function upgradeAt(f, n, time, over = {}) {
  await becomeOlder(f, `0.1.${n}`);
  return f.run({}, { ...FINDER, now: () => time, ...over });
}
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

test('backups of earlier runs are removed after each successful run; only the run\'s own copies stay, and uninstall still recognises the folder', async t => {
  const f = await fixture(t), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const register = (root, options) => registerInstallation(root, { ...options, registry });
  await f.run({}, { ...FINDER, registry, registerUninstall: register });
  const start = Date.UTC(2026, 10, 1, 8), times = [];
  for (let n = 0; n < 7; n++) {
    times.push(start + n * 60000);
    const result = await upgradeAt(f, n, times[n], { registry, registerUninstall: register });
    assert.equal(result.upgrade.kind, 'upgrade');
    assert.equal((await backupFolders(f)).length, 1, 'after upgrade ' + (n + 1));
    assert.equal(result.backupsRemoved, n >= 1 ? 1 : 0);
  }
  assert.deepEqual(await backupFolders(f), [stamp(times[6])], 'the last run\'s own copies are what is left');
  for (const name of await backupFolders(f)) {
    const folder = path.join(f.root, 'backups', name), manifest = await json(path.join(folder, 'backup-manifest.json'));
    assert.deepEqual(Object.keys(manifest.files), [`current-current.json`]);
    for (const [file, digest] of Object.entries(manifest.files)) assert.equal(sha(await read(path.join(folder, file))), digest);
  }
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const done = await uninstall(f.root, { confirmOffline: true }, deps);
  assert.equal(done.status, 'uninstalled', JSON.stringify(done));
});

test('an older backup folder is deleted only when everything in it is provably what Setup wrote; anything else stays and is listed', async t => {
  const f = await fixture(t);
  await f.run({}, FINDER);
  const first = await upgradeAt(f, 0, Date.UTC(2026, 10, 1, 8));
  assert.equal(first.upgrade.kind, 'upgrade');
  const real = path.join(f.root, 'backups', (await backupFolders(f))[0]), base = path.join(f.root, 'backups');
  const copy = async name => { await fs.cp(real, path.join(base, name), { recursive: true }); return path.join(base, name); };
  // One intact copy, and four that Setup cannot prove it wrote.
  const intact = await copy('20250101T000000Z');
  const extra = await copy('20250102T000000Z'); await fs.writeFile(path.join(extra, 'notes.txt'), 'the owner wrote this');
  const unlisted = await copy('20250103T000000Z'); await fs.rm(path.join(unlisted, 'backup-manifest.json'));
  // Two files listed; the one that comes last was changed afterwards. Nothing in the folder may be deleted, not even the first, intact one.
  const edited = await copy('20250104T000000Z'), pointerCopy = `current-current.json`;
  const manifestFile = path.join(edited, 'backup-manifest.json'), manifest = await json(manifestFile), second = Buffer.from('{"second":true}\n');
  await fs.writeFile(path.join(edited, 'zz-second.json'), second); manifest.files['zz-second.json'] = sha(second);
  await fs.writeFile(manifestFile, JSON.stringify(manifest) + '\n'); await fs.appendFile(path.join(edited, 'zz-second.json'), ' ');
  const nested = await copy('20250105T000000Z'); await fs.mkdir(path.join(nested, 'sub'));
  await fs.mkdir(path.join(base, 'my-own-notes'));
  for (let n = 0; n < 5; n++) await copy(`2026060${n + 1}${NEWER}`);
  const result = await upgradeAt(f, 1, Date.UTC(2026, 10, 2, 8));
  assert.equal(result.upgrade.kind, 'upgrade');
  const left = await backupFolders(f);
  assert.equal(await exists(intact), false, 'the provable old folder was removed');
  assert.equal(await read(path.join(extra, 'notes.txt')).then(String), 'the owner wrote this', 'a folder holding something Setup did not write is kept whole');
  assert.deepEqual((await fs.readdir(extra)).sort(), ['backup-manifest.json', pointerCopy, 'notes.txt'], 'nothing in it was deleted, not even the files Setup wrote');
  assert.equal(await exists(unlisted), true, 'a folder without a manifest (nothing proves it) is kept');
  assert.deepEqual((await fs.readdir(edited)).sort(), ['backup-manifest.json', pointerCopy, 'zz-second.json'], 'a copy that no longer matches what Setup wrote keeps the whole folder, including the intact file');
  assert.equal(await exists(path.join(nested, 'sub')), true, 'a folder holding a sub-folder is kept');
  assert.ok(left.includes('my-own-notes'), 'a folder that is not named like a backup is never counted or touched');
  // Every provable folder of an earlier run is gone (the first upgrade's own copy and the five newer-named ones); this run's copy stays.
  assert.deepEqual(left.filter(name => /^2026/.test(name)), [stamp(Date.UTC(2026, 10, 2, 8))], 'only this run\'s own copies are left of the provable ones');
  assert.equal(result.backupsRemoved, 7);
  assert.deepEqual(result.cleanup.left.map(row => row.path).sort(), [extra, unlisted, edited, nested].sort(), 'what stays is listed');
  assert.ok(result.cleanup.left.every(row => row.reason === 'Setup cannot prove it wrote everything in it'), JSON.stringify(result.cleanup.left));
  assert.ok(result.summary.some(line => line.startsWith('left alone: ' + extra)));
});

test('nothing is removed when the run fails: older backups stay until a run has succeeded', async t => {
  const f = await fixture(t);
  await f.run({}, FINDER);
  await upgradeAt(f, 0, Date.UTC(2026, 10, 1, 8));
  const base = path.join(f.root, 'backups'), real = path.join(base, (await backupFolders(f))[0]);
  for (let n = 1; n <= 6; n++) await fs.cp(real, path.join(base, `2026010${n}${NEWER}`), { recursive: true });
  const before = await backupFolders(f);
  await becomeOlder(f, '0.1.1');
  await assert.rejects(f.run({}, { ...FINDER, now: () => Date.UTC(2026, 10, 2, 8), registerUninstall: async () => { throw new Error('synthetic registry refusal'); } }), /synthetic registry refusal/);
  const after = await backupFolders(f);
  assert.deepEqual(before.filter(name => !after.includes(name)), [], 'every folder that was there is still there');
  assert.equal((await f.run({}, { ...FINDER, now: () => Date.UTC(2026, 10, 3, 8) })).upgrade.kind, 'upgrade');
  assert.equal((await backupFolders(f)).length, 1, 'after a successful run only that run\'s own copies are left');
});

test('a backup folder that cannot be made private is taken away again, so no empty folder is left to stop the next run', async t => {
  const f = await fixture(t);
  await f.run({}, FINDER);
  const { protect } = f.deps.permissions, backupsFolder = path.join(f.root, 'backups');
  const refusing = { ...f.deps.permissions, protect: async (target, directory) => { if (path.dirname(target) === backupsFolder) throw new Error('synthetic permission refusal'); return protect(target, directory); } };
  await becomeOlder(f, '0.1.0');
  await assert.rejects(f.run({}, { ...FINDER, now: () => Date.UTC(2026, 10, 1, 8), permissions: refusing }), /synthetic permission refusal/);
  assert.deepEqual(await backupFolders(f), [], 'no empty dated folder is left');
  assert.equal((await f.run({}, { ...FINDER, now: () => Date.UTC(2026, 10, 2, 8) })).upgrade.kind, 'upgrade');
});

test('a launcher folder left empty by a cut-off install is filled in by the next run, and a launcher that could not be written leaves no folder behind', async t => {
  const f = await fixture(t);
  // The disk fills while the launcher script is written: the folder made for it is removed again.
  const original = fs.writeFile;
  fs.writeFile = async (file, ...rest) => { if (String(file).endsWith('Start-OMP.ps1')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); return original(file, ...rest); };
  try { await assert.rejects(f.run(), { code: 'ENOSPC' }); } finally { fs.writeFile = original; }
  assert.equal(await exists(f.launcherFolder), false, 'no half-made launcher folder');
  await f.run();
  const script = path.join(f.launcherFolder, 'Start-OMP.ps1'), settings = path.join(f.launcherFolder, 'launch-settings.json'), kept = await read(script);
  // An empty folder from an earlier cut-off (the power went before either file was written) is not a reason to stop.
  await fs.rm(script); await fs.rm(settings);
  await f.run();
  assert.deepEqual(await read(script), kept);
  assert.equal(await exists(settings), true);
});

// ------------------------------------------------------------------------------------------------ failed stage write
// Disk full: the Nth file written into the staging folder gets half of its bytes and then a write error.
const diskFull = after => {
  let opened = 0;
  return { ...fs, open: async (file, ...rest) => {
    const handle = await fs.open(file, ...rest);
    if (!String(file).includes(path.sep + 'staging' + path.sep) || ++opened <= after) return handle;
    return { writeFile: async data => { await handle.writeFile(data.subarray(0, Math.floor(data.length / 2))); throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); },
      sync: () => handle.sync(), close: () => handle.close() };
  } };
};

test('a write error while the new version is staged (disk full) changes nothing that existed, removes what was created, and says so in plain words', async t => {
  // Before the first file, in the middle, and at the record that is written last.
  for (const after of [0, 3, RELEASE_FILES.length]) {
    const f = await fixture(t);
    await f.run(); await becomeOlder(f, '0.2.11');
    const before = await snapshot(f.root);
    await assert.rejects(f.run({}, { updateIo: diskFull(after) }), error => error.message === UPGRADE_ERRORS.stage && !/ENOSPC|space|errno|\bat \w/.test(error.message), 'write error ' + after);
    assert.deepEqual(await snapshot(f.root), before, 'nothing existing changed and nothing half-made is left (' + after + ')');
    assert.deepEqual(await f.pointer(), { version: 1, current: '0.2.11', previous: null });
    assert.equal((await f.run()).upgrade.kind, 'upgrade', 'the next run, with room again, completes the upgrade');
    assert.equal(await exists(path.join(f.managed, 'activate.lock')), false);
  }
  // A first install: the half-built install folder is removed, the next run starts clean.
  const g = await fixture(t);
  await assert.rejects(g.run({}, { updateIo: diskFull(3) }), error => error.message === UPGRADE_ERRORS.stage);
  assert.equal(await exists(g.managed), false, 'no half-made install folder');
  assert.equal((await g.run()).upgrade.kind, 'fresh');
});

// An older build's launcher script and uninstall program, as that build's own record listed them.
async function recordOlderFiles(f) {
  const recordFile = path.join(f.root, 'uninstall-record.json'), record = await json(recordFile);
  for (const [file, name] of [[path.join(f.launcherFolder, 'Start-OMP.ps1'), 'launchers/lane/Start-OMP.ps1'], [path.join(f.root, 'uninstall.mjs'), 'uninstall.mjs']]) {
    await fs.appendFile(file, '\n# older build\n'); record.software[name] = sha(await read(file));
  }
  await fs.writeFile(recordFile, JSON.stringify(record, null, 2) + '\n');
}
function registered() {
  const rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  return { registry, register: (root, options) => registerInstallation(root, { ...options, registry }),
    deps: f => ({ platform: 'win32', registry, processes: async () => [], permissions: f.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
      integration: { read: async () => null, remove: async () => {} }, audit: async () => [] }) };
}

test('a newer Setup over files an older build wrote and recorded replaces them, records the new bytes, refreshes the uninstall program, and uninstall is ready', async t => {
  const f = await fixture(t), r = registered();
  await f.run({}, { registerUninstall: r.register }); await recordOlderFiles(f);
  const again = await f.run({}, { registerUninstall: r.register });
  assert.ok(!again.summary.some(line => /could not be checked/.test(line)), 'the record was updated, not skipped');
  const record = await json(path.join(f.root, 'uninstall-record.json'));
  assert.deepEqual(await read(path.join(f.root, 'uninstall.mjs')), await read(path.join(CHECKOUT, 'src', 'uninstall.mjs')), 'the uninstall program is this build\'s');
  assert.doesNotMatch(String(await read(path.join(f.launcherFolder, 'Start-OMP.ps1'))), /older build/, 'the launcher was replaced');
  for (const [name, digest] of Object.entries(record.software)) assert.equal(sha(await read(path.join(f.root, name))), digest, name + ' is recorded as it is now');
  assert.equal((await uninstall(f.root, {}, r.deps(f))).status, 'preview');
});

test('three upgrades in a row over files that each older build changed: every run refreshes the record, and uninstall is ready and completes', async t => {
  const f = await fixture(t), r = registered();
  await f.run({}, { registerUninstall: r.register });
  for (let step = 0; step < 3; step++) {
    await recordOlderFiles(f); await becomeOlder(f, '0.2.1' + step);
    const run = await f.run({}, { registerUninstall: r.register });
    assert.ok(!run.summary.some(line => /could not be checked/.test(line)), 'upgrade ' + (step + 1) + ' refreshed the record');
  }
  assert.equal((await uninstall(f.root, {}, r.deps(f))).status, 'preview');
  assert.equal((await uninstall(f.root, { confirmOffline: true }, r.deps(f))).status, 'uninstalled');
});

test('a file the owner put in the install folder never stops Setup from refreshing the record; it is kept, and uninstall still lists it and removes nothing', async t => {
  const f = await fixture(t), r = registered();
  await f.run({}, { registerUninstall: r.register }); await recordOlderFiles(f);
  const note = path.join(f.root, 'workspace', 'STATE.md'); await fs.mkdir(path.dirname(note)); await fs.writeFile(note, 'mine');
  await f.run({}, { registerUninstall: r.register });
  assert.deepEqual(await read(path.join(f.root, 'uninstall.mjs')), await read(path.join(CHECKOUT, 'src', 'uninstall.mjs')), 'the record and the uninstall program are current');
  assert.equal(await read(note).then(String), 'mine');
  const preview = await uninstall(f.root, {}, r.deps(f));
  assert.deepEqual([preview.status, preview.installations[0].reason, preview.installations[0].items], ['blocked', 'unverified-files', ['workspace/STATE.md']]);
  assert.equal((await uninstall(f.root, { confirmOffline: true }, r.deps(f))).status, 'blocked', 'a real uninstall also refuses');
  assert.equal(await read(note).then(String), 'mine', 'nothing was removed');
});

// An install exactly as 0.2.20 left it: runtime/managed-<session>/ with its own launcher, pointer and versions, and a launcher folder that uses it.
async function becomeLegacyManaged(f, label) {
  const legacy = path.join(f.runtime, 'managed-' + f.sessionId), current = f.managed;
  await fs.rename(current, legacy); f.managed = legacy;
  await becomeOlder(f, label); f.managed = current;
  const settingsFile = path.join(f.launcherFolder, 'launch-settings.json'), settings = await json(settingsFile);
  await fs.writeFile(settingsFile, JSON.stringify({ ...settings, cli: path.join(legacy, 'bridge.mjs') }) + '\n');
  return legacy;
}

test('migration: a 0.2.20 per-session runtime folder is kept untouched, the fixed runtime\\current takes over, and the old pointer is in the backup', async t => {
  const f = await fixture(t);
  await f.run();
  const legacy = await becomeLegacyManaged(f, '0.2.20');
  const legacyBefore = await snapshot(legacy), pointerBefore = await read(path.join(legacy, 'current.json')), settingsBefore = await read(path.join(f.launcherFolder, 'launch-settings.json'));
  const result = await f.run();
  assert.equal(result.upgrade.kind, 'upgrade'); assert.equal(result.upgrade.from, '0.2.20');
  assert.equal(result.upgrade.message, `Upgraded to ${VERSION}.`);
  assert.equal(result.cliLauncher, path.join(f.managed, 'bridge.mjs'), 'one fixed path');
  assert.deepEqual(await snapshot(legacy), legacyBefore, 'the old per-session folder is byte-identical (the way back)');
  assert.equal((await json(path.join(f.launcherFolder, 'launch-settings.json'))).cli, path.join(f.managed, 'bridge.mjs'), 'the launcher now uses the fixed path');
  const kept = new Map(await Promise.all((await backups(f)).map(async e => [e.name, await read(path.join(e.parentPath ?? e.path, e.name))])));
  assert.deepEqual(kept.get(`managed-${f.sessionId}-current.json`), pointerBefore, 'the 0.2.20 pointer is kept in the backup');
  assert.deepEqual(kept.get('launcher-lane-launch-settings.json'), settingsBefore, 'and so is the old launcher setting');
  const done = await snapshot(f.root), again = await f.run();
  assert.equal(again.upgrade.kind, 'unchanged'); assert.deepEqual(await snapshot(f.root), done);
});

test('migration that fails its start check leaves the old install working and builds nothing at the fixed path', async t => {
  const f = await fixture(t);
  await f.run();
  const legacy = await becomeLegacyManaged(f, '0.2.20');
  const before = await snapshot(f.root, rel => rel.startsWith('backups'));
  await assert.rejects(f.run({}, { startCheck: async () => { throw new Error(UPGRADE_ERRORS.startCheck); } }), error => error.message === UPGRADE_ERRORS.startCheck);
  assert.equal(await exists(f.managed), false, 'no half-made current folder');
  assert.deepEqual(await snapshot(f.root, rel => rel.startsWith('backups')), before, 'every owned file is as it was');
  assert.equal((await json(path.join(f.launcherFolder, 'launch-settings.json'))).cli, path.join(legacy, 'bridge.mjs'));
  assert.equal((await f.run()).upgrade.kind, 'upgrade', 'the next run completes it');
});

test('a plan running on the old version is not broken by the upgrade; the next start uses the new version', async t => {
  const f = await fixture(t);
  await f.run();
  // The old version carries a marker so a run of it can be told apart from the new one.
  const files = await olderFiles('0.2.11');
  files.set('src/cli.mjs', Buffer.concat([files.get('src/cli.mjs'), Buffer.from("\nprocess.stdout.write('old-version-marker\\n');\n")]));
  await fs.rm(path.join(f.managed, 'versions', VERSION), { recursive: true, force: true });
  const oldFolder = path.join(f.managed, 'versions', '0.2.11');
  await writeVersion(oldFolder, '0.2.11', files);
  await fs.writeFile(path.join(f.managed, 'current.json'), JSON.stringify({ version: 1, current: '0.2.11', previous: null }) + '\n');
  const run = (args, env = {}) => new Promise(resolve => execFile(process.execPath, [path.join(f.managed, 'bridge.mjs'), ...args], { windowsHide: true, env: { ...process.env, ...env } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const credential = path.join(f.root, 'credentials', 'controller.json');
  const planA = crypto.randomUUID(), planB = crypto.randomUUID();
  const planFile = id => JSON.stringify({ version: 1, id, sessionId: f.sessionId, expiresAt: Date.now() + 3600000, steps: [{ prompt: 'Synthetic fixture prompt.', continueAfterEnd: false }] }) + '\n';
  await fs.writeFile(path.join(f.state, 'plans', planA + '.json'), planFile(planA));
  const receiptFile = path.join(f.state, 'receipts', planA + '.json');
  const receipt = state => JSON.stringify({ version: 1, id: planA, sessionId: f.sessionId, state, nextStep: 0, updatedAt: Date.now(), outcomes: [], taskSuccess: 'unverified', automaticReplay: false }) + '\n';
  await fs.writeFile(receiptFile, receipt('submitted'));
  // The running session: loaded the OLD version's files, still loading more of them after the switch.
  const lane = spawn(process.execPath, ['-e', `
    const { pathToFileURL } = require('node:url'), path = require('node:path'), fs = require('node:fs');
    const [folder, receiptFile, text] = process.argv.slice(1);
    const load = name => import(pathToFileURL(path.join(folder, name)).href);
    load('src/control.mjs').then(() => {
      process.stdout.write('ready\\n');
      process.stdin.once('data', async () => {
        await load('src/transcript.mjs'); await load('src/cli.mjs');
        fs.writeFileSync(receiptFile, text);
        process.stdout.write('finished\\n'); process.exit(0);
      });
    });`, oldFolder, receiptFile, receipt('completed')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => lane.kill());
  let output = ''; lane.stdout.on('data', chunk => { output += chunk; });
  const until = async word => { for (let i = 0; i < 400 && !output.includes(word); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(output.includes(word), word); };
  await until('ready');
  const oldBefore = await snapshot(oldFolder), planBefore = await read(path.join(f.state, 'plans', planA + '.json'));
  const oldRun = await run(['status', f.state]);
  assert.equal(oldRun.code, 0, oldRun.stderr); assert.match(oldRun.stdout, /old-version-marker/, 'before the upgrade the launcher runs the old version');

  const result = await f.run({}, { openSessions: async () => 1 });
  assert.equal(result.upgrade.message, `Upgraded to ${VERSION}. A session is open, so the new version starts with the next session.`);
  assert.deepEqual(await snapshot(oldFolder), oldBefore, 'the files the running plan loaded are untouched');
  assert.deepEqual(await read(path.join(f.state, 'plans', planA + '.json')), planBefore, 'the running plan is untouched');
  assert.equal(await json(receiptFile).then(r => r.state), 'submitted', 'and still in flight');

  lane.stdin.write('go\n'); await until('finished');
  assert.equal(await json(receiptFile).then(r => r.state), 'completed', 'the plan finished on the old version');

  const next = await run(['status', f.state]);
  assert.equal(next.code, 0, next.stderr); assert.doesNotMatch(next.stdout, /old-version-marker/, 'the next start runs the new version');
  assert.deepEqual(JSON.parse(next.stdout).map(row => [row.id, row.state]), [[planA, 'completed']]);
  await fs.writeFile(path.join(f.base, 'plan-b.json'), planFile(planB));
  const queued = await run(['enqueue', path.join(f.state, 'config.json'), path.join(f.base, 'plan-b.json')], { OMP_BRIDGE_CONTROLLER: credential });
  assert.equal(queued.code, 3, queued.stderr); assert.doesNotMatch(queued.stdout, /old-version-marker/, 'the next plan is accepted by the new version');
  assert.deepEqual(JSON.parse((await run(['status', f.state])).stdout).map(row => row.id).sort(), [planA, planB].sort());
});

test('a runtime folder that a repair moved aside never blocks uninstall, even when the repair did not finish, but a stranger\'s file in it still does', async t => {
  for (const [stranger, unfinished] of [[false, false], [true, false], [false, true], [true, true]]) {
    const f = await fixture(t), r = registered();
    await f.run({}, { registerUninstall: r.register });
    // The power went out while the pointer was switched: a half-written pointer file is left in the runtime folder.
    await fs.writeFile(path.join(f.managed, 'current.json.' + crypto.randomUUID() + '.tmp'), '{"half');
    if (stranger) await fs.writeFile(path.join(f.managed, 'note.txt'), 'mine');
    // A repair that stops right after the folder was moved aside (a failed later step, a stop, a power cut) leaves it behind; the next install moves nothing.
    if (unfinished) await assert.rejects(f.run({}, { registerUninstall: async () => { throw new Error('stopped after the move'); } }));
    else assert.equal((await f.run({}, { registerUninstall: r.register })).upgrade.kind, 'fresh');
    const moved = (await fs.readdir(f.runtime)).find(name => name.startsWith('managed-'));
    assert.equal(await exists(path.join(f.runtime, moved, 'bridge.mjs')), true);
    await f.run({}, { registerUninstall: r.register });
    const preview = await uninstall(f.root, {}, r.deps(f));
    if (stranger) {
      assert.deepEqual([preview.status, preview.installations[0].reason, preview.installations[0].items], ['blocked', 'unverified-files', [`runtime/${moved}/note.txt`]]);
      assert.equal((await uninstall(f.root, { confirmOffline: true }, r.deps(f))).status, 'blocked');
      assert.equal(await read(path.join(f.runtime, moved, 'note.txt')).then(String), 'mine', 'nothing was removed');
    } else {
      assert.equal(preview.status, 'preview', JSON.stringify(preview));
      assert.equal((await uninstall(f.root, { confirmOffline: true }, r.deps(f))).status, 'uninstalled');
      assert.equal(await exists(f.root), false);
    }
  }
});

test('a runtime folder moved aside while an earlier launcher was current is still claimed; a launcher the product never shipped is not', async t => {
  const older = '#!/usr/bin/env node\n// the launcher of an earlier build\n', olderHash = crypto.createHash('sha256').update(older).digest('hex');
  assert.ok(LAUNCHER_HASHES.has(crypto.createHash('sha256').update(LAUNCHER).digest('hex')), 'a changed launcher must add its hash and keep the old ones');
  for (const shipped of [true, false]) {
    const f = await fixture(t), r = registered();
    await f.run({}, { registerUninstall: r.register });
    await fs.writeFile(path.join(f.managed, 'current.json.' + crypto.randomUUID() + '.tmp'), '{"half');
    await assert.rejects(f.run({}, { registerUninstall: async () => { throw new Error('stopped after the move'); } }));
    const moved = (await fs.readdir(f.runtime)).find(name => name.startsWith('managed-'));
    await fs.writeFile(path.join(f.runtime, moved, 'bridge.mjs'), older);
    if (shipped) LAUNCHER_HASHES.add(olderHash);
    try { await f.run({}, { registerUninstall: r.register }); } finally { LAUNCHER_HASHES.delete(olderHash); }
    const preview = await uninstall(f.root, {}, r.deps(f));
    if (shipped) assert.equal(preview.status, 'preview', JSON.stringify(preview));
    else assert.deepEqual([preview.status, preview.installations[0].items], ['blocked', [`runtime/${moved}/bridge.mjs`]]);
  }
});
