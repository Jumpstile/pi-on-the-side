import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main } from '../src/cli.mjs';
import { createServer } from '../src/mcp.mjs';
import { readConnections, registerConnection } from '../src/connections.mjs';
import { createCredential, acquireController } from '../src/controller.mjs';
import { initialize, LaneEvents } from '../src/control.mjs';
import { loadSetup } from '../src/setup.mjs';
import { lanesStatus, LANE_ERRORS, startLaneTask } from '../src/lane-status.mjs';

const quiet = { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' };
async function base(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-guarantee-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function lane(dir, name, extra = []) {
  const cwd = path.join(dir, 'project-' + name); await fs.mkdir(cwd);
  const session = path.join(dir, name + '.jsonl');
  await fs.writeFile(session, [JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }), ...extra].join('\n') + '\n');
  const state = path.join(dir, 'state-' + name);
  return { cwd, session, state, setup: () => main(['setup', session, state], quiet) };
}
async function lanes(dir, count) {
  const rows = [];
  for (let i = 0; i < count; i++) { const row = await lane(dir, 'l' + i); assert.equal(await row.setup(), 0); rows.push(row); }
  return rows;
}

test('two lanes registering at the same moment both succeed and the registry stays complete', async t => {
  const dir = await base(t), rows = await lanes(dir, 6), hub = path.join(dir, 'connections');
  await Promise.all(rows.map((row, i) => registerConnection(hub, 'lane-' + i, row.state)));
  assert.deepEqual((await readConnections(hub)).connections.map(row => row.name), rows.map((_, i) => 'lane-' + i));
  assert.deepEqual((await fs.readdir(hub)).sort(), ['connections.json']);
});

test('readers never see an invalid registry while writers are publishing', async t => {
  const dir = await base(t), rows = await lanes(dir, 6), hub = path.join(dir, 'connections');
  await registerConnection(hub, 'first', rows[0].state);
  let writing = true; const failures = []; let reads = 0;
  const reader = (async () => {
    while (writing) {
      try { const value = await readConnections(hub); assert.ok(value.connections.length >= 1); reads++; }
      catch (error) { failures.push(error.message); }
    }
  })();
  const writers = Promise.all(rows.slice(1).map((row, i) => registerConnection(hub, 'more-' + i, row.state)));
  try { await writers; } finally { writing = false; await reader; }
  assert.deepEqual(failures, []);
  assert.ok(reads > 0);
  assert.equal((await readConnections(hub)).connections.length, 6);
});

// Starting two lanes back to back: the first `connect` has created the folder but not yet taken its lock.
test('a reader that arrives while the registry folder is still empty waits instead of calling it invalid', async t => {
  const dir = await base(t), [row] = await lanes(dir, 1), hub = path.join(dir, 'connections');
  await fs.mkdir(hub);
  const pending = readConnections(hub);
  await new Promise(resolve => setTimeout(resolve, 120));
  await registerConnection(hub, 'solo', row.state);
  assert.equal((await pending).connections[0].name, 'solo');
});

// An older build wrote a registry with 16 lanes; the 17th `connect` used to fail with "invalid connections registry".
test('a registry of 16 lanes written by an older build is read, and a 17th lane can still be connected', async t => {
  const dir = await base(t), hub = path.join(dir, 'connections');
  const rows = await lanes(dir, 17);
  for (let i = 0; i < 16; i++) await registerConnection(hub, 'lane-' + String(i).padStart(2, '0'), rows[i].state);
  assert.equal((await readConnections(hub)).connections.length, 16);
  const result = await registerConnection(hub, 'lane-16', rows[16].state);
  assert.equal(result.connections.length, 17);
  assert.equal((await readConnections(hub)).connections.length, 17);
});

test('a registry over the limit is still refused as invalid', async t => {
  const dir = await base(t), hub = path.join(dir, 'connections');
  await fs.mkdir(hub);
  const row = i => ({ name: 'lane-' + i, root: path.join(dir, 'state-' + i), binding: { sessionId: crypto.randomUUID(), cwd: path.join(dir, 'p' + i), sessionFile: path.join(dir, i + '.jsonl'), executable: process.execPath } });
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: Array.from({ length: 64 }, (_, i) => row(i)) }));
  assert.equal((await readConnections(hub)).connections.length, 64);
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: Array.from({ length: 65 }, (_, i) => row(i)) }));
  await assert.rejects(readConnections(hub, { tries: 1 }), { message: 'invalid connections registry' });
});

test('a half-written registry is waited out, a permanently broken one gives a plain error', async t => {
  const dir = await base(t), [row] = await lanes(dir, 1), hub = path.join(dir, 'connections');
  await registerConnection(hub, 'solo', row.state);
  const file = path.join(hub, 'connections.json'), good = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, good.slice(0, 40));
  const pending = readConnections(hub);
  await new Promise(resolve => setTimeout(resolve, 120));
  await fs.writeFile(file, good);
  assert.equal((await pending).connections[0].name, 'solo');
  await fs.writeFile(file, good.slice(0, 40));
  await assert.rejects(readConnections(hub, { tries: 3, delayMs: 5 }), { message: 'invalid connections registry' });
  await fs.writeFile(file, good);
  // Leftover writer files (lock or temp) are normal while another process publishes.
  await fs.writeFile(path.join(hub, `connections.json.${crypto.randomUUID()}.tmp`), '{"ver');
  assert.equal((await readConnections(hub)).connections[0].name, 'solo');
  await fs.writeFile(path.join(hub, 'unrelated.txt'), 'x');
  await assert.rejects(readConnections(hub, { tries: 1 }), { message: 'invalid connections registry' });
});

test('setup never adopts or removes a folder that already existed', async t => {
  const dir = await base(t), row = await lane(dir, 'retry');
  const header = JSON.parse((await fs.readFile(row.session, 'utf8')).split('\n')[0]);
  await initialize(row.state);
  const config = JSON.stringify({ sessionId: header.id, cwd: row.cwd, root: row.state }) + '\n';
  await fs.writeFile(path.join(row.state, 'config.json'), config);
  assert.notEqual(await row.setup(), 0);
  assert.equal(await fs.readFile(path.join(row.state, 'config.json'), 'utf8'), config);

  const foreign = await lane(dir, 'foreign');
  await fs.mkdir(foreign.state); await fs.writeFile(path.join(foreign.state, 'notes.txt'), 'mine');
  assert.notEqual(await foreign.setup(), 0);
  assert.equal(await fs.readFile(path.join(foreign.state, 'notes.txt'), 'utf8'), 'mine');
  const empty = await lane(dir, 'empty'); await fs.mkdir(empty.state);
  assert.notEqual(await empty.setup(), 0);
  assert.deepEqual(await fs.readdir(empty.state), []);
});

// A stand-in for the running bridge: answers each /model ticket the way the real adapter reports it,
// `verified` when works(attempt) says so, otherwise `mismatch`. Model names are synthetic fixtures.
function fakeBridge(store, { works = () => true } = {}) {
  let seen = 0, stopped = false;
  const state = { works };
  const done = new Set();
  const loop = (async () => {
    while (!stopped) {
      for (const id of await store.commandIds().catch(() => [])) {
        if (done.has(id) || (await store.commandReceipt(id).catch(() => null))?.state !== 'queued') continue;
        done.add(id); seen++;
        const requested = (await store.commandRequest(id)).command.split(/\s+/)[1];
        await store.updateCommandReceipt(id, 'dispatching', 'admitted');
        const outcome = state.works(seen);
        if (outcome === 'unsupported') await store.updateCommandReceipt(id, 'unsupported', 'OMP does not recognise this model', { requested });
        else if (outcome) await store.updateCommandReceipt(id, 'verified', 'OMP reports the requested model is running', { requested, resolved: requested, actual: requested });
        else await store.updateCommandReceipt(id, 'mismatch', 'OMP reports another model; switch not proven, send no task', { requested, resolved: requested, actual: 'cheap/start-1' });
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  return { get seen() { return seen; }, set works(value) { state.works = value; }, stop: async () => { stopped = true; await loop; } };
}
const TIMING = { modelTries: 6, modelRetryMs: 5, modelWaitMs: 5000, modelPollMs: 5 };
async function modelLane(t) {
  const dir = await base(t);
  const row = await lane(dir, 'model');
  assert.equal(await row.setup(), 0);
  const controllerFile = path.join(dir, 'controller.json'); await createCredential(controllerFile);
  const current = await loadSetup(row.state);
  await acquireController(current.store, controllerFile);
  const run = args => {
    const out = [], err = [];
    return main(args, { ...quiet, controllerFile, ...TIMING, stdout: s => out.push(s), stderr: s => err.push(s) }).then(code => ({ code, out: out.join('\n'), err: err.join('\n') }));
  };
  const events = async () => (await fs.readFile(path.join(row.state, 'control', 'lane-events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const status = async () => (await lanesStatus([{ name: 'lane', loaded: await loadSetup(row.state) }])).lanes[0];
  const rpc = async () => {
    const server = createServer({ stateRoot: row.state, controllerFile, modelTiming: { tries: TIMING.modelTries, retryDelayMs: TIMING.modelRetryMs, modelWaitMs: TIMING.modelWaitMs, modelPollMs: TIMING.modelPollMs } });
    let seq = 0; const call = (method, params) => server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }));
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return (name, args) => call('tools/call', { name, arguments: args }).then(reply => reply.result?.content[0].text ?? reply.error.message);
  };
  return { ...row, controllerFile, current, run, events, status, rpc, plans: () => fs.readdir(path.join(row.state, 'plans')) };
}

test('failed model switch: task is not sent, exit is non-zero, a failed-start event and the attention flag show it, and no door lets a task past', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: () => false });
  t.after(() => bridge.stop());
  const result = await f.run(['lane-task', f.state, 'writer/big-1', 'do the work']);
  assert.equal(result.code, 1); assert.match(result.err, /model switch not verified; task not sent/);
  assert.deepEqual(await f.plans(), []);
  assert.equal(bridge.seen, TIMING.modelTries);
  const event = (await f.events()).find(row => row.event === 'start_failed');
  assert.equal(event.reason, 'model_unverified');
  const state = await f.status();
  assert.equal(state.needsAttention, true); // the failed start alone raises the flag
  assert.match(state.eventId, /^[a-f0-9]{64}$/);
  // Neither the CLI queue nor the MCP tool can slip a task past the unproven switch.
  const queued = await f.run(['queue', f.state, 'sneak']);
  assert.equal(queued.code, 1); assert.match(queued.err, /model switch not verified; task not sent/);
  const call = await f.rpc();
  assert.match(await call('bridge_enqueue', { id: crypto.randomUUID(), prompt: 'sneak' }), /model switch not verified; task not sent/);
  assert.deepEqual(await f.plans(), []);
});

test('a failed start stops needing attention once the model is switched, the recovery the docs name', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: () => false });
  t.after(() => bridge.stop());
  assert.equal((await f.run(['lane-task', f.state, 'writer/big-1', 'do the work'])).code, 1);
  assert.equal((await f.status()).needsAttention, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  const events = new LaneEvents(f.state, f.current.store.config.sessionId);
  events.record('model_switched', { requested: 'writer/big-1', model: 'writer/big-1' }); await events.flush();
  assert.equal((await f.status()).needsAttention, false);
});

test('model switch that works after some failures sends the task once and queueing is open again', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: attempt => attempt >= 3 });
  t.after(() => bridge.stop());
  const result = await f.run(['lane-task', f.state, 'writer/big-1', 'do the work']);
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  assert.equal(report.started, true); assert.equal(report.model, 'writer/big-1'); assert.equal(report.proof.verified, true);
  assert.equal(bridge.seen, 3);
  assert.deepEqual(await f.plans(), [report.planId + '.json']);
  assert.equal((await f.events()).some(row => row.event === 'start_failed'), false);
  assert.equal((await f.run(['queue', f.state, 'next task'])).code, 0);
});

test('a name OMP refuses is not retried, and an invalid name is refused before anything is asked', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: () => 'unsupported' });
  t.after(() => bridge.stop());
  const refused = await f.run(['lane-task', f.state, 'writer/nope', 'x']);
  assert.equal(refused.code, 1); assert.match(refused.err, /model switch not verified; task not sent/);
  assert.equal(bridge.seen, 1);
  assert.deepEqual(await f.plans(), []);
  const before = (await f.current.store.commandIds()).length;
  const invalid = await f.run(['lane-task', f.state, 'two words', 'x']);
  assert.equal(invalid.code, 1); assert.match(invalid.err, /invalid model id/);
  assert.equal((await f.current.store.commandIds()).length, before);
});

test('a plain /model command that OMP does not prove holds tasks until a later verified switch', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: () => false });
  t.after(() => bridge.stop());
  assert.equal((await f.run(['command', f.state, crypto.randomUUID(), '/model', 'writer/big-1'])).code, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  const early = await f.run(['queue', f.state, 'too early']);
  assert.equal(early.code, 1); assert.match(early.err, /model switch not verified; task not sent/);
  bridge.works = () => true;
  assert.equal((await f.run(['model', f.state, 'writer/big-1'])).code, 0);
  assert.equal((await f.run(['queue', f.state, 'now fine'])).code, 0);
});

test('a damaged model receipt fails closed, and a later verified switch still clears it', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store);
  t.after(() => bridge.stop());
  const id = crypto.randomUUID();
  await f.current.store.requestCommand(id, '/model writer/big-1');
  bridge.works = () => true;
  await fs.writeFile(f.current.store.commandFile(id, true), '{"ver');
  const refused = await f.run(['queue', f.state, 'sneak']);
  assert.equal(refused.code, 1); assert.match(refused.err, /model switch not verified; task not sent/);
  assert.deepEqual(await f.plans(), []);
  await new Promise(resolve => setTimeout(resolve, 20)); // the damaged file is older than the next receipt
  assert.equal((await f.run(['model', f.state, 'writer/big-1'])).code, 0);
  assert.equal((await f.run(['queue', f.state, 'open again'])).code, 0);
});

test('bridge_enqueue with a model queues only after OMP proves it, never twice, and refuses a bad model name', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store, { works: () => false });
  t.after(() => bridge.stop());
  const call = await f.rpc(), id = crypto.randomUUID();
  assert.match(await call('bridge_enqueue', { id, prompt: 'do the work', model: 'writer/big-1' }), /model switch not verified; task not sent/);
  assert.deepEqual(await f.plans(), []);
  assert.equal(bridge.seen, TIMING.modelTries);
  bridge.works = () => true;
  const ok = JSON.parse(await call('bridge_enqueue', { id, prompt: 'do the work', model: 'writer/big-1' }));
  assert.deepEqual([ok.state, ok.duplicate, ok.model.state, ok.model.requested], ['queued', false, 'verified', 'writer/big-1']);
  const switches = bridge.seen;
  const again = JSON.parse(await call('bridge_enqueue', { id, prompt: 'do the work', model: 'writer/big-1' }));
  assert.equal(again.duplicate, true);
  assert.equal(bridge.seen, switches); // a retry of the same plan id does not switch again
  assert.deepEqual(await f.plans(), [id + '.json']);
  assert.match(await call('bridge_enqueue', { id: crypto.randomUUID(), prompt: 'x', model: 'two words' }), /Invalid|invalid/);
});

test('a task that cannot be confirmed stored is a loud failed start, not a silent success', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store);
  t.after(() => bridge.stop());
  await assert.rejects(startLaneTask({ store: f.current.store, model: 'writer/big-1', controllerFile: f.controllerFile, ...TIMING, enqueue: async () => crypto.randomUUID() }),
    /prompt delivery not confirmed; lane start failed/);
  assert.equal((await f.events()).find(row => row.event === 'start_failed').reason, 'prompt_not_delivered');
  assert.equal((await f.status()).needsAttention, true);
});

test('a task that was stored is not reported as a failed start because listing the plans failed a couple of times', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store), store = f.current.store; let failures = 0;
  t.after(() => bridge.stop());
  const ids = store.ids.bind(store); store.ids = async () => { if (failures > 0) { failures--; throw new Error('busy'); } return ids(); };
  const enqueue = async () => {
    const id = crypto.randomUUID();
    await store.enqueue({ version: 1, id, sessionId: store.config.sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
    failures = 2; return id;
  };
  const result = await startLaneTask({ store, model: 'writer/big-1', controllerFile: f.controllerFile, ...TIMING, enqueue });
  assert.equal(result.started, true);
  assert.equal((await f.events()).some(row => row.event === 'start_failed'), false);
});

test('a task the queue itself refuses (full queue, text it does not accept) shows that reason and is not recorded as a lost delivery', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store);
  t.after(() => bridge.stop());
  for (const reason of ['queue capacity reached', 'invalid step']) {
    await assert.rejects(startLaneTask({ store: f.current.store, model: 'writer/big-1', controllerFile: f.controllerFile, ...TIMING, enqueue: async () => { throw new Error(reason); } }), { message: reason });
  }
  assert.equal((await f.events()).some(row => row.event === 'start_failed'), false);
});

test('a queue write that fails at the disk leaves a failed-start row, and a plan list that cannot be read at all says the task may have been queued', async t => {
  const f = await modelLane(t), bridge = fakeBridge(f.current.store), store = f.current.store;
  t.after(() => bridge.stop());
  const start = enqueue => startLaneTask({ store, model: 'writer/big-1', controllerFile: f.controllerFile, ...TIMING, enqueue });
  await assert.rejects(start(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }), { code: 'ENOSPC' });
  assert.deepEqual((await f.events()).filter(row => row.event === 'start_failed').map(row => row.reason), ['prompt_not_delivered']);
  const ids = store.ids.bind(store); let blind = false; store.ids = async () => { if (blind) throw new Error('busy'); return ids(); };
  await assert.rejects(start(async () => {
    const id = crypto.randomUUID();
    await store.enqueue({ version: 1, id, sessionId: store.config.sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
    blind = true; return id;
  }), { message: LANE_ERRORS[3] });
  assert.equal((await f.events()).filter(row => row.event === 'start_failed').length, 2);
});
