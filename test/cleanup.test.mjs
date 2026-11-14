import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { autoSetup } from '../src/autosetup.mjs';
import { registerInstallation, installationId, uninstall } from '../src/uninstall.mjs';

// After an install that checks out, Setup removes the backups of earlier runs that it can prove it wrote itself, and the
// uninstall record only vouches for files this very call created. Every folder below is a disposable fake under one
// temporary base: no real install, lane, registry, assistant app or network is involved.
const DEFAULT_NAME = 'OMP Session Bridge Local';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFile(file);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.lstat(file).then(() => true, () => false);

async function world(t) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-clean-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(base, 'home'), appdata = path.join(base, 'appdata'), startup = path.join(base, 'startup');
  for (const dir of [home, appdata, startup, path.join(home, '.claude'), path.join(home, '.codex')]) await fs.mkdir(dir, { recursive: true });
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const cwd = path.join(base, 'project-one'); await fs.mkdir(cwd);
  const id = crypto.randomUUID(), file = path.join(sessions, 'project-one.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id, cwd }) + '\n');
  const claudeExe = path.join(base, 'tools', 'claude.exe'); await fs.mkdir(path.dirname(claudeExe)); await fs.writeFile(claudeExe, 'fake claude');
  const claudeJson = path.join(home, '.claude.json');
  const runClient = async (exe, args) => {
    const doc = await json(claudeJson).catch(() => ({})); doc.mcpServers ??= {};
    if (args[1] === 'add') {
      const dash = args.indexOf('--'), env = {};
      args.forEach((arg, i) => { if (arg === '--env') { const [name, ...rest] = args[i + 1].split('='); env[name] = rest.join('='); } });
      doc.mcpServers[args[dash - 1]] = { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env };
    } else if (args[1] === 'remove') delete doc.mcpServers[args[2]];
    await fs.writeFile(claudeJson, JSON.stringify(doc));
    return { stdout: '' };
  };
  // The Installed apps list, as a fake registry.
  const apps = new Map();
  const registry = { read: async id => apps.get(id) ?? null, write: async (id, entry) => { apps.set(id, { root: entry.InstallLocation, command: entry.UninstallString }); },
    list: async () => [...apps.values()].map(row => row.root), remove: async id => { apps.delete(id); } };
  const register = (root, options) => registerInstallation(root, { ...options, registry });
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base, APPDATA: appdata }, home,
    nodeVersion: process.versions.node, nodeExecutable: process.execPath, locate: async () => process.execPath,
    detect: async () => 'omp/18.8.6',
    startCheck: async () => {}, which: async name => name === 'claude.exe' ? claudeExe : null, runClient, registerUninstall: register,
    tasks: undefined, selfTest: undefined, registry, processes: async () => [],
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  return { base, deps, registry, run: (options = {}, over = {}) => autoSetup({ session: file, name: 'lane', ...options }, { ...deps, ...over }) };
}

test('backups of earlier runs are removed once proven; this run keeps its own copies; a backup folder that cannot be proven stays and is listed', async t => {
  const w = await world(t); await w.run();
  const root = path.join(w.base, DEFAULT_NAME), backups = path.join(root, 'backups');
  const make = async (name, body, manifest = true) => {
    const dir = path.join(backups, name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), body);
    if (manifest) await fs.writeFile(path.join(dir, 'backup-manifest.json'), JSON.stringify({ version: 1, files: { 'a.txt': sha(Buffer.from(body)) } }) + '\n');
    return dir;
  };
  await fs.mkdir(backups, { recursive: true });
  const earlierRuns = (await fs.readdir(backups)).length; // the first run's own copies are an earlier run's by now
  const proven = await make('20260101T000000Z', 'one'), edited = await make('20260102T000000Z', 'two'), noManifest = await make('20260103T000000Z', 'three', false);
  await fs.appendFile(path.join(edited, 'a.txt'), ' changed later');
  const result = await w.run();
  assert.equal(await exists(proven), false, 'a proven backup of an earlier run is removed');
  assert.equal(await exists(edited), true); assert.equal(await exists(noManifest), true);
  assert.deepEqual(result.cleanup.left.map(row => row.path).sort(), [edited, noManifest].sort());
  assert.ok(result.cleanup.left.every(row => row.reason === 'Setup cannot prove it wrote everything in it'), JSON.stringify(result.cleanup.left));
  assert.equal(result.backupsRemoved, earlierRuns + 1, JSON.stringify(result.cleanup));
  assert.ok(result.summary.some(line => new RegExp(`${earlierRuns + 1} older backups?`).test(line)));
  // A run that replaces something keeps its own backup folder; the next run removes it.
  const upgraded = await w.run({}, {}); assert.equal(upgraded.backupFolder, null);
});

test('registration claims only the unlisted or changed files this very call vouches for, with exactly their hashes; everything else is kept and left unclaimed, and the record is still refreshed', async t => {
  const w = await world(t), first = await w.run();
  const extra = path.join(first.installRoot, 'launchers', 'extra'); await fs.mkdir(extra);
  const file = path.join(extra, 'Start-OMP.ps1'); await fs.writeFile(file, 'Write-Host new\r\n');
  const recordFile = path.join(first.installRoot, 'uninstall-record.json'), record = await json(recordFile);
  const coordinatorInstructions = Object.entries(record.software).filter(([name]) => name.startsWith('coordinator-instructions/')).map(([name, sha256]) => ({ path: name, sha256 }));
  const digest = sha(await read(file)), register = added => registerInstallation(first.installRoot, { registry: w.registry, coordinatorInstructions, added });
  const listed = async name => (await json(recordFile)).software[name];
  await register({}); assert.equal(await listed('launchers/extra/Start-OMP.ps1'), undefined, 'an unlisted file nobody vouches for is not claimed');
  await register({ 'launchers/extra/Start-OMP.ps1': sha(Buffer.from('other')) }); assert.equal(await listed('launchers/extra/Start-OMP.ps1'), undefined, 'the wrong hash does not claim it');
  await assert.rejects(register({ 'launchers/extra/Start-OMP.ps1': digest, 'notes.txt': digest }), /unverified install file/, 'a path Setup never creates is refused even next to a good one');
  await assert.rejects(register({ 'launchers/extra/Start-OMP.ps1': 'not a hash' }), /unverified install file/);
  assert.deepEqual(await register({ 'launchers/extra/Start-OMP.ps1': digest }), { registered: true, id: installationId(first.installRoot), root: first.installRoot });
  assert.equal(await listed('launchers/extra/Start-OMP.ps1'), digest);
  // A recorded file that changed afterwards is kept as it is and no longer claimed, unless this call says it wrote that exact content.
  const settings = path.join(first.installRoot, 'launchers', 'lane', 'launch-settings.json'); await fs.appendFile(settings, ' ');
  const edited = await read(settings);
  await register({}); assert.equal(await listed('launchers/lane/launch-settings.json'), undefined);
  assert.deepEqual(await read(settings), edited, 'the changed file was not touched');
  await register({ 'launchers/lane/launch-settings.json': sha(edited) }); assert.equal(await listed('launchers/lane/launch-settings.json'), sha(edited));
});

const previewOf = (w, root) => uninstall(root, {}, { platform: 'win32', registry: w.registry, processes: async () => [], permissions: w.deps.permissions,
  recover: async () => '', integration: { read: async () => null, remove: async () => {} }, audit: async () => [] });

test('running pots install again with the same choices leaves nothing that blocks Uninstall (the emptied backups folder is not "unknown")', async t => {
  const w = await world(t); await w.run(); await w.run();
  const root = path.join(w.base, DEFAULT_NAME);
  assert.deepEqual(await fs.readdir(path.join(root, 'backups')), [], 'the second run left an empty backups folder');
  const preview = await previewOf(w, root);
  assert.equal(preview.status, 'preview', JSON.stringify(preview));
});

test('coordinator text the owner wrote is kept, is not recorded as ours, and Uninstall names it instead of removing it', async t => {
  const w = await world(t); await w.run();
  const root = path.join(w.base, DEFAULT_NAME), name = 'coordinator-instructions/chatgpt-custom-instructions.txt', file = path.join(root, name);
  await fs.writeFile(file, 'My own notes for the assistant.\n');
  await w.run();
  assert.equal(await fs.readFile(file, 'utf8'), 'My own notes for the assistant.\n', 'kept byte for byte');
  assert.equal((await json(path.join(root, 'uninstall-record.json'))).software[name], undefined, 'not claimed');
  const preview = await previewOf(w, root);
  assert.deepEqual([preview.status, preview.installations[0].reason, preview.installations[0].items], ['blocked', 'unverified-files', [name]]);
});
