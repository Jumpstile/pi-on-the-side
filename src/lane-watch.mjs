import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, plain, readJson, unlinkRetry, writeJson } from './control.mjs';
import { readLaneEvents } from './lane-status.mjs';

// Lane watcher: tells a coordinator, within seconds and with zero network and
// zero model calls, that a lane (a) finished its turn and stayed idle, (b) is
// busy again, (c) wrote its result files or (d) lost its OMP process.
//
// It adds no process. While `bridge start` runs OMP in the foreground, this
// module runs inside that same wrapper process on one unref'd timer, so it
// starts with the lane and ends with it. Source of truth: the bridge's own
// lane-event feed (control/lane-events.jsonl; the bridge samples OMP every 2 s,
// so an event is recorded up to 2 s after the change). Fallback only when that
// feed stays silent: the OMP log line
// `agent_end maintenance routing` (heuristic; see docs/lane-watch.md).
//
// Files, all inside the lane's private control folder, all content-free:
//   lane-watch.json         owner settings (optional; defaults apply if absent)
//   lane-watch.log(.1)      append-only change log, <= 64 KiB per file
//   lane-watch-state.json   latest state, replaced atomically
//   lane-watch-cursor.json  last log sequence the coordinator has been shown

export const WATCH_FILES = Object.freeze({ settings: 'lane-watch.json', log: 'lane-watch.log', state: 'lane-watch-state.json', cursor: 'lane-watch-cursor.json' });
const WATCH_KINDS = Object.freeze(['START', 'STOP', 'IDLE', 'BUSY', 'RESULT', 'GONE', 'ERROR', 'EXPIRED']);
// Informational markers; the coordinator-facing reader never prints them.
const QUIET_KINDS = new Set(['START', 'STOP']);
export const WATCH_LIMITS = Object.freeze({ minPollMs: 1000, maxPollMs: 60000, minIdleMs: 2000, maxIdleMs: 600000, logBytes: 65536,
  settleMs: 2000, fallbackAfterMs: 30000, fallbackQuietMs: 15000, maxFolders: 4, maxFiles: 4, maxEntries: 2000, outputLines: 100,
  stateHeartbeatMs: 15000, logTailBytes: 65536, pending: 64 });
export const WATCH_DEFAULTS = Object.freeze({ version: 1, enabled: true, pollMs: 5000, idleMs: 8000,
  resultFiles: Object.freeze(['RESULT.md', 'HASHES.json']), resultFolders: Object.freeze([]) });
export const WATCH_ERRORS = Object.freeze(['invalid lane watch settings', 'invalid lane watch line', 'lane watch records differ; inspect locally']);

const fail = message => { throw new Error(message); };
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELD_KEY = /^[a-z]{1,12}$/;
const FIELD_VALUE = /^[A-Za-z0-9._:+-]{1,64}$/;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const iso = ms => new Date(ms).toISOString();
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && value === path.resolve(value) && !/[\x00-\x1f]/.test(value);

// ---- Log line format (stable, documented in docs/lane-watch.md) -------------
//   <UTC time, ms> <seq> <KIND> [key=value ...]
//   2026-11-06T13:05:07.123Z 41 IDLE pid=4242 since=2026-11-06T13:04:57.100Z src=events
// One line per change; keys are [a-z]{1,12}; values are [A-Za-z0-9._:+-]{1,64}.
export function formatWatchLine({ time, seq, kind, fields = {} }) {
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(seq) || seq < 1 || !WATCH_KINDS.includes(kind)) fail('invalid lane watch line');
  const parts = [iso(time), String(seq), kind];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (!FIELD_KEY.test(key) || !FIELD_VALUE.test(text)) fail('invalid lane watch line');
    parts.push(`${key}=${text}`);
  }
  return parts.join(' ');
}
export function parseWatchLine(line) {
  if (typeof line !== 'string' || line.length > 512) return null;
  const [stamp, seqText, kind, ...rest] = line.split(' ');
  if (!STAMP.test(stamp ?? '') || !/^[1-9]\d{0,14}$/.test(seqText ?? '') || !WATCH_KINDS.includes(kind)) return null;
  const time = Date.parse(stamp), fields = Object.create(null);
  if (!Number.isFinite(time)) return null;
  for (const part of rest) {
    const at = part.indexOf('=');
    if (at < 1) return null;
    const key = part.slice(0, at), value = part.slice(at + 1);
    if (!FIELD_KEY.test(key) || !FIELD_VALUE.test(value) || key in fields) return null;
    fields[key] = value;
  }
  return { time, seq: Number(seqText), kind, fields: { ...fields } };
}

// ---- Settings ----------------------------------------------------------------
const SETTING_KEYS = ['version', 'enabled', 'pollMs', 'idleMs', 'resultFiles', 'resultFolders'];
export function validateWatchSettings(value) {
  if (value === undefined) return { ...WATCH_DEFAULTS, resultFiles: [...WATCH_DEFAULTS.resultFiles], resultFolders: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !SETTING_KEYS.includes(key))) fail(WATCH_ERRORS[0]);
  const merged = { ...WATCH_DEFAULTS, ...value };
  const ok = merged.version === 1 && typeof merged.enabled === 'boolean' &&
    Number.isSafeInteger(merged.pollMs) && merged.pollMs >= WATCH_LIMITS.minPollMs && merged.pollMs <= WATCH_LIMITS.maxPollMs &&
    Number.isSafeInteger(merged.idleMs) && merged.idleMs >= WATCH_LIMITS.minIdleMs && merged.idleMs <= WATCH_LIMITS.maxIdleMs &&
    Array.isArray(merged.resultFiles) && merged.resultFiles.length >= 1 && merged.resultFiles.length <= WATCH_LIMITS.maxFiles &&
    merged.resultFiles.every(name => typeof name === 'string' && FILE_NAME.test(name)) &&
    new Set(merged.resultFiles.map(name => name.toLowerCase())).size === merged.resultFiles.length &&
    Array.isArray(merged.resultFolders) && merged.resultFolders.length <= WATCH_LIMITS.maxFolders && merged.resultFolders.every(absolute);
  if (!ok) fail(WATCH_ERRORS[0]);
  return { version: 1, enabled: merged.enabled, pollMs: merged.pollMs, idleMs: merged.idleMs, resultFiles: [...merged.resultFiles], resultFolders: [...merged.resultFolders] };
}
const controlFolder = root => path.join(root, 'control');
export async function readWatchSettings(root) {
  try { return validateWatchSettings(await readJson(path.join(controlFolder(root), WATCH_FILES.settings))); }
  catch (error) { if (error.code === 'ENOENT') return validateWatchSettings(); throw error; }
}
// Installer step: create the owner-editable defaults once; never overwrite an existing file.
export async function ensureWatchSettings(root) {
  const file = path.join(controlFolder(root), WATCH_FILES.settings);
  try { await writeJson(file, WATCH_DEFAULTS, true); return { file, created: true }; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    validateWatchSettings(await readJson(file));
    return { file, created: false };
  }
}

// ---- Pure state machine --------------------------------------------------------
// One machine per lane. Input per observation:
//   signal  latest {kind:'idle'|'busy', time, pid} or null;  src 'events'|'omplog'
//   alive   false once the OMP process is gone;  results  [{key,prefix,complete,settled,signature}] or null
// Output: [{kind, fields}] lines to append. Lines are stamped with the time the
// change was noticed; IDLE also carries since= (when the turn ended).
export function createWatchMachine({ idleMs }) {
  return { idleMs, phase: 'new', endedAt: null, pid: null, src: null, seen: new Map(), baselined: false, lastResult: null };
}
export function stepWatchMachine(m, { now, signal = null, src = 'events', alive = true, goneReason = 'lost', code, pid, results = null }) {
  const out = [];
  if (m.phase === 'gone') return out;
  if (signal) { m.pid = signal.pid ?? pid ?? m.pid; m.src = src; } else if (pid) m.pid ??= pid;
  if (alive && signal) {
    if (signal.kind === 'busy') {
      if (m.phase === 'idle') out.push({ kind: 'BUSY', fields: { pid: m.pid, src: m.src } });
      m.phase = 'busy'; m.endedAt = null;
    } else if (m.phase === 'new' || m.phase === 'busy') { m.phase = 'ending'; m.endedAt = signal.time; }
    else if (signal.time > m.endedAt) {
      // A newer turn end while already reported idle or pending: the lane worked in between.
      if (m.phase === 'idle') out.push({ kind: 'BUSY', fields: { pid: m.pid, src: m.src } });
      m.phase = 'ending'; m.endedAt = signal.time;
    }
  }
  if (alive && m.phase === 'ending' && now - m.endedAt >= m.idleMs) {
    out.push({ kind: 'IDLE', fields: { pid: m.pid, since: iso(m.endedAt), src: m.src } });
    m.phase = 'idle';
  }
  if (results) {
    for (const row of results) {
      if (!row.complete || !row.settled || m.seen.get(row.key) === row.signature) continue;
      m.seen.set(row.key, row.signature);
      // Groups already complete when the watcher started are the baseline, not news.
      if (m.baselined) { out.push({ kind: 'RESULT', fields: { prefix: row.prefix, files: row.files } }); m.lastResult = { prefix: row.prefix, time: now }; }
    }
    m.baselined = true;
  }
  if (!alive) {
    out.push({ kind: 'GONE', fields: { pid: m.pid ?? pid, reason: goneReason, code } });
    m.phase = 'gone';
  }
  return out;
}
const STATE_NAMES = { new: 'not_seen_yet', busy: 'busy', ending: 'ending', idle: 'idle', gone: 'gone' };

// ---- Result files --------------------------------------------------------------
// A result is a group of configured file names sharing one prefix: the bare names
// (RESULT.md + HASHES.json) or prefixed ones (REPORT-RESULT.md + REPORT-HASHES.json;
// prefix and name joined by - or _). It is reported once all files exist and have
// stopped changing, and again if a completed group is rewritten.
const cleanPrefix = value => (value.replace(/[^A-Za-z0-9._:+-]/g, '_').slice(0, 64)) || '-';
export function groupResultFiles(entries, files, folderIndex = 0) {
  const groups = new Map();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    files.forEach((file, index) => {
      const want = file.toLowerCase();
      let prefix;
      if (lower === want) prefix = '';
      else if (lower.endsWith('-' + want) || lower.endsWith('_' + want)) prefix = entry.name.slice(0, entry.name.length - want.length - 1);
      else return;
      const key = `${folderIndex}:${prefix.toLowerCase()}`;
      const group = groups.get(key) ?? { key, prefix: cleanPrefix(prefix), found: new Map() };
      group.found.set(index, entry);
      groups.set(key, group);
    });
  }
  return [...groups.values()].map(group => {
    const rows = [...group.found.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
    return { key: group.key, prefix: group.prefix, complete: group.found.size === files.length, files: group.found.size,
      newest: Math.max(...rows.map(row => row.mtimeMs)), signature: rows.map(row => `${row.name}:${row.size}:${row.mtimeMs}`).join('|') };
  });
}
async function scanResultFolders(folders, files, now, settleMs) {
  const rows = [];
  for (const [index, folder] of folders.entries()) {
    let names;
    try { await plain(folder, true); names = await fs.readdir(folder); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const entries = [];
    const wanted = files.map(file => file.toLowerCase());
    const matches = names.filter(name => { const lower = name.toLowerCase(); return wanted.some(file => lower === file || lower.endsWith('-' + file) || lower.endsWith('_' + file)); });
    for (const name of matches.slice(0, WATCH_LIMITS.maxEntries)) {
      try {
        const stat = await fs.lstat(path.join(folder, name));
        if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ name, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const group of groupResultFiles(entries, files, index)) {
      rows.push({ ...group, settled: now - group.newest >= settleMs || group.newest > now + 3600000 });
    }
  }
  return rows;
}

// ---- OMP log fallback ------------------------------------------------------------
// Heuristic used only when the lane-event feed stays silent. The turn counts as
// ended at the last `agent_end maintenance routing` row (route `entered`), and the
// lane as busy again when a later non-noise row is more than 15 s newer.
const OMP_NOISE = /suppressed by emission guard|Usage fetch|claude-auto-reset|ui.loop-blocked/;
export function ompLogSignal(text) {
  let last = null, end = null;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || typeof row.message !== 'string' || typeof row.timestamp !== 'string' || OMP_NOISE.test(row.message)) continue;
    const time = Date.parse(row.timestamp);
    if (!Number.isFinite(time)) continue;
    last = time;
    if (row.message === 'agent_end maintenance routing' && row.route === 'entered') end = time;
  }
  if (end === null || last === null) return null;
  return last <= end + WATCH_LIMITS.fallbackQuietMs ? { kind: 'idle', time: end } : { kind: 'busy', time: last };
}
const defaultOmpLogFolder = () => path.join(os.homedir(), '.omp', 'logs');
async function readOmpLogSignal(folder, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  await plain(folder, true); // A linked log folder or log file is never followed.
  let best = null;
  const suffix = `.${pid}.log`;
  for (const name of await fs.readdir(folder)) {
    if (!/^omp\.[0-9-]+\.\d+\.log$/.test(name) || !name.endsWith(suffix)) continue;
    const file = path.join(folder, name);
    let stat;
    try { stat = await plain(file); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  if (!best) return null;
  const handle = await fs.open(best.file, 'r');
  try {
    const length = Math.min(best.size, WATCH_LIMITS.logTailBytes), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, best.size - length);
    return ompLogSignal(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

// ---- Log files ---------------------------------------------------------------------
// The writer may rotate (current file becomes `.1`) between the two reads, which would hide the moved lines. A rotation
// replaces `.1`, so if it changed while reading, the read is repeated.
async function backupIdentity(directory) {
  try { const stat = await plain(path.join(directory, WATCH_FILES.log + '.1')); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
  catch (error) { if (error.code === 'ENOENT') return 'none'; throw error; }
}
async function readLog(directory) {
  for (let attempt = 0; ; attempt++) {
    const before = await backupIdentity(directory), rows = [];
    for (const name of [WATCH_FILES.log + '.1', WATCH_FILES.log]) {
      const file = path.join(directory, name);
      try {
        const stat = await plain(file);
        if (stat.size > 2 * WATCH_LIMITS.logBytes) fail(WATCH_ERRORS[2]);
        for (const raw of (await fs.readFile(file, 'utf8')).split('\n')) {
          const parsed = raw ? parseWatchLine(raw) : null;
          if (parsed) rows.push({ raw, ...parsed });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (attempt < 3 && await backupIdentity(directory) !== before) continue;
    rows.sort((a, b) => a.seq - b.seq);
    return { rows, maxSeq: rows.reduce((max, row) => Math.max(max, row.seq), 0) };
  }
}
async function appendLogLine(directory, text) {
  await plain(directory, true);
  const file = path.join(directory, WATCH_FILES.log), backup = file + '.1', bytes = Buffer.byteLength(text) + 1;
  let size = 0;
  try { size = (await plain(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size > 0 && size + bytes > WATCH_LIMITS.logBytes) {
    await fs.unlink(backup).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rename(file, backup);
  }
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(text + '\n'); } finally { await handle.close(); }
}

const STATE_KEYS = ['version', 'updatedAt', 'state', 'since', 'pid', 'source', 'watcherPid', 'startedAt', 'lastSeq', 'pollMs', 'idleMs', 'lastResult', 'error'];
const intOrNull = value => value === null || (Number.isSafeInteger(value) && value >= 0);
function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...STATE_KEYS].sort().join() &&
    value.version === 1 && Number.isSafeInteger(value.updatedAt) && Object.values(STATE_NAMES).includes(value.state) &&
    intOrNull(value.since) && intOrNull(value.pid) && [null, 'events', 'omplog'].includes(value.source) && Number.isSafeInteger(value.watcherPid) &&
    Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.lastSeq) && Number.isSafeInteger(value.pollMs) && Number.isSafeInteger(value.idleMs) &&
    (value.lastResult === null || (typeof value.lastResult?.prefix === 'string' && Number.isSafeInteger(value.lastResult.time))) &&
    (value.error === null || ['read', 'scan', 'write'].includes(value.error));
}
// The watcher replaces this file atomically; a read that lands on the swap ("file changed") is simply read again.
export async function readWatchState(root) {
  for (let attempt = 0; ; attempt++) {
    try { const value = await readJson(path.join(controlFolder(root), WATCH_FILES.state)); if (value?.state === 'unknown') value.state = 'not_seen_yet'; /* written by an older version */ return validState(value) ? value : null; }
    catch (error) { if (error.code === 'ENOENT') return null; if (error?.message === 'file changed' && attempt < 4) continue; throw error; }
  }
}

// ---- The watcher (runs inside `bridge start`) ------------------------------------------
export function createLaneWatch({ root, sessionId, settings, now = Date.now, readEvents = readLaneEvents, ompLogFolder = defaultOmpLogFolder(),
  watcherPid = process.pid, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const directory = controlFolder(root), folders = settings.resultFolders;
  const startedAt = now(), machine = createWatchMachine({ idleMs: settings.idleMs });
  let seq = 0, timer, inflight = Promise.resolve(), stopped = false, started = false, childPid = null, usedEvents = false; const expiredSeen = new Set();
  let pending = [], failure = null, writeFailed = false, lastState = '', lastStateAt = 0, lastSeq = 0;
  const lines = rows => { for (const row of rows) { if (pending.length >= WATCH_LIMITS.pending) pending.shift(); pending.push({ time: now(), ...row }); } };
  async function flush() {
    while (pending.length) {
      const row = pending[0];
      await appendLogLine(directory, formatWatchLine({ time: row.time, seq: seq + 1, kind: row.kind, fields: row.fields }));
      seq++; lastSeq = seq; pending.shift();
    }
  }
  function record() {
    return { version: 1, updatedAt: now(), state: STATE_NAMES[machine.phase], since: machine.endedAt ?? null, pid: machine.pid ?? null, source: machine.src ?? null,
      watcherPid, startedAt, lastSeq, pollMs: settings.pollMs, idleMs: settings.idleMs, lastResult: machine.lastResult ?? null, error: failure ?? (writeFailed ? 'write' : null) };
  }
  async function writeState(force) {
    const value = record(), body = JSON.stringify({ ...value, updatedAt: 0 }), time = now();
    if (!force && body === lastState && time - lastStateAt < WATCH_LIMITS.stateHeartbeatMs) return;
    await writeJson(path.join(directory, WATCH_FILES.state), value);
    lastState = body; lastStateAt = time;
  }
  async function observe(finalTick, exit) {
    const time = now();
    let signal = null, src = 'events', results = null, problem = null;
    if (!finalTick) {
      try {
        const all = await readEvents(root, sessionId), events = all.filter(row => (row.event === 'idle' || row.event === 'busy') && row.time >= startedAt);
        // A queued task that never started because its time ran out is reported once (plan id only, no task text).
        for (const row of all) if (row.event === 'plan_done' && row.reason === 'expired_before_submission' && row.time >= startedAt && typeof row.planId === 'string' && !expiredSeen.has(row.planId)) { expiredSeen.add(row.planId); lines([{ kind: 'EXPIRED', fields: { plan: row.planId } }]); }
        const last = events.at(-1);
        if (last) { signal = { kind: last.event, time: last.time, pid: last.pid }; usedEvents = true; }
      } catch { problem = 'read'; }
      if (!signal && !usedEvents && childPid && time - startedAt >= WATCH_LIMITS.fallbackAfterMs) {
        try { signal = await readOmpLogSignal(ompLogFolder, childPid); src = 'omplog'; } catch { /* Fallback is best effort; the feed is the contract. */ }
      }
    }
    try { results = await scanResultFolders(folders, settings.resultFiles, time, finalTick ? 0 : WATCH_LIMITS.settleMs); }
    catch { problem ??= 'scan'; }
    lines(stepWatchMachine(machine, { now: time, signal, src, alive: !finalTick, goneReason: exit?.reason, code: exit?.code, pid: childPid ?? undefined, results }));
    // Read/scan problems are reported once per episode, not once per poll.
    if (problem !== failure) {
      if (problem) lines([{ kind: 'ERROR', fields: { reason: problem } }]);
      failure = problem;
    }
    try { await flush(); writeFailed = false; } catch { writeFailed = true; }
    try { await writeState(finalTick); } catch { writeFailed = true; }
  }
  const run = (finalTick, exit) => { inflight = inflight.then(() => observe(finalTick, exit), () => observe(finalTick, exit)); return inflight; };
  function loop() {
    if (stopped) return;
    timer = setTimer(() => { run(false).catch(() => {}).then(loop); }, settings.pollMs);
    timer.unref?.();
  }
  return {
    status: 'running', settings,
    // The OMP child's process id, used only to find its log for the fallback.
    setChildPid(pid) { if (Number.isSafeInteger(pid) && pid > 0) childPid = pid; },
    tick: () => run(false),
    async start() {
      if (started) return;
      await plain(directory, true); // An unusable control folder means the watcher cannot report: refuse to start.
      started = true;
      seq = (await readLog(directory)).maxSeq; lastSeq = seq;
      lines([{ kind: 'START', fields: { pid: watcherPid, poll: settings.pollMs, idle: settings.idleMs } }]);
      await run(false);
      loop();
    },
    // Called when OMP has exited (or never started): reports the result files that
    // landed just before exit, then GONE and STOP, and releases the timer.
    async stop({ exitCode } = {}) {
      if (stopped || !started) return;
      stopped = true; clearTimer(timer);
      await inflight.catch(() => {});
      await run(true, { reason: 'exit', code: Number.isSafeInteger(exitCode) && exitCode >= 0 ? exitCode : undefined });
      lines([{ kind: 'STOP', fields: { pid: watcherPid } }]);
      try { await flush(); await writeState(true); } catch { /* A failed final write is visible as a missing STOP. */ }
    },
  };
}
const idle = { status: 'off', setChildPid() {}, tick: async () => {}, start: async () => {}, stop: async () => {} };
// Lane start entry point: never throws, never blocks OMP. `status` tells the caller what happened.
export async function startLaneWatch(options) {
  let settings;
  try { settings = await readWatchSettings(options.root); } catch { return { ...idle, status: 'invalid' }; }
  if (!settings.enabled) return { ...idle, status: 'disabled' };
  const watch = createLaneWatch({ ...options, settings: { ...settings, resultFolders: settings.resultFolders.length ? settings.resultFolders : [options.cwd] } });
  try { await watch.start(); } catch { await watch.stop().catch(() => {}); return { ...idle, status: 'failed' }; }
  return watch;
}

// ---- Coordinator side -------------------------------------------------------------------
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Same swap as the state file: a read that lands on it ("file changed") is simply read again.
async function readCursor(directory) {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await readJson(path.join(directory, WATCH_FILES.cursor));
      return value?.version === 1 && Object.keys(value).sort().join() === 'seq,version' && Number.isSafeInteger(value.seq) && value.seq >= 0 ? value.seq : 0;
    } catch (error) { if (error.code === 'ENOENT') return 0; if (error?.message === 'file changed' && attempt < 4) continue; throw error; }
  }
}
// Returns the lines not yet shown for the given lanes, oldest first, and advances each
// lane's cursor unless `peek`. At most `max` lines per call: when more are waiting, at most
// `max` are returned, in log order, and each cursor stops right after what was returned, so no line
// is ever skipped and the rest arrives on the next call. A lane whose watcher died without
// a trace (the wrapper was killed) gets one GONE reason=lost line, appended here.
// A lane whose files cannot be read is named in `unreadable`; a lane whose place cannot be saved is named in `unsaved`.
// The other lanes are still shown.
export async function readNewWatchLines(rows, { peek = false, now = Date.now, alive = isProcessAlive, max = WATCH_LIMITS.outputLines } = {}) {
  const collected = [], cursors = [], unreadable = [], unsaved = [];
  for (const { name, loaded } of rows) try {
    const root = loaded.settings.root, directory = controlFolder(root);
    let log;
    try { log = await readLog(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let state = await readWatchState(root);
    const lost = () => state && state.state !== 'gone' && !alive(state.watcherPid);
    const addGone = async write => {
      // A call that wrote this line but could not save the state left it as the last line: only the state is saved again, so the line is never written twice.
      const last = log.rows.at(-1), written = last?.kind === 'GONE' && last.fields.reason === 'lost';
      const row = written ? last : { time: now(), seq: log.maxSeq + 1, kind: 'GONE', fields: { pid: state.pid ?? undefined, reason: 'lost' } };
      const raw = written ? last.raw : formatWatchLine(row);
      if (write) {
        if (!written) await appendLogLine(directory, raw);
        await writeJson(path.join(directory, WATCH_FILES.state), { ...state, updatedAt: row.time, state: 'gone', lastSeq: row.seq });
      }
      if (!written) { log.rows.push({ raw, ...parseWatchLine(raw) }); log.maxSeq = row.seq; }
    };
    if (lost()) {
      if (peek) await addGone(false); // a peek shows the line the next real read writes, and writes nothing itself
      else {
        // Two readers meeting a dead watcher must write one GONE line between them: the second one waits, then finds it already there.
        const lockFile = path.join(directory, 'lane-watch-gone.lock');
        // A live reader holds this lock for two file writes; one a minute older, or a minute ahead of the clock (the clock was set back), is a crashed reader's and would hide the line for good.
        if (await fs.lstat(lockFile).then(stat => Math.abs(Date.now() - stat.mtimeMs) > 60000, () => false)) await unlinkRetry(lockFile);
        let lock = null;
        for (let tries = 0; !lock && tries < 40; tries++) {
          try { lock = await acquireLock(lockFile); }
          catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        try {
          log = await readLog(directory); state = await readWatchState(root);
          if (lock && lost()) await addGone(true);
        } finally { if (lock) { await lock.close(); await unlinkRetry(lockFile); } }
      }
    }
    let seen = await readCursor(directory);
    if (seen > log.maxSeq) seen = 0; // The log was recreated; sequence numbers restarted.
    // Order by a per-lane running maximum of the time so a lane's lines always keep their sequence order.
    let order = 0;
    for (const row of log.rows) {
      order = Math.max(order, row.time);
      if (row.seq > seen && !QUIET_KINDS.has(row.kind)) collected.push({ name, order, ...row });
    }
    cursors.push({ name, directory, maxSeq: log.maxSeq, seen });
  } catch (error) { if (WATCH_ERRORS.includes(error?.message)) throw error; unreadable.push(name); } // damaged records still get their plain message; a file that cannot be opened only names its lane
  collected.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.seq - b.seq);
  // A lane whose cursor cannot be saved is named and the lines past its saved place are held back (they come again on the next call);
  // the other lanes are shown and advanced. A line is never shown without its cursor moving past it, never skipped, and never shown twice:
  // lines up to a place an earlier pass already saved are returned even when a later save fails, because the next call starts after them.
  // Those lines take room in the cap (the other lanes show that much less and wait for the next call), so a call returns at most `max` lines.
  // Held lanes take no other room, so the pass repeats without them until no further lane is held.
  const held = new Set(), saved = new Map();
  let shown, rest;
  for (;;) {
    const owed = collected.filter(row => held.has(row.name) && row.seq <= (saved.get(row.name) ?? 0)).length;
    const open = collected.filter(row => !held.has(row.name)), lastShown = new Map(), waiting = new Set();
    shown = open.slice(0, Math.max(0, max - owed)); rest = open.slice(shown.length);
    for (const row of shown) lastShown.set(row.name, row.seq);
    for (const row of rest) waiting.add(row.name);
    if (peek) break;
    const before = held.size;
    for (const cursor of cursors) {
      if (held.has(cursor.name)) continue;
      const next = waiting.has(cursor.name) ? (lastShown.get(cursor.name) ?? cursor.seen) : cursor.maxSeq;
      if (next === (saved.get(cursor.name) ?? cursor.seen)) continue;
      try { await writeJson(path.join(cursor.directory, WATCH_FILES.cursor), { version: 1, seq: next }); saved.set(cursor.name, next); } catch { held.add(cursor.name); unsaved.push(cursor.name); }
    }
    if (held.size === before) break;
  }
  // `more` only when calling again can help: lines of a lane whose cursor cannot be saved come back unchanged, so they never count.
  const kept = new Set(shown), lines = collected.filter(row => kept.has(row) || (held.has(row.name) && row.seq <= (saved.get(row.name) ?? 0)));
  return { lines: lines.map(row => `${row.name} ${row.raw}`), more: rest.length > 0, unreadable, unsaved };
}
// Latest state per lane (the "what is each lane doing right now" view).
export async function readWatchStates(rows) {
  const states = [];
  for (const { name, loaded } of rows) states.push({ connection: name, ...(await readWatchState(loaded.settings.root) ?? { state: 'none' }) });
  return states;
}
