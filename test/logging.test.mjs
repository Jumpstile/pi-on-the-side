import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {LocalTrace,initialize,Store,Supervisor} from '../src/control.mjs';
async function fixture(t){const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bridge-trace-'))),root=path.join(base,'state');await initialize(root);t.after(()=>fs.rm(base,{recursive:true,force:true}));return {base,root};}
test('trace redaction, rate limits, small rotating disk cap and private permissions',async t=>{const {root}=await fixture(t),trace=new LocalTrace(root,1024);trace.record('heartbeat',{idle:true,prompt:'SECRET',path:'C:/private',credential:'SECRET',code:'TOKEN_SECRET'});for(let i=0;i<20;i++)trace.record('heartbeat',{idle:true});await trace.flush();for(let i=0;i<70;i++){trace.record('dispatch_returned',{step:i%8,state:'submitted',prompt:'SECRET'});await trace.flush();}const files=(await fs.readdir(path.join(root,'control'))).filter(n=>n.startsWith('bridge-trace'));assert.equal(files.length,3);let bytes=0;for(const name of files){const file=path.join(root,'control',name),stat=await fs.stat(file);assert.ok(stat.size<=1024);bytes+=stat.size;if(process.platform!=='win32')assert.equal(stat.mode&0o077,0);const text=await fs.readFile(file,'utf8');assert.equal(/SECRET|private|credential|prompt/.test(text),false);for(const row of text.trim().split('\n').map(JSON.parse))assert.ok(['dispatch_returned','heartbeat'].includes(row.event));}assert.ok(bytes<=3072);});
test('traces record reservation, dispatch and terminal paths without changing receipts',async t=>{const {root,base}=await fixture(t),sessionId=crypto.randomUUID(),trace=new LocalTrace(root),store=new Store({root,cwd:base,sessionId});const supervisor=new Supervisor(store,{isIdle:()=>true,fence:async()=>true,admitted:async()=>true,send:()=>{},trace:(event,fields)=>trace.record(event,fields)});await supervisor.open();const id=crypto.randomUUID();await store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,steps:[{prompt:'PRIVATE_TASK_TEXT',continueAfterEnd:false}]});await supervisor.tick();await supervisor.started(1, {owner:supervisor.active,sessionId,planId:id,step:supervisor.active.row.nextStep});await supervisor.ended(1,false,{sessionId,planId:id,step:0});await supervisor.close();await trace.flush();const text=await fs.readFile(trace.file,'utf8'),events=text.trim().split('\n').map(JSON.parse).map(x=>x.event);for(const event of ['supervisor_open','reserved','dispatch_call','dispatch_returned','task_terminal','supervisor_close'])assert.ok(events.includes(event),event);assert.equal(text.includes('PRIVATE_TASK_TEXT'),false);assert.equal(text.includes(id),false);assert.equal((await store.receipt(id)).state,'completed');});
test('trace persistence failures never stop supervisor; a failed plan holds the queue for the settle time',async t=>{const {root,base}=await fixture(t),sessionId=crypto.randomUUID(),trace=new LocalTrace(root);await fs.mkdir(trace.file);const store=new Store({root,cwd:base,sessionId}),sent=[],supervisor=new Supervisor(store,{isIdle:()=>true,fence:async()=>true,send:text=>sent.push(text),admitted:async()=>false,trace:(event,fields)=>trace.record(event,fields)});await supervisor.open();const id=crypto.randomUUID();await store.enqueue({version:1,id,sessionId,expiresAt:Date.now()+60000,steps:[{prompt:'synthetic',continueAfterEnd:false}]});await supervisor.tick();await supervisor.started(1, {owner:supervisor.active,sessionId,planId:id,step:supervisor.active.row.nextStep});await supervisor.ended(1,false,{sessionId,planId:id,step:0});await supervisor.tick();assert.equal(sent.length,1);assert.equal(supervisor.closed,false);assert.equal((await store.receipt(id)).state,'failed');await supervisor.close();await trace.flush();});
test('preexisting unsanitized traces are refused and backlog stays bounded',async t=>{const {root}=await fixture(t),trace=new LocalTrace(root);await fs.writeFile(trace.file,'SECRET OLD CONTENT');for(let i=0;i<100;i++)trace.record('error',{code:'private-token'});assert.ok(trace.queue.length<=32);await trace.flush();assert.equal(await fs.readFile(trace.file,'utf8'),'SECRET OLD CONTENT');assert.ok(trace.dropped>0);});
test('admission failure traces are bounded, rate-limited and content-free',async t=>{
  const {root}=await fixture(t),trace=new LocalTrace(root);
  trace.record('admission_failure',{failure:'user_text_mismatch',identityMatches:true,fenceMatches:true,textMatches:false,
    processedBytes:99999999,userCount:1,prompt:'PRIVATE_TRANSCRIPT_CONTENT',path:'C:/private/credential'});
  trace.record('admission_failure',{failure:'admission_aborted',path:'C:/private/credential'});
  await trace.flush();
  const content=await fs.readFile(trace.file,'utf8'),rows=content.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['version','time','pid','event','failure','identityMatches','fenceMatches','textMatches','processedBytes','userCount'].sort());
  assert.equal(rows[0].failure,'user_text_mismatch');
  assert.equal(rows[0].processedBytes,99999999);
  assert.equal(rows[0].userCount,1);
  assert.equal(content.includes('PRIVATE_TRANSCRIPT_CONTENT'),false);
  assert.equal(content.includes('C:/private/credential'),false);
});
test('run-correlation trace keeps event lineage while excluding native IDs and message data', async t => {
  const {root}=await fixture(t), trace=new LocalTrace(root);
  trace.record('run_correlation',{phase:'agent_end',runEpoch:7,eventOrder:9,startOrder:1,runPresent:true,tokenPresent:true,
    tokenMatches:true,messageEndObserved:false,messageKeyAvailable:true,messageKeyMatches:false,nativeIdCompared:true,
    nativeIdMatches:false,assistantStop:true,continuation:'false',tokenRejection:'native_identifier_mismatch',
    lineage:'unavailable',responseId:'PRIVATE_RESPONSE_ID',prompt:'PRIVATE_PROMPT',path:'C:/private/state'});
  await trace.flush();
  const content=await fs.readFile(trace.file,'utf8'),row=JSON.parse(content);
  assert.equal(row.event,'run_correlation'); assert.equal(row.nativeIdMatches,false); assert.equal(row.eventOrder,9);
  assert.equal(content.includes('PRIVATE_RESPONSE_ID'),false); assert.equal(content.includes('PRIVATE_PROMPT'),false);
  assert.equal(content.includes('C:/private/state'),false);
  assert.deepEqual(Object.keys(row).sort(),
    ['version','time','pid','event','phase','runEpoch','eventOrder','startOrder','runPresent','tokenPresent','tokenMatches',
      'messageEndObserved','messageKeyAvailable','messageKeyMatches','nativeIdCompared','nativeIdMatches','assistantStop',
      'continuation','tokenRejection','lineage'].sort());
});
test('submission conflict diagnostics retain only bounded categories across trace reopen', async t => {
  const {root}=await fixture(t), trace=new LocalTrace(root);
  const categories=['submission_target_mismatch','submission_marker_unconfirmed','conflicting_claimed_submission',
    'no_submitted_target','claimed_submission','prior_submission'];
  for (let i=0;i<categories.length;i++) {
    trace.record('run_correlation',{phase:'agent_end',tokenRejection:categories[i],
      lineage:i%2 ? 'claimed_submission' : 'prior_submission',responseId:'PRIVATE_ID',text:'PRIVATE_TEXT'});
  }
  trace.record('run_correlation',{tokenRejection:'PRIVATE_REJECTION',lineage:'PRIVATE_LINEAGE'});
  await trace.flush();
  const reopened=new LocalTrace(root);
  reopened.record('run_correlation',{tokenRejection:'no_submitted_target',lineage:'prior_submission'});
  await reopened.flush();
  const text=await fs.readFile(trace.file,'utf8'), rows=text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(0,6).map(row=>row.tokenRejection),categories);
  assert.deepEqual(rows.slice(0,6).map(row=>row.lineage),
    ['prior_submission','claimed_submission','prior_submission','claimed_submission','prior_submission','claimed_submission']);
  assert.equal(rows[6].tokenRejection,undefined); assert.equal(rows[6].lineage,undefined);
  assert.equal(rows[7].tokenRejection,'no_submitted_target');
  assert.equal(text.includes('PRIVATE_'),false);
});
test('submission ownership diagnostics reject transcript-valued operands and retain only booleans',async t=>{
  const {root}=await fixture(t),trace=new LocalTrace(root);
  const operands={submissionMarkerPresent:true,submissionMarkerMatches:true,
    submissionUserMatches:false,submissionUserUnique:false};
  trace.record('run_correlation',{phase:'agent_end',tokenRejection:'submission_marker_unconfirmed',...operands,
    expectedText:'PRIVATE_SUBMITTED_TEXT',actualText:'PRIVATE_NATIVE_USER',marker:'PRIVATE_MARKER'});
  trace.record('run_correlation',{phase:'agent_end',tokenRejection:'submission_marker_unconfirmed',
    ...Object.fromEntries(Object.keys(operands).map(key=>[key,'PRIVATE_TRANSCRIPT_VALUE']))});
  await trace.flush();
  const text=await fs.readFile(trace.file,'utf8'),rows=text.trim().split('\n').map(JSON.parse);
  for(const [key,value]of Object.entries(operands)) {
    assert.equal(rows[0][key],value);
    assert.equal(Object.hasOwn(rows[1],key),false);
  }
  assert.equal(text.includes('PRIVATE_'),false);
});

test('terminal signal reasons are bounded and sanitized across trace reopen', async t => {
  const {root}=await fixture(t), trace=new LocalTrace(root);
  const reasons=['non_boolean_field'];
  for (const terminalSignalReason of reasons)
    trace.record('run_correlation',{phase:'agent_end',continuation:'unreadable',terminalSignalReason,
      text:'PRIVATE_TASK_TEXT',host:'PRIVATE_HOST',willContinue:'PRIVATE_FIELD'});
  trace.record('run_correlation',{terminalSignalReason:'PRIVATE_REASON'});
  await trace.flush();
  const reopened=new LocalTrace(root);
  reopened.record('run_correlation',{phase:'agent_end',terminalSignalReason:'non_boolean_field'});
  await reopened.flush();
  const text=await fs.readFile(trace.file,'utf8'), rows=text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(0,1).map(row=>row.terminalSignalReason),reasons);
  assert.equal(Object.hasOwn(rows[1],'terminalSignalReason'),false);
  assert.equal(rows[2].terminalSignalReason,'non_boolean_field');
  assert.equal(text.includes('PRIVATE_'),false);
});
