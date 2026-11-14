import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plain, readJson, unlinkRetry, writeJson } from './control.mjs';
import { exists } from './setup.mjs';
import { readConnections, loadConnections, MAX_CONNECTIONS } from './connections.mjs';
import { lanesStatus, unreadableEventId } from './lane-status.mjs';
import { coordinatorHeartbeatFresh } from './coordinator-heartbeat.mjs';

export const RESUME_LIMITS = Object.freeze({ pollMs: 2000, minPollMs: 1000, maxPollMs: 15000, globalCooldownMs: 120000,
  laneCooldownMs: 300000, windowMs: 3600000, globalPerHour: 6, lanePerHour: 3, logRecords: 128, eventRecords: 512 });
const fail = () => { throw new Error('coordinator resume safety check failed'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && value === path.resolve(value) && !/[\x00-\x1f]/.test(value);
const choices = ['none','claude','chatgpt','both'];
const enabled = choice => choice === 'both' ? ['claude','chatgpt'] : choice === 'none' ? [] : [choice];
const inside = (file, root) => { const r = path.relative(root, file); return r !== '' && !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); };
export function validateResumeConfig(value, configFile) {
  const keys = ['version','cwd','connectionsFolder','handoffFile','promptFile','cliClients','dryRun',
    'claudeExecutable','codexExecutable','claudeSession','claudeContinue','pollMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) ||
      value.version !== 1 || !choices.includes(value.cliClients) || typeof value.dryRun !== 'boolean' ||
      !['cwd','connectionsFolder','handoffFile','promptFile'].every(k => absolute(value[k])) ||
      !absolute(configFile) || !inside(value.promptFile, path.dirname(configFile))) fail();
  for (const key of ['claudeExecutable','codexExecutable']) if (value[key] !== undefined && !absolute(value[key])) fail();
  if (value.claudeSession !== undefined && (typeof value.claudeSession !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.claudeSession))) fail();
  if (value.claudeContinue !== undefined && typeof value.claudeContinue !== 'boolean') fail();
  if (value.claudeSession && value.claudeContinue) fail();
  if (value.pollMs !== undefined && (!Number.isSafeInteger(value.pollMs) ||
      value.pollMs < RESUME_LIMITS.minPollMs || value.pollMs > RESUME_LIMITS.maxPollMs)) fail();
  return Object.freeze({ ...value, pollMs: value.pollMs ?? RESUME_LIMITS.pollMs });
}
// `cycleFile` is the watchdog's current-cycle file. A cloud-only setup has no watchdog and so no such file: the text then has no cycle rule to obey.
export function resumePrompt({ handoffFile, cycleFile, cycleId }) {
  if (!absolute(handoffFile) || (cycleFile !== undefined && !absolute(cycleFile)) ||
      (cycleId !== undefined && (cycleFile === undefined || !Number.isSafeInteger(cycleId) || cycleId < 1))) fail();
  return 'POTS coordinator resume cycle' + (cycleId === undefined ? '' : ' cycleId=' + cycleId) +
    (cycleFile === undefined ? '' : '. Current-cycle authority: ' + JSON.stringify(cycleFile)) + '.\r\n' +
    (cycleFile === undefined ? '' : 'Before reading the handoff, on every wake-up, and immediately before work or scheduling, read that authority JSON (version 2, numeric cycleId). ' +
    (cycleId === undefined ? 'Use the cycleId bound by the watchdog; a reminder must retain its original cycleId, never adopt a newer one. ' : 'This invocation is bound to cycleId=' + cycleId + '; never adopt a newer cycleId. ') +
    'If the file is missing, unreadable, malformed, the cycleId is absent, or the current cycleId differs, do no work and exit with exactly one line: POTS resume superseded or unavailable.\r\n') +
    'Read the project handoff file: ' + JSON.stringify(handoffFile) + '\r\n' +
    'This is a fresh coordinator session; do not assume chat memory. Use only the configured bridge and normal user-approved authority. Do not steal controller ownership or bypass approvals.\r\n' +
    'Call bridge_lanes_status once for compact status of every registered lane. Before queueing work and on each cycle, call bridge_coordinator_heartbeat for each relevant connection using the existing controller authority; refresh at least every two minutes while directing work. If authority is missing, ask the owner; do not take it over.\r\n' +
    'For each needsAttention lane, inspect its result and handoff, close a completed window only through normal bridge controls, then queue the next authorized step. A receipt that is failed, malformed, aborted or expired needs the owner: never automatically replay, retry, or requeue it. A gone lane requires diagnosis, not blind replay. A stopped lane (stopped is true: a task was running and no bridge is running it any more) is continued with pots lane restore <name>, or with /bridge status then /bridge enable in its window if that window is still open; never queue a new step on it and never close its window.\r\n' +
    'Keep one directing coordinator. If another coordinator is active, stop. While anyRunning is true, schedule exactly one next wake-up at the shortest interval the client allows if supported; before scheduling, list and delete other pending ones. ' +
    (cycleFile === undefined ? '' : 'Bind the same cycleId and current-cycle authority path into that wake-up; stale or superseded wake-ups must exit in the one line above without work or rearming. ') +
    'Recheck status, refresh each relevant heartbeat, and tell the user. Stop rearming when nothing runs and delete pending wake-ups if supported. POTS cannot push to a closed chat; never claim otherwise. If tools, local files, or permission approvals are unavailable, report the blocker without inventing results.\r\n';
}
export function cloudResumePrompt({ client, handoffFile, cycleFile }) {
  if (!['claude','chatgpt'].includes(client)) fail();
  return 'Recurring ' + (client === 'claude' ? 'Claude scheduled task/routine' : 'ChatGPT Task') + ': start a fresh coordinator session at the shortest interval the client allows while work is active.\r\n' +
    'Best-effort cloud reminder only: a fresh session has no chat memory, may be unable to reach this local PC or bridge, and may stall at permission prompts. The opt-in local CLI watchdog is the reliable wake-up path. Do not claim access you do not have.\r\n' + resumePrompt({ handoffFile, cycleFile });
}

// Keep home/config locations for normal CLI login, but never forward ambient API
// keys, tokens, provider overrides, NODE_OPTIONS, or shell initialization hooks.
export function sanitizedResumeEnvironment(env = process.env) {
  const allowed = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOME',
    'APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','USERNAME','USERDOMAIN','LANG','LC_ALL']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
}
export async function isElevatedResumeToken({ platform = process.platform, env = process.env, exec = promisify(execFile) } = {}) {
  if (platform !== 'win32') return true;
  const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (!absolute(systemRoot)) return true;
  try {
    const { stdout } = await exec(path.join(systemRoot, 'System32', 'whoami.exe'), ['/groups','/fo','csv','/nh'],
      { windowsHide: true, timeout: 5000, maxBuffer: 65536, env: sanitizedResumeEnvironment(env) });
    // Unknown, high, system and protected-process integrity all fail closed.
    const levels = [...stdout.matchAll(/S-1-16-(\d+)/g)].map(match => Number(match[1]));
    return levels.length !== 1 || levels[0] !== 8192;
  } catch { return true; }
}

// Never execute .cmd/.ps1 text. Recognize only the standard npm package layout,
// validate its declared bin, then invoke the fixed JS entrypoint with Node.
export async function resolveResumeExecutable(client, configured, { env = process.env, platform = process.platform, node = process.execPath } = {}) {
  if (platform !== 'win32' || !['claude','chatgpt'].includes(client)) fail();
  const name = client === 'claude' ? 'claude' : 'codex';
  const packageName = client === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  const entry = client === 'claude' ? 'cli.js' : 'bin/codex.js';
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const candidates = configured ? [configured] : pathValue.split(';').flatMap(part => {
    const dir = part.replace(/^"(.*)"$/, '$1');
    return absolute(dir) && /^[a-z]:[\\/]/i.test(dir) ? [path.join(dir, name + '.exe'), path.join(dir, name + '.cmd')] : [];
  });
  for (const file of candidates) {
    try {
      if (!absolute(file)) continue;
      await plain(file);
      if (/\.exe$/i.test(file)) return { executable: file, prefix: [] };
      if (path.basename(file).toLowerCase() !== name + '.cmd') continue;
      const root = path.join(path.dirname(file), 'node_modules', ...packageName.split('/'));
      const metadata = await readJson(path.join(root, 'package.json'));
      const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[name];
      if (metadata.name !== packageName || ![entry, './' + entry].includes(bin)) continue;
      const script = path.join(root, ...entry.split('/'));
      await plain(script); await plain(node);
      return { executable: node, prefix: [script] };
    } catch { /* Missing, linked or unfamiliar shims are not executable. */ }
  }
  fail();
}
async function launchResumeClient({ command, args, prompt, cwd, env }, spawnChild = spawn) {
  return await new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { cwd, env, shell: false, detached: true,
      windowsHide: true, stdio: ['pipe','inherit','inherit'] });
    child.once('error', () => reject(new Error('coordinator resume launch failed')));
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      child.stdin.end(prompt);
      child.unref();
      resolve();
    });
  });
}
const connections = async (config, now) => (await loadConnections(await readConnections(config.connectionsFolder), () => now)).rows;
function validateState(value, now) {
  const legacy = value?.version === 1;
  if (!value || ![1,2].includes(value.version) ||
      Object.keys(value).sort().join() !== (legacy ? 'global,lanes,version' : 'cycleId,events,global,lanes,version') ||
      !Array.isArray(value.global) || !value.lanes || typeof value.lanes !== 'object' || Array.isArray(value.lanes) ||
      Object.keys(value.lanes).length > 64) fail();
  const times = (list, max) => {
    if (!Array.isArray(list) || list.length > max || list.some(time => !Number.isSafeInteger(time) || time < 0 || time > now)) fail();
    return list.filter(time => now - time < RESUME_LIMITS.windowMs).sort((a,b) => a-b);
  };
  const lanes = Object.create(null), events = Object.create(null);
  for (const [key, list] of Object.entries(value.lanes)) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail();
    const live = times(list, RESUME_LIMITS.lanePerHour);
    if (live.length) lanes[key] = live;
  }
  if (!legacy) {
    if (!Number.isSafeInteger(value.cycleId) || value.cycleId < 0 ||
        !value.events || typeof value.events !== 'object' || Array.isArray(value.events) || Object.keys(value.events).length > 64) fail();
    let count = 0;
    for (const [key, list] of Object.entries(value.events)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(list) || !list.length ||
          list.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(list).size !== list.length) fail();
      count += list.length;
      if (count > RESUME_LIMITS.eventRecords) fail();
      events[key] = list;
    }
  }
  return { version: 2, cycleId: legacy ? 0 : value.cycleId, global: times(value.global, RESUME_LIMITS.globalPerHour), lanes, events };
}
// `current` is every event that still asks for attention in this tick. Such an id is never forgotten, so an old finished event
// cannot become unseen again (and be launched twice) after other lanes have filled the ledger.
function rememberEvents(state, events, current = events) {
  const keep = new Set(current.map(({ id }) => id));
  for (const { key, id } of events) {
    const list = state.events[key] ||= [];
    if (!list.includes(id)) list.push(id);
  }
  // Bounded: the oldest remembered ids that nothing asks for any more go first, so a busy install cannot fill the ledger and stop wake-ups for good.
  const count = () => Object.values(state.events).reduce((sum, list) => sum + list.length, 0);
  let total = count();
  for (const [key, list] of Object.entries(state.events)) {
    if (total <= RESUME_LIMITS.eventRecords) break;
    for (let i = 0; i < list.length && total > RESUME_LIMITS.eventRecords;) { if (keep.has(list[i])) i++; else { list.splice(i, 1); total--; } }
    if (!list.length) delete state.events[key];
  }
  for (const [key, list] of Object.entries(state.events)) {
    if (Object.keys(state.events).length <= 64) break;
    if (!list.some(id => keep.has(id))) delete state.events[key];
  }
  if (Object.keys(state.events).length > 64 || count() > RESUME_LIMITS.eventRecords) fail();
}
const laneKey = row => crypto.createHash('sha256').update(row.connection + '\0' + row.lane).digest('hex');
const rateAllows = (list, now, cooldown, max) => list.length < max && (!list.length || now - list.at(-1) >= cooldown);

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// How long the watchdog's own log may stay unwritten before doctor calls the watchdog stopped (it is written every poll).
export const watchdogSilenceMs = pollMs => Math.max(30000, 6 * pollMs);
// A lock left by a crash, a kill or a reboot must not stop the watchdog for good. Its recorded process being gone proves it dead. A
// live number proves nothing (Windows reuses numbers after a restart), and the PC's uptime cannot be trusted either: Fast Startup keeps
// it running through a "shutdown", and a clock set forward makes any lock look older than the boot. So a live number is judged by the
// watchdog's own log, written every poll: a lock and a log both untouched for twice doctor's window, and still the same one poll
// later, belong to no running watchdog. Times are compared as distance from now, so a clock set back never reads as fresh, and a clock
// set forward is caught by the second look (a running watchdog has written a new row by then). A fresh lock (a watchdog that has
// just started and written nothing yet) is never taken. Without a readable owner the lock is dead once it is older than a few minutes.
// Returns null when the lock is not proven dead, else the owner note that was judged dead (empty when there is none).
async function lockIsDead(lock, owner, logFile, pollMs, sleep) {
  try {
    const stat = await fs.lstat(lock);
    if (!stat.isDirectory()) return null;
    const note = await fs.readFile(owner, 'utf8').catch(() => '');
    let pid;
    try { pid = JSON.parse(note).pid; } catch { /* empty or unreadable */ }
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 5 * 60000 ? note : null;
    if (!pidAlive(pid)) return note;
    const written = () => fs.stat(logFile).then(item => item.mtimeMs, () => 0);
    const quiet = log => [stat.mtimeMs, log].every(time => Math.abs(Date.now() - time) > 2 * watchdogSilenceMs(pollMs));
    const first = await written();
    if (!quiet(first)) return null;
    await sleep(2 * pollMs);
    const second = await written();
    if (second !== first || !quiet(second)) return null;
    // Another start may have taken the lock while this one waited: it must still be the very lock that was judged.
    const now = await fs.lstat(lock);
    return now.mtimeMs === stat.mtimeMs && await fs.readFile(owner, 'utf8').catch(() => '') === note ? note : null;
  } catch { return null; }
}
// Two starts can judge the same lock dead, and one may finish taking it while the other is still looking. So a dead lock is moved aside in
// one step (only one start can move it), and what was moved is checked against the note that was judged dead. A lock that carries any
// other note is a live start's new lock: it is put back and never removed. A lock that was proven dead is left aside, not deleted, unless it
// holds nothing but its note.
async function takeDeadLock(lock, judged, token) {
  const aside = `${lock}.dead-${token}`, note = path.join(aside, 'owner.json');
  // Look once more just before moving: a lock with another note was made by a start that is alive, and is not touched.
  if (await fs.readFile(path.join(lock, 'owner.json'), 'utf8').catch(() => '') !== judged) return;
  try { await fs.rename(lock, aside); } catch { return; } // another start moved it first
  if (await fs.readFile(note, 'utf8').catch(() => '') !== judged) {
    // It was a live start's new lock after all (the look above and the move are not one step): put it back. Windows can refuse for a
    // moment while the folder is in use; a lock that someone else has made in the meantime is not replaced.
    for (let tries = 0; tries < 8; tries++) {
      try { await fs.rename(aside, lock); return; } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return;
  }
  await fs.unlink(note).catch(() => {});
  await fs.rmdir(aside).catch(() => {});
}

// The launch log is one JSON record per line. A line that is cut off, garbled or not a record this version writes (an older version wrote
// the file in place, a power cut can stop a write half way, and an older build refused more than 16 lanes) is skipped and reported as
// `damaged`, so one bad line never stops the watchdog for good.
const validLogRow = row => Boolean(row) && typeof row === 'object' && !Object.keys(row).some(k => !['version','time','action','reason','client','laneCount'].includes(k)) &&
  row.version === 1 && Number.isSafeInteger(row.time) &&
  ['suppressed','reserved','launched','dry-run','failed'].includes(row.action) &&
  ['disabled','unconfigured','heartbeat','quiet','duplicate','rate-limit','elevated','config-changed','launch','safety'].includes(row.reason) &&
  (row.client === undefined || ['claude','chatgpt'].includes(row.client)) &&
  Number.isSafeInteger(row.laneCount) && row.laneCount >= 0 && row.laneCount <= MAX_CONNECTIONS;
export function parseLaunchLog(text) {
  const records = []; let damaged = false;
  for (const line of text.split('\n').filter(Boolean)) {
    let row; try { row = JSON.parse(line); } catch { /* cut off or garbled */ }
    if (validLogRow(row)) records.push(row); else damaged = true;
  }
  return { records, damaged };
}
// Rewrites a log whose last line is cut off without that line. Only call it while no watchdog is running.
export async function repairLaunchLog(control) {
  const file = path.join(control, 'launches.jsonl'), text = await fs.readFile(file, 'utf8').catch(() => '');
  const { records, damaged } = parseLaunchLog(text);
  if (!damaged) return false;
  await fs.writeFile(file + '.tmp', records.map(item => JSON.stringify(item)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
  return true;
}
export async function createResumeWatchdog(configFile, dependencies = {}) {
  configFile = path.resolve(configFile);
  const original = await readJson(configFile), config = validateResumeConfig(original, configFile);
  const deps = { now: Date.now, elevated: isElevatedResumeToken, loadConnections: connections,
    status: rows => lanesStatus(rows, { internal: true }), heartbeat: coordinatorHeartbeatFresh, resolve: resolveResumeExecutable,
    launch: launchResumeClient, persistState: writeJson, env: process.env, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...dependencies };
  const control = path.join(path.dirname(configFile), 'control');
  await plain(path.dirname(configFile), true);
  try { await fs.mkdir(control, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await plain(control, true);
  const lock = path.join(control, 'watchdog.lock'), owner = path.join(lock, 'owner.json');
  // A lock left by a crash, a kill or a reboot would stop the watchdog for good, so one thing is proven first: its recorded owner
  // process is gone, or its owner's log has gone silent. A lock without that proof is never taken. The lock is born complete: a folder
  // holding our owner note is renamed into place in one step, so a start that finds the lock in place never sees it half made, and
  // exactly one of two racing starts gets it.
  const token = crypto.randomUUID(), fresh = `${lock}.new-${token}`, note = JSON.stringify({ pid: process.pid, token });
  await fs.mkdir(fresh, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(fresh, 'owner.json'), note, { mode: 0o600 });
    // The lock can be moved away by another start between our failed step and the look at it: then we simply try to take it again.
    // A lock is judged once; after that, a lock that is still there belongs to someone else.
    let judgedBefore = false;
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(fresh, lock); break; } catch (error) {
        if (attempt >= 4) throw error;
        if (!await exists(lock)) continue;
        const judged = judgedBefore ? null : await lockIsDead(lock, owner, path.join(control, 'launches.jsonl'), config.pollMs, deps.sleep);
        judgedBefore = true;
        if (judged === null) throw Object.assign(new Error(`the watchdog lock is held: ${lock}`), { code: 'EEXIST' });
        await takeDeadLock(lock, judged, token);
      }
    }
  } finally { await fs.rm(fresh, { recursive: true, force: true }); }
  let closed = false, queue = Promise.resolve();
  const stateFile = path.join(control, 'state.json'), logFile = path.join(control, 'launches.jsonl');
  async function log(action, reason, now, client, laneCount = 0) {
    let records = [];
    if (await exists(logFile)) {
      const stat = await plain(logFile);
      if (stat.size > 65536) fail();
      records = parseLaunchLog(await fs.readFile(logFile, 'utf8')).records;
    }
    const row = { version: 1, time: now, action, reason, ...(client ? { client } : {}), laneCount };
    const text = [...records, row].slice(-RESUME_LIMITS.logRecords).map(item => JSON.stringify(item)).join('\n') + '\n';
    // Lock ownership serializes this bounded, content-free log. Never append
    // attacker-controlled error messages, paths, prompts, or CLI output.
    // Written to a temporary file and renamed, so a crash leaves the old complete log, never a cut-off one.
    await fs.writeFile(logFile + '.tmp', text, { mode: 0o600 });
    await fs.rename(logFile + '.tmp', logFile);
    return { action, reason, ...(client ? { client } : {}), laneCount };
  }
  async function tick() {
    if (closed) fail();
    const now = deps.now();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    const suppress = reason => log('suppressed', reason, now);
    // Dry-run never creates any child, including the native token probe.
    const dryRun = config.dryRun || deps.forceDryRun;
    if (await exists(path.join(control, 'disabled'))) return suppress('disabled');
    if (JSON.stringify(await readJson(configFile)) !== JSON.stringify(original)) return suppress('config-changed');
    const clients = enabled(config.cliClients);
    if (!clients.length) return suppress('unconfigured');
    const rows = await deps.loadConnections(config, now);
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_CONNECTIONS) fail();
    for (const row of rows) if (await deps.heartbeat(row.loaded.settings.root, now)) return suppress('heartbeat');
    const summary = await deps.status(rows);
    if (!Array.isArray(summary?.lanes) || summary.lanes.length > MAX_CONNECTIONS) fail();
    const attention = summary.lanes.filter(row => row.needsAttention === true);
    let stored = null, state;
    try {
      stored = await exists(stateFile) ? await readJson(stateFile) : null;
      state = stored ? validateState(stored, now) : { version: 2, cycleId: 0, global: [], lanes: Object.create(null), events: Object.create(null) };
    } catch (error) {
      // A quiet tick has nothing to remember or forget, so a state file that cannot be read right now does not end the watchdog.
      if (attention.length) throw error;
      return suppress('quiet');
    }
    // A lane that reads normally again forgets its "cannot be read" id, so the next time it cannot be read wakes the coordinator again.
    let forgot = false;
    for (const row of summary.lanes) {
      const id = unreadableEventId(row.lane), key = laneKey(row), list = state.events[key];
      if (!id || id === row.eventId || !list?.includes(id)) continue;
      list.splice(list.indexOf(id), 1); if (!list.length) delete state.events[key]; forgot = true;
    }
    if (forgot) await deps.persistState(stateFile, state);
    if (!attention.length) return suppress('quiet');
    for (const row of attention) if (typeof row.connection !== 'string' || !row.connection.length || row.connection.length > 128 ||
        typeof row.lane !== 'string' || !row.lane.length || row.lane.length > 128 ||
        typeof row.eventId !== 'string' || !/^[a-f0-9]{64}$/.test(row.eventId)) fail();
    const events = attention.map(row => ({ key: laneKey(row), id: row.eventId, connection: row.connection, lane: row.lane }));
    if (stored?.version === 1) {
      // Old state had no event identities. Conservatively baseline current
      // attention without launching; preserve every outstanding rate charge.
      rememberEvents(state, events);
      await deps.persistState(stateFile, state);
      return suppress('duplicate');
    }
    const unseen = events.filter(({ key, id }) => !state.events[key]?.includes(id));
    if (!unseen.length) return suppress('duplicate');
    if (!rateAllows(state.global, now, RESUME_LIMITS.globalCooldownMs, RESUME_LIMITS.globalPerHour)) return suppress('rate-limit');
    const eligible = unseen.filter(({ key }) => rateAllows(state.lanes[key] || [], now, RESUME_LIMITS.laneCooldownMs, RESUME_LIMITS.lanePerHour));
    if (!eligible.length) return suppress('rate-limit');
    // Select exactly one directing client, not one child per client/lane: the first configured one that can be found on this PC.
    let client = clients[0], resolved = null;
    await plain(config.cwd, true);
    await plain(config.handoffFile);
    const promptStat = await plain(config.promptFile);
    if (promptStat.size > 32768 || promptStat.size === 0) fail();
    const shipped = await fs.readFile(config.promptFile, 'utf8');
    // Always append the invariant protocol even if the owner edits the prompt.
    if (state.cycleId === Number.MAX_SAFE_INTEGER) fail();
    const cycleId = state.cycleId + 1;
    const prompt = shipped + '\r\n' + resumePrompt({ ...config, cycleFile: stateFile, cycleId }) +
      'Act only on these reserved lane events: ' + JSON.stringify(eligible.map(({ connection, id }) => ({ connection, eventId: id }))) +
      '. Other lanes are read-only observations in this invocation; do not act on an unreserved or changed eventId.\r\n';
    if (!dryRun) {
      client = undefined;
      for (const candidate of clients) {
        try { resolved = await deps.resolve(candidate, candidate === 'claude' ? config.claudeExecutable : config.codexExecutable, { env: deps.env }); client = candidate; break; } catch { /* try the next one */ }
      }
      if (!client) fail();
    }
    const args = client === 'claude' ? ['-p', ...(config.claudeSession ? ['--resume',config.claudeSession] : config.claudeContinue ? ['--continue'] : [])] : ['exec','-'];
    // Recheck externally mutable launch barriers immediately before reservation
    // and spawn, including the authority heartbeat for every registered lane.
    if (await exists(path.join(control, 'disabled'))) return suppress('disabled');
    if (JSON.stringify(await readJson(configFile)) !== JSON.stringify(original)) return suppress('config-changed');
    if (!dryRun && await deps.elevated()) return suppress('elevated');
    for (const row of rows) if (await deps.heartbeat(row.loaded.settings.root, deps.now())) return suppress('heartbeat');
    state.global.push(now);
    for (const key of new Set(eligible.map(row => row.key))) (state.lanes[key] ||= []).push(now);
    // Reserve only eligible lane events; the prompt's event allowlist prevents
    // another lane from bypassing its cooldown or hourly cap via this director.
    rememberEvents(state, eligible, events);
    state.cycleId = cycleId;
    // At most 64 lane keys are kept: the ones charged longest ago go first (their charge is about to expire anyway).
    while (Object.keys(state.lanes).length > 64) delete state.lanes[Object.keys(state.lanes).sort((a, b) => state.lanes[a].at(-1) - state.lanes[b].at(-1))[0]];
    await deps.persistState(stateFile, state);
    await log('reserved', 'launch', now, client, eligible.length);
    if (await exists(path.join(control, 'disabled'))) return suppress('disabled');
    // Reservation and log I/O can overlap a real coordinator becoming active.
    // Recheck after both writes; a suppressed attempt conservatively keeps quota.
    if (JSON.stringify(await readJson(configFile)) !== JSON.stringify(original)) return suppress('config-changed');
    if (JSON.stringify(await readJson(stateFile)) !== JSON.stringify(state)) fail();
    if (!dryRun && await deps.elevated()) return suppress('elevated');
    for (const row of rows) if (await deps.heartbeat(row.loaded.settings.root, deps.now())) return suppress('heartbeat');
    if (dryRun) return log('dry-run', 'launch', now, client, eligible.length);
    try {
      await deps.launch({ command: resolved.executable, args: [...resolved.prefix, ...args], prompt,
        cwd: config.cwd, env: sanitizedResumeEnvironment(deps.env) });
      return log('launched', 'launch', now, client, eligible.length);
    } catch { return log('failed', 'launch', now, client, eligible.length); }
  }
  return {
    pollMs: config.pollMs,
    cycleFile: stateFile,
    tick() {
      const result = queue.then(tick).catch(async () => log('suppressed', 'safety', deps.now()));
      queue = result.catch(() => {});
      return result;
    },
    async close() {
      await queue;
      if (closed) return;
      closed = true;
      // Only our own lock is removed: if another start has since taken the lock, its note differs and it is left alone.
      if (await fs.readFile(owner, 'utf8').catch(() => null) !== note) return;
      await unlinkRetry(owner);
      await fs.rmdir(lock);
    },
  };
}
export async function runResumeWatchdog(argv, dependencies = {}) {
  let configFile, once = false, dryRun = false, disable = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && !configFile && absolute(argv[i + 1])) configFile = argv[++i];
    else if (argv[i] === '--once' && !once) once = true;
    else if (argv[i] === '--dry-run' && !dryRun) dryRun = true;
    else if (argv[i] === '--disable' && !disable) disable = true;
    else fail();
  }
  if (!configFile) fail();
  if (disable) {
    if (once || dryRun) fail();
    // Disabling needs no config contents, CLI credentials, token probe, or
    // watchdog lock. A marker with words in it is never truncated or replaced;
    // an empty one (an unfinished install's own note) gets the words appended, so it becomes the owner's.
    const root = path.dirname(configFile), control = path.join(root, 'control');
    await plain(root, true);
    try { await fs.mkdir(control, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await plain(control, true);
    const marker = path.join(control, 'disabled');
    let handle;
    try { handle = await fs.open(marker, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await plain(marker); handle = await fs.open(marker, 'a'); }
    try {
      if ((await handle.stat()).size === 0) { await handle.writeFile('POTS coordinator resume disabled.\r\n'); await handle.sync(); }
    } finally { await handle.close(); }
    return { action: 'disabled', reason: 'disabled' };
  }
  // CLI dry-run is an override, never an on-disk config mutation.
  const watchdog = await createResumeWatchdog(configFile, { ...dependencies, forceDryRun: dryRun });
  try {
    if (once) return await watchdog.tick();
    const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    while (!dependencies.signal?.aborted) {
      const result = await watchdog.tick();
      if (result.reason === 'disabled' || result.reason === 'config-changed') break;
      await sleep(watchdog.pollMs);
    }
  } finally { await watchdog.close(); }
}
