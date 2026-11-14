import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { autoSetup, makeSessionSync, syncSessions } from '../src/autosetup.mjs';
import { acquireLock } from '../src/control.mjs';
import { createServer } from '../src/mcp.mjs';
import { readConnections } from '../src/connections.mjs';
import { registerInstallation, uninstall, uninstallDefaults } from '../src/uninstall.mjs';

// One bridge for every OMP session on the PC. Disposable folders only: no real OMP, no real assistant, no network.
const NOW = Date.now();
async function world(t, count) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-one-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const w = { base, agent, sessions, saved: [] };
  w.save = async name => {
    const cwd = path.join(base, 'project-' + name); await fs.mkdir(cwd);
    const file = path.join(sessions, name + '.jsonl'), sessionId = crypto.randomUUID();
    await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
    const row = { file, cwd, sessionId }; w.saved.push(row); return row;
  };
  for (let i = 0; i < count; i++) await w.save('s' + i);
  w.root = path.join(base, 'private-setup');
  w.deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base }, home: base, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
    locate: async () => process.execPath, detect: async () => 'omp/18.8.6', startCheck: async () => {},
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  w.install = () => autoSetup({ root: w.root }, w.deps);
  return w;
}
// The assistant adapter over the connections folder, as an assistant holds it. `sync` is what bin/mcp.mjs passes when the adapter holds the credential.
async function adapter(report, sync) {
  const server = createServer({ stateRoot: report.connectionsFolder, controllerFile: report.credentialFile, now: () => Date.now(), sync });
  let next = 1;
  const rpc = (method, params) => server.handle(JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params === undefined ? {} : { params }) }));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } });
  await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const call = async (name, args) => { const reply = await rpc('tools/call', { name, arguments: args }); return { error: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) }; };
  const names = async () => (await rpc('tools/list')).result.tools.find(tool => tool.name === 'bridge_enqueue').inputSchema.properties.connection.enum;
  return { call, names };
}
const plan = () => crypto.randomUUID();

test('two sessions at once keep separate queues: a plan, its receipt view and its cancel only ever touch its own session', async t => {
  const w = await world(t, 2), report = await w.install(), bridge = await adapter(report);
  const [a, b] = report.sessions.map(row => row.name), [idA, idB] = [plan(), plan()];
  assert.equal((await bridge.call('bridge_enqueue', { connection: a, id: idA, prompt: 'work for A' })).body.state, 'queued');
  assert.equal((await bridge.call('bridge_enqueue', { connection: b, id: idB, prompt: 'work for B' })).body.state, 'queued');
  const files = async row => (await fs.readdir(path.join(row.stateFolder, 'plans'))).sort();
  const [rowA, rowB] = report.sessions;
  assert.deepEqual(await files(rowA), [idA + '.json']); assert.deepEqual(await files(rowB), [idB + '.json']);
  const aPlan = JSON.parse(await fs.readFile(path.join(rowA.stateFolder, 'plans', idA + '.json'), 'utf8'));
  assert.equal(aPlan.sessionId, rowA.sessionId, 'the plan names its own session');
  // Each session answers only for its own plans.
  assert.equal((await bridge.call('bridge_receipt', { connection: b, id: idA })).body.error, 'unknown plan id');
  assert.equal((await bridge.call('bridge_receipt', { connection: a, id: idA })).body.state, 'queued');
  // Cancelling in A does not touch B.
  assert.equal((await bridge.call('bridge_cancel', { connection: a, id: idA })).body.cancelRequested, true);
  assert.equal((await bridge.call('bridge_receipt', { connection: b, id: idB })).body.cancelRequested, false);
  const status = (await bridge.call('bridge_status', {})).body.connections;
  assert.deepEqual(status.map(row => [row.name, row.plans.map(p => p.id)]).sort(), [[a, [idA]], [b, [idB]]].sort());
});

test('a session saved after Setup is connected by the adapter itself, with its own state, controller record and launcher; no restart, no question', async t => {
  const w = await world(t, 1), report = await w.install();
  const sync = () => syncSessions({ connectionsFolder: report.connectionsFolder, credentialFile: report.credentialFile, env: w.deps.env, home: w.base, detect: w.deps.detect });
  const bridge = await adapter(report, sync), readOnly = await adapter(report);
  assert.equal((await bridge.names()).length, 1);
  const later = await w.save('later');
  const names = await bridge.names();
  assert.equal(names.length, 2, 'the new session is offered to the assistant');
  const row = (await readConnections(report.connectionsFolder)).connections.find(c => c.binding.sessionId === later.sessionId);
  assert.ok(row, 'registered'); assert.equal(row.root, path.join(w.root, 'sessions', later.sessionId));
  assert.ok(await fs.stat(path.join(row.root, 'controller-' + later.sessionId + '.json')), 'its own controller record');
  assert.ok(await fs.stat(path.join(w.root, 'launchers', row.name, 'Start-OMP.ps1')), 'its own launcher');
  assert.equal((await bridge.call('bridge_enqueue', { connection: row.name, id: plan(), prompt: 'first task' })).body.state, 'queued', 'the assistant can send work to it at once');
  // An adapter that holds no credential never connects anything itself, but sees the registry as it is now.
  assert.deepEqual((await readOnly.names()).sort(), names.sort());
  const more = await w.save('even-later');
  assert.equal((await readOnly.names()).length, 2, 'a read-only adapter does not connect sessions');
  assert.ok(!(await readConnections(report.connectionsFolder)).connections.some(c => c.binding.sessionId === more.sessionId));
  // Running Setup again connects it; the adapter that is already running sees it without a restart.
  const again = await w.install();
  assert.equal(again.sessions.length, 3);
  assert.equal((await readOnly.names()).length, 3);
});

test('the adapter connects nothing by itself unless it holds the controller credential', async () => {
  assert.equal(makeSessionSync({ OMP_BRIDGE_STATE: path.resolve('x') }), undefined);
  assert.equal(makeSessionSync({ OMP_BRIDGE_CONTROLLER: path.resolve('y') }), undefined);
  assert.equal(typeof makeSessionSync({ OMP_BRIDGE_STATE: path.resolve('x'), OMP_BRIDGE_CONTROLLER: path.resolve('y') }), 'function');
});

test('a saved project whose folder holds the install folder is left out, and one that cannot be connected never stops the others', async t => {
  const w = await world(t, 2);
  // A session whose project folder contains the install folder cannot be connected safely.
  const outer = await w.save('outer');
  w.root = path.join(outer.cwd, 'inside'); w.install = () => autoSetup({ root: w.root }, w.deps);
  const report = await w.install();
  assert.deepEqual(report.sessions.map(row => row.sessionId).sort(), w.saved.filter(row => row !== outer).map(row => row.sessionId).sort());
  // One damaged older state folder is skipped and reported; the other session is still connected.
  const x = await world(t, 2), first = await x.install();
  await fs.unlink(path.join(first.sessions[0].stateFolder, 'launch.json'));
  const again = await x.install();
  assert.equal(again.sessions.length, 1); assert.equal(again.skipped.length, 1);
  assert.match(again.summary.join(' '), /skipped/);
});

test('Uninstall removes an install that connected several sessions and still holds a 0.2.20 per-session runtime folder', async t => {
  const w = await world(t, 2), rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  // Make the install look like it came from 0.2.20: its runtime lives in runtime\\managed-<id> and its launchers use it.
  const first = await w.install(), legacy = path.join(w.root, 'runtime', 'managed-' + first.sessions[0].sessionId);
  await fs.rename(path.join(w.root, 'runtime', 'current'), legacy);
  for (const row of first.sessions) {
    const file = path.join(path.dirname(row.launcher), 'launch-settings.json'), settings = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...settings, cli: path.join(legacy, 'bridge.mjs') }) + '\n');
  }
  const report = await autoSetup({ root: w.root }, { ...w.deps, registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }) });
  assert.equal(report.sessions.length, 2);
  const deps = { platform: 'win32', registry, processes: async () => [], permissions: w.deps.permissions, recover: uninstallDefaults.recover,
    integration: { read: async () => null, remove: async () => {} }, audit: async () => [] };
  const result = await uninstall(w.root, { confirmOffline: true }, deps);
  assert.notEqual(result.status, 'blocked', JSON.stringify(result));
  assert.equal(rows.size, 0, 'the Installed-apps entry is gone');
  for (const row of report.sessions) await assert.rejects(fs.stat(row.launcher), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(w.root, 'runtime', 'current', 'bridge.mjs')), { code: 'ENOENT' });
});

test('the adapter leaves a new session alone while pots install is working (it holds the install lock) and connects it on the next check', async t => {
  const w = await world(t, 1), report = await w.install();
  const sync = () => syncSessions({ connectionsFolder: report.connectionsFolder, credentialFile: report.credentialFile, env: w.deps.env, home: w.base, detect: w.deps.detect });
  const later = await w.save('later'), lockFile = path.join(w.root, 'setup.lock'), held = await acquireLock(lockFile);
  assert.equal(await sync(), 0, 'nothing is connected while the install holds its lock');
  assert.equal((await readConnections(report.connectionsFolder)).connections.length, 1);
  await held.close(); await fs.unlink(lockFile);
  assert.equal(await sync(), 1);
  assert.ok((await readConnections(report.connectionsFolder)).connections.some(row => row.binding.sessionId === later.sessionId));
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' }, 'the adapter leaves no lock behind');
});

test('one deleted saved session never breaks the others: status calls and new sessions carry on, and Setup removes only that connection', async t => {
  const w = await world(t, 3), report = await w.install();
  const sync = () => syncSessions({ connectionsFolder: report.connectionsFolder, credentialFile: report.credentialFile, env: w.deps.env, home: w.base, detect: w.deps.detect });
  const bridge = await adapter(report, sync);
  const dead = report.sessions[0], saved = w.saved.find(row => row.sessionId === dead.sessionId), alive = report.sessions.slice(1).map(row => row.name).sort();
  await fs.unlink(saved.file);
  // Every status call still answers for the other two sessions, and names the one that cannot be used in plain words.
  const lanes = (await bridge.call('bridge_lanes_status', {})).body;
  assert.deepEqual(lanes.lanes.map(row => row.connection).sort(), alive);
  assert.deepEqual(lanes.unavailable.map(row => row.name), [dead.name]);
  assert.match(lanes.unavailable[0].problem, /saved OMP session was deleted or changed.*pots install/);
  const status = (await bridge.call('bridge_status', {})).body.connections;
  assert.deepEqual(status.filter(row => row.plans).map(row => row.name).sort(), alive);
  assert.match(status.find(row => row.name === dead.name).unavailable, /cannot be used/);
  assert.deepEqual((await bridge.call('bridge_lane_watch_lines', {})).body.unavailable.map(row => row.name), [dead.name]);
  // A call that names the dead connection itself gets a plain sentence with its name and the next step, not a technical error.
  const named = await bridge.call('bridge_status', { connection: dead.name });
  assert.equal(named.error, true);
  assert.ok(named.body.error.includes(dead.name) && /pots status, then pots install/.test(named.body.error), named.body.error);
  assert.ok(!/restart the adapter|ENOENT|unexpected error/.test(named.body.error), named.body.error);
  // A session saved later is still connected by the adapter while the dead row is there.
  const later = await w.save('later');
  assert.equal((await bridge.names()).length, 4);
  assert.ok((await readConnections(report.connectionsFolder)).connections.some(row => row.binding.sessionId === later.sessionId));
  // Setup removes only the dead row and says so; the saved-state folder and the other sessions stay.
  const again = await w.install();
  assert.match(again.summary.join(' '), /Removed one connection whose saved OMP session was deleted or changed/);
  assert.deepEqual((await readConnections(report.connectionsFolder)).connections.map(row => row.name).sort(), [...alive, ...again.sessions.filter(row => row.sessionId === later.sessionId).map(row => row.name)].sort());
  assert.ok(await fs.stat(dead.stateFolder), 'the saved-state folder of the removed connection is untouched');
  assert.equal((await bridge.call('bridge_lanes_status', {})).body.unavailable, undefined);
});

test('the shared assistant choices follow the same connection every time, not the order the sessions were found in', async t => {
  const w = await world(t, 0);
  // Found order is by project path (x/alpha first); connection names sort by project name (aardvark first).
  const make = async (dir, name) => { const cwd = path.join(w.base, dir, name); await fs.mkdir(cwd, { recursive: true }); const file = path.join(w.sessions, name + '.jsonl'), sessionId = crypto.randomUUID();
    await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n'); return file; };
  const alpha = await make('x', 'alpha'), aardvark = await make('y', 'aardvark');
  await autoSetup({ root: w.root, session: alpha, clients: 'claude' }, w.deps);
  await autoSetup({ root: w.root, session: aardvark, clients: 'chatgpt' }, w.deps);
  const again = await w.install();
  assert.equal(again.sessions.length, 2);
  assert.deepEqual(again.sessions.map(row => row.project.split(path.sep).at(-1)), ['aardvark', 'alpha']);
  assert.equal(again.clients, 'chatgpt', 'the choices of the first connection by name (aardvark), whatever order the sessions were found in');
});
