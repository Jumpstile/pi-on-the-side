import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, LaneEvents, proveModel, Store, writeJson } from '../src/control.mjs';
import { acquireController, createCredential } from '../src/controller.mjs';
import { lanesStatus, switchModel } from '../src/lane-status.mjs';
import { main } from '../src/cli.mjs';

// Model switching must use OMP's own live model list and resolver, and may only
// be called a success when OMP itself reports the requested model running.
// Every model name below is a synthetic fixture; POTS never lists or aliases models.
// A runtime that cannot strip TypeScript types must fail here, not silently skip every adapter test (Node 22.18+, 23.6+ and 24+ strip by default).
if (!process.features?.typescript) throw new Error('These tests need a Node.js that strips TypeScript types: use Node 22.18 or newer, or run node --experimental-strip-types --test.');
const adapter = await import('../extension/bridge.ts');
const sessionId = '00000000-0000-4000-8000-000000000031';
const START = { provider: 'fixture-a', id: 'model-start' };
const CATALOG = [START, { provider: 'fixture-a', id: 'model-alpha' }, { provider: 'fixture-b', id: 'model-alpha' }, { provider: 'fixture-b', id: 'model-gamma-large' }];
const selector = model => `${model.provider}/${model.id}`;
// Stand-in for OMP's resolver: exact provider/id, else the first model whose id contains the text.
const resolver = name => CATALOG.find(model => selector(model) === name) ?? CATALOG.find(model => model.id.includes(name));

async function waitFor(read, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await read(); } catch (error) { if (error?.code !== 'ENOENT' && error?.message !== 'file changed') throw error; }
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// `behaviour`: 'switch' applies the model, 'ignore' returns true without changing it,
// 'lag' applies it only after the report has been read twice, 'blind' switches but OMP cannot report a model,
// 'refuse' returns false (the lane can never change model).
async function lane(t, { behaviour = 'switch', facade = true, listError = false } = {}) {
  let mode = behaviour;
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-switch-')));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const settings = { sessionId, cwd, root };
  const configFile = path.join(base, 'config.json'); await writeJson(configFile, settings);
  const session = path.join(base, 'session.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n' +
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'synthetic prior turn' } }) + '\n');
  const handlers = new Map(), sent = [], changes = [], calls = { setModel: 0, reads: 0 };
  let timer = null, running = START, pendingApply = null;
  const report = () => {
    calls.reads++;
    if (pendingApply && calls.reads >= 3) { running = pendingApply; pendingApply = null; }
    return mode === 'blind' && running !== START ? undefined : running;
  };
  const pi = {
    on: (name, fn) => handlers.set(name, fn), registerCommand: () => {},
    sendUserMessage: async text => { sent.push(text); },
    getCommands: () => [],
    setModel: async model => {
      calls.setModel++; changes.push(model);
      if (mode === 'refuse') return false; // OMP declines every switch
      if (mode === 'switch' || mode === 'blind') running = model;
      if (mode === 'lag') { calls.reads = 0; pendingApply = model; }
      return true;
    },
  };
  const ctx = {
    agent: { kind: 'main' }, cwd, ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => session },
    isIdle: () => true, hasPendingMessages: () => false,
    setInterval: fn => (timer = fn, 1), clearTimer: () => { timer = null; },
    ...(facade ? { models: { list: () => { if (listError) throw Error('synthetic listing failure'); return CATALOG; }, resolve: resolver, current: report } } : { modelRegistry: { getAvailable: async () => CATALOG } }),
  };
  // A host without ctx.models reports the running model through ctx.model, read live.
  if (!facade) Object.defineProperty(ctx, 'model', { get: report });
  const previous = process.env.OMP_BRIDGE_CONFIG; process.env.OMP_BRIDGE_CONFIG = configFile;
  t.after(async () => {
    await handlers.get('session_shutdown')?.();
    if (previous === undefined) delete process.env.OMP_BRIDGE_CONFIG; else process.env.OMP_BRIDGE_CONFIG = previous;
    await fs.rm(base, { recursive: true, force: true });
  });
  adapter.createBridge(async () => 'omp/18.7.0', { modelProof: { attempts: 4, delayMs: 5 } })(pi);
  await handlers.get('session_start')({}, ctx);
  await waitFor(async () => (await readJsonFile(path.join(root, 'control', 'dispatch-diagnostic.json'))).lastTickFinishedAt !== null, 'initial wake finished');
  const store = new Store(settings);
  const loaded = { store, lockFile: path.join(root, `supervisor-${sessionId}.lock`) };
  const ask = async text => {
    const id = crypto.randomUUID();
    await store.requestCommand(id, text);
    let ticks = 0;
    const row = await waitFor(async () => { if (ticks++ % 10 === 0) timer?.(); const receipt = await store.commandReceipt(id); return receipt?.state === 'queued' || receipt?.state === 'dispatching' ? null : receipt; }, `receipt for ${text}`);
    return row;
  };
  const events = async () => (await fs.readFile(path.join(root, 'control', 'lane-events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const status = async () => (await lanesStatus([{ name: 'fixture', loaded }])).lanes[0];
  // Throttled so repeated polling does not flood the adapter's wake queue.
  let ticks = 0;
  return { store, root, ask, events, status, sent, changes, calls, running: () => running, behave: value => { mode = value; }, tick: () => { if (ticks++ % 10 === 0) timer?.(); } };
}
const readJsonFile = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('a short name is resolved by OMP, switched, and proven by OMP\'s own report of the running model', async t => {
  const h = await lane(t);
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'verified');
  assert.deepEqual([row.requested, row.resolved, row.actual], ['gamma', 'fixture-b/model-gamma-large', 'fixture-b/model-gamma-large']);
  assert.deepEqual(h.changes, [CATALOG[3]]); // the Model object OMP itself returned
  assert.deepEqual(h.sent, []);
  const switched = await waitFor(async () => (await h.events()).find(event => event.event === 'model_switched'), 'model_switched event');
  assert.deepEqual([switched.requested, switched.model], ['gamma', 'fixture-b/model-gamma-large']);
});

test('a name OMP does not recognise is a loud error that lists what OMP reports, and nothing is switched', async t => {
  const h = await lane(t);
  const row = await h.ask('/model nonexistent');
  assert.equal(row.state, 'unsupported');
  assert.match(row.observation, /does not recognise model "nonexistent"/);
  for (const model of CATALOG) assert.ok(row.observation.includes(selector(model)), `lists ${selector(model)}`);
  assert.equal(h.calls.setModel, 0);
  assert.equal(h.running(), START);
});

test('a bare name carried by several providers is ambiguous: error naming the exact choices, nothing switched', async t => {
  const h = await lane(t);
  const row = await h.ask('/model model-alpha');
  assert.equal(row.state, 'unsupported');
  assert.match(row.observation, /ambiguous.*exact provider\/id/);
  assert.ok(row.observation.includes('fixture-a/model-alpha') && row.observation.includes('fixture-b/model-alpha'));
  assert.equal(h.calls.setModel, 0);
  const exact = await h.ask('/model fixture-b/model-alpha');
  assert.equal(exact.state, 'verified');
  assert.equal(exact.actual, 'fixture-b/model-alpha');
});

test('setModel returning true is not proof: an unchanged running model is a mismatch error and an event line', async t => {
  const h = await lane(t, { behaviour: 'ignore' });
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'mismatch');
  assert.match(row.observation, /reports fixture-a\/model-start running, not fixture-b\/model-gamma-large; switch not proven, send no task/);
  assert.equal(row.actual, 'fixture-a/model-start');
  const event = await waitFor(async () => (await h.events()).find(entry => entry.event === 'model_mismatch'), 'model_mismatch event');
  assert.deepEqual([event.requested, event.model], ['gamma', 'fixture-a/model-start']);
  const lanes = await waitFor(async () => { const s = await h.status(); return s.model.state === 'mismatch' ? s : null; }, 'status shows mismatch');
  assert.deepEqual(lanes.model, { actual: 'fixture-a/model-start', requested: 'gamma', state: 'mismatch', holdingPlans: true });
  // An unproven switch needs the coordinator's attention on its own (no queued task is needed), with a stable event identity;
  // a later proven switch clears it.
  assert.equal(lanes.needsAttention, true); assert.match(lanes.eventId, /^[a-f0-9]{64}$/);
  h.behave('switch');
  assert.equal((await h.ask('/model gamma')).state, 'verified');
  const cleared = await waitFor(async () => { h.tick(); const s = await h.status(); return s.model.state === 'verified' ? s : null; }, 'status shows the proven switch');
  assert.equal(cleared.needsAttention, false);
});

test('if OMP cannot report the running model the switch is unproven, never success', async t => {
  const h = await lane(t, { behaviour: 'blind' });
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'returned-unverified');
  assert.match(row.observation, /did not report the running model; switch not proven/);
  assert.equal(row.actual, undefined);
  await waitFor(async () => (await h.events()).find(entry => entry.event === 'model_mismatch'), 'model_mismatch event');
});

test('OMP\'s report may lag the switch; the proof retries before declaring success or failure', async t => {
  const h = await lane(t, { behaviour: 'lag' });
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'verified');
  assert.equal(row.actual, 'fixture-b/model-gamma-large');
});

test('an unproven switch holds an already queued plan, and a later proven switch releases it', async t => {
  const h = await lane(t, { behaviour: 'ignore' });
  const planId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'synthetic task', continueAfterEnd: false }] });
  assert.equal((await h.ask('/model gamma')).state, 'mismatch');
  for (let i = 0; i < 5; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, []);
  assert.equal(await h.store.receipt(planId), null);
  const held = await h.status();
  assert.deepEqual([held.queuedCount, held.needsAttention, held.model.holdingPlans], [1, true, true]);
  assert.match(held.eventId, /^[a-f0-9]{64}$/);
  h.behave('switch');
  assert.equal((await h.ask('/model gamma')).state, 'verified');
  await waitFor(async () => { h.tick(); return h.sent.length === 1; }, 'queued plan sent after the proven switch');
  await waitFor(async () => (await h.status()).model.holdingPlans === false, 'no longer holding plans'); // waitFor retries a receipt still being written
});

test('a lane that cannot change model is never stuck: asking for the model it already runs is proven at once and releases the hold', async t => {
  const h = await lane(t, { behaviour: 'refuse' });
  const planId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'synthetic task', continueAfterEnd: false }] });
  assert.equal((await h.ask('/model gamma')).state, 'unsupported'); // OMP declined: the request is unproven
  for (let i = 0; i < 5; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, []);
  assert.equal((await h.status()).model.holdingPlans, true);
  const current = await h.ask(`/model ${selector(START)}`);
  assert.equal(current.state, 'verified');
  assert.equal(h.calls.setModel, 1); // only the declined switch; the current model needed no switch
  await waitFor(async () => { h.tick(); return h.sent.length === 1; }, 'queued plan sent once the hold is released');
  await waitFor(async () => (await h.status()).model.holdingPlans === false, 'no longer holding plans'); // waitFor retries a receipt still being written
});

test('a /model request is held against plans from the instant its request file exists, before any receipt, and the switch then runs first', async t => {
  const h = await lane(t);
  const planId = crypto.randomUUID(), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'synthetic task', continueAfterEnd: false }] });
  // requestCommand writes the request and then the receipt; stop in between.
  await writeJson(h.store.commandFile(id), { version: 1, id, sessionId, command: '/model gamma', createdAt: Date.now() }, true);
  assert.deepEqual(await h.store.modelHold(), { id, requested: 'gamma', state: 'pending' });
  for (let i = 0; i < 6; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, []);
  assert.equal(await h.store.receipt(planId), null);
  // The receipt arrives; the adapter switches first and only then does the plan go out.
  await writeJson(h.store.commandFile(id, true), { version: 1, id, sessionId, state: 'queued', updatedAt: Date.now() }, true);
  await waitFor(async () => { h.tick(); return (await h.store.commandReceipt(id))?.state === 'verified'; }, 'switch verified');
  await waitFor(async () => { h.tick(); return h.sent.length === 1; }, 'plan sent after the switch');
  assert.deepEqual(h.changes, [CATALOG[3]]);
});

test('a damaged command receipt does not stop the adapter: it keeps the hold, and a later verified switch still runs and releases it', async t => {
  const h = await lane(t);
  // The lowest possible id, so the adapter meets the damaged receipt before it reaches any later request.
  const planId = crypto.randomUUID(), id = '00000000-0000-4000-8000-000000000001';
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'synthetic task', continueAfterEnd: false }] });
  await h.store.requestCommand(id, '/model fixture-a/model-alpha');
  await fs.writeFile(h.store.commandFile(id, true), '{"ver');
  for (let i = 0; i < 6; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, []); // fail closed
  assert.equal((await h.status()).model.holdingPlans, true);
  await new Promise(resolve => setTimeout(resolve, 20)); // the damaged file is older than the next receipt
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'verified');
  await waitFor(async () => { h.tick(); return h.sent.length === 1; }, 'plan sent once the verified switch outranks the damaged receipt');
  // The adapter may still be writing the plan's receipt right after the send; a status read that meets a file
  // changing under it is refused by design, and waitFor asks again until a whole read succeeds.
  await waitFor(async () => (await h.status()).model.holdingPlans === false, 'no longer holding plans');
});

test('a damaged command request does not stop the adapter: a later model switch is still answered, and the plan stays held while the damaged request waits', async t => {
  const h = await lane(t);
  const planId = crypto.randomUUID(), id = '00000000-0000-4000-8000-000000000001';
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'synthetic task', continueAfterEnd: false }] });
  await h.store.requestCommand(id, '/model fixture-a/model-alpha');
  await fs.writeFile(h.store.commandFile(id), '{"ver');
  for (let i = 0; i < 6; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, []); // fail closed
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'verified');
  assert.deepEqual(h.changes, [CATALOG[3]]);
  for (let i = 0; i < 6; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(h.sent, [], 'the damaged request still holds the plan');
});

test('Store.modelHold: the newest model request decides; other commands and cancelled tickets never hold', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-hold-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  let clock = Date.now();
  const store = new Store({ sessionId, cwd, root }, () => ++clock);
  const settle = async (state, details, command = '/model x') => {
    const id = crypto.randomUUID();
    await store.requestCommand(id, command);
    if (state === 'cancelled') await store.cancelCommand(id);
    else if (state === 'unsupported') await store.updateCommandReceipt(id, state, 'refused', details);
    else { await store.updateCommandReceipt(id, 'dispatching', 'admitted'); await store.updateCommandReceipt(id, state, 'done', details); }
    return id;
  };
  assert.equal(await store.modelHold(), null);
  // A request still waiting for its receipt holds only when it is a /model request.
  const waiting = crypto.randomUUID(), other = crypto.randomUUID();
  await writeJson(store.commandFile(other), { version: 1, id: other, sessionId, command: '/compact', createdAt: ++clock }, true);
  assert.equal(await store.modelHold(), null);
  await writeJson(store.commandFile(waiting), { version: 1, id: waiting, sessionId, command: '/model gamma', createdAt: ++clock }, true);
  assert.deepEqual(await store.modelHold(), { id: waiting, requested: 'gamma', state: 'pending' });
  assert.deepEqual(await store.cancelCommand(waiting), { id: waiting, state: 'cancelled', cancelled: true }); // no receipt yet: cancelling gives it one
  assert.equal(await store.modelHold(), null);
  const refused = await settle('unsupported', { requested: 'nope' });
  assert.deepEqual(await store.modelHold(), { id: refused, requested: 'nope', state: 'unsupported' });
  await settle('unsupported', undefined, '/compact'); // another command: neither holds nor releases
  await settle('cancelled', { requested: 'x' });
  assert.equal((await store.modelHold()).id, refused);
  await settle('verified', { requested: 'gamma', resolved: 'a/b', actual: 'a/b' });
  assert.equal(await store.modelHold(), null);
  const bad = await settle('mismatch', { requested: 'gamma', resolved: 'a/b', actual: 'a/c' });
  assert.deepEqual(await store.modelHold(), { id: bad, requested: 'gamma', state: 'mismatch' });
});

test('Store.modelHold: a queued switch still holds plans when an earlier switch finishes after it was requested', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-hold-queued-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  let clock = Date.now();
  const store = new Store({ sessionId, cwd, root }, () => ++clock);
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  await store.requestCommand(first, '/model alpha');
  await store.updateCommandReceipt(first, 'dispatching', 'admitted');
  await store.requestCommand(second, '/model beta'); // asked while the first switch is still running
  await store.updateCommandReceipt(first, 'verified', 'done', { requested: 'alpha', resolved: 'a/alpha', actual: 'a/alpha' });
  assert.equal((await store.modelHold())?.id, second, 'the switch still waiting must hold plans');
});

async function holdStore(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-stuck-command-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const clock = { now: Date.now() };
  return { store: new Store({ sessionId, cwd, root }, () => clock.now), clock };
}

test('a /model request nobody answered stops holding plans after five minutes, with or without a receipt', async t => {
  const { store, clock } = await holdStore(t);
  const lost = crypto.randomUUID(), frozen = crypto.randomUUID();
  await writeJson(store.commandFile(lost), { version: 1, id: lost, sessionId, command: '/model gamma', createdAt: clock.now }, true);
  assert.equal((await store.modelHold())?.id, lost);
  clock.now += 5 * 60 * 1000 + 1;
  assert.equal(await store.modelHold(), null, 'no receipt was ever written');
  await store.requestCommand(frozen, '/model gamma');
  assert.equal((await store.modelHold())?.id, frozen);
  clock.now += 5 * 60 * 1000 + 1;
  assert.equal(await store.modelHold(), null, 'a receipt stuck at queued');
});

test('command-cancel gives a request that has no receipt its receipt, so it stops holding at once', async t => {
  const { store, clock } = await holdStore(t);
  const id = crypto.randomUUID();
  await writeJson(store.commandFile(id), { version: 1, id, sessionId, command: '/model gamma', createdAt: clock.now }, true);
  assert.deepEqual(await store.cancelCommand(id), { id, state: 'cancelled', cancelled: true });
  assert.equal(await store.modelHold(), null);
  await assert.rejects(store.cancelCommand(crypto.randomUUID()), /unknown command id/);
});

test('a command lock left behind by a crash is removed when old, and a fresh one is respected', async t => {
  const { store } = await holdStore(t);
  const id = crypto.randomUUID();
  await store.requestCommand(id, '/model gamma');
  await fs.writeFile(store.commandLock(id), '');
  assert.equal((await store.updateCommandReceipt(id, 'dispatching', 'admitted')).state, 'queued', 'a fresh lock may belong to a write in progress');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  await fs.utimes(store.commandLock(id), old, old);
  assert.equal((await store.cancelCommand(id)).state, 'cancelled', 'the old lock no longer blocks the receipt');
});

test('command-cancel waits out the adapter\'s short hold on the request record, and never reports a cancel that was not recorded as cancelled', async t => {
  const { store } = await holdStore(t);
  const brief = crypto.randomUUID(), stuck = crypto.randomUUID();
  await store.requestCommand(brief, '/model gamma'); await store.requestCommand(stuck, '/model gamma');
  await fs.writeFile(store.commandLock(brief), ''); await fs.writeFile(store.commandLock(stuck), '');
  setTimeout(() => fs.unlink(store.commandLock(brief)).catch(() => {}), 80);
  assert.deepEqual(await store.cancelCommand(brief), { id: brief, state: 'cancelled', cancelled: true });
  assert.deepEqual(await store.cancelCommand(stuck), { id: stuck, state: 'queued', cancelled: false });
});

test('restart recovery skips a damaged command receipt instead of stopping, and still settles the others', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-recover-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const store = new Store({ sessionId, cwd, root });
  const damaged = crypto.randomUUID(), admitted = crypto.randomUUID();
  await store.requestCommand(damaged, '/model gamma'); await fs.writeFile(store.commandFile(damaged, true), '{"ver');
  await store.requestCommand(admitted, '/model gamma'); await store.updateCommandReceipt(admitted, 'dispatching', 'admitted');
  await store.recoverCommands();
  assert.equal((await store.commandReceipt(admitted)).state, 'failed');
  assert.equal((await store.modelHold()) !== null, true); // the damaged one still holds
});

test('a model switch that was interrupted after it was admitted still holds queued plans after restart recovery', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-recover-hold-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const store = new Store({ sessionId, cwd, root });
  const admitted = crypto.randomUUID();
  await store.requestCommand(admitted, '/model fixture-b/model-gamma-large'); await store.updateCommandReceipt(admitted, 'dispatching', 'admitted');
  await store.recoverCommands();
  const receipt = await store.commandReceipt(admitted);
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.requested, 'fixture-b/model-gamma-large');
  assert.deepEqual(await store.modelHold(), { id: admitted, requested: 'fixture-b/model-gamma-large', state: 'failed' });
  // A later switch that OMP confirms ends the hold.
  const later = crypto.randomUUID();
  await store.requestCommand(later, '/model fixture-b/model-gamma-large'); await store.updateCommandReceipt(later, 'dispatching', 'admitted');
  await store.updateCommandReceipt(later, 'verified', 'verified', { requested: 'fixture-b/model-gamma-large', resolved: 'fixture-b/model-gamma-large', actual: 'fixture-b/model-gamma-large' });
  assert.equal(await store.modelHold(), null);
});

test('if OMP cannot list its models the request ends in a plain error instead of staying queued', async t => {
  const h = await lane(t, { listError: true });
  const row = await h.ask('/model gamma');
  assert.equal(row.state, 'unsupported');
  assert.match(row.observation, /could not list its available models; nothing was switched/);
  assert.equal(h.calls.setModel, 0);
});

test('hosts without ctx.models accept only an exact provider/id that OMP lists', async t => {
  const h = await lane(t, { facade: false });
  const bare = await h.ask('/model gamma');
  assert.equal(bare.state, 'unsupported');
  assert.match(bare.observation, /does not recognise/);
  const exact = await h.ask('/model fixture-b/model-gamma-large');
  assert.equal(exact.state, 'verified');
});

test('lane status shows the model OMP actually runs and the model that was requested', async t => {
  const h = await lane(t);
  const before = await waitFor(async () => { h.tick(); const s = await h.status(); return s.model.actual ? s : null; }, 'status reports the start model');
  assert.deepEqual(before.model, { actual: 'fixture-a/model-start', requested: null, state: null, holdingPlans: false });
  await h.ask('/model gamma');
  const after = await waitFor(async () => { h.tick(); const s = await h.status(); return s.model.state === 'verified' && s.model.actual === 'fixture-b/model-gamma-large' ? s : null; }, 'status reports the switched model');
  assert.deepEqual(after.model, { actual: 'fixture-b/model-gamma-large', requested: 'gamma', state: 'verified', holdingPlans: false });
});

test('proveModel retries, reports the last observation, and treats errors as unobservable', async () => {
  let reads = 0;
  assert.deepEqual(await proveModel(() => (++reads < 3 ? 'a/old' : 'a/new'), 'a/new', { attempts: 5, delayMs: 1 }), { proven: true, actual: 'a/new', attempts: 3 });
  assert.deepEqual(await proveModel(() => 'a/old', 'a/new', { attempts: 3, delayMs: 1 }), { proven: false, actual: 'a/old', attempts: 3 });
  assert.deepEqual(await proveModel(() => { throw Error('nope'); }, 'a/new', { attempts: 2, delayMs: 1 }), { proven: false, actual: null, attempts: 2 });
  assert.deepEqual(await proveModel(() => null, 'a/new', { attempts: 2, delayMs: 1 }), { proven: false, actual: null, attempts: 2 });
});

test('model lane events carry only selector-shaped names, never free text', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-events-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state'); await initialize(root);
  const events = new LaneEvents(root, sessionId);
  events.record('model_switched', { requested: 'gamma', model: 'fixture-b/model-gamma-large', prompt: 'SECRET' });
  events.record('model_mismatch', { requested: 'has spaces and SECRET', model: 'fixture-a/model-start' });
  events.record('idle', { requested: 'gamma', model: 'fixture-a/model-start', reason: 'native_idle' });
  await events.flush();
  const rows = (await fs.readFile(path.join(root, 'control', 'lane-events.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([rows[0].requested, rows[0].model, rows[0].prompt], ['gamma', 'fixture-b/model-gamma-large', undefined]);
  assert.deepEqual([rows[1].requested, rows[1].model], [undefined, 'fixture-a/model-start']);
  assert.deepEqual([rows[2].requested, rows[2].model], [undefined, undefined]); // model fields exist only on model rows
});

// ---- Controller side: a task is queued only after the switch is proven. ----
async function controller(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-model-cli-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const settings = { sessionId, cwd, root };
  const configFile = path.join(base, 'config.json'); await writeJson(configFile, settings);
  const credential = path.join(base, 'client.json'); await createCredential(credential);
  const store = new Store(settings);
  await acquireController(store, credential);
  // Stand-in lane: answers each queued model ticket with the given final receipt.
  let answer = null, answering = false;
  const responder = setInterval(async () => {
    // One pass at a time: overlapping passes (likely when the whole suite loads the machine) would race each other's receipt writes.
    if (!answer || answering) return;
    answering = true;
    try {
      for (const id of await store.commandIds()) {
        if ((await store.commandReceipt(id))?.state !== 'queued') continue;
        await store.updateCommandReceipt(id, 'dispatching', 'admitted');
        await store.updateCommandReceipt(id, answer.state, answer.observation, answer.details);
      }
    } catch { /* A transient read race is retried on the next interval. */ }
    finally { answering = false; }
  }, 5);
  t.after(() => clearInterval(responder));
  // Every wait ends the moment its answer is there; the long limit only matters on a PC that is busy elsewhere. Only the no-reply test waits for it to run out (it passes a short one).
  const run = async (argv, modelWaitMs = 60000) => {
    let out = '', err = '';
    const code = await main(argv, { controllerFile: credential, stdout: text => { out += text; }, stderr: text => { err += text; }, modelWaitMs, modelPollMs: 5, modelRetryMs: 5 });
    return { code, out, err };
  };
  return { store, configFile, credential, run, answer: value => { answer = value; } };
}
const proven = { state: 'verified', observation: 'OMP reports the requested model is running', details: { requested: 'gamma', resolved: 'fixture-b/model-gamma-large', actual: 'fixture-b/model-gamma-large' } };
const unproven = { state: 'mismatch', observation: 'setModel returned true but OMP reports fixture-a/model-start running, not fixture-b/model-gamma-large; switch not proven, send no task', details: { requested: 'gamma', resolved: 'fixture-b/model-gamma-large', actual: 'fixture-a/model-start' } };

test('queue --model sends the task only after OMP proved the switch', async t => {
  const c = await controller(t);
  c.answer(proven);
  const result = await c.run(['queue', c.configFile, 'synthetic task', '--model', 'gamma']);
  assert.equal(result.code, 0, result.out + result.err);
  const report = JSON.parse(result.out);
  assert.equal(report.queued, true);
  assert.deepEqual([report.model.verified, report.model.requested, report.model.resolved, report.model.actual], [true, 'gamma', 'fixture-b/model-gamma-large', 'fixture-b/model-gamma-large']);
  assert.deepEqual(await c.store.ids(), [report.planId]);
});

test('queue --model with an unproven switch is an error and queues no task', async t => {
  const c = await controller(t);
  c.answer(unproven);
  const result = await c.run(['queue', c.configFile, 'synthetic task', '--model', 'gamma']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out);
  assert.equal(report.queued, false);
  assert.deepEqual([report.model.verified, report.model.state, report.model.actual], [false, 'mismatch', 'fixture-a/model-start']);
  assert.match(report.model.observation, /switch not proven/);
  assert.deepEqual(await c.store.ids(), []);
});

test('queue --model with no reply from the lane cancels the switch ticket and queues nothing', async t => {
  const c = await controller(t);
  const result = await c.run(['queue', c.configFile, 'synthetic task', '--model', 'gamma'], 300);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out);
  assert.deepEqual([report.queued, report.model.verified, report.model.state], [false, false, 'cancelled']);
  assert.deepEqual(await c.store.ids(), []);
  const [ticket] = await c.store.commandIds();
  assert.equal((await c.store.commandReceipt(ticket)).state, 'cancelled'); // cannot fire after the caller gave up
});

test('model command exit status follows OMP\'s proof, and a refused name relays what OMP reports', async t => {
  const c = await controller(t);
  c.answer(proven);
  assert.equal((await c.run(['model', c.configFile, 'gamma'])).code, 0);
  c.answer({ state: 'unsupported', observation: 'OMP does not recognise model "nope" as an available model. OMP reports: fixture-a/model-start', details: { requested: 'nope' } });
  const refused = await c.run(['model', c.configFile, 'nope']);
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.out).observation, /OMP reports: fixture-a\/model-start/);
  const invalid = await switchModel(c.store, 'two words', { controllerFile: c.credential });
  assert.deepEqual([invalid.verified, invalid.state], [false, 'invalid']);
});

test('one lane whose event file is far too big is marked by itself; a file a little over the writer limit is still read', async t => {
  const lanes = [];
  for (const size of [33000, 60000]) {
    const { store } = await holdStore(t), file = path.join(store.config.root, 'control', 'lane-events.jsonl');
    let text = '', seq = 0;
    while (Buffer.byteLength(text) < size) text += JSON.stringify({ version: 1, seq: ++seq, time: 1000 + seq, pid: process.pid, sessionId, event: 'idle' }) + '\n';
    await fs.writeFile(file, text);
    lanes.push({ name: 'lane' + size, loaded: { store, lockFile: path.join(store.config.root, 'none.lock') } });
  }
  const report = await lanesStatus(lanes);
  assert.deepEqual(report.lanes.map(row => [row.connection, row.status, row.needsAttention]), [['lane33000', 'idle', false], ['lane60000', 'unknown', true]]);
});
