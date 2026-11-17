import fs from 'node:fs/promises';
import path from 'node:path';
import {acquireLock,isStaleLock,plain,readJson,unlinkRetry,writeJson,same} from './control.mjs';
import {loadSetup,exists,CHECKOUT} from './setup.mjs';
import {CONTROLLER_RECORD_NOT_FILE} from './controller.mjs';
export const NAME=/^[a-z][a-z0-9-]{0,31}$/;
const NOT_EMPTY='That connections folder already holds other files, so nothing was changed. Next: choose a new or empty folder for the connections, then run the command again.';
export const CONNECTION_ERRORS=['invalid connections registry','duplicate connection name or session','unknown connection','explicit connection required','connections changed; restart the adapter','connections registration busy',NOT_EMPTY];
export const MAX_CONNECTIONS=64;
export const BAD_LANE_NAME='Lane names can only use lowercase letters, digits and hyphens, must start with a letter, and can be at most 32 characters (for example guide-trim-b-review). Next: choose a name like that and run the command again. Nothing was changed.';
// When the list is full, finished lanes are taken off it (oldest first) down to this many, then the new lane is added.
export const KEEP_CONNECTIONS=48;
// A lane that is not running is only taken off automatically after this long with no change in its files.
export const QUIET_MS=2*60*60*1000;
// A message built only from fixed words, numbers and a lane name; safe to print as it is (see diagnostic in setup.mjs).
export const say=text=>Object.assign(new Error(text),{plain:true});
const fail=message=>{throw new Error(message);};
export const identity=loaded=>({sessionId:loaded.settings.sessionId,cwd:loaded.settings.cwd,sessionFile:loaded.launch.sessionFile,executable:loaded.launch.executable});
const inside=(a,b)=>{const r=path.relative(b,a);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
// A registry contains only explicitly authorized saved bindings, never discovery.
// It grants no launch, network or recovery authority. Names are exact, not aliases.
// Writers publish connections.json by temp file + fsync + rename (writeJson), so a
// reader never sees a half-written registry from this code. During a write the
// folder also holds connections.lock or a connections.json.<id>.tmp file, or is still empty
// (just created, lock not yet taken); those are normal and readers wait briefly for them instead of calling the registry invalid.
const TMP=/^connections\.json\.[0-9a-f-]{36}\.tmp$/,BAK=/^connections\.json\.bak[1-5]$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const TRANSIENT=new Set(['EPERM','EACCES','EBUSY','ENOENT']);
const transient=e=>e instanceof SyntaxError||e?.message==='file changed'||TRANSIENT.has(e?.code);
async function readOnce(root){
 await plain(root,true);
 const names=await fs.readdir(root),busy=names.length===0||names.some(n=>n==='connections.lock'||TMP.test(n));
 if(names.some(n=>n!=='connections.json'&&n!=='connections.lock'&&!TMP.test(n)&&!BAK.test(n)))fail('invalid connections registry');
 if(!names.includes('connections.json')){if(busy)return {busy};fail('invalid connections registry');}
 try{return {value:await readJson(path.join(root,'connections.json'))};}
 catch(e){if(!transient(e))throw e;return {busy};}
}
export async function readConnections(root,{tries=40,delayMs=50}={}){
 let value;
 for(let attempt=1;;attempt++){
  const got=await readOnce(root);
  if(got.value!==undefined){value=got.value;break;}
  if(attempt>=tries)fail(got.busy?'connections registration busy':'invalid connections registry');
  await sleep(delayMs);
 }
 if(!value||value.version!==1||Object.keys(value).sort().join()!=='connections,version'||!Array.isArray(value.connections)||!value.connections.length||value.connections.length>MAX_CONNECTIONS)fail('invalid connections registry');
 const names=new Set(),sessions=new Set(),roots=[];
 for(const row of value.connections){
  if(!row||Object.keys(row).sort().join()!=='binding,name,root'||typeof row.name!=='string'||!NAME.test(row.name)||typeof row.root!=='string'||!path.isAbsolute(row.root)||row.root!==path.resolve(row.root)||!row.binding||Object.keys(row.binding).sort().join()!=='cwd,executable,sessionFile,sessionId')fail('invalid connections registry');
  if(names.has(row.name)||sessions.has(row.binding.sessionId)||roots.some(r=>same(r,row.root)))fail('duplicate connection name or session');
  names.add(row.name);sessions.add(row.binding.sessionId);roots.push(row.root);
 }
 return value;
}
export async function loadConnection(row,now=Date.now){
 const loaded=await loadSetup(row.root,now);
 if(JSON.stringify(identity(loaded))!==JSON.stringify(row.binding))fail('connections changed; restart the adapter');
 return loaded;
}
// One connection whose saved OMP session was deleted or changed must not break the others. It is named, never loaded.
export const unavailableText=name=>`The connection ${name} cannot be used because its saved OMP session was deleted or changed. The other connections work normally. Next: run pots status, then pots install to remove it; your saved sessions are not touched.`;
export async function loadConnections(registry,now=Date.now){
 const rows=[],unavailable=[];
 for(const row of registry.connections){try{rows.push({name:row.name,loaded:await loadConnection(row,now)});}catch(e){const plainProblem=e?.message===CONTROLLER_RECORD_NOT_FILE;unavailable.push({name:row.name,problem:plainProblem?e.message:unavailableText(row.name),...(plainProblem?{kept:true}:{})});}}
 return {rows,unavailable};
}
async function acquire(lock,tries=100,delayMs=50){
 for(let attempt=1;;attempt++){
  try{return await acquireLock(lock);}
  catch(e){if(e.code!=='EEXIST'&&!TRANSIENT.has(e.code))throw e;if(attempt>=tries)fail('connections registration busy');}
  await sleep(delayMs);
 }
}
// A lane is running while its supervisor lock names a live process. Anything that cannot be read counts as running,
// so a lane is never taken off the list on a guess. `newest` is the last time any of its files changed.
async function laneState(row,now){
 let newest=0;
 const touch=async file=>{try{newest=Math.max(newest,(await fs.lstat(file)).mtimeMs);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
 try{
  const lock=path.join(row.root,`supervisor-${row.binding.sessionId}.lock`);
  if(await touch(lock)&&!await isStaleLock(lock))return {running:true};
  for(const name of ['config.json','control/lane-events.jsonl','plans','receipts'])await touch(path.join(row.root,name));
  return {running:false,newest,quiet:now-newest>=QUIET_MS};
 }catch{return {running:true};}
}
// Names of finished lanes to take off, oldest first, down to KEEP_CONNECTIONS. Fails plainly when none may be taken off.
async function finishedLanes(rows){
 const now=Date.now(),free=[];let running=0,recent=0;
 for(const row of rows){const s=await laneState(row,now);if(s.running)running++;else if(s.quiet)free.push({name:row.name,newest:s.newest});else recent++;}
 if(!free.length)throw say(`Pi on the Side can hold ${MAX_CONNECTIONS} lanes and all of them are in use. ${running} ${running===1?'is':'are'} running now and ${recent} stopped less than 2 hours ago, so none could be taken off the list automatically. Nothing was removed. To free a place, close a lane you no longer need: pots lane close <lane-name> (pots lane list shows the lane names; pots lane close --finished takes every finished lane off at once).`);
 return free.sort((a,b)=>a.newest-b.newest).slice(0,Math.max(1,rows.length-KEEP_CONNECTIONS)).map(x=>x.name);
}
async function locked(root,run){
 const lock=path.join(root,'connections.lock'),handle=await acquire(lock);
 try{return await run();}finally{await handle.close();await unlinkRetry(lock);}
}
// Before rows are removed the old file is kept as connections.json.bak1 (the last 5 are kept as .bak1 to .bak5).
async function backup(file){
 for(let i=5;i>1;i--)await fs.rename(`${file}.bak${i-1}`,`${file}.bak${i}`).catch(e=>{if(e.code!=='ENOENT')throw e;});
 await fs.copyFile(file,`${file}.bak1`);
}
// Writes the new list, reads it back with the normal reader and puts the old list back if that fails.
async function publish(root,old,next,write,removing){
 const file=path.join(root,'connections.json');
 if(removing)await backup(file);
 try{
  await write(file,next);
  if(JSON.stringify(await readConnections(root,{tries:1}))!==JSON.stringify(next))fail('invalid connections registry');
 }catch{
  try{if(old)await writeJson(file,old);else await fs.unlink(file).catch(()=>{});}
  catch{throw say('The lane list could not be saved safely, and the old list could not be put back automatically. A copy of the old list is in connections.json.bak1 in the connections folder; copy it over connections.json.');}
  throw say('The lane list could not be saved safely, so Pi on the Side put the old list back. No lane or saved session was changed. Try again; if it keeps happening, send this message to support.');
 }
}
export async function registerConnection(rootArg,name,stateArg,{write=writeJson}={}){
 if(typeof name!=='string'||!NAME.test(name))throw say(BAD_LANE_NAME);
 const root=path.resolve(rootArg),state=path.resolve(stateArg),loaded=await loadSetup(state,Date.now);
 if(inside(root,CHECKOUT)||inside(root,loaded.settings.cwd)||inside(root,state))fail('invalid connections registry');
 if(!await exists(root)){await plain(path.dirname(root),true);try{await fs.mkdir(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
 await plain(root,true);
 // The exclusive local writer lock prevents lost registrations; a second writer
 // waits for it (never steals it). All reads and the one write happen under it.
 const file=path.join(root,'connections.json');
 return locked(root,async()=>{
  let old;
  if(await exists(file))old=await readConnections(root,{tries:1});
  else if((await fs.readdir(root)).some(n=>n!=='connections.lock'&&!TMP.test(n)&&!BAK.test(n)))fail(NOT_EMPTY);
  const value=old??{version:1,connections:[]};
  if(value.connections.some(row=>row.name===name||row.binding.sessionId===loaded.settings.sessionId||same(row.root,state)))fail('duplicate connection name or session');
  // Full: finished lanes lose their row here (only the row; sessions and state folders are never touched).
  const retired=value.connections.length>=MAX_CONNECTIONS?await finishedLanes(value.connections):[];
  const next={version:1,connections:[...value.connections.filter(row=>!retired.includes(row.name)),{name,root:state,binding:identity(loaded)}].sort((a,b)=>a.name.localeCompare(b.name))};
  await publish(root,old,next,write,retired.length>0);
  return {registered:name,connections:next.connections.map(row=>row.name),...(retired.length?{retiredFinishedLanes:retired,retiredNote:'The list was full, so these finished lanes were taken off it. Their saved sessions and state folders were not touched. Bring one back with: pots lane restore <lane-name>'}:{}),adapterFolder:root,note:'Restart the adapter after registration. No OMP session was launched.'};
 });
}
// Takes one lane off the list. Only its row goes; its saved session, state folder and results stay.
export async function closeConnection(rootArg,name,{write=writeJson}={}){
 const root=path.resolve(rootArg);
 await plain(root,true);
 return locked(root,async()=>{
  const old=await readConnections(root,{tries:1}),row=old.connections.find(r=>r.name===name);
  if(!row)throw say('There is no lane with that name on the list. Next: run pots lane list to see the lane names. Nothing was changed.');
  if(old.connections.length===1)throw say('That is the only lane on the list, and the list cannot be empty, so it was not closed. Nothing was changed.');
  if((await laneState(row,Date.now())).running)throw say(`Lane ${name} is running, so it was not closed. Next: close its OMP window, then run this command again. Nothing was changed.`);
  const next={version:1,connections:old.connections.filter(r=>r!==row)};
  await publish(root,old,next,write,true);
  // `pots lane restore` finds a lane again only through the launcher record Setup saved, so only promise it when that record exists.
  const again=await savedLaneState(root,name)?` Bring it back with: pots lane restore ${name}`:'';
  return {closed:name,connections:next.connections.map(r=>r.name),note:`Lane ${name} is off the list. Only its entry was removed: its saved session, its folder and its results were not touched.${again}`};
 });
}
// Lanes that were taken off the list: the last lists, kept as connections.json.bak1 to .bak5, still name their state folders.
// A lane started by a script has no launcher record, so this is how `pots lane restore` finds it again.
async function removedLanes(rootArg){
 const root=path.resolve(rootArg),found=new Map();
 for(let i=1;i<=5;i++){
  try{for(const row of (await readJson(path.join(root,`connections.json.bak${i}`))).connections??[])if(typeof row?.name==='string'&&NAME.test(row.name)&&typeof row.root==='string'&&!found.has(row.name))found.set(row.name,row.root);}catch{/* a missing or unreadable copy names nothing */}
 }
 return found;
}
// The state folder Setup saved for a lane in its launcher (next to the connections folder), else the one a kept copy of the list names, or undefined.
export async function savedLaneState(rootArg,name){
 if(typeof name!=='string'||!NAME.test(name))return undefined;
 try{const state=(await readJson(path.join(path.dirname(path.resolve(rootArg)),'launchers',name,'launch-settings.json'))).state;if(typeof state==='string')return state;}catch{/* no launcher record: look in the kept lists */}
 return (await removedLanes(rootArg)).get(name);
}
// Every lane on the list with what it is doing, and the lanes that are off the list but can be brought back.
export async function laneOverview(rootArg){
 const root=path.resolve(rootArg),now=Date.now(),registry=await readConnections(root,{tries:1}),lanes=[];
 for(const row of registry.connections){const s=await laneState(row,now);lanes.push({name:row.name,state:s.running?'running':s.quiet?'finished':'stopped less than 2 hours ago'});}
 const listed=new Set(registry.connections.map(row=>row.name));
 return {lanes,offTheList:[...(await removedLanes(root)).keys()].filter(name=>!listed.has(name)).sort()};
}
// Takes every finished lane off the list in one step. The list cannot be empty, so the most recently used finished lane stays when all are finished.
export async function closeFinishedConnections(rootArg,{write=writeJson}={}){
 const root=path.resolve(rootArg);
 await plain(root,true);
 return locked(root,async()=>{
  const old=await readConnections(root,{tries:1}),now=Date.now(),done=[];
  for(const row of old.connections){const s=await laneState(row,now);if(!s.running&&s.quiet)done.push({name:row.name,newest:s.newest});}
  done.sort((a,b)=>a.newest-b.newest);
  if(done.length===old.connections.length)done.pop();
  if(!done.length)throw say('No lane could be taken off the list: a lane counts as finished when OMP is not running for it and it has been quiet for 2 hours, and one lane always stays on the list. Nothing was changed.');
  const gone=new Set(done.map(item=>item.name)),next={version:1,connections:old.connections.filter(row=>!gone.has(row.name))};
  await publish(root,old,next,write,true);
  return {closed:[...gone],connections:next.connections.map(row=>row.name),note:`${gone.size} finished lane${gone.size===1?' is':'s are'} off the list: ${[...gone].join(', ')}. Only their entries were removed: saved sessions, folders and results were not touched. Bring one back with: pots lane restore <lane-name>`};
 });
}
// Removes only the registry rows that can no longer be read, never any saved session or project file. Returns their names.
export async function dropUnavailableConnections(rootArg){
 const root=path.resolve(rootArg),file=path.join(root,'connections.json');
 if(!await exists(file))return [];
 return locked(root,async()=>{
  const value=await readConnections(root,{tries:1}),keep=[],dropped=[];
  // One passing error (a scanner, or OMP writing the file just then) must not drop a working row: look twice before dropping.
  // A row whose controller file is a folder or link is kept: that is a plain, fixable problem, not a deleted session.
  const check=row=>loadConnection(row).then(()=>true,e=>e?.message===CONTROLLER_RECORD_NOT_FILE);
  for(const row of value.connections){let ok=await check(row);if(!ok){await sleep(100);ok=await check(row);}if(ok)keep.push(row);else dropped.push(row.name);}
  if(dropped.length){if(keep.length)await publish(root,value,{...value,connections:keep},writeJson,true);else{await backup(file);await fs.unlink(file);}}
  return dropped;
 });
}
