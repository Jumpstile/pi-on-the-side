import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {main}from'../src/cli.mjs';import {createServer}from'../src/mcp.mjs';import{registerConnection,dropUnavailableConnections,readConnections}from'../src/connections.mjs';
import {createCredential,acquireController} from '../src/controller.mjs';import {Store,readJson} from '../src/control.mjs';
test('named connections route explicit targets, reject missing/unknown targets, duplicate names and changed binding',async t=>{
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bridge-named-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));const roots=[];
 for(let i=0;i<2;i++){const cwd=path.join(base,'project'+i);await fs.mkdir(cwd);const session=path.join(base,'session'+i+'.jsonl');await fs.writeFile(session,JSON.stringify({type:'session',version:3,id:crypto.randomUUID(),cwd})+'\n');const root=path.join(base,'state'+i);assert.equal(await main(['setup',session,root],{stdout:()=>{},stderr:()=>{},locate:async()=>process.execPath,detect:async()=>'omp/18.7.0'}),0);roots.push(root);}
 const hub=path.join(base,'connections');await registerConnection(hub,'alpha',roots[0]);await registerConnection(hub,'beta',roots[1]);await assert.rejects(registerConnection(hub,'alpha',roots[1]));await assert.rejects(registerConnection(hub,'third',roots[0]));
 const controllerFile=path.join(base,'controller.json');await createCredential(controllerFile);for(const root of roots)await acquireController(new Store(await readJson(path.join(root,'config.json'))),controllerFile);
 const server=createServer({stateRoot:hub,controllerFile});let seq=0;const rpc=(method,params)=>server.handle(JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}));await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});await server.handle(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}));const call=(name,args)=>rpc('tools/call',{name,arguments:args});const body=r=>JSON.parse(r.result.content[0].text);
 const tools=(await rpc('tools/list',{})).result.tools;assert.deepEqual(tools.find(x=>x.name==='bridge_enqueue').inputSchema.properties.connection.enum,['alpha','beta']);assert.ok(tools.find(x=>x.name==='bridge_enqueue').inputSchema.required.includes('connection'));assert.deepEqual(Object.keys(tools.find(x=>x.name==='bridge_lanes_status').inputSchema.properties),[]);assert.equal(tools.find(x=>x.name==='bridge_lanes_status').inputSchema.required,undefined);
 const status=body(await call('bridge_status',{}));assert.deepEqual(status.connections.map(x=>x.name),['alpha','beta']);const lanes=body(await call('bridge_lanes_status',{}));assert.deepEqual(lanes.lanes.map(x=>x.connection),['alpha','beta']);assert.equal(lanes.anyRunning,false);assert.equal(lanes.nextWakeUpSeconds,null);const id=crypto.randomUUID();const args={id,prompt:'synthetic',connection:'alpha'};assert.equal(body(await call('bridge_enqueue',args)).state,'queued');assert.equal(body(await call('bridge_enqueue',args)).duplicate,true);assert.equal((await fs.readdir(path.join(roots[0],'plans'))).length,1);assert.equal((await fs.readdir(path.join(roots[1],'plans'))).length,0);
 for(const invalid of [{id,prompt:'synthetic'},{...args,connection:'missing'}]){const r=await call('bridge_enqueue',invalid);assert.ok(r.error||r.result.isError);}
 assert.equal(body(await call('bridge_enqueue',{...args,connection:'beta'})).state,'queued');
 assert.equal(body(await call('bridge_cancel',{id,connection:'alpha'})).cancelRequested,true);
 assert.equal(body(await call('bridge_receipt',{id,connection:'beta'})).cancelRequested,false);assert.equal((await fs.readdir(path.join(roots[1],'control'))).length,0);
 const missingHeartbeat = await call('bridge_coordinator_heartbeat', {});
 assert.equal(body(missingHeartbeat).error, 'explicit connection required');
 assert.equal(body(await call('bridge_coordinator_heartbeat', { connection: 'alpha' })).active, true);
 assert.equal(JSON.parse(await fs.readFile(path.join(roots[0], 'control', 'coordinator-active.json'))).version, 1);
 await assert.rejects(fs.stat(path.join(roots[1], 'control', 'coordinator-active.json')), { code: 'ENOENT' });
 const cfg=path.join(roots[0],'config.json');const original=await fs.readFile(cfg);const changed=JSON.parse(original);changed.sessionId=crypto.randomUUID();await fs.writeFile(cfg,JSON.stringify(changed));assert.equal((await call('bridge_enqueue',args)).result.isError,true);await fs.writeFile(cfg,original);
 const file=path.join(hub,'connections.json'),registry=JSON.parse(await fs.readFile(file));registry.connections.shift();await fs.writeFile(file,JSON.stringify(registry));assert.equal(body(await call('bridge_cancel',{id,connection:'alpha'})).error,'unknown connection','a connection removed from the registry is gone at once, without a restart');
 assert.deepEqual((await rpc('tools/list',{})).result.tools.find(tool=>tool.name==='bridge_enqueue').inputSchema.properties.connection.enum,['beta'],'the connection list is read fresh, so a removed connection disappears without a restart');
});

test('a connection that is unreadable for a moment is kept, one that is really gone is removed from the list', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-drop-'))); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = [], hub = path.join(base, 'connections');
  for (const name of ['alpha', 'beta']) {
    const cwd = path.join(base, 'project-' + name), session = path.join(base, name + '.jsonl'), root = path.join(base, 'state-' + name);
    await fs.mkdir(cwd); await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
    assert.equal(await main(['setup', session, root], { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' }), 0);
    await registerConnection(hub, name, root); roots.push(root);
  }
  // The first look at alpha fails (its folder is out of sight for a moment); the second one succeeds.
  const hidden = roots[0] + '.away'; await fs.rename(roots[0], hidden);
  setTimeout(() => fs.rename(hidden, roots[0]), 40);
  assert.deepEqual(await dropUnavailableConnections(hub), []);
  assert.deepEqual((await readConnections(hub)).connections.map(row => row.name), ['alpha', 'beta']);
  // A folder that stays gone is dropped; the other connection stays.
  await fs.rm(roots[1], { recursive: true });
  assert.deepEqual(await dropUnavailableConnections(hub), ['beta']);
  assert.deepEqual((await readConnections(hub)).connections.map(row => row.name), ['alpha']);
});

test('connecting into a folder that already holds another file is refused in plain words and leaves everything as it was', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-notempty-'))); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'), session = path.join(base, 'saved.jsonl'), root = path.join(base, 'state'), hub = path.join(base, 'connections');
  await fs.mkdir(cwd); await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
  assert.equal(await main(['setup', session, root], { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' }), 0);
  await fs.mkdir(hub); await fs.writeFile(path.join(hub, 'notes.txt'), 'mine');
  await assert.rejects(registerConnection(hub, 'alpha', root), /already holds other files, so nothing was changed/);
  assert.deepEqual(await fs.readdir(hub), ['notes.txt']);
  assert.equal(await fs.readFile(path.join(hub, 'notes.txt'), 'utf8'), 'mine');
});

test('a lane whose controller lock is a folder is explained in plain words by every tool, and the listing carries only name and problem', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-folder-'))); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'), session = path.join(base, 'saved.jsonl'), root = path.join(base, 'state'), hub = path.join(base, 'connections');
  await fs.mkdir(cwd); await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
  assert.equal(await main(['setup', session, root], { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' }), 0);
  await registerConnection(hub, 'alpha', root);
  await fs.mkdir(path.join(root, `controller-${(await readJson(path.join(root, 'config.json'))).sessionId}.lock`));
  const server = createServer({ stateRoot: hub, controllerFile: path.join(base, 'controller.json') });
  let seq = 0; const rpc = (method, params) => server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const body = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  const plainText = /^A controller file in the session's state folder .*is a folder or a link.*move it away/;
  assert.match((await body('bridge_status', { connection: 'alpha' })).error, plainText);
  for (const tool of ['bridge_lanes_status', 'bridge_lane_watch_lines']) {
    const { unavailable } = await body(tool, {});
    assert.deepEqual(Object.keys(unavailable[0]), ['name', 'problem']);
    assert.match(unavailable[0].problem, plainText);
  }
});
