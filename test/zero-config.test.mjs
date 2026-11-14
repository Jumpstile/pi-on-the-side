import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { autoSetup, AUTO_ERRORS, resultMessage } from '../src/autosetup.mjs';
import { RELEASE_FILES, UPGRADE_ERRORS } from '../src/update.mjs';
import { registerInstallation, uninstall, auditExternal } from '../src/uninstall.mjs';
import { zip } from '../src/zip.mjs';
import { loadSetup } from '../src/setup.mjs';

// The installer is the only configuration step: after it finishes (fresh or over an older install) the assistant
// apps are connected, the coordinator text is in place, and a coordinator can reach the lane tools. Every app
// folder below is a disposable fake home; no real Claude, Codex, registry, network or OMP is involved.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8')).version;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFile(file);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.lstat(file).then(() => true, () => false);
const NODE_SERVER = 'omp-session-bridge';

async function world(t, { codex = true, claude = true, app = codex } = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-zero-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const home = path.join(base, 'home'); await fs.mkdir(home);
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const file = path.join(sessions, 'saved.jsonl'), sessionId = crypto.randomUUID();
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  if (codex) await fs.mkdir(path.join(home, '.codex'));
  // The ChatGPT desktop app is a Windows app package from OpenAI; the Codex folder alone does not prove it (the command-line program makes that folder too).
  if (app) await fs.mkdir(path.join(base, 'Packages', 'OpenAI.ChatGPT-Desktop_fixture'), { recursive: true });
  if (claude) await fs.mkdir(path.join(home, '.claude'));
  const claudeExe = path.join(base, 'tools', 'claude.exe'); await fs.mkdir(path.dirname(claudeExe)); await fs.writeFile(claudeExe, 'fake claude');
  // The assistant's own command line, modelled on what `claude mcp add/remove --scope user` does to its settings file.
  const claudeJson = path.join(home, '.claude.json'), calls = [];
  const runClient = async (exe, args) => {
    calls.push(args);
    const doc = await json(claudeJson).catch(() => ({})); doc.mcpServers ??= {};
    if (args[1] === 'add') {
      const dash = args.indexOf('--'), env = {};
      args.forEach((arg, i) => { if (arg === '--env') { const [name, ...rest] = args[i + 1].split('='); env[name] = rest.join('='); } });
      doc.mcpServers[args[dash - 1]] = { type: 'stdio', command: args[dash + 1], args: args.slice(dash + 2), env };
    } else if (args[1] === 'remove') delete doc.mcpServers[args[2]];
    await fs.writeFile(claudeJson, JSON.stringify(doc));
    return { stdout: '' };
  };
  const registry = new Map();
  const register = (root, options) => registerInstallation(root, { ...options, registry: { read: async id => registry.get(id) ?? null,
    write: async (id, entry) => registry.set(id, { root: entry.InstallLocation, command: entry.UninstallString }) } });
  const root = path.join(base, 'private-setup');
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base }, home,
    nodeVersion: process.versions.node, nodeExecutable: process.execPath, locate: async () => process.execPath,
    detect: async () => 'omp/18.8.6',
    startCheck: async () => {}, which: async name => name === 'claude.exe' ? claudeExe : null, runClient, registerUninstall: register,
    tasks: undefined, selfTest: undefined,
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  const w = { base, home, root, cwd, file, sessionId, deps, calls, claudeJson, registry, codexFile: path.join(home, '.codex', 'config.toml'),
    skillFile: path.join(home, '.claude', 'skills', 'pi-on-the-side', 'SKILL.md'),
    run: (options = {}, over = {}) => autoSetup({ root, name: 'lane', ...options }, { ...deps, ...over }) };
  w.managed = path.join(root, 'runtime', 'current');
  return w;
}
async function tree(dir) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    rows.push([path.relative(dir, full).split(path.sep).join('/'), sha(await fs.readFile(full))]);
  }
  return rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
}
// What a coordinator does first: start the registered command, say hello, list the tools.
async function coordinatorTools(entry) {
  const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  const frames = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-coordinator', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
  for (const frame of frames) child.stdin.write(JSON.stringify(frame) + '\n');
  for (let i = 0; i < 2400 && !out.includes('"id":2'); i++) await new Promise(resolve => setTimeout(resolve, 25));
  child.kill();
  const reply = out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === 2);
  return reply?.result?.tools?.map(tool => tool.name).sort() ?? [];
}
const OLDER_DROP = ['src/lane-watch.mjs', 'src/clients.mjs'];
async function becomeOlder(w, label) {
  const files = new Map();
  for (const name of RELEASE_FILES.filter(name => !OLDER_DROP.includes(name))) files.set(name, await read(path.join(CHECKOUT, name)));
  const pkg = JSON.parse(files.get('package.json')); delete pkg.runtimeFiles;
  files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, version: label }, null, 2) + '\n'));
  const dir = path.join(w.managed, 'versions', label), record = { version: 1, release: label, digest: 'sha256:' + sha(zip([...files].map(([name, data]) => ({ name, data })))), files: {} };
  await fs.rm(path.join(w.managed, 'versions', VERSION), { recursive: true, force: true });
  for (const [name, data] of files) { record.files[name] = sha(data); await fs.mkdir(path.dirname(path.join(dir, ...name.split('/'))), { recursive: true }); await fs.writeFile(path.join(dir, ...name.split('/')), data); }
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify(record) + '\n');
  await fs.writeFile(path.join(w.managed, 'current.json'), JSON.stringify({ version: 1, current: label, previous: null }) + '\n');
}

test('fresh install ends fully configured: Claude Code, Codex and the Claude skill are set, one assistant directs, and a coordinator can reach the lane tools', async t => {
  const w = await world(t), result = await w.run();
  const entry = (await json(w.claudeJson)).mcpServers[NODE_SERVER], launcher = path.join(w.managed, 'bridge.mjs');
  assert.deepEqual([entry.type, entry.command, entry.args], ['stdio', process.execPath, [launcher, 'mcp']]);
  assert.equal(entry.env.OMP_BRIDGE_STATE, path.join(w.root, 'connections'));
  assert.equal(entry.env.OMP_BRIDGE_CONTROLLER, path.join(w.root, 'credentials', 'controller.json'), 'Claude Code is the one directing assistant');
  const toml = await read(w.codexFile).then(bytes => bytes.toString('utf8'));
  assert.match(toml, /\[mcp_servers\.omp-session-bridge\]/);
  assert.match(toml, /default_tools_approval_mode = "writes"/);
  assert.ok(!toml.includes('OMP_BRIDGE_CONTROLLER'), 'a second assistant never receives the write credential');
  const skill = await read(w.skillFile).then(bytes => bytes.toString('utf8'));
  assert.match(skill, /^---\nname: pi-on-the-side\n/);
  assert.match(skill, /bridge_lane_watch_lines/);
  assert.deepEqual(result.assistants.items.map(item => item.status), ['configured', 'configured', 'configured']);
  // The only thing left that no program can do is ChatGPT's own account setting, and it is one command away.
  assert.deepEqual(result.assistants.needsYou.map(item => [item.client, item.action]), [['ChatGPT', 'copy-chatgpt-instructions']]);
  assert.ok(await exists(result.assistants.needsYou[0].file));
  assert.ok(result.summary.length >= 5 && result.summary.every(line => typeof line === 'string' && line.length > 10));
  // Uninstall knows what to take back.
  const record = await json(path.join(w.root, 'uninstall-record.json'));
  assert.equal(record.claudeCode.exe.endsWith('claude.exe'), true);
  assert.deepEqual(record.assistants.map(row => row.kind).sort(), ['claude-skill', 'codex']);
  // The registered command really serves the tools a coordinator needs.
  const tools = await coordinatorTools(entry);
  for (const name of ['bridge_enqueue', 'bridge_status', 'bridge_lanes_status', 'bridge_lane_watch_lines', 'bridge_coordinator_heartbeat']) assert.ok(tools.includes(name), name);
});

test('running the installer again changes nothing: no file anywhere, no assistant command, no backup', async t => {
  const w = await world(t); await w.run();
  const before = { root: await tree(w.root), home: await tree(w.home), calls: w.calls.length };
  const result = await w.run();
  assert.deepEqual(await tree(w.root), before.root); assert.deepEqual(await tree(w.home), before.home);
  assert.equal(w.calls.length, before.calls);
  assert.equal(result.upgrade.kind, 'unchanged'); assert.equal(result.backupFolder, null);
  assert.deepEqual(result.assistants.items.map(item => item.status), ['already-configured', 'already-configured', 'already-configured']);
});

test('upgrade over an older install ends configured without touching any assistant setting: the registrations point at the stable launcher', async t => {
  const w = await world(t); await w.run(); await becomeOlder(w, '0.2.11');
  const home = await tree(w.home), calls = w.calls.length, codex = await read(w.codexFile);
  const result = await w.run();
  assert.equal(result.upgrade.kind, 'upgrade');
  assert.deepEqual(await tree(w.home), home, 'the assistants already use the stable launcher, so their settings need no change');
  assert.equal(w.calls.length, calls);
  assert.deepEqual(result.assistants.items.map(item => item.status), ['already-configured', 'already-configured', 'already-configured']);
  assert.deepEqual(await read(w.codexFile), codex, 'Codex keeps its connection to the stable launcher after the upgrade');
  assert.match(codex.toString('utf8'), /\[mcp_servers\.omp-session-bridge\]/);
  assert.deepEqual(await json(path.join(w.managed, 'current.json')), { version: 1, current: VERSION, previous: '0.2.11' });
  const entry = (await json(w.claudeJson)).mcpServers[NODE_SERVER];
  const tools = await coordinatorTools(entry);
  assert.ok(tools.includes('bridge_lane_watch_lines'), 'the registered command now serves the new version');
});

test('an old fixed-folder install is moved onto the stable launcher and the assistant entries that pointed at it are updated, with their old part kept', async t => {
  const w = await world(t); await w.run();
  const oldDir = path.join(w.root, 'runtime', '0.2.11'); await fs.mkdir(path.join(oldDir, 'bin'), { recursive: true });
  const oldMcp = path.join(oldDir, 'bin', 'mcp.mjs'); await fs.writeFile(oldMcp, 'old');
  await fs.writeFile(path.join(oldDir, 'runtime-files.json'), JSON.stringify([{ name: 'bin/mcp.mjs', sha256: sha(Buffer.from('old')) }]) + '\n');
  await fs.rm(w.managed, { recursive: true, force: true });
  const settingsFile = path.join(w.root, 'launchers', 'lane', 'launch-settings.json'), settings = await json(settingsFile);
  await fs.writeFile(settingsFile, JSON.stringify({ ...settings, cli: path.join(oldDir, 'bin', 'bridge.mjs') }) + '\n');
  const doc = await json(w.claudeJson); doc.mcpServers[NODE_SERVER].args = [oldMcp]; await fs.writeFile(w.claudeJson, JSON.stringify(doc));
  const result = await w.run();
  assert.equal(result.upgrade.launcherSwitched, true);
  assert.deepEqual((await json(w.claudeJson)).mcpServers[NODE_SERVER].args, [path.join(w.managed, 'bridge.mjs'), 'mcp']);
  assert.equal(result.assistants.items.find(item => item.client === 'Claude Code' && item.what === 'connection').status, 'updated');
  const kept = await json(path.join(result.backupFolder, 'claude-code-connection.json'));
  assert.deepEqual(kept.previous.args, [oldMcp]);
  assert.equal(await read(oldMcp).then(String), 'old', 'the old runtime is untouched');
});

test('if one assistant app cannot be connected, the install still finishes, names that app and the next step, and leaves nothing half done in it', async t => {
  const failAdd = { runClient: async (exe, args) => { if (args[1] === 'add') throw new Error('assistant command failed'); return { stdout: '' }; } };
  // An upgrade over an older install.
  const w = await world(t); await w.run({ clients: 'claude' }); await becomeOlder(w, '0.2.11');
  await fs.rm(w.claudeJson); await fs.rm(path.dirname(w.skillFile), { recursive: true });
  const result = await w.run({}, failAdd);
  assert.equal((await json(path.join(w.managed, 'current.json'))).current, VERSION, 'the new version is in place and the bridge works');
  assert.deepEqual(result.assistants.items.filter(item => item.status === 'failed').map(item => item.client), ['Claude Code']);
  assert.equal(await exists(w.claudeJson), false, 'the failed connection left nothing behind');
  assert.match(resultMessage(result), /^Upgraded to .* Next: Close Claude Code and run pots install again\./);
  assert.ok(!/could not be checked/.test(result.summary.join(' ')), 'the copy was checked; only the one app failed');
  // Once the app works, running it again connects it.
  const fixed = await w.run();
  assert.equal(fixed.assistants.items.find(item => item.client === 'Claude Code' && item.what === 'connection').status, 'configured');
  // A first install has no previous version, and the text never talks about one.
  const fresh = await world(t, { codex: false }), first = await fresh.run({ clients: 'claude' }, failAdd);
  assert.equal(first.upgrade.kind, 'fresh');
  assert.ok(await exists(path.join(fresh.managed, 'bridge.mjs')), 'the bridge is installed');
  assert.match(resultMessage(first), /^Installed Pi on the Side .* Next: Close Claude Code and run pots install again\./);
  assert.ok(!/previous version/.test(resultMessage(first) + first.summary.join(' ')));
});

test('running pots install again with no options keeps the earlier choices: clients, wake-ups and the resume watchdog', async t => {
  const w = await world(t); const handoff = path.join(w.base, 'handoff.md'); await fs.writeFile(handoff, 'handoff\n');
  await w.run({ clients: 'claude', coordinatorWakeups: false, coordinatorResume: { cliClients: 'claude', handoffFile: handoff, dryRun: true } });
  const before = await tree(w.root);
  const again = await w.run();
  assert.equal(again.clients, 'claude'); assert.equal(again.coordinatorWakeups, false);
  assert.equal(again.coordinatorResume.options.cliClients, 'claude');
  assert.deepEqual(await tree(w.root), before);
});

test('what cannot be automated is reported with its fix: OMP models, Claude Desktop, ChatGPT text, apps that are not installed', async t => {
  const w = await world(t, { codex: false, claude: false });
  await fs.mkdir(path.join(w.base, 'appdata', 'Claude'), { recursive: true });
  const result = await w.run({ clients: 'both' }, { which: async () => null, env: { ...w.deps.env, APPDATA: path.join(w.base, 'appdata') },
    modelRoles: async () => ({ status: 'missing', missing: ['advisor', 'slow'] }) });
  assert.deepEqual(result.assistants.needsYou.map(item => item.action).sort(), [undefined], 'no ChatGPT app, so no ChatGPT text to paste');
  assert.ok(JSON.parse(await fs.readFile(path.join(w.base, 'appdata', 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers['omp-session-bridge'], 'Claude Desktop is connected through its own settings file');
  for (const item of result.assistants.needsYou) { assert.ok(item.message.length > 20 && item.fix.length > 20, JSON.stringify(item)); assert.ok(!/\bat .*:\d+/.test(item.message)); }
  assert.deepEqual(result.modelRoles, { status: 'missing', missing: ['advisor', 'slow'] });
  assert.equal(await exists(w.claudeJson), false);
  // No assistant app installed at all: each missing app says what to install, and running pots install again connects it.
  const none = await world(t, { codex: false, claude: false });
  const bare = await none.run({ clients: 'both' }, { which: async () => null });
  assert.deepEqual(bare.assistants.needsYou.map(item => item.action).sort(), ['connect-again', 'connect-again']);
  assert.ok(bare.assistants.items.every(item => item.status === 'not-installed'));
  assert.deepEqual(bare.modelRoles, { status: 'unchecked', missing: [] });
});

test('uninstall takes back only what the installer set up in the assistant apps and keeps everything the user added', async t => {
  const w = await world(t);
  await fs.writeFile(w.codexFile, 'model = "x"\n\n[mcp_servers.other]\ncommand = "other"\n');
  await w.run();
  const doc = await json(w.claudeJson); doc.mcpServers.other = { type: 'stdio', command: 'other' }; await fs.writeFile(w.claudeJson, JSON.stringify(doc));
  let removed = 0;
  const integration = { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null,
    remove: async () => { removed++; const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } };
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; }, integration, audit: async () => [] };
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(removed, 1);
  const toml = await read(w.codexFile).then(String);
  assert.equal(toml, 'model = "x"\n\n[mcp_servers.other]\ncommand = "other"\n', 'only the installer block was removed, byte for byte');
  assert.equal(await exists(w.skillFile), false);
  assert.deepEqual(Object.keys((await json(w.claudeJson)).mcpServers), ['other']);
});

test('uninstall removes an install whose wake-ups were switched off by the person (the stored choice is not an unknown file)', async t => {
  const w = await world(t);
  await w.run({ coordinatorWakeups: false });
  assert.equal(await exists(path.join(w.root, 'coordinator-resume', 'control', 'wakeups-off')), true);
  const integration = { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null,
    remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } };
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; }, integration, audit: async () => [] };
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
});

test('uninstall removes an install after wake-ups were switched off and on again, also when the on-choice is still waiting for an open session', async t => {
  const w = await world(t);
  await w.run({ coordinatorWakeups: false });
  const on = await w.run({ coordinatorWakeups: true }), control = path.join(w.root, 'coordinator-resume', 'control');
  assert.equal(await exists(path.join(control, 'wakeups-off')), false);
  const lock = (await loadSetup(on.sessions[0].stateFolder)).lockFile;
  await w.run({ coordinatorWakeups: false });
  await fs.writeFile(lock, 'open'); await w.run({ coordinatorWakeups: true }); await fs.unlink(lock); // the on-choice waits for the open session
  assert.equal(await exists(path.join(control, 'wakeups-on')), true);
  const integration = { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null,
    remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } };
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; }, integration, audit: async () => [] };
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
});

test('uninstall is not blocked by the empty coordinator-resume folder an undone off-choice run leaves behind', async t => {
  const w = await world(t);
  await w.run({ coordinatorWakeups: false });
  const folder = path.join(w.root, 'coordinator-resume');
  await fs.rm(path.join(folder, 'control', 'wakeups-off')); await fs.rm(path.join(folder, 'ownership.json')); // what the undo of a failed run puts back
  const integration = { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null,
    remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } };
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; }, integration, audit: async () => [] };
  assert.equal((await uninstall(w.root, { confirmOffline: true }, deps)).status, 'uninstalled');
});

test('uninstall leaves the Codex block alone when the user added something inside it, and says so', async t => {
  const w = await world(t);
  await w.run();
  const edited = (await read(w.codexFile)).toString().replace('default_tools_approval_mode', 'USER_ADDED = "keep me"\ndefault_tools_approval_mode');
  await fs.writeFile(w.codexFile, edited);
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null, remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } }, audit: async () => [] };
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal((await read(w.codexFile)).toString(), edited, 'the edited block is byte for byte as the user left it');
  assert.ok(JSON.stringify(result).includes('config.toml'), 'the kept file is reported');
});

test('a failure late in the run also puts back the owned files changed earlier in it: settings, coordinator text and the resume watchdog', async t => {
  const w = await world(t), handoff = path.join(w.base, 'handoff.md'); await fs.writeFile(handoff, 'handoff\n');
  const resume = { cliClients: 'claude', handoffFile: handoff, dryRun: true };
  await w.run({ clients: 'claude', coordinatorWakeups: true, coordinatorResume: resume });
  const before = { root: await tree(w.root), home: await tree(w.home) };
  const changed = { coordinatorWakeups: false, coordinatorResume: { ...resume, pollMs: 3000 } };
  await assert.rejects(w.run(changed, { registerUninstall: async () => { throw new Error('synthetic registry refusal'); } }), /synthetic registry refusal/);
  const after = await tree(w.root);
  assert.deepEqual(before.root.filter(row => !after.some(([rel, hash]) => rel === row[0] && hash === row[1])), [], 'nothing that existed before the failed run was left changed');
  assert.deepEqual(await tree(w.home), before.home);
  // The same request without the failure applies the change.
  const done = await w.run(changed);
  assert.equal(done.coordinatorWakeups, false);
  assert.equal((await json(path.join(w.root, 'coordinator-resume', 'config.json'))).pollMs, 3000);
});

test('rollback never overwrites a file somebody changed after Setup wrote it: it is kept and reported', async t => {
  const w = await world(t), handoff = path.join(w.base, 'handoff.md'); await fs.writeFile(handoff, 'handoff\n');
  const resume = { cliClients: 'claude', handoffFile: handoff, dryRun: true };
  await w.run({ clients: 'claude', coordinatorResume: resume });
  const prompt = path.join(w.root, 'coordinator-resume', 'resume-prompt.txt'), config = path.join(w.root, 'coordinator-resume', 'config.json');
  const pollBefore = (await json(config)).pollMs;
  const failing = async () => { await fs.appendFile(prompt, 'a line the owner added\n'); throw new Error('synthetic registry refusal'); };
  const error = await w.run({ coordinatorResume: { ...resume, pollMs: 3000 } }, { registerUninstall: failing }).then(() => null, e => e);
  assert.equal(error?.message, 'synthetic registry refusal');
  assert.match(await read(prompt).then(String), /a line the owner added/, 'the owner edit survived');
  assert.deepEqual(error.left, ['resume-prompt.txt was changed after Setup wrote it, so it was kept as it is.']);
  assert.equal((await json(config)).pollMs, pollBefore, 'the generated file the owner had not touched was put back');
});

test('choosing fewer assistants on a later run does not make the uninstaller forget what an earlier run set up', async t => {
  const w = await world(t);
  await w.run();
  await w.run({ clients: 'claude' });
  const record = await json(path.join(w.root, 'uninstall-record.json'));
  assert.deepEqual(record.assistants.map(row => row.kind).sort(), ['claude-skill', 'codex']);
  assert.match(await read(w.codexFile).then(String), /\[mcp_servers\.omp-session-bridge\]/, 'the earlier Codex block is still there and still tracked');
  // The whole lifecycle: uninstall still removes the earlier Codex block and keeps what the user added.
  await fs.appendFile(w.codexFile, '\n[mcp_servers.other]\ncommand = "other"\n');
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null, remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } }, audit: async () => [] };
  assert.equal((await uninstall(w.root, { confirmOffline: true }, deps)).status, 'uninstalled');
  const after = await read(w.codexFile).then(String);
  assert.ok(!after.includes('omp-session-bridge'), 'the earlier Codex block was removed');
  assert.match(after, /\[mcp_servers\.other\]/, 'the user table survived');
});

test('choosing another client on a later run moves the write credential, tells the user, and uninstall still takes back the earlier registration', async t => {
  const w = await world(t);
  await w.run();
  const credential = path.join(w.root, 'credentials', 'controller.json');
  assert.equal((await json(w.claudeJson)).mcpServers[NODE_SERVER].env.OMP_BRIDGE_CONTROLLER, credential);
  const result = await w.run({ clients: 'chatgpt' });
  const entry = (await json(w.claudeJson)).mcpServers[NODE_SERVER];
  assert.equal(entry.env.OMP_BRIDGE_CONTROLLER, undefined, 'Claude Code no longer holds the write credential');
  assert.equal(entry.env.OMP_BRIDGE_STATE, path.join(w.root, 'connections'), 'but it stays connected');
  assert.match(await read(w.codexFile).then(String), /OMP_BRIDGE_CONTROLLER/, 'the ChatGPT desktop app / Codex directs now');
  assert.ok(result.summary.some(line => /Claude Code is now a read-only viewer, which cannot send or cancel tasks, because ChatGPT desktop app \(Codex\) directs now/.test(line)));
  assert.ok(result.backupFolder && (await json(path.join(result.backupFolder, 'claude-code-connection.json'))).previous.env.OMP_BRIDGE_CONTROLLER === credential, 'the earlier entry was kept');
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null, remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } }, audit: async () => [] };
  assert.equal((await uninstall(w.root, { confirmOffline: true }, deps)).status, 'uninstalled');
  assert.equal((await json(w.claudeJson)).mcpServers?.[NODE_SERVER], undefined, 'the changed Claude Code registration was still recognised as ours');
  assert.ok(!(await read(w.codexFile).then(String)).includes('omp-session-bridge'));
});

test('a model check that could not run is reported, not treated as fine', async t => {
  const w = await world(t);
  const result = await w.run({}, { modelRoles: async () => ({ status: 'unchecked', missing: [] }) });
  assert.ok(result.assistants.needsYou.some(item => item.client === 'OMP' && /could not check/.test(item.message)));
});

// Setup has no folder option, so an older folder at the default location must never stop it. Everything below uses fake
// folders under a disposable base; the older folder stands for what a hand-made earlier layout looked like.
const DEFAULT_NAME = 'OMP Session Bridge Local';
async function defaultWorld(t) {
  const w = await world(t);
  w.root = path.join(w.base, DEFAULT_NAME); w.managed = path.join(w.root, 'runtime', 'current');
  // A process finder that sees nothing running: Setup then also cleans up, and what it cannot prove is left alone.
  w.deps = { ...w.deps, processes: async () => [], registry: { read: async id => w.registry.get(id) ?? null, write: async () => {}, remove: async id => { w.registry.delete(id); }, list: async () => [...w.registry.values()].map(row => row.root) } };
  w.run = (options = {}, over = {}) => autoSetup({ name: 'lane', ...options }, { ...w.deps, ...over });
  w.sibling = n => path.join(w.base, `${DEFAULT_NAME} ${n}`);
  return w;
}
async function legacyFolder(dir) {
  for (const sub of ['chatgpt-client', 'connections', 'coordination-work', 'credentials', 'runtime/alpha', 'runtime/beta', 'sessions', 'transcripts', 'updates']) await fs.mkdir(path.join(dir, sub), { recursive: true });
  await fs.writeFile(path.join(dir, 'credentials', 'controller.json'), 'fake credential text');
  await fs.writeFile(path.join(dir, 'runtime', 'alpha', 'bridge.mjs'), 'old launcher');
  await fs.writeFile(path.join(dir, 'transcripts', 'one.jsonl'), '{"line":1}\n');
  await fs.writeFile(path.join(dir, 'Start-Alpha.ps1'), 'Write-Host alpha\r\n');
  await fs.writeFile(path.join(dir, 'Start-Beta.ps1'), 'Write-Host beta\r\n');
}
// Every path (empty folders included) and every file's bytes: one value that changes if anything in the tree does.
async function deepHash(dir) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name), rel = path.relative(dir, full).split(path.sep).join('/');
    rows.push(entry.isFile() ? rel + ':' + sha(await fs.readFile(full)) : rel + '/');
  }
  return sha(Buffer.from(rows.sort().join('\n')));
}
const removalDeps = w => ({ platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
  processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
  integration: { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null, remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } },
  audit: roots => auditExternal(roots, { home: w.home, env: w.deps.env }) });
const OLDER_MESSAGE = (older, chosen) => `Found a folder that Setup did not make (${older}). It was left alone. Pi on the Side is using a new folder: ${chosen}.`;

test('default folder missing: Setup creates it under its plain name', async t => {
  const w = await defaultWorld(t), result = await w.run();
  assert.equal(result.installRoot, w.root);
  assert.equal(result.olderFolder, undefined);
  assert.ok(!result.summary.some(line => /older setup folder/.test(line)));
  assert.ok(await exists(path.join(w.root, 'local-setup.json')));
  assert.equal(await exists(w.sibling(2)), false);
});

test('default folder is already a managed setup: it is reused and upgraded in place, never moved', async t => {
  const w = await defaultWorld(t); await w.run(); await becomeOlder(w, '0.2.11');
  const result = await w.run();
  assert.equal(result.installRoot, w.root);
  assert.equal(result.upgrade.kind, 'upgrade');
  assert.equal(result.olderFolder, undefined);
  assert.ok(!result.summary.some(line => /older setup folder/.test(line)));
  assert.equal(await exists(w.sibling(2)), false);
  assert.deepEqual(await json(path.join(w.managed, 'current.json')), { version: 1, current: VERSION, previous: '0.2.11' }, 'the older version stays as the rollback target');
  assert.equal(await exists(path.join(w.managed, 'versions', '0.2.11')), true);
});

test('an older folder that Setup cannot recognise is left byte for byte; Setup uses a new sibling, finds it again, upgrades it, and uninstall never touches the older folder', async t => {
  const w = await defaultWorld(t), older = w.root, sibling = w.sibling(2);
  await legacyFolder(older); const untouched = await deepHash(older);
  const first = await w.run();
  assert.equal(first.installRoot, sibling);
  assert.equal(first.olderFolder, older);
  assert.equal(first.summary[0], OLDER_MESSAGE(older, sibling), 'the first line of the summary says it in plain words');
  assert.ok(await exists(path.join(sibling, 'local-setup.json')));
  assert.equal(await deepHash(older), untouched, 'the older folder is unchanged');
  assert.equal(await exists(w.sibling(3)), false);

  const settled = await tree(sibling), again = await w.run();
  assert.equal(again.installRoot, sibling, 'the second run reuses the same folder');
  assert.equal(again.upgrade.kind, 'unchanged');
  // The first run's own backup copies existed, the second run removed exactly those, and nothing else changed.
  const firstBackups = settled.filter(([rel]) => rel.startsWith('backups/'));
  assert.ok(firstBackups.length > 0, 'the first run left its own backup copies');
  const afterSecond = await tree(sibling);
  assert.deepEqual(afterSecond.filter(([rel]) => rel.startsWith('backups/')), [], 'the second run removed the first run\'s backup copies');
  assert.deepEqual(afterSecond, settled.filter(([rel]) => !rel.startsWith('backups/')));
  assert.equal((await w.run()).backupsRemoved, 0, 'a third run has nothing left to remove');
  assert.deepEqual(await tree(sibling), afterSecond, 'and changes nothing');
  assert.equal(await exists(w.sibling(3)), false);
  assert.equal(await deepHash(older), untouched);

  w.managed = path.join(sibling, 'runtime', 'current'); await becomeOlder(w, '0.2.11');
  const upgraded = await w.run();
  assert.equal(upgraded.installRoot, sibling);
  assert.equal(upgraded.upgrade.kind, 'upgrade');
  assert.equal(await deepHash(older), untouched);

  const removed = await uninstall(sibling, { all: true, confirmOffline: true }, removalDeps(w));
  assert.equal(removed.status, 'uninstalled', JSON.stringify(removed));
  assert.equal(await exists(sibling), false, 'the folder Setup made is gone');
  assert.equal(await deepHash(older), untouched, 'the older folder is exactly as it was');
});

test('a managed sibling is still found when the older folder is later removed by its owner', async t => {
  const w = await defaultWorld(t); await legacyFolder(w.root);
  const first = await w.run(); assert.equal(first.installRoot, w.sibling(2));
  await fs.rm(w.root, { recursive: true });
  const again = await w.run();
  assert.equal(again.installRoot, w.sibling(2), 'Setup does not start a second install at the plain name');
  assert.equal(again.olderFolder, undefined);
  assert.ok(!again.summary.some(line => /older setup folder/.test(line)));
  assert.equal(await exists(w.root), false);
});

test('names that look like Setup folders but are not are skipped: only a folder with the exact marker or a valid install pointer is reused', async t => {
  const w = await defaultWorld(t);
  // The plain name: only Setup-looking entries, no marker, no pointer. "2": a marker of another version.
  for (const sub of ['credentials', 'sessions', 'runtime', 'connections']) await fs.mkdir(path.join(w.root, sub), { recursive: true });
  await fs.mkdir(w.sibling(2)); await fs.writeFile(path.join(w.sibling(2), 'local-setup.json'), JSON.stringify({ version: 2, type: 'omp-session-bridge-local' }));
  // "3": a pointer file that is not a pointer. "4": a plain file with that name.
  await fs.mkdir(path.join(w.sibling(3), 'runtime', 'x'), { recursive: true }); await fs.writeFile(path.join(w.sibling(3), 'runtime', 'x', 'current.json'), '{"hello":1}');
  await fs.writeFile(w.sibling(4), 'a file');
  const hashes = { plain: await deepHash(w.root), two: await deepHash(w.sibling(2)), three: await deepHash(w.sibling(3)) };
  const result = await w.run();
  assert.equal(result.installRoot, w.sibling(5));
  assert.equal(result.olderFolder, w.root);
  assert.deepEqual([await deepHash(w.root), await deepHash(w.sibling(2)), await deepHash(w.sibling(3))], [hashes.plain, hashes.two, hashes.three]);
  assert.equal(await fs.readFile(w.sibling(4), 'utf8'), 'a file');
});

// What earlier releases left in the default folder: a managed install pointer, no marker file, and entries the current
// Setup does not know. The upgrade must reuse that folder (no "... 2" copy) and connect both assistants.
for (const older of ['0.2.11', '0.2.13', '0.2.16']) {
  test(`an install folder from ${older} without the marker file and with extra entries is reused, not copied; both assistants stay connected`, async t => {
    const w = await defaultWorld(t); await w.run();
    await fs.rm(path.join(w.root, 'local-setup.json'));
    const extras = { 'updates/note.txt': 'old updater scratch', 'Start-Alpha.ps1': 'Write-Host alpha\r\n', 'transcripts/one.jsonl': '{"line":1}\n' };
    for (const [rel, text] of Object.entries(extras)) { await fs.mkdir(path.dirname(path.join(w.root, rel)), { recursive: true }); await fs.writeFile(path.join(w.root, rel), text); }
    await becomeOlder(w, older);
    const codex = await read(w.codexFile), result = await w.run();
    assert.equal(result.installRoot, w.root);
    assert.equal(result.olderFolder, undefined);
    assert.equal(await exists(w.sibling(2)), false, 'no second copy is made');
    assert.equal(result.upgrade.kind, 'upgrade');
    assert.deepEqual(await json(path.join(w.root, 'local-setup.json')), { version: 1, type: 'omp-session-bridge-local' }, 'the marker is put back');
    for (const [rel, text] of Object.entries(extras)) assert.equal(await fs.readFile(path.join(w.root, rel), 'utf8'), text, rel + ' is left as it was');
    assert.deepEqual(result.assistants.items.map(item => item.status), ['already-configured', 'already-configured', 'already-configured']);
    assert.deepEqual(await read(w.codexFile), codex);
    assert.equal((await json(w.claudeJson)).mcpServers[NODE_SERVER].args[0], path.join(w.managed, 'bridge.mjs'));
  });
}

test('a Claude Code entry from an earlier install is reconnected when only the Node path changed; Codex stays connected', async t => {
  const w = await world(t); await w.run();
  const doc = await json(w.claudeJson), launcher = doc.mcpServers[NODE_SERVER].args[0];
  doc.mcpServers[NODE_SERVER].command = path.join(w.base, 'old-node', 'node.exe'); await fs.writeFile(w.claudeJson, JSON.stringify(doc));
  const codex = await read(w.codexFile), result = await w.run();
  const claude = result.assistants.items.find(item => item.client === 'Claude Code');
  assert.equal(claude.status, 'updated', JSON.stringify(claude));
  const entry = (await json(w.claudeJson)).mcpServers[NODE_SERVER];
  assert.deepEqual([entry.command, entry.args[0]], [process.execPath, launcher]);
  assert.deepEqual(await read(w.codexFile), codex, 'Codex is unchanged and still connected');
  assert.match(codex.toString('utf8'), /\[mcp_servers\.omp-session-bridge\]/);
  // An entry that runs something outside this install is still somebody else's and is left alone.
  const other = await json(w.claudeJson); other.mcpServers[NODE_SERVER] = { type: 'stdio', command: 'node.exe', args: [path.join(w.base, 'elsewhere', 'mcp.mjs')] }; await fs.writeFile(w.claudeJson, JSON.stringify(other));
  const again = await w.run();
  assert.equal(again.assistants.items.find(item => item.client === 'Claude Code').status, 'needs-you');
  assert.equal((await json(w.claudeJson)).mcpServers[NODE_SERVER].args[0], path.join(w.base, 'elsewhere', 'mcp.mjs'));
});

test('coordinator text: an older text Setup wrote is brought up to date; the owner\'s own or edited text is kept and never blocks the upgrade', async t => {
  const w = await world(t); await w.run();
  const folder = path.join(w.root, 'coordinator-instructions'), skill = path.join(folder, 'claude-skill.md'), chatgpt = path.join(folder, 'chatgpt-custom-instructions.txt');
  const current = await fs.readFile(skill, 'utf8');
  // Wake-ups on, watcher text, and the first interval wording: an earlier build's text that the old fixed list did not contain.
  const older = current.replace('at the shortest interval your own scheduling/reminder tool allows (the real delay depends on that client)', 'for about 2 minutes later using your own scheduling/reminder tool');
  assert.notEqual(older, current);
  await fs.writeFile(skill, older); await fs.writeFile(chatgpt, 'My own notes for the assistant.\n');
  let result = await w.run();
  assert.equal(await fs.readFile(skill, 'utf8'), current, 'Setup\'s own earlier text is replaced');
  assert.equal(await fs.readFile(chatgpt, 'utf8'), 'My own notes for the assistant.\n', 'the owner\'s own file is kept byte for byte');
  assert.ok(!result.assistants.items.some(item => item.status === 'failed'));
  assert.deepEqual(result.summary.filter(line => line.includes('Setup did not touch')).map(line => line.split(' It is not exactly')[0]), ['Setup did not touch ' + chatgpt + '.'],
    'the summary names the one file that was kept (not the one Setup replaced)');
  await fs.appendFile(skill, 'Owner note: keep this.\n');
  const edited = await fs.readFile(skill);
  result = await w.run();
  assert.deepEqual(await fs.readFile(skill), edited, 'an edited copy is kept as the owner left it');
  assert.ok(!result.assistants.items.some(item => item.status === 'failed'));
  assert.ok(result.summary.some(line => line.includes(skill) && line.includes('may not have the newest wake-up instructions')));
});

test('a setup lock left behind by a crash does not block the next run, and the run leaves no lock behind', async t => {
  const w = await world(t); await w.run();
  const lock = path.join(w.root, 'setup.lock'), old = new Date(Date.now() - 2 * 3600 * 1000);
  await fs.writeFile(lock, ''); await fs.utimes(lock, old, old);
  await w.run();
  assert.equal(await exists(lock), false);
  await fs.writeFile(lock, '');
  await assert.rejects(w.run(), /Setup \(another pots install\) or the assistant connection is already working on this install/, 'a recent lock may belong to a run that is still going');
});

test('when every default folder name is taken, Setup says so plainly and changes nothing', async t => {
  const w = await defaultWorld(t);
  await fs.mkdir(w.root); await fs.writeFile(path.join(w.root, 'mine.txt'), 'mine');
  for (let n = 2; n <= 50; n++) { await fs.mkdir(w.sibling(n)); await fs.writeFile(path.join(w.sibling(n), 'mine.txt'), 'mine'); }
  const before = await tree(w.base);
  await assert.rejects(w.run(), error => error.message === AUTO_ERRORS.find(text => /free folder/.test(text)));
  assert.deepEqual(await tree(w.base), before);
  assert.equal(await exists(w.sibling(51)), false);
});

test('an explicit --root behaves exactly as before: an unmanaged folder is refused and left alone, and it never moves to a sibling', async t => {
  const w = await defaultWorld(t);
  const own = path.join(w.base, 'chosen'); await legacyFolder(own); const untouched = await deepHash(own);
  await assert.rejects(w.run({ root: own }), /existing folder is not a managed private setup; choose a new --root/);
  assert.equal(await deepHash(own), untouched);
  // Naming the default folder explicitly is also an explicit choice.
  await legacyFolder(w.root); const defaultUntouched = await deepHash(w.root);
  await assert.rejects(w.run({ root: w.root }), /not a managed private setup/);
  assert.equal(await deepHash(w.root), defaultUntouched);
  assert.equal(await exists(w.sibling(2)), false);
  const fresh = await w.run({ root: path.join(w.base, 'managed-choice') });
  assert.equal(fresh.installRoot, path.join(w.base, 'managed-choice'));
  assert.equal(fresh.olderFolder, undefined);
});

test('the uninstall audit reports an unrecorded managed copy at the default location but not an older folder that is not Setup\'s', async t => {
  const w = await defaultWorld(t), env = w.deps.env;
  await legacyFolder(w.root);
  assert.deepEqual(await auditExternal([], { home: w.home, env }), [], 'an older folder is not Setup\'s and must not block removing an install');
  await fs.rm(w.root, { recursive: true });
  await w.run();
  assert.deepEqual((await auditExternal([], { home: w.home, env })).map(item => [item.path, item.reason]), [[w.root, 'unrecorded-copy-requires-local-review']]);
  assert.deepEqual(await auditExternal([w.root], { home: w.home, env }), [], 'a recorded install is not reported');
});

test('what Setup tells the user never asks for a command-line option or an install folder `pots install` cannot take', async t => {
  const w = await defaultWorld(t);
  // The project list refuses an over-deep saved-session folder; `pots install` has no --session to fall back on.
  await fs.mkdir(path.join(w.base, 'agent', 'sessions', 'a', 'b', 'c', 'd'), { recursive: true });
  await assert.rejects(w.run(), error => AUTO_ERRORS.includes(error.message) && /too many saved OMP sessions/.test(error.message));
  // Only the explicit --root refusal may name an option; no message tells the user to choose another install folder.
  const explicit = 'existing folder is not a managed private setup; choose a new --root';
  for (const message of [...AUTO_ERRORS, ...Object.values(UPGRADE_ERRORS)]) {
    if (message === explicit) continue;
    assert.ok(!/(^|\s)--[a-z]/.test(message) && !/choose a new|new install folder/i.test(message), message);
  }
});
test('the ChatGPT paste step follows the ChatGPT desktop app itself: not Claude Code only, not the Codex command-line program only, and yes with the app', async t => {
  const pasteStep = result => result.assistants.needsYou.some(item => item.action === 'copy-chatgpt-instructions');
  const only = await world(t, { codex: false }), result = await only.run();
  assert.ok(!pasteStep(result), JSON.stringify(result.assistants.needsYou));
  assert.ok(!/ChatGPT|pots instructions/.test(resultMessage(result)), resultMessage(result));
  const cli = await world(t, { app: false }), cliResult = await cli.run();
  assert.ok(!pasteStep(cliResult), 'a Codex folder without the ChatGPT app has nothing to paste into');
  assert.ok(!/pots instructions/.test(resultMessage(cliResult)), resultMessage(cliResult));
  const both = await world(t), withApp = await both.run();
  assert.ok(pasteStep(withApp));
  assert.match(resultMessage(withApp), /Run pots instructions/);
  const fresh = await world(t, { codex: false, app: true }), appOnly = await fresh.run({ clients: 'chatgpt' });
  assert.ok(pasteStep(appOnly), 'the app is installed but has not made its Codex folder yet: the paste step is still there');
});

test('a wake-up file the person changed and Setup no longer writes is named in the install result, and uninstall stops for it (default and purge) until the person moves it', async t => {
  const w = await world(t), handoffFile = path.join(w.base, 'handoff.md');
  await w.run({ coordinatorResume: { cliClients: 'claude', cloudClients: 'chatgpt', handoffFile } });
  const note = path.join(w.root, 'coordinator-resume', 'chatgpt-cloud-task.txt');
  await fs.writeFile(note, 'my own account note');
  const again = await w.run({ coordinatorResume: { cliClients: 'claude', cloudClients: 'none', handoffFile } });
  assert.equal(await fs.readFile(note, 'utf8'), 'my own account note', 'the changed file is kept');
  assert.ok(again.summary.some(line => line.includes(note) && /you changed them after Setup wrote them/.test(line) && /pots uninstall will stop and leave them where they are/.test(line)), again.summary.join('\n'));
  const deps = { platform: 'win32', registry: { read: async id => w.registry.get(id) ?? null, remove: async id => w.registry.delete(id), list: async () => [...w.registry.values()].map(row => row.root) },
    processes: async () => [], permissions: w.deps.permissions, recover: async root => { const target = root + '-recovered'; await fs.rename(root, target); return target; },
    integration: { read: async () => (await json(w.claudeJson)).mcpServers?.[NODE_SERVER] ?? null, remove: async () => { const d = await json(w.claudeJson); delete d.mcpServers[NODE_SERVER]; await fs.writeFile(w.claudeJson, JSON.stringify(d)); } }, audit: async () => [] };
  for (const options of [{ confirmOffline: true }, { confirmOffline: true, purge: true, confirmPurge: true }]) {
    const blocked = await uninstall(w.root, options, deps);
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.deepEqual([blocked.installations[0].reason, blocked.installations[0].items], ['unverified-files', ['coordinator-resume/chatgpt-cloud-task.txt']]);
    assert.equal(await fs.readFile(note, 'utf8'), 'my own account note', 'not moved and not deleted');
  }
  const mine = path.join(w.base, 'my-account-note.txt');
  await fs.rename(note, mine);
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.equal(result.status, 'uninstalled', JSON.stringify(result));
  assert.equal(await fs.readFile(mine, 'utf8'), 'my own account note', 'the file the person moved is untouched');
});
