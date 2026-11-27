import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {claudeLocations,windowsTasks,MAX_BYTES} from './clients.mjs';
import {isKeptLock,isStaleLock,same,writeJson} from './control.mjs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Standalone by design: Installed apps and the CLI call this same routine.
// Its private ownership record never authorizes deleting referenced projects,
// OMP/Node, host configuration, or an unrecorded filesystem neighbour.
const DAMAGED='The uninstall list in the install folder is damaged (the PC may have lost power while it was saved). Next: run pots install to repair it, then run pots uninstall again.';
const BROKEN_RUNTIME='A program folder inside the install folder (under runtime) is damaged: its files are missing, so Pi on the Side cannot tell what is safe to remove. Next: move that folder out of the install folder yourself (it is the one with the missing files), then run the same command again.';
export const REVIEW='private permissions require local review';
// The plain words for REVIEW, shown by `pots install` and `pots uninstall` (`command` is the one the person ran).
export const reviewText=command=>`${command} stopped because a file or folder in the install folder is not private to you, or it is a link, and it does not follow links. Next: if you made a link inside the install folder, delete the link itself (not the folder it points to), then run ${command} again. If you did not, send the Details to support.\nDetails: ${REVIEW}`;
export const UNINSTALL_ERRORS=["uninstall refused: linked or foreign path","uninstall refused: invalid installation root","uninstall refused: oversized ownership record","uninstall refused: inventory limit","private permission setup failed",REVIEW,"private recovery verification failed; moved files retained for local recovery","uninstall refused: host entry remains","uninstall refused: native host removal failed","uninstall refused: installation ownership missing","uninstall refused: host registration ownership unavailable","uninstall refused: foreign registry entry","uninstall refused: unverified install file","uninstall registration failed; setup retained, rerun setup to repair","uninstall refused: invalid release ownership",BROKEN_RUNTIME,"uninstall requires Windows","uninstall refused: process ownership unavailable","uninstall refused: unverified recovery archive",DAMAGED,"uninstall usage: <installation-root> [--all] [--confirm-offline] [--purge --confirm-purge]"];
const MARKER={version:1,type:'omp-session-bridge-local'};
const ICON='pots.ico', RECORD='uninstall-record.json', RECORD_MAX=1048576, HELPER='uninstall.mjs', HELPER_FILES=[HELPER,'clients.mjs','control.mjs',ICON];
// This build's own bytes for an installed helper file; the icon ships in assets/ and may be absent (then null, and the entry has no icon).
const helperBytes=async name=>{const here=path.dirname(fileURLToPath(import.meta.url));try{return await fs.readFile(name===ICON?path.join(here,'..','assets',ICON):path.join(here,name));}catch(e){if(name===ICON&&e.code==='ENOENT')return null;throw e;}};
// A helper copy whose bytes equal this build's own file is one Setup could have written (an earlier run that failed after copying it).
const ownHelper=async name=>{const bytes=await helperBytes(name);return bytes&&hash(bytes);};
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Everything the product writes that is not software. A cut-off write leaves `<name>.<uuid>.tmp`, and a cut-off watchdog start leaves its lock as `watchdog.lock.new-<uuid>` or `.dead-<uuid>`.
const lockFolder=`watchdog\\.lock(\\.(new|dead)-${uuid})?`,lockPattern=new RegExp(`^coordinator-resume/control/${lockFolder}$`);
// Written with temp + rename (writeJson): a cut-off write leaves `<name>.<uuid>.tmp`.
const tmp=`\\.${uuid}\\.tmp`;
// Appended to, renamed or written in place: never a temp name.
const plainData=`pots\\.log(\\.1)?|connections/connections\\.json\\.bak[1-5]|coordinator-resume/handoff\\.md|coordinator-resume/control/(${lockFolder}/owner\\.json|disabled|wakeups-off|wakeups-on|launches\\.jsonl(\\.1|\\.tmp)?)|backups/\\d{8}T\\d{6}Z(-[0-9a-f]{6})?/[A-Za-z0-9][A-Za-z0-9._-]*|sessions/${uuid}/control/(bridge-trace\\.jsonl(\\.[12])?|lane-events\\.jsonl(\\.1)?|lane-watch\\.log(\\.1)?)`;
const jsonData=`coordinator-resume/control/state\\.json|credentials/controller\\.json|connections/connections\\.json|sessions/${uuid}/(config\\.json|launch\\.json|controller-${uuid}\\.json|(plans|receipts)/${uuid}\\.json|control/(${uuid}(\\.review)?\\.json|coordinator-active\\.json|dispatch-diagnostic\\.json|command-${uuid}(\\.receipt)?\\.json|lane-watch(-state|-cursor)?\\.json))`;
// Staging folders of an interrupted update hold copies of release files only.
const stagedFile=`(release\\.json|NOTICE\\.md|SECURITY\\.md|package\\.json|assets/pots\\.ico|(bin|src)/[A-Za-z0-9][A-Za-z0-9._-]*\\.mjs|extension/[A-Za-z0-9][A-Za-z0-9._-]*\\.(mjs|ts))`;
const dataPattern=new RegExp(`^(${plainData}|(${jsonData})(${tmp})?|(coordinator-resume/(config\\.json|resume-prompt\\.txt|claude-cloud-task\\.txt|chatgpt-cloud-task\\.txt|Disable-Resume\\.cmd|Run-Resume\\.vbs|ownership\\.json)|local-setup\\.json|uninstall-record\\.json|runtime/(managed-[0-9a-f-]+|current)/current\\.json|launchers/[a-z][a-z0-9-]{0,63}/launch-settings\\.json)${tmp}|launchers/[a-z][a-z0-9-]{0,63}/(Start-OMP\\.ps1|launch-settings\\.json)\\.[0-9a-f]{8}\\.tmp|runtime/(managed-[0-9a-f-]+|current)/staging/${uuid}/${stagedFile})$`);
const emptyDirs=new RegExp(`^(credentials|connections|launchers|launchers/[a-z][a-z0-9-]{0,63}|backups|backups/\\d{8}T\\d{6}Z(-[0-9a-f]{6})?|runtime|runtime/(managed-[0-9a-f-]+|current)(/(versions|staging(/${uuid}(/[A-Za-z0-9._/-]+)?)?))?|coordinator-resume|coordinator-resume/control(/disabled)?|coordinator-instructions|sessions|sessions/[0-9a-f-]+(/(plans|receipts|control))?)$`);
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
export const installationId=root=>'PiOnTheSide-'+hash(path.resolve(root).toLowerCase()).slice(0,24);
// The scheduled task that keeps the wake-up watchdog running. Only a task that still carries the marker is ever removed.
export const resumeTaskName=root=>installationId(root)+'-Resume';
export const resumeTaskMark=root=>'Pi on the Side resume watchdog '+installationId(root);
const absent=async p=>{try{await fs.lstat(p);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
async function plain(p,dir=false){const s=await fs.lstat(p);if(s.isSymbolicLink()||!s[dir?'isDirectory':'isFile']())throw Error('uninstall refused: linked or foreign path');const real=await fs.realpath(p);if(real.toLowerCase()!==path.resolve(p).toLowerCase())throw Error('uninstall refused: linked or foreign path');return s;}
async function rootPath(root){if(typeof root!=='string'||!path.isAbsolute(root)||root!==path.resolve(root)||root.startsWith('\\\\')||root===path.parse(root).root)throw Error('uninstall refused: invalid installation root');let p=root;while(true){await plain(p,true);const next=path.dirname(p);if(next===p)break;p=next;}return root;}
async function json(p){const s=await plain(p);if(s.size>1048576)throw Error('uninstall refused: oversized ownership record');return JSON.parse(await fs.readFile(p,'utf8'));}
// A record that is not valid JSON (a cut-off write) is "damaged": Setup treats it as absent (lenient); uninstall says what to do.
const readRecord=async(root,lenient=false)=>{const file=path.join(root,RECORD);if(lenient&&await absent(file))return null;try{return await json(file);}catch(e){if(!(e instanceof SyntaxError))throw e;if(lenient)return null;throw Error(DAMAGED);}};
async function inventory(root){const files=[],dirs=[];let bytes=0;async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(files.length+dirs.length>20000)throw Error('uninstall refused: inventory limit');const p=path.join(dir,entry.name),rel=path.relative(root,p).split(path.sep).join('/');/* The pause marker is data whatever it is; a link there is removed (never followed) by the removal itself. */if(rel==='coordinator-resume/control/disabled'&&entry.isSymbolicLink())continue;if(entry.isDirectory()){await plain(p,true);dirs.push(rel);await walk(p);}else{const stat=await plain(p);bytes+=stat.size;if(bytes>64*1048576)throw Error('uninstall refused: inventory limit');files.push({path:rel,sha256:hash(await fs.readFile(p))});}}}await walk(root);return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),dirs:dirs.sort()};}
const safeRelative=p=>typeof p==='string'&&p&&!p.includes('\\')&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
// Any runtime-shaped name: the hash recorded in release.json / runtime-files.json (checked by the callers) is what binds a file, so a release that adds or drops a runtime file never needs a change here.
const softwareName=p=>/^(NOTICE\.md|SECURITY\.md|package\.json|assets\/pots\.ico|(bin|src)\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs|extension\/[A-Za-z0-9][A-Za-z0-9._-]*\.(mjs|ts))$/.test(p);

// ---- The one place that runs powershell.exe and icacls.exe ----
// Every Windows helper call goes through here, so a failure always says WHAT failed: the step in plain words (the message,
// for beginners) and the technical cause under `detail` (timed out, too much output, or the script's own text, trimmed).
// `pots install` and `pots uninstall` read a failure through `report()` (setup.mjs cannot import this standalone file: the MCP bundle ships without it).
export class HelperFailure extends Error{constructor(plain,detail,kind){super(plain);this.name='HelperFailure';this.kind=kind;this.detail=detail;}report(){return `${this.message}\nDetails: ${this.detail}`;}}
// Windows PowerShell wraps what it writes to stderr in CLIXML when stdout is redirected; keep only the error text.
const stderrText=t=>{const s=String(t??'');if(!s.startsWith('#< CLIXML'))return s;return [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m=>m[1]).join(' ').replace(/_x[0-9A-Fa-f]{4}_/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');};
const clip=(t,n=300)=>{const s=String(t??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'...':s;};
export function runWindowsHelper(step,exe,args,{env=process.env,timeout=20000,maxBuffer=1048576,exec=execFile}={}){
 return new Promise((resolve,reject)=>{
  const bad=(kind,plain,detail)=>reject(new HelperFailure(plain,`${step}: ${detail}`,kind));
  try{exec(exe,args,{env,windowsHide:true,shell:false,timeout,maxBuffer},(e,out,err)=>{
   if(!e)return resolve(String(out).trim());
   if(e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return bad('output',`Windows returned more text than Setup can read when it tried to ${step}.`,`more than ${maxBuffer} bytes of output`);
   if(e.killed){const s=Math.max(1,Math.round(timeout/1000));return bad('timeout',`Windows did not finish within ${s} second${s===1?'':'s'} when Setup tried to ${step}.`,`no answer within ${timeout} ms`);}
   if(typeof e.code==='number')return bad('script',`Windows reported a problem when Setup tried to ${step}.`,`exit code ${e.code}: ${clip(stderrText(err))||clip(out)||'no message'}`);
   bad('start',`Setup could not start the Windows helper to ${step}.`,`${e.code||'error'}: ${clip(e.message)}`);
  });}catch(e){bad('start',`Setup could not start the Windows helper to ${step}.`,`${e&&e.code||'error'}: ${clip(e&&e.message)}`);}
 });
}
export function runPowerShell(step,script,{env=process.env,system=env.SystemRoot||env.SYSTEMROOT,timeout=20000,maxBuffer=1048576,exec}={}){
 if(!system)return Promise.reject(new HelperFailure(`Setup could not find the Windows folder it needs to ${step}.`,`${step}: SystemRoot is not set`,'start'));
 const exe=path.join(system,'System32/WindowsPowerShell/v1.0/powershell.exe');
 // Windows PowerShell 5 must load its own OS modules, not inherited PowerShell 7 modules. This child-only environment change
 // does not alter any ACL policy. Progress output would only add noise to stderr.
 return runWindowsHelper(step,exe,['-NoProfile','-NonInteractive','-Command',"$ProgressPreference='SilentlyContinue';"+script],{env:{...env,PSModulePath:path.join(path.dirname(exe),'Modules')},timeout,maxBuffer,exec});
}
const psRun=(script,env={},timeout=20000,step='show a Windows window',options={})=>runPowerShell(step,script,{env:{...process.env,...env},timeout,...options});
const answer=(step,out)=>{try{return JSON.parse(out);}catch{throw new HelperFailure(`Windows gave an answer Setup could not read when it tried to ${step}.`,`${step}: not valid JSON: ${clip(out)}`,'script');}};
const registryBase='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
export function windowsRegistry({exec}={}){const run=(script,env,timeout,step)=>psRun(script,env,timeout,step,{exec});return {
 async read(id){const step='look up this install in Installed apps';return answer(step,await run("$ErrorActionPreference='Stop';$p=$env:PI_UNINSTALL_KEY;if(Test-Path -LiteralPath $p){$v=Get-ItemProperty -LiteralPath $p;@{root=$v.PiOwnedRoot;command=$v.UninstallString;name=$v.DisplayName}|ConvertTo-Json -Compress}else{'null'}",{PI_UNINSTALL_KEY:registryBase+id},20000,step));},
 async list(){const step='list the installs in Installed apps';return answer(step,await run("$ErrorActionPreference='Stop';@{roots=@(Get-ChildItem -LiteralPath $env:PI_UNINSTALL_BASE -ErrorAction SilentlyContinue|Where-Object{$_.PSChildName -like 'PiOnTheSide-*'}|ForEach-Object{(Get-ItemProperty -LiteralPath $_.PSPath).PiOwnedRoot})}|ConvertTo-Json -Compress",{PI_UNINSTALL_BASE:registryBase.slice(0,-1)},20000,step)).roots;},
 async write(id,entry){await run("$ErrorActionPreference='Stop';$p=$env:PI_UNINSTALL_KEY;$e=$env:PI_UNINSTALL_ENTRY|ConvertFrom-Json;[void](New-Item -Path $p -Force);foreach($n in @('DisplayName','DisplayVersion','Publisher','InstallLocation','UninstallString','PiOwnedRoot','DisplayIcon')){if($null -ne $e.$n){[void](New-ItemProperty -LiteralPath $p -Name $n -Value $e.$n -PropertyType String -Force)}else{Remove-ItemProperty -LiteralPath $p -Name $n -ErrorAction SilentlyContinue}};foreach($n in @('NoModify','NoRepair')){[void](New-ItemProperty -LiteralPath $p -Name $n -Value 1 -PropertyType DWord -Force)}",{PI_UNINSTALL_KEY:registryBase+id,PI_UNINSTALL_ENTRY:JSON.stringify(entry)},20000,'add this install to Installed apps');},
 async remove(id){await run("$ErrorActionPreference='Stop';if(Test-Path -LiteralPath $env:PI_UNINSTALL_KEY){Remove-Item -LiteralPath $env:PI_UNINSTALL_KEY}",{PI_UNINSTALL_KEY:registryBase+id},20000,'remove an install from Installed apps');}
};}
// Asks the process scan only for the process ids under the given folders (a few bytes back), never for every command line.
export function windowsProcessFinder({exec}={}){return async function processes(roots){
 if(!Array.isArray(roots)||!roots.length||roots.some(r=>typeof r!=='string'||!r))throw Error('uninstall refused: process ownership unavailable');
 const step='check which programs are running from an install folder';
 return answer(step,await psRun("$ErrorActionPreference='Stop';$r=@($env:PI_UNINSTALL_ROOTS|ConvertFrom-Json);@{pids=@(Get-CimInstance Win32_Process|Where-Object{$p=$_;if($p.ProcessId -eq [int]$env:PI_UNINSTALL_PID){return $false};if($p.Name -in @('node.exe','omp.exe') -and !$p.CommandLine){return $true};foreach($root in $r){if(($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($p.CommandLine -and $p.CommandLine.IndexOf($root+'\\',[StringComparison]::OrdinalIgnoreCase) -ge 0)){return $true}};return $false}|ForEach-Object{$_.ProcessId})}|ConvertTo-Json -Compress",{PI_UNINSTALL_ROOTS:JSON.stringify(roots),PI_UNINSTALL_PID:String(process.pid)},60000,step,{exec})).pids;
};}
const processes=windowsProcessFinder();
const fail=message=>{throw Error(message);};
export function windowsPermissions(env = process.env) {
  const system = env.SystemRoot || env.SYSTEMROOT;
  const ps = system && path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const icacls = system && path.join(system, 'System32/icacls.exe');
  const inspect = async file => {
    if (!ps || !icacls) fail('private permission setup failed');
    const script = "$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $env:OMP_BRIDGE_ACL_TARGET;@{sid=$s.Value;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');full=($_.FileSystemRights -eq 'FullControl')}})}|ConvertTo-Json -Depth 4 -Compress";
    const out = await runPowerShell('check who may open a private Setup folder', script, { env: { ...env, OMP_BRIDGE_ACL_TARGET: file }, system });
    try { return JSON.parse(out); } catch { fail('private permission setup failed'); }
  };
  const verify = async (file, protectedRequired = true) => {
    const a = await inspect(file);
    if (a.owner !== a.sid || (protectedRequired && !a.protected) || !Array.isArray(a.rules) || a.rules.length !== 1 ||
      a.rules.some(r => r.sid !== a.sid || !r.allow || !r.full)) fail(REVIEW);
    return a.sid;
  };
  return {
    verify,
    async verifyTree(root) {
      await plain(root, true);
      // Each folder is listed on its own, so a link is seen but never followed. Only the pause marker may be a link: Setup and uninstall never open it.
      const pause = path.join(root, 'coordinator-resume', 'control', 'disabled').toLowerCase();
      const walk = async folder => {
        for (const row of await fs.readdir(folder, { withFileTypes: true })) {
          const file = path.join(folder, row.name);
          if (row.isSymbolicLink()) { if (file.toLowerCase() === pause) continue; fail(REVIEW); }
          if (row.isDirectory()) await walk(file);
        }
      };
      try { await walk(root); } catch { fail(REVIEW); }
      const script = "$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$skip=Join-Path $env:OMP_BRIDGE_ACL_TARGET 'coordinator-resume\\control\\disabled';$todo=New-Object System.Collections.Stack;$todo.Push((Get-Item -LiteralPath $env:OMP_BRIDGE_ACL_TARGET -Force));while($todo.Count){$f=$todo.Pop();if($f.Attributes -band [IO.FileAttributes]::ReparsePoint){if($f.FullName -ieq $skip){continue};throw 'linked'};$a=Get-Acl -LiteralPath $f.FullName;$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($r.Count -ne 1 -or $r[0].IdentityReference -ne $s -or $r[0].AccessControlType -ne 'Allow' -or $r[0].FileSystemRights -ne 'FullControl'){throw 'access'};if($f.PSIsContainer){foreach($c in @(Get-ChildItem -LiteralPath $f.FullName -Force)){$todo.Push($c)}}};'verified'";
      // A helper that could not run says so (timeout, too much output); only the script's own refusal means the folders need review.
      let out;
      try { out = await runPowerShell('check the private permissions of every file in a Setup folder', script, { env: { ...env, OMP_BRIDGE_ACL_TARGET: root }, system, timeout: 60000 }); }
      catch (error) { if (error instanceof HelperFailure && error.kind !== 'script') throw error; fail(REVIEW); }
      if (out !== 'verified') fail(REVIEW);
    },
    async protect(file, directory) {
      await plain(file, directory);
      const a = await inspect(file);
      // Called only for paths this invocation just created. Elevated Windows
      // tokens may create them with Administrators as owner; assign this user's
      // SID without touching SACLs. Existing paths use verify, never this repair.
      if (a.owner !== a.sid) await runWindowsHelper('give this user ownership of a private Setup folder', icacls, [file, '/setowner', `*${a.sid}`], { env });
      await runWindowsHelper('restrict a private Setup folder to this user', icacls, [file, '/inheritance:r', '/grant:r', `*${a.sid}:${directory ? '(OI)(CI)F' : 'F'}`], { env });
      await verify(file);
    },
  };
}


async function recover(root,permissions) {
 await permissions.verify(root);await permissions.verifyTree(root);
 const base=path.join(path.dirname(root),'Pi on the Side Recovery');
 if(await absent(base)){await fs.mkdir(base);await permissions.protect(base,true);}else{await plain(base,true);await permissions.verify(base);}
 const container=path.join(base,installationId(root)+'-'+crypto.randomUUID());await fs.mkdir(container);await permissions.protect(container,true);await permissions.verifyTree(container);
 const target=path.join(container,'installation');
 try {await fs.rename(root,target);await permissions.verify(target);await permissions.verifyTree(target);await permissions.verifyTree(container);}
 catch(e) {if(!await absent(target)&&await absent(root)){try{await fs.rename(target,root);}catch{throw Object.assign(Error('private recovery verification failed; moved files retained for local recovery'),{recovery:target});}await permissions.verifyTree(root);}throw e;}
 return target;
}

// Claude's documented user-scope configuration is read only. Deletion uses
// its native command; no host JSON is patched and no MCP server is contacted.
function referencesRoot(value,root){if(typeof value==='string')return new RegExp(root.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=[\\\\/"\']|$)').test(value.toLowerCase());return value&&typeof value==='object'&&Object.values(value).some(v=>referencesRoot(v,root));}
const ownsEntry=(entry,record,root)=>Boolean(entry)&&entry.type==='stdio'&&entry.command===record.nodeExecutable&&Array.isArray(entry.args)&&entry.args.some(p=>typeof p==='string'&&p.startsWith(root+path.sep))&&entry.env?.OMP_BRIDGE_STATE===path.join(root,'connections');
export function claudeIntegration({home=os.homedir(),env=process.env,run=clientRun}={}){const file=claudeLocations({home,env}).json;return {
 // Claude Code rewrites this file itself and it grows with its history: allow the size the installer's own reader allows.
 async read(){if(await absent(file))return null;const s=await plain(file);if(s.size>MAX_BYTES)throw Error('uninstall refused: host registration ownership unavailable');const value=JSON.parse(await fs.readFile(file,'utf8'));return value.mcpServers?.['omp-session-bridge']??null;},
 async remove(exe){if(await absent(exe))return {gone:true};await plain(exe);await run(exe,['mcp','remove','omp-session-bridge','--scope','user']);if(await this.read())throw Error('uninstall refused: host entry remains');return {gone:false};}
};}
function clientRun(exe,args){return new Promise((resolve,reject)=>execFile(exe,args,{windowsHide:true,shell:false,timeout:20000,maxBuffer:65536},e=>e?reject(Error('uninstall refused: native host removal failed')):resolve()));}
export async function trackClaudeCode(root,exe,integration=claudeIntegration()){
 await rootPath(root);await plain(exe);const record=await json(path.join(root,RECORD));if(record.root!==root||record.id!==installationId(root)||record.type!=='pi-on-the-side-uninstall')throw Error('uninstall refused: installation ownership missing');
 // A settings file that cannot be read now means this one registration cannot be verified: it is not recorded, and setup goes on.
 let entry;try{entry=await integration.read();}catch{return {tracked:false,host:'Claude Code',scope:'user'};}
 if(!ownsEntry(entry,record,root))throw Error('uninstall refused: host registration ownership unavailable');
 record.claudeCode={exe};await writeJson(path.join(root,RECORD),record,false,undefined,RECORD_MAX);return {tracked:true,host:'Claude Code',scope:'user'};
}

// Registrations the installer made in the assistant apps outside its own folder (Claude Desktop config entry, a
// Codex config block, the Claude skill file). Only what is recorded here is ever removed, and only while it is still
// exactly ours; anything the user changed since is left in place and reported.
const ASSISTANT_KINDS=['claude-desktop','codex','claude-skill','pots-command'];
export async function trackAssistants(root,rows){
 await rootPath(root);const record=await json(path.join(root,RECORD));if(record.root!==root||record.id!==installationId(root)||record.type!=='pi-on-the-side-uninstall')throw Error('uninstall refused: installation ownership missing');
 if(!Array.isArray(rows)||rows.length>6||rows.some(r=>!r||!ASSISTANT_KINDS.includes(r.kind)||typeof r.file!=='string'||!path.isAbsolute(r.file)||(['claude-skill','pots-command'].includes(r.kind)&&!/^[0-9a-f]{64}$/.test(r.sha256))||(r.kind==='codex'&&r.sha256!==undefined&&!/^[0-9a-f]{64}$/.test(r.sha256))))throw Error('uninstall refused: host registration ownership unavailable');
 const kept=new Map((Array.isArray(record.assistants)?record.assistants:[]).filter(r=>r&&ASSISTANT_KINDS.includes(r.kind)).map(r=>[r.kind,r]));for(const r of rows)kept.set(r.kind,r.sha256?{kind:r.kind,file:r.file,sha256:r.sha256}:{kind:r.kind,file:r.file});record.assistants=[...kept.values()];
 await writeJson(path.join(root,RECORD),record,false,undefined,RECORD_MAX);return {tracked:rows.length};
}
const OWN_BEGIN='# BEGIN Pi on the Side (omp-session-bridge)',OWN_END='# END Pi on the Side (omp-session-bridge)';
async function removeAssistants(root,rows,removed={}){
 const preserved=[],settings=[];const keep=row=>(['claude-desktop','codex'].includes(row.kind)?settings:preserved).push(row.file);if(!Array.isArray(rows)||rows.length>6)throw Error('uninstall refused: unverified install file');
 for(const row of rows){
  if(!row||!ASSISTANT_KINDS.includes(row.kind)||typeof row.file!=='string'||!path.isAbsolute(row.file))throw Error('uninstall refused: unverified install file');
  if(await absent(row.file))continue;
  try{
   await plain(row.file);const bytes=await fs.readFile(row.file);
   if(row.kind==='pots-command'){if(hash(bytes)===row.sha256){await fs.unlink(row.file);removed.command=true;}else keep(row);}
   else if(row.kind==='claude-skill'){if(hash(bytes)===row.sha256){await fs.unlink(row.file);await fs.rmdir(path.dirname(row.file)).catch(()=>{});}else keep(row);}
   else if(row.kind==='claude-desktop'){
    const value=JSON.parse(bytes.toString('utf8')),entry=value?.mcpServers?.['omp-session-bridge'];
    if(!entry)continue;if(!referencesRoot(entry,root)){keep(row);continue;}
    delete value.mcpServers['omp-session-bridge'];const temp=row.file+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,row.file);
   }else{
    const text=bytes.toString('utf8'),eol=text.includes('\r\n')?'\r\n':'\n',lines=text.split(/\r?\n/);
    const begin=lines.map((l,i)=>l.startsWith(OWN_BEGIN)?i:-1).filter(i=>i>=0),end=lines.map((l,i)=>l.startsWith(OWN_END)?i:-1).filter(i=>i>=0);
    if(!begin.length&&!end.length)continue;
    if(begin.length!==1||end.length!==1||end[0]<begin[0]||!referencesRoot(lines.slice(begin[0],end[0]+1).join('\n').replace(/\\\\/g,'\\'),root)||(row.sha256&&hash(lines.slice(begin[0],end[0]+1).join('\n'))!==row.sha256)){keep(row);continue;}
    const from=begin[0]>0&&lines[begin[0]-1]===''?begin[0]-1:begin[0];lines.splice(from,end[0]-from+1);
    const temp=row.file+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';await fs.writeFile(temp,lines.join(eol),{flag:'wx',mode:0o600});await fs.rename(temp,row.file);
   }
  }catch{keep(row);}
 }
 return {files:preserved,settings};
}


// These are known historical product locations, not a disk-wide name search.
// Legacy/manual copies and Desktop-managed MCPBs are reported for their normal
// owner/client removal, never adopted or patched by this uninstaller. The default
// Local folder is reported only when it carries Setup's own marker: an older
// folder without it is not Setup's (Setup leaves it untouched and uses a new
// folder), so it must not block removing the install Setup made.
export async function auditExternal(roots,{home=os.homedir(),env=process.env}={}){
 const candidates=[path.join(home,'.omp','omp-session-bridge-local'),path.join(home,'.omp','omp-session-bridge-releases')];if(env.LOCALAPPDATA)candidates.push(path.join(env.LOCALAPPDATA,'OMP Session Bridge Local'));const items=[];
 const ours=async p=>{try{return JSON.stringify(await json(path.join(p,'local-setup.json')))===JSON.stringify(MARKER);}catch{return false;}};
 for(const p of candidates)if(!roots.some(r=>r.toLowerCase()===p.toLowerCase())&&!await absent(p)&&(!env.LOCALAPPDATA||p!==path.join(env.LOCALAPPDATA,'OMP Session Bridge Local')||await ours(p)))items.push({path:p,reason:'unrecorded-copy-requires-local-review'});
 if(env.APPDATA){const folder=path.join(env.APPDATA,'Claude','Claude Extensions');if(!await absent(folder)){await plain(folder,true);for(const dir of await fs.readdir(folder,{withFileTypes:true})){if(!dir.isDirectory())continue;const p=path.join(folder,dir.name,'manifest.json');if(await absent(p))continue;try{const manifest=await json(p);if(manifest.name==='omp-session-bridge')items.push({path:path.dirname(p),reason:'remove-through-Claude-Desktop-extension-settings'});}catch{if(dir.name.includes('omp-session-bridge'))items.push({path:path.dirname(p),reason:'unverified-client-copy'});}}}}
 return items;
}

export const uninstallDefaults={platform:process.platform,registry:windowsRegistry(),processes,permissions:windowsPermissions(),recover,integration:claudeIntegration(),audit:auditExternal,tasks:windowsTasks()};

// Record only an already-created, exclusively owned automatic setup. Existing
// manual copies are not adopted based on a product name or directory location.
export async function registerInstallation(root,{nodeExecutable=process.execPath,registry=windowsRegistry(),coordinatorInstructions=[],coordinatorResume={files:[],external:[]},added={}}={}){
 if(!added||typeof added!=='object'||Array.isArray(added)||Object.entries(added).some(([p,h])=>!(/^launchers\/[a-z][a-z0-9-]{0,63}\/(Start-OMP\.ps1|launch-settings\.json)$/.test(p)||/^runtime\/(?:managed-[0-9a-f-]+|current)\/(bridge\.mjs|current\.json)$/.test(p))||!/^[0-9a-f]{64}$/.test(h)))throw Error('uninstall refused: unverified install file');
 const managedInstructions=await verifiedCoordinatorInstructions(root,coordinatorInstructions);
 const managedResume=await verifiedResumeFiles(root,coordinatorResume.files),resumeExternal=await verifiedResumeExternal(root,coordinatorResume.external);
 for(const [name,digest] of managedResume)managedInstructions.set(name,digest);
 // `added`: the exact files (path -> SHA-256) that this very Setup call wrote or verified, e.g. a launcher it just replaced. A file that
 // matches the earlier record, this build's own helper bytes, or `added` is Setup's. Any other unlisted or changed file (maybe edited by
 // the owner) never stops the record from being refreshed: it is left untouched and unclaimed, so uninstall still lists it and keeps it.
 const unproven=new Set();
 const id=installationId(root),prior=await registry.read(id);if(prior&&prior.root&&prior.root!==root)throw Error('uninstall refused: foreign registry entry');const existing=await readRecord(root,true);if(existing){const old=existing;if(old.root!==root||old.id!==id||prior&&prior.root&&prior.command!==old.command)throw Error('uninstall refused: foreign registry entry');const scan=await inventory(root),allowed=await qualifiedSoftware(root,old,scan);for(const [name,digest] of managedInstructions)allowed.set(name,digest);for(const f of scan.files){if(f.path===RECORD||f.path==='setup.lock'||f.path==='local-setup.json'||dataPattern.test(f.path)||f.path.startsWith('coordinator-resume/')&&!managedResume.has(f.path))continue;if(allowed.get(f.path)!==f.sha256&&!(HELPER_FILES.includes(f.path)&&f.sha256===await ownHelper(f.path))&&!(Object.hasOwn(added,f.path)&&added[f.path]===f.sha256))unproven.add(f.path);}}
 // A failed run must leave nothing behind for any future build: remember the helper targets and the record, put them back (or delete what was created) on failure.
 const before=new Map();for(const name of [...HELPER_FILES,RECORD])before.set(name,await fs.readFile(path.join(root,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e;}));
 try{
 for(const name of HELPER_FILES)if(!unproven.has(name)){const bytes=await helperBytes(name);if(bytes)await fs.writeFile(path.join(root,name),bytes,{mode:0o600});}
 const scan=await inventory(root),manifest=await runtimeManifest(root,scan),software={};for(const f of scan.files){if(f.path===RECORD||f.path==='setup.lock'||f.path==='local-setup.json'||dataPattern.test(f.path)||unproven.has(f.path))continue;if(HELPER_FILES.includes(f.path)||managedInstructions.get(f.path)===f.sha256||(f.path.startsWith('runtime/')&&softwareLocation(f.path)&&(runtimeMeta(f.path)||manifest.get(f.path)===f.sha256))||/^launchers\/[a-z][a-z0-9-]{0,63}\/(Start-OMP\.ps1|launch-settings\.json)$/.test(f.path))software[f.path]=f.sha256;/* Any other file is not claimed: uninstall will list it and leave it. */}
 const command=`"${nodeExecutable}" "${path.join(root,HELPER)}" "${root}" --all --ui`;
 const oldRecord=existing;const record={version:1,type:'pi-on-the-side-uninstall',root,id,nodeExecutable,command,software,resumeExternal,...(oldRecord?.claudeCode?{claudeCode:oldRecord.claudeCode}:{}),...(oldRecord?.assistants?{assistants:oldRecord.assistants}:{})};
 await writeJson(path.join(root,RECORD),record,false,undefined,RECORD_MAX);
 const pkg=await json(path.join(path.dirname(fileURLToPath(import.meta.url)),'../package.json'));
 try{await registry.write(id,{DisplayName:'Pi on the Side!',DisplayVersion:pkg.version,Publisher:'Jumpstile',InstallLocation:root,UninstallString:command,PiOwnedRoot:root,...(software[ICON]?{DisplayIcon:path.join(root,ICON)}:{})});}catch(e){throw Error('uninstall registration failed; setup retained, rerun setup to repair');}
 }catch(e){const left=[];for(const [name,bytes] of before){const file=path.join(root,name);try{if(bytes)await fs.writeFile(file,bytes,{mode:0o600});else await fs.rm(file,{force:true});}catch{left.push(name);}}if(left.length)e.left=left;throw e;}
 await pruneStale(root,registry);
 return {registered:true,id,root};
}
// After this install's own entry is written: removes the Installed-apps entries of Pi on the Side whose install folder is gone (a deleted throwaway folder), so only the real install is listed.
// Registry keys only, never a file. An entry whose folder still exists, one that is not provably Setup's own (same proof as an orphan in previewUninstall), and anything unreadable are left alone; a failure here never fails the install.
async function pruneStale(root,registry){
 if(typeof registry.list!=='function'||typeof registry.remove!=='function')return;/* a list that cannot be read or changed has nothing to clean */
 try{for(const p of await listedRoots({registry})){
  try{if(!path.isAbsolute(p)||p!==path.resolve(p)||p===path.parse(p).root||same(p,root)||!await absent(p))continue;
   const id=installationId(p),entry=await registry.read(id);
   if(entry&&entry.name==='Pi on the Side!'&&typeof entry.root==='string'&&same(entry.root,p)&&typeof entry.command==='string'&&entry.command.toLowerCase().endsWith(` "${path.join(p,HELPER)}" "${p}" --all --ui`.toLowerCase()))await registry.remove(id);}catch{/* this one entry stays */}
 }}catch{await fs.appendFile(path.join(root,'pots.log'),new Date().toISOString()+' Old Installed apps entries could not be cleaned up this time.\r\n',{mode:0o600}).catch(()=>{});}
}

const resumeLocation=p=>/^coordinator-resume\/(config\.json|resume-prompt\.txt|claude-cloud-task\.txt|chatgpt-cloud-task\.txt|Disable-Resume\.cmd|Run-Resume\.vbs|ownership\.json)$/.test(p);
const softwareLocation=p=>HELPER_FILES.includes(p)||resumeLocation(p)||/^coordinator-instructions\/(claude-skill\.md|chatgpt-custom-instructions\.txt)$/.test(p)||/^launchers\/[a-z][a-z0-9-]{0,63}\/(Start-OMP\.ps1|launch-settings\.json)$/.test(p)||/^runtime\/[^/]+\/(bridge\.mjs|current\.json|runtime-files\.json)$/.test(p)||/^runtime\/[^/]+\/versions\/[^/]+\/release\.json$/.test(p)||(/^runtime\/[^/]+\//.test(p)&&softwareName(p.replace(/^runtime\/[^/]+\/(?:versions\/[^/]+\/)?/,'')));
async function verifiedResumeFiles(root,rows){
 if(!Array.isArray(rows)||rows.length>6)throw Error('uninstall refused: unverified install file');
 const out=new Map();for(const row of rows){if(!row||!resumeLocation(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256)||out.has(row.path))throw Error('uninstall refused: unverified install file');const file=path.join(root,row.path);await plain(file);if(hash(await fs.readFile(file))!==row.sha256)throw Error('uninstall refused: unverified install file');out.set(row.path,row.sha256);}return out;
}
const startupName=(root,p)=>[installationId(root)+'-Resume.cmd',installationId(root)+'-Resume.vbs'].includes(path.basename(p));
async function verifiedResumeExternal(root,rows){
 if(!Array.isArray(rows)||rows.length>1)throw Error('uninstall refused: unverified install file');
 for(const row of rows){if(!row||typeof row.path!=='string'||!path.isAbsolute(row.path)||row.path!==path.resolve(row.path)||!startupName(root,row.path)||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('uninstall refused: unverified install file');/* A launcher changed after Setup wrote it is still recorded: uninstall deletes a row's file only while its bytes equal the recorded hash, otherwise it names and keeps it. */if(await absent(row.path))continue;await plain(row.path);}return rows;
}
async function disableResume(root){
 await rootPath(root);if(JSON.stringify(await json(path.join(root,'local-setup.json')))!==JSON.stringify(MARKER))throw Error('uninstall refused: installation ownership missing');
 const record=await readRecord(root);if(record.version!==1||record.type!=='pi-on-the-side-uninstall'||record.root!==root||record.id!==installationId(root))throw Error('uninstall refused: installation ownership missing');
 if(!record.software||!Object.keys(record.software).some(resumeLocation))return false;
 const directory=path.join(root,'coordinator-resume');await plain(directory,true);
 const control=path.join(directory,'control');if(await absent(control))await fs.mkdir(control);else await plain(control,true);
 const marker=path.join(control,'disabled');let made=false;/* Whatever is named disabled (a file, a folder or a link) already keeps the watchdog off. */if(await absent(marker)){await fs.writeFile(marker,'',{flag:'wx',mode:0o600});made=true;}
 const deadline=Date.now()+17000,lock=path.join(control,'watchdog.lock');
 while(!await absent(lock)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
 return made;
}
async function removeResumeExternal(root,rows){
 const preserved=[];
 if(!Array.isArray(rows)||rows.length>1)throw Error('uninstall refused: unverified install file');
 for(const row of rows){if(!row||typeof row.path!=='string'||!path.isAbsolute(row.path)||!startupName(root,row.path)||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('uninstall refused: unverified install file');if(await absent(row.path))continue;await plain(row.path);if(hash(await fs.readFile(row.path))===row.sha256)await fs.unlink(row.path);else preserved.push(row.path);}return preserved;
}
async function verifiedCoordinatorInstructions(root, rows) {
 if (!Array.isArray(rows) || rows.length > 2) throw Error('uninstall refused: unverified install file');
 const approved = new Map();
 for (const row of rows) {
  if (!row || Object.keys(row).sort().join() !== 'path,sha256' || typeof row.path !== 'string' ||
      !/^coordinator-instructions\/(claude-skill\.md|chatgpt-custom-instructions\.txt)$/.test(row.path) ||
      typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || approved.has(row.path)) throw Error('uninstall refused: unverified install file');
  const file = path.join(root, ...row.path.split('/'));
  await plain(file);
  if (hash(await fs.readFile(file)) !== row.sha256) throw Error('uninstall refused: unverified install file');
  approved.set(row.path, row.sha256);
 }
 return approved;
}
// A runtime file is owned only if a release manifest of its own version folder lists it with the digest it has now: release.json of a managed version, runtime-files.json of a fixed-folder install. A runtime-shaped name alone never claims a file.
const runtimeMeta=p=>/^runtime\/[^/]+\/(bridge\.mjs|current\.json|runtime-files\.json)$/.test(p)||/^runtime\/[^/]+\/versions\/[^/]+\/release\.json$/.test(p);
async function runtimeManifest(root,scan){const owned=new Map();
 for(const f of scan.files){let rows;const dir=path.posix.dirname(f.path);
  if(/^runtime\/[^/]+\/versions\/[^/]+\/release\.json$/.test(f.path)){const v=await json(path.join(root,f.path));if(!v.files||typeof v.files!=='object'||Array.isArray(v.files)||typeof v.release!=='string'||path.posix.basename(dir)!==v.release)throw Error('uninstall refused: invalid release ownership');rows=Object.entries(v.files);}
  else if(/^runtime\/[^/]+\/runtime-files\.json$/.test(f.path)){const v=await json(path.join(root,f.path));if(!Array.isArray(v))throw Error('uninstall refused: invalid release ownership');rows=v.map(r=>[r&&r.name,r&&r.sha256]);}
  else continue;
  for(const [name,digest] of rows){if(typeof name!=='string'||!softwareName(name)||!/^([0-9a-f]{64})$/.test(digest))throw Error('uninstall refused: invalid release ownership');owned.set(dir+'/'+name,digest);}
 }
 return owned;}
async function qualifiedSoftware(root,record,scan){const allowed=new Map(Object.entries(record.software));
 // Updates retain immutable version folders. Verify each complete release
 // manifest rather than trusting new files simply because they sit in runtime.
 for(const [p,digest] of await runtimeManifest(root,scan))allowed.set(p,digest);
 for(const f of scan.files.filter(f=>/^runtime\/[^/]+\/(versions\/[^/]+\/release|runtime-files)\.json$/.test(f.path)))allowed.set(f.path,f.sha256);
 for(const f of scan.files.filter(f=>/^runtime\/(?:managed-[0-9a-f-]+|current)\/current\.json$/.test(f.path))){const pointer=await json(path.join(root,f.path));if(typeof pointer.current!=='string'||!allowed.has(path.posix.join(path.posix.dirname(f.path),'versions',pointer.current,'release.json')))throw Error(BROKEN_RUNTIME);allowed.set(f.path,f.sha256);}
 return allowed;
}
// An earlier Setup wrote a lane's launch-settings.json first and Start-OMP.ps1 second; a cut-off between the two leaves the first alone. It is Setup's own only while it has the exact shape Setup writes and points inside this install folder.
async function loneSettings(scan,root,p){const m=/^(launchers\/[a-z][a-z0-9-]{0,63})\/launch-settings\.json$/.exec(p);if(!m||scan.files.some(f=>f.path===m[1]+'/Start-OMP.ps1'))return false;try{const v=JSON.parse(await fs.readFile(path.join(root,p),'utf8'));return Boolean(v)&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()==='cli,node,state'&&Object.values(v).every(x=>typeof x==='string')&&[v.cli,v.state].every(x=>path.isAbsolute(x)&&path.resolve(x).toLowerCase().startsWith(root.toLowerCase()+path.sep));}catch{return false;}}
async function previewUninstall(root,deps=uninstallDefaults){
 if(deps.platform!=='win32')throw Error('uninstall requires Windows');if(typeof root!=='string'||!path.isAbsolute(root)||root!==path.resolve(root)||root===path.parse(root).root)throw Error('uninstall refused: invalid installation root');if(await absent(root)){const id=installationId(root),entry=await deps.registry.read(id);/* The folder is gone but Windows still lists it: that one entry is removed only when it names this very folder and the uninstall command Setup wrote for it; any other entry is never touched. The folder is compared without letter case, as everywhere else. */if(entry&&!(typeof entry.root==='string'&&same(entry.root,root)&&typeof entry.command==='string'&&entry.command.toLowerCase().endsWith(` "${path.join(root,HELPER)}" "${root}" --all --ui`.toLowerCase())))return {status:'blocked',reason:'foreign-registry-entry',root};return {status:'already-absent',root,id,files:[],dirs:[],orphan:Boolean(entry)};}await rootPath(root);
 const ownerRoot=deps.recoveryOrigin??root;const marker=await json(path.join(root,'local-setup.json')),record=await readRecord(root);if(JSON.stringify(marker)!==JSON.stringify(MARKER)||record.version!==1||record.type!=='pi-on-the-side-uninstall'||typeof record.root!=='string'||!same(record.root,ownerRoot)||record.id!==installationId(ownerRoot)||!record.software||Object.entries(record.software).some(([p,h])=>!safeRelative(p)||!softwareLocation(p)||!/^([0-9a-f]{64})$/.test(h)))throw Error('uninstall refused: installation ownership missing');
 const entry=await deps.registry.read(record.id);if(entry&&entry.root&&(!same(entry.root,root)||entry.command!==record.command))return {status:'blocked',reason:'foreign-registry-entry',root};
 // Claude Code's settings file is read only when the record says it was connected; a file that cannot be read means this one entry cannot be verified, and it is left in place.
 let host=null,hostUnverified=false;if(record.claudeCode){if(typeof record.claudeCode.exe!=='string'||!path.isAbsolute(record.claudeCode.exe))throw Error('uninstall refused: host registration ownership unavailable');try{host=await deps.integration.read();}catch{hostUnverified=true;}if(host&&!ownsEntry(host,record,root))return {status:'blocked',reason:'host-registration-changed',root};}
 const scan=await inventory(root),software=await qualifiedSoftware(root,record,scan),unknown=[],busy=[];
 // A file that is not recorded as Setup's own (including a wake-up file the person changed or made) is never moved or purged: it stops the removal and is named under --details.
 for(const f of scan.files){if(f.path.endsWith('.lock')){if(!await isStaleLock(path.join(root,f.path)))busy.push(f.path);continue;}if(f.path===RECORD||f.path==='local-setup.json'||dataPattern.test(f.path))continue;if(software.get(f.path)!==f.sha256&&!await loneSettings(scan,root,f.path))unknown.push(f.path);}
 // Unknown empty directories also matter: never recursively remove them on the
 // assumption that their parents belong to the product.
 for(const dir of scan.dirs){if(!scan.files.some(f=>f.path.startsWith(dir+'/'))&&!emptyDirs.test(dir)&&!lockPattern.test(dir))unknown.push(dir+'/');}
 const pids=await deps.processes(deps.recoveryOrigin?[root,deps.recoveryOrigin]:[root]);if(!Array.isArray(pids)||pids.some(p=>!Number.isSafeInteger(p)||p<=0))throw Error('uninstall refused: process ownership unavailable');let keptLock;for(const f of busy)if(!keptLock&&await isKeptLock(path.join(root,f)))keptLock=path.join(root,f);if(pids.length||busy.length)return {status:'blocked',reason:'running-or-locked',root,pids,items:busy,note:pids.length||!busy.length?'Something from Pi on the Side still looks busy. Close OMP and your assistants and try again.':busy.includes('setup.lock')?'Setup or the assistant connection is working on this install right now. Next: wait a minute, then run pots uninstall again.':keptLock?`An earlier update could not put the version pointer back and left its lock, so nothing was removed. Next: in ${path.dirname(keptLock)}, check that current.json names a folder that exists inside versions (fix the name if it does not), then delete only the file ${path.basename(keptLock)} there and run pots uninstall again. The steps are in docs/update.md under Rollback and recovery.`:`A lock file is still in place: ${busy.map(f=>path.join(root,f)).join(', ')}. Either a program that is still running holds it, or a crash left it behind. If no OMP window or Pi on the Side program is running, delete only that file, then run pots uninstall again.`};if(unknown.length)return {status:'blocked',reason:'unverified-files',root,items:unknown};
 return {status:'ready',root,id:record.id,files:scan.files,dirs:scan.dirs,registryPresent:Boolean(entry),hostUnverified,recovery:'Verified private recovery archive by default; permanent purge requires explicit confirmation',record};
}
// A purge deletes the whole install folder, and the handoff file in it holds the owner's own notes: it is copied next to the install folder first, never over a file that is already there.
async function keepHandoff(root,origin){
 const source=path.join(root,'coordinator-resume','handoff.md');if(await absent(source))return undefined;
 for(let n=1;;n++){const target=path.join(path.dirname(origin),`Pi on the Side handoff${n>1?` (${n})`:''}.md`);try{await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);return target;}catch(e){if(e.code!=='EEXIST')throw e;}}
}
async function uninstallInstallation(root,options={},deps=uninstallDefaults){
 const preview=await previewUninstall(root,deps);if(preview.status==='already-absent'){if(preview.orphan&&options.confirmOffline){try{await deps.registry.remove(preview.id);if(await deps.registry.read(preview.id))return {status:'incomplete',root,reason:'registry-remains'};}catch{return {status:'incomplete',root,reason:'registry-removal-failed'};}}return {status:'already-absent',root};}if(preview.status!=='ready'||!options.confirmOffline)return {...preview,record:undefined};
 const final=await previewUninstall(root,deps);if(final.status!=='ready'||JSON.stringify(final.files)!==JSON.stringify(preview.files)||JSON.stringify(final.dirs)!==JSON.stringify(preview.dirs))return {status:'blocked',reason:'installation-changed',root};
 // The handoff copy comes first: if it fails, nothing has been removed yet, not even the scheduled task.
 let handoffKept;if(options.purge)try{handoffKept=await keepHandoff(root,deps.recoveryOrigin??root);}catch{return {status:'blocked',reason:'handoff-not-copied',root,note:`The handoff file could not be copied next to the install folder, so nothing was removed from ${root}. Next: make sure you can save files in the folder that holds the install folder, then run pots uninstall again.`};}
 // The permission checks come first and the scheduled task goes only after every check has passed, so a blocked uninstall never costs the person their wake-ups.
 // A refusal keeps its own reason (and the recovery folder when files were already moved) instead of reading as "something is using them".
let recovery,preservedExternal=[],preservedSettings=[],programGone=false,linkRemoved=false,taskGone=false;const removed={};
// Only a real "in use" error reads as something using the files; a Windows helper that did not finish, a failed host removal or any other error says what happened (the cause is kept for --details).
const IN_USE=new Set(['EBUSY','EPERM','EACCES','ENOTEMPTY']);
const stopped=e=>({status:'incomplete',root,reason:e.recovery?'recovery-kept':e.message===REVIEW?'permissions-review':IN_USE.has(e.code)?'locked-or-removal-failed':'removal-failed',registryRetained:true,recovery:e.recovery,wakeupsOff:taskGone,
 ...(e instanceof HelperFailure?{note:`${e.message} Next: run pots uninstall again; if it comes back, send the Details to support.`,detail:e.detail}:UNINSTALL_ERRORS.includes(e.message)?{detail:e.message}:typeof e.code==='string'?{detail:e.code}:{})});
// The permission checks come first and nothing is removed until they pass: a link named disabled (removed itself, never followed) goes only after them.
try{await deps.permissions.verify(root);await deps.permissions.verifyTree(root);const mark=path.join(root,'coordinator-resume','control','disabled');if((await fs.lstat(mark).catch(()=>null))?.isSymbolicLink()){await fs.rm(mark,{force:true});linkRemoved=true;}}catch(e){return stopped(e);}
 if(options.confirmOffline&&!deps.recoveryOrigin){try{await deps.tasks?.remove(resumeTaskName(root),resumeTaskMark(root));taskGone=Boolean(deps.tasks);}catch{return {status:'blocked',reason:'task-remains',root,note:`Windows would not confirm that the scheduled task ${resumeTaskName(root)} is gone, so nothing was removed. Next: open Task Scheduler, check that this task is deleted (delete it if it is there), then run pots uninstall again.`};}}
 // root was resolved, ancestor/reparse-checked, ownership-qualified and fully
 // re-inventoried above. Recover by same-volume rename, preserving its DACL,
 // then verify the private destination before removing the app registration.
 try{if(final.record.claudeCode&&!final.hostUnverified&&await deps.integration.read())programGone=(await deps.integration.remove(final.record.claudeCode.exe))?.gone===true;{const wake=await removeResumeExternal(root,final.record.resumeExternal||[]),apps=await removeAssistants(root,final.record.assistants||[],removed);preservedExternal=[...wake,...apps.files];preservedSettings=apps.settings;}if(options.purge)await fs.rm(root,{recursive:true,force:false});else recovery=await deps.recover(root,deps.permissions);}catch(e){return stopped(e);}
 if(!await absent(root))return {status:'incomplete',root,reason:'files-remain',registryRetained:true,recovery,wakeupsOff:taskGone,preservedExternal,preservedSettings};
try{await deps.registry.remove(preview.id);if(await deps.registry.read(preview.id))return {status:'incomplete',root,reason:'registry-remains',recovery,wakeupsOff:taskGone};}catch{return {status:'incomplete',root,reason:'registry-removal-failed',recovery,wakeupsOff:taskGone};}
 const commandRemoved=removed.command===true; // only what this uninstall really deleted: a command the person had already deleted is not claimed
 return {status:'uninstalled',root,activeFilesRemaining:0,registryPresent:false,preservedExternal,preservedSettings,commandRemoved,claudeCodeKept:final.hostUnverified||programGone,claudeCodeGone:programGone,recovery:options.purge?'none: permanent purge confirmed':recovery,handoffKept,linkRemoved,scope:'Recorded installation only; modified external resume launchers are preserved. Unrecorded downloads, manual copies and host-installed adapters are not claimed removed.'};
}
// Recovery folders are considered only for a confirmed permanent purge. Each
// archive must retain the selected installation's marker, original root and
// ownership hashes; unrecognized siblings cause a blocked result.
async function recoveryTargets(root,deps){
 const base=path.join(path.dirname(root),'Pi on the Side Recovery');if(await absent(base))return [];await plain(base,true);await deps.permissions.verify(base);const targets=[];
 for(const dir of await fs.readdir(base,{withFileTypes:true})){if(!dir.name.startsWith(installationId(root)+'-'))continue;if(!dir.isDirectory()||!new RegExp('^'+installationId(root)+'-'+uuid+'$').test(dir.name))throw Error('uninstall refused: unverified recovery archive');const container=path.join(base,dir.name);await plain(container,true);await deps.permissions.verify(container);const children=await fs.readdir(container);if(!children.length){targets.push({empty:container});continue;}if(children.length!==1||children[0]!=='installation')throw Error('uninstall refused: unverified recovery archive');targets.push({root:path.join(container,'installation'),container});}
 return targets;
}
// A half-written Installed-apps entry has no root. Its key is a hash of the root, so only this product's own partial write can look like that; skip it. Anything else that is not an absolute path is still refused by the caller.
export const listedRoots=async deps=>(await deps.registry.list()).filter(p=>typeof p==='string'&&p);
// Pausing the watchdog only serves the removal. When the uninstall ends with the install still in place, the pause Setup wrote is taken away
// again; a pause the owner wrote (Disable-Resume) is never Setup's to remove.
export async function uninstall(root,options={},deps=uninstallDefaults){
 const paused=[];
 try{return await uninstallAll(root,options,deps,paused);}
 finally{await unpause(paused);}
}
const unpause=async markers=>{for(const marker of markers){try{if((await fs.stat(marker)).size===0)await fs.unlink(marker);}catch{/* removed with the install */}}};
// --ui, after the person's yes: pauses the watchdogs, previews the removal and asks the person (`ask`). A preview that comes back blocked, or a window that fails or times out, takes the pause away again, so a removal that never started does not leave wake-ups off.
// An answer of cancel keeps the pause, as the first window says.
export async function uiPreview(root,options,resumable,deps=uninstallDefaults,ask=uiConfirm){
 const paused=[];
 try{for(const target of resumable)if(await disableResume(target))paused.push(path.join(target,'coordinator-resume','control','disabled'));
  const preview=await uninstall(root,options,deps);if(preview.status!=='preview'){await unpause(paused);return {preview,paused};}
  return {preview,paused,mode:await ask(preview.installations.map(p=>p.root+' ('+p.files.length+' owned files)').join('\n'))};}
 catch(e){await unpause(paused);throw e;}
}
async function uninstallAll(root,options,deps,paused){
 // `orphans` (plain `pots uninstall`): besides this install, only an Installed-apps entry whose folder is gone and that is provably Setup's own is cleaned up; every other listed install is left alone. `all` takes every listed install.
 const listed=options.all||options.orphans?await listedRoots(deps):[],roots=options.all?listed:[root],orphanRoots=[];
 if(options.orphans&&!options.all)for(const p of listed)if(path.isAbsolute(p)&&p===path.resolve(p)&&p!==path.parse(p).root&&!same(p,root)&&await absent(p)&&(await previewUninstall(p,deps)).orphan){roots.push(p);orphanRoots.push(p);}
 if(!roots.some(p=>same(p,root)))roots.push(root);const unique=roots.filter((p,i)=>roots.findIndex(q=>same(p,q))===i);if(unique.some(p=>!path.isAbsolute(p)))throw Error('uninstall refused: foreign registry entry');
 if(options.all&&deps.audit){
  const unresolved=await deps.audit(unique);
  if(unresolved.length)return {status:'blocked',reason:'unresolved-external-copies',items:unresolved};
 }
 if(options.all)for(const base of new Set(unique.map(r=>path.join(path.dirname(r),'Pi on the Side Recovery')))){if(await absent(base))continue;await plain(base,true);const unknown=(await fs.readdir(base)).filter(name=>!unique.some(r=>name.startsWith(installationId(r)+'-')));if(unknown.length)return {status:'blocked',reason:'unverified-recovery-containers',items:unknown.map(name=>path.join(base,name))};}
 const targets=unique.map(root=>({root,deps,orphan:orphanRoots.some(p=>same(p,root))})),empty=[];
 if(options.purge)for(const p of unique)for(const item of await recoveryTargets(p,deps)){if(item.empty){empty.push(item.empty);continue;}targets.push({...item,deps:{...deps,recoveryOrigin:p,registry:{read:async()=>null,remove:async()=>{}},integration:{read:async()=>null,remove:async()=>{}}}});}
 if(options.confirmOffline&&(!options.purge||options.confirmPurge))for(const item of targets)if(!item.deps.recoveryOrigin&&!await absent(item.root)&&await disableResume(item.root))paused.push(path.join(item.root,'coordinator-resume','control','disabled'));
 const previews=[];for(const item of targets)previews.push(await previewUninstall(item.root,item.deps));if(previews.some(p=>!['ready','already-absent'].includes(p.status)))return {status:'blocked',installations:previews.map(({record,...p})=>p)};
 if(!options.confirmOffline)return {status:'preview',installations:previews.map(({record,...p})=>p),emptyRecoveryContainers:empty};if(options.purge&&!options.confirmPurge)return {status:'confirmation-required',note:'Permanent deletion includes active files and verified recovery archives. Your handoff file (coordinator-resume\\handoff.md) is kept: it is copied next to the install folder first, and anyone who can open that folder can read it.'};
 // A leftover entry was chosen because its folder was gone. If the folder is back by now (a drive or network folder that reconnected), it is a working install again and plain uninstall leaves it alone.
 const results=[];for(const item of targets){if(item.orphan&&!await absent(item.root)){results.push({status:'already-absent',root:item.root,cameBack:true});continue;}const r=await uninstallInstallation(item.root,options,item.deps);results.push(r);if(!['uninstalled','already-absent'].includes(r.status))break;if(item.container){try{await deps.permissions.verify(item.container);await fs.rmdir(item.container);}catch{return {status:'incomplete',reason:'recovery-container-remains',installations:results};}}}
 if(results.length===targets.length)for(const p of empty){try{await deps.permissions.verify(p);await fs.rmdir(p);}catch{return {status:'incomplete',reason:'recovery-container-remains',installations:results};}}
 if(options.purge&&results.length===targets.length)for(const p of new Set(unique.map(r=>path.join(path.dirname(r),'Pi on the Side Recovery')))){if(!await absent(p)&&!(await fs.readdir(p)).length){try{await deps.permissions.verify(p);await fs.rmdir(p);}catch{return {status:'incomplete',reason:'recovery-parent-remains',installations:results};}}}
 const final={status:results.length===targets.length&&results.every(r=>['uninstalled','already-absent'].includes(r.status))?'uninstalled':'incomplete',installations:results};
 return final;
}

async function uiConfirm(targets){const out=await psRun("$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;$m='Selected installation roots:'+[Environment]::NewLine+$env:PI_UNINSTALL_TARGETS+[Environment]::NewLine+[Environment]::NewLine+'Remove these recorded Pi on the Side installations? Close their OMP/bridge clients first. Shared OMP, Node, Sesori and project files are not removed.'+[Environment]::NewLine+[Environment]::NewLine+'YES: recoverable removal to a verified private recovery archive.'+[Environment]::NewLine+'NO: permanent purge, including history, receipts and credentials. Your handoff file is copied next to the install folder first, and anyone who can open that folder can read it.'+[Environment]::NewLine+'CANCEL: change nothing.';$a=[Windows.Forms.MessageBox]::Show($m,'Pi on the Side uninstall',[Windows.Forms.MessageBoxButtons]::YesNoCancel,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button3);if($a -eq 'Yes'){'recover'}elseif($a -eq 'No'){$b=[Windows.Forms.MessageBox]::Show('Permanently delete all recorded Pi files, credentials, receipts, logs and recovery data? Your handoff file is copied next to the install folder first, and anyone who can open that folder can read it. Files outside the install folder that you changed after Setup wrote them stay where they are. This cannot be undone.','Confirm permanent purge',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button2);if($b -eq 'Yes'){'purge'}else{'cancel'}}else{'cancel'}",{PI_UNINSTALL_TARGETS:targets},300000);return out;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try {
  const [root,...flags]=process.argv.slice(2);
  if(root&&flags[0]==='--track-claude-code'&&flags.length===2){console.log(JSON.stringify(await trackClaudeCode(root,flags[1])));process.exit(0);}
  if(!root||flags.some(f=>!['--all','--ui','--confirm-offline','--purge','--confirm-purge'].includes(f))||new Set(flags).size!==flags.length)throw Error('uninstall usage: <installation-root> [--all] [--confirm-offline] [--purge --confirm-purge]');
  const options={all:flags.includes('--all'),confirmOffline:flags.includes('--confirm-offline'),purge:flags.includes('--purge'),confirmPurge:flags.includes('--confirm-purge')};
  let preview,paused=[];
  if(flags.includes('--ui')){
   const roots=options.all?await listedRoots(uninstallDefaults):[root];if(!roots.includes(root))roots.push(root);
   const resumable=[];for(const target of [...new Set(roots)])if(!await absent(target)){await rootPath(target);const record=await readRecord(target);if(record.software&&Object.keys(record.software).some(resumeLocation))resumable.push(target);}
   if(resumable.length&&await psRun("Add-Type -AssemblyName System.Windows.Forms;if([Windows.Forms.MessageBox]::Show('Pause the recorded coordinator resume watchdogs before inspecting uninstall? This disables future automatic CLI launches and waits up to 17 seconds. No installed files are removed yet. If removal is cancelled, resume remains disabled for safety.','Pause coordinator resume',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button2) -eq 'Yes'){'yes'}else{'no'}",{},300000)!=='yes')process.exit(0);
   const shown=await uiPreview(root,{all:options.all,purge:options.purge},resumable);preview=shown.preview;paused=shown.paused;
   if(preview.status!=='preview'){console.log(JSON.stringify(preview,null,2));await psRun("Add-Type -AssemblyName System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show($env:PI_UNINSTALL_RESULT,'Pi on the Side uninstall blocked')",{PI_UNINSTALL_RESULT:[...(preview.installations??[]).map(p=>p.note).filter(Boolean),JSON.stringify(preview,null,2)].join('\n\n')},300000);process.exit(1);}
   const mode=shown.mode;
   if(mode==='cancel')process.exit(0);options.confirmOffline=true;options.purge=options.confirmPurge=mode==='purge';
  }
  let result;try{result=await uninstall(root,options);}finally{await unpause(paused);}console.log(JSON.stringify(result,null,2));
  if(flags.includes('--ui'))await psRun("Add-Type -AssemblyName System.Windows.Forms;[void][Windows.Forms.MessageBox]::Show($env:PI_UNINSTALL_RESULT,'Pi on the Side uninstall result')",{PI_UNINSTALL_RESULT:JSON.stringify(result,null,2)},300000);
  process.exitCode=['uninstalled','preview'].includes(result.status)?0:1;
 }catch(e){console.error(e instanceof HelperFailure?e.report():e.message===REVIEW?reviewText('pots uninstall'):UNINSTALL_ERRORS.includes(e.message)?e.message:'uninstall refused; inspect the installation locally');process.exitCode=1;}
}
