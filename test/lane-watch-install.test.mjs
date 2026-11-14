import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { autoSetup } from '../src/autosetup.mjs';
import { readJson } from '../src/control.mjs';
import { loadSetup } from '../src/setup.mjs';
import { readConnections, loadConnection } from '../src/connections.mjs';
import { registerInstallation, uninstall, uninstallDefaults } from '../src/uninstall.mjs';
import { RELEASE_FILES } from '../src/update.mjs';
import { WATCH_DEFAULTS, WATCH_FILES, createLaneWatch, readNewWatchLines, readWatchSettings } from '../src/lane-watch.mjs';

// A disposable installation: real autoSetup, real registerInstallation and real uninstall,
// with the Windows-only pieces (permissions, registry, process list) replaced by fakes.
async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'lane-watch-install-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const sessionId = crypto.randomUUID(), file = path.join(sessions, 'saved.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  const root = path.join(base, 'private-setup');
  const rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, remove: async id => rows.delete(id),
    write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString, InstallLocation: entry.InstallLocation }),
    list: async () => [...rows.values()].map(row => row.root) };
  const permissions = { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} };
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base }, home: base, nodeVersion: process.versions.node,
    nodeExecutable: process.execPath, locate: async () => process.execPath, detect: async () => 'omp/18.8.6',
    permissions,
    startCheck: async () => {},
    registerUninstall: (installRoot, options) => registerInstallation(installRoot, { ...options, registry }) };
  const removal = { platform: 'win32', registry, processes: async () => [], permissions, recover: uninstallDefaults.recover,
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  return { base, root, cwd, sessionId, deps, removal, run: options => autoSetup({ root, name: 'watch', ...options }, deps) };
}
const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('installer: the watcher is picked automatically as one step, with owner-editable defaults written once', async t => {
  const f = await fixture(t), first = await f.run();
  const settingsFile = path.join(first.sessions[0].stateFolder, 'control', WATCH_FILES.settings);
  assert.equal(first.laneWatch.settingsFile, settingsFile); assert.equal(first.laneWatch.settingsCreated, true);
  assert.equal(first.laneWatch.enabled, true); assert.equal(first.laneWatch.pollSeconds, 5); assert.equal(first.laneWatch.idleSeconds, 8);
  assert.equal(first.laneWatch.coordinatorTool, 'bridge_lane_watch_lines');
  assert.match(first.laneWatch.coordinatorCommand, /watch-lines '.+connections'$/);
  assert.deepEqual(await readJson(settingsFile), { ...WATCH_DEFAULTS, resultFiles: [...WATCH_DEFAULTS.resultFiles], resultFolders: [] });
  assert.ok(RELEASE_FILES.includes('src/lane-watch.mjs'));
  assert.deepEqual(await fs.readFile(path.join(first.runtimeFolder, 'src/lane-watch.mjs')), await fs.readFile(path.resolve(import.meta.dirname, '..', 'src/lane-watch.mjs')),
    'the installed runtime contains the watcher');
  // No second process or Startup entry is created for it.
  assert.deepEqual(first.coordinatorResume.external, []);
  // The owner edits the settings; a repeated Setup keeps them and reports the file as not created.
  await fs.writeFile(settingsFile, JSON.stringify({ version: 1, pollMs: 3000, idleMs: 6000 }) + '\n');
  const second = await f.run();
  assert.equal(second.laneWatch.settingsCreated, false); assert.equal(second.laneWatch.pollSeconds, 3); assert.equal(second.laneWatch.idleSeconds, 6);
  assert.equal((await readWatchSettings(first.sessions[0].stateFolder)).idleMs, 6000);
  // A broken settings file stops Setup instead of being replaced.
  await fs.writeFile(settingsFile, '{"pollMs":1}\n');
  await assert.rejects(f.run(), /invalid lane watch settings/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), '{"pollMs":1}\n');
});

test('installer: generated coordinator instructions carry the reminder text and the honest limits, and older generated files are upgraded in place', async t => {
  const f = await fixture(t), first = await f.run({ clients: 'both' });
  const [claudeFile, chatgptFile] = ['claude-skill.md', 'chatgpt-custom-instructions.txt'].map(name => path.join(first.installRoot, 'coordinator-instructions', name));
  const claude = await fs.readFile(claudeFile, 'utf8'), chatgpt = await fs.readFile(chatgptFile, 'utf8');
  for (const text of [claude, chatgpt]) {
    assert.match(text, /bridge_lane_watch_lines/);
    assert.match(text, /A process on the PC cannot wake you/);
    assert.match(text, /reminder interval plus about 15 seconds/);
  }
  assert.match(claude, /Pi on the Side check: call bridge_lane_watch_lines\. No lines: say nothing and stop\./);
  assert.match(chatgpt, /cloud cannot call bridge_lane_watch_lines or reach this PC/);
  assert.equal(claude.includes('cloud cannot call'), false);
  // Pre-watcher instruction files (what earlier versions generated) are recognised, not treated as owner edits.
  const older = text => text.replace(/\nLane watcher \(zero tokens\)[\s\S]*?(?=\nSchedule exactly one next wake-up)/, '');
  assert.notEqual(older(claude), claude);
  await fs.writeFile(claudeFile, older(claude)); await fs.writeFile(chatgptFile, older(chatgpt));
  await f.run({ clients: 'both' });
  assert.equal(await fs.readFile(claudeFile, 'utf8'), claude); assert.equal(await fs.readFile(chatgptFile, 'utf8'), chatgpt);
  // An edited file is kept as the owner left it and the run still completes.
  await fs.writeFile(claudeFile, claude + 'owner note\n');
  await f.run({ clients: 'both' });
  assert.equal(await fs.readFile(claudeFile, 'utf8'), claude + 'owner note\n');
  // With wake-ups off there is no reminder, so no watcher reminder text either.
  await fs.writeFile(claudeFile, claude);
  await f.run({ clients: 'both', coordinatorWakeups: false });
  assert.equal((await fs.readFile(claudeFile, 'utf8')).includes('bridge_lane_watch_lines'), false);
});

test('uninstaller: removes the watcher with the install (runtime copy and per-lane data files); an unknown neighbour still blocks it', async t => {
  const f = await fixture(t), first = await f.run();
  // Produce every data file a lane leaves behind: log, rotated log, state, cursor.
  const loaded = await loadSetup(first.sessions[0].stateFolder);
  const watch = createLaneWatch({ root: first.sessions[0].stateFolder, sessionId: f.sessionId, settings: { ...WATCH_DEFAULTS, resultFiles: ['RESULT.md'], resultFolders: [f.cwd] } });
  await watch.start(); await watch.stop({ exitCode: 0 });
  const control = path.join(first.sessions[0].stateFolder, 'control');
  await fs.copyFile(path.join(control, WATCH_FILES.log), path.join(control, WATCH_FILES.log + '.1'));
  const row = { name: 'watch', loaded };
  assert.ok((await readNewWatchLines([row])).lines.length >= 1);
  for (const name of Object.values(WATCH_FILES)) assert.ok(await exists(path.join(control, name)), name);
  assert.ok(await exists(path.join(control, WATCH_FILES.log + '.1')));
  const record = await readJson(path.join(first.installRoot, 'uninstall-record.json'));
  assert.ok(Object.keys(record.software).some(name => name.endsWith('src/lane-watch.mjs')), 'the watcher file is recorded as owned software');
  assert.ok(await readConnections(first.connectionsFolder) && await loadConnection((await readConnections(first.connectionsFolder)).connections[0]));

  // Negative control: a look-alike file that is not one of ours must still block removal.
  const stray = path.join(control, 'lane-watch-extra.json');
  await fs.writeFile(stray, '{}');
  const blocked = await uninstall(first.installRoot, { confirmOffline: true, purge: true, confirmPurge: true }, f.removal);
  assert.equal(blocked.status, 'blocked'); assert.equal(await exists(first.installRoot), true);
  await fs.unlink(stray);

  const removed = await uninstall(first.installRoot, { confirmOffline: true, purge: true, confirmPurge: true }, f.removal);
  assert.equal(removed.status, 'uninstalled');
  assert.equal(await exists(first.installRoot), false);
  assert.equal(await exists(first.runtimeFolder), false);
});

test('installer: the reminder wording follows the shortest interval the client allows; wake-ups off give no interval; earlier generated files are upgraded', async t => {
  const f = await fixture(t), first = await f.run({ clients: 'both' });
  const [claudeFile, chatgptFile] = ['claude-skill.md', 'chatgpt-custom-instructions.txt'].map(name => path.join(first.installRoot, 'coordinator-instructions', name));
  const [claude, chatgpt] = await Promise.all([fs.readFile(claudeFile, 'utf8'), fs.readFile(chatgptFile, 'utf8')]);
  for (const text of [claude, chatgpt]) {
    assert.match(text, /at the shortest interval your own scheduling\/reminder tool allows/);
    assert.equal(/about 2 minutes|two minutes/.test(text), false);
  }
  // What the first release wrote ("about 2 minutes", no watcher text) is recognised and replaced, not refused as an owner edit.
  const firstRelease = text => text.replace(/\nLane watcher \(zero tokens\)[\s\S]*?(?=\nSchedule exactly one next wake-up)/, '')
    .replace('at the shortest interval your own scheduling/reminder tool allows (the real delay depends on that client)', 'for about 2 minutes later using your own scheduling/reminder tool');
  assert.match(firstRelease(claude), /for about 2 minutes later/);
  await fs.writeFile(claudeFile, firstRelease(claude)); await fs.writeFile(chatgptFile, firstRelease(chatgpt));
  await f.run({ clients: 'both' });
  assert.equal(await fs.readFile(claudeFile, 'utf8'), claude); assert.equal(await fs.readFile(chatgptFile, 'utf8'), chatgpt);
  // With wake-ups off the generated text schedules nothing and names no interval at all.
  await f.run({ clients: 'both', coordinatorWakeups: false });
  for (const file of [claudeFile, chatgptFile]) {
    const off = await fs.readFile(file, 'utf8');
    assert.match(off, /wake-ups are disabled/);
    assert.equal(/minutes|shortest interval|about 120/.test(off), false);
  }
});

test('uninstaller: command receipts left by model switches are owned data and do not block removal', async t => {
  const f = await fixture(t), first = await f.run();
  const { store } = await loadSetup(first.sessions[0].stateFolder);
  const id = crypto.randomUUID();
  await store.requestCommand(id, '/model fixture/synthetic');
  await store.updateCommandReceipt(id, 'unsupported', 'refused', { requested: 'fixture/synthetic' });
  const control = path.join(first.sessions[0].stateFolder, 'control');
  assert.ok(await exists(path.join(control, `command-${id}.json`)) && await exists(path.join(control, `command-${id}.receipt.json`)));
  const removed = await uninstall(first.installRoot, { confirmOffline: true, purge: true, confirmPurge: true }, f.removal);
  assert.equal(removed.status, 'uninstalled');
  assert.equal(await exists(first.installRoot), false);
});
