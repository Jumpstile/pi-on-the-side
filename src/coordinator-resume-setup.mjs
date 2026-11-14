import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { plain } from './control.mjs';
import { installationId, resumeTaskName, resumeTaskMark } from './uninstall.mjs';
import { resumePrompt, cloudResumePrompt, createResumeWatchdog, resolveResumeExecutable, RESUME_LIMITS, parseLaunchLog, repairLaunchLog, watchdogSilenceMs } from './coordinator-resume.mjs';
import { readJson, LaneEvents } from './control.mjs';
import { readConnections } from './connections.mjs';
import { coordinatorHeartbeatFresh, heartbeatFile } from './coordinator-heartbeat.mjs';
import { rmSync } from 'node:fs';
import { createLaneWatch, readNewWatchLines, WATCH_DEFAULTS } from './lane-watch.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const choices = ['none', 'claude', 'chatgpt', 'both'];
const selected = value => value === 'both' ? ['claude', 'chatgpt'] : value === 'none' ? [] : [value];
const fail = () => { throw Error('invalid automatic setup options'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && value === path.resolve(value) && !/[\r\n\0]/.test(value);
export function resumeOptions(value, clients) {
  if (value === undefined) return { cliClients: 'none', cloudClients: 'none', dryRun: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['cliClients','cloudClients','handoffFile','dryRun','pollMs','claudeExecutable','codexExecutable','claudeSession','claudeContinue'].includes(k))) fail();
  const result = { cliClients: 'none', cloudClients: 'none', dryRun: false, ...value };
  if (!choices.includes(result.cliClients) || !choices.includes(result.cloudClients) || typeof result.dryRun !== 'boolean' ||
      (result.pollMs !== undefined && (!Number.isSafeInteger(result.pollMs) || result.pollMs < 1000 || result.pollMs > 15000)) ||
      [...selected(result.cliClients), ...selected(result.cloudClients)].some(client => !selected(clients).includes(client)) ||
      (result.claudeContinue !== undefined && typeof result.claudeContinue !== 'boolean') ||
      (result.claudeSession !== undefined && (typeof result.claudeSession !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result.claudeSession))) ||
      (result.claudeSession && result.claudeContinue) ||
      ['handoffFile','claudeExecutable','codexExecutable'].some(k => result[k] !== undefined && !absolute(result[k])) ||
      ((result.cliClients !== 'none' || result.cloudClients !== 'none') && !absolute(result.handoffFile))) fail();
  return result;
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
const generatedName = name => /^(config\.json|resume-prompt\.txt|claude-cloud-task\.txt|chatgpt-cloud-task\.txt|Disable-Resume\.cmd|Run-Resume\.vbs)$/.test(name);
const HANDOFF_TEXT = 'Pi on the Side handoff\n\nThis file is read by a coordinator that Pi on the Side starts by itself when a lane finishes and no coordinator is active.\nThe coordinator keeps it current. Write here, in plain words: the goal, what is finished, what is approved next, and anything that needs the owner.\n';
const xmlText = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Starts at log-in, then every 5 minutes; a copy that is already running is never doubled (IgnoreNew), so a closed or crashed watchdog is back within 5 minutes.
function resumeTaskXml({ root, script, account }) {
  const who = '<UserId>' + xmlText(account) + '</UserId>';
  return '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
    '<RegistrationInfo><Description>' + xmlText(resumeTaskMark(root)) + '</Description></RegistrationInfo>\n' +
    '<Triggers><LogonTrigger><Enabled>true</Enabled>' + who + '</LogonTrigger>' +
    '<TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>\n' +
    '<Principals><Principal id="Author">' + who + '<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n' +
    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>' +
    '<AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand>' +
    '<Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>\n' +
    '<Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //NoLogo "' + xmlText(script) + '"</Arguments></Exec></Actions>\n</Task>\n';
}
async function readOwnership(directory, root, adopt, wanted = {}) {
  const file = path.join(directory, 'ownership.json');
  if (!await exists(file)) return { version: 1, files: {}, external: [] };
  const stat = await plain(file);
  if (stat.size > 16384) fail();
  const bytes = await fs.readFile(file), manifestHash = digest(bytes);
  if (!adopt) {
    const recordFile = path.join(root, 'uninstall-record.json');
    if (!await exists(recordFile)) throw Error('automatic setup records differ; inspect locally');
    const recordStat = await plain(recordFile);
    if (recordStat.size > 1048576) fail();
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    if (record.version !== 1 || record.type !== 'pi-on-the-side-uninstall' || record.root !== root || record.id !== installationId(root) ||
        record.software?.['coordinator-resume/ownership.json'] !== manifestHash) throw Error('automatic setup records differ; inspect locally');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.version !== 1 || !value.files || !Array.isArray(value.external) || value.external.length > 1 ||
      Object.entries(value.files).some(([name, hash]) => !generatedName(name) || !/^[a-f0-9]{64}$/.test(hash)) ||
      value.external.some(row => !absolute(row.path) || ![installationId(root) + '-Resume.cmd', installationId(root) + '-Resume.vbs'].includes(path.basename(row.path)) || !/^[a-f0-9]{64}$/.test(row.sha256))) fail();
  // With no matching uninstall record (the install was cut off after this file was written, before the record was), the folder's own
  // list still proves the files are Setup's when every listed file is there with its listed hash, or with the bytes this version would write
  // (a second cut-off run may already have rewritten some). One changed or missing file proves nothing.
  if (adopt) for (const [name, hash] of Object.entries(value.files)) if (!await matches(path.join(directory, name), hash) && !(wanted[name] && await matches(path.join(directory, name), wanted[name]))) throw Error('automatic setup records differ; inspect locally');
  return { ...value, manifestHash };
}
// A record that cannot be proven either way is never a reason to stop an upgrade: the old files are simply left as they are.
const ownership = async (directory, root, wanted) => await readOwnership(directory, root).catch(() => null) ?? await readOwnership(directory, root, true, wanted).catch(() => null);
async function matches(file, hash) {
  if (!await exists(file)) return false;
  await plain(file);
  return digest(await fs.readFile(file)) === hash;
}
// Written to a temporary file and renamed, so a power cut leaves the old file or the new one, never half of one.
async function replaceGenerated(file, content, priorHash) {
  if (await exists(file)) {
    if (await matches(file, digest(content))) return; // already what is about to be written (a run that was cut off)
    if (!priorHash || !await matches(file, priorHash)) throw Error('automatic setup records differ; inspect locally');
  }
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let published = false;
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    // Looked at again just before the rename: a file that arrived meanwhile is never replaced.
    if (await exists(file) && !(priorHash && await matches(file, priorHash))) throw Error('automatic setup records differ; inspect locally');
    await fs.rename(temp, file); published = true;
  } finally { if (!published) await fs.unlink(temp).catch(() => {}); }
}
const cmdPath = value => { if (/["%\r\n\0]/.test(value)) fail(); return '"' + value + '"'; };
const vbsPath = value => { if (/["%\r\n\0]/.test(value)) fail(); return value; };
export async function installCoordinatorResume({ root, options, cwd, connectionsFolder, runtimeFolder, nodeExecutable, permissions, account }) {
  const directory = path.join(root, 'coordinator-resume'), enabled = options.cliClients !== 'none' || options.cloudClients !== 'none';
  if (!enabled && !await exists(directory)) return { options, files: [], external: [], preserved: [] };
  if (!await exists(directory)) { await fs.mkdir(directory); await permissions.protect(directory, true); }
  else await plain(directory, true);
  // The handoff file is data only and is never replaced (wx), so it is made whenever wake-ups are on and the file is the standard one and missing: with or without a command-line program, and even when old wake-up files are left as they are.
  const handoffFile = path.join(directory, 'handoff.md');
  if (enabled && options.handoffFile === handoffFile && !await exists(handoffFile)) await fs.writeFile(handoffFile, HANDOFF_TEXT.replace(/\n/g, '\r\n'), { flag: 'wx', mode: 0o600 });
  const control = path.join(directory, 'control'), configFile = path.join(directory, 'config.json'), files = {}, external = [], preserved = [];
  const config = enabled ? { version: 1, cwd, connectionsFolder, handoffFile: options.handoffFile, promptFile: path.join(directory, 'resume-prompt.txt'),
    cliClients: options.cliClients, dryRun: options.dryRun, pollMs: options.pollMs ?? RESUME_LIMITS.pollMs,
    ...Object.fromEntries(['claudeExecutable','codexExecutable','claudeSession','claudeContinue'].filter(k => options[k] !== undefined).map(k => [k, options[k]])) } : null;
  const generated = {};
  if (config) {
    generated['config.json'] = JSON.stringify(config, null, 2) + '\r\n';
    generated['resume-prompt.txt'] = resumePrompt({ handoffFile: options.handoffFile, cycleFile: path.join(control, 'state.json') }).replace(/\r?\n/g, '\r\n') + '\r\n';
    generated['Disable-Resume.cmd'] = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' + cmdPath(nodeExecutable) + ' ' + cmdPath(path.join(runtimeFolder, 'bin/coordinator-resume.mjs')) + ' --config ' + cmdPath(configFile) + ' --disable\r\npause\r\n';
    if (options.cliClients !== 'none') generated['Run-Resume.vbs'] = 'Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run("""' + vbsPath(nodeExecutable) + '"" ""' + vbsPath(path.join(runtimeFolder, 'bin/coordinator-resume.mjs')) + '"" --config ""' + vbsPath(configFile) + '""", 0, True)\r\n';
    // Only the watchdog writes the current-cycle file, so a cloud-only setup (no watchdog) gets a reminder without that rule.
    for (const client of selected(options.cloudClients)) generated[client + '-cloud-task.txt'] = cloudResumePrompt({ client, handoffFile: options.handoffFile, cycleFile: options.cliClients === 'none' ? undefined : path.join(control, 'state.json') }).replace(/\r?\n/g, '\r\n') + '\r\n';
  }
  const old = await ownership(directory, root, Object.fromEntries(Object.entries(generated).map(([name, content]) => [name, digest(content)])));
  // The old files are left as they are. A cut-off last log line is still repaired (data only), but only while no watchdog is running.
  const leftAlone = async () => { if (await gone(path.join(control, 'watchdog.lock'))) await repairLaunchLog(control).catch(() => {}); return { options, files: [], external: [], preserved: [], leftAsIs: true }; };
  if (!old) return leftAlone();
  if (!await exists(control)) { await fs.mkdir(control); await permissions.protect(control, true); } else await plain(control, true);
  // Disable the previous configuration before changing executable/client choices.
  // Preflight every selected output: a modified or unowned file is never replaced. It is left as it is, and nothing has been changed yet.
  for (const [name, content] of Object.entries(generated)) {
    const file = path.join(directory, name);
    if (await exists(file) && !await matches(file, digest(content)) && (!old.files[name] || !await matches(file, old.files[name]))) return leftAlone();
    files[name] = digest(content);
  }
  const cli = options.cliClients !== 'none';
  const task = cli ? { name: resumeTaskName(root), mark: resumeTaskMark(root), xml: resumeTaskXml({ root, script: path.join(directory, 'Run-Resume.vbs'), account }) } : null;
  const changed = old.files['config.json'] && (!config || !await matches(configFile, digest(generated['config.json'])));
  if (changed && !await exists(path.join(control, 'disabled'))) await fs.writeFile(path.join(control, 'disabled'), '', { flag: 'wx', mode: 0o600 });
  for (const [name, hash] of Object.entries(old.files)) {
    if (generated[name] !== undefined) continue;
    const file = path.join(directory, name);
    if (await matches(file, hash)) await fs.unlink(file); else if (await exists(file)) preserved.push(file);
  }
  for (const [name, content] of Object.entries(generated)) await replaceGenerated(path.join(directory, name), content, old.files[name]);
  for (const row of old.external) {
    // Older versions put one Startup file outside the install; the task replaces it.
    // A launcher that no longer matches its record is not ours to delete: it stays, and stays in the record so that uninstall names it too.
    if (await matches(row.path, row.sha256)) await fs.unlink(row.path); else if (await exists(row.path)) { preserved.push(row.path); external.push(row); }
  }
  const record = { version: 1, files, external };
  await replaceGenerated(path.join(directory, 'ownership.json'), JSON.stringify(record, null, 2) + '\r\n', old.manifestHash);
  return { options, files: [...Object.keys(files).map(name => ({ path: 'coordinator-resume/' + name, sha256: files[name] })),
    { path: 'coordinator-resume/ownership.json', sha256: digest(await fs.readFile(path.join(directory, 'ownership.json'))) }], external, preserved,
    task };
}

// ---- What a plain install turns on by itself, and how to see that it works -----------------------------------------

// A program on this PC cannot type into a chat. What it can do is start a command-line coordinator (Claude Code or Codex) when a
// lane has finished and no coordinator has been active for a while. A plain install turns that on when it finds one.
export async function autoResumeOptions({ root, clients, env, resolve = resolveResumeExecutable }) {
  const found = [];
  for (const client of selected(clients)) { try { await resolve(client, undefined, { env }); found.push(client); } catch { /* not installed */ } }
  if (!found.length) return undefined;
  return { cliClients: found.length === 2 ? 'both' : found[0], cloudClients: 'none', dryRun: false, handoffFile: path.join(root, 'coordinator-resume', 'handoff.md') };
}

// One line in the install log (pots.log), for everything that failed or could not be done. Two files of at most 64 KiB.
export async function logProblem(root, text, now = Date.now) {
  const file = path.join(root, 'pots.log');
  try {
    if ((await fs.stat(file).catch(() => ({ size: 0 }))).size > 65536) await fs.rename(file, file + '.1');
    await fs.appendFile(file, new Date(now()).toISOString() + ' ' + text.replace(/[\r\n]+/g, ' ') + '\r\n', { mode: 0o600 });
  } catch { /* the problem is still shown on screen */ }
}

const gone = async file => { try { await fs.lstat(file); return false; } catch { return true; } };
// Puts the scheduled task in place and (re)starts the watchdog on the code that was just installed. Throws when any step fails.
export async function applyResumeTask({ root, task, tasks, pollMs = RESUME_LIMITS.pollMs, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const name = resumeTaskName(root), mark = resumeTaskMark(root);
  if (!task) return { status: await tasks.remove(name, mark) };
  const control = path.join(root, 'coordinator-resume', 'control'), marker = path.join(control, 'disabled'), lock = path.join(control, 'watchdog.lock');
  // An empty marker is Setup's own "please stop" note; a marker with words in it is the owner's own Disable-Resume and is left alone.
  // A folder or a link with that name is neither: it is not Setup's to delete, and it keeps the watchdog off.
  const seen = await fs.lstat(marker).catch(() => null), owner = Boolean(seen?.isFile() && seen.size > 0);
  let ours = false;
  if (!seen) { await fs.mkdir(control, { recursive: true }); await fs.writeFile(marker, '', { flag: 'wx', mode: 0o600 }); ours = true; }
  else if (seen.isFile() && !owner) ours = true;
  const deadline = Date.now() + 3 * pollMs + 2000;
  while (!await gone(lock) && Date.now() < deadline) await sleep(250);
  if (!await gone(lock)) await tasks.stop(name); else await repairLaunchLog(control).catch(() => {}); // no watchdog is running: a cut-off last log line is repaired before it starts again
  await tasks.register(name, task.xml);
  if (ours) {
    // Disable-Resume may have written into the marker while the task was being registered: words in it are the owner's, so it stays.
    // Only a zero-byte plain file is ours to remove.
    const now = await fs.lstat(marker).catch(() => null);
    if (now && !(now.isFile() && now.size === 0)) return { status: now.isFile() ? 'disabled-by-owner' : 'marker-not-a-file' };
    await fs.unlink(marker).catch(() => {});
  }
  if (owner) return { status: 'disabled-by-owner' };
  if (seen && !seen.isFile()) return { status: 'marker-not-a-file' };
  await tasks.start(name);
  return { status: 'started' };
}

// The install's own wake-up choice (pots install --no-coordinator-wakeups / --coordinator-wakeups), kept in one small empty file each.
export const wakeupsOffFile = root => path.join(root, 'coordinator-resume', 'control', 'wakeups-off');
export const wakeupsOnFile = root => path.join(root, 'coordinator-resume', 'control', 'wakeups-on');
export const WAKEUPS_ON_AGAIN = 'To turn them on again, run pots install --coordinator-wakeups.';
export const WAKEUPS_FORGOTTEN = 'Turning wake-ups off also forgets their saved settings (which handoff file to read, check interval, cloud task choice); the handoff file itself is not deleted. Turning them on again starts from the standard settings.';
// True when the person chose pots install --no-coordinator-wakeups: the stored choice says so, or the saved settings of every connected project do.
async function offByChoice(root) {
  try {
    if (await exists(wakeupsOffFile(root))) return true;
    if (await exists(wakeupsOnFile(root))) return false; // turned on again while a session was still open: that session still says off
    const { connections } = await readConnections(path.join(root, 'connections'));
    return (await Promise.all(connections.map(row => readJson(path.join(row.root, 'config.json')).then(saved => saved.coordinatorWakeups === false, () => false)))).every(Boolean);
  } catch { return false; }
}
// Every part of the wake-up path, in plain words. ok:false means it will not work as it is.
export async function resumeHealth({ root, tasks, env, resolve = resolveResumeExecutable, now = Date.now }) {
  const rows = [], add = (key, ok, text) => rows.push({ key, ok, text }), directory = path.join(root, 'coordinator-resume'), control = path.join(directory, 'control');
  let config = null;
  try { config = await readJson(path.join(directory, 'config.json')); } catch { /* not set up */ }
  // The watchdog counts as running while its log has been written lately (the same test as the watchdog row below).
  const seen = await fs.stat(path.join(control, 'launches.jsonl')).then(stat => now() - stat.mtimeMs, () => null);
  const silent = watchdogSilenceMs(config?.pollMs ?? RESUME_LIMITS.pollMs), live = seen !== null && seen <= silent;
  const handoff = async () => {
    const there = !await gone(config.handoffFile);
    add('handoff', there, there ? 'The handoff file the coordinator reads exists.' : config.handoffFile === path.join(directory, 'handoff.md') ? 'The handoff file the coordinator reads is missing. Next: run pots install; it makes a new one.'
      : `The handoff file the coordinator reads (${config.handoffFile}) is missing. Next: create that file again, or run setup-auto with --handoff-file set to the file you use (docs/coordinator-resume.md).`);
  };
  // Setup could not switch off an old wake-up setup (its files were left as they are). Say what is really still there.
  if (config && config.cliClients !== 'none' && await exists(wakeupsOffFile(root))) {
    const queried = await tasks.query(resumeTaskName(root)).catch(() => null), taskThere = queried !== null && queried.includes(resumeTaskMark(root));
    const still = [taskThere && 'the scheduled task that starts the watchdog is still in place', live && 'the watchdog is still running'].filter(Boolean);
    if (!still.length) add('off', true, `Wake-ups are off by your choice. Changed wake-up files from an earlier setup were left in ${directory}, but no scheduled task or watchdog is running. ${WAKEUPS_ON_AGAIN}`);
    else add('off-old', true, `Wake-ups are off by your choice (pots install --no-coordinator-wakeups), but ${still.join(' and ')}, so an assistant may still be started. Next: to stop it now, ${await exists(path.join(directory, 'Disable-Resume.cmd')) ? `run Disable-Resume.cmd in ${directory}` : `create an empty file named disabled in ${control} (the watchdog stops when it sees it)${taskThere ? ` and delete the scheduled task ${resumeTaskName(root)} in Task Scheduler` : ''}`}; to remove it for good, move your changed wake-up files away and run pots install --no-coordinator-wakeups again.`);
    return rows;
  }
  if (!config || config.cliClients === 'none') {
    if (await offByChoice(root)) { add('off', true, 'Wake-ups are off by your choice. ' + WAKEUPS_ON_AGAIN); return rows; }
    // Saved settings with no command-line program in them are a cloud-only choice: Setup writes them only when something was selected.
    if (config) { add('cloud-only', true, 'Wake-ups from Claude Code or Codex are not set up: this install is set up for cloud tasks only (--resume-cli none), so nothing starts them by itself. Chats in Claude Desktop or ChatGPT cannot be woken by a program; the cloud task text in coordinator-resume is for you to schedule. To use Claude Code or Codex instead, run setup-auto with --resume-cli claude, chatgpt (Codex) or both (docs/coordinator-resume.md).'); await handoff(); return rows; }
    add('resume', false, 'Nothing can start an assistant by itself when a lane finishes, because no Claude Code or Codex (the command-line programs) was selected for wake-ups. Chats in Claude Desktop or ChatGPT cannot be woken by a program. Next: install Claude Code or Codex if you have neither, then run pots install; it turns wake-ups on for what it finds. To choose one yourself, use setup-auto with --resume-cli (docs/coordinator-resume.md).');
    return rows;
  }
  const marker = path.join(control, 'disabled'), pause = await fs.lstat(marker).catch(() => null);
  if (!pause) add('switch', true, 'Wake-ups are switched on.');
  else if (!pause.isFile()) add('switch', false, `Wake-ups are off because ${marker} is a folder or a link, not a file Setup or you made. Next: delete or rename it, then run pots install.`);
  else if (pause.size) { add('off', true, `Wake-ups are off by your choice: you switched them off with Disable-Resume. To switch them on again, delete ${marker} and run pots install.`); return rows; }
  else add('switch', false, 'Wake-ups were paused by an install or uninstall that did not finish. Next: run pots install.');
  const clients = config.cliClients === 'both' ? ['claude', 'chatgpt'] : [config.cliClients], names = { claude: 'Claude Code', chatgpt: 'Codex' };
  const own = client => config[client === 'claude' ? 'claudeExecutable' : 'codexExecutable'], flag = client => client === 'claude' ? '--claude-executable' : '--codex-executable';
  let program;
  for (const client of clients) { try { await resolve(client, own(client), { env }); program = names[client]; break; } catch { /* try the next */ } }
  const custom = clients.filter(own);
  add('program', Boolean(program), program ? `${program} was found, so it can be started.` : `${clients.map(client => names[client]).join(' or ')} was not found ${custom.length ? `at ${custom.map(own).join(' or ')}` : 'any more'}. Next: ${custom.length ? `put it back there, or run setup-auto with ${custom.map(flag).join(' or ')} set to where it is now (docs/coordinator-resume.md)` : 'install it again, then run pots install'}.`);
  await handoff();
  const found = await tasks.query(resumeTaskName(root)).catch(() => null);
  add('task', found !== null && found.includes(resumeTaskMark(root)), found !== null && found.includes(resumeTaskMark(root)) ? 'The scheduled task that keeps the watchdog running is in place.' : 'The scheduled task that keeps the watchdog running is missing. Next: run pots install.');
  const lockFolder = path.join(control, 'watchdog.lock');
  add('watchdog', live, live ? 'The watchdog is running.' : (seen === null ? 'The watchdog has never run.' : `The watchdog stopped ${Math.round(seen / 60000)} minute(s) ago.`) + ' Next: run pots install.' +
    (await gone(lockFolder) ? '' : ` A lock the watchdog left behind is cleared by the next start once its log has been quiet for ${Math.ceil(2 * silent / 60000)} minute(s). If it still stays like this after that, delete the folder ${lockFolder} (only while no watchdog is running) and run pots install again.`));
  let log; try { log = parseLaunchLog(await fs.readFile(path.join(control, 'launches.jsonl'), 'utf8').catch(() => '')); } catch { log = { records: [], damaged: true }; }
  if (log.damaged) add('log', false, 'The watchdog log (coordinator-resume/control/launches.jsonl) has a damaged line, probably because the PC lost power while it was written. Next: run pots install; it repairs the log.');
  const last = log.records.filter(row => row.action === 'launched' || row.action === 'failed').at(-1);
  if (last?.action === 'failed') add('launch', false, `The last try to start ${program ?? 'the coordinator'} failed. Next: open it once yourself to see what it asks for.`);
  if (log.records.at(-1)?.reason === 'safety') {
    // A coordinator's "I am active" note dated far in the future stops every wake-up; it sits in the lane's own folder, not here.
    const bad = [];
    try { for (const row of (await readConnections(config.connectionsFolder, { tries: 1 })).connections) await coordinatorHeartbeatFresh(row.root, now()).catch(() => bad.push(heartbeatFile(row.root))); } catch { /* no readable lane list: the general text below applies */ }
    const other = `Next: run pots install. If this stays, delete the file ${path.join(control, 'state.json')} and run pots install again (it forgets which finished lanes were already handled, so it may start one extra wake-up).`;
    add('safety', false, bad.length
      ? `The watchdog is running, but it starts nothing. A coordinator's "I am active" note cannot be trusted (damaged, or dated far in the future, for example after the PC clock was changed) and can stop wake-ups: ${bad.join(' and ')}. Next: delete that file while no coordinator is working on that lane. If wake-ups do not come back, the safety check is failing for another reason. ${other}`
      : `The watchdog is running, but its own safety check keeps failing, so it starts nothing. ${other}`);
  }
  return rows;
}
export const healthText = rows => rows.map(row => (row.ok ? 'OK: ' : 'NOT WORKING: ') + row.text);

// Runs a lane that does nothing in a throwaway folder through the real watcher, the real status and the real wake-up decision
// (without starting any program), then deletes everything it made. It cannot prove that the coordinator program opens: that only
// happens for a real lane.
export async function selfTest({ root, tasks, env, resolve, watch = {}, limitMs = 15000, stopText = 'The wake-up test was stopped. Nothing was changed.', now = Date.now }) {
  // The watcher can only call a lane idle after the lane's own quiet time (idleMs) plus one poll, so the limit never sits below that.
  const timing = { ...WATCH_DEFAULTS, ...watch }, limit = Math.max(limitMs, timing.idleMs + timing.pollMs + 5000);
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-selftest-')));
  let watcher, idleMs = null, wakeMs = null, action = null;
  // Ctrl+C, a closed window or a stop request ends the process without running `finally`: the throwaway folder is removed here first.
  const stops = ['SIGINT', 'SIGTERM', 'SIGHUP'], onStop = signal => { try { rmSync(base, { recursive: true, force: true }); } catch { /* the folder is only temporary */ } console.log(stopText); process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)); };
  for (const signal of stops) process.on(signal, onStop);
  try {
    const lane = path.join(base, 'lane'), sessionId = crypto.randomUUID(), planId = crypto.randomUUID(), rc = path.join(base, 'resume');
    await fs.mkdir(path.join(lane, 'control'), { recursive: true }); await fs.mkdir(rc);
    const real = await readJson(path.join(root, 'coordinator-resume', 'config.json')).catch(() => null);
    const settings = { ...WATCH_DEFAULTS, ...watch, resultFolders: [base] };
    watcher = createLaneWatch({ root: lane, sessionId, settings });
    await watcher.start();
    const events = new LaneEvents(lane, sessionId), start = now();
    events.record('plan_done', { planId, state: 'completed', reason: 'all_planned_submissions_ended_success_unverified' });
    events.record('idle', { planId, reason: 'native_idle' });
    await events.flush();
    const rows = [{ name: 'selftest', loaded: { settings: { root: lane }, lockFile: path.join(lane, 'supervisor.lock'), store: {
      config: { root: lane, sessionId }, ids: async () => [planId], receipt: async () => ({ version: 1, id: planId, sessionId, state: 'completed', updatedAt: start }) } } }];
    const deadline = start + limit + settings.idleMs;
    while (now() < deadline && idleMs === null) {
      await new Promise(resolveTimer => setTimeout(resolveTimer, 200));
      if ((await readNewWatchLines(rows, { peek: true, now })).lines.some(line => / IDLE /.test(line))) idleMs = now() - start;
    }
    if (idleMs !== null) {
      const handoffFile = real?.handoffFile && !await gone(real.handoffFile) ? real.handoffFile : path.join(base, 'handoff.md');
      if (handoffFile.startsWith(base)) await fs.writeFile(handoffFile, 'self-test');
      await fs.writeFile(path.join(rc, 'resume-prompt.txt'), 'self-test');
      const configFile = path.join(rc, 'config.json');
      await fs.writeFile(configFile, JSON.stringify({ version: 1, cwd: base, connectionsFolder: base, handoffFile, promptFile: path.join(rc, 'resume-prompt.txt'),
        cliClients: real && real.cliClients !== 'none' ? real.cliClients : 'claude', dryRun: true, pollMs: 1000 }));
      const watchdog = await createResumeWatchdog(configFile, { loadConnections: async () => rows, heartbeat: async () => false, env, now });
      const wakeStart = now();
      try { action = (await watchdog.tick()).action; } finally { await watchdog.close(); }
      wakeMs = now() - wakeStart;
    }
  } finally {
    for (const signal of stops) process.off(signal, onStop);
    await watcher?.stop().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const leftover = await gone(base) ? null : base;
  // Checked last: a watchdog the install has just started has had the whole test to write its first line.
  const health = await resumeHealth({ root, tasks, env, resolve, now });
  const seconds = ms => (ms / 1000).toFixed(1);
  const failed = [...health.filter(row => !row.ok).map(row => row.text),
    ...(idleMs === null ? [`The watcher did not notice the finished test lane within ${seconds(limit)} seconds.`] : idleMs > limit ? [`The watcher noticed the finished test lane after ${seconds(idleMs)} seconds; the limit is ${seconds(limit)}.`] : []),
    ...(idleMs !== null && action !== 'dry-run' ? ['The decision to start a coordinator was not made for the finished test lane.'] : []),
    ...(leftover ? [`The throwaway test folder ${leftover} could not be removed. Delete it yourself.`] : [])];
  const pass = failed.length === 0;
  return { pass, idleSeconds: idleMs === null ? null : idleMs / 1000, wakeSeconds: wakeMs === null ? null : wakeMs / 1000, health, failed,
    text: pass
      ? `Wake-up self-test: PASS. A test lane that finished was noticed after ${seconds(idleMs)} seconds (limit ${seconds(limit)}), and the decision to start your coordinator was made ${seconds(wakeMs)} seconds later. Proven: the watcher, the lane status, the decision, the scheduled task and the running watchdog. Not proven: that the coordinator program itself opens, because that happens only when a real lane finishes.`
      : `Wake-up self-test: FAIL. ${failed.join(' ')}`,
    note: leftover ? `The throwaway test folder could not be removed: ${leftover}` : 'The test lane and its folder were removed.' };
}

