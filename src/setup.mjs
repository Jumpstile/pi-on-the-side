import fs from 'node:fs/promises';
import path from 'node:path';
import { config, initialize, isStaleLock, plain, readJson, same, Store, writeJson } from './control.mjs';
import { CONTROLLER_RECORD_NOT_FILE } from './controller.mjs';
import { sessionIdentity, validateSavedSession } from './transcript.mjs';
import { isOmpVersion } from './host.mjs';

export const CHECKOUT = path.resolve(import.meta.dirname, '..');
export const MESSAGES = Object.freeze({
  noOmp: 'OMP executable not found on PATH',
  host: 'unrecognized OMP executable or version response',
  node: 'unsupported Node.js; requires 22+',
  incomplete: 'not a complete bridge setup folder',
  mismatch: 'existing bridge setup does not match this session or OMP',
  otherCopy: 'this session is already connected through another saved copy of its file, so this copy was left out',
  otherOmp: 'this session was connected with a different OMP program than the one installed now',
  outside: 'state folder must be outside the bridge checkout and session project',
  locked: 'bridge lock present; follow offline recovery before starting',
  changed: 'bridge setup changed during start; nothing launched',
  notConfigured: 'bridge state not configured',
});
// Readiness never inspects credentials or starts a login, so it cannot know.
export const PROVIDER_AUTH = "not verified; use OMP's normal provider login and quota workflow";
export const OWNER_ONLY = 'not verified; restrict this folder to your own account yourself (Node mode flags do not set a Windows ACL)';
export const CANCEL_NOTE = "Cancellation recorded for future bridge steps only. Active OMP work may continue; interrupt it with OMP's own controls.";

// Only fixed text is ever printed. Parser/runtime diagnostics (e.g. V8
// JSON.parse snippets or path-bearing errors) can quote private input.
export const FIXED = new Set([...Object.values(MESSAGES), 'invalid config', 'config paths must be canonical', 'invalid plan',
  'invalid step', 'plan too large', 'linked or non-plain path', 'linked ancestor', 'file too large', 'file changed',
  'record too large', 'root must be canonical and absolute', 'invalid record identity', 'wrong session', 'queue capacity reached', 'plan id already used',
  'queue capacity exceeded', 'receipt identity mismatch', 'invalid control record', 'transcript changed',
  'transcript header invalid', 'transcript identity mismatch', 'partial transcript', 
  'invalid command request', 'command identity mismatch', 'invalid command receipt', 'unknown command id',
  'Muse is no longer supported; choose Claude, ChatGPT, or both.']);
// The internal sentence means nothing to a person: say what it means and what to do, keep the technical text under Details.
const BARE_OPTIONS = 'invalid automatic setup options';
const OPTIONS_HELP = 'Setup could not use the settings it was given or found from an earlier install, so it stopped. Nothing was lost. Check the options you typed, or run pots install again; if this comes back, send the Details to support.';
const REFUSED_HELP = 'Pi on the Side stopped because it found a file or record in the install folder that it could not check. Nothing was removed or lost. Try again; if this comes back, send the Details to support.';
const CODES = new Set(['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EMFILE', 'EROFS', 'ENOSPC']);
export function diagnostic(error, allowed = FIXED) {
  if (CODES.has(error?.code)) return error.code;
  if (error instanceof SyntaxError) return 'malformed JSON input';
  // A Windows helper failure says what failed in plain words, with the technical cause under Details.
  if (error?.name === 'HelperFailure' && typeof error.report === 'function') return error.report();
  // A sentence the code built itself from fixed words, numbers and a lane name (see `say` in connections.mjs).
  if (error?.constructor === Error && error.plain === true) return error.message;
  if (error?.constructor === Error && allowed.has(error.message)) return error.message === BARE_OPTIONS ? OPTIONS_HELP + '\nDetails: ' + BARE_OPTIONS : error.message.startsWith('uninstall refused') ? REFUSED_HELP + '\nDetails: ' + error.message : error.message;
  return 'unexpected error';
}
const fail = message => { throw new Error(message); };

export const nodeSupported = version => Number(String(version).split('.')[0]) >= 22;

// Resolves `omp` from absolute PATH entries only. Relative entries would depend
// on the caller's working directory. Windows accepts only omp.exe: a .cmd/.ps1
// shim would need a shell, which the launcher never uses.
export async function locateOmp(env) {
  const windows = process.platform === 'win32';
  const key = Object.keys(env).find(name => windows ? name.toUpperCase() === 'PATH' : name === 'PATH');
  const value = key === undefined ? '' : env[key];
  if (typeof value !== 'string') return null;
  const name = windows ? 'omp.exe' : 'omp';
  for (let entry of value.split(path.delimiter)) {
    if (windows && entry.length > 1 && entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    if (!entry || !path.isAbsolute(entry) || (windows && !/^[a-z]:[\\/]/i.test(entry))) continue;
    const file = path.join(path.resolve(entry), name);
    try {
      if (!(await fs.stat(file)).isFile()) continue;
      if (!windows) await fs.access(file, fs.constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

// The version probe is the only readiness check: exact supported host or refuse.
export async function requireHost(detect, executable) {
  let host = null;
  try { host = await detect(executable); } catch { /* unknown host */ }
  if (!isOmpVersion(host)) fail(MESSAGES.host);
  return host;
}

const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};
function requireOutside(root, cwd) {
  if (inside(root, CHECKOUT) || inside(root, cwd)) fail(MESSAGES.outside);
}

const ENTRIES = ['config.json', 'control', 'launch.json', 'plans', 'receipts'].sort().join('/');
const LOCK = /^supervisor-.*\.lock$/;
const CONTROLLER = /^controller-.*\.(json|lock)$/;
const TEMP = /^(?:config|launch|controller-[0-9a-f-]{36})\.json\.[0-9a-f-]{36}\.tmp$/;
const TEMP_MS = 60000;
const lockName = sessionId => `supervisor-${sessionId}.lock`;
function launchRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).sort().join() !== 'executable,sessionFile,version') fail(MESSAGES.incomplete);
  for (const key of ['executable', 'sessionFile']) {
    const file = value[key];
    if (typeof file !== 'string' || !path.isAbsolute(file) || file !== path.resolve(file)) fail(MESSAGES.incomplete);
  }
  return Object.freeze({ ...value });
}

// Accepts only a folder this setup generated, complete and unchanged in shape:
// Five setup entries plus this session's supervisor/controller records. Older
// directory clients reject the new entries rather than bypass ownership.
// Every directory command (and every MCP call) revalidates config, launch
// metadata, containment and the saved session's header identity.
export async function loadSetup(root, now = Date.now) {
  await plain(root, true);
  // A temp file of the product's own record writes (see writeJson) can be left by a power cut. It is ignored, and removed once it is too old to belong to a write in progress.
  const all = await fs.readdir(root), names = [];
  for (const name of all) {
    if (!TEMP.test(name)) { names.push(name); continue; }
    const file = path.join(root, name);
    try { if ((await plain(file)).mtimeMs < now() - TEMP_MS) await fs.unlink(file); } catch { /* ignored either way */ }
  }
  const locks = names.filter(name => LOCK.test(name));
  const controllers = names.filter(name => CONTROLLER.test(name));
  if (names.filter(name => !LOCK.test(name) && !CONTROLLER.test(name)).sort().join('/') !== ENTRIES || locks.length > 1 || controllers.length > 2) fail(MESSAGES.incomplete);
  let settings, launch;
  try {
    settings = config(await readJson(path.join(root, 'config.json')));
    launch = launchRecord(await readJson(path.join(root, 'launch.json')));
  } catch (error) {
    if (error?.message === 'Muse is no longer supported; choose Claude, ChatGPT, or both.') fail(error.message);
    fail(MESSAGES.incomplete);
  }
  if (!same(settings.root, root) || (locks.length && locks[0] !== lockName(settings.sessionId))) fail(MESSAGES.incomplete);
  for (const name of controllers) {
    if (![ `controller-${settings.sessionId}.json`, `controller-${settings.sessionId}.lock` ].includes(name)) fail(MESSAGES.incomplete);
    try { await plain(path.join(root, name)); } catch (e) { if (/^linked /.test(e.message)) fail(CONTROLLER_RECORD_NOT_FILE); throw e; }
  }
  requireOutside(settings.root, settings.cwd);
  const store = new Store(settings, now);
  await store.ready();
  await validateSavedSession(launch.sessionFile, settings);
  return { settings, launch, store, configFile: path.join(settings.root, 'config.json'),
    lockFile: path.join(settings.root, lockName(settings.sessionId)) };
}

export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// The private folder Setup keeps its files in. A folder is Setup's when it carries the exact marker file, or when it holds an
// install pointer Setup wrote (runtime/<folder>/current.json, as older versions left it, which had no marker). What else
// is in the folder does not matter: Setup adds to its own folder and never removes what it cannot prove it made.
export const MARKER = { version: 1, type: 'omp-session-bridge-local' };
export async function isManagedRoot(root) {
  try { if (JSON.stringify(await readJson(path.join(root, 'local-setup.json'))) === JSON.stringify(MARKER)) return true; } catch { /* no marker */ }
  try {
    for (const name of await fs.readdir(path.join(root, 'runtime'))) {
      const pointer = await readJson(path.join(root, 'runtime', name, 'current.json')).catch(() => null);
      if (pointer?.version === 1 && typeof pointer.current === 'string' && /^\d+\.\d+\.\d+/.test(pointer.current)) return true;
    }
  } catch { /* no runtime folder */ }
  return false;
}

// The default folder is "<base>"; when an older folder of that name is not Setup's, Setup uses "<base> 2", "<base> 3", ...
// (never more than DEFAULT_ROOT_TRIES names). Which one is in use is read back from the marker file, so every later run,
// upgrade and connection check lands on the same folder without a second record.
const DEFAULT_ROOT_NAME = 'OMP Session Bridge Local';
const DEFAULT_ROOT_TRIES = 50;
export const defaultRootBase = ({ env, home }) => path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), DEFAULT_ROOT_NAME);
// state: 'free' (does not exist), 'ours' (a managed setup of ours), 'other' (anything else, including links and files).
export async function defaultRootStates(base) {
  const rows = [];
  for (let i = 1; i <= DEFAULT_ROOT_TRIES; i++) {
    const root = i === 1 ? base : `${base} ${i}`;
    let state = 'free';
    if (await exists(root)) { try { await plain(root, true); state = await isManagedRoot(root) ? 'ours' : 'other'; } catch { state = 'other'; } }
    rows.push({ root, state });
  }
  return rows;
}

// Rolls back the folder THIS setup call just created and failed to finish. Only
// setup's own entries are accepted (no lock, plan, unknown file or link); entries
// are removed one by one and the folder with a plain rmdir, so anything that
// appears meanwhile makes this fail closed instead of being deleted. A folder that
// already existed before the call is never removed.
async function discardUnfinished(root) {
  await plain(root, true);
  const names = await fs.readdir(root), known = ENTRIES.split('/');
  if (names.some(name => !known.includes(name)) || (names.includes('config.json') && names.includes('launch.json'))) return false;
  for (const name of names) {
    const stat = await fs.lstat(path.join(root, name));
    if (stat.isSymbolicLink()) return false;
    if (name.endsWith('.json') ? !stat.isFile() || stat.size > 65536 : !stat.isDirectory() || (await fs.readdir(path.join(root, name))).length) return false;
  }
  for (const name of names) {
    if (name.endsWith('.json')) await fs.unlink(path.join(root, name)); else await fs.rmdir(path.join(root, name));
  }
  await fs.rmdir(root);
  return true;
}

// An older Setup that failed late removed the new project's config.json and left the rest of the folder (launch.json,
// its own controller record, empty record folders). Writes the config again, from the saved session's own identity,
// only into such a folder; loadSetup then checks everything as usual. Setup's later options still apply on top.
export async function restoreConfig(root, identity) {
  if (await exists(path.join(root, 'config.json')) || !await exists(path.join(root, 'launch.json'))) return;
  await writeJson(path.join(root, 'config.json'), config({ sessionId: identity.sessionId, cwd: identity.cwd, root, coordinatorWakeups: true, clients: 'both' }), true);
}

// A first Setup cut off (power loss) after it made the folder and before it saved launch.json leaves only empty record folders, maybe a
// config.json. Nothing in it is anyone's work: it is removed so the next Setup starts that project again. Anything else is left for loadSetup to judge.
export async function discardUnstarted(root) {
  if (!await exists(root) || await exists(path.join(root, 'launch.json'))) return false;
  return discardUnfinished(root).catch(() => false);
}

// Creates a new private state folder for the saved session's exact identity,
// or confirms an identical complete setup. Never adopts, repairs or overwrites.
export async function setup(sessionArg, stateArg, { locate, detect, coordinatorWakeups = true, clients = 'both', keepWhenOpen = false }) {
  if (typeof coordinatorWakeups !== 'boolean' || !['claude','chatgpt','both'].includes(clients)) fail('invalid automatic setup options');
  await plain(path.resolve(sessionArg));
  const sessionFile = await fs.realpath(path.resolve(sessionArg));
  const identity = await sessionIdentity(sessionFile);
  await plain(identity.cwd, true);
  await validateSavedSession(sessionFile, identity);
  const requested = path.resolve(stateArg);
  requireOutside(requested, identity.cwd);
  const executable = await locate();
  if (!executable) fail(MESSAGES.noOmp);
  const host = await requireHost(detect, executable);
  const report = (created, root, settings) => ({ created, stateFolder: root, configFile: path.join(root, 'config.json'),
    sessionId: identity.sessionId, cwd: identity.cwd, sessionFile, executable, host,
    coordinatorWakeups: settings.coordinatorWakeups, clients: settings.clients,
    providerAuth: PROVIDER_AUTH, ownerOnlyPermissions: OWNER_ONLY });

  // An existing folder is never adopted or removed here; an unfinished one must be inspected and removed by its owner.
  if (await exists(requested)) {
    const current = await loadSetup(requested);
    // Say which part differs, so a skipped project can be understood (the first differing part is named).
    if (current.settings.sessionId !== identity.sessionId || !same(current.settings.cwd, identity.cwd)) fail(MESSAGES.mismatch);
    if (!same(current.launch.sessionFile, sessionFile)) fail(MESSAGES.otherCopy);
    if (!same(current.launch.executable, executable)) fail(MESSAGES.otherOmp);
    const selected = config({ ...current.settings, coordinatorWakeups, clients });
    if (selected.coordinatorWakeups !== current.settings.coordinatorWakeups || selected.clients !== current.settings.clients) {
      // A lock left by a crashed lane (its owner no longer runs) is not an open session: install may change the saved choices.
      if (await exists(current.lockFile) && !(keepWhenOpen && await isStaleLock(current.lockFile))) {
        // An open OMP session holds its saved choices. Install keeps them as they are (`kept`) and says so; a direct setup call still refuses.
        if (!keepWhenOpen) fail(MESSAGES.locked);
        return { ...report(false, current.settings.root, current.settings), kept: true };
      }
      await writeJson(current.configFile, selected);
    }
    return report(false, current.settings.root, selected);
  }
  await plain(path.dirname(requested), true);
  const root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  const settings = config({ sessionId: identity.sessionId, cwd: identity.cwd, root, coordinatorWakeups, clients });
  await initialize(root); // Non-recursive mkdir: an existing folder is never adopted.
  // Exclusive link publication. If it fails midway, remove the folder this call
  // just created so a retry is not blocked by a half-made lane.
  try {
    await writeJson(path.join(root, 'config.json'), settings, true);
    await writeJson(path.join(root, 'launch.json'), { version: 1, sessionFile, executable }, true);
  } catch (error) {
    await discardUnfinished(root).catch(() => {});
    throw error;
  }
  return report(true, root, settings);
}
