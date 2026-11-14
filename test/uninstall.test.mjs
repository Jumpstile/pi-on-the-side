import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installationId, registerInstallation, uninstall, uninstallDefaults, claudeIntegration, uiPreview, REVIEW } from '../src/uninstall.mjs';
import { UPGRADE_ERRORS } from '../src/update.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function exists(p) {
  try { await fs.lstat(p); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const sessionId = '00000000-0000-4000-8000-000000000071';

async function fixture(t, { permissions, processIds = [], registryEntry = null, claude = false, hostUnreadable = false } = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-uninstall-')));
  t.after(async () => {
    const relative = path.relative(temp, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'managed-install');
  await fs.mkdir(path.join(root, 'credentials'), { recursive: true });
  await fs.mkdir(path.join(root, 'sessions', sessionId), { recursive: true });
  const marker = JSON.stringify({ version: 1, type: 'omp-session-bridge-local' });
  await fs.writeFile(path.join(root, 'local-setup.json'), marker);
  const software = Buffer.from('fixture-owned uninstall helper');
  await fs.writeFile(path.join(root, 'uninstall.mjs'), software);
  const credential = Buffer.from('controller-credential-fixture-bytes');
  await fs.writeFile(path.join(root, 'credentials', 'controller.json'), credential);
  const sessionConfig = Buffer.from('saved-session-private-state');
  await fs.writeFile(path.join(root, 'sessions', sessionId, 'config.json'), sessionConfig);
  const command = 'node fixture-uninstaller';
  const record = { version: 1, type: 'pi-on-the-side-uninstall', root, id: installationId(root), nodeExecutable: 'node.exe',
    command, software: { 'uninstall.mjs': hash(software) } };
  let integration = null;
  if (claude) {
    const entry = { type: 'stdio', command: 'node.exe', args: [path.join(root, 'mcp.mjs')], env: { OMP_BRIDGE_STATE: path.join(root, 'connections') } };
    record.claudeCode = { exe: path.join(base, 'claude.exe') };
    integration = typeof claude === 'function' ? claude(entry) : entry;
  }
  await fs.writeFile(path.join(root, 'uninstall-record.json'), JSON.stringify(record));
  const registrations = new Map();
  if (registryEntry) registrations.set(record.id, registryEntry);
  const registry = { read: async id => registrations.get(id) ?? null, remove: async id => registrations.delete(id),
    write: async (id, value) => registrations.set(id, value), list: async () => [...registrations.values()].map(row => row.root) };
  let removedHost = 0;
  let hostReads = 0;
  const host = { read: async () => { hostReads++; if (hostUnreadable) throw Error('unreadable'); return integration; }, remove: async () => { removedHost++; integration = null; } };
  const defaultPermissions = { verify: async () => {}, verifyTree: async () => {}, protect: async () => {} };
  const deps = { platform: 'win32', registry, processes: async () => processIds, permissions: permissions || defaultPermissions,
    recover: uninstallDefaults.recover, integration: host, audit: async () => [] };
  return { base, root, record, credential, sessionConfig, deps, registrations, host, get removedHost() { return removedHost; }, get hostReads() { return hostReads; } };
}

test('installation ownership registration records only the synthetic private root and rejects a foreign registration', async t => {
  const f = await fixture(t), fakeNode = path.join(f.base, 'node.exe');
  await fs.writeFile(fakeNode, 'synthetic node executable');
  const result = await registerInstallation(f.root, { nodeExecutable: fakeNode, registry: f.deps.registry });
  assert.equal(result.registered, true);
  assert.equal(result.id, f.record.id);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'uninstall-record.json'), 'utf8'));
  assert.equal(saved.root, f.root);
  assert.ok(saved.software['uninstall.mjs']);
  assert.equal((await f.deps.registry.read(saved.id)).InstallLocation, f.root);

  const g = await fixture(t);
  await g.deps.registry.write(g.record.id, { root: path.join(g.base, 'another-install'), command: 'foreign' });
  await assert.rejects(registerInstallation(g.root, { nodeExecutable: fakeNode, registry: g.deps.registry }), /foreign registry entry/);
  assert.equal(await fs.readFile(path.join(g.root, 'uninstall-record.json'), 'utf8').then(value => value === JSON.stringify(g.record)), true);
});

test('active owner session blocks removal and retains controller and session data byte-for-byte', async t => {
  const f = await fixture(t, { processIds: [4242] });
  const beforeCredential = await fs.readFile(path.join(f.root, 'credentials', 'controller.json'));
  const beforeSession = await fs.readFile(path.join(f.root, 'sessions', sessionId, 'config.json'));
  const result = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'blocked');
  assert.equal(result.installations[0].reason, 'running-or-locked');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'credentials', 'controller.json')), beforeCredential);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'sessions', sessionId, 'config.json')), beforeSession);
  assert.equal(f.registrations.has(f.record.id), false);
});

test('unknown files and foreign registration are refused without deleting or moving owner data', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'owner-note.txt'), 'keep me');
  const unknown = await uninstall(f.root, {}, f.deps);
  assert.equal(unknown.status, 'blocked');
  assert.equal(unknown.installations[0].reason, 'unverified-files');
  assert.equal(await fs.readFile(path.join(f.root, 'owner-note.txt'), 'utf8'), 'keep me');

  const g = await fixture(t, { registryEntry: { root: path.join(os.tmpdir(), 'foreign'), command: 'foreign' } });
  const foreign = await uninstall(g.root, {}, g.deps);
  assert.equal(foreign.status, 'blocked');
  assert.equal(foreign.installations[0].reason, 'foreign-registry-entry');
  assert.equal(await fs.readFile(path.join(g.root, 'credentials', 'controller.json'), 'utf8'), 'controller-credential-fixture-bytes');
});

test('default removal uses verified same-volume recovery and preserves controller credentials and session state', async t => {
  const f = await fixture(t);
  const result = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'uninstalled');
  assert.equal(await exists(f.root), false);
  assert.match(result.installations[0].recovery, /Pi on the Side Recovery/);
  const recovered = result.installations[0].recovery;
  assert.deepEqual(await fs.readFile(path.join(recovered, 'credentials', 'controller.json')), f.credential);
  assert.deepEqual(await fs.readFile(path.join(recovered, 'sessions', sessionId, 'config.json')), f.sessionConfig);
  assert.equal(f.registrations.has(f.record.id), false);
  assert.equal(f.removedHost, 0);
});

test('the lane list backups (connections.json.bak1 to .bak5) do not block uninstall and are kept in the recovery copy; a .bak6 is a stranger\'s file and still blocks', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'connections');
  await fs.mkdir(folder);
  for (const name of ['connections.json', 'connections.json.bak1', 'connections.json.bak5']) await fs.writeFile(path.join(folder, name), name);
  await fs.writeFile(path.join(folder, 'connections.json.bak6'), 'not ours');
  const blocked = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.deepEqual([blocked.status, blocked.installations[0].items], ['blocked', ['connections/connections.json.bak6']]);
  await fs.unlink(path.join(folder, 'connections.json.bak6'));
  const result = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'uninstalled');
  assert.equal(await fs.readFile(path.join(result.installations[0].recovery, 'connections', 'connections.json.bak1'), 'utf8'), 'connections.json.bak1');
});

test('the install folder typed in different letter case is accepted; a really different recorded folder is still refused', async t => {
  const f = await fixture(t), typed = f.root.toUpperCase();
  assert.notEqual(typed, f.root);
  assert.equal((await uninstall(typed, {}, f.deps)).status, 'preview');
  const other = await fixture(t), recordFile = path.join(other.root, 'uninstall-record.json');
  await fs.writeFile(recordFile, JSON.stringify({ ...other.record, root: path.join(other.base, 'some-other-folder') }));
  await assert.rejects(uninstall(other.root, {}, other.deps), /installation ownership missing/);
});

test('a wake-up file the person made that Setup never recorded stops removal (default and purge); it is not moved, not deleted and is named', async t => {
  const f = await fixture(t), mine = path.join(f.root, 'coordinator-resume', 'config.json');
  await fs.mkdir(path.dirname(mine)); await fs.writeFile(mine, 'my own settings');
  for (const options of [{ confirmOffline: true }, { confirmOffline: true, purge: true, confirmPurge: true }]) {
    const result = await uninstall(f.root, options, f.deps);
    assert.deepEqual([result.status, result.installations[0].reason, result.installations[0].items], ['blocked', 'unverified-files', ['coordinator-resume/config.json']]);
    assert.equal(await fs.readFile(mine, 'utf8'), 'my own settings');
  }
});

test('failed recovery verification rolls the installation back and retains registration', async t => {
  let failTarget = true;
  const permissions = { verify: async () => {}, protect: async () => {}, verifyTree: async target => {
    if (failTarget && target.endsWith(`${path.sep}installation`)) { failTarget = false; throw Error('synthetic verification refusal'); }
  } };
  const f = await fixture(t, { permissions });
  await f.deps.registry.write(f.record.id, { root: f.root, command: f.record.command });
  const result = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.installations[0].registryRetained, true);
  assert.equal(await exists(f.root), true);
  assert.equal(await fs.readFile(path.join(f.root, 'credentials', 'controller.json'), 'utf8'), 'controller-credential-fixture-bytes');
  assert.equal((await f.deps.registry.read(f.record.id)).root, f.root);
});

test('a private-permission refusal stops uninstall before the wake-up task is removed and keeps its own reason; moved files that cannot be checked are named', async t => {
  let removed = 0;
  const tasks = { remove: async () => { removed++; } };
  const f = await fixture(t, { permissions: { verify: async () => {}, protect: async () => {}, verifyTree: async () => { throw Error(REVIEW); } } });
  f.deps.tasks = tasks;
  const refused = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.deepEqual([refused.status, refused.installations[0].reason, refused.installations[0].recovery], ['incomplete', 'permissions-review', undefined]);
  assert.equal(removed, 0, 'the wake-ups were not switched off by a refused uninstall'); assert.equal(refused.installations[0].wakeupsOff, false);
  assert.equal(await exists(f.root), true);
  // Moved to recovery, check fails there, and the folder cannot be checked back in its old place either: it is back in the install folder, so nothing says "recovery".
  let checks = 0;
  const g = await fixture(t, { permissions: { verify: async () => {}, protect: async () => {}, verifyTree: async () => { if (++checks >= 4) throw Error(REVIEW); } } });
  g.deps.tasks = tasks;
  const back = await uninstall(g.root, { confirmOffline: true }, g.deps);
  assert.deepEqual([back.installations[0].reason, back.installations[0].recovery], ['permissions-review', undefined]);
  assert.equal(removed, 1); assert.equal(back.installations[0].wakeupsOff, true, 'the task was already removed, so the result says wake-ups are off');
  assert.equal(await exists(path.join(g.root, 'credentials', 'controller.json')), true);
  // The recovery copy exists but cannot be moved back: its folder is named.
  const h = await fixture(t), kept = path.join(h.base, 'Pi on the Side Recovery', 'copy', 'installation');
  h.deps.tasks = tasks;
  h.deps.recover = async () => { throw Object.assign(new Error('private recovery verification failed; moved files retained for local recovery'), { recovery: kept }); };
  const stuck = await uninstall(h.root, { confirmOffline: true }, h.deps);
  assert.deepEqual([stuck.installations[0].reason, stuck.installations[0].recovery, stuck.installations[0].registryRetained], ['recovery-kept', kept, true]);
});

test('permanent purge requires separate confirmation and only affects the synthetic root', async t => {
  const f = await fixture(t);
  const blocked = await uninstall(f.root, { confirmOffline: true, purge: true }, f.deps);
  assert.equal(blocked.status, 'confirmation-required');
  assert.equal(await fs.readFile(path.join(f.root, 'credentials', 'controller.json'), 'utf8'), 'controller-credential-fixture-bytes');
  const purged = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(purged.status, 'uninstalled');
  assert.equal(purged.installations[0].recovery, 'none: permanent purge confirmed');
  assert.equal(await exists(f.root), false);
  assert.equal(f.removedHost, 0);
});

test('Claude Code is only asked about when the install says it connected it; a changed entry blocks, a reformatted one does not', async t => {
  const owned = await fixture(t, { claude: true });
  const result = await uninstall(owned.root, { confirmOffline: true }, owned.deps);
  assert.equal(result.status, 'uninstalled');
  assert.equal(owned.removedHost, 1);

  // Claude Code rewrote the entry with another key order and an extra field: it is still ours.
  const rewritten = await fixture(t, { claude: entry => ({ env: entry.env, extra: 1, args: entry.args, command: entry.command, type: entry.type }) });
  assert.equal((await uninstall(rewritten.root, { confirmOffline: true }, rewritten.deps)).status, 'uninstalled');
  assert.equal(rewritten.removedHost, 1);

  // The entry now points somewhere else: not ours, nothing removed.
  const foreign = await fixture(t, { claude: entry => ({ ...entry, command: 'foreign' }) });
  const refused = await uninstall(foreign.root, { confirmOffline: true }, foreign.deps);
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.installations[0].reason, 'host-registration-changed');
  assert.equal(foreign.removedHost, 0);
  assert.equal(await fs.readFile(path.join(foreign.root, 'credentials', 'controller.json'), 'utf8'), 'controller-credential-fixture-bytes');

  // A settings file that cannot be read (too big, a link, half written) must not block removing the install; its one entry is left and reported.
  const unreadable = await fixture(t, { claude: true, hostUnreadable: true });
  const kept = await uninstall(unreadable.root, { confirmOffline: true }, unreadable.deps);
  assert.equal(kept.status, 'uninstalled');
  assert.equal(kept.installations[0].claudeCodeKept, true);
  assert.equal(unreadable.removedHost, 0);

  // Nothing recorded about Claude Code: its settings file is never opened.
  const none = await fixture(t, { hostUnreadable: true });
  assert.equal((await uninstall(none.root, { confirmOffline: true }, none.deps)).status, 'uninstalled');
  assert.equal(none.hostReads, 0);
});

async function resumeFixture(t, { modified = false, extension = 'cmd' } = {}) {
  const f = await fixture(t), directory = path.join(f.root, 'coordinator-resume');
  await fs.mkdir(path.join(directory, 'control'), { recursive: true });
  const config = '{"version":1}', prompt = 'owned resume prompt';
  await fs.writeFile(path.join(directory, 'config.json'), config);
  await fs.writeFile(path.join(directory, 'resume-prompt.txt'), prompt);
  f.record.software['coordinator-resume/config.json'] = hash(config);
  f.record.software['coordinator-resume/resume-prompt.txt'] = hash(prompt);
  const startup = path.join(f.base, installationId(f.root) + '-Resume.' + extension), launcher = 'owned Startup launcher';
  await fs.writeFile(startup, modified ? 'owner modified launcher' : launcher);
  f.record.resumeExternal = [{ path: startup, sha256: hash(launcher) }];
  await fs.writeFile(path.join(f.root, 'uninstall-record.json'), JSON.stringify(f.record));
  return { ...f, directory, startup };
}

test('confirmed uninstall disables resume before checking processes and removes only verified Startup artifact', async t => {
  const f = await resumeFixture(t);
  let inspected = false;
  f.deps.processes = async () => {
    inspected = true;
    assert.equal(await exists(path.join(f.directory, 'control/disabled')), true);
    return [];
  };
  const result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(result.status, 'uninstalled'); assert.equal(inspected, true);
  assert.equal(await exists(f.startup), false); assert.equal(await exists(f.root), false);
});

test('uninstall deletes the install\'s scheduled task only when it still carries the product marker, and a preview deletes nothing', async t => {
  const f = await resumeFixture(t), name = installationId(f.root) + '-Resume', mark = 'Pi on the Side resume watchdog ' + installationId(f.root);
  const tasks = new Map([[name, '<Description>' + mark + '</Description>']]);
  f.deps.tasks = { remove: async (task, text) => { const xml = tasks.get(task); if (xml === undefined) return 'absent'; if (!xml.includes(text)) return 'foreign'; tasks.delete(task); return 'removed'; } };
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview'); assert.equal(tasks.size, 1, 'a preview changes nothing');
  assert.equal((await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps)).status, 'uninstalled');
  assert.equal(tasks.size, 0);
  const other = await resumeFixture(t), otherName = installationId(other.root) + '-Resume';
  const foreign = new Map([[otherName, '<Description>somebody else made this</Description>']]);
  other.deps.tasks = { remove: async (task, text) => { const xml = foreign.get(task); if (xml === undefined) return 'absent'; return xml.includes(text) ? (foreign.delete(task), 'removed') : 'foreign'; } };
  assert.equal((await uninstall(other.root, { confirmOffline: true, purge: true, confirmPurge: true }, other.deps)).status, 'uninstalled');
  assert.equal(foreign.size, 1, 'a task without the marker is never deleted');
});

test('uninstall that cannot confirm the scheduled task is gone removes nothing and says so', async t => {
  const f = await resumeFixture(t);
  f.deps.tasks = { remove: async () => { throw new Error('scheduled task state unknown'); } };
  const result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.installations[0].reason, 'task-remains');
  assert.equal(await exists(f.root), true, 'the install is still there, so the task never points at a missing folder');
});

test('a lock a crashed watchdog left behind does not block uninstall', async t => {
  const f = await resumeFixture(t), lock = path.join(f.directory, 'control', 'watchdog.lock');
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), '{"pid":1}');
  assert.equal((await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps)).status, 'uninstalled');
  assert.equal(await exists(f.root), false);
});

test('uninstall removes the proven legacy .vbs Startup entry of an install that was never upgraded', async t => {
  const f = await resumeFixture(t, { extension: 'vbs' });
  const result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(result.status, 'uninstalled');
  assert.equal(await exists(f.startup), false); assert.equal(await exists(f.root), false);
});

test('uninstall preview does not disable resume or mutate Startup and modified external launcher survives removal', async t => {
  const f = await resumeFixture(t, { modified: true });
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview');
  assert.equal(await exists(path.join(f.directory, 'control/disabled')), false);
  assert.equal(await fs.readFile(f.startup, 'utf8'), 'owner modified launcher');
  const result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(result.status, 'uninstalled');
  assert.deepEqual(result.installations[0].preservedExternal, [f.startup]);
  assert.equal(await fs.readFile(f.startup, 'utf8'), 'owner modified launcher');
});

test('unknown and modified internal resume files are retained under the existing fail-closed uninstall boundary', async t => {
  const f = await resumeFixture(t);
  await fs.writeFile(path.join(f.directory, 'resume-prompt.txt'), 'owner modified prompt');
  await fs.writeFile(path.join(f.directory, 'owner.txt'), 'owner file');
  const result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps);
  assert.equal(result.status, 'blocked');
  assert.equal(await fs.readFile(path.join(f.directory, 'resume-prompt.txt'), 'utf8'), 'owner modified prompt');
  assert.equal(await fs.readFile(path.join(f.directory, 'owner.txt'), 'utf8'), 'owner file');
  assert.equal(await exists(f.startup), true);
});

test('coordinator heartbeat permits recovery removal without admitting adjacent owner files', async t => {
  const f = await resumeFixture(t), control = path.join(f.root, 'sessions', sessionId, 'control');
  await fs.mkdir(control);
  const heartbeat = JSON.stringify({ version: 1, updatedAt: 1800000000000 });
  await fs.writeFile(path.join(control, 'coordinator-active.json'), heartbeat);
  const ownerFile = path.join(control, 'coordinator-owner-note.json');
  await fs.writeFile(ownerFile, 'owner data');
  assert.equal((await uninstall(f.root, { confirmOffline: true }, f.deps)).status, 'blocked');
  assert.equal(await fs.readFile(ownerFile, 'utf8'), 'owner data');
  assert.equal(await exists(f.startup), true);
  await fs.unlink(ownerFile);
  const removed = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(removed.status, 'uninstalled');
  assert.equal(await exists(f.startup), false);
  assert.equal(await fs.readFile(path.join(removed.installations[0].recovery, 'sessions', sessionId,
    'control', 'coordinator-active.json'), 'utf8'), heartbeat);
});

test('a lock left by a crash no longer blocks uninstall; a lock whose program still runs does, and says which file to delete', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'sessions', sessionId, 'control'), old = new Date(Date.now() - 2 * 3600 * 1000);
  await fs.mkdir(dir, { recursive: true });
  const guard = path.join(dir, 'trace-write.lock'), supervisor = path.join(f.root, 'sessions', sessionId, `supervisor-${sessionId}.lock`);
  await fs.writeFile(guard, '');
  const recent = await uninstall(f.root, {}, f.deps);
  assert.equal(recent.installations[0].reason, 'running-or-locked');
  assert.ok(recent.installations[0].note.includes(guard));
  await fs.utimes(guard, old, old);
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview', 'an old guard file with no owner is not a running program');
  // OMP was killed: its lock names a program that is gone, so it is a leftover and does not block.
  await fs.writeFile(supervisor, JSON.stringify({ version: 1, pid: spawnSync(process.execPath, ['-e', '']).pid, startedAt: Date.now(), sessionId }));
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview');
  // The program still runs: refuse, never touch the file, name it and give the recovery. Restarting the PC is not advice.
  const live = JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now(), sessionId });
  await fs.writeFile(supervisor, live);
  const blocked = (await uninstall(f.root, {}, f.deps)).installations[0];
  assert.equal(blocked.reason, 'running-or-locked');
  assert.ok(blocked.note.includes(supervisor), blocked.note);
  assert.match(blocked.note, /delete only that file/);
  assert.ok(!/restart the PC/i.test(blocked.note));
  assert.equal(await fs.readFile(supervisor, 'utf8'), live);
});

test('uninstall is not blocked when the recorded Claude Code program is gone: only its settings entry is left, and the result says so', async t => {
  const f = await fixture(t, { claude: true }), home = path.join(f.base, 'home');
  await fs.mkdir(home);
  const entry = { type: 'stdio', command: 'node.exe', args: [path.join(f.root, 'mcp.mjs')], env: { OMP_BRIDGE_STATE: path.join(f.root, 'connections') } };
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'omp-session-bridge': entry } }));
  f.deps.integration = claudeIntegration({ home, env: {}, run: async () => { throw new Error('the missing program must never be run'); } });
  const result = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'uninstalled');
  assert.deepEqual([result.installations[0].claudeCodeKept, result.installations[0].claudeCodeGone], [true, true]);
  assert.equal(await exists(f.root), false);
  assert.ok(JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers['omp-session-bridge'], 'the entry is left, as the result says');
});

test('a blocked uninstall does not leave the watchdog paused, and never touches a pause the owner wrote', async t => {
  const f = await resumeFixture(t), marker = path.join(f.directory, 'control', 'disabled');
  await fs.writeFile(path.join(f.root, 'my-notes.txt'), 'mine');
  const blocked = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.equal(blocked.status, 'blocked');
  assert.equal(await exists(marker), false, 'the pause it wrote for the removal is taken away again');
  await fs.writeFile(marker, 'POTS coordinator resume disabled.\r\n');
  assert.equal((await uninstall(f.root, { confirmOffline: true }, f.deps)).status, 'blocked');
  assert.equal(await fs.readFile(marker, 'utf8'), 'POTS coordinator resume disabled.\r\n', 'the owner\'s own pause stays');
});

test('files the product itself left half-written (temp files, a cut-off lock folder) do not block uninstall, but a stranger\'s file still does', async t => {
  const f = await resumeFixture(t), id = crypto.randomUUID(), control = path.join(f.directory, 'control'), lock = path.join(control, 'watchdog.lock.dead-' + id);
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), '{"pid":1}');
  await fs.writeFile(path.join(control, 'state.json.' + id + '.tmp'), '{"half');
  await fs.writeFile(path.join(f.directory, 'config.json.' + id + '.tmp'), '{"half');
  await fs.mkdir(path.join(f.root, 'sessions', sessionId, 'plans'));
  await fs.writeFile(path.join(f.root, 'sessions', sessionId, 'plans', id + '.json.' + crypto.randomUUID() + '.tmp'), '{"half');
  await fs.mkdir(path.join(f.root, 'launchers', 'lane-one'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'launchers', 'lane-one', 'Start-OMP.ps1.1a2b3c4d.tmp'), 'half');
  await fs.writeFile(path.join(control, 'state.json.tmp'), 'not made by the product');
  const blocked = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.deepEqual([blocked.status, blocked.installations[0].items], ['blocked', ['coordinator-resume/control/state.json.tmp']]);
  await fs.unlink(path.join(control, 'state.json.tmp'));
  assert.equal((await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps)).status, 'uninstalled');
  assert.equal(await exists(f.root), false);
});

test('a purge copies the handoff file next to the install folder first and says so; a normal removal keeps it in the recovery copy', async t => {
  const notes = await resumeFixture(t), text = 'Goal: finish the report. Next: ask the owner.';
  await fs.writeFile(path.join(notes.directory, 'handoff.md'), text);
  const asked = await uninstall(notes.root, { confirmOffline: true, purge: true }, notes.deps);
  assert.equal(asked.status, 'confirmation-required');
  assert.match(asked.note, /handoff file.*copied next to the install folder first/);
  const purged = (await uninstall(notes.root, { confirmOffline: true, purge: true, confirmPurge: true }, notes.deps)).installations[0];
  assert.equal(purged.handoffKept, path.join(notes.base, 'Pi on the Side handoff.md'));
  assert.equal(await fs.readFile(purged.handoffKept, 'utf8'), text);
  assert.equal(await exists(notes.root), false);
  const again = await resumeFixture(t);
  await fs.writeFile(path.join(again.directory, 'handoff.md'), 'second');
  await fs.writeFile(path.join(again.base, 'Pi on the Side handoff.md'), 'an earlier copy');
  const second = (await uninstall(again.root, { confirmOffline: true, purge: true, confirmPurge: true }, again.deps)).installations[0];
  assert.equal(second.handoffKept, path.join(again.base, 'Pi on the Side handoff (2).md'));
  assert.equal(await fs.readFile(path.join(again.base, 'Pi on the Side handoff.md'), 'utf8'), 'an earlier copy', 'a file that is already there is never overwritten');
  const kept = await resumeFixture(t);
  await fs.writeFile(path.join(kept.directory, 'handoff.md'), 'stays');
  const removed = (await uninstall(kept.root, { confirmOffline: true }, kept.deps)).installations[0];
  assert.equal(removed.handoffKept, undefined);
  assert.equal(await fs.readFile(path.join(removed.recovery, 'coordinator-resume', 'handoff.md'), 'utf8'), 'stays');
});

test('the Windows-window removal takes its pause away again when the removal is blocked, and keeps it when the removal can go on', async t => {
  const f = await resumeFixture(t), marker = path.join(f.directory, 'control', 'disabled');
  await fs.writeFile(path.join(f.root, 'my-notes.txt'), 'mine');
  const blocked = await uiPreview(f.root, {}, [f.root], f.deps);
  assert.equal(blocked.preview.status, 'blocked');
  assert.equal(await exists(marker), false, 'wake-ups are not left off by a removal that never started');
  await fs.unlink(path.join(f.root, 'my-notes.txt'));
  const ready = await uiPreview(f.root, {}, [f.root], f.deps, async () => 'cancel');
  assert.equal(ready.preview.status, 'preview');
  assert.equal(ready.mode, 'cancel');
  assert.deepEqual(ready.paused, [marker]);
  assert.equal(await exists(marker), true, 'the person said yes to the pause, and it stays while they decide');
});

test('a confirmation window that fails or times out takes the pause away again', async t => {
  const f = await resumeFixture(t), marker = path.join(f.directory, 'control', 'disabled');
  await assert.rejects(uiPreview(f.root, {}, [f.root], f.deps, async () => { throw Error('the window did not open'); }), /did not open/);
  assert.equal(await exists(marker), false, 'wake-ups are not left off by a window that never answered');
});

test('an uninstall list cut off by a power loss is repaired by the next install, and uninstall says what to do meanwhile', async t => {
  const f = await fixture(t), fakeNode = path.join(f.base, 'node.exe'), recordFile = path.join(f.root, 'uninstall-record.json');
  await fs.writeFile(fakeNode, 'synthetic node executable');
  await fs.writeFile(recordFile, JSON.stringify(f.record).slice(0, 30));
  await assert.rejects(uninstall(f.root, { confirmOffline: true }, f.deps), /Next: run pots install to repair it, then run pots uninstall again/);
  await registerInstallation(f.root, { nodeExecutable: fakeNode, registry: f.deps.registry });
  assert.equal(JSON.parse(await fs.readFile(recordFile, 'utf8')).root, f.root);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.includes('uninstall-record.json.')), [], 'no temp file is left');
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview');
});

test('what an interrupted update, install or setup leaves behind does not block uninstall, but a stranger\'s file inside it still does', async t => {
  const f = await fixture(t), id = crypto.randomUUID(), runtime = path.join(f.root, 'runtime');
  const staged = path.join(runtime, 'current', 'staging', id, 'src');
  await fs.mkdir(staged, { recursive: true }); await fs.writeFile(path.join(staged, 'control.mjs'), 'half'); await fs.writeFile(path.join(runtime, 'current', 'staging', id, 'release.json'), '{"half');
  await fs.mkdir(path.join(runtime, 'current', 'staging', id, 'extension'));
  await fs.mkdir(path.join(runtime, 'managed-1a2b3c', 'versions'), { recursive: true }); await fs.mkdir(path.join(runtime, 'managed-1a2b3c', 'staging'));
  await fs.writeFile(path.join(runtime, 'current', 'current.json.' + crypto.randomUUID() + '.tmp'), '{"half');
  await fs.writeFile(path.join(f.root, 'local-setup.json.' + crypto.randomUUID() + '.tmp'), '{"half');
  await fs.writeFile(path.join(f.root, 'uninstall-record.json.' + crypto.randomUUID() + '.tmp'), '{"half');
  await fs.mkdir(path.join(f.root, 'launchers', 'lane-one'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'launchers', 'lane-one', 'launch-settings.json.' + crypto.randomUUID() + '.tmp'), '{"half');
  await fs.writeFile(path.join(runtime, 'current', 'staging', id, 'my-notes.txt'), 'mine');
  const blocked = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.deepEqual([blocked.status, blocked.installations[0].items], ['blocked', ['runtime/current/staging/' + id + '/my-notes.txt']]);
  await fs.unlink(path.join(runtime, 'current', 'staging', id, 'my-notes.txt'));
  assert.equal((await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps)).status, 'uninstalled');
  assert.equal(await exists(f.root), false);
});

test('a runtime folder with a pointer but no program files says in plain words what to do, and uninstall works once it is moved out', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'runtime', 'managed-1a2b3c');
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'current.json'), '{"version":1,"current":"1.0.0"}');
  await assert.rejects(uninstall(f.root, {}, f.deps), /is damaged: its files are missing.*Next: move that folder out of the install folder yourself.*run the same command again/);
  await fs.rm(folder, { recursive: true });
  assert.equal((await uninstall(f.root, { confirmOffline: true }, f.deps)).status, 'uninstalled');
});

test('an empty launcher, backup, instructions or project-record folder that a cut-off install left does not block uninstall; an oddly named empty folder still does', async t => {
  const f = await fixture(t), cut = crypto.randomUUID();
  const folders = ['launchers/lane-two', 'backups/20261110T101010Z', 'backups/20261110T101010Z-1a2b3c', 'coordinator-instructions', ...['plans', 'receipts', 'control'].map(name => `sessions/${cut}/${name}`), 'launchers/Odd Name'];
  for (const folder of folders) await fs.mkdir(path.join(f.root, ...folder.split('/')), { recursive: true });
  const blocked = await uninstall(f.root, { confirmOffline: true }, f.deps);
  assert.deepEqual([blocked.status, blocked.installations[0].items], ['blocked', ['launchers/Odd Name/']]);
  await fs.rmdir(path.join(f.root, 'launchers', 'Odd Name'));
  assert.equal((await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps)).status, 'uninstalled');
  assert.equal(await exists(f.root), false);
});

test('a launcher folder holding only the settings file an older Setup wrote first does not block uninstall; a file of any other shape still does', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'launchers', 'lane-one'), settings = path.join(folder, 'launch-settings.json');
  const own = { node: 'node.exe', cli: path.join(f.root, 'runtime', 'current', 'bridge.mjs'), state: path.join(f.root, 'sessions', sessionId) };
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(settings, JSON.stringify(own) + '\n');
  assert.equal((await uninstall(f.root, {}, f.deps)).status, 'preview');
  for (const other of [{ ...own, note: 'mine' }, { ...own, cli: path.join(f.base, 'elsewhere', 'bridge.mjs') }]) {
    await fs.writeFile(settings, JSON.stringify(other) + '\n');
    const blocked = await uninstall(f.root, {}, f.deps);
    assert.deepEqual([blocked.status, blocked.installations[0].items], ['blocked', ['launchers/lane-one/launch-settings.json']]);
  }
});

test('a failed handoff copy during a purge stops it before anything is removed, with its own reason, and the scheduled task stays', async t => {
  const f = await resumeFixture(t), removed = [];
  await fs.writeFile(path.join(f.directory, 'handoff.md'), 'my notes');
  f.deps.tasks = { remove: async name => { removed.push(name); } };
  const real = fs.copyFile;
  fs.copyFile = async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
  let result;
  try { result = await uninstall(f.root, { confirmOffline: true, purge: true, confirmPurge: true }, f.deps); } finally { fs.copyFile = real; }
  assert.equal(result.status, 'incomplete');
  assert.deepEqual([result.installations[0].status, result.installations[0].reason], ['blocked', 'handoff-not-copied']);
  assert.match(result.installations[0].note, /The handoff file could not be copied next to the install folder, so nothing was removed/);
  assert.deepEqual(removed, [], 'the scheduled task is still in place');
  assert.equal(await fs.readFile(path.join(f.directory, 'handoff.md'), 'utf8'), 'my notes');
});

test('a folder or a link named disabled in the wake-up folder does not block uninstall; a link is removed without touching what it points to', async t => {
  const folder = await resumeFixture(t);
  await fs.mkdir(path.join(folder.directory, 'control', 'disabled'));
  assert.equal((await uninstall(folder.root, { confirmOffline: true, purge: true, confirmPurge: true }, folder.deps)).status, 'uninstalled');
  assert.equal(await exists(folder.root), false);
  const link = await resumeFixture(t), elsewhere = path.join(link.base, 'elsewhere');
  await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'kept');
  await fs.symlink(elsewhere, path.join(link.directory, 'control', 'disabled'), 'junction');
  const preview = await uninstall(link.root, {}, link.deps);
  assert.equal(preview.status, 'preview');
  const done = (await uninstall(link.root, { confirmOffline: true, purge: true, confirmPurge: true }, link.deps)).installations[0];
  assert.deepEqual([done.status, done.linkRemoved], ['uninstalled', true]);
  assert.equal(await exists(link.root), false);
  assert.equal(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf8'), 'kept');
});

test('a refused permission check leaves a link named disabled in place: nothing is removed before the checks pass', async t => {
  const f = await resumeFixture(t), link = path.join(f.directory, 'control', 'disabled'), elsewhere = path.join(f.base, 'elsewhere');
  await fs.mkdir(elsewhere); await fs.symlink(elsewhere, link, 'junction');
  f.deps.permissions = { verify: async () => {}, protect: async () => {}, verifyTree: async () => { throw Error(REVIEW); } };
  const refused = (await uninstall(f.root, { confirmOffline: true }, f.deps)).installations[0];
  assert.equal(refused.reason, 'permissions-review');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('an Installed apps entry whose folder is gone is removed on request, an entry that is not ours is left, and one such entry never blocks removing a working install', async t => {
  const f = await fixture(t), gone = path.join(f.base, 'gone-install'), id = installationId(gone);
  const command = `"node.exe" "${path.join(gone, 'uninstall.mjs')}" "${gone}" --all --ui`;
  f.registrations.set(f.record.id, { root: f.root, command: f.record.command });
  f.registrations.set(id, { root: gone, command });
  const result = await uninstall(f.root, { all: true, confirmOffline: true }, f.deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(await exists(f.root), false);
  assert.deepEqual([...f.registrations.keys()], [], 'the working install and the orphan entry are both gone from Installed apps');

  // The same entry with a command Setup did not write is somebody else's: it stays, and the person is told why.
  f.registrations.set(id, { root: gone, command: 'someone-elses-uninstaller' });
  const foreign = await uninstall(gone, { confirmOffline: true }, f.deps);
  assert.equal(foreign.status, 'blocked');
  assert.equal(foreign.installations[0].reason, 'foreign-registry-entry');
  assert.ok(f.registrations.has(id));

  // Windows refusing to remove the entry is reported, not called a success.
  f.registrations.set(id, { root: gone, command });
  f.deps.registry.remove = async () => { throw new Error('refused'); };
  const stuck = await uninstall(gone, { confirmOffline: true }, f.deps);
  assert.equal(stuck.status, 'incomplete');
  assert.equal(stuck.installations[0].reason, 'registry-removal-failed');
});

test('an Installed apps entry whose folder is gone is found whatever letter case the folder is typed in, and is shown once', async t => {
  const f = await fixture(t), gone = path.join(f.base, 'Gone-Install'), typed = gone.toLowerCase(), id = installationId(gone);
  f.registrations.set(id, { root: gone, command: `"node.exe" "${path.join(gone, 'uninstall.mjs')}" "${gone}" --all --ui` });
  const preview = await uninstall(typed, { all: true }, f.deps);
  assert.equal(preview.status, 'preview', JSON.stringify(preview));
  assert.equal(preview.installations.length, 1);
  const result = await uninstall(typed, { confirmOffline: true }, f.deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(f.registrations.has(id), false);
});

test('a lock that an unfinished update kept is explained as that, with the pointer check; any other lock names both ways it can be there', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'runtime', 'current'), lock = path.join(folder, 'activate.lock');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, kept: true }));
  const kept = (await uninstall(f.root, {}, f.deps)).installations[0];
  assert.equal(kept.reason, 'running-or-locked');
  assert.match(kept.note, /^An earlier update could not put the version pointer back and left its lock, so nothing was removed\. Next: in .*current, check that current\.json names a folder that exists inside versions.*delete only the file activate\.lock there and run pots uninstall again/);
  assert.doesNotMatch(kept.note, /crash/);
  assert.match(UPGRADE_ERRORS.kept, /in the folder runtime\/current inside the install folder, check that current\.json names a folder that exists inside versions.*delete only the file activate\.lock there/);

  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, up: os.uptime() }));
  assert.match((await uninstall(f.root, {}, f.deps)).installations[0].note, /Either a program that is still running holds it, or a crash left it behind/);
});
