import {windowsPermissions,registerInstallation,trackClaudeCode,claudeIntegration,trackAssistants,windowsRegistry,uninstallDefaults,REVIEW} from './uninstall.mjs';
export {windowsPermissions} from './uninstall.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { acquireLock, plain, readJson, same, unlinkRetry, writeJson, Store } from './control.mjs';
import { sessionIdentity } from './transcript.mjs';
import { CHECKOUT, diagnostic, discardUnstarted, exists, loadSetup, nodeSupported, requireHost, restoreConfig, setup, MESSAGES, MARKER, isManagedRoot, defaultRootBase, defaultRootStates } from './setup.mjs';
import { createCredential, acquireController, CONTROLLER_ERRORS } from './controller.mjs';
import { detectHost } from './host.mjs';
import { windowsProcesses } from './live.mjs';
import { NAME, MAX_CONNECTIONS, CONNECTION_ERRORS, readConnections, registerConnection, closeConnection, loadConnection, dropUnavailableConnections } from './connections.mjs';
import { compareVersions, isOurLauncher, prepareManagedRuntime, startCheck, UPGRADE_ERRORS, MESSAGES as UPDATE_MESSAGES } from './update.mjs';
import { configureAssistants, windowsTasks } from './clients.mjs';
import { resumeOptions, installCoordinatorResume, autoResumeOptions, applyResumeTask, logProblem, selfTest, wakeupsOffFile, wakeupsOnFile, WAKEUPS_ON_AGAIN, WAKEUPS_FORGOTTEN } from './coordinator-resume-setup.mjs';
import { ensureWatchSettings, validateWatchSettings } from './lane-watch.mjs';
import { modelRolesStatus } from './model-setup.mjs';

const NO_FREE_FOLDER = 'Setup could not find a free folder for its files: every folder name it tries is already used by another folder or program. Nothing was changed.';
const SETUP_BUSY = 'Setup (another pots install) or the assistant connection is already working on this install, so nothing was changed. Next: wait a minute, then run pots install again.';
const RUNTIME_NOT_OURS = 'The existing runtime folder was not created by this Setup, so nothing was changed. Setup only changes files it made itself, so it left that folder as it is.';
const LAUNCHER_NOT_OURS = 'Setup found a launcher file that it did not write (it may be from an older version of Setup), so nothing was changed. The file is Start-OMP.ps1 or launch-settings.json in the launchers folder of the install folder, in the folder named for your project. Next: move or delete that file (or put launch-settings.json back if you deleted it), then run pots install again.';
export const AUTO_ERRORS = ['automatic setup requires Windows', 'invalid automatic setup options',
  'no eligible saved OMP sessions; create a saved session in OMP first',
  'There are too many saved OMP sessions to check safely, so nothing was changed. Remove the saved sessions you no longer need in OMP, then run pots install again.',
  'automatic setup paths must be absolute', 'automatic setup must be outside the runtime and session project',
  'existing folder is not a managed private setup; choose a new --root', REVIEW,
  'private permission setup failed', SETUP_BUSY,
  'existing connection differs; no binding replaced',
  'automatic setup records differ; inspect locally', 'automatic setup requires a local Windows folder',
  'Muse is no longer supported; choose Claude, ChatGPT, or both.',
  NO_FREE_FOLDER, ...Object.values(UPGRADE_ERRORS),
  RUNTIME_NOT_OURS, LAUNCHER_NOT_OURS];
// Thrown at the next step boundary after Ctrl+C; the stop handler below prints the one line the person sees, so the CLI prints nothing more for it.
export const INSTALL_STOPPED = 'Install was stopped.';
const fail = message => { throw new Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)); };
const absolute = file => { if (typeof file !== 'string' || !path.isAbsolute(file) || file !== path.resolve(file)) fail(AUTO_ERRORS[4]); return file; };
const OLDER_FOLDER = (older, chosen) => `Found a folder that Setup did not make (${older}). It was left alone. Pi on the Side is using a new folder: ${chosen}.`;
const LEGACY_COORDINATOR_WAKEUP_TEXT = `Coordinator wake-up protocol for Pi on the Side!

At the start of any run that queues bridge work, call bridge_lanes_status. If any lane is running and coordinator wake-ups are enabled, schedule a visible message in this same chat for about 2 minutes later using your own scheduling/reminder tool. Tell the user plainly that you scheduled it. Pi on the Side cannot push a message into this chat.

On every scheduled wake-up, call bridge_lanes_status. For every lane with needsAttention=true, read its bridge result/receipt, close that lane's OMP window, and queue the next approved step only after reviewing the result. Never replay or requeue a task whose state is failed, malformed, aborted or expired; stop for owner review. If anyRunning=true, schedule another visible wake-up using your own tool and tell the user plainly. If anyRunning=false, do not re-arm; tell the user plainly that no lane is running.

Use only the bounded status and receipt results. They contain no task text. Scheduling may fail, be delayed, be cancelled, or be unavailable while the chat is closed; OMP, provider availability, approvals, sleep and unknown outcomes can stop progress.`;
// The first versions said "about 2 minutes". The real minimum belongs to the assistant's client, so the text now
// says to use the shortest interval that client allows. The old wording is kept only to recognise (and upgrade) files this installer wrote earlier.
const OLD_INTERVAL = 'for about 2 minutes later using your own scheduling/reminder tool';
const NEW_INTERVAL = 'at the shortest interval your own scheduling/reminder tool allows (the real delay depends on that client)';
// The text before the stopped-lane sentence was added: kept only to recognise (and upgrade) files this installer wrote earlier.
const WAKEUP_TEXT_BEFORE_STOP = LEGACY_COORDINATOR_WAKEUP_TEXT
  .replace(OLD_INTERVAL, NEW_INTERVAL)
  .replace('call bridge_lanes_status.', 'call bridge_coordinator_heartbeat for each relevant lane (include its connection name in registry mode), then call bridge_lanes_status.')
  .replace('On every scheduled wake-up, call bridge_lanes_status.', 'On every scheduled wake-up, refresh bridge_coordinator_heartbeat for each relevant lane, then call bridge_lanes_status.')
  + '\nKeep each relevant lane heartbeat refreshed at least every 120 seconds during long coordinator processing. Heartbeat writes require current controller authority for that lane; never claim authority over another lane.';
const STOPPED_SENTENCE_V1 = ' A stopped lane (stopped is true) is continued with `pots lane restore <name>`; never queue a new step on it.';
const COORDINATOR_WAKEUP_TEXT = WAKEUP_TEXT_BEFORE_STOP.replace('reviewing the result.', 'reviewing the result. A stopped lane (stopped is true) is continued with `pots lane restore <name>`, or with `/bridge status` then `/bridge enable` in its window if that window is still open; never queue a new step on it and never close its window.');
// The text of the build before a stopped lane's window was protected: kept only to recognise (and upgrade) files that build wrote.
const WAKEUP_TEXT_STOP_V1 = WAKEUP_TEXT_BEFORE_STOP.replace('reviewing the result.', 'reviewing the result.' + STOPPED_SENTENCE_V1);
const LEGACY_COORDINATOR_WAKEUP_DISABLED_TEXT = `Coordinator wake-ups are disabled in Setup.
Do not schedule or re-arm visible reminders. Call bridge_lanes_status only when the user asks to inspect progress or before taking an explicitly approved next action. Pi on the Side cannot push a message into this chat.`;
const COORDINATOR_WAKEUP_DISABLED_TEXT = LEGACY_COORDINATOR_WAKEUP_DISABLED_TEXT
  + '\nBefore explicitly approved bridge work, refresh bridge_coordinator_heartbeat for each relevant lane using current controller authority (include its connection name in registry mode), then call bridge_lanes_status. Refresh each relevant heartbeat every cycle and at least every 120 seconds during long coordinator processing. This does not enable reminders or grant new authority.';
// Zero-token lane watcher guidance (added after the first wake-up text shipped; older generated
// files without it are recognised and upgraded in place, never treated as user edits).
const WATCH_TEXT_V1 = '\nLane watcher (zero tokens): every OMP lane started with the Pi on the Side launcher logs IDLE, BUSY, RESULT and GONE lines on this PC within about 15 seconds. Make each scheduled reminder do ONLY this: call bridge_lane_watch_lines, or, if you can run local commands, the exact watch-lines command shown by Setup. If it returns no lines, reply with nothing and stop. If it returns IDLE, RESULT or GONE lines, call bridge_lanes_status and continue the wake-up protocol above. BUSY lines are informational. A process on the PC cannot wake you: this check runs only when your own scheduler runs the reminder, so the real worst-case delay is the reminder interval plus about 15 seconds, plus your own run time.';
// The second wording also names the ERROR line; files written with the first wording are still recognised as Setup's own.
const WATCH_TEXT_V2 = WATCH_TEXT_V1.replace('IDLE, BUSY, RESULT and GONE lines', 'IDLE, BUSY, RESULT, GONE and ERROR lines')
  .replace('BUSY lines are informational.', 'BUSY lines are informational. An ERROR line means the watcher could not read its files: do not treat it as a result, tell the user and check that lane locally.');
// The newest wording also names the EXPIRED line (a queued task whose time ran out): the person has to be told.
const WATCH_TEXT = WATCH_TEXT_V2.replace('RESULT, GONE and ERROR lines', 'RESULT, GONE, ERROR and EXPIRED lines').replace('If it returns IDLE, RESULT or GONE lines', 'If it returns IDLE, RESULT, GONE or EXPIRED lines')
  .replace('BUSY lines are informational.', 'BUSY lines are informational. An EXPIRED line means a queued task was not started because its time ran out: tell the user and say it has to be queued again.');
const WATCH_CLIENT_TEXT = {
  'claude-skill.md': '\nSchedule the shortest repeating reminder your Claude client allows, with this prompt: "Pi on the Side check: call bridge_lane_watch_lines. No lines: say nothing and stop. Lines: follow the coordinator protocol."',
  'chatgpt-custom-instructions.txt': '\nChatGPT reaches this PC only through its local desktop connection. A ChatGPT scheduled task that runs in the cloud cannot call bridge_lane_watch_lines or reach this PC; use this reminder only in a session that has the local connection open, or use the opt-in CLI resume described in the Pi on the Side docs.',
};

async function installCoordinatorInstructions(root, clients, wakeupsEnabled, permissions, backup) {
  const directory = path.join(root, 'coordinator-instructions');
  if (!await exists(directory)) { await fs.mkdir(directory); await permissions.protect(directory, true); }
  else { await plain(directory, true); await permissions.verify(directory, false); }
  // `stage`: 0 = current text, 1 = the text before a stopped lane's window was protected, 2 = the text before any stopped-lane sentence.
  const contentFor = (name, enabled, prior = false, watch = WATCH_TEXT, oldInterval = false, stage = 0) => {
    const rule = enabled && !prior ? '\nSchedule exactly one next wake-up; before scheduling, list and delete other pending ones. If this invocation has a watchdog-bound cycleId, retain that original ID and authority path in every reminder. Before reading the handoff, doing work or scheduling, compare it with the current version-2 state.json cycleId; never adopt a newer ID. A stale, missing, malformed or unreadable authority exits with exactly one line: POTS resume superseded or unavailable. Do no work or rearming in that case. If reminder listing/cancellation is unavailable, report the limitation rather than claiming the queue is clear.' : '';
    const base = [COORDINATOR_WAKEUP_TEXT, WAKEUP_TEXT_STOP_V1, WAKEUP_TEXT_BEFORE_STOP][stage];
    const wakeText = oldInterval ? base.replace(NEW_INTERVAL, OLD_INTERVAL) : base;
    const text = (enabled ? wakeText + (watch ? watch + WATCH_CLIENT_TEXT[name] : '') : COORDINATOR_WAKEUP_DISABLED_TEXT) + rule + '\n';
    return name === 'claude-skill.md' ? '# Pi on the Side coordinator\n\n' + text : text;
  };
  const legacyFor = (name, enabled) => {
    const text = (enabled ? LEGACY_COORDINATOR_WAKEUP_TEXT : LEGACY_COORDINATOR_WAKEUP_DISABLED_TEXT) + '\n';
    return name === 'claude-skill.md' ? '# Pi on the Side coordinator\n\n' + text : text;
  };
  // Every text an earlier Setup wrote is one combination of: wake-ups on or off, the wake-up rule line, the lane-watcher text, the stopped-lane sentence and
  // the old interval wording (or the very first wording). Only a file that is exactly one of them is Setup's own and may be replaced
  // or removed. Any other file (the owner's, or one this does not know) is kept as it is and never blocks the upgrade.
  const everWritten = name => new Set([legacyFor(name, true), legacyFor(name, false), contentFor(name, false),
    ...[true, false].flatMap(prior => [WATCH_TEXT, WATCH_TEXT_V2, WATCH_TEXT_V1, ''].flatMap(watch => [true, false].flatMap(oldInterval => [0, 1, 2].map(stage => contentFor(name, true, prior, watch, oldInterval, stage)))))]);
  const files = [];
  if (clients === 'claude' || clients === 'both') files.push('claude-skill.md');
  if (clients === 'chatgpt' || clients === 'both') files.push('chatgpt-custom-instructions.txt');
  const selected = new Set(files), kept = [];
  for (const name of ['claude-skill.md','chatgpt-custom-instructions.txt']) {
    const file = path.join(directory, name);
    if (!await exists(file)) continue;
    await plain(file);
    const content = await fs.readFile(file, 'utf8');
    if (!everWritten(name).has(content)) { if (selected.has(name)) kept.push(file); continue; }
    if (!selected.has(name)) {
      await backup?.file('coordinator-' + name, await fs.readFile(file));
      await fs.unlink(file);
    } else if (content !== contentFor(name, wakeupsEnabled)) {
      await backup?.file('coordinator-' + name, await fs.readFile(file));
      await fs.writeFile(file, contentFor(name, wakeupsEnabled), { flag: 'w' });
    }
  }
  for (const name of files) {
    const file = path.join(directory, name);
    if (!await exists(file)) await fs.writeFile(file, contentFor(name, wakeupsEnabled), { flag: 'wx', mode: 0o600 });
  }
  return { files: files.map(name => path.join(directory, name)), kept };
}

// Only native session storage is searched, never project trees. The strict
// header reader parses no message bodies. Bounds refuse partial discovery.
export async function discoverSessions(roots) {
  const files = [], seen = new Set(); let visited = 0;
  async function walk(dir, depth) {
    if (!await exists(dir)) return;
    await plain(dir, true);
    for (const row of await fs.readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000) fail(AUTO_ERRORS[3]);
      const file = path.join(dir, row.name);
      if (row.isSymbolicLink()) continue;
      if (row.isDirectory()) { if (depth >= 3) fail(AUTO_ERRORS[3]); await walk(file, depth + 1); }
      else if (row.isFile() && row.name.endsWith('.jsonl')) {
        await plain(file); const canonical = await fs.realpath(file);
        if (!seen.has(canonical.toLowerCase())) { seen.add(canonical.toLowerCase()); files.push(canonical); }
      }
    }
  }
  for (const root of roots) await walk(absolute(root), 0);
  const result = [];
  for (const file of files) {
    try { const identity = await sessionIdentity(file); await plain(identity.cwd, true); result.push({ file, time: (await fs.stat(file)).mtimeMs, ...identity }); }
    catch { /* Only valid, accessible v3 saved sessions are eligible. */ }
  }
  return result.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.file.localeCompare(b.file));
}

// A private folder for copies of what an upgrade replaces: nothing the user may have put there, never an
// external config file, only files this installer wrote itself. Created on first use. Every folder also holds a
// manifest with the SHA-256 of each file Setup wrote into it; that is the proof an older folder can be removed later.
const BACKUP_FOLDER = /^\d{8}T\d{6}Z(-[0-9a-f]{6})?$/, BACKUP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/, BACKUP_MANIFEST = 'backup-manifest.json';
function backupWriter(root, permissions, now) {
  let folder;
  const written = {};
  return {
    get folder() { return folder; },
    async file(name, bytes) {
      if (!folder) {
        const base = path.join(root, 'backups');
        if (!await exists(base)) { await fs.mkdir(base); await permissions.protect(base, true); }
        else { await plain(base, true); await permissions.verify(base, false); }
        let candidate = path.join(base, new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
        if (await exists(candidate)) candidate += '-' + crypto.randomBytes(3).toString('hex');
        await fs.mkdir(candidate);
        // A dated folder that could not be made private is taken away again: an empty one would stop the next install and the uninstall.
        try { await permissions.protect(candidate, true); } catch (error) { await fs.rmdir(candidate).catch(() => {}); throw error; }
        folder = candidate;
      }
      const file = path.join(folder, name);
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      written[name] = hash(bytes);
      await writeAtomic(path.join(folder, BACKUP_MANIFEST), Buffer.from(JSON.stringify({ version: 1, files: written }) + '\n'));
      return file;
    },
  };
}

// The files of an older backup folder when every one of them is provably what Setup wrote (the manifest names each
// file with its hash, nothing else is there, nothing is linked); otherwise null and the folder is left alone.
async function provenBackup(folder) {
  try {
    await plain(folder, true);
    const manifestFile = path.join(folder, BACKUP_MANIFEST);
    await plain(manifestFile);
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')), files = manifest?.files;
    if (Object.keys(manifest).sort().join() !== 'files,version' || manifest.version !== 1 || files === null || typeof files !== 'object' || Array.isArray(files)) return null;
    for (const [name, digest] of Object.entries(files)) if (!BACKUP_FILE.test(name) || name === BACKUP_MANIFEST || !/^[0-9a-f]{64}$/.test(digest)) return null;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || (entry.name !== BACKUP_MANIFEST && !Object.hasOwn(files, entry.name))) return null;
    }
    for (const [name, digest] of Object.entries(files)) {
      const now = await fs.readFile(path.join(folder, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (now !== null && hash(now) !== digest) return null;
    }
    return files;
  } catch { return null; }
}

// Removes the backup folders of earlier runs, except `keepFolder` (the copies this run just made of what it replaced; the
// next run removes those). A folder goes only when everything in it is provably Setup's own, checked again byte for byte
// right before each delete; anything else (a file somebody added, a folder from an older Setup without a manifest) stays
// and is listed. Never fails the setup; returns how many folders were removed and which ones were left.
async function pruneBackups(root, keepFolder) {
  const base = path.join(root, 'backups');
  let removed = 0;
  const left = [];
  try {
    await plain(base, true);
    const folders = (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && BACKUP_FOLDER.test(entry.name)).map(entry => entry.name).sort();
    for (const name of folders) {
      const folder = path.join(base, name);
      if (keepFolder && same(folder, keepFolder)) continue;
      const files = await provenBackup(folder);
      if (!files) { left.push({ path: folder, reason: 'Setup cannot prove it wrote everything in it' }); continue; }
      try {
        for (const [file, digest] of [...Object.entries(files), [BACKUP_MANIFEST, null]]) {
          const target = path.join(folder, file), now = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (now === null) continue;
          if (digest !== null && hash(now) !== digest) throw new Error('changed');
          await fs.rm(target);
        }
        await fs.rmdir(folder);
        removed++;
      } catch { left.push({ path: folder, reason: 'it changed while it was being removed' }); }
    }
  } catch { /* nothing to prune, or not provable: kept */ }
  return { removed, left };
}

// One bridge for every project and session on this PC: runtime/current/bridge.mjs, a path that never changes
// across versions (the version lives in current.json inside it). An upgrade adds a new versions/<x> folder and moves
// the pointer, so a session that is running keeps the files it loaded. Older per-session managed-<id> folders are
// never edited or removed (they are the way back); the first run that builds the new layout copies their pointers into
// the backup folder and reports it as an upgrade from the newest of them. A current folder that is unreadable but
// holds this Setup's own launcher or only its empty work folders (an interrupted first install) is moved aside,
// never deleted, and rebuilt; one without our launcher is left as it is and stops the setup.
async function legacyRuntimes(parent) {
  const rows = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('managed-')) continue;
    try {
      const bytes = await fs.readFile(path.join(parent, entry.name, 'current.json')), pointer = JSON.parse(bytes.toString('utf8'));
      if (pointer?.version === 1 && typeof pointer.current === 'string') rows.push({ name: entry.name, version: pointer.current, bytes });
    } catch { /* not a readable older install: left alone */ }
  }
  return rows;
}
// The one place the managed runtime lives; its launcher is bridge.mjs in it.
const runtimeTarget = root => path.join(root, 'runtime', 'current');
async function installRuntime(root, backup, probe, io) {
  const parent = path.join(root, 'runtime'), target = runtimeTarget(root);
  if (!await exists(parent)) await fs.mkdir(parent); else await plain(parent, true);
  const options = { backup, ...(probe ? { probe } : {}), ...(io ? { io } : {}) };
  let runtime;
  try { runtime = await prepareManagedRuntime(target, options); }
  catch (e) {
    if (!(e instanceof Error) || e.message !== UPDATE_MESSAGES.incomplete) throw e;
    let ours = false;
    try { await plain(path.join(target, 'bridge.mjs')); ours = isOurLauncher(await fs.readFile(path.join(target, 'bridge.mjs'))); } catch { /* not ours */ }
    // Killed before the launcher was written: only empty versions/staging folders exist.
    if (!ours) try { ours = (await Promise.all((await fs.readdir(target, { withFileTypes: true })).map(async d => d.isDirectory() && ['versions', 'staging'].includes(d.name) && (await fs.readdir(path.join(target, d.name))).length === 0))).every(Boolean); } catch { /* not ours */ }
    if (!ours) fail(RUNTIME_NOT_OURS);
    const aside = 'managed-' + Date.now().toString(16);
    await fs.rename(target, path.join(parent, aside));
    runtime = await prepareManagedRuntime(target, options);
  }
  if (runtime.kind !== 'fresh') return runtime;
  const older = (await legacyRuntimes(parent)).sort((x, y) => { try { return compareVersions(y.version, x.version); } catch { return 0; } });
  if (!older.length) return runtime;
  for (const row of older) await backup.file(row.name + '-current.json', row.bytes);
  let newer = false; try { newer = compareVersions(runtime.to, older[0].version) > 0; } catch { /* not a version: reported as installed */ }
  return newer ? Object.assign(runtime, { kind: 'upgrade', upgraded: true, from: older[0].version }) : runtime;
}

// First absolute PATH entry holding `name` (a plain file, never a link); relative entries depend on the working folder and are ignored.
async function locateExecutable(name, env) {
  const key = Object.keys(env).find(item => item.toUpperCase() === 'PATH');
  for (let entry of String(key === undefined ? '' : env[key]).split(path.delimiter)) {
    if (entry.length > 1 && entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    if (!entry || !path.isAbsolute(entry)) continue;
    const file = path.join(path.resolve(entry), name);
    try { if ((await fs.lstat(file)).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}
// The assistant's own command line (for example `claude mcp add`), no shell, bounded time and output.
const runClient = (exe, args) => new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 262144 },
  (error, stdout) => error ? reject(new Error('assistant command failed')) : resolve({ stdout })));
const writeAtomic = async (file, bytes) => {
  const temp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temp, file); } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
};
// Bytes of the files a step may change: before the step, and what the step left. A later failure puts the old bytes
// back only into a file that still holds exactly what the step left (or removes one the step created); a file that was
// changed after that is kept as it is and reported.
const sameBytes = (a, b) => a === null || b === null ? a === b : a.equals(b);
function trackFiles() {
  const before = new Map(), after = new Map();
  // A folder with the name of a tracked file (for example `disabled`) is not that file's bytes: it is left to whoever made it.
  const readOrNull = file => fs.readFile(file).catch(e => { if (e.code === 'ENOENT' || e.code === 'EISDIR') return null; throw e; });
  return {
    async before(paths) { for (const file of paths) if (!before.has(file)) before.set(file, await readOrNull(file)); },
    async after() { for (const file of before.keys()) after.set(file, await readOrNull(file)); },
    async restore() {
      const left = [];
      for (const [file, was] of before) {
        try {
          const now = await readOrNull(file);
          if (sameBytes(now, was)) continue;
          if (!after.has(file) || !sameBytes(now, after.get(file))) { left.push(`${path.basename(file)} was changed after Setup wrote it, so it was kept as it is.`); continue; }
          if (was === null) await fs.unlink(file); else await writeAtomic(file, was);
        } catch { left.push('A file could not be put back: ' + path.basename(file)); }
      }
      return { left };
    },
  };
}

// What an earlier Setup stored for the opt-in resume watchdog, so that running pots install again (for example to upgrade)
// keeps it instead of switching it off. Anything unreadable or no longer valid counts as "not set up".
async function existingResumeOptions(root, clients) {
  const directory = path.join(root, 'coordinator-resume');
  try {
    const stored = await readJson(path.join(directory, 'config.json'));
    const cloud = [];
    for (const client of ['claude', 'chatgpt']) if (await exists(path.join(directory, `${client}-cloud-task.txt`))) cloud.push(client);
    const keep = ['cliClients', 'dryRun', 'pollMs', 'handoffFile', 'claudeExecutable', 'codexExecutable', 'claudeSession', 'claudeContinue']
      .filter(key => stored[key] !== undefined).map(key => [key, stored[key]]);
    const options = { ...Object.fromEntries(keep), cloudClients: cloud.length === 2 ? 'both' : cloud[0] ?? 'none' };
    resumeOptions(options, clients);
    return options;
  } catch { return undefined; }
}

// The resume watchdog owns a few generated files in its folder, its handoff file and a "disabled" marker. Their bytes are tracked around
// the step so that a later failure can put them back.
async function trackResume(root) {
  const directory = path.join(root, 'coordinator-resume'), tracked = trackFiles();
  const paths = ['config.json', 'resume-prompt.txt', 'claude-cloud-task.txt', 'chatgpt-cloud-task.txt', 'Disable-Resume.cmd', 'Run-Resume.vbs', 'handoff.md', 'ownership.json', 'control/disabled', 'control/wakeups-off', 'control/wakeups-on']
    .map(name => path.join(directory, ...name.split('/')));
  // A link or folder named `disabled` is the owner's pause marker: Setup never reads or rewrites through it.
  const marker = path.join(directory, 'control', 'disabled');
  if (!await fs.lstat(marker).then(stat => stat.isFile(), () => true)) paths.splice(paths.indexOf(marker), 1);
  const external = [];
  try { external.push(...(await readJson(path.join(directory, 'ownership.json'))).external.map(row => row.path)); } catch { /* none recorded */ }
  for (const file of external) if (typeof file === 'string' && path.isAbsolute(file)) paths.push(file);
  await tracked.before(paths);
  return tracked;
}
// The install's own wake-up choice is kept in one small empty file: `wakeups-off` (pots install --no-coordinator-wakeups). A session that is open
// cannot be updated, so without it a later plain install would read the old choice from that session and undo this one. `--coordinator-wakeups`
// removes `wakeups-off`; while a session is still open, `wakeups-on` stands in for it until every session has been brought in line.
const storedWakeups = async root => await exists(wakeupsOffFile(root)) ? false : await exists(wakeupsOnFile(root)) ? true : undefined;
async function rememberWakeups(root, permissions, choice, openKept) {
  const off = wakeupsOffFile(root), on = wakeupsOnFile(root), drop = file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const keepOn = choice !== false && openKept > 0 && (choice === true || await exists(on));
  if (choice === true) await drop(off);
  if (choice === false || !keepOn) await drop(on);
  if (choice === false || keepOn) {
    for (const directory of [path.join(root, 'coordinator-resume'), path.join(root, 'coordinator-resume', 'control')]) {
      if (!await exists(directory)) { await fs.mkdir(directory); await permissions.protect(directory, true); } else await plain(directory, true);
    }
    await fs.writeFile(choice === false ? off : on, '', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
}
// Creates the launcher of a new lane. For an existing one that was written by an older Setup (same state folder,
// runtime inside this install) it returns a `rewrite` that backs the two files up and replaces them; anything
// else stops the setup unchanged. `undo` puts the old bytes back only if the new ones are still there.
async function planLauncher(folder, settings, script, root, state) {
  const settingsFile = path.join(folder, 'launch-settings.json'), scriptFile = path.join(folder, 'Start-OMP.ps1');
  const present = await exists(folder);
  if (present) await plain(folder, true);
  // The shape Setup writes for launch-settings.json: its own three paths, for this state folder, with the program inside this install.
  const ours = current => Boolean(current) && typeof current === 'object' && !Array.isArray(current) && Object.keys(current).sort().join() === 'cli,node,state' &&
    Object.values(current).every(value => typeof value === 'string') && same(current.state, state) && inside(current.cli, root);
  // A folder without both files is what a cut-off earlier run left behind (nothing, or only the first of the two files): it is filled in like a new one.
  if (!present || !(await exists(settingsFile) && await exists(scriptFile))) {
    // A lone file is removed only when it is provably Setup's own: a script someone edited, or a settings file of another shape, is never deleted unread.
    // The checks come before the cleanup below, which removes what this run wrote and must never reach a file it refused.
    if (present && await exists(scriptFile) && !(await fs.readFile(scriptFile)).equals(Buffer.from(script))) fail(LAUNCHER_NOT_OURS);
    if (present && await exists(settingsFile) && !ours(await fs.readFile(settingsFile, 'utf8').then(JSON.parse, () => null))) fail(LAUNCHER_NOT_OURS);
    try {
      if (!present) await fs.mkdir(folder);
      else { await fs.rm(settingsFile, { force: true }); await fs.rm(scriptFile, { force: true }); }
      await writeJson(settingsFile, settings, true); await fs.writeFile(scriptFile, script, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      // Never leave a half-made launcher folder: it would stop the next install and the uninstall.
      await fs.rm(settingsFile, { force: true }); await fs.rm(scriptFile, { force: true }); await fs.rmdir(folder).catch(() => {});
      throw error;
    }
    return { rewrite: null, created: true };
  }
  const before = { settings: await fs.readFile(settingsFile), script: await fs.readFile(scriptFile) };
  const next = { settings: Buffer.from(JSON.stringify(settings) + '\n'), script: Buffer.from(script) };
  if (before.settings.equals(next.settings) && before.script.equals(next.script)) return { rewrite: null };
  let current;
  try { current = JSON.parse(before.settings.toString('utf8')); } catch { /* not ours */ }
  if (!ours(current)) fail(LAUNCHER_NOT_OURS);
  let wrote = false;
  return {
    async rewrite(backup) {
      await backup.file(`launcher-${path.basename(folder)}-launch-settings.json`, before.settings);
      await backup.file(`launcher-${path.basename(folder)}-Start-OMP.ps1`, before.script);
      await writeAtomic(settingsFile, next.settings); wrote = true;
      await writeAtomic(scriptFile, next.script);
    },
    async undo() {
      if (!wrote) return;
      for (const [file, was, now] of [[settingsFile, before.settings, next.settings], [scriptFile, before.script, next.script]]) {
        const found = await fs.readFile(file).catch(() => null);
        if (found && found.equals(now)) await writeAtomic(file, was);
      }
      wrote = false;
    },
  };
}

// Plain words for a person who does not read JSON: what happened and the few things that are still theirs to do.
async function finish({ root, runtime, sessions, skipped, notBound, dropped, retired = [], openSessions, credentialCreated, connectionsFolder, credentialFile, instructionFiles, keptInstructions,
  resume, resumeChosen, assistants, backup, watchFile, watchSettings, deps, executable, clients, coordinatorWakeups, wakeNote, host, command }) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const nowOpen = openSessions > 0;
  const upgrade = { kind: runtime.kind, from: runtime.from, to: runtime.to, launcherSwitched: sessions.some(row => row.launcherSwitched), sessionOpen: nowOpen,
    message: { fresh: `Installed Pi on the Side ${runtime.to}.`,
      upgrade: `Upgraded to ${runtime.to}.` + (nowOpen ? ' A session is open, so the new version starts with the next session.' : ''),
      unchanged: `Pi on the Side ${runtime.to} is already installed; its program files were not changed.`,
      'newer-kept': `A newer version (${runtime.to}) is already installed and was kept.` }[runtime.kind] };
  // A read-only look at OMP's own settings; a model is the user's choice, so the only automatic thing here is to say what is missing.
  let models = { status: 'unchecked', missing: [] };
  try { if (deps.modelRoles) models = await deps.modelRoles(executable, sessions[0].project); } catch { /* reported as unchecked */ }
  const needsYou = assistants.needsYou.map(item => ({ action: 'connect-again', ...item }));
  if (models.status === 'missing') needsYou.push({ client: 'OMP', message: `OMP has no model chosen for: ${models.missing.join(', ')}.`,
    fix: "Choose them in OMP's own settings; Pi on the Side never picks a model for you." });
  else if (models.status === 'unchecked' && deps.modelRoles) needsYou.push({ client: 'OMP', message: 'Setup could not check which models OMP has chosen.',
    fix: "Review the models in OMP's own settings." });
  // The MCP handshake is size-limited, and ChatGPT keeps custom instructions in the user's own account settings,
  // which no program can change: the one thing left for the user is a paste, and `pots instructions` prints the text.
  // Only when the ChatGPT desktop app is there (a Windows app package from OpenAI): a PC with only Claude Code or only the Codex command-line
  // program has nothing to paste into. The Codex folder alone does not tell, because the command-line program makes it too. The package name
  // "OpenAI.ChatGPT-Desktop_..." was read from a PC that has the app (see docs/client-setup.md); the other OpenAI packages there (Codex) do not count.
  const chatgptFile = instructionFiles.find(file => path.basename(file) === 'chatgpt-custom-instructions.txt');
  const chatgptApp = chatgptFile ? (await fs.readdir(path.join(deps.env.LOCALAPPDATA || path.join(deps.home, 'AppData/Local'), 'Packages')).catch(() => [])).some(name => /^OpenAI\.ChatGPT-Desktop_/i.test(name)) : false;
  if (chatgptFile && chatgptApp) needsYou.push({ client: 'ChatGPT', message: 'ChatGPT keeps custom instructions in its own account settings, which no program can change.',
    fix: 'Run pots instructions to print the ChatGPT instructions, then paste them once into ChatGPT Settings > Personalization > Custom instructions.', action: 'copy-chatgpt-instructions', file: chatgptFile });
  const keptWakeFiles = (resume.preserved ?? []).filter(file => !resume.external?.some(row => row.path === file));
  const summary = [upgrade.message, ...assistants.items.map(item => item.message),
    ...(command.created ? [command.onPath ? 'Type pots in a terminal: pots upgrade, pots status, pots instructions, pots --version, pots uninstall.' : `The pots command was saved as ${command.file}. That folder is not on your PATH, so type the full name there.`] : []),
    ...(command.note ? [command.note] : []),
    `Projects connected: ${sessions.length}.`,
    ...(dropped.length ? [`Removed ${dropped.length === 1 ? 'one connection' : `${dropped.length} connections`} whose saved OMP session was deleted or changed (${dropped.join(', ')}). Your saved sessions and projects were not touched.`] : []),
    ...(retired.length ? [`The list was full (${MAX_CONNECTIONS} lanes), so ${retired.length === 1 ? 'one finished lane was' : `${retired.length} finished lanes were`} taken off it (${retired.join(', ')}). Their saved sessions were not touched. Bring one back with: pots lane restore <lane-name>`] : []),
    ...(skipped.length ? [`${skipped.length === 1 ? 'One saved project was' : `${skipped.length} saved projects were`} skipped (${[...new Set(skipped.map(row => row.reason))].join('; ')}).`] : []),
    ...(notBound ? [`${notBound} saved ${notBound === 1 ? 'project was' : 'projects were'} not connected, because ${MAX_CONNECTIONS} is the most Pi on the Side connects at once. Projects connected earlier keep their places, and the rest are taken newest first. To free a place, run pots lane close <lane-name> for a lane you no longer need, then pots install again.`] : []),
    wakeNote ? wakeNote
      : resume.task ? 'Wake-ups: a scheduled task keeps a small watchdog running. When a lane finishes and no assistant is active, it starts Claude Code or Codex on its own.'
      : coordinatorWakeups ? (resumeChosen ? `Wake-ups: no command-line program (Claude Code or Codex) is selected for wake-ups (${resume.options.cloudClients === 'none' ? 'you chose --resume-cli none and no cloud client' : 'cloud-only'}), so nothing can start an assistant on its own. To use one, see docs/coordinator-resume.md (setup-auto with --resume-cli).`
        : `Wake-ups: ${clients === 'claude' ? 'Claude Code was not found' : clients === 'chatgpt' ? 'Codex was not found' : 'no Claude Code or Codex was found'} on this PC, so nothing can start an assistant on its own. Install ${clients === 'both' ? 'one' : 'it'}, then run pots install.`)
      : `Wake-ups are off by your choice (pots install --no-coordinator-wakeups). Nothing starts an assistant by itself, and your assistant will not schedule any reminders. ${WAKEUPS_ON_AGAIN} ${WAKEUPS_FORGOTTEN}`,
    'The lane watcher starts by itself with the launcher and needs no setup.',
    ...(resume.external?.length ? [`An old Startup file from an earlier version was kept because it was changed after Setup wrote it (${resume.external.map(row => row.path).join(', ')}). The scheduled task replaces it, so it is not needed. Delete it yourself when you like; pots uninstall names it too.`] : []),
    ...(keptWakeFiles.length ? [`Setup kept these wake-up files because you changed them after Setup wrote them, and Setup no longer writes them with the current wake-up settings: ${keptWakeFiles.join(', ')}. Nothing needs them. pots uninstall will stop and leave them where they are until you move or delete them (pots uninstall --details names them).`] : []),
    ...keptInstructions.map(file => `Setup did not touch ${file}. It is not exactly the text Setup wrote (you may have edited it), so it may not have the newest wake-up instructions. To get them, move that file somewhere else and run pots install again. If you leave it, pots uninstall will stop and keep it where it is until you move or delete it (pots uninstall --details names it).`),
    ...(backup.folder ? [`Copies of everything Setup replaced are in ${backup.folder}.`] : []),
    ...needsYou.map(item => `${item.message} ${item.fix}`)];
  return { installRoot: root, installed: runtime.created, upgraded: runtime.upgraded, upgrade, credentialCreated, host, command, wakeNote,
    sessions, skipped, connectionsFolder, credentialFile, runtimeFolder: runtime.target,
    cliLauncher: runtime.launcher, mcpLauncher: runtime.launcher,
    mcpArguments: ['mcp'], updateChannel: 'published stable and prerelease',
    clients, coordinatorWakeups, coordinatorInstructionFiles: instructionFiles,
    coordinatorResume: resume, assistants: { items: assistants.items, needsYou }, modelRoles: models, summary, backupFolder: backup.folder ?? null,
    laneWatch: { enabled: watchSettings.enabled, settingsCreated: watchFile.created, settingsFile: watchFile.file,
      pollSeconds: watchSettings.pollMs / 1000, idleSeconds: watchSettings.idleMs / 1000, resultFiles: watchSettings.resultFiles,
      source: 'bridge lane events (OMP log fallback only if they stay silent)', runsWith: 'the Pi on the Side launcher (no extra process)',
      coordinatorTool: 'bridge_lane_watch_lines',
      coordinatorCommand: `& ${quote(deps.nodeExecutable)} ${quote(runtime.launcher)} watch-lines ${quote(connectionsFolder)}`,
      note: 'Zero network, zero model calls. A PC process cannot wake your assistant: its own scheduled reminder must run the coordinator command or tool. Worst case: reminder interval + about 15 seconds.' },
    ownerOnlyPermissions: 'current Windows user only; verified during setup', started: false,
    note: 'To let your assistant work in a project, open that project with its Pi on the Side launcher (listed under sessions). No global OMP settings changed; provider availability is not verified.' };
}

// `pots` is a real command, like `omp`: a one-line pots.cmd in the folder Windows already puts on every user's PATH
// (no PATH or registry change, so removing it is just deleting that file). It runs the fixed launcher, so it keeps
// working across upgrades. Only a file that carries this marker is ever replaced.
const SHIM_MARK = 'REM Pi on the Side command (omp-session-bridge)';
export const commandFile = deps => path.join(deps.env.LOCALAPPDATA || path.join(deps.home, 'AppData/Local'), 'Microsoft', 'WindowsApps', 'pots.cmd');
async function installCommand(deps, launcher) {
  const file = commandFile(deps), folder = path.dirname(file);
  const text = `@echo off\r\n${SHIM_MARK}\r\n"${deps.nodeExecutable}" "${launcher}" %*\r\n`;
  const onPath = String(deps.env.PATH ?? deps.env.Path ?? '').split(';').some(entry => entry.replace(/\\$/, '').toLowerCase() === folder.toLowerCase());
  if (!await exists(folder)) return { file, created: false, onPath, note: 'The pots command was not added because Windows has no WindowsApps folder here. Use the launchers listed by pots install --details.' };
  const old = await fs.readFile(file, 'utf8').catch(() => null);
  if (old !== null && !old.includes(SHIM_MARK)) return { file, created: false, onPath, note: 'A different pots command already exists, so Setup left it alone.' };
  if (old !== text) await fs.writeFile(file, text);
  return { file, created: true, onPath, sha256: hash(Buffer.from(text)) };
}

const LAUNCH_SCRIPT = "$ErrorActionPreference='Stop'\n$s=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'launch-settings.json') -Raw | ConvertFrom-Json\nif((Read-Host 'Close any OMP instance using this saved session, then type START') -cne 'START'){return}\n& $s.node $s.cli start $s.state --confirm-offline\nif($LASTEXITCODE -ne 0){throw 'Bound OMP launch refused; inspect local status and offline recovery'}\n";
const projectName = cwd => { const generated = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'session'; return /^[a-z]/.test(generated) ? generated : 's-' + generated.slice(0, 18); };

// Binds ONE saved session: its own state folder (plans, queue, receipts, controller record), a registry entry and a launcher.
// Used by Setup for every saved session it finds and by the assistant adapter for a session saved later. An existing
// session keeps the choices it already has; a new one gets `options` or the defaults. `undo` collects the steps that put
// a changed config back if a later step fails.
async function bindSession({ root, credentialFile, connectionsFolder, executable, detect, options = {}, node, cli, undo }, selected) {
  const state = path.join(root, 'sessions', selected.sessionId), stateConfig = path.join(state, 'config.json');
  // A project folder this run creates stays complete if a later step fails (retry reuses it); only an existing one's config is put back.
  await discardUnstarted(state);
  if (await exists(state)) await restoreConfig(state, selected);
  const configFiles = trackFiles(); if (await exists(state)) await configFiles.before([stateConfig]);
  const bind = await exists(state) ? await loadSetup(state) : null, existing = bind?.settings ?? null;
  const registry = await exists(path.join(connectionsFolder, 'connections.json')) ? await readConnections(connectionsFolder) : { connections: [] };
  // A session that is new to this install follows the choices the install already has (for example --no-coordinator-wakeups or --clients), not a fresh default.
  let sibling = null;
  for (const row of registry.connections) { try { sibling = (await loadSetup(row.root)).settings; break; } catch { /* a dead connection is skipped */ } }
  const chosenClients = options.clients ?? existing?.clients ?? sibling?.clients ?? 'both';
  // A stored choice wins over what a session says: a session that was open at the time could not be updated.
  const chosenWakeups = options.coordinatorWakeups ?? await storedWakeups(root) ?? existing?.coordinatorWakeups ?? sibling?.coordinatorWakeups ?? true;
  undo?.push(() => configFiles.restore());
  let bound;
  try { bound = await setup(selected.file, state, { locate: async () => bind?.launch.executable ?? executable, detect, coordinatorWakeups: chosenWakeups, clients: chosenClients, keepWhenOpen: true }); } finally { await configFiles.after(); }
  if (bound.sessionId !== selected.sessionId || !same(bound.cwd, selected.cwd) || !same(bound.sessionFile, selected.file)) fail('automatic setup records differ; inspect locally');
  const loaded = await loadSetup(state), controller = await acquireController(new Store(loaded.settings), credentialFile);
  const prior = registry.connections.find(row => row.binding.sessionId === selected.sessionId);
  const name = options.name || prior?.name || `${projectName(selected.cwd)}-${hash(selected.sessionId).slice(0, 8)}`;
  if (prior) { if (prior.name !== name || !same(prior.root, state)) fail('existing connection differs; no binding replaced'); await loadConnection(prior); }
  const added = prior ? undefined : await registerConnection(connectionsFolder, name, state);
  const launcherFolder = path.join(root, 'launchers', name), launchSettings = { node, cli, state };
  let launcherPlan;
  try { launcherPlan = await planLauncher(launcherFolder, launchSettings, LAUNCH_SCRIPT, root, state); }
  // A lane whose launcher cannot be planned must not stay on the list as a row nobody can start: take only its row off again.
  catch (e) { if (added) await closeConnection(connectionsFolder, name).catch(() => {}); throw e; }
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  return { bound, launcherFolder, launcherPlan, retired: added?.retiredFinishedLanes ?? [],
    row: { name, project: selected.cwd, sessionId: selected.sessionId, stateFolder: state, created: bound.created, controller, launcher: path.join(launcherFolder, 'Start-OMP.ps1'),
      launcherSwitched: Boolean(launcherPlan.rewrite), startCommand: `& ${quote(node)} ${quote(cli)} start ${quote(state)} --confirm-offline` } };
}

// The OMP an existing install already uses (the one in its saved launch records), so a repeat run works without OMP on PATH.
async function recordedOmp(root) {
  try {
    for (const row of (await readConnections(path.join(root, 'connections'))).connections) {
      try { const file = (await loadSetup(row.root)).launch.executable; if (await exists(file)) return file; } catch { /* try the next saved session */ }
    }
  } catch { /* no usable registry yet */ }
  return null;
}
// A skipped project is explained in words; the system code stays out of the sentence.
const WHY = { ENOENT: 'its saved file or folder is gone', EEXIST: 'a file with the same name is already there', EACCES: 'Windows would not let Setup open it', EPERM: 'Windows would not let Setup open it',
  EBUSY: 'another program is using it', ENOTDIR: 'its folder is no longer a folder', EISDIR: 'a folder is where a file should be', ENOTEMPTY: 'its folder is not empty', EMFILE: 'Windows has too many files open', EROFS: 'its folder is read-only', ENOSPC: 'the disk is full', 'unexpected error': 'Setup could not read it' };
const plainReason = text => WHY[text] ?? text;

// At most MAX_CONNECTIONS saved sessions are connected at once (the registry limit); the newest come first.
const newestFirst = list => [...list].sort((a, b) => b.time - a.time || a.file.localeCompare(b.file));

// Installation copies an allowlisted runtime, then connects every saved OMP session it finds. It never starts OMP,
// alters its settings or steals controller locks. An open OMP session or a running plan never blocks it: the new
// version is only added and the pointer switched, so a running session keeps the files it already loaded.
async function installOnce(options, deps) {
  if (options?.clients === 'muse') fail('Muse is no longer supported; choose Claude, ChatGPT, or both.');
  const allowed = new Set(['root', 'session', 'name', 'sessionDir', 'clients', 'coordinatorWakeups', 'coordinatorResume']);
  if (!options || Object.keys(options).some(k => !allowed.has(k) ||
      (k === 'coordinatorResume' ? false : k === 'coordinatorWakeups' ? typeof options[k] !== 'boolean' :
        typeof options[k] !== 'string' || !options[k])) ||
      (options.clients !== undefined && !['claude','chatgpt','both'].includes(options.clients)) ||
      (options.name !== undefined && !NAME.test(options.name))) fail('invalid automatic setup options');
  const clients = options.clients || 'both';
  resumeOptions(options.coordinatorResume, clients); // validates what was asked for before anything is touched
  if (!nodeSupported(deps.nodeVersion)) fail(MESSAGES.node);
  if (deps.platform !== 'win32') fail('automatic setup requires Windows');
  const agentDir = deps.env.PI_CODING_AGENT_DIR || path.join(deps.home, '.omp/agent');
  const found = options.session ? [{ file: await fs.realpath(absolute(options.session)), ...await sessionIdentity(absolute(options.session)) }]
    : await discoverSessions(options.sessionDir ? [absolute(options.sessionDir)] : [path.join(absolute(agentDir), 'sessions'), path.join(absolute(agentDir), 'custom-session-files')]);
  if (!found.length) fail(AUTO_ERRORS[2]);
  const requested = absolute(options.root || defaultRootBase(deps));
  if (requested.startsWith('\\\\')) fail('automatic setup requires a local Windows folder');
  if (inside(requested, CHECKOUT)) fail(AUTO_ERRORS[5]);
  await plain(path.dirname(requested), true);
  let root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested)), olderFolder = null;
  if (options.root === undefined) {
    // Only the default folder is ever moved. A folder that is not a managed setup of ours is never changed or adopted:
    // a managed sibling of ours is reused, otherwise the first unused sibling name is taken.
    const rows = await defaultRootStates(root), chosen = rows.find(row => row.state === 'ours') ?? rows.find(row => row.state === 'free');
    if (!chosen) fail(NO_FREE_FOLDER);
    if (chosen.root !== root) {
      if (rows[0].state === 'other') olderFolder = root;
      root = chosen.root;
      if (inside(root, CHECKOUT)) fail(AUTO_ERRORS[5]);
    }
  }
  // A repeat run works without OMP on PATH: an existing install's own recorded OMP is used when PATH has none.
  const executable = await deps.locate() ?? await recordedOmp(root); if (!executable) fail(MESSAGES.noOmp);
  const host = await requireHost(deps.detect, executable);
  // The install folder cannot be inside a project folder; such a session is left out (an explicitly named one is an error).
  const usable = found.filter(row => !inside(root, row.cwd));
  if (!usable.length || (options.session && usable.length !== found.length)) fail(AUTO_ERRORS[5]);
  // One connection name can only name one project.
  if (options.name !== undefined && usable.length !== 1) fail('invalid automatic setup options');
  const permissions = deps.permissions;
  if (await exists(root)) {
    await plain(root, true);
    if (!await isManagedRoot(root)) fail('existing folder is not a managed private setup; choose a new --root');
    await permissions.verify(root);
    await permissions.verifyTree(root);
  } else {
    await fs.mkdir(root);
    // A folder made here that cannot be made private or marked is taken away again: left unmarked it would stop the next install and be reported as not made by Setup.
    try { await permissions.protect(root, true); await writeJson(path.join(root, 'local-setup.json'), MARKER, true); }
    catch (error) { await fs.rm(path.join(root, 'local-setup.json'), { force: true }).catch(() => {}); await fs.rmdir(root).catch(() => {}); throw error; }
  }
  let lock;
  try { lock = await acquireLock(path.join(root, 'setup.lock')); } catch (e) { if (e.code === 'EEXIST') fail(SETUP_BUSY); throw e; }
  try {
    // An older folder recognised by its install pointer has no marker yet; add it so later runs and uninstall know the folder.
    if (!await exists(path.join(root, 'local-setup.json'))) await writeJson(path.join(root, 'local-setup.json'), MARKER, true);
    for (const name of ['credentials', 'sessions', 'launchers']) {
      const dir = path.join(root, name);
      if (!await exists(dir)) { await fs.mkdir(dir); await permissions.protect(dir, true); }
      else { await plain(dir, true); await permissions.verify(dir, false); }
    }
    const backup = backupWriter(root, permissions, deps.now ?? Date.now);
    // All-or-nothing for what an existing install already owns: the new copy is only added and verified first, the
    // switches come last, and every owned file this run changes is put back if any later step fails.
    const undo = []; let recordLeft = false, claudeUntracked = false, stopping = false, uncovered = false;
    // Ctrl+C, a closed window or a stop request: the install stops at its next step boundary (halt), its own failure path undoes
    // everything, and then the process ends. A step that does not finish within 10 seconds is undone as it stands; the one step whose undo is
    // only known when it finishes (connecting the assistants, which can wait on a program for 30 seconds) is then named as maybe not undone.
    let leftOver = [], settle; const settled = new Promise(resolve => { settle = resolve; });
    const halt = () => { if (stopping) throw new Error(INSTALL_STOPPED); };
    const onStop = signal => {
      if (stopping) return;
      stopping = true;
      const sleep = new Promise(resolve => setTimeout(() => resolve(false), 10000));
      Promise.race([settled.then(() => true), sleep]).then(async inTime => { const more = await rollBack(undo); return { inTime, more }; }).then(async ({ inTime, more }) => {
        const left = [...leftOver, ...more];
        await lock.close().catch(() => {}); await unlinkRetry(path.join(root, 'setup.lock'));
        // A step that was still running after 10 seconds and has no undo yet is not covered: say so instead of "undone".
        (deps.stdout ?? console.log)(INSTALL_STOPPED + ' ' + (left.length ? `Some of what it had started could not be undone: ${left.join(' ')} Run \`pots install\` again; that is safe and repairs it.`
          : !inTime && uncovered ? 'Connecting your assistants was still running after 10 seconds, so part of it may not be undone. Run `pots install` again; that is safe and repairs it.'
          : 'What it had started was undone. Run `pots install` again when you are ready.'));
        process.exit(STOPS[signal]);
      });
    };
    for (const signal of Object.keys(STOPS)) process.on(signal, onStop);
    try {
    const runtime = await installRuntime(root, backup, deps.startCheck, deps.updateIo), credentialFile = path.join(root, 'credentials/controller.json');
    const credentialCreated = !await exists(credentialFile);
    if (credentialCreated) { await createCredential(credentialFile); await permissions.protect(credentialFile, false); }
    else { await plain(credentialFile); await permissions.verify(credentialFile); }
    const connectionsFolder = path.join(root, 'connections');
    // Every saved session found is connected on its own; one that cannot be (a damaged older folder, another controller) is
    // skipped and reported, and never stops the others. Sessions already connected are always kept; new ones fill what is left.
    const registered = await exists(path.join(connectionsFolder, 'connections.json')) ? (await readConnections(connectionsFolder)).connections : [];
    const known = new Set(registered.map(row => row.binding.sessionId));
    const fresh = newestFirst(usable.filter(row => !known.has(row.sessionId))), room = Math.max(0, MAX_CONNECTIONS - registered.length);
    const chosen = options.session ? usable : [...usable.filter(row => known.has(row.sessionId)), ...fresh.slice(0, room)];
    const notBound = options.session ? 0 : fresh.length - Math.min(fresh.length, room);
    const context = { root, credentialFile, connectionsFolder, executable, detect: deps.detect, options, node: deps.nodeExecutable, cli: runtime.launcher, undo };
    const bound = [], skipped = []; let firstError;
    for (const selected of chosen) {
      try { bound.push(await bindSession(context, selected)); }
      catch (e) {
        if (options.session) throw e;
        firstError ??= e; skipped.push({ project: selected.cwd, reason: plainReason(diagnostic(e, new Set([...Object.values(MESSAGES), ...AUTO_ERRORS, ...CONNECTION_ERRORS, ...CONTROLLER_ERRORS]))) });
      }
    }
    if (!bound.length) throw firstError ?? new Error(AUTO_ERRORS[2]);
    // The shared assistant files and the reported choices follow one connection, always the same one: a connection that was already there
    // comes before a new one, then the lowest name. Discovery order and adding a project can then never change them.
    bound.sort((a, b) => known.has(b.bound.sessionId) - known.has(a.bound.sessionId) || a.row.name.localeCompare(b.row.name));
    const sessions = bound.map(item => item.row), first = bound[0].bound;
    // What this run asked for wins; a session that was open (and so kept its old file) still follows it.
    const wakeups = options.coordinatorWakeups ?? await storedWakeups(root) ?? first.coordinatorWakeups, chosenClients = options.clients ?? first.clients;
    const openKept = bound.filter(item => item.bound.kept).length;
    const instructionNames = ['claude-skill.md', 'chatgpt-custom-instructions.txt'], instructionFolder = path.join(root, 'coordinator-instructions');
    const ownedText = trackFiles(); await ownedText.before(instructionNames.map(file => path.join(instructionFolder, file)));
    undo.push(() => ownedText.restore());
    let instructionFiles, keptInstructions;
    try { ({ files: instructionFiles, kept: keptInstructions } = await installCoordinatorInstructions(root, chosenClients, wakeups, permissions, backup)); } finally { await ownedText.after(); }
    const coordinatorInstructions = await Promise.all(instructionFiles.filter(file => !keptInstructions.includes(file)).map(async file => ({
      path: path.relative(root, file).split(path.sep).join('/'),
      sha256: hash(await fs.readFile(file)),
    })));
    // --no-coordinator-wakeups on this run wins over anything stored: no watchdog settings are kept, so the scheduled task is removed below.
    const chosenResume = options.coordinatorResume ?? (options.coordinatorWakeups === false ? undefined : await existingResumeOptions(root, chosenClients));
    const coordinatorResume = resumeOptions(chosenResume ?? (options.coordinatorWakeups !== false && wakeups ? await autoResumeOptions({ root, clients: chosenClients, env: deps.env, resolve: deps.resolveResume }) : undefined), chosenClients);
    // Whether an OMP session is open is asked once, before the switch, only to say it in the result; it never blocks.
    const openSessions = deps.openSessions ? await deps.openSessions().catch(() => 1) : 0;
    // The switches. Until here the new copy was only added and verified; each one below is undone if a later one fails.
    halt();
    await runtime.commit(); undo.push(() => runtime.rollback());
    for (const item of bound) if (item.launcherPlan.rewrite) { await item.launcherPlan.rewrite(backup); undo.push(() => item.launcherPlan.undo()); }
    const claudeFile = instructionFiles.find(file => path.basename(file) === 'claude-skill.md');
    halt();
    uncovered = true;
    const assistants = await configureAssistants({ clients: chosenClients, installRoot: root, nodeExecutable: deps.nodeExecutable, mcpLauncher: runtime.launcher,
      mcpArguments: ['mcp'], connectionsFolder, credentialFile, backup,
      coordinatorInstructions: { claude: claudeFile ? await fs.readFile(claudeFile, 'utf8') : '' } },
    { home: deps.home, env: deps.env, which: deps.which ?? (async exe => locateExecutable(exe, deps.env)), run: deps.runClient ?? runClient, now: deps.now ?? Date.now });
    undo.push(() => assistants.undo()); uncovered = false;
    const shimTrack = trackFiles(); await shimTrack.before([commandFile(deps)]); undo.push(() => shimTrack.restore());
    let command; try { command = await installCommand(deps, runtime.launcher); } finally { await shimTrack.after(); }
    halt();
    const resumeFiles = await trackResume(root);
    undo.push(() => resumeFiles.restore());
    let resume;
    try {
      await rememberWakeups(root, permissions, options.coordinatorWakeups, openKept);
      resume = await installCoordinatorResume({ root, options: coordinatorResume, cwd: sessions[0].project, connectionsFolder,
        runtimeFolder: runtime.target, nodeExecutable: deps.nodeExecutable, permissions, account: deps.account ?? (deps.env.USERDOMAIN && deps.env.USERNAME ? deps.env.USERDOMAIN + '\\' + deps.env.USERNAME : deps.env.USERNAME ?? os.userInfo().username) });
    } finally { await resumeFiles.after(); }
    // Lane watcher step: no extra process or Startup entry. The runtime copied above contains it, and
    // `bridge start` runs it inside the launcher. Only the owner-editable defaults file is written here,
    // once; an existing (possibly edited) file is validated and kept.
    const watchFile = await ensureWatchSettings(sessions[0].stateFolder);
    const watchSettings = validateWatchSettings(await readJson(watchFile.file));
    await permissions.verifyTree(root);
    halt();
    if (deps.registerUninstall) {
      // The uninstall record is rolled back with the files it describes, so a retry after a failure finds them in agreement.
      const recordFile = trackFiles(); await recordFile.before(['uninstall-record.json', 'uninstall.mjs', 'clients.mjs', 'control.mjs'].map(name => path.join(root, name))); undo.push(() => recordFile.restore());
      // The files of this run (its launchers, replaced or not, and the runtime's launcher and pointer), with their hashes:
      // the only changed or unlisted files an existing record may take over.
      const added = {};
      const attest = async (folder, relative, names) => { for (const name of names) added[`${relative}/${name}`] = hash(await fs.readFile(path.join(folder, name))); };
      for (const item of bound) await attest(item.launcherFolder, `launchers/${path.basename(item.launcherFolder)}`, ['Start-OMP.ps1', 'launch-settings.json']);
      const managedFolder = path.dirname(runtime.launcher);
      if (/^(current|managed-)/.test(path.basename(managedFolder))) await attest(managedFolder, `runtime/${path.basename(managedFolder)}`, ['bridge.mjs', 'current.json']);
      // Any runtime/managed-* folder (also one an earlier, unfinished repair moved aside, even by a build with another launcher) whose launcher is byte for byte one Setup ever shipped is claimed; anything else in it stays unclaimed.
      for (const entry of (await fs.readdir(path.join(root, 'runtime'), { withFileTypes: true })).slice(0, 256)) {
        if (!entry.isDirectory() || !/^managed-[0-9a-f-]+$/.test(entry.name) || entry.name === path.basename(managedFolder)) continue;
        const folder = path.join(root, 'runtime', entry.name);
        try { await plain(path.join(folder, 'bridge.mjs')); if (!isOurLauncher(await fs.readFile(path.join(folder, 'bridge.mjs')))) continue; } catch { continue; }
        await attest(folder, `runtime/${entry.name}`, ['bridge.mjs']);
      }
      // An upgrade over an older install must never be blocked by an old leftover Setup cannot verify: the assistants are connected,
      // the old files stay untouched, and only the uninstall list is not brought up to date.
      const upgrading = await exists(path.join(root, 'uninstall-record.json'));
      try {
        try { await deps.registerUninstall(root, { nodeExecutable: deps.nodeExecutable, coordinatorInstructions, coordinatorResume: resume, added }); }
        catch (e) { if (!upgrading || e?.constructor !== Error || e.message !== 'uninstall refused: unverified install file') throw e; recordLeft = true; }
        if (assistants.claudeCode && !(await trackClaudeCode(root, assistants.claudeCode.exe, claudeIntegration({ home: deps.home, env: deps.env }))).tracked) claudeUntracked = true;
        if (assistants.owned?.length || command.sha256) await trackAssistants(root, [...(assistants.owned ?? []), ...(command.sha256 ? [{ kind: 'pots-command', file: command.file, sha256: command.sha256 }] : [])]);
      } finally { await recordFile.after(); }
      await permissions.verifyTree(root);
    }
    // Only after everything above succeeded: connections whose saved session is gone are removed (only their rows, never any
    // session file), and old copies are never removed for a run that is about to be undone. A row that cannot be removed now stays and is shown as unavailable.
    const dropped = await dropUnavailableConnections(connectionsFolder).catch(() => []);
    // The scheduled task and the watchdog on the code just installed. A failure never undoes the install, but it is printed and logged.
    halt();
    let wakeProblem, ownerOff = false, oddMarker = false;
    if (deps.tasks && !resume.leftAsIs) {
      if (resume.task) {
        // Undo of this step: the "please stop" note it may make (an empty `disabled` file Setup makes itself) is removed, and so is the task if this run made it.
        // A task that cannot be asked about is treated as one that was there before, so an undo never deletes it.
        const marker = path.join(root, 'coordinator-resume', 'control', 'disabled'), hadMarker = await exists(marker), hadTask = await deps.tasks.query(resume.task.name).then(found => found !== null, () => true);
        undo.push(async () => { if (!hadTask) await deps.tasks.remove(resume.task.name, resume.task.mark); if (!hadMarker && (await fs.stat(marker).catch(() => ({ size: 1 }))).size === 0) await fs.unlink(marker).catch(() => {}); });
      }
      try { const { status } = await applyResumeTask({ root, task: resume.task, tasks: deps.tasks, pollMs: coordinatorResume.pollMs }); ownerOff = status === 'disabled-by-owner'; oddMarker = status === 'marker-not-a-file'; }
      catch { wakeProblem = resume.task ? 'Wake-ups are NOT working: Windows would not set up the scheduled task that keeps the watchdog running. Next: run pots doctor.' : 'Wake-ups are turned off, but Windows would not remove the scheduled task, so the watchdog may still run. Next: run pots install again.'; await logProblem(root, wakeProblem, deps.now ?? Date.now); }
    }
    // Plain words for the two cases where the wake-up state is not what the person might expect.
    const wakeNote = ownerOff ? `Wake-ups are switched off by the owner marker (you used Disable-Resume): ${path.join(root, 'coordinator-resume', 'control', 'disabled')}. To turn them on, delete that file and run pots install.`
      : oddMarker ? `Wake-ups are OFF: ${path.join(root, 'coordinator-resume', 'control', 'disabled')} is a folder or a link, not a file, so the watchdog stays stopped. Setup did not make it and will not delete it. Next: delete or rename it, then run pots install again.`
      : resume.leftAsIs && wakeups === false ? `You asked for wake-ups to be off, but old wake-up files from an earlier version were left as they are, because Setup could not be sure they are unchanged and made by it. Setup did not stop them, so an old scheduled task may still start assistants. Next: to stop it now, run Disable-Resume.cmd in ${path.join(root, 'coordinator-resume')} (if it is there); to remove it, move your changed files away and run pots install --no-coordinator-wakeups again.`
      : resume.leftAsIs ? `Wake-ups were not changed: old wake-up files from an earlier version were left as they are, because Setup could not be sure they are unchanged and made by it. So no scheduled task was set up and the wake-up test did not run, and an old task may still run. Next: move your changed files in ${path.join(root, 'coordinator-resume')} somewhere else and run pots install again; pots doctor shows what works.`
      : undefined;
    const result = await finish({ root, runtime, sessions, skipped, notBound, dropped, retired: bound.flatMap(item => item.retired), openSessions, credentialCreated, connectionsFolder,
      credentialFile, instructionFiles, keptInstructions, resume, resumeChosen: chosenResume !== undefined, assistants, backup, watchFile, watchSettings, deps, executable, clients: chosenClients, coordinatorWakeups: wakeups, wakeNote, host, command });
    if (openKept) result.summary.push(`${openKept === 1 ? 'One OMP session is' : `${openKept} OMP sessions are`} open, so ${openKept === 1 ? 'it keeps' : 'they keep'} the older choices until closed. Next: close ${openKept === 1 ? 'it' : 'them'}, then run pots install again.`);
    if (wakeProblem) { result.wakeProblem = wakeProblem; result.summary.push(wakeProblem); }
    if (olderFolder) result.olderFolder = olderFolder;
    if (claudeUntracked) result.summary.push('Claude Code is connected, but its settings file (.claude.json) could not be read to check that entry, so pots uninstall will leave it. Next: when you uninstall, also run: claude mcp remove omp-session-bridge --scope user');
    if (recordLeft) result.summary.push('Your assistants were connected. Some old files from an earlier version could not be checked, so Setup left them as they are and the uninstall list was not updated. Details: an older install file did not match its record (uninstall refused: unverified install file).');
    result.backupFolder = backup.folder ?? null;
    return result;
    } catch (e) {
      leftOver = await rollBack(undo);
      if (leftOver.length) e.left = leftOver;
      throw e;
    } finally { for (const signal of Object.keys(STOPS)) process.off(signal, onStop); settle(); }
  } finally {
    // The install is already finished or has failed for its own reason: a lock a scanner still holds must not replace either.
    await lock.close().catch(() => {}); await unlinkRetry(path.join(root, 'setup.lock'));
  }
}

const STOPS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
// Runs each recorded undo step once, newest first; returns what could not be put back.
async function rollBack(undo) {
  const left = [];
  for (const step of undo.splice(0).reverse()) { try { const r = await step(); if (r?.left?.length) left.push(...r.left); } catch { left.push('A change could not be undone; the copies Setup kept are in the install folder named backups.'); } }
  return left;
}

// The assistant adapter calls this (at most every 30 seconds) so a session saved after Setup is connected without a new
// Setup run: only a session the registry does not have yet, newest first, up to the registry limit, and only with the
// controller credential the adapter already holds. A session that cannot be connected is left out and tried again later.
export async function syncSessions({ connectionsFolder, credentialFile, env, home, detect }) {
  const root = path.dirname(connectionsFolder);
  const registered = (await readConnections(connectionsFolder)).connections;
  const room = MAX_CONNECTIONS - registered.length;
  if (room <= 0) return 0;
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, '.omp/agent');
  const known = new Set(registered.map(row => row.binding.sessionId));
  const fresh = newestFirst((await discoverSessions([path.join(absolute(agentDir), 'sessions'), path.join(absolute(agentDir), 'custom-session-files')]))
    .filter(row => !known.has(row.sessionId) && !inside(root, row.cwd)));
  if (!fresh.length) return 0;
  let executable;
  for (const row of registered) { try { executable = (await loadConnection(row)).launch.executable; break; } catch { /* a dead connection is skipped, never a reason to connect nothing */ } }
  if (!executable) return 0;
  const context = { root, credentialFile, connectionsFolder, executable, detect, node: process.execPath, cli: path.join(runtimeTarget(root), 'bridge.mjs') };
  // `pots install` holds setup.lock while it fills a session folder, and binding clears a half-made one: binding without the lock could remove
  // what the install is still writing. A busy lock skips this round (the next check tries again); the registry is read again once the lock is ours.
  const lockFile = path.join(root, 'setup.lock');
  let lock; try { lock = await acquireLock(lockFile); } catch (e) { if (e.code === 'EEXIST') return 0; throw e; }
  let added = 0;
  try {
    const connected = (await readConnections(connectionsFolder)).connections, again = new Set(connected.map(row => row.binding.sessionId));
    for (const selected of fresh.filter(row => !again.has(row.sessionId)).slice(0, MAX_CONNECTIONS - connected.length)) { try { await bindSession(context, selected); added++; } catch { /* left out; the next check tries again */ } }
  } finally { await lock.close(); await unlinkRetry(lockFile); }
  return added;
}
// What bin/mcp.mjs passes to the adapter; an adapter without the controller credential connects nothing by itself.
export function makeSessionSync(env = process.env, deps = {}) {
  const connectionsFolder = env.OMP_BRIDGE_STATE, credentialFile = env.OMP_BRIDGE_CONTROLLER;
  if (typeof connectionsFolder !== 'string' || !path.isAbsolute(connectionsFolder) || typeof credentialFile !== 'string' || !path.isAbsolute(credentialFile)) return undefined;
  let last = 0;
  return async () => {
    const now = Date.now();
    if (now - last < 30000) return;
    last = now;
    await syncSessions({ connectionsFolder, credentialFile, env, home: os.homedir(), detect: detectHost, ...deps });
  };
}

const NOT_VERIFIED = 'Setup did not remove anything of the older versions because the new copy could not be checked completely. Run pots install again.';
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// The new copy is only trusted for cleanup when it starts, its launcher points at it and every saved project record loads with it.
async function verifyNewCopy(result, deps) {
  try {
    await (deps.startCheck ?? startCheck)(result.runtimeFolder);
    for (const session of result.sessions) {
      const settings = JSON.parse(await fs.readFile(path.join(path.dirname(session.launcher), 'launch-settings.json'), 'utf8'));
      if (settings.cli !== result.cliLauncher || !same(settings.state, session.stateFolder)) return false;
    }
    if (result.assistants.items.some(item => item.status === 'failed')) return false;
    for (const row of (await readConnections(result.connectionsFolder)).connections) await loadConnection(row);
    return true;
  } catch { return false; }
}

// After a verified install only: remove the backups of earlier runs that Setup can prove it wrote itself. Nothing here can
// fail the install; whatever is not removed is reported plainly.
async function cleanUpOlder(result, deps) {
  const cleanup = { verified: false, left: [], backupsRemoved: 0 };
  result.cleanup = cleanup;
  if (!await verifyNewCopy(result, deps)) { result.summary.push(NOT_VERIFIED); return; }
  cleanup.verified = true;
  const backups = await pruneBackups(result.installRoot, result.backupFolder);
  Object.assign(cleanup, { left: backups.left, backupsRemoved: backups.removed });
  result.backupsRemoved = backups.removed;
  if (backups.removed) result.summary.push(`Removed what older versions left behind: ${plural(backups.removed, 'older backup', 'older backups')}.`);
  for (const row of backups.left.slice(0, 10)) result.summary.push(`left alone: ${row.path} (${row.reason})`);
  if (backups.left.length > 10) result.summary.push(`and ${backups.left.length - 10} more left alone; see the details`);
}

export async function autoSetup(options, deps) {
  const result = await installOnce(options, deps);
  // Only a run that has a process finder (the real defaults always do) prunes; without one nothing is removed.
  if (typeof deps.processes === 'function') await cleanUpOlder(result, deps);
  if (result.olderFolder && await exists(result.olderFolder)) result.summary.unshift(OLDER_FOLDER(result.olderFolder, result.installRoot));
  else delete result.olderFolder;
  // The last step: prove the wake-up path on a throwaway lane. A failure is printed and logged, never hidden. Nothing is tested when
  // wake-ups are off or switched off by the owner marker.
  if (typeof deps.selfTest === 'function' && !result.coordinatorResume.leftAsIs && !result.wakeNote && result.coordinatorResume.options.cliClients !== 'none') {
    result.selfTest = await deps.selfTest(result).catch(() => ({ pass: false, text: 'Wake-up self-test: FAIL. It could not run. Next: run pots doctor.' }));
    result.summary.push(result.selfTest.text);
    if (!result.selfTest.pass) await logProblem(result.installRoot, result.selfTest.text, deps.now ?? Date.now);
  }
  return result;
}

// One sentence for the terminal: what happened, then a real next step or that nothing is left. It is built here so that
// `pots install` and its JSON output can never say different things.
export const NOTHING_LEFT = 'Nothing else to do.';
const USE_IT = 'Next: to let your assistant work in a project, open that project with its Pi on the Side launcher (pots install --details lists them).';
const SKIPPED_NEXT = 'Next: run pots install again to try the skipped project. pots install --details says why it was skipped.';
export function resultMessage(result) {
  const todo = result.assistants.needsYou.find(row => row.action);
  const next = todo ? `Next: ${todo.fix}` : result.skipped.length ? SKIPPED_NEXT : result.upgrade.kind === 'fresh' ? USE_IT : NOTHING_LEFT;
  const off = result.coordinatorWakeups === false && result.coordinatorResume?.options?.cliClients === 'none' && !result.wakeNote;
  return `${result.upgrade.message} ${next}${off ? ` Wake-ups are off by your choice. ${WAKEUPS_ON_AGAIN} ${WAKEUPS_FORGOTTEN}` : ''}${result.wakeNote ? ' ' + result.wakeNote : ''}${result.selfTest ? ' ' + result.selfTest.text : ''}${result.wakeProblem ? ' ' + result.wakeProblem : ''}`;
}
// Technical text for the Details box, in labelled blocks. No secrets, only names and places.
export function resultDetails(result) {
  const block = (title, rows) => rows.length ? [title, ...rows.map(row => '  ' + row), ''] : [];
  const lines = [...block('What happened', result.summary),
    ...block('Version', [result.upgrade.from ? `Now ${result.upgrade.to}, before ${result.upgrade.from}` : `${result.upgrade.to}`]),
    ...block('Where it is installed', [`Install folder: ${result.installRoot}`, `Program folder: ${result.runtimeFolder}`, `Assistant folder: ${result.connectionsFolder}`, `Permission file: ${result.credentialFile}`, `pots command: ${result.command.file}`,
      ...result.assistants.needsYou.filter(row => row.file).map(row => `${row.client} instructions: ${row.file}`)]),
    ...block('Copies of what was replaced', result.backupFolder ? [result.backupFolder] : [])];
  for (const row of result.sessions) lines.push(...block(`Project ${row.project}`, [`Name: ${row.name}`, `Saved session: ${row.sessionId}`, `Launcher: ${row.launcher}`, `Command: ${row.startCommand}`]));
  for (const row of result.skipped) lines.push(...block(`Skipped project ${row.project}`, [`Why: ${row.reason}`]));
  return lines.join('\n').trimEnd();
}

export const autoDefaults = { platform: process.platform, env: process.env, home: os.homedir(),
  nodeExecutable: process.execPath, permissions: windowsPermissions(), openSessions: async () => (await windowsProcesses()).length, registerUninstall:registerInstallation,
  processes: uninstallDefaults.processes, registry: windowsRegistry(), tasks: windowsTasks(),
  selfTest: result => selfTest({ root: result.installRoot, tasks: windowsTasks(), env: process.env, watch: { pollMs: result.laneWatch.pollSeconds * 1000, idleMs: result.laneWatch.idleSeconds * 1000 },
    stopText: result.upgrade ? resultMessage(result) + ' The install is complete; only the wake-up test was stopped. Next: run pots doctor to run it again.' : 'The wake-up test was stopped. Nothing was changed.' }),
  modelRoles: (executable, cwd) => modelRolesStatus(executable, cwd) };
