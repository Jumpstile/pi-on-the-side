import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, Store, writeJson } from '../src/control.mjs';
// POTS has no list of supported OMP versions. These two arbitrary versions only show that behavior does not depend on the version.
const ANY_OMP = ['omp/0.0.1', 'omp/99.99.99'];

// Drives the production extension adapter (extension/bridge.ts) with a fake
// OMP API. Importing .ts needs runtime type stripping (default on Node >=23.6).
// On Node 22 run: node --experimental-strip-types --test
// The host-contract mapping itself is covered without stripping in host.test.mjs.
// A runtime that cannot strip TypeScript types must fail here, not silently skip every adapter test (Node 22.18+, 23.6+ and 24+ strip by default).
if (!process.features?.typescript) throw new Error('These tests need a Node.js that strips TypeScript types: use Node 22.18 or newer, or run node --experimental-strip-types --test.');
const adapter = await import('../extension/bridge.ts');
const sessionId = '00000000-0000-4000-8000-000000000002';
const fixtureAdmissionTimers = new WeakMap();
// Only readJson's exact identity-race Error('file changed') is retried: on
// Windows a concurrent atomic replace can swap the inode between stat and open.
// Every other error propagates. Each wait ends the moment its condition holds; the deadline only bounds a real failure and is
// generous so a busy PC (other programs or test suites running) does not fail a test that is merely slow.
const SETTLE_MS = 60000;
const reach = async (store, id, state, notes = [], timeoutMs = SETTLE_MS) => {
  const read = async () => {
    try { return await store.receipt(id); } catch (error) {
      if (error?.constructor === Error && error.message === 'file changed') return undefined;
      throw error;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await read();
    if (row?.state === state) return row;
    if (!row) fixtureAdmissionTimers.get(store)?.();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const trace = await fs.readFile(path.join(store.config.root, 'control', 'bridge-trace.jsonl'), 'utf8').then(text => text.trim().split('\n').slice(-12).join('\n'), () => '');
  assert.fail(`receipt never reached ${state}: ${JSON.stringify(await read())}; adapter notes: ${JSON.stringify(notes)}; trace tail:\n${trace}`);
};

async function waitForInitialWake(root) {
  const file = path.join(root, 'control', 'dispatch-diagnostic.json');
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    try {
      const row = JSON.parse(await fs.readFile(file, 'utf8'));
      if (row.tickCount >= 1 && Number.isSafeInteger(row.lastTickFinishedAt)) return row;
    } catch { /* Initial diagnostic write may not have completed yet. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('initial supervisor wake did not settle');
}
async function waitForSnapshot(root, predicate) {
  const file = path.join(root,'control','dispatch-diagnostic.json'), deadline = Date.now()+SETTLE_MS;
  while (Date.now()<deadline) {
    try {
      const text = await fs.readFile(file,'utf8'), row = JSON.parse(text);
      if (predicate(row)) return {text,row};
    } catch { /* Atomic diagnostic replacement can still be in flight. */ }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('diagnostic snapshot condition did not settle');
}
async function harness(t, bridge, shouldStart = true) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp-bridge-adapter-')));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const settings = { sessionId, cwd, root };
  const configFile = path.join(base, 'config.json'); await writeJson(configFile, settings);
  const session = path.join(base, 'session.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n' +
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'synthetic prior turn' } }) + '\n');
  const commands = new Map(); const handlers = new Map(); const sent = []; const notes = []; const modelChanges = []; let timer = null, intervalMs = null;
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: async text => { sent.push(text); await fs.appendFile(session, JSON.stringify({ type: 'message', message: { role: 'user', content: text } }) + '\n'); },
    getCommands: () => [{ name: 'advisor', source: 'extension' }, { name: 'prompt-review', source: 'prompt' }],
    setModel: async model => { modelChanges.push(model); ctx.model = model; return true; },
  };
  const ctx = {
    agent: { kind: 'main' }, cwd, ui: { notify: (...args) => notes.push(args) },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => session },
    modelRegistry: { getAvailable: async () => [{ provider: 'openai-codex', id: 'gpt-6-luna' }] },
    model: { provider: 'openai-codex', id: 'gpt-5-start' },
    isIdle: () => true, hasPendingMessages: () => false,
    setInterval: (fn, ms) => (timer = fn, intervalMs = ms, 1), clearTimer: () => { timer = null; },
  };
  const previous = process.env.OMP_BRIDGE_CONFIG; process.env.OMP_BRIDGE_CONFIG = configFile;
  t.after(async () => {
    await handlers.get('session_shutdown')?.();
    if (previous === undefined) delete process.env.OMP_BRIDGE_CONFIG; else process.env.OMP_BRIDGE_CONFIG = previous;
    await fs.rm(base, { recursive: true, force: true });
  });
  bridge(pi);
  await handlers.get('session_start')({}, ctx);
  if (shouldStart) await waitForInitialWake(root);
  assert.equal(Boolean(timer), shouldStart, 'adapter startup admission');
  const store = new Store(settings);
  fixtureAdmissionTimers.set(store, () => timer?.());
  return { store, handlers, sent, notes, ctx, commands, pi, modelChanges, root, configFile, tick: () => timer?.(), timer: () => timer, intervalMs: () => intervalMs };
}
function endEvent(h, assistant, extra = {}, sentThrough = h.sent.length - 1) {
  const messages = h.sent.slice(0, sentThrough + 1).map(text => ({ role: 'user', content: [{ type: 'text', text }] }));
  messages.push(...(Array.isArray(assistant) ? assistant : [assistant]));
  h.handlers.get('agent_end')({ messages, ...extra });
}

// Submit step 0 of a two-step plan through the adapter timer, then deliver one
// correlated agent_end carrying `extra` fields.
async function end(t, extra, bridge, options = {}) {
  const h = await harness(t, bridge);
  const p = { version: 1, id: crypto.randomUUID(), sessionId, expiresAt: Date.now() + 600000,
    steps: [0, 1].map(() => ({ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: true })) };
  await h.store.enqueue(p);
  h.tick(); await reach(h.store, p.id, 'submitted', h.notes);
  assert.equal(h.sent.length, 1);
  const message = { role: 'assistant', timestamp: 1700000000000, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic reply' }] };
  if (options.priorObservation) h.handlers.get('message_end')({ message: structuredClone(message) });
  h.handlers.get('agent_start')({});
  const observation = options.omitMessage ? undefined : { message: { ...structuredClone(message), ...options.changeObserved } };
  if (observation && !options.delayMessage) h.handlers.get('message_end')(observation);
  // Hold the next planned submission until the test explicitly ticks. A
  // verified END now wakes automatically; waiting is otherwise transient.
  h.ctx.isIdle = () => false;
  endEvent(h, { ...structuredClone(message), ...options.changeEnd }, extra);
  if (observation && options.delayMessage) h.handlers.get('message_end')(observation);
  return { ...h, id: p.id, message, tick: () => { h.ctx.isIdle = () => true; h.tick(); } };
}
const KNOWN = ANY_OMP[0];
const known = (testHooks) => adapter.createBridge(async () => KNOWN, testHooks);
const unknown = () => adapter.createBridge(async () => null);
const unknownCases = [
  ['known host null', known, { willContinue: null }, 'malformed_end'],
  ['known host string "true"', known, { willContinue: 'true' }, 'malformed_end'],
  ['known host string "false"', known, { willContinue: 'false' }, 'malformed_end'],
  ['known host number 0', known, { willContinue: 0 }, 'malformed_end'],
];
const phaseMessage = (phase, stopReason = 'stop') => ({
  role:'assistant',timestamp:1800000000000 + phase,provider:'synthetic',model:'fixture',
  responseId:`phase-${phase}`,stopReason,content:[{type:'text',text:`phase ${phase}`}],
});
async function phaseFixture(t, host = ANY_OMP[0]) {
  const h = await harness(t, adapter.createBridge(async () => host)), id = crypto.randomUUID();
  await h.store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect the synthetic phase fixture only.',continueAfterEnd:false}]});
  h.tick(); await reach(h.store,id,'submitted',h.notes);
  return {...h,id};
}
for (const host of ANY_OMP) for (const order of ['START-before-END','END-before-START']) {
  test(`adapter: ${order} continuation on ${host} preserves three phases and releases the queue`, async t => {
    const h = await phaseFixture(t, host);
    h.handlers.get('agent_start')({});
    const phases = [phaseMessage(0, 'toolUse'),phaseMessage(1),phaseMessage(2)];
    for (let i = 0; i < 2; i++) {
      h.handlers.get('message_end')({message:phases[i]});
      if (order === 'START-before-END') h.handlers.get('agent_start')({});
      endEvent(h, phases.slice(0,i+1), {willContinue:true});
      if (order === 'END-before-START') h.handlers.get('agent_start')({});
      // An exact old END must not retire the successor, even with its observation present.
      endEvent(h, phases.slice(0,i+1), {willContinue:true});
    }
    h.handlers.get('message_end')({message:phases[2]});
    endEvent(h, [phases[0]], {willContinue:true});
    endEvent(h, phases, {willContinue:false});
    const row = await reach(h.store,h.id,'completed',h.notes);
    assert.equal(row.nextStep,1); assert.equal(row.outcomes.length,1);
    assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
    assert.equal(row.outcomes[0].terminalObservation,'run_end_observed');
    assert.equal(row.taskSuccess,'unverified'); assert.equal(h.sent.length,1);
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Inspect a distinct synthetic task.',continueAfterEnd:false}]});
    h.tick(); await reach(h.store,nextId,'submitted',h.notes);
    assert.equal(h.sent.length,2); assert.match(h.sent[1],new RegExp(nextId));
  });
}
test('adapter: a subagent run is never taken as the plan\'s run, the main run still is', async t => {
  const h = await phaseFixture(t), sub = { agent: { kind: 'subagent' } }, main = { agent: { kind: 'main' } }, message = phaseMessage(7);
  const deliver = ctx => {
    h.handlers.get('agent_start')({}, ctx);
    h.handlers.get('message_end')({ message }, ctx);
    h.handlers.get('agent_end')({ messages: [{ role: 'user', content: [{ type: 'text', text: h.sent[0] }] }, message], willContinue: false }, ctx);
  };
  deliver(sub);
  for (let i = 0; i < 6; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal((await h.store.receipt(h.id)).state, 'submitted', 'a subagent run does not end the plan');
  deliver(main);
  assert.equal((await reach(h.store, h.id, 'completed', h.notes)).state, 'completed');
});
for (const host of ANY_OMP) {
  for (const mode of ['mutated no-ID same-count','truncated history','changed content','changed timestamp',
    'changed provider','changed model','changed stopReason','changed UTF16']) {
    test(`adapter: successor END rejects ${mode} on ${host}`, async t => {
      const h = await phaseFixture(t,host), first = phaseMessage(10), second = phaseMessage(11);
      if (mode === 'mutated no-ID same-count') delete first.responseId;
      if (mode === 'changed UTF16') first.content[0].text = '\ud800';
      const predecessor = mode === 'truncated history' ? [first,second] : [first];
      h.handlers.get('agent_start')({});
      endEvent(h,predecessor,{willContinue:true});
      h.handlers.get('agent_start')({});
      const changed = structuredClone(first);
      if (mode === 'changed timestamp') changed.timestamp++;
      else if (mode === 'changed provider') changed.provider = 'other-provider';
      else if (mode === 'changed model') changed.model = 'other-model';
      else if (mode === 'changed stopReason') changed.stopReason = 'toolUse';
      else changed.content[0].text = mode === 'changed UTF16' ? '\ud801' : 'mutated predecessor';
      const history = mode === 'truncated history' ? [second]
        : mode === 'mutated no-ID same-count' ? [changed] : [changed,second];
      // No successor message_end: the old mutated END must not acquire its token.
      endEvent(h,history,{willContinue:false});
      const row = await reach(h.store,h.id,'failed',h.notes);
      assert.equal(row.reason,'end_not_matched_to_message'); assert.equal(row.nextStep,0);
      assert.equal(row.automaticReplay,false); assert.equal(h.sent.length,1);
    });
  }
  for (const mode of ['staged successor','multiple pending STARTs','interleaved assistant']) {
    test(`adapter: unowned ${mode} on ${host} preserves committed receipt`, async t => {
      const h = await phaseFixture(t,host), first = phaseMessage(20);
      h.handlers.get('agent_start')({});
      h.handlers.get('message_end')({message:first});
      endEvent(h,first,{willContinue:false});
      const committed = await reach(h.store,h.id,'completed',h.notes);
      // Receipt persistence precedes the event-driven wake. Finish that empty
      // wake before creating the unowned scenario and its next queued plan.
      await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.activeState===null&&
        row.tickCount>=3&&row.lastTickFinishedAt>=row.lastTickAt);
      h.handlers.get('agent_start')({});
      h.handlers.get('message_end')({message:phaseMessage(21)});
      h.handlers.get('agent_start')({});
      if (mode === 'multiple pending STARTs') h.handlers.get('agent_start')({});
      if (mode === 'interleaved assistant') h.handlers.get('message_end')({message:phaseMessage(22)});
      endEvent(h,[first,phaseMessage(21)],{willContinue:true});
      h.handlers.get('message_end')({message:phaseMessage(22)});
      endEvent(h,[first,phaseMessage(21),phaseMessage(22)],{willContinue:false});
      const nextId = crypto.randomUUID();
      await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
        steps:[{prompt:'Inspect after unowned native phases.',continueAfterEnd:false}]});
      h.tick();
      if (mode === 'staged successor') {
        await reach(h.store,nextId,'submitted',h.notes);
        assert.equal(h.sent.length,2); assert.match(h.sent[1],new RegExp(nextId));
      } else {
        await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.activeState===null&&row.tickCount>=3);
        assert.equal(await h.store.receipt(nextId),null);
        assert.equal(h.sent.length,1,'ambiguous unowned phases must retain their dispatch hold');
      }
      assert.deepEqual(await h.store.receipt(h.id),committed);
    });
  }
}
for (const guard of ['idle','busy','pending']) {
  test(`adapter: unowned evidence hold recovers only after a valid settled END and ${guard} guard clears`, async t => {
    const h = await phaseFixture(t,ANY_OMP[0]), first = phaseMessage(40), unowned = phaseMessage(41);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    endEvent(h,first,{willContinue:false});
    const committed = await reach(h.store,h.id,'completed',h.notes);
    await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.activeState===null&&
      row.tickCount>=3&&row.lastTickFinishedAt>=row.lastTickAt);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:unowned});
    endEvent(h,[first,unowned],{willContinue:null});
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Inspect after a validated unowned end.',continueAfterEnd:false}]});
    let before = await waitForSnapshot(h.root,row=>row.phase==='after-event');
    h.tick();
    await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.tickCount>before.row.tickCount);
    assert.equal(await h.store.receipt(nextId),null,'idle without a valid END cannot release the hold');
    assert.equal(h.sent.length,1);
    h.ctx.isIdle = () => guard !== 'busy';
    h.ctx.hasPendingMessages = () => guard === 'pending';
    endEvent(h,[first,unowned],{willContinue:false});
    if (guard !== 'idle') {
      before = await waitForSnapshot(h.root,row=>row.phase==='after-event');
      h.tick();
      await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.tickCount>before.row.tickCount);
      assert.equal(await h.store.receipt(nextId),null);
      assert.equal(h.sent.length,1,'valid END alone cannot bypass native work or pending messages');
    }
    h.ctx.isIdle = () => true; h.ctx.hasPendingMessages = () => false;
    h.tick(); await reach(h.store,nextId,'submitted',h.notes);
    assert.equal(h.sent.length,2); assert.match(h.sent[1],new RegExp(nextId));
    assert.deepEqual(await h.store.receipt(h.id),committed);
  });
}

for (const mode of ['missing observation','replayed endpoint','changed end','late conflicting observation',
  'changed binding','changed lifecycle before END','changed lifecycle after END']) {
  test(`adapter: unowned hold refuses ${mode} despite idle and a terminal END`, async t => {
    const h = await harness(t,adapter.createBridge(async () => ANY_OMP[0])), unowned = phaseMessage(42);
    h.handlers.get('agent_start')({});
    if (mode !== 'missing observation') h.handlers.get('message_end')({message:unowned});
    endEvent(h,unowned,{willContinue:null});
    if (mode === 'changed end') unowned.content[0].text = 'Changed unowned endpoint';
    if (mode === 'changed lifecycle before END') h.handlers.get('session_before_tree')({});
    h.ctx.isIdle = () => false;
    endEvent(h,unowned,{willContinue:false});
    if (mode === 'changed binding') h.ctx.cwd = path.join(h.root,'other-project');
    if (mode === 'changed lifecycle after END') h.handlers.get('session_before_tree')({});
    if (mode === 'late conflicting observation') h.handlers.get('message_end')({message:phaseMessage(44)});
    if (mode === 'replayed endpoint') {
      h.handlers.get('agent_start')({});
      h.handlers.get('message_end')({message:unowned});
      endEvent(h,unowned,{willContinue:false});
    }
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Never send while unowned evidence is uncertain.',continueAfterEnd:false}]});
    h.ctx.isIdle = () => true;
    const before = await waitForSnapshot(h.root,row=>row.phase==='after-event');
    h.tick();
    await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.tickCount>before.row.tickCount);
    assert.equal(await h.store.receipt(nextId),null); assert.equal(h.sent.length,0);
  });
}

for (const mode of ['changed evidence','continuing END','old submission marker']) {
  test(`adapter: a late ${mode} after a valid unowned END revokes its pending hold release`, async t => {
    const h = await phaseFixture(t,ANY_OMP[0]), first = phaseMessage(50), unowned = phaseMessage(51);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    endEvent(h,first,{willContinue:false});
    const committed = await reach(h.store,h.id,'completed',h.notes);
    await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.activeState===null&&
      row.tickCount>=3&&row.lastTickFinishedAt>=row.lastTickAt);
    h.ctx.isIdle = () => false;
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:unowned});
    endEvent(h,[first,unowned],{willContinue:false});
    if (mode === 'changed evidence') endEvent(h,[first,phaseMessage(52)],{willContinue:false});
    else if (mode === 'continuing END') endEvent(h,[first,unowned],{willContinue:true});
    else endEvent(h,unowned,{willContinue:false});
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Never send after contradictory unowned evidence.',continueAfterEnd:false}]});
    h.ctx.isIdle = () => true;
    const before = await waitForSnapshot(h.root,row=>row.phase==='after-event');
    h.tick();
    await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.tickCount>before.row.tickCount);
    assert.equal(await h.store.receipt(nextId),null); assert.equal(h.sent.length,1);
    assert.deepEqual(await h.store.receipt(h.id),committed);
  });
}

test('adapter: /bridge disable then /bridge enable after an ordinary OMP turn does not leave the queue stuck', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler, reply = phaseMessage(60);
  // The user asks OMP something. While it works, they turn the bridge off; the turn ends while it is off; they turn it on again.
  h.ctx.isIdle = () => false;
  h.handlers.get('agent_start')({});
  await command('disable', h.ctx);
  h.handlers.get('message_end')({ message: reply });
  endEvent(h, reply, { willContinue: false });
  h.ctx.isIdle = () => true;
  await command('enable', h.ctx);
  const id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'Work queued after enable.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  assert.equal(h.sent.length, 1);
});

for (const how of ['a later clean OMP turn', '/bridge enable']) {
  test(`adapter: an OMP turn whose END arrives before its message holds queued tasks and says so; ${how} releases them`, async t => {
    const h = await harness(t, known()), command = h.commands.get('bridge').handler, first = phaseMessage(70);
    h.handlers.get('agent_start')({});
    endEvent(h, first, { willContinue: false }); // the END is delivered before the message it ends
    h.handlers.get('message_end')({ message: first });
    const id = crypto.randomUUID();
    await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000, steps: [{ prompt: 'Work queued after the odd turn.', continueAfterEnd: false }] });
    const before = await waitForSnapshot(h.root, row => row.phase === 'after-event');
    h.tick();
    await waitForSnapshot(h.root, row => row.phase === 'after-event' && row.tickCount > before.row.tickCount);
    assert.equal(await h.store.receipt(id), null); assert.equal(h.sent.length, 0);
    await command('status', h.ctx);
    assert.match(h.notes.at(-1)[0], /on hold after an OMP turn/);
    await waitLane(h.root, row => row.event === 'busy' && row.reason === 'native_busy'); // the lane feed does not say idle
    if (how === '/bridge enable') {
      await command('enable', h.ctx);
      assert.match(h.notes.at(-1)[0], /will start them now/);
    } else {
      const second = phaseMessage(71);
      h.handlers.get('agent_start')({});
      h.handlers.get('message_end')({ message: second });
      endEvent(h, second, { willContinue: false });
    }
    h.tick(); await reach(h.store, id, 'submitted', h.notes);
    assert.equal(h.sent.length, 1);
    await command('status', h.ctx);
    assert.doesNotMatch(h.notes.at(-1)[0], /on hold/);
  });
}

test('adapter: /bridge disable while the session is starting is not undone by the automatic start', async t => {
  let reached, open, wait = false;
  const inDetect = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { open = resolve; });
  const h = await harness(t, adapter.createBridge(async () => { if (wait) { reached(); await gate; } return KNOWN; }));
  const command = h.commands.get('bridge').handler;
  wait = true;
  const starting = h.handlers.get('session_start')({}, h.ctx);
  await inDetect; // the session start is now between binding and the automatic start
  const disabled = command('disable', h.ctx);
  open();
  await starting; await disabled;
  assert.equal(h.timer(), null, 'the bridge is off after disable, not started again');
  await command('status', h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge stopped/);
});

test('adapter: releasing a validated unowned hold never reviews or changes a MALFORMED receipt', async t => {
  const h = await end(t,{willContinue:null},adapter.createBridge(async () => ANY_OMP[0]));
  const unknown = await reach(h.store,h.id,'malformed',h.notes), unowned = phaseMessage(45);
  h.ctx.isIdle = () => true;
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:unowned});
  endEvent(h,unowned,{willContinue:false});
  const nextId = crypto.randomUUID();
  await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Never bypass the malformed hold.',continueAfterEnd:false}]});
  const before = await waitForSnapshot(h.root,row=>row.phase==='after-event');
  h.tick();
  await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.tickCount>before.row.tickCount);
  assert.deepEqual(await h.store.receipt(h.id),unknown);
  assert.equal(unknown.nextStep,0); assert.equal(unknown.automaticReplay,false);
  assert.equal(await h.store.receipt(nextId),null); assert.equal(h.sent.length,1);
});

// A malformed terminal field is traced without any message data, on every OMP version alike.
test('adapter: a malformed terminal field is traced as non_boolean_field without message data', async t => {
  const h = await harness(t,adapter.createBridge(async () => ANY_OMP[0]),true);
  h.handlers.get('agent_start')({});
  const message = phaseMessage(43); message.content[0].text = 'PRIVATE_ASSISTANT_TEXT';
  h.handlers.get('message_end')({message});
  h.handlers.get('agent_end')({messages:[{role:'user',content:'PRIVATE_USER_TEXT'},message],willContinue:'PRIVATE_FIELD_VALUE'});
  await h.handlers.get('session_shutdown')();
  const text = await fs.readFile(path.join(h.root,'control','bridge-trace.jsonl'),'utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row=>row.event==='run_correlation'&&row.phase==='agent_end'&&
    row.continuation==='unreadable'&&row.terminalSignalReason==='non_boolean_field'));
  assert.equal(text.includes('PRIVATE_'),false); assert.equal(h.sent.length,0);
});

test('adapter: a nonterminal END retires one phase and matching successor START completes without resubmission', async t => {
  const h = await end(t, { willContinue: true }, adapter.createBridge(async () => ANY_OMP[0]));
  endEvent(h, structuredClone(h.message), {willContinue:true});
  const successor = { role:'assistant',timestamp:1700000000001,provider:'synthetic',model:'fixture',
    stopReason:'stop',content:[{type:'text',text:'synthetic continued reply'}] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:structuredClone(successor)});
  endEvent(h, [h.message,successor], {willContinue:false});
  const row = await reach(h.store, h.id, 'waiting', h.notes);
  assert.equal(row.nextStep, 1);
  assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(row.outcomes[0].terminalObservation, 'run_end_observed');
  assert.equal(h.sent.length, 1, 'native continuation must not submit another user message');
});
test('adapter: staged START followed by terminal END is unexplained overlap', async t => {
  const h = await phaseFixture(t);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:phaseMessage(0)});
  h.handlers.get('agent_start')({});
  endEvent(h,phaseMessage(0),{willContinue:false});
  const row = await reach(h.store,h.id,'failed',h.notes);
  assert.equal(row.reason,'end_not_matched_to_message');
  assert.equal(row.nextStep,0); assert.equal(h.sent.length,1);
});
for (const mode of ['unknown END','multiple STARTs','interleaved assistant','changed user','duplicated user']) {
  test(`adapter: continuation rejects ${mode} without replay and releases the queue after the settle time`, async t => {
    const realNow = Date.now; let offset = 0;
    t.mock.method(Date, 'now', () => realNow() + offset);
    const h = await phaseFixture(t), first = phaseMessage(0);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    h.handlers.get('agent_start')({});
    if (mode === 'multiple STARTs') h.handlers.get('agent_start')({});
    if (mode === 'interleaved assistant') h.handlers.get('message_end')({message:phaseMessage(1)});
    const user = {role:'user',content:mode==='changed user' ? h.sent[0]+' changed' : h.sent[0]};
    h.handlers.get('agent_end')({messages:[user,...(mode==='duplicated user'?[user]:[]),
      first],willContinue:mode==='unknown END'?null:true});
    const row = await reach(h.store,h.id,'failed',h.notes);
    assert.equal(row.nextStep,0); assert.equal(row.automaticReplay,false);
    assert.equal(h.sent.length,1);
    offset = 6000;
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Inspect the next synthetic task after the settle time.',continueAfterEnd:false}]});
    h.tick(); await reach(h.store,nextId,'submitted',h.notes);
    assert.equal(h.sent.length,2);
  });
}
// Seen on a real lane: the answer ended with a stop, an advisor note started another turn, that turn failed and OMP retried it.
// The END after the failed turn says "will continue"; it must not fail a plan whose run did finish later.
test('adapter: a continuing END after a failed model call keeps the plan open and the true END completes it', async t => {
  const h = await phaseFixture(t), failed = phaseMessage(0,'error'), retried = phaseMessage(1);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:failed});
  endEvent(h,[failed],{willContinue:true});
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:retried});
  endEvent(h,[failed,retried],{willContinue:false});
  const row = await reach(h.store,h.id,'completed',h.notes);
  assert.equal(row.nextStep,1); assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
  assert.equal(row.automaticReplay,false); assert.equal(h.sent.length,1,'nothing is sent again');
});
// The last events of the real lane (a long run with an advisor note): tool calls, an answer that stopped, a failed model call, END that says
// "will continue", then the retried turn ends with a stop and the true END. OMP sent the new START right after the continuing END there;
// the adapter must give the same result with the START before it and with no new START at all before the true END.
for (const order of ['START after the continuing END (as seen)', 'START before the continuing END', 'no new START before the true END']) {
  test(`adapter: real last-END sequence, ${order}, completes the plan once`, async t => {
    const h = await phaseFixture(t), tools = phaseMessage(0, 'toolUse'), answer = phaseMessage(1), failed = phaseMessage(2, 'error'), final = phaseMessage(3);
    h.handlers.get('agent_start')({});
    for (const message of [tools, answer, failed]) h.handlers.get('message_end')({message});
    if (order.startsWith('START before')) h.handlers.get('agent_start')({});
    endEvent(h, [tools, answer, failed], {willContinue:true});
    if (order.startsWith('START after')) h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:final});
    endEvent(h, [tools, answer, failed, final], {willContinue:false});
    const row = await reach(h.store, h.id, 'completed', h.notes);
    assert.equal(row.nextStep, 1); assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
    assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1, 'nothing is sent again');
  });
}
for (const host of ANY_OMP) {
  test(`adapter: independent postterminal START on ${host} preserves committed receipt`, async t => {
    const h = await phaseFixture(t,host), first = phaseMessage(0);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    endEvent(h,first,{willContinue:false});
    const committed = await reach(h.store,h.id,'completed',h.notes);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:phaseMessage(1)});
    endEvent(h,[first,phaseMessage(1)],{willContinue:false});
    endEvent(h,[first,phaseMessage(1)],{willContinue:false});
    const nextId = crypto.randomUUID();
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Inspect a distinct postterminal task.',continueAfterEnd:false}]});
    h.tick(); await reach(h.store,nextId,'submitted',h.notes);
    h.handlers.get('agent_start')({});
    endEvent(h,[first,phaseMessage(1)],{willContinue:false},0);
    const fresh=phaseMessage(2);
    h.handlers.get('message_end')({message:fresh});
    endEvent(h,fresh,{willContinue:false});
    await reach(h.store,nextId,'completed',h.notes);
    assert.deepEqual(await h.store.receipt(h.id),committed);
    assert.equal(h.sent.length,2);
  });
}
// A passing OS error on the cancel-request check (a scanner or indexer touching the folder) must not turn a verified task into unknown.
test('adapter: one failed cancel-status read does not make a verified task unknown', async t => {
  const h = await phaseFixture(t,ANY_OMP[0]), first = phaseMessage(0), lstat = fs.lstat;
  let failed = 0, calls = 0;
  fs.lstat = async function (file, ...rest) {
    if (/[\\/]control[\\/][0-9a-f-]{36}\.json$/.test(String(file)) && calls++ % 2 === 0) { failed++; throw Object.assign(new Error('EPERM: operation not permitted, lstat'), { code: 'EPERM' }); }
    return lstat.call(this, file, ...rest);
  };
  try {
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    endEvent(h,first,{willContinue:false});
    await reach(h.store,h.id,'completed',h.notes);
  } finally { fs.lstat = lstat; }
  assert.ok(failed > 0, 'the failure was really injected');
});
// Deterministic form of the race above: the independent native run lands after
// the supervisor's idle gate passed, while it reads the queue, before the
// durable reservation. The plan must stay unreserved, then submit normally.
for (const host of ANY_OMP) {
  test(`adapter: postterminal native run between idle gate and reservation on ${host} leaves the plan unreserved`, async t => {
    const h = await phaseFixture(t,host), first = phaseMessage(0);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({message:first});
    endEvent(h,first,{willContinue:false});
    const committed = await reach(h.store,h.id,'completed',h.notes);
    const nextId = crypto.randomUUID();
    // Only a supervisor tick lists the plans directory after enqueue, and only
    // after its idle gate. Inject once a listing contains the next plan, before
    // that tick can reserve it.
    const plans = path.join(h.root,'plans'), readdir = fs.readdir;
    let injected = false;
    t.mock.method(fs,'readdir',async (...args) => {
      const names = await readdir.apply(fs,args);
      if (!injected && args[0] === plans && names.includes(nextId+'.json')) {
        injected = true;
        h.handlers.get('agent_start')({});
        h.handlers.get('message_end')({message:phaseMessage(1)});
        endEvent(h,[first,phaseMessage(1)],{willContinue:false});
      }
      return names;
    });
    await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
      steps:[{prompt:'Inspect a distinct postterminal task.',continueAfterEnd:false}]});
    h.tick(); const submitted = await reach(h.store,nextId,'submitted',h.notes);
    assert.equal(injected,true);
    assert.equal(submitted.reason,undefined);
    h.handlers.get('agent_start')({});
    const fresh=phaseMessage(2);
    h.handlers.get('message_end')({message:fresh});
    endEvent(h,fresh,{willContinue:false});
    await reach(h.store,nextId,'completed',h.notes);
    assert.deepEqual(await h.store.receipt(h.id),committed);
    assert.equal(h.sent.length,2); assert.match(h.sent[1],new RegExp(nextId));
  });
}
test('adapter: nonterminal END without message_end creates no terminal ticket or handoff', async t => {
  const h = await phaseFixture(t), first = phaseMessage(0,'toolUse');
  h.handlers.get('agent_start')({});
  endEvent(h,first,{willContinue:true});
  h.tick();
  await waitForSnapshot(h.root,row=>row.tickCount>=3&&row.phase==='after-event');
  const pending = await h.store.receipt(h.id);
  assert.equal(pending.state,'submitted'); assert.equal(pending.nextStep,0);
  assert.equal(pending.outcomes[0].terminalObservation,'not_seen'); assert.equal(h.sent.length,1);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:phaseMessage(1)});
  endEvent(h,[first,phaseMessage(1)],{willContinue:false});
  assert.equal((await reach(h.store,h.id,'completed',h.notes)).nextStep,1);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect after a phase without a detached observation.',continueAfterEnd:false}]});
  h.tick(); await reach(h.store,nextId,'submitted',h.notes);
  assert.equal(h.sent.length,2);
});
test('adapter: cancellation clears staged START even without a native END', async t => {
  const h = await phaseFixture(t);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:phaseMessage(0)});
  h.handlers.get('agent_start')({});
  await h.store.abort(h.id); h.tick(); await reach(h.store,h.id,'aborted',h.notes);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect after staged cancellation.',continueAfterEnd:false}]});
  h.tick(); await reach(h.store,nextId,'submitted',h.notes);
  assert.equal(h.sent.length,2);
  assert.equal((await h.store.receipt(h.id)).nextStep,0);
});
test('adapter: expiry clears staged START even without a native END', async t => {
  const realNow = Date.now; let offset = 0;
  t.mock.method(Date,'now',()=>realNow()+offset);
  const h = await phaseFixture(t);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message:phaseMessage(30)});
  h.handlers.get('agent_start')({});
  offset = 60001;
  h.tick(); await reach(h.store,h.id,'expired',h.notes);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect after staged expiry.',continueAfterEnd:false}]});
  h.tick(); await reach(h.store,nextId,'submitted',h.notes);
  assert.equal(h.sent.length,2); assert.equal((await h.store.receipt(h.id)).nextStep,0);
});
test('adapter: failed admission retires its missing-message ticket before dispatch after the settle time', async t => {
  const realNow = Date.now; let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const h = await phaseFixture(t);
  await fs.appendFile(h.ctx.sessionManager.getSessionFile(),
    JSON.stringify({type:'message',message:{role:'user',content:'unexpected second user'}})+'\n');
  h.handlers.get('agent_start')({});
  endEvent(h,phaseMessage(31),{willContinue:false});
  const row = await reach(h.store,h.id,'failed',h.notes);
  assert.equal(row.reason,'message_not_confirmed_in_transcript'); assert.equal(row.nextStep,0);
  assert.equal(row.automaticReplay,false);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({version:1,id:nextId,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect after the failed admission.',continueAfterEnd:false}]});
  h.tick();
  await waitForSnapshot(h.root,row=>row.phase==='after-event'&&row.activeState===null&&row.tickCount>=3);
  assert.equal(await h.store.receipt(nextId),null,'held while the settle time runs');
  offset = 6000;
  h.tick(); await reach(h.store,nextId,'submitted',h.notes);
  assert.equal(h.sent.length,2); assert.match(h.sent[1],new RegExp(nextId));
});
for (const host of [null, 'not-omp/18.7.1', 'not-omp/18.8.5', 'not-omp/18.8.7']) {
  test(`adapter: ${host} refuses automatic and manual startup without a lock or send`, async t => {
    const h = await harness(t, adapter.createBridge(async () => host), false);
    await h.commands.get('bridge').handler('enable', h.ctx);
    assert.equal(h.timer(), null); assert.equal(h.sent.length, 0);
    await assert.rejects(fs.stat(path.join(h.root, 'supervisor-' + sessionId + '.lock')), { code: 'ENOENT' });
  });
}
for (const [name, make, extra, reason] of unknownCases) {
  test(`adapter: ${name} yields malformed and never advances or replays`, async t => {
    const h = await end(t, extra, make());
    const row = await reach(h.store, h.id, 'malformed', h.notes);
    assert.equal(row.reason, reason); assert.equal(row.nextStep, 0); assert.equal(row.automaticReplay, false);
    for (let i = 0; i < 3; i++) { h.tick(); await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.equal(h.sent.length, 1);
    assert.equal((await h.store.receipt(h.id)).state, 'malformed');
  });
}
const fencedRepresentationChanges = [
  ['timestamp differs', { changeEnd: { timestamp: 1700000000001 } }],
  ['provider differs', { changeEnd: { provider: 'other' } }],
  ['model differs', { changeEnd: { model: 'other' } }],
  ['body differs', { changeEnd: { content: [{ type: 'text', text: 'different' }] } }],
  ['message_end is absent', { omitMessage: true }],
  ['message_end arrives after agent_end', { delayMessage: true }],
  ['message_end timestamp is malformed', { changeObserved: { timestamp: '1700000000000' } }],
  ['message_end provider is absent', { changeObserved: { provider: undefined } }],
  ['message_end snapshot exceeds fallback fingerprint bound', { changeObserved: { content: [{ type: 'text', text: 'x'.repeat(65537) }] } }],
  ['native response ID survives detached bookkeeping changes', { changeObserved: { responseId: 'native-response-1' },
    changeEnd: { responseId: 'native-response-1', timestamp: 1700000000001, provider: 'other', model: 'other' } }],
];
for (const [name, options] of fencedRepresentationChanges) {
  test(`adapter: ${name} correlates through the run-local fence`, async t => {
    const h = await end(t, { willContinue: false }, known(), options);
    const row = await reach(h.store, h.id, 'waiting', h.notes);
    assert.equal(row.nextStep, 1);
    assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
    assert.equal(row.outcomes[0].terminalObservation, 'run_end_observed');
    if (options.omitMessage) {
      h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await h.store.receipt(h.id)).state, 'waiting');
      assert.equal(h.sent.length, 1); return;
    }
    h.tick(); await reach(h.store, h.id, 'submitted', h.notes);
    assert.equal(h.sent.length, 2);
  });
}
const uncorrelatedEvents = [
  ['nonterminal stop reason', { changeEnd: { stopReason: 'error' } }],
  ['prior epoch key cannot authorize current run', { omitMessage: true, priorObservation: true }],
  ['conflicting native response IDs', { changeObserved: { responseId: 'native-response-a' }, changeEnd: { responseId: 'native-response-b' } }],
  ['malformed native response ID', { changeEnd: { responseId: 17 } }],
  ['late conflicting native response ID invalidates the terminal receipt',
    { delayMessage: true, changeObserved: { responseId: 'native-response-a' }, changeEnd: { responseId: 'native-response-b' } }],
  ['oversized fallback identity fails closed', { changeEnd: { content: [{ type: 'text', text: 'x'.repeat(65537) }] } }],
  ['over-wide fallback identity fails closed', { changeEnd: { content: Array.from({ length: 3000 }, () => ({ text: 'x' })) } }],
];
for (const [name, options] of uncorrelatedEvents) {
  test(`adapter: ${name} ends failed without advancement or replay`, async t => {
    const h = await end(t, { willContinue: false }, known(), options);
    const row = await reach(h.store, h.id, 'failed', h.notes);
    assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 0);
    h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.sent.length, 1);
  });
}
test('adapter: detached event reorder records sanitized run lineage and exact admission', async t => {
  const h = await end(t, { willContinue: false }, known(), { delayMessage: true });
  await reach(h.store, h.id, 'waiting', h.notes);
  const file = path.join(h.root, 'control', 'bridge-trace.jsonl'), deadline = Date.now() + SETTLE_MS;
  let rows = [];
  while (Date.now() < deadline) {
    try {
      rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
      if (rows.some(row => row.event === 'run_correlation' && row.phase === 'admission_result')) break;
    } catch { /* Trace append may still be in flight. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const correlation = rows.filter(row => row.event === 'run_correlation');
  const endRow = correlation.find(row => row.phase === 'agent_end');
  const lateMessage = correlation.find(row => row.phase === 'message_end' && row.eventOrder > endRow?.eventOrder);
  const admission = correlation.find(row => row.phase === 'admission_result');
  assert.ok(endRow); assert.ok(lateMessage); assert.ok(admission);
  assert.equal(endRow.messageEndObserved, false); assert.equal(endRow.lineage, 'run_local_fenced');
  assert.equal(endRow.continuation, 'false'); assert.equal(lateMessage.eventOrder > endRow.eventOrder, true);
  assert.equal(admission.fencePresent, true); assert.equal(admission.admissionVerified, true);
  assert.equal(admission.lineage, 'exact_user_record_observed');
  const traceText = await fs.readFile(file, 'utf8');
  assert.equal(traceText.includes('Inspect the synthetic fixture only.'), false);
  assert.equal(traceText.includes('synthetic reply'), false);
});
test('adapter: detached equal snapshots tolerate only unrelated bookkeeping changes', async t => {
  const h = await end(t, { willContinue: false }, known(), { changeEnd: { usage: { output: 12 }, completedAt: 1700000000100 } });
  await reach(h.store, h.id, 'waiting', h.notes);
  h.tick(); await reach(h.store, h.id, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
});

test('adapter: delayed transcript persistence is reconciled after terminal event without replay', async t => {
  let releaseAdmission, signalEmptyProbe;
  let firstEmptyProbe = true;
  const emptyProbeObserved = new Promise(resolve => { signalEmptyProbe = resolve; });
  const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
  const bridge = known({
    afterEmptyAdmissionProbe: async () => {
      if (!firstEmptyProbe) return;
      firstEmptyProbe = false;
      signalEmptyProbe();
      await admissionGate;
    },
  });
  const h = await harness(t, bridge); const id = crypto.randomUUID();
  const p = { version: 1, id, sessionId, expiresAt: Date.now() + 600000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] };
  const message = { role: 'assistant', timestamp: 1700000001000, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic reply' }] };
  h.pi.sendUserMessage = async text => { h.sent.push(text); };
  await h.store.enqueue(p); h.tick(); await reach(h.store, id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await emptyProbeObserved;
  await fs.appendFile(h.ctx.sessionManager.getSessionFile(),
    JSON.stringify({ type: 'message', message: { role: 'user', content: h.sent[0] } }) + '\n' +
    JSON.stringify({ type: 'message', message }) + '\n');
  releaseAdmission();
  const row = await reach(h.store, id, 'completed', h.notes);
  assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(h.sent.length, 1);
});

for (const stopMode of ['disable', 'shutdown']) {
  test(`adapter: ${stopMode} interrupts pending transcript observation without replay`, async t => {
    let signalEmptyProbe;
    let firstEmptyProbe = true;
    const emptyProbeObserved = new Promise(resolve => { signalEmptyProbe = resolve; });
    const bridge = known({ afterEmptyAdmissionProbe: async () => {
      if (firstEmptyProbe) { firstEmptyProbe = false; signalEmptyProbe(); }
    } });
    const h = await harness(t, bridge); const id = crypto.randomUUID();
    const p = { version: 1, id, sessionId, expiresAt: Date.now() + 600000,
      steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] };
    const message = { role: 'assistant', timestamp: 1700000002000, provider: 'synthetic', model: 'fixture',
      stopReason: 'stop', content: [{ type: 'text', text: 'synthetic reply' }] };
    h.pi.sendUserMessage = async text => { h.sent.push(text); };
    await h.store.enqueue(p); h.tick(); await reach(h.store, id, 'submitted', h.notes);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({ message: structuredClone(message) });
    endEvent(h, structuredClone(message), { willContinue: false }, 0);
    await emptyProbeObserved;
    h.tick(); // Queue a bridge wake behind the pending admission; teardown must interrupt before draining it.
    if (stopMode === 'disable') await h.commands.get('bridge').handler('disable', h.ctx);
    else await h.handlers.get('session_shutdown')();
    const row = await h.store.receipt(id);
    assert.equal(row.state, 'failed');
    assert.equal(row.reason, 'supervisor_shutdown');
    assert.equal(h.sent.length, 1);
    await assert.rejects(fs.stat(path.join(h.root, `supervisor-${sessionId}.lock`)), { code: 'ENOENT' });
  });
}

test('adapter: a claimed duplicate END cannot mutate a waiting next step', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  const p = { version: 1, id, sessionId, expiresAt: Date.now() + 600000,
    steps: [0, 1].map(() => ({ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: true })) };
  await h.store.enqueue(p); h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: 1700000000000, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic reply' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  h.ctx.isIdle = () => false;
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await reach(h.store, id, 'waiting', h.notes);
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  const row = await h.store.receipt(id);
  assert.equal(row.state, 'waiting'); assert.equal(row.nextStep, 1); assert.equal(row.automaticReplay, false);
  assert.equal(h.sent.length, 1);
  h.ctx.isIdle = () => true; h.tick();
  await reach(h.store, id, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
});
test('adapter: verified terminal event wakes a distinct queued task within 15 seconds', async t => {
  const h = await harness(t, known());
  const firstId = '00000000-0000-4000-8000-000000000010';
  const nextId = '00000000-0000-4000-8000-000000000011';
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId));
  await h.store.enqueue(plan(nextId));
  h.tick();
  await reach(h.store, firstId, 'submitted', h.notes);
  assert.equal(await h.store.receipt(nextId), null);
  const message = { role: 'assistant', timestamp: Date.now(), provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic terminal response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  const terminalAt = Date.now();
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  const [completed, submitted] = await Promise.all([
    reach(h.store, firstId, 'completed', h.notes, 30000),
    reach(h.store, nextId, 'submitted', h.notes, 30000),
  ]);
  const elapsedMs = Date.now() - terminalAt;
  assert.ok(elapsedMs <= 30000, 'the queued task starts right after the terminal, not on a slow poll');
  assert.equal(completed.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(completed.taskSuccess, 'unverified');
  assert.equal(submitted.id, nextId); assert.equal(submitted.nextStep, 0);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0], new RegExp(firstId)); assert.match(h.sent[1], new RegExp(nextId));
});
test('adapter: missing detached message_end holds distinct next-task dispatch', async t => {
  const h = await harness(t, known());
  const firstId = '00000000-0000-4000-8000-000000000010', nextId = '00000000-0000-4000-8000-000000000011';
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId)); await h.store.enqueue(plan(nextId));
  h.tick(); await reach(h.store, firstId, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: Date.now(), provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic terminal response' }] };
  h.handlers.get('agent_start')({});
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  const row = await reach(h.store, firstId, 'completed', h.notes);
  assert.equal(row.taskSuccess, 'unverified');
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await h.store.receipt(nextId), null); assert.equal(h.sent.length, 1);
});
test('adapter: shutdown quarantines a terminal while detached identity is still missing', async t => {
  const h = await end(t, { willContinue: false }, known(), { omitMessage: true });
  await reach(h.store, h.id, 'waiting', h.notes);
  await h.handlers.get('session_shutdown')();
  const row = await reach(h.store, h.id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 1);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
});
for (const terminalState of ['aborted', 'expired']) {
  test(`adapter: shutdown quarantines a pending terminal on ${terminalState} receipt`, async t => {
    const h = await end(t, { willContinue: false }, known(), { omitMessage: true });
    await reach(h.store, h.id, 'waiting', h.notes);
    const receipt = await h.store.receipt(h.id);
    receipt.state = terminalState; receipt.reason = `fixture_${terminalState}`; receipt.updatedAt = Date.now();
    await h.store.save(receipt);
    await h.handlers.get('session_shutdown')();
    const row = await reach(h.store, h.id, 'failed', h.notes);
    assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 1);
    assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
    await assert.rejects(fs.stat(path.join(h.root, `supervisor-${sessionId}.lock`)), { code: 'ENOENT' });
  });
}

test('adapter: duplicate end cannot orphan a pending terminal ticket during shutdown', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: Date.now(), provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic terminal response' }] };
  h.handlers.get('agent_start')({});
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await reach(h.store, id, 'completed', h.notes);
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await h.handlers.get('session_shutdown')();
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 1);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
});
test('adapter: rejected duplicate end preserves the ticket for a late conflicting response ID', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: 1700000001000, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', responseId: 'native-response-first', content: [{ type: 'text', text: 'first response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await reach(h.store, id, 'completed', h.notes);
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  h.handlers.get('message_end')({ message: { ...structuredClone(message), timestamp: 1700000002000,
    responseId: 'native-response-late', content: [{ type: 'text', text: 'conflicting late response' }] } });
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 1);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
});

const terminalCases = [['explicit false', { willContinue: false }], ['omitted field', {}], ['explicit undefined', { willContinue: undefined }]];
test('adapter: claimed prior-step END cannot mutate a replacement run', async t => {
  const h = await end(t, { willContinue: false }, known());
  await reach(h.store, h.id, 'waiting', h.notes);
  h.tick(); await reach(h.store, h.id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  endEvent(h, structuredClone(h.message), { willContinue: false }, 0);
  const stillCurrent = await h.store.receipt(h.id);
  assert.equal(stillCurrent.state, 'submitted'); assert.equal(stillCurrent.nextStep, 1);
  assert.equal(stillCurrent.automaticReplay, false); assert.equal(h.sent.length, 2);
  const fresh = { ...structuredClone(h.message), timestamp: h.message.timestamp + 1 };
  h.handlers.get('message_end')({ message: structuredClone(fresh) });
  endEvent(h, fresh, { willContinue: false }, 1);
  const row = await reach(h.store, h.id, 'completed', h.notes);
  assert.equal(row.nextStep, 2); assert.equal(h.sent.length, 2);
});
test('adapter: contradictory duplicate END invalidates its old task without corrupting distinct active work', async t => {
  const h = await harness(t, known()), [firstId, nextId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId)); await h.store.enqueue(plan(nextId));
  h.tick(); await reach(h.store, firstId, 'submitted', h.notes);
  const first = { role: 'assistant', timestamp: 1800000000004, provider: 'synthetic', model: 'fixture',
    responseId: 'first-native-response', stopReason: 'stop', content: [{ type: 'text', text: 'first response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(first) });
  endEvent(h, first, { willContinue: false }, 0);
  await reach(h.store, firstId, 'completed', h.notes);
  await reach(h.store, nextId, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  endEvent(h, { ...structuredClone(first), responseId: 'conflicting-native-response' }, { willContinue: true }, 0);
  const quarantined = await reach(h.store, firstId, 'failed', h.notes);
  assert.equal(quarantined.reason, 'end_not_matched_to_message'); assert.equal(quarantined.automaticReplay, false);
  assert.equal((await h.store.receipt(nextId)).state, 'submitted'); assert.equal(h.sent.length, 2);
  const next = { role: 'assistant', timestamp: 1800000000005, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'next response' }] };
  h.handlers.get('message_end')({ message: structuredClone(next) });
  endEvent(h, next, { willContinue: false }, 1);
  assert.equal((await reach(h.store, nextId, 'completed', h.notes)).taskSuccess, 'unverified');
});
test('adapter: old-task conflict cannot quarantine a distinct task waiting at its pre-send fence', async t => {
  let signalSecondFence, releaseSecondFence;
  const secondFence = new Promise(resolve => { signalSecondFence = resolve; });
  const admissionGate = new Promise(resolve => { releaseSecondFence = resolve; });
  const [firstId, nextId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  t.after(() => releaseSecondFence());
  const h = await harness(t, known({ beforeSubmissionFence: async text => {
    if (text.startsWith(`[OMP bridge ${nextId} step 0]`)) { signalSecondFence(); await admissionGate; }
  } }));
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId)); await h.store.enqueue(plan(nextId));
  h.tick(); await reach(h.store, firstId, 'submitted', h.notes);
  const first = { role: 'assistant', timestamp: 1800000000006, provider: 'synthetic', model: 'fixture',
    responseId: 'first-native-response', stopReason: 'stop', content: [{ type: 'text', text: 'first response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(first) });
  endEvent(h, first, { willContinue: false }, 0);
  await reach(h.store, firstId, 'completed', h.notes);
  await reach(h.store, nextId, 'submitting', h.notes);
  await secondFence;
  endEvent(h, { ...structuredClone(first), responseId: 'conflicting-native-response' }, { willContinue: true }, 0);
  releaseSecondFence();
  const [quarantined, submitted] = await Promise.all([
    reach(h.store, firstId, 'failed', h.notes), reach(h.store, nextId, 'submitted', h.notes),
  ]);
  assert.equal(quarantined.reason, 'end_not_matched_to_message'); assert.equal(quarantined.automaticReplay, false);
  assert.equal(submitted.nextStep, 0); assert.equal(h.sent.length, 2);
  const next = { role: 'assistant', timestamp: 1800000000007, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'next response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(next) });
  endEvent(h, next, { willContinue: false }, 1);
  assert.equal((await reach(h.store, nextId, 'completed', h.notes)).taskSuccess, 'unverified');
});
test('adapter: changed earlier post-user native evidence invalidates only its claimed task', async t => {
  const h = await harness(t, known()), [firstId, nextId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId)); await h.store.enqueue(plan(nextId));
  h.tick(); await reach(h.store, firstId, 'submitted', h.notes);
  const earlier = { role: 'assistant', timestamp: 1800000000007, provider: 'synthetic', model: 'fixture',
    responseId: 'earlier-native-response', stopReason: 'toolUse', content: [{ type: 'text', text: 'earlier response' }] };
  const terminal = { role: 'assistant', timestamp: 1800000000008, provider: 'synthetic', model: 'fixture',
    responseId: 'last-native-response', stopReason: 'stop', content: [{ type: 'text', text: 'terminal response' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(earlier) });
  endEvent(h, [earlier, terminal], { willContinue: false }, 0);
  await reach(h.store, firstId, 'completed', h.notes);
  await reach(h.store, nextId, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  const user = { role: 'user', content: [{ type: 'text', text: h.sent[0] }] };
  h.handlers.get('agent_end')({ messages: [user,
    { ...structuredClone(earlier), responseId: 'changed-earlier-native-response' }, structuredClone(terminal)],
    willContinue: false });
  const quarantined = await reach(h.store, firstId, 'failed', h.notes);
  assert.equal(quarantined.reason, 'end_not_matched_to_message');
  assert.equal((await h.store.receipt(nextId)).state, 'submitted'); assert.equal(h.sent.length, 2);
  const next = { role: 'assistant', timestamp: 1800000000009, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'next response' }] };
  h.handlers.get('message_end')({ message: structuredClone(next) });
  endEvent(h, next, { willContinue: false }, 1);
  assert.equal((await reach(h.store, nextId, 'completed', h.notes)).taskSuccess, 'unverified');
});
test('adapter: prior END requires exact submitted text before replacement work is protected', async t => {
  const realNow = Date.now; let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const h = await harness(t, known());
  const [firstId, nextId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const unpaired = String.fromCharCode(0xd800);
  const plan = id => ({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: id === firstId ? `Inspect ${unpaired} fixture only.` : 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  await h.store.enqueue(plan(firstId)); await h.store.enqueue(plan(nextId));
  const send = h.pi.sendUserMessage;
  h.pi.sendUserMessage = async text => {
    await send(text);
    if (text.startsWith(`[OMP bridge ${firstId} step 0]`)) throw new Error('accepted then disconnected');
  };
  h.tick();
  const first = await reach(h.store, firstId, 'failed', h.notes);
  assert.equal(first.automaticReplay, false);
  offset = 6000;
  h.tick(); await reach(h.store, nextId, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  const stale = { role: 'assistant', timestamp: 1800000000001, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'stale response' }] };
  endEvent(h, stale, { willContinue: false }, 0);
  assert.equal((await h.store.receipt(nextId)).state, 'submitted');
  const changedText = h.sent[0].replace(unpaired, String.fromCharCode(0xfffd));
  assert.notEqual(changedText, h.sent[0]);
  h.handlers.get('agent_end')({ messages: [
    { role: 'user', content: [{ type: 'text', text: changedText }] }, structuredClone(stale),
  ], willContinue: false });
  const current = await reach(h.store, nextId, 'failed', h.notes);
  assert.equal(current.reason, 'end_not_matched_to_message'); assert.equal(current.automaticReplay, false);
  assert.equal(h.sent.length, 2);
});
test('adapter: END arriving before send returns stays bound to the captured submitting step', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  const message = { role: 'assistant', timestamp: 1800000000003, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'early terminal' }] };
  const send = h.pi.sendUserMessage;
  h.pi.sendUserMessage = async text => {
    await send(text);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({ message: structuredClone(message) });
    endEvent(h, message, { willContinue: false }, 0);
  };
  h.tick();
  const row = await reach(h.store, id, 'completed', h.notes);
  assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(row.taskSuccess, 'unverified'); assert.equal(h.sent.length, 1);
});
test('adapter: an earlier assistant STOP cannot terminalize a current submitted prompt', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  const earlier = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old stop' }] };
  const currentUser = { role: 'user', content: [{ type: 'text', text: h.sent[0] }] };
  h.handlers.get('agent_end')({ messages: [earlier, currentUser], willContinue: false });
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 0);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
});
test('adapter: missing submitted user association makes the captured task UNKNOWN', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  const manual = { role: 'user', content: [{ type: 'text', text: 'unrelated message' }] };
  const reply = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'unrelated stop' }] };
  h.handlers.get('agent_end')({ messages: [manual, reply], willContinue: false });
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 0);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
});
test('adapter: response ID and fallback fingerprint independently block prior-run replay', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  const p = { version: 1, id, sessionId, expiresAt: Date.now() + 600000,
    steps: [0, 1].map(() => ({ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: true })) };
  await h.store.enqueue(p); h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: 1700000000000, provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic reply' }], responseId: 'native-response-old' };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  h.ctx.isIdle = () => false;
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await reach(h.store, id, 'waiting', h.notes); h.ctx.isIdle = () => true;
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const replay = structuredClone(message); delete replay.responseId;
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(replay) });
  endEvent(h, structuredClone(replay), { willContinue: false }, 1);
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.nextStep, 1);
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 2);
});
test('adapter: a prior-epoch message_end arriving after agent_end quarantines the terminal', async t => {
  const h = await end(t, { willContinue: false }, known());
  await reach(h.store, h.id, 'waiting', h.notes); h.tick();
  await reach(h.store, h.id, 'submitted', h.notes);
  const fresh = { ...structuredClone(h.message), timestamp: h.message.timestamp + 1 };
  h.handlers.get('agent_start')({});
  endEvent(h, structuredClone(fresh), { willContinue: false }, 1);
  h.handlers.get('message_end')({ message: structuredClone(h.message) });
  const row = await reach(h.store, h.id, 'failed', h.notes);
  assert.equal(row.reason, 'end_not_matched_to_message'); assert.equal(row.automaticReplay, false);
  assert.equal(h.sent.length, 2);
});

test('adapter: fresh second-run evidence completes without reusing a key', async t => {
  const h = await end(t, { willContinue: false }, known());
  await reach(h.store, h.id, 'waiting', h.notes);
  h.tick(); await reach(h.store, h.id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  const fresh = { ...structuredClone(h.message), timestamp: h.message.timestamp + 1 };
  h.handlers.get('message_end')({ message: structuredClone(fresh) });
  endEvent(h, structuredClone(fresh), { willContinue: false }, 1);
  const row = await reach(h.store, h.id, 'completed', h.notes);
  assert.equal(row.nextStep, 2); assert.equal(row.taskSuccess, 'unverified');
  assert.equal(h.sent.length, 2);
});
test('adapter: snapshot history capacity fails closed without eviction', async t => {
  const h = await harness(t, known());
  const p = { version: 1, id: crypto.randomUUID(), sessionId, expiresAt: Date.now() + 600000,
    steps: [{ prompt: 'Inspect synthetic fixture.', continueAfterEnd: false }] };
  await h.store.enqueue(p); h.tick(); await reach(h.store, p.id, 'submitted', h.notes);
  h.handlers.get('agent_start')({});
  let message;
  for (let i = 0; i < 100001; i++) {
    message = { role: 'assistant', timestamp: 1700000000000 + i, provider: 'synthetic', model: 'fixture',
      stopReason: 'stop', content: [] };
    h.handlers.get('message_end')({ message: structuredClone(message) });
  }
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  const row = await reach(h.store, p.id, 'failed', h.notes);
  assert.equal(row.nextStep, 0); assert.equal(h.sent.length, 1);
});

test('adapter: native START during pre-send fence cannot claim later submission', async t => {
  let releaseFence, signalFence;
  const enteredFence = new Promise(resolve => { signalFence = resolve; });
  const fenceBarrier = new Promise(resolve => { releaseFence = resolve; });
  const h = await harness(t, known({ beforeSubmissionFence: async () => {
    signalFence(); await fenceBarrier;
  } }));
  const id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Native START must not predate send.', continueAfterEnd: false }] });
  h.tick(); await enteredFence;
  h.handlers.get('agent_start')({}); // Before the actual send call, while tick is awaiting fence.
  releaseFence();
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'context_changed_before_submission');
  assert.equal(row.nextStep, 0); assert.equal(row.automaticReplay, false);
  assert.equal(h.sent.length, 0, 'pre-send START must stop dispatch');
});

test('adapter: synchronous native START inside send is correctly bound to submitted owner', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  const send = h.pi.sendUserMessage;
  h.pi.sendUserMessage = async text => {
    h.handlers.get('agent_start')({}); // OMP callback can arrive before sendUserMessage returns.
    return send(text);
  };
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Synchronous START accepted only after invocation.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: Date.now(), provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic terminal response' }] };
  h.handlers.get('message_end')({ message: structuredClone(message) });
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  const row = await reach(h.store, id, 'completed', h.notes);
  assert.equal(row.nextStep, 1); assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(row.taskSuccess, 'unverified'); assert.equal(h.sent.length, 1);
});


test('adapter: end without a current agent start ends failed (start_event_missing) and never replays', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: Date.now(), provider: 'synthetic', model: 'fixture',
    stopReason: 'stop', content: [{ type: 'text', text: 'synthetic terminal response' }] };
  endEvent(h, message, { willContinue: false }, 0);
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'start_event_missing'); assert.equal(row.nextStep, 0); assert.equal(row.automaticReplay, false);
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.sent.length, 1);
});
test('adapter: changed project binding at the final API gate is failed and never sent', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  // Change the project binding once the pre-send fence is durably recorded, which
  // precedes the final idle/binding gate adjacent to the native send. Keyed on the
  // receipt, not on how many times the timer or diagnostics sample isIdle.
  const fenced = () => { try { return Boolean(JSON.parse(readFileSync(h.store.file('receipts', id), 'utf8')).outcomes?.[0]?.admissionFence); } catch { return false; } };
  h.ctx.isIdle = () => {
    if (fenced()) h.ctx.cwd = path.join(h.root, 'wrong-project');
    return true;
  };
  h.tick();
  const row = await reach(h.store, id, 'failed', h.notes);
  assert.equal(row.reason, 'context_changed_before_submission');
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 0);
});
for (const host of ANY_OMP) for (const [name, extra] of terminalCases) {
  test(`adapter: known ${host} host treats ${name} as terminal and advances`, async t => {
    const h = await end(t, extra, adapter.createBridge(async () => host));
    await reach(h.store, h.id, 'waiting', h.notes);
    h.tick(); await reach(h.store, h.id, 'submitted', h.notes);
    assert.equal(h.sent.length, 2);
  });
}


// `pump` re-fires the harness timer while waiting. A command is now answered early in the wake, so the next
// request can arrive while the previous wake is still finishing and its single manual tick is coalesced away;
// production re-fires every 2 seconds, so the test does the same.
async function commandState(store, id, expected, pump) {
  const deadline = Date.now() + SETTLE_MS;
  for (let polls = 0; Date.now() < deadline; polls++) {
    if (pump && polls % 5 === 4) pump();
    try {
      const receipt = await store.commandReceipt(id);
      if (receipt?.state === expected) return receipt;
    } catch (error) {
      if (error?.constructor !== Error || error.message !== 'file changed') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`command ${id} did not reach ${expected}`);
}

test('controller slash command safely selects an available native model without sending slash text', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  h.tick();
  const row = await commandState(h.store, id, 'verified');
  assert.match(row.observation, /OMP reports the requested model is running/);
  assert.deepEqual([row.requested, row.resolved, row.actual], ['openai-codex/gpt-6-luna', 'openai-codex/gpt-6-luna', 'openai-codex/gpt-6-luna']);
  assert.deepEqual(h.modelChanges, [{ provider: 'openai-codex', id: 'gpt-6-luna' }]);
  assert.deepEqual(h.sent, []);
});

test('unknown, TUI-only, custom and file commands are explicit non-prompt outcomes', async t => {
  const h = await harness(t, known());
  for (const [text, reason] of [
    ['/not-a-command', /may be TUI-only or unknown/],
    ['/advisor', /extension command dispatch/],
    ['/prompt-review', /prompt command dispatch/],
    ['/model', /menu or malformed/],
  ]) {
    const id = crypto.randomUUID();
    await h.store.requestCommand(id, text);
    h.tick();
    const row = await commandState(h.store, id, 'unsupported', h.tick);
    assert.match(row.observation, reason);
  }
  assert.deepEqual(h.sent, []);
});

test('model command refuses unavailable models and missing native selection capability', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  h.ctx.modelRegistry.getAvailable = async () => [];
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  h.tick();
  assert.match((await commandState(h.store, id, 'unsupported')).observation, /does not recognise/);
  const id2 = crypto.randomUUID();
  h.ctx.modelRegistry.getAvailable = async () => [{ provider: 'openai-codex', id: 'gpt-6-luna' }];
  delete h.pi.setModel;
  await h.store.requestCommand(id2, '/model openai-codex/gpt-6-luna');
  h.tick();
  assert.match((await commandState(h.store, id2, 'unsupported', h.tick)).observation, /capability unavailable/);
  assert.deepEqual(h.sent, []);
});

test('model command remains queued when disable interrupts its admission', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  let signalAvailability, releaseAvailability;
  const availabilityStarted = new Promise(resolve => { signalAvailability = resolve; });
  const availabilityGate = new Promise(resolve => { releaseAvailability = resolve; });
  h.ctx.modelRegistry.getAvailable = async () => {
    signalAvailability(); await availabilityGate;
    return [];
  };
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  h.tick(); await availabilityStarted;
  const disabling = h.commands.get('bridge').handler('disable', h.ctx);
  releaseAvailability(); await disabling;
  assert.equal((await h.store.commandReceipt(id)).state, 'queued');
  assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.sent, []);
  await assert.rejects(fs.stat(path.join(h.root, `supervisor-${sessionId}.lock`)), { code: 'ENOENT' });
});
test('model command becomes unknown if disable lands at the immediate native gate', { timeout: 5000 }, async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  let signalDispatch, releaseDispatch;
  const dispatchStarted = new Promise(resolve => { signalDispatch = resolve; });
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const update = Store.prototype.updateCommandReceipt;
  Store.prototype.updateCommandReceipt = async function(requestId, state, observation) {
    if (state === 'dispatching') { signalDispatch(); await dispatchGate; }
    return update.call(this, requestId, state, observation);
  };
  t.after(() => { Store.prototype.updateCommandReceipt = update; });
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  h.tick(); await dispatchStarted;
  const disabling = h.commands.get('bridge').handler('disable', h.ctx);
  releaseDispatch(); await disabling;
  const row = await h.store.commandReceipt(id);
  assert.equal(row.state, 'failed'); assert.match(row.observation, /lifecycle interrupted/);
  assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.sent, []);
  await assert.rejects(fs.stat(path.join(h.root, `supervisor-${sessionId}.lock`)), { code: 'ENOENT' });
});


test('command tickets are unique, cancellable before dispatch, and isolated to the bound session', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  let signalAvailability, releaseAvailability;
  const availabilityStarted = new Promise(resolve => { signalAvailability = resolve; });
  const availabilityGate = new Promise(resolve => { releaseAvailability = resolve; });
  h.ctx.modelRegistry.getAvailable = async () => {
    signalAvailability();
    await availabilityGate;
    return [{ provider: 'openai-codex', id: 'gpt-6-luna' }];
  };
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  await assert.rejects(h.store.requestCommand(id, '/model openai-codex/gpt-6-luna'), { code: 'EEXIST' });
  h.tick();
  await availabilityStarted;
  assert.deepEqual(await h.store.cancelCommand(id), { id, state: 'cancelled', cancelled: true });
  releaseAvailability();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.modelChanges, []);
  const foreignId = crypto.randomUUID();
  await h.store.requestCommand(foreignId, '/model openai-codex/gpt-6-luna');
  h.ctx.sessionManager.getSessionId = () => crypto.randomUUID();
  h.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.store.commandReceipt(foreignId)).state, 'queued');
  assert.deepEqual(h.modelChanges, []);
});

test('native work in flight serializes ahead of command tickets; ordinary chat remains a prompt', async t => {
  const h = await harness(t, known());
  const planId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: planId, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'ordinary chat text', continueAfterEnd: false }] });
  h.tick();
  await reach(h.store, planId, 'submitted', h.notes);
  const id = crypto.randomUUID();
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  h.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.store.commandReceipt(id)).state, 'queued');
  assert.deepEqual(h.modelChanges, []);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /ordinary chat text/);
});

test('a dispatch admitted before adapter restart becomes unknown and never replays', async t => {
  const h = await harness(t, known()), id = crypto.randomUUID();
  await h.store.requestCommand(id, '/model openai-codex/gpt-6-luna');
  await h.store.updateCommandReceipt(id, 'dispatching', 'synthetic admission');
  await h.store.recoverCommands();
  assert.equal((await h.store.commandReceipt(id)).state, 'failed');
  h.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.modelChanges, []);
  assert.deepEqual(h.sent, []);
});

test('slash lifecycle: disable is idempotent, holds queued work, enable restores exactly one supervisor', async t => {
  const h = await harness(t, known()); const command = h.commands.get('bridge').handler;
  const lock = path.join(h.root, 'supervisor-' + sessionId + '.lock');
  await command('disable', h.ctx); await command('disable', h.ctx);
  assert.equal(h.timer(), null); await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  const id = crypto.randomUUID(); await h.store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,steps:[{prompt:'fixture',continueAfterEnd:false}]});
  h.tick(); assert.equal(h.sent.length, 0); assert.equal(await h.store.receipt(id), null);
  await command('enable', h.ctx); const timer = h.timer(); await command('enable', h.ctx); assert.equal(h.timer(), timer);
  await fs.stat(lock); await command('status', h.ctx); assert.match(h.notes.at(-1)[0], /running.*session/);
  await command('disable', h.ctx); assert.equal(h.sent.length, 1);
  assert.equal((await h.store.receipt(id)).reason, 'supervisor_shutdown');
});

test('slash disable in flight marks unknown without interrupt or replay; competing lock and changed session refuse enable', async t => {
  const h = await harness(t, known()); const command=h.commands.get('bridge').handler;
  const id=crypto.randomUUID(); await h.store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,steps:[{prompt:'fixture',continueAfterEnd:false}]});
  h.tick(); await reach(h.store,id,'submitted',h.notes); await command('disable',h.ctx);
  assert.equal((await h.store.receipt(id)).state,'failed'); assert.equal(h.sent.length,1);
  const lock=path.join(h.root,'supervisor-'+sessionId+'.lock'); await fs.writeFile(lock,'other');
  await command('enable',h.ctx); assert.equal(h.timer(),null); assert.equal(await fs.readFile(lock,'utf8'),'other');
  await fs.unlink(lock); h.ctx.sessionManager.getSessionId=()=>crypto.randomUUID(); await command('enable',h.ctx);
  assert.equal(h.timer(),null); assert.match(h.notes.at(-1)[0],/does not match/);
});

for(const host of ANY_OMP) for(const [label,extra,expected] of [['explicit false',{willContinue:false},'waiting'],['omitted',{},'waiting'],['null',{willContinue:null},'malformed'],['explicit continuation',{willContinue:true},'submitted']]) {
 test('adapter: on any OMP version (' + host + ') willContinue '+label+' follows the one rule', async t=>{
  const h=await end(t,extra,adapter.createBridge(async ()=>host));
  const row=await reach(h.store,h.id,expected,h.notes);
  assert.equal(h.sent.length,1); assert.equal(row.taskSuccess,'unverified');
 });
}

test('adapter: missing timer capability refuses enable before lock or submission', async t=>{
 const h=await harness(t,adapter.createBridge(async ()=>ANY_OMP[0]));
 await h.commands.get('bridge').handler('disable',h.ctx);
 delete h.ctx.clearTimer;
 await h.commands.get('bridge').handler('enable',h.ctx);
 assert.equal(h.timer(),null); assert.equal(h.sent.length,0);
 await assert.rejects(fs.stat(path.join(h.root,'supervisor-'+sessionId+'.lock')),{code:'ENOENT'});
 assert.match(h.notes.at(-1)[0],/capabilities/);
});

// Diagnostics observe gates; they never bypass them or retain task text.
test('diagnostics record idle/pending gates without sending or leaking prompts', async t => {
  const h=await harness(t,known());let idle=false,pending=true;h.ctx.isIdle=()=>idle;h.ctx.hasPendingMessages=()=>pending;
  const id=crypto.randomUUID(),secret='synthetic text must not enter status';await h.store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+600000,steps:[{prompt:secret,continueAfterEnd:false}]});
  const initial=JSON.parse(await fs.readFile(path.join(h.root,'control','dispatch-diagnostic.json'),'utf8'));
  h.tick();const {text,row}=await waitForSnapshot(h.root,row=>row.tickCount===initial.tickCount+1&&row.phase==='after-event');assert.equal(row.idle,false);assert.equal(row.pendingMessages,true);assert.equal(row.tickCount,initial.tickCount+1);assert.ok(row.lastTickFinishedAt);assert.equal(h.sent.length,0);assert.equal(text.includes(secret),false);
  const metadata=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));assert.equal(row.bridgeVersion,metadata.version);
  idle=true;pending=false;h.tick();await reach(h.store,id,'submitted',h.notes);assert.equal(h.sent.length,1);
});
test('diagnostics report a fixed category without raw error text and keep controller open', async t => {
  const h = await harness(t,known());h.ctx.isIdle=()=>{throw Error('private credential-like text must not leak')};h.tick();const {text,row}=await waitForSnapshot(h.root,row=>row.lastSupervisorError==='other-fixed-category');assert.equal(row.supervisorClosed,false);assert.equal(row.lastSupervisorError,'other-fixed-category');assert.equal(row.idle,null);assert.equal(text.includes('credential-like'),false);assert.equal(h.sent.length,0);
});

test('diagnostics retain exact setup shape and normal controller/status loading', async t => {
  const {loadSetup}=await import('../src/setup.mjs');const h=await harness(t,known());await fs.copyFile(h.configFile,path.join(h.root,'config.json'));await writeJson(path.join(h.root,'launch.json'),{version:1,sessionFile:h.ctx.sessionManager.getSessionFile(),executable:path.join(path.dirname(h.root),'synthetic-omp.exe')});const initial=await waitForInitialWake(h.root);h.tick();await waitForSnapshot(h.root,row=>row.tickCount>initial.tickCount&&row.phase==='after-event');const loaded=await loadSetup(h.root);assert.equal(loaded.settings.sessionId,sessionId);assert.deepEqual(await loaded.store.ids(),[]);assert.equal((await fs.readdir(h.root)).includes('dispatch-diagnostic.json'),false);assert.ok(await fs.stat(path.join(h.root,'control','dispatch-diagnostic.json')));
});

// Matching failed observations used to consume a step before an overlapping
// native queued run marked the receipt unknown. Exercise both host paths.
for (const host of ANY_OMP) for (const stopReason of ['aborted', 'error', 'toolUse']) {
 test(`adapter: correlated non-successful ${stopReason} on ${host} never advances or replays`, async t => {
  const message = {stopReason};
  const h = await end(t, {willContinue:false}, adapter.createBridge(async()=>host), {changeObserved:message,changeEnd:message});
  const row = await reach(h.store,h.id,'failed',h.notes);
  assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(row.taskSuccess,'unverified');
  h.tick();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(h.sent.length,1);
 });
}

// Regression: a long session accumulates one message key per assistant reply.
// Correlation must keep working for the Nth legitimate completion; saturation of
// the prior-epoch key set must not turn every later completed turn into
// end_not_matched_to_message. 130 prior completed turns exceeds the 128-key bound.
test('adapter: correct completion still correlates after 130 prior completed turns', async t => {
  const h = await harness(t, known());
  for (let i = 0; i < 130; i++) {
    h.handlers.get('agent_start')({});
    const prior = { role: 'assistant', timestamp: 1700000000000 + i, provider: 'synthetic', model: 'fixture', stopReason: 'stop', content: [{ type: 'text', text: 'prior ' + i }] };
    h.handlers.get('message_end')({ message: prior });
    h.handlers.get('agent_end')({ messages: [{role:'user',content:'synthetic prior user '+i},prior], willContinue: false });
  }
  const p = { version: 1, id: crypto.randomUUID(), sessionId, expiresAt: Date.now() + 600000,
    steps: [0, 1].map(() => ({ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: true })) };
  await h.store.enqueue(p);
  h.tick(); await reach(h.store, p.id, 'submitted', h.notes);
  const message = { role: 'assistant', timestamp: 1800000000000, provider: 'synthetic', model: 'fixture', stopReason: 'stop', content: [{ type: 'text', text: 'task reply' }] };
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: structuredClone(message) });
  h.ctx.isIdle = () => false;
  endEvent(h, structuredClone(message), { willContinue: false }, 0);
  await reach(h.store, p.id, 'waiting', h.notes);
});
test('adapter: shutdown after real work drains trace and diagnostic writers', async t => {
  const h = await end(t, { willContinue: false }, known());
  await reach(h.store, h.id, 'waiting', h.notes);
  await h.handlers.get('session_shutdown')();
  const control = path.join(h.root, 'control');
  const names = await fs.readdir(control);
  assert.deepEqual(names.filter(name => name.endsWith('.tmp') || name === 'trace-write.lock'), []);
  assert.match(await fs.readFile(path.join(control, 'bridge-trace.jsonl'), 'utf8'), /"event":"supervisor_close"/);
});
// Receipt shape from the lane on the host-qualified 18.14.0 build:
// a fresh session (title slot + header, whole file inside the 32 KiB fence window)
// runs to a normal finish, OMP rewrites the title slot in place mid-run, and the
// plan was left `unknown/message_not_confirmed_in_transcript` (fence start 0, fence_changed).
const titleSlot = (title) => {
  const base = { type: 'title', v: 1, title, source: 'auto', updatedAt: '2026-10-30T00:00:00.000Z' };
  const pad = 256 - Buffer.byteLength(JSON.stringify({ ...base, pad: '' }) + '\n');
  return JSON.stringify({ ...base, pad: ' '.repeat(pad) }) + '\n';
};
async function titleSlotRun(t, mutate) {
  const h = await harness(t, adapter.createBridge(async () => ANY_OMP[0]));
  const session = h.ctx.sessionManager.getSessionFile();
  await fs.writeFile(session, titleSlot('New session') + await fs.readFile(session, 'utf8'));
  const id = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect the synthetic title-slot fixture only.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, id, 'submitted', h.notes);
  const receipt = await h.store.receipt(id);
  const fence = receipt.outcomes[0].admissionFence;
  const message = phaseMessage(30);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message });
  await mutate(session);
  endEvent(h, [message], { willContinue: false });
  return { ...h, id, fence, session };
}
test('adapter: in-place title-slot rewrite during a one-step run completes the plan, not failed', async t => {
  const h = await titleSlotRun(t, async session => {
    const handle = await fs.open(session, 'r+');
    try { await handle.write(Buffer.from(titleSlot('Generated automatic title')), 0, 256, 0); } finally { await handle.close(); }
  });
  assert.equal(h.fence.start, 0);
  const row = await reach(h.store, h.id, 'completed', h.notes);
  assert.equal(row.reason, 'all_planned_submissions_ended_success_unverified');
  assert.equal(row.outcomes[0].admission, 'exact_user_record_observed');
  assert.equal(row.outcomes[0].terminalObservation, 'run_end_observed');
  assert.equal(row.taskSuccess, 'unverified'); assert.equal(row.automaticReplay, false);
  assert.equal(h.sent.length, 1);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: nextId, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, nextId, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
});
test('adapter: a rewrite of any other fenced byte during the run still ends the plan failed', async t => {
  const h = await titleSlotRun(t, async session => {
    const handle = await fs.open(session, 'r+');
    try { await handle.write(Buffer.from('MUTATED'), 0, 7, 256 + 200); } finally { await handle.close(); }
  });
  const row = await reach(h.store, h.id, 'failed', h.notes);
  assert.equal(row.reason, 'message_not_confirmed_in_transcript');
  assert.equal(row.automaticReplay, false); assert.equal(h.sent.length, 1);
  const nextId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: nextId, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await h.store.receipt(nextId), null); assert.equal(h.sent.length, 1);
});
// Coordinator-visible lane transitions (control/lane-events.jsonl): idle/busy are
// sampled on the 2 s timer and written immediately, so each lands well inside 3 s.
const laneFile = root => path.join(root, 'control', 'lane-events.jsonl');
async function waitLane(root, predicate, timeoutMs = SETTLE_MS) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    try { rows = (await fs.readFile(laneFile(root), 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { rows = []; }
    const hit = rows.find(predicate);
    if (hit) return { hit, rows };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('lane event never appeared: ' + JSON.stringify(rows));
}
test('adapter: lane events report idle, busy and pending transitions within 3 s of the sampling tick', async t => {
  const h = await harness(t, known());
  await waitLane(h.root, row => row.event === 'idle' && row.reason === 'native_idle');
  const sample = async (mutate, event, reason) => {
    mutate();
    const started = Date.now(); h.tick();
    const { hit } = await waitLane(h.root, row => row.event === event && row.reason === reason && row.time >= started);
    assert.ok(hit.time - started < 3000, `${event} took ${hit.time - started} ms`);
    return hit;
  };
  await sample(() => { h.ctx.isIdle = () => false; }, 'busy', 'native_busy');
  await sample(() => { h.ctx.isIdle = () => true; }, 'idle', 'native_idle');
  await sample(() => { h.ctx.hasPendingMessages = () => true; }, 'busy', 'pending_messages');
  await sample(() => { h.ctx.hasPendingMessages = () => false; }, 'idle', 'native_idle');
  const { rows } = await waitLane(h.root, row => row.event === 'idle' && row.seq >= 5);
  assert.deepEqual(rows.map(row => row.event), ['idle', 'busy', 'idle', 'busy', 'idle']); // edges only, no repeats
});
test('adapter: finished plan emits plan_done then idle, with no task text, and the next plan dispatches on the first idle tick', async t => {
  const h = await phaseFixture(t, ANY_OMP[0]);
  h.tick();
  await waitLane(h.root, row => row.event === 'busy' && row.reason === 'plan_active' && row.planId === h.id);
  h.handlers.get('agent_start')({});
  const message = phaseMessage(50);
  h.handlers.get('message_end')({ message });
  endEvent(h, [message], { willContinue: false });
  await reach(h.store, h.id, 'completed', h.notes);
  const { hit: done } = await waitLane(h.root, row => row.event === 'plan_done' && row.planId === h.id && row.state === 'completed');
  h.tick(); // The idle edge may already have been written right after plan_done (edges are written once), so match by order, not by time.
  const { rows } = await waitLane(h.root, row => row.event === 'idle' && row.seq > done.seq);
  const events = rows.map(row => row.event);
  assert.ok(events.indexOf('plan_done') < events.lastIndexOf('idle'), events.join());
  const text = await fs.readFile(laneFile(h.root), 'utf8');
  assert.equal(text.includes('Inspect the synthetic'), false);
  for (const row of rows) assert.ok(Object.keys(row).every(key => ['version', 'seq', 'time', 'pid', 'sessionId', 'event', 'planId', 'state', 'reason', 'dropped'].includes(key)));
  const next = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: next, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, next, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
});
test('adapter: a failed plan reports plan_done/failed, holds the queued plan for the settle time, never replays', async t => {
  const h = await titleSlotRun(t, async session => {
    const handle = await fs.open(session, 'r+');
    try { await handle.write(Buffer.from('MUTATED'), 0, 7, 256 + 200); } finally { await handle.close(); }
  });
  await reach(h.store, h.id, 'failed', h.notes);
  const next = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: next, sessionId, expiresAt: Date.now() + 60000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick();
  const { rows } = await waitLane(h.root, row => row.event === 'plan_done' && row.planId === h.id);
  const failed = rows.find(row => row.event === 'plan_done' && row.planId === h.id);
  assert.deepEqual([failed.state, failed.reason], ['failed', 'message_not_confirmed_in_transcript']);
  assert.equal(rows.some(row => row.event === 'plan_unknown' || row.event === 'queued_blocked'), false);
  assert.equal(await h.store.receipt(next), null); assert.equal(h.sent.length, 1);
});
// Owner requirement: at most 15 s between commands. The supervisor timer is the
// only trigger for a queued plan on an idle lane, so its period bounds dispatch.
test('adapter: queue polling cadence bounds idle-lane dispatch well under 15 s', async t => {
  const h = await harness(t, known());
  assert.ok(Number.isSafeInteger(h.intervalMs()) && h.intervalMs() > 0 && h.intervalMs() <= 5000, String(h.intervalMs()));
});
// An omitted willContinue means the run finished, on every OMP version: the plan completes and the next one starts at once.
test('adapter: an omitted willContinue finishes the plan and the next queued plan starts on the next tick', async t => {
  const h = await phaseFixture(t, ANY_OMP[1]);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: phaseMessage(40) });
  endEvent(h, phaseMessage(40), {});
  const row = await reach(h.store, h.id, 'completed', h.notes);
  assert.equal(row.reason, 'all_planned_submissions_ended_success_unverified');
  const nextId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: nextId, sessionId, expiresAt: Date.now() + 600000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick(); await reach(h.store, nextId, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
});
// A malformed field is held only for the settle time, then the queue goes on. Never replayed.
test('adapter: a malformed finish is malformed, goes idle, and the next queued plan then starts', async t => {
  const realNow = Date.now; let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const h = await phaseFixture(t, ANY_OMP[1]);
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({ message: phaseMessage(40) });
  endEvent(h, phaseMessage(40), { willContinue: 'maybe' });
  const row = await reach(h.store, h.id, 'malformed', h.notes);
  assert.equal(row.reason, 'malformed_end');
  const nextId = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: nextId, sessionId, expiresAt: Date.now() + 600000,
    steps: [{ prompt: 'Inspect a distinct synthetic task.', continueAfterEnd: false }] });
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await h.store.receipt(nextId), null, 'not before the lane has been idle a while');
  offset = 6000; h.ctx.isIdle = () => false;
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await h.store.receipt(nextId), null, 'never while the lane is running');
  h.ctx.isIdle = () => true;
  h.tick(); await reach(h.store, nextId, 'submitted', h.notes);
  assert.equal(h.sent.length, 2);
  const first = await h.store.receipt(h.id);
  assert.deepEqual([first.state, first.nextStep, first.automaticReplay], ['malformed', 0, false]);
});

// The person's view of a stopped or failing bridge: what the lane watcher reads, and what /bridge enable and the warnings say.
test('adapter: turning the bridge off while a plan is active ends the lane feed with an idle edge, so the watcher does not stay busy', async t => {
  const h = await phaseFixture(t, ANY_OMP[0]);
  h.tick();
  const { hit: busy } = await waitLane(h.root, row => row.event === 'busy' && row.reason === 'plan_active' && row.planId === h.id);
  await h.commands.get('bridge').handler('disable', h.ctx);
  const { hit } = await waitLane(h.root, row => row.event === 'idle' && row.reason === 'bridge_stopped' && row.seq > busy.seq);
  assert.ok(hit);
});
test('adapter: a failure that does not stop the bridge says it will try again, not that the bridge stopped', async t => {
  const h = await harness(t, known());
  h.ctx.isIdle = () => { throw new Error('transient'); };
  h.tick();
  const deadline = Date.now() + SETTLE_MS;
  while (!h.notes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(h.notes.map(note => note[0]), ['OMP bridge could not read its files just now and will try again. Nothing was lost.']);
  assert.ok(!h.notes.some(note => /stopped on uncertain state/.test(note[0])));
  h.ctx.isIdle = () => true;
  h.tick(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.notes.length, 1, 'no repeated warning, and the bridge keeps working');
});
test('adapter: /bridge enable after the bridge stopped itself on an error starts it again instead of saying it is already running', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler, broken = path.join(h.root, 'plans', crypto.randomUUID() + '.json');
  await fs.mkdir(broken); // a queue entry that cannot be read stops the supervisor
  h.tick();
  const deadline = Date.now() + SETTLE_MS;
  while (!h.notes.some(note => /stopped on uncertain state/.test(note[0])) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.notes.some(note => /stopped on uncertain state/.test(note[0])), JSON.stringify(h.notes));
  await fs.rmdir(broken);
  h.notes.length = 0;
  await command('enable', h.ctx);
  assert.ok(!h.notes.some(note => /already running/.test(note[0])), JSON.stringify(h.notes));
  assert.ok(h.notes.some(note => /Bridge enabled/.test(note[0])), JSON.stringify(h.notes));
});

// A continuing END with no START after it is read as the start of the next run when the true END follows ("late START"). That
// permission belongs to the ownership it was given under: a branch or tree change forgets it, so the same true END is not read as that run.
for (const [name, events] of [['no change', []], ['tree navigation', ['session_before_tree', 'session_tree']], ['branch', ['session_before_branch', 'session_branch']]]) {
  test(`adapter: a true END after a continuing END with no START: ${name}`, async t => {
    const h = await phaseFixture(t), first = phaseMessage(0, 'toolUse'), second = phaseMessage(1);
    h.handlers.get('agent_start')({});
    h.handlers.get('message_end')({ message: first });
    endEvent(h, first, { willContinue: true });
    for (const event of events) h.handlers.get(event)({});
    h.handlers.get('message_end')({ message: second });
    endEvent(h, [first, second], { willContinue: false });
    if (!events.length) { assert.equal((await reach(h.store, h.id, 'completed', h.notes)).nextStep, 1, 'without a change the late START is read as the next run'); return; }
    const row = await reach(h.store, h.id, 'failed', h.notes, 5000);
    assert.equal(row.reason, 'start_event_missing', 'the true END after the change is not accepted as the announced run');
    assert.equal(row.nextStep, 0); assert.equal(h.sent.length, 1);
  });
}

test('a /bridge disable that fails (the receipt cannot be saved) does not wedge the lane: after recovery, /bridge enable starts queued work again', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler;
  const queue = async () => {
    const id = crypto.randomUUID();
    await h.store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 600000, steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
    return id;
  };
  const first = await queue(); h.tick();
  const row = await reach(h.store, first, 'submitted', h.notes);
  // The shutdown receipt cannot be written, so the supervisor keeps its lock for offline recovery.
  const receipt = path.join(h.root, 'receipts', first + '.json');
  await fs.rm(receipt); await fs.mkdir(receipt);
  await command('disable', h.ctx);
  assert.match(h.notes.at(-1)[0], /^Bridge could not save the receipt of the task that was running, so it kept its lock file\..*run \/bridge enable\.$/);
  await command('status', h.ctx);
  assert.match(h.notes.at(-1)[0], /lock ownership is not held here, and this session left its lock file behind; run \/bridge enable to take it over/);
  // The person puts the receipt right; the leftover lock is this session's own, so enable takes it over and the queue does not stay shut.
  await fs.rm(receipt, { recursive: true }); await h.store.save({ ...row, state: 'failed', reason: 'supervisor_shutdown', updatedAt: Date.now() - 60000 }); // old enough not to hold the next task
  const second = await queue();
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge enabled/);
  h.tick();
  assert.equal((await reach(h.store, second, 'submitted', h.notes, 5000)).state, 'submitted');
});

test('a stop that fails when another session is loaded keeps the saved binding, so /bridge enable works once the problem is fixed', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler;
  const first = crypto.randomUUID();
  await h.store.enqueue({ version: 1, id: first, sessionId, expiresAt: Date.now() + 600000, steps: [{ prompt: 'Inspect the synthetic fixture only.', continueAfterEnd: false }] });
  h.tick();
  const row = await reach(h.store, first, 'submitted', h.notes);
  const receipt = path.join(h.root, 'receipts', first + '.json');
  await fs.rm(receipt); await fs.mkdir(receipt); // the shutdown receipt cannot be written, so stopping fails
  await h.handlers.get('session_start')({}, h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge did not start/);
  await fs.rm(receipt, { recursive: true }); await h.store.save({ ...row, state: 'failed', reason: 'supervisor_shutdown', updatedAt: Date.now() - 60000 });
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge enabled/, h.notes.at(-1)[0]);
});

test('a /bridge disable that cannot remove the lock file says so, and /bridge enable then takes that lock over', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler;
  const lock = path.join(h.root, `supervisor-${sessionId}.lock`), unlink = fs.unlink; let held = true;
  fs.unlink = async file => { if (held && String(file) === lock) throw Object.assign(new Error('held'), { code: 'EBUSY' }); return unlink.call(fs, file); };
  t.after(() => { fs.unlink = unlink; });
  await command('disable', h.ctx);
  assert.match(h.notes.at(-1)[0], /^Bridge lock file could not be removed because another program is holding it\. Run \/bridge enable to try again/);
  await command('status', h.ctx);
  assert.match(h.notes.at(-1)[0], /this session left its lock file behind/);
  held = false;
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge enabled/, h.notes.at(-1)[0]);
  // A second failed disable leaves the lock again; the person deletes the file by hand: status stops saying the session left it behind.
  held = true;
  await command('disable', h.ctx);
  await command('status', h.ctx);
  assert.match(h.notes.at(-1)[0], /this session left its lock file behind/);
  await unlink.call(fs, lock);
  await command('status', h.ctx);
  assert.match(h.notes.at(-1)[0], /lock ownership is not held here\. Desktop/);
});

test('/bridge enable names a changed saved session file or unreadable saved settings instead of one generic sentence', async t => {
  const h = await harness(t, known()), command = h.commands.get('bridge').handler, session = h.ctx.sessionManager.getSessionFile();
  await command('disable', h.ctx);
  const original = await fs.readFile(session);
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd: h.ctx.cwd }) + '\n');
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /^The saved OMP session file belongs to a different session or folder.*Run setup again/);
  await fs.writeFile(session, original);
  const settings = await fs.readFile(h.configFile);
  await fs.rm(h.configFile);
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /^Saved bridge settings could not be read\. Run setup again/);
  await fs.writeFile(h.configFile, JSON.stringify({ ...JSON.parse(settings), cwd: h.ctx.cwd + path.sep + '..' + path.sep + path.basename(h.ctx.cwd) }));
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /^The saved bridge settings name a folder that is not a full, clean path.*Run setup again/);
  await fs.writeFile(h.configFile, settings);
  await command('enable', h.ctx);
  assert.match(h.notes.at(-1)[0], /Bridge enabled/, h.notes.at(-1)[0]);
});
