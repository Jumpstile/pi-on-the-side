import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, Store, writeJson } from '../src/control.mjs';
import { createBridge } from '../extension/bridge.ts';

const sessionId = '00000000-0000-4000-8000-000000000012';
const fixtureAdmissionTimers = new WeakMap();
async function reach(store, id, state, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let receipt;
    try { receipt = await store.receipt(id); } catch (error) {
      if (error?.constructor !== Error || error.message !== 'file changed') throw error;
    }
    if (receipt?.state === state) return receipt;
    if (!receipt) fixtureAdmissionTimers.get(store)?.();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('receipt did not reach ' + state + ': ' + JSON.stringify(await store.receipt(id)));
}
async function fixture(t, hooks = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-start-owner-'));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const sessionFile = path.join(base, 'session.jsonl');
  await fs.writeFile(sessionFile, JSON.stringify({ type:'session', version:3, id:sessionId, cwd }) + '\n');
  const configFile = path.join(base, 'config.json');
  const settings = { sessionId, cwd, root };
  await writeJson(configFile, settings);
  const saved = process.env.OMP_BRIDGE_CONFIG; process.env.OMP_BRIDGE_CONFIG = configFile;
  const handlers = new Map(), sent = []; let timer;
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: () => {},
    sendUserMessage: async text => {
      sent.push(text);
      await fs.appendFile(sessionFile, JSON.stringify({type:'message',message:{role:'user',content:text}})+'\n');
    },
  };
  const ctx = {
    agent: {kind:'main'}, cwd, ui: {notify:()=>{}},
    sessionManager: {getSessionId:()=>sessionId,getSessionFile:()=>sessionFile},
    isIdle:()=>true, hasPendingMessages:()=>false,
    setInterval: fn => (timer=fn,1), clearTimer:()=>{timer=undefined;},
  };
  createBridge(async ()=>'omp/18.13.1',hooks)(pi);
  await handlers.get('session_start')({},ctx);
  t.after(async()=> {
    try { await handlers.get('session_shutdown')?.(); }
    finally {
      if (saved === undefined) delete process.env.OMP_BRIDGE_CONFIG;
      else process.env.OMP_BRIDGE_CONFIG = saved;
      await fs.rm(base,{recursive:true,force:true});
    }
  });
  const store=new Store(settings);
  fixtureAdmissionTimers.set(store,()=>timer?.());
  return {store,handlers,sent,pi,ctx,sessionFile,tick:()=>timer?.()};
}
const plan = () => ({
  version:1,id:crypto.randomUUID(),sessionId,expiresAt:Date.now()+60000,
  steps:[{prompt:'Inspect disposable native START race fixture only.',continueAfterEnd:false}],
});

test('pre-send native START during awaited fence cannot acquire task ownership', async t => {
  let h;
  let calls = 0;
  h = await fixture(t,{beforeSubmissionFence:async()=>{calls++;h.handlers.get('agent_start')({});}});
  const p=plan(); await h.store.enqueue(p); h.tick();
  const row=await reach(h.store,p.id,'failed');
  assert.equal(calls,1);
  assert.equal(row.nextStep,0);
  assert.equal(row.automaticReplay,false);
  assert.equal(h.sent.length,0,'pre-send START must never permit a native send');
  h.tick(); await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(h.sent.length,0,'unknown plan must not replay');
});

test('legitimate synchronous native START inside sendUserMessage remains correlated', async t => {
  const h=await fixture(t),p=plan();
  h.pi.sendUserMessage=async text=>{
    h.handlers.get('agent_start')({});
    h.sent.push(text);
    await fs.appendFile(h.sessionFile,JSON.stringify({type:'message',message:{role:'user',content:text}})+'\n');
  };
  await h.store.enqueue(p); h.tick();
  await reach(h.store,p.id,'submitted');
  assert.equal(h.sent.length,1);
  const message={role:'assistant',timestamp:1700001000000,provider:'synthetic',model:'fixture',
    stopReason:'stop',content:[{type:'text',text:'done'}]};
  h.handlers.get('message_end')({message});
  h.handlers.get('agent_end')({messages:[{role:'user',content:h.sent[0]},message],willContinue:false});
  const row=await reach(h.store,p.id,'completed');
  assert.equal(row.nextStep,1);
  assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
  assert.equal(row.taskSuccess,'unverified');
  assert.equal(h.sent.length,1);
});

test('later planned step resets START eligibility before its awaited fence', async t => {
  let h, fences = 0;
  h = await fixture(t,{beforeSubmissionFence:async()=>{
    if (++fences === 2) h.handlers.get('agent_start')({});
  }});
  const p=plan(); p.steps[0].continueAfterEnd=true;
  p.steps.push({prompt:'Inspect the second disposable step.',continueAfterEnd:false});
  await h.store.enqueue(p); h.tick(); await reach(h.store,p.id,'submitted');
  const message={role:'assistant',timestamp:1700001000001,provider:'synthetic',model:'fixture',
    stopReason:'stop',content:[{type:'text',text:'first step ended'}]};
  h.handlers.get('agent_start')({});
  h.handlers.get('message_end')({message});
  h.handlers.get('agent_end')({messages:[{role:'user',content:h.sent[0]},message],willContinue:false});
  const row=await reach(h.store,p.id,'failed');
  assert.equal(fences,2); assert.equal(row.nextStep,1);
  assert.equal(row.reason,'context_changed_before_submission');
  assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
  assert.equal(h.sent.length,1,'a previous step invocation must not authorize the next pre-send START');
});
