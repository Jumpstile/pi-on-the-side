import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initialize, Store, Supervisor, writeJson, LocalTrace } from '../src/control.mjs';
import { fence, reconcileAdmission, captureNativeAdmission, invokeNativeAdmission,
  observeNativeAdmission, reconcileNativeAdmission } from '../src/transcript.mjs';
import { createBridge } from '../extension/bridge.ts';
const fixtureAdmissionTimers = new WeakMap();

async function reach(store,id,state) {
  const until=Date.now()+60000;
  while(Date.now()<until) {
    try {
      const row=await store.receipt(id);if(row?.state===state)return row;
      if(!row)fixtureAdmissionTimers.get(store)?.();
    }
    catch(e) { if(e.message!=='file changed')throw e; }
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('expected '+state+': '+JSON.stringify(await store.receipt(id)));
}
async function fixture(t,host='omp/1.2.3',mode='normal',userOrder='resident-at-start') {
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pots-lineage-')));
  const cwd=path.join(base,'work'),root=path.join(base,'state'),sessionId=crypto.randomUUID();
  await fs.mkdir(cwd);await initialize(root);
  const file=path.join(base,'session.jsonl'),header={type:'session',version:3,id:sessionId,cwd};
  const entries=[];let leaf=null,sequence=0;
  const append=(message,type='message',extra={})=> {
    const e={type,id:String(++sequence).padStart(8,'0'),parentId:leaf,timestamp:'2026-10-28T00:00:00.000Z',
      ...(type==='message'?{message}:{}),...extra};entries.push(e);leaf=e.activeLeafId!==undefined?e.activeLeafId:e.id;return e;
  };
  append({role:'user',timestamp:1,content:'historical user'});
  append({role:'assistant',timestamp:2,provider:'fixture',model:'native',stopReason:'toolUse',content:[{type:'text',text:'old read'}]});
  const oldRead=append({role:'toolResult',toolName:'read',content:[{type:'text',text:'FIRST'}]});
  const manager={getSessionId:()=>sessionId,getSessionFile:()=>file,getHeader:()=>header,getEntries:()=>[...entries],
    getLeafId:()=>leaf,getEntry:id=>entries.find(e=>e.id===id),getBranch:()=>{
      const branch=[];let id=leaf;const seen=new Set();
      while(id!==null){if(seen.has(id))throw Error('cycle');seen.add(id);const e=entries.find(e=>e.id===id);if(!e)throw Error('missing');branch.unshift(e);id=e.parentId;}return branch;
    }};
  const content=()=>[header,...entries].map(e=>JSON.stringify(e)).join('\n')+'\n';
  const rewrite=async(text=content())=>{const tmp=file+'.new';await fs.writeFile(tmp,text);await fs.rename(file,file+'.old-'+crypto.randomUUID());await fs.rename(tmp,file);};
  await fs.writeFile(file,content());
  const config=path.join(base,'config.json');await writeJson(config,{sessionId,cwd,root});
  const prior=process.env.OMP_BRIDGE_CONFIG;process.env.OMP_BRIDGE_CONFIG=config;
  const handlers=new Map(),sent=[];let timer,oldUser;
  const emit=(name,event={},context)=>handlers.get(name)?.(event,context);
  const ctx={agent:{kind:'main'},cwd,sessionManager:manager,ui:{notify:()=>{}},isIdle:()=>true,hasPendingMessages:()=>false,
    setInterval:f=>(timer=f,1),clearTimer:()=>{timer=undefined;}};
  createBridge(async()=>host,{beforeSubmissionFence:async text=>{
    if(mode==='old off-branch same text') {
      const active=leaf;oldUser=append({role:'user',timestamp:100,content:[{type:'text',text}]},'message',{activeLeafId:active});
      await rewrite();
    }
  }})({on:(name,fn)=>handlers.set(name,fn),registerCommand:()=>{},sendUserMessage:async text=>{
    sent.push(text);
    if(mode==='file-only replacement')return;
    if(mode==='replicated same text')append({role:'user',timestamp:100,content:[{type:'text',text}]});
    emit('before_agent_start',{...(host.endsWith('-noreason')?{}:{reason:'prompt'}),prompt:text});emit('agent_start');
    const message={role:'user',timestamp:100,content:[{type:'text',text}]};
    if(userOrder!=='resident-at-start')emit('message_start',{message});
    if(userOrder==='insert-after-observers')emit('message_end',{message});
    if(mode==='old off-branch same text')leaf=oldUser.id;
    else {const e=append(message);await fs.appendFile(file,JSON.stringify(e)+'\n');}
    if(userOrder==='resident-at-start')emit('message_start',{message});
    if(userOrder!=='insert-after-observers')emit('message_end',{message});
  }});
  await handlers.get('session_start')({},ctx);
  t.after(async()=>{await emit('session_shutdown');if(prior===undefined)delete process.env.OMP_BRIDGE_CONFIG;else process.env.OMP_BRIDGE_CONFIG=prior;await fs.rm(base,{recursive:true,force:true});});
  const until=Date.now()+60000;
  for(;;) {
    try {
      const row=JSON.parse(await fs.readFile(path.join(root,'control','dispatch-diagnostic.json'),'utf8'));
      if(row.tickCount>=1&&Number.isSafeInteger(row.lastTickFinishedAt))break;
    } catch {}
    if(Date.now()>=until)assert.fail('startup wake did not settle');
    await new Promise(r=>setTimeout(r,10));
  }
  const store=new Store({sessionId,cwd,root});
  fixtureAdmissionTimers.set(store,()=>timer?.());
  const enqueue=async(expectedState='submitted')=>{const id=crypto.randomUUID();await store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Inspect the disposable native lineage fixture.',continueAfterEnd:false}]});timer();await reach(store,id,expectedState);return id;};
  const assistant=i=>({role:'assistant',timestamp:1700000000000+i,provider:'fixture',model:'native',responseId:'reply-'+i,
    stopReason:'stop',content:[{type:'text',text:'phase '+i}]});
  const end=(willContinue)=>emit('agent_end',{messages:entries.filter(e=>e.type==='message').map(e=>e.message),willContinue});
  const continuationPrompt=()=>emit('before_agent_start',{...(host.endsWith('-noreason')?{}:{reason:'prompt'}),
    prompt:'Continue native work with different guidance, without another user admission.'});
  return {base,cwd,root,file,header,entries,manager,store,append,rewrite,content,oldRead,emit,sent,enqueue,assistant,end,continuationPrompt,ctx,sessionId};
}

for(const host of ['omp/1.2.3','omp/1.2.3-noreason','omp/99.0.0']) for(const userOrder of ['resident-at-start','insert-between-observers','insert-after-observers']) for(const phaseOrder of ['END-before-START','START-before-END']) {
  test(`native lineage: pruning atomic rewrite on ${host} with ${userOrder} and ${phaseOrder} durably proves one user across two phases`,async t=>{
    const h=await fixture(t,host,'normal',userOrder),id=await h.enqueue(),first=h.assistant(1);
    const currentRead=h.append({role:'toolResult',toolName:'read',content:[{type:'text',text:'FIRST'}]});
    h.append(first);h.emit('message_end',{message:first});
    if(phaseOrder==='START-before-END'){h.continuationPrompt();h.emit('agent_start');h.end(true);}
    else {h.end(true);h.continuationPrompt();h.emit('agent_start');}
    h.oldRead.message.content[0].text='[Superseded by a newer read of this file]';
    currentRead.message.content[0].text='[Superseded by a newer read of this file]';
    const second=h.assistant(2);h.append(second);await h.rewrite();
    h.emit('message_end',{message:second});h.end(false);
    const row=await reach(h.store,id,'completed'),proof=row.outcomes[0].admissionProof;
    assert.equal(row.nextStep,1);assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
    assert.equal(proof.kind,'native-lineage-v1');assert.equal(proof.planId,id);assert.equal(proof.step,0);
    assert.equal(proof.anchorId,h.oldRead.id);assert.notEqual(proof.fileIno,proof.originalFence.fileIno);
    assert.equal(proof.prefixCount,3);assert.equal(proof.userId,h.entries[3].id);assert.equal(proof.userParentId,h.oldRead.id);
    assert.equal(proof.contentDigest,crypto.createHash('sha256').update(await fs.readFile(h.file)).digest('hex'));
    assert.equal(h.sent.length,1);assert.equal(row.taskSuccess,'unverified');
    const next=await h.enqueue();assert.equal((await h.store.receipt(next)).state,'submitted');assert.equal(h.sent.length,2);
  });
}
async function compactedFixture(t,count=2,host='omp/99.0.0') {
  const h=await fixture(t,host),id=await h.enqueue(),start=h.entries.length;
  const original=await fs.stat(h.file,{bigint:true});
  let kept,compact;
  for(let i=0;i<count;i++) {
    kept=h.append({...h.assistant(200+i),stopReason:'toolUse'});
    h.append({role:'toolResult',toolName:'read',content:[{type:'text',text:'inert result '+i}]});
    compact=h.append(undefined,'compaction',{firstKeptEntryId:kept.id,summary:'native preparation summary',tokensBefore:40000});
  }
  const second=h.append({...h.assistant(300),stopReason:'toolUse'});
  const result=h.append({role:'toolResult',toolName:'read',content:[{type:'text',text:'last inert result'}]});
  const endpoint=h.append(h.assistant(301));
  await fs.appendFile(h.file,h.entries.slice(start).map(e=>JSON.stringify(e)).join('\n')+'\n');
  // Actual 18.13.3 capture: summary, retained assistant/toolResult pair,
  // subsequent assistant/toolResult pair, final assistant; no user rows.
  // Native reproduction: 1793220931622-bb0442f0, five real compactions.
  const projection=[{role:'compactionSummary',summary:'native preparation summary'},kept.message,
    h.entries[h.entries.indexOf(kept)+1].message,second.message,result.message,endpoint.message];
  return {...h,id,kept,compact,endpoint,projection,original};
}
for(const count of [1,2,5])test(`compaction ownership: authentic ${count}-compaction actual END projection uses persisted endpoint proof`,async t=>{
  const h=await compactedFixture(t,count);
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection)});
  const row=await reach(h.store,h.id,'completed'),proof=row.outcomes[0].admissionProof;
  assert.equal(row.nextStep,1);assert.equal(row.taskSuccess,'unverified');assert.equal(row.automaticReplay,false);
  assert.equal(proof.kind,'native-lineage-v1');assert.equal(proof.userId,h.entries[3].id);
  assert.equal(proof.fileIno,proof.originalFence.fileIno,'No replacement-file failure selects this proof');
  assert.equal((await fs.stat(h.file,{bigint:true})).ino,h.original.ino);
  assert.equal(h.sent.length,1);await h.emit('session_shutdown');
  const events=(await fs.readFile(path.join(h.root,'control','bridge-trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e=>e.phase==='agent_end'&&e.lineage==='compaction_elided'&&e.tokenRejection==='none'));
});
for(const mode of ['kept before user','second native user','off-branch user','changed admitted user','changed prefix',
  'wrong END user','multipart END user','duplicate END user','later END user','unobserved assistant',
  'mismatched response ID','missing resident endpoint','duplicate resident endpoint','disk endpoint mismatch',
  'disk compaction mismatch','navigation','late extension input']) {
  test(`compaction ownership: ${mode} cannot borrow a compacted admission`,async t=>{
    const h=await compactedFixture(t,2,'omp/1.2.3');
    const observed=structuredClone(h.endpoint.message),messages=structuredClone(h.projection);
    if(mode!=='unobserved assistant')h.emit('message_end',{message:observed});
    if(mode==='kept before user'){h.compact.firstKeptEntryId=h.oldRead.id;await h.rewrite();}
    else if(mode==='second native user'||mode==='off-branch user') {
      h.append({role:'user',timestamp:101,content:h.sent[0]},'message',
        mode==='off-branch user'?{activeLeafId:h.endpoint.id}:{});
      await h.rewrite();
    } else if(mode==='changed admitted user'){h.entries[3].message.content[0].text+=' changed';await h.rewrite();}
    else if(mode==='changed prefix'){h.entries[0].message.content='changed old user';await h.rewrite();}
    else if(mode==='wrong END user')messages.unshift({role:'user',content:'another task'});
    else if(mode==='multipart END user')messages.unshift({role:'user',content:[
      {type:'text',text:h.sent[0].slice(0,12)},{type:'text',text:h.sent[0].slice(12)}]});
    else if(mode==='duplicate END user')messages.unshift(h.entries[3].message,h.entries[3].message);
    else if(mode==='later END user')messages.unshift(h.entries[3].message,{role:'user',content:'later context'});
    else if(mode==='mismatched response ID')messages.at(-1).responseId='wrong-native-response';
    else if(mode==='missing resident endpoint') {
      h.endpoint.message={role:'toolResult',toolName:'read',content:[{type:'text',text:'no persisted assistant'}]};
      await h.rewrite();
    } else if(mode==='duplicate resident endpoint'){h.append(structuredClone(h.endpoint.message));await h.rewrite();}
    else if(mode==='disk endpoint mismatch'||mode==='disk compaction mismatch') {
      const disk=structuredClone(h.entries),entry=disk.find(e=>e.id===(mode==='disk endpoint mismatch'?h.endpoint.id:h.compact.id));
      if(mode==='disk endpoint mismatch')entry.message.content[0].text='different persisted terminal content';
      else entry.firstKeptEntryId=h.oldRead.id;
      await h.rewrite([h.header,...disk].map(e=>JSON.stringify(e)).join('\n')+'\n');
    } else if(mode==='navigation'){h.emit('session_before_tree');h.emit('session_tree');}
    else if(mode==='late extension input')h.emit('input',{source:'extension',text:h.sent[0]});
    h.emit('agent_end',{messages,willContinue:false});
    const row=await reach(h.store,h.id,'failed');
    assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(row.taskSuccess,'unverified');
    assert.equal(row.outcomes[0].admission,undefined);assert.equal(h.sent.length,1);
  });
}
test('compaction ownership: cancellation before proof never advances',async t=>{
  const h=await compactedFixture(t);await h.store.abort(h.id);
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection),willContinue:false});
  const row=await reach(h.store,h.id,'aborted');
  assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
for(const change of ['resident endpoint','disk endpoint'])test(`compaction ownership: changed ${change} after proof cannot advance`,async t=>{
  let produced=false,held,release;const entered=new Promise(r=>{held=r;}),gate=new Promise(r=>{release=r;});
  t.after(()=>release());
  const ended=Supervisor.prototype.ended,cancelled=Store.prototype.cancelled;
  t.mock.method(Supervisor.prototype,'ended',function(...args){
    const admitted=this.adapter.admitted;
    this.adapter.admitted=async(...values)=>{const ok=await admitted(...values);produced=ok===true;return ok;};
    return ended.apply(this,args);
  });
  let target;
  t.mock.method(Store.prototype,'cancelled',async function(id){
    const value=await cancelled.call(this,id);if(id===target&&produced){held();await gate;}return value;
  });
  const h=await compactedFixture(t);target=h.id;
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection),willContinue:false});await entered;
  if(change==='resident endpoint'){h.endpoint.message.content[0].text='changed after proof';await h.rewrite();}
  else {
    const disk=structuredClone(h.entries);disk.at(-1).message.content[0].text='changed only on disk';
    await h.rewrite([h.header,...disk].map(e=>JSON.stringify(e)).join('\n')+'\n');
  }
  release();const row=await reach(h.store,h.id,'failed');
  assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
for(const stagedStart of [false,true])for(const willContinue of [true,false]) {
  test(`compaction ownership: preparation-before-END with ${stagedStart?'staged':'deferred'} START and ${willContinue?'nonterminal':'terminal'} END`,async t=>{
    const h=await compactedFixture(t),first=structuredClone(h.projection);
    h.emit('message_end',{message:structuredClone(h.endpoint.message)});
    h.continuationPrompt();if(stagedStart)h.emit('agent_start');
    h.emit('agent_end',{messages:first,willContinue});
    if(willContinue) {
      if(!stagedStart)h.emit('agent_start');
      const last=h.append(h.assistant(402));await h.rewrite();
      h.emit('message_end',{message:structuredClone(last.message)});
      h.emit('agent_end',{messages:[...first,last.message],willContinue:false});
    }
    const row=await reach(h.store,h.id,willContinue?'completed':'failed');
    assert.equal(row.nextStep,willContinue?1:0);
    assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
    if(willContinue)assert.equal(row.outcomes[0].admissionProof.kind,'native-lineage-v1');
    else assert.equal(row.outcomes[0].admission,undefined);
  });
}
for(const holdForMonitor of [false,true])test(`compaction ownership: cancellation during final proof persistence ${holdForMonitor?'remains monitored':'is checked before commit'}`,async t=>{
  let entered,release,observed;
  const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const cancellationSeen=new Promise(r=>{observed=r;});
  t.after(()=>release());
  const ended=Supervisor.prototype.ended,save=Store.prototype.save,cancelled=Store.prototype.cancelled;
  let finalizing=false,target;
  t.mock.method(Supervisor.prototype,'ended',function(...args){
    const finalize=this.adapter.finalizeAdmission;
    this.adapter.finalizeAdmission=async(...values)=>{
      finalizing=true;
      try{return await finalize(...values);}finally{finalizing=false;}
    };
    return ended.apply(this,args);
  });
  t.mock.method(Store.prototype,'save',async function(row){
    await save.call(this,row);
    if(row.id===target&&finalizing&&row.state==='submitted'&&row.outcomes.at(-1).admissionProof){
      entered();await gate;
    }
  });
  t.mock.method(Store.prototype,'cancelled',async function(id){
    const value=await cancelled.call(this,id);
    if(id===target&&finalizing&&value)observed();
    return value;
  });
  const h=await compactedFixture(t);target=h.id;
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection),willContinue:false});
  await held;await h.store.abort(h.id);
  if(holdForMonitor)await Promise.race([cancellationSeen,new Promise((_,reject)=>setTimeout(()=>reject(Error('final admission cancellation monitor stopped')),15000))]);
  release();
  const row=await reach(h.store,h.id,'aborted');
  assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);
  assert.equal(row.outcomes[0].admission,undefined);assert.equal(h.sent.length,1);
});
for(const change of ['resident endpoint','disk endpoint','cancel read failure'])test(`compaction ownership: ${change} during final cancellation observation cannot advance`,async t=>{
  let entered,release;const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  t.after(()=>release());
  const ended=Supervisor.prototype.ended,save=Store.prototype.save,cancelled=Store.prototype.cancelled;
  let finalizing=false,persisted=false,target;
  t.mock.method(Supervisor.prototype,'ended',function(...args){
    const finalize=this.adapter.finalizeAdmission;
    this.adapter.finalizeAdmission=async(...values)=>{
      finalizing=true;
      try{return await finalize(...values);}finally{finalizing=false;}
    };
    return ended.apply(this,args);
  });
  t.mock.method(Store.prototype,'save',async function(row){
    await save.call(this,row);
    if(row.id===target&&finalizing&&row.state==='submitted'&&row.outcomes.at(-1).admissionProof)persisted=true;
  });
  t.mock.method(Store.prototype,'cancelled',async function(id){
    const value=await cancelled.call(this,id);
    if(id===target&&persisted) {
      entered();await gate;
      if(change==='cancel read failure')throw Error('private cancellation read failure');
    }
    return value;
  });
  const h=await compactedFixture(t);target=h.id;
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection),willContinue:false});await held;
  if(change==='resident endpoint'){h.endpoint.message.content[0].text='changed at final cancellation observation';await h.rewrite();}
  else if(change==='disk endpoint') {
    const disk=structuredClone(h.entries);disk.at(-1).message.content[0].text='changed only on disk at final observation';
    await h.rewrite([h.header,...disk].map(e=>JSON.stringify(e)).join('\n')+'\n');
  }
  release();const row=await reach(h.store,h.id,'failed');
  assert.equal(row.nextStep,0);assert.equal(row.outcomes[0].admission,undefined);
  assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
test('compaction ownership: monitor-observed abort overrides an earlier negative cancellation read',async t=>{
  let entered,release,observed;
  const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const seen=new Promise(r=>{observed=r;});t.after(()=>release());
  const ended=Supervisor.prototype.ended,cancelled=Store.prototype.cancelled;
  let produced=false,negativeHeld=false,target;
  t.mock.method(Supervisor.prototype,'ended',function(...args){
    const admitted=this.adapter.admitted;
    this.adapter.admitted=async(...values)=>{const ok=await admitted(...values);produced=ok===true;return ok;};
    return ended.apply(this,args);
  });
  t.mock.method(Store.prototype,'cancelled',async function(id){
    const value=await cancelled.call(this,id);
    if(id===target&&produced) {
      if(!negativeHeld){assert.equal(value,false);negativeHeld=true;entered();await gate;}
      else if(value)observed();
    }
    return value;
  });
  const h=await compactedFixture(t);target=h.id;
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:structuredClone(h.projection),willContinue:false});
  await held;await h.store.abort(h.id);
  await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(Error('monitor did not observe abort')),15000))]);
  release();const row=await reach(h.store,h.id,'aborted');
  assert.equal(row.reason,'future_steps_cancelled_execution_may_continue');
  assert.equal(row.nextStep,0);assert.equal(row.outcomes[0].admission,undefined);
  assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
for(const mode of ['same cut','new authenticated cut','altered same-cut prefix'])test(`compaction ownership: continuation with ${mode} preserves phase fences`,async t=>{
  const h=await compactedFixture(t),first=structuredClone(h.projection);
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages:first,willContinue:true});h.continuationPrompt();h.emit('agent_start');
  let messages;
  if(mode==='new authenticated cut') {
    const kept=h.append({...h.assistant(401),stopReason:'toolUse'}),read=h.append({role:'toolResult',toolName:'read',content:'inert'});
    h.append(undefined,'compaction',{firstKeptEntryId:kept.id,summary:'next native cut',tokensBefore:40000});
    messages=[{role:'compactionSummary',summary:'next native cut'},kept.message,read.message];
  } else messages=structuredClone(h.projection);
  if(mode==='altered same-cut prefix')messages[1].content[0].text='changed retained predecessor';
  const last=h.append(h.assistant(402));messages.push(last.message);await h.rewrite();
  h.emit('message_end',{message:structuredClone(last.message)});h.emit('agent_end',{messages,willContinue:false});
  const row=await reach(h.store,h.id,mode==='altered same-cut prefix'?'failed':'completed');
  assert.equal(row.nextStep,mode==='altered same-cut prefix'?0:1);
  assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
test('compaction ownership: duplicate old END preserves receipt, hidden pending and next distinct task',async t=>{
  const h=await compactedFixture(t),messages=structuredClone(h.projection);
  const diagnostic=()=>fs.readFile(path.join(h.root,'control','dispatch-diagnostic.json'),'utf8').then(JSON.parse);
  const beforeEnd=await diagnostic(),wakeDeadline=Date.now()+60000;
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages,willContinue:false});const committed=await reach(h.store,h.id,'completed');
  // Receipt persistence can precede its event-driven empty-queue wake. Drain
  // that wake before introducing hidden pending work and the next queued plan.
  for(;;){const d=await diagnostic();if(d.tickCount>beforeEnd.tickCount&&d.phase==='after-event'&&
      d.activeState===null&&d.lastTickFinishedAt>=d.lastTickAt)break;
    if(Date.now()>wakeDeadline)assert.fail('terminal wake did not finish');await new Promise(r=>setTimeout(r,10));}
  h.ctx.hasPendingMessages=()=>true;
  const next=crypto.randomUUID();await h.store.enqueue({version:1,id:next,sessionId:h.sessionId,expiresAt:Date.now()+60000,
    steps:[{prompt:'Distinct disposable task after compacted END.',continueAfterEnd:false}]});
  const before=await diagnostic();fixtureAdmissionTimers.get(h.store)();
  const until=Date.now()+60000;
  for(;;){const d=await diagnostic();if(d.tickCount>before.tickCount&&d.lastTickFinishedAt>=d.lastTickAt)break;
    if(Date.now()>until)assert.fail('pending gate wake did not finish');await new Promise(r=>setTimeout(r,10));}
  assert.equal(await h.store.receipt(next),null);assert.equal(h.sent.length,1);
  h.emit('agent_end',{messages,willContinue:false});assert.deepEqual(await h.store.receipt(h.id),committed);
  h.ctx.hasPendingMessages=()=>false;fixtureAdmissionTimers.get(h.store)();await reach(h.store,next,'submitted');
  h.emit('agent_end',{messages,willContinue:false});assert.equal((await h.store.receipt(next)).state,'submitted');
  const reply=h.assistant(900);h.append(reply);await h.rewrite();h.emit('message_end',{message:reply});h.end(false);
  const last=await reach(h.store,next,'completed');assert.equal(last.nextStep,1);assert.equal(h.sent.length,2);
  assert.deepEqual(await h.store.receipt(h.id),committed);
});
test('compaction ownership: conflicting old native END is not silently deduplicated',async t=>{
  const h=await compactedFixture(t),messages=structuredClone(h.projection);
  h.emit('message_end',{message:structuredClone(h.endpoint.message)});
  h.emit('agent_end',{messages,willContinue:false});await reach(h.store,h.id,'completed');
  messages[1].content[0].text='altered old assistant prefix';
  h.emit('agent_end',{messages,willContinue:false});
  const row=await reach(h.store,h.id,'failed');assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
});
for(const mode of ['unsolicited preparation','duplicate preparation','extra user before preparation']) {
  test(`native lineage: ${mode} cannot borrow a continuation phase`,async t=>{
    const h=await fixture(t,'omp/1.2.3-noreason'),id=await h.enqueue(),first=h.assistant(50);
    h.append(first);h.emit('message_end',{message:first});
    if(mode==='unsolicited preparation')h.continuationPrompt();
    h.end(true);
    if(mode==='extra user before preparation')h.append({role:'user',timestamp:101,content:h.sent[0]});
    h.continuationPrompt();
    if(mode==='duplicate preparation')h.continuationPrompt();
    h.emit('agent_start');
    const second=h.assistant(51);h.append(second);await h.rewrite();
    h.emit('message_end',{message:second});h.end(false);
    const row=await reach(h.store,id,'failed');
    assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
  });
}
for(const mode of ['terminal false','malformed END','extra user','competing input']) {
  test(`native lineage: staged preparation with ${mode} stays failed without handoff`,async t=>{
    const h=await fixture(t,'omp/1.2.3-noreason','normal','insert-between-observers'),id=await h.enqueue(),first=h.assistant(60);
    h.append(first);h.emit('message_end',{message:first});h.continuationPrompt();
    if(mode==='extra user')h.append({role:'user',timestamp:101,content:h.sent[0]});
    if(mode==='competing input')h.emit('input',{source:'rpc',text:h.sent[0]});
    h.end(mode==='terminal false'?false:mode==='malformed END'?null:true);
    const row=await reach(h.store,id,'failed');
    assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
    assert.equal(row.outcomes[0].terminalObservation,'not_seen');
  });
}
test('native lineage: phase-grant rejection reports a fixed category without native data',async t=>{
  const h=await fixture(t),id=await h.enqueue(),reply=h.assistant(52);
  h.entries[0].message.content='DO_NOT_LOG_NATIVE_PREFIX';
  h.append(reply);h.emit('message_end',{message:reply});h.end(true);
  assert.equal((await reach(h.store,id,'failed')).nextStep,0);
  await h.emit('session_shutdown');
  const text=await fs.readFile(path.join(h.root,'control','bridge-trace.jsonl'),'utf8');
  const failures=text.trim().split('\n').map(JSON.parse).filter(row=>row.event==='admission_failure');
  assert.deepEqual(failures.map(row=>row.failure),['native_prefix_changed']);
  assert.equal(text.includes('DO_NOT_LOG_NATIVE_PREFIX'),false);
  assert.equal(text.includes(h.sent[0]),false);assert.equal(text.includes(h.file),false);
  assert.equal(text.includes(h.entries[3].id),false);
});
for(const mode of ['intact history','pruned history with advisor output','missing END user','old END user',
  'changed END user','split END user text','duplicate END user']) {
  test(`native lineage: resumed 212-message history diagnoses ${mode} without borrowing admission`,async t=>{
    let traceWriter;
    const record=LocalTrace.prototype.record;
    t.mock.method(LocalTrace.prototype,'record',function(...args){traceWriter=this;return record.apply(this,args);});
    const h=await fixture(t,'omp/99.0.0'),id=await h.enqueue();
    const admittedUser=h.entries[3],messages=[];
    for(let i=0;i<212;i++) {
      const reply={...h.assistant(1000+i),stopReason:i===211?'stop':'toolUse'};
      const entry=h.append(reply);messages.push(reply);
      await fs.appendFile(h.file,JSON.stringify(entry)+'\n');
      h.emit('message_end',{message:reply});
      // Native tool turns are spaced out; deterministically drain diagnostics
      // rather than exercising the unrelated bounded-backlog drop policy.
      await traceWriter.flush();
      if(i<211) {
        const result=h.append({role:'toolResult',toolName:'read',toolCallId:'read-'+i,
          content:[{type:'text',text:'disposable read result '+i}]});
        await fs.appendFile(h.file,JSON.stringify(result)+'\n');
      }
    }
    if(mode==='pruned history with advisor output') {
      h.oldRead.message.content[0].text='[Superseded by a newer read of this file]';
      h.append(undefined,'custom_message',{customType:'advisor-note',display:true,
        content:'PRIVATE_ADVISOR_TEXT: [OMP bridge not-the-submitted-plan step 0]'});
      await h.rewrite();
    }
    let endMessages=h.entries.filter(e=>e.type==='message').map(e=>e.message);
    if(mode==='missing END user')endMessages=[{role:'compactionSummary',summary:'disposable summary'},...messages];
    if(mode==='old END user')endMessages=[h.entries[0].message,...messages];
    if(mode==='changed END user'||mode==='split END user text') {
      const user=structuredClone(admittedUser.message);
      user.content=mode==='changed END user'?[{type:'text',text:h.sent[0]+' changed'}]:
        [{type:'text',text:h.sent[0].slice(0,12)},{type:'text',text:h.sent[0].slice(12)}];
      endMessages=endMessages.map(message=>message===admittedUser.message?user:message);
    }
    if(mode==='duplicate END user')endMessages=[admittedUser.message,...endMessages];
    h.emit('agent_end',{messages:endMessages,willContinue:false});
    const accepted=mode==='intact history'||mode==='pruned history with advisor output';
    const row=await reach(h.store,id,accepted?'completed':'failed');
    assert.equal(row.nextStep,accepted?1:0);assert.equal(row.automaticReplay,false);
    assert.equal(row.taskSuccess,'unverified');assert.equal(h.sent.length,1);
    assert.equal(h.entries.filter(e=>e.type==='message'&&e.message.role==='user'&&e.message.timestamp===100).length,1);
    if(accepted) {
      assert.equal(row.outcomes[0].admission,'exact_user_record_observed');
      if(mode==='pruned history with advisor output') {
        assert.equal(row.outcomes[0].admissionProof.kind,'native-lineage-v1');
        assert.equal(row.outcomes[0].admissionProof.userId,admittedUser.id);
      }
    } else {
      assert.equal(row.reason,'end_not_matched_to_message');assert.equal(row.outcomes[0].admission,undefined);
      assert.equal(row.outcomes[0].terminalObservation,'not_seen');
      h.emit('agent_end',{messages:endMessages,willContinue:false});
    }
    await h.emit('session_shutdown');
    assert.deepEqual(await h.store.receipt(id),row);
    const trace=await fs.readFile(path.join(h.root,'control','bridge-trace.jsonl'),'utf8');
    assert.equal(trace.includes(h.sent[0]),false);assert.equal(trace.includes('PRIVATE_ADVISOR_TEXT'),false);
    assert.equal(trace.includes(h.file),false);assert.equal(trace.includes(admittedUser.id),false);
    if(!accepted) {
      const observation=trace.trim().split('\n').map(JSON.parse).find(r=>
        r.event==='run_correlation'&&r.phase==='agent_end'&&r.tokenRejection==='submission_marker_unconfirmed');
      assert.ok(observation);
      assert.equal(observation.eventOrder,214);assert.equal(observation.startOrder,1);
      assert.equal(observation.submissionMarkerPresent,true);assert.equal(observation.submissionMarkerMatches,true);
      assert.equal(observation.submissionUserMatches,mode==='duplicate END user');
      assert.equal(observation.submissionUserUnique,mode!=='missing END user'&&mode!=='duplicate END user');
    }
  });
}
for(const mode of ['navigation','competing input','matching extension input','disk user removed','disk user altered','legitimate pruning rewrite','legitimate title rewrite']) {
  test(`native lineage: ${mode} during final cancellation await revalidates current semantic proof`,async t=>{
    let proofReturned=false,signalHeld,releaseHeld;
    const held=new Promise(r=>{signalHeld=r;}),release=new Promise(r=>{releaseHeld=r;});
    t.after(()=>releaseHeld());
    const ended=Supervisor.prototype.ended,cancelled=Store.prototype.cancelled;
    t.mock.method(Supervisor.prototype,'ended',function(...args){
      if(!this.adapter.postProofWrapped) {
        this.adapter.postProofWrapped=true;const admitted=this.adapter.admitted;
        this.adapter.admitted=async(...values)=>{const result=await admitted(...values);proofReturned=result===true;return result;};
      }
      return ended.apply(this,args);
    });
    let target;
    t.mock.method(Store.prototype,'cancelled',async function(id){
      const result=await cancelled.call(this,id);
      if(id===target&&proofReturned){signalHeld();await release;}
      return result;
    });
    const h=await fixture(t);target=await h.enqueue();
    const reply=h.assistant(40);h.append(reply);await h.rewrite();
    h.emit('message_end',{message:reply});h.end(false);
    await held;
    if(mode==='navigation'){h.emit('session_before_tree');h.emit('session_tree');}
    else if(mode==='competing input'||mode==='matching extension input')
      h.emit('input',{source:mode==='matching extension input'?'extension':'rpc',text:h.sent[0]});
    else if(mode==='disk user removed')
      await h.rewrite([h.header,...h.entries.filter(e=>e.message?.timestamp!==100)].map(e=>JSON.stringify(e)).join('\n')+'\n');
    else if(mode==='disk user altered')
      await h.rewrite(h.content().replace(h.sent[0].replaceAll('\n','\\n'),'different persisted user'));
    else if(mode==='legitimate pruning rewrite') {
      h.oldRead.message.content[0].text='[Superseded by a newer read of this file]';await h.rewrite();
    } else if(mode==='legitimate title rewrite') {
      const title={type:'title',v:1,title:'Updated native title',updatedAt:'2026-10-28T13:00:00.000Z',pad:''};
      title.pad=' '.repeat(255-Buffer.byteLength(JSON.stringify(title)));
      await h.rewrite(JSON.stringify(title)+'\n'+h.content());
    }
    releaseHeld();
    const accepted=mode.startsWith('legitimate ');
    const row=await reach(h.store,target,accepted?'completed':'failed');
    assert.equal(row.nextStep,accepted?1:0);assert.equal(row.outcomes[0].admissionProof.kind,'native-lineage-v1');
    if(accepted)assert.equal(row.outcomes[0].admissionProof.contentDigest,crypto.createHash('sha256').update(await fs.readFile(h.file)).digest('hex'));
    assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
  });
}
for(const mode of ['file-only replacement','old off-branch same text','replicated same text','altered user','duplicate user',
  'extra off-branch user','changed historical user','changed parent','reused native ID','disk mismatch','duplicate JSON key',
  'partial JSONL','reset boundary','navigation away and back','branch event','manager replacement']) {
  test(`native lineage: ${mode} cannot authorize terminal advancement`,async t=>{
    const h=await fixture(t,'omp/1.2.3',mode),id=await h.enqueue(mode==='old off-branch same text'?'failed':'submitted'),reply=h.assistant(3);
    if(mode==='file-only replacement') {
      h.emit('agent_start');
      h.append({role:'user',timestamp:100,content:h.sent[0]});
    }
    if(mode==='altered user')h.entries.find(e=>e.message?.timestamp===100).message.content[0].text+=' altered';
    if(mode==='duplicate user')h.append({role:'user',timestamp:101,content:h.sent[0]});
    if(mode==='extra off-branch user'){const active=h.manager.getLeafId();h.append({role:'user',timestamp:101,content:'off branch'},'message',{activeLeafId:active});}
    if(mode==='changed historical user')h.entries[0].message.content='historical user altered';
    if(mode==='changed parent')h.entries[1].parentId=null;
    if(mode==='reused native ID')h.entries.find(e=>e.message?.timestamp===100).id=h.oldRead.id;
    if(mode==='reset boundary')h.append(undefined,'reset_boundary');
    if(mode==='navigation away and back'){h.emit('session_before_tree');h.emit('session_tree');}
    if(mode==='branch event'){h.emit('session_before_branch');h.emit('session_branch');}
    if(mode==='manager replacement')h.ctx.sessionManager={...h.manager};
    h.append(reply);await h.rewrite();
    if(mode==='disk mismatch')await h.rewrite(h.content().replace('phase 3','phase 4').replace('"id":"00000004"','"id":"99999999"'));
    if(mode==='duplicate JSON key')await h.rewrite(h.content().replace('"role":"user"','"role":"assistant","role":"user"'));
    if(mode==='partial JSONL')await h.rewrite(h.content().trimEnd());
    h.emit('message_end',{message:reply});h.end(false);
    const row=await reach(h.store,id,'failed');
    assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
    if(mode==='old off-branch same text') {
      assert.equal(row.reason,'end_not_matched_to_message');assert.equal(row.taskSuccess,'unverified');
      assert.equal(row.outcomes[0].admission,undefined);assert.equal(row.outcomes[0].admissionProof,undefined);
    }
  });
}
for(const action of ['manual input','cancellation','shutdown']) {
  test(`native lineage: ${action} retires ownership without advancement`,async t=>{
    const h=await fixture(t),id=await h.enqueue(),reply=h.assistant(4);h.append(reply);await h.rewrite();
    if(action==='manual input')h.emit('input',{source:'rpc',text:h.sent[0]});
    if(action==='cancellation')await h.store.abort(id);
    if(action==='shutdown')await h.emit('session_shutdown');
    else {h.emit('message_end',{message:reply});h.end(false);}
    const row=await reach(h.store,id,action==='cancellation'?'aborted':'failed');
    assert.equal(row.nextStep,0);assert.equal(row.automaticReplay,false);assert.equal(h.sent.length,1);
  });
}
test('native lineage: a subagent that starts while the task runs cannot make the task fail',async t=>{
  const h=await fixture(t),id=await h.enqueue(),reply=h.assistant(5),sub={agent:{kind:'subagent'}},prompt='A prompt that belongs to a subagent.';
  h.emit('input',{source:'extension',text:prompt},sub);
  h.emit('before_agent_start',{reason:'prompt',prompt},sub);
  h.emit('message_start',{message:{role:'user',timestamp:200,content:[{type:'text',text:prompt}]}},sub);
  h.append(reply);h.emit('message_end',{message:reply});h.end(false);
  const row=await reach(h.store,id,'completed');
  assert.equal(row.nextStep,1);assert.equal(row.outcomes[0].admission,'exact_user_record_observed');assert.equal(h.sent.length,1);
});
test('native lineage: raw replacement fence remains strict and serialized proof cannot be reused',async t=>{
  const h=await fixture(t),text='exact\ud800';
  const raw=await fence(h.file,{sessionId:h.sessionId,cwd:h.cwd},text);
  const capture=captureNativeAdmission(h.manager,{sessionId:h.sessionId,cwd:h.cwd,planId:crypto.randomUUID(),step:0},raw,text,'omp/1.2.3',1,()=>true);
  invokeNativeAdmission(capture);observeNativeAdmission(capture,'input',{source:'extension',text});
  observeNativeAdmission(capture,'before_agent_start',{reason:'prompt',prompt:text});
  const message={role:'user',timestamp:100,content:text};h.append(message);
  observeNativeAdmission(capture,'message_start',{message});observeNativeAdmission(capture,'message_end',{message});
  h.append(h.assistant(5));await h.rewrite();
  assert.equal(await reconcileAdmission(raw),false,'replacement never passes the raw API');
  let evidence;assert.equal(await reconcileNativeAdmission(capture,{onVerified:p=>{evidence=p;}}),true);
  assert.equal(evidence.kind,'native-lineage-v1');assert.equal(evidence.textLength,text.length);
  assert.equal(await reconcileNativeAdmission(capture),false,'live proof is one-use');
  assert.equal(await reconcileNativeAdmission(evidence),false,'serialized evidence is not live authority');
});
test('native lineage: cancellation during durable proof commit remains unconfirmed',async t=>{
  const h=await fixture(t),text='exact',raw=await fence(h.file,{sessionId:h.sessionId,cwd:h.cwd},text),controller=new AbortController();
  const capture=captureNativeAdmission(h.manager,{sessionId:h.sessionId,cwd:h.cwd,planId:crypto.randomUUID(),step:0},raw,text,'omp/1.2.3',1,()=>true);
  invokeNativeAdmission(capture);observeNativeAdmission(capture,'before_agent_start',{reason:'prompt',prompt:text});
  const message={role:'user',timestamp:100,content:text};h.append(message);observeNativeAdmission(capture,'message_start',{message});
  observeNativeAdmission(capture,'message_end',{message});h.append(h.assistant(6));await h.rewrite();
  assert.equal(await reconcileNativeAdmission(capture,{signal:controller.signal,onVerified:()=>controller.abort()}),false);
});
