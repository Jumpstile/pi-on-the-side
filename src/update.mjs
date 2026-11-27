import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { acquireLock, isKeptLock, keepLock, plain, readJson, unlinkRetry, writeJson } from './control.mjs';
import { CHECKOUT, exists, loadSetup } from './setup.mjs';
import { unzip, zip } from './zip.mjs';

// Optional updater. The only authority is the release list of one private
// GitHub repository, read and downloaded through the user's existing GitHub CLI
// login with fixed argument vectors. The bridge never reads, stores or passes
// credentials, never starts a login, and accepts no repository, host, URL,
// mirror or token override. A release asset's sha256 digest from that metadata
// binds the downloaded bytes (integrity); it is not independent publisher
// authentication. Nothing from a bundle is executed while installing.
export const REPOSITORY = 'Jumpstile/pi-on-the-side';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/`;
const WEB = `https://github.com/${REPOSITORY}/releases/`;
const ENDPOINT = `repos/${REPOSITORY}/releases`;
const PER_PAGE = 100, MAX_PAGES = 5;
const MIB = 1024 * 1024;
const METADATA = { timeout: 20000, maxBytes: 4 * MIB };
const DOWNLOAD_TIMEOUT = 60000;
const MAX_ASSET = 4 * MIB;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
// The runtime files of THIS release (also the packer's --release allowlist).
// A bundle must carry exactly the list its own package.json declares in
// `runtimeFiles` (a bundle without one must carry exactly this list), and an
// installed version folder is judged by the list in its own release.json. So
// changing this list never blocks an update or an upgrade: only a name that is
// not a runtime-shaped file, or a missing launcher-critical file, is refused.
export const RELEASE_FILES = Object.freeze(['NOTICE.md', 'SECURITY.md', 'bin/bridge.mjs', 'bin/coordinator-resume.mjs', 'bin/mcp.mjs', 'extension/bridge.ts',
    'package.json', 'src/autosetup.mjs', 'src/cli.mjs', 'src/clients.mjs', 'src/connections.mjs', 'src/control.mjs', 'src/controller.mjs', 'src/coordinator-heartbeat.mjs', 'src/coordinator-resume.mjs', 'src/coordinator-resume-setup.mjs', 'src/host.mjs', 'src/icon.mjs', 'src/lane-status.mjs', 'src/lane-watch.mjs', 'src/live.mjs', 'src/mcp.mjs', 'src/setup.mjs', 'src/transcript.mjs',
  'src/model-setup.mjs', 'src/uninstall.mjs', 'src/update.mjs', 'src/zip.mjs'].sort());
const RUNTIME_NAME = /^(?:NOTICE\.md|SECURITY\.md|package\.json|(?:bin|src|extension)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|ts))$/;
const CORE_FILES = ['bin/bridge.mjs', 'bin/mcp.mjs', 'extension/bridge.ts', 'package.json', 'src/cli.mjs'];
const shaped = names => Array.isArray(names) && names.length <= 64 && names.every(name => typeof name === 'string' && RUNTIME_NAME.test(name)) &&
  new Set(names.map(name => name.toLowerCase())).size === names.length && CORE_FILES.every(name => names.includes(name));
const sameNames = (a, b) => [...a].sort().join('\n') === [...b].sort().join('\n');
function declaredFiles(data) {
  // Absent means "use the running version's list"; a present-but-invalid value (null, a string...) is returned as is and refused by `shaped`.
  try { const pkg = JSON.parse(data.toString('utf8')); return Object.hasOwn(pkg, 'runtimeFiles') ? pkg.runtimeFiles : undefined; } catch { return undefined; }
}
const NODE_FLOOR = 22;
const POINTER = 'current.json', LAUNCHER_FILE = 'bridge.mjs', VERSIONS = 'versions', STAGING = 'staging', BUSY = 'activate.lock';
// A cut-off write leaves `<name>.<id>.tmp`; it is harmless and must not stop an update or an update check. Install (prepareManagedRuntime) stays strict: it moves such a folder aside and rebuilds it.
const STRAY_TMP = /^[A-Za-z0-9._-]+\.[0-9a-f-]{36}\.tmp$/;
const RECORD = 'release.json';
const ROOT_ENTRIES = [LAUNCHER_FILE, POINTER, STAGING, VERSIONS].sort().join('/');

export const MESSAGES = Object.freeze({
  source: 'running from a source checkout; apply and rollback need the managed launcher (nothing changed)',
  outside: 'install folder must be outside the bridge checkout and state folder',
  incomplete: 'not a complete managed install folder',
  exists: 'install folder already exists',
  leftover: 'The install did not finish, and what it had already made in the install folder could not be removed (a program may be holding a file). Next: close other programs, delete that install folder yourself, then run pots update install again.',
});

const KEEP = 'keeping the current version.';
export const NOTES = Object.freeze({
  'up-to-date': 'The current version is the newest eligible release.',
  'update-available': 'A newer eligible release is published. A managed install applies it with `update apply`; a source checkout is updated with git.',
  'no-releases': `No eligible release is published; ${KEEP}`,
  'gh-missing': `GitHub CLI (gh) was not found on PATH; ${KEEP}`,
  'auth-missing': `GitHub CLI has no usable github.com login and the bridge never starts one; ${KEEP}`,
  'no-access': `The existing GitHub CLI login cannot read this repository's releases; ${KEEP}`,
  'unavailable': `GitHub could not be reached in time; ${KEEP}`,
  'invalid-release': `Release metadata failed validation; ${KEEP}`,
  'missing-digest': `The release asset has no sha256 digest; ${KEEP}`,
  'download-failed': `The bounded download did not complete; ${KEEP}`,
  'digest-mismatch': `The download does not match the published sha256 digest; ${KEEP}`,
  'too-many-releases': `More than 500 releases are listed, so the bounded prerelease scan cannot be complete; ${KEEP}`,
  'invalid-bundle': `The release bundle failed validation; ${KEEP}`,
  'incompatible': `The release needs a different Node.js or OMP version; ${KEEP}`,
  'conflict': `A different folder for this version already exists and was left untouched; ${KEEP}`,
  'stage-failed': `The new version could not be staged or did not start; ${KEEP}`,
  'staged': 'Verified and staged, not active. Rerun with --confirm-offline to activate it.',
  'deferred': `Another update is running or was interrupted (lock file activate.lock, next to current.json in runtime/current); ${KEEP}`,
  'activated': 'Activated. Running OMP processes keep the version they loaded; start again through the launcher to use it.',
  'activation-failed': `Activation failed and the original pointer is in place; ${KEEP}`,
  'activation-failed-unrestored': 'Activation failed and the original pointer could not be restored. The install lock ' +
    'is kept so no other update can start until it is checked (the launcher still starts the version current.json names); follow recovery in docs/update.md.',
  'installed': 'Managed install created. Run it through its bridge.mjs launcher; the source checkout is never changed.',
  'no-previous': `No retained previous version; ${KEEP}`,
  'verification-failed': `The version folder does not match its release record; ${KEEP}`,
  'rollback-ready': 'The retained previous version verifies. Rerun with --confirm-offline to activate it.',
  'rolled-back': 'Rolled back to the retained previous version. Start again through the launcher to use it.',
  'failed': `The update step failed unexpectedly; ${KEEP}`,
});
export const SUCCESS = new Set(['up-to-date', 'update-available', 'no-releases', 'staged', 'activated', 'installed', 'rollback-ready', 'rolled-back']);
export const REASONS = Object.freeze({ busy: 'another update or rollback is running', changed: 'install changed during update', kept: 'an earlier update left its lock to be checked' });
// `deferred` has three causes with different next steps; its note follows the reason.
const DEFERRED = Object.freeze({
  [REASONS.changed]: `The install changed while this update was being prepared, so nothing was switched; ${KEEP}`,
  [REASONS.kept]: `An earlier update could not put its version pointer back and left the lock file activate.lock so it is checked first; ${KEEP} Follow recovery in docs/update.md.`,
});
// A lock that could not be marked (see keepLock) still blocks while its owner lives, but a later update may take it over: say so.
export const UNMARKED = 'The lock could not be marked as unsafe to remove, so a later update may not stop for it. Look at current.json yourself before updating again.';
export const noteOf = result => (result.status === 'deferred' && DEFERRED[result.reason]) || (result.unmarked ? `${NOTES[result.status]} ${UNMARKED}` : NOTES[result.status]);
const OFFLINE = 'Rerun this command with --confirm-offline to switch. Open OMP sessions keep the version they already loaded.';

// Written once by `update install`; runs the pointer's version from its own
// immutable folder. Never rewritten by an update.
export const LAUNCHER = `#!/usr/bin/env node
// Managed omp-session-bridge launcher written by \`update install\`.
// Runs the version named in current.json from its immutable versions folder.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = import.meta.dirname;
let current;
try { current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).current; } catch { /* invalid */ }
if (typeof current !== 'string' || !/${SEMVER.source}/.test(current)) {
  process.stderr.write('managed install pointer invalid\\n');
  process.exit(1);
}
if (process.argv[2] === 'mcp' && process.argv.length === 3) {
  await import(pathToFileURL(path.join(root, 'versions', current, 'bin', 'mcp.mjs')).href);
} else {
  const { main } = await import(pathToFileURL(path.join(root, 'versions', current, 'src', 'cli.mjs')).href);
  process.exitCode = await main(process.argv.slice(2), { managed: root });
}
`;

class Halt { constructor(status, extra) { this.status = status; this.extra = extra; } }
const halt = (status, extra = {}) => { throw new Halt(status, extra); };
const fail = message => { throw new Error(message); };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
// sha256 of every launcher this product has shipped. A change to LAUNCHER adds its new hash here and keeps the old ones, so a runtime
// folder that an earlier build left or moved aside is still recognised as the product's own; any other file is never accepted.
export const LAUNCHER_HASHES = new Set(['0b3412061042d012ea31c5e2088f43960d49e4681b2a2157b4520bc6521f1c0d']);
export const isOurLauncher = bytes => LAUNCHER_HASHES.has(sha(bytes));
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};
async function settle(current, body) {
  try { return { current, ...await body() }; }
  catch (e) { if (e instanceof Halt) return { current, status: e.status, ...e.extra }; throw e; }
}

// Semantic Versioning 2.0.0 precedence (no build metadata is accepted).
export function compareVersions(a, b) {
  const [, ...left] = SEMVER.exec(a), [, ...right] = SEMVER.exec(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return BigInt(left[i]) < BigInt(right[i]) ? -1 : 1;
  if (!left[3] || !right[3]) return left[3] === right[3] ? 0 : left[3] ? -1 : 1;
  const x = left[3].split('.'), y = right[3].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
const validVersion = value => typeof value === 'string' && value.length <= 64 && SEMVER.test(value);

// Bounded GitHub CLI child: no shell, github.com forced whatever GH_HOST says,
// no prompts, TTY forcing or debug output. stdout is capped (the child is
// killed past the cap) and stderr is kept only for status classification; it
// is never relayed. The caller's environment is otherwise passed unchanged so
// gh uses its existing login; the bridge does not read it.
const DROPPED = new Set(['GH_HOST', 'GH_REPO', 'GH_FORCE_TTY', 'GH_DEBUG', 'DEBUG', 'CLICOLOR_FORCE', 'GH_PAGER', 'PAGER']);
export function runGh(args, { timeout, maxBytes, command = 'gh', env = process.env }) {
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) if (!DROPPED.has(key.toUpperCase())) childEnv[key] = value;
  Object.assign(childEnv, { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' });
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }); }
    catch (error) { reject(error); return; }
    const chunks = [];
    let size = 0, stderr = '', overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => {
      if (overflow) return;
      if (size + chunk.length > maxBytes) { overflow = true; child.kill(); return; }
      size += chunk.length; chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', text => { if (stderr.length < 4096) stderr = (stderr + text).slice(0, 4096); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks), stderr, overflow, timedOut }); });
  });
}

async function request(gh, endpoint) {
  let result;
  try { result = await gh(['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', endpoint], METADATA); }
  catch (e) { halt(e?.code === 'ENOENT' ? 'gh-missing' : 'unavailable'); }
  if (result.timedOut) halt('unavailable');
  if (result.overflow) halt('invalid-release');
  if (result.code !== 0) {
    const stderr = String(result.stderr ?? '');
    if (result.code === 4 || /\(HTTP 401\)/.test(stderr)) halt('auth-missing');
    if (/\(HTTP 40[34]\)/.test(stderr)) halt('no-access');
    halt('unavailable');
  }
  try { return JSON.parse(result.stdout.toString('utf8')); } catch { halt('invalid-release'); }
}

// Stable: GitHub's own "latest release" (newest full, non-draft release). Its
// 404 means either no full release or no access; a one-item listing tells
// them apart. Prerelease opt-in: every release, paged to a fixed bound; a
// listing that may continue past the bound is refused, never truncated.
async function published(gh, prerelease) {
  if (!prerelease) {
    try { return [await request(gh, `${ENDPOINT}/latest`)]; }
    catch (e) {
      if (!(e instanceof Halt) || e.status !== 'no-access') throw e;
      if (!Array.isArray(await request(gh, `${ENDPOINT}?per_page=1&page=1`))) halt('invalid-release');
      halt('no-releases');
    }
  }
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = await request(gh, `${ENDPOINT}?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(list) || list.length > PER_PAGE) halt('invalid-release');
    all.push(...list);
    if (list.length < PER_PAGE) return all;
  }
  halt('too-many-releases');
}

// Newest eligible release by exact semver: stable unless prerelease is
// explicitly requested; drafts and non-`v<semver>` tags are not bridge
// releases. Only a candidate newer than `current` is validated in full.
async function select(gh, current, prerelease) {
  const eligible = [];
  for (const entry of await published(gh, prerelease)) {
    if (!entry || typeof entry !== 'object' || entry.draft !== false || typeof entry.tag_name !== 'string' || !entry.tag_name.startsWith('v')) continue;
    const version = entry.tag_name.slice(1);
    if (!validVersion(version) || (!prerelease && (entry.prerelease !== false || version.includes('-')))) continue;
    eligible.push({ version, entry });
  }
  // A stable "latest" that is not a bridge release is malformed metadata.
  if (!eligible.length) halt(prerelease ? 'no-releases' : 'invalid-release');
  eligible.sort((a, b) => compareVersions(b.version, a.version));
  const { version, entry } = eligible[0];
  if (eligible.filter(other => other.version === version).length > 1) halt('invalid-release');
  if (current && compareVersions(version, current) <= 0) return { status: 'up-to-date', latest: version };
  return { status: 'update-available', latest: version, release: describe(version, entry) };
}

// Metadata must name exactly this repository on github.com/api.github.com and
// exactly one uploaded bundle asset with a bounded size and a sha256 digest.
function describe(version, entry) {
  const tag = 'v' + version, name = `omp-session-bridge-${version}.zip`;
  if (entry.html_url !== WEB + 'tag/' + tag || typeof entry.url !== 'string' || !entry.url.startsWith(API) ||
      !/^\d+$/.test(entry.url.slice(API.length)) || !Array.isArray(entry.assets)) halt('invalid-release');
  const matches = entry.assets.filter(asset => asset?.name === name);
  if (matches.length !== 1) halt('invalid-release', { detail: matches.length ? `This release lists ${name} more than once; it must have exactly one.` :
    `This release has no update file named ${name}. Attach that file to the release; the .mcpb cannot be used to update.` });
  const [asset] = matches;
  if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.url !== API + 'assets/' + asset.id ||
      asset.browser_download_url !== WEB + 'download/' + tag + '/' + name || asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET) halt('invalid-release');
  if (asset.digest === undefined || asset.digest === null) halt('missing-digest');
  if (typeof asset.digest !== 'string' || !DIGEST.test(asset.digest)) halt('invalid-release');
  return { version, tag, name, size: asset.size, digest: asset.digest };
}

// `gh release download` is GitHub CLI's supported download path; any redirect
// to GitHub's asset storage is followed by gh itself. The bridge never sees or
// fetches a URL. Bytes are accepted only from gh's stdout, capped at the
// declared size, and must match that size and the published digest.
async function download(gh, release) {
  const args = ['release', 'download', release.tag, '--repo', 'github.com/' + REPOSITORY, '--pattern', release.name, '--output', '-'];
  let result;
  try { result = await gh(args, { timeout: DOWNLOAD_TIMEOUT, maxBytes: release.size }); }
  catch (e) { halt(e?.code === 'ENOENT' ? 'gh-missing' : 'download-failed'); }
  if (result.code !== 0 || result.overflow || result.timedOut || !Buffer.isBuffer(result.stdout) || result.stdout.length !== release.size) halt('download-failed');
  if ('sha256:' + sha(result.stdout) !== release.digest) halt('digest-mismatch');
  return readBundle(result.stdout, release.version);
}

function readBundle(bytes, version) {
  let entries;
  try { entries = unzip(bytes, { maxEntries: 64, maxFile: MIB }); } catch { halt('invalid-bundle'); }
  const files = new Map();
  for (const { name, data } of entries) {
    if (files.has(name)) halt('invalid-bundle');
    files.set(name, data);
  }
  if (!files.has('package.json')) halt('invalid-bundle');
  const declared = declaredFiles(files.get('package.json')), expected = declared === undefined ? RELEASE_FILES : declared;
  if (!shaped(expected) || !expected.includes('package.json') || !sameNames(files.keys(), expected)) halt('invalid-bundle');
  compatible(files.get('package.json'), version);
  return files;
}

// Static checks only; no bundle code runs before activation.
// `gate` is the policy for NEW code (Node and OMP pins); an installed older
// version is only checked for identity so it can still be verified and rolled back to.
function compatible(data, version, gate = true) {
  let pkg;
  try { pkg = JSON.parse(data.toString('utf8')); } catch { halt('invalid-bundle'); }
  if (pkg?.name !== 'omp-session-bridge' || pkg.version !== version || pkg.private !== true || pkg.type !== 'module') halt('invalid-bundle');
  if (!gate) return;
  const node = /^>=(\d+)$/.exec(typeof pkg.engines?.node === 'string' ? pkg.engines.node : '');
  if (!node || Number(node[1]) > NODE_FLOOR) halt('incompatible');
}

async function loadInstall(root, stray = false) {
  try {
    await plain(root, true);
    if ((await fs.readdir(root)).filter(name => name !== BUSY && !(stray && STRAY_TMP.test(name))).sort().join('/') !== ROOT_ENTRIES) fail('entries');
    await plain(path.join(root, VERSIONS), true);
    await plain(path.join(root, STAGING), true);
    await plain(path.join(root, LAUNCHER_FILE));
    if (await fs.readFile(path.join(root, LAUNCHER_FILE), 'utf8') !== LAUNCHER) fail('launcher');
    const pointer = await readJson(path.join(root, POINTER));
    if (!pointer || Object.keys(pointer).sort().join() !== 'current,previous,version' || pointer.version !== 1 || !validVersion(pointer.current) ||
        !(pointer.previous === null || (validVersion(pointer.previous) && pointer.previous !== pointer.current))) fail('pointer');
    return { root, pointer, file: path.join(root, POINTER) };
  } catch { fail(MESSAGES.incomplete); }
}

// A version folder must hold exactly the files its record lists, as plain
// files with the recorded hashes, and a compatible package.json.
async function verifyVersion(root, version) {
  const dir = path.join(root, VERSIONS, version);
  try {
    await plain(dir, true);
    const record = await readJson(path.join(dir, RECORD));
    if (!record || Object.keys(record).sort().join() !== 'digest,files,release,version' || record.version !== 1 || record.release !== version ||
        typeof record.digest !== 'string' || !DIGEST.test(record.digest) || !record.files || typeof record.files !== 'object' ||
        Array.isArray(record.files)) fail('record');
    const names = Object.keys(record.files).sort();
    if (!shaped(names) || names.some(name => !HEX.test(record.files[name]))) fail('record');
    const found = [];
    for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) fail('entry');
      const relative = path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/');
      if (relative !== RECORD) found.push(relative);
    }
    if (found.sort().join('\n') !== names.join('\n')) fail('files');
    for (const name of names) {
      const file = path.join(dir, ...name.split('/'));
      await plain(file);
      const data = await fs.readFile(file);
      if (sha(data) !== record.files[name]) fail('hash');
      if (name === 'package.json') compatible(data, version, false);
    }
    return record;
  } catch { halt('verification-failed'); }
}

async function writeNew(file, data, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const handle = await io.open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

// An existing version folder is reused only if it verifies with the same
// release digest; otherwise it is left untouched.
async function reuse(root, release) {
  let record;
  try { record = await verifyVersion(root, release.version); } catch { halt('conflict'); }
  if (record.digest !== release.digest) halt('conflict');
}

// Files are written into a fresh staging folder, made read-only and published
// with one rename to versions/<version>; a version folder is never modified.
async function stageFiles(root, release, files, io = fs) {
  const target = path.join(root, VERSIONS, release.version);
  const temp = path.join(root, STAGING, crypto.randomUUID());
  await io.mkdir(temp);
  try {
    for (const name of [...files.keys()].sort()) await writeNew(path.join(temp, ...name.split('/')), files.get(name), io);
    await writeNew(path.join(temp, RECORD), recordBytes(release, files), io);
    for (const name of [...files.keys(), RECORD]) await io.chmod(path.join(temp, ...name.split('/')), 0o444);
    await io.rename(temp, target);
  } catch {
    // A partly written file is a prefix of what was being written, which is still provably ours; anything else is left.
    await removeExact(temp, new Map([...files, [RECORD, recordBytes(release, files)]]), new Set([...files.keys()].flatMap(parents)), true);
    if (!await exists(target)) halt('stage-failed');
  }
  await reuse(root, release);
}

// Returns the files it wrote, or undefined when a verified folder for this release was already there.
async function stage(root, release, gh) {
  if (await exists(path.join(root, VERSIONS, release.version))) return reuse(root, release);
  const files = await download(gh, release);
  await stageFiles(root, release, files);
  return files;
}

// Activation boundary: the install lock serializes updates of this install. It is taken over only from a dead owner, never
// when it was kept (marked) because the pointer could not be restored. An open OMP session or a running plan never blocks an update: a running session keeps
// the version folder it loaded (version folders are immutable) and the next start uses the new one.
async function boundary(root, body) {
  const busyFile = path.join(root, BUSY);
  let busy, keep = false;
  try { busy = await acquireLock(busyFile); }
  catch (e) { if (e.code === 'EEXIST') halt('deferred', { reason: await isKeptLock(busyFile) ? REASONS.kept : REASONS.busy }); throw e; }
  // The pointer is already swapped when the lock goes. A lock file Windows will not release (a scanner or another command has
  // it open) is retried; if it stays, the update still worked and the result says a harmless lock file remains.
  const release = async () => { await busy.close(); return keep || await unlinkRetry(busyFile); };
  let result;
  try { result = await body(async () => { keep = true; return keepLock(busy); }); }
  catch (e) { await release(); throw e; }
  return await release() ? result : { ...result, lockLeft: true };
}

// Atomic pointer replacement (temp file, fsync, rename). Any failure restores
// the original bytes; if that fails too, the truth is reported and locks kept.
async function swap(file, intended, io, keep) {
  const original = await fs.readFile(file);
  try {
    await writeJson(file, intended, false, io);
    if (!(await fs.readFile(file)).equals(Buffer.from(JSON.stringify(intended) + '\n'))) fail('pointer not written');
  } catch {
    try {
      if (!(await fs.readFile(file)).equals(original)) {
        await writeJson(file, JSON.parse(original.toString('utf8')), false, io);
        if (!(await fs.readFile(file)).equals(original)) fail('pointer not restored');
      }
    } catch { const marked = await keep(); halt('activation-failed-unrestored', marked ? {} : { unmarked: true }); }
    halt('activation-failed');
  }
}

async function activate(install, next, { io, prepare }) {
  return boundary(install.root, async keep => {
    const fresh = await loadInstall(install.root, true);
    if (JSON.stringify(fresh.pointer) !== JSON.stringify(install.pointer)) halt('deferred', { reason: REASONS.changed });
    if (prepare) await prepare();
    await verifyVersion(install.root, next);
    await swap(install.file, { version: 1, current: next, previous: install.pointer.current }, io, keep);
    return { current: next, previous: install.pointer.current };
  });
}

async function managedTarget(managed, stateFolder, now) {
  if (!managed) fail(MESSAGES.source);
  const install = await loadInstall(path.resolve(managed), true);
  // `pots upgrade` has no project in mind: without a state folder only the install itself is checked.
  if (stateFolder !== undefined) {
    const setup = await loadSetup(path.resolve(stateFolder), now);
    for (const other of [setup.settings.root, setup.settings.cwd])
      if (inside(install.root, other) || inside(other, install.root)) fail(MESSAGES.outside);
  }
  return { install };
}

async function insideStateFolder(target) {
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'config.json')) && await exists(path.join(dir, 'launch.json')) && await exists(path.join(dir, 'receipts'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

export async function checkUpdate({ gh, managed, prerelease }) {
  const current = managed ? (await loadInstall(path.resolve(managed), true)).pointer.current
    : (await readJson(path.join(CHECKOUT, 'package.json'))).version;
  return settle(current, async () => {
    const { status, latest } = await select(gh, current, prerelease);
    return { status, latest };
  });
}

// New install folder only (never adopted); nothing is created unless the
// release downloads and verifies. The source checkout is never written.
export async function installUpdate(target, { gh, prerelease }) {
  const root = path.resolve(target);
  if (inside(root, CHECKOUT) || await insideStateFolder(root)) fail(MESSAGES.outside);
  if (await exists(root)) fail(MESSAGES.exists);
  await plain(path.dirname(root), true);
  return settle(null, async () => {
    const { release } = await select(gh, null, prerelease);
    const files = await download(gh, release);
    await fs.mkdir(root);
    try {
      await fs.mkdir(path.join(root, VERSIONS));
      await fs.mkdir(path.join(root, STAGING));
      await writeNew(path.join(root, LAUNCHER_FILE), Buffer.from(LAUNCHER));
      await stageFiles(root, release, files);
      await writeJson(path.join(root, POINTER), { version: 1, current: release.version, previous: null }, true);
    } catch (e) {
      // A refused cleanup leaves the folder behind, and the next try would stop at "already exists": say what to do instead.
      if (!await removeCreated(root, { version: release.version, digest: release.digest, files })) throw new Error(MESSAGES.leftover);
      throw e;
    }
    return { status: 'installed', current: release.version, launcher: path.join(root, LAUNCHER_FILE) };
  });
}

// Seed or upgrade a MANAGED install from the setup package already on disk. The
// digest describes a deterministic local bundle, not a GitHub download or
// independent publisher signature. Nothing the user's assistants or launchers
// point at is switched by `prepare`: it only adds a new, verified version folder
// next to the old ones (or builds a brand-new install). `commit` then moves the
// single pointer file, backed up first, and `rollback` puts it back. A running
// lane keeps the files it loaded because no existing version folder is ever
// written. The runtime file list of the old and the new version may differ.
export const UPGRADE_ERRORS = Object.freeze({
  sameVersion: 'This setup has the same version number as the installed copy but different files, so nothing was changed. Use a setup package with a newer version number.',
  damaged: 'The installed copy failed its file check, so nothing was changed. Keep it for inspection; Setup does not replace an installed copy it cannot verify.',
  startCheck: 'The new copy did not pass its start check, so nothing was switched and the previous version keeps working.',
  stage: 'The new copy could not be written or did not match its file list, so nothing was switched and the previous version keeps working.',
  busy: 'Another update is running or was interrupted, so nothing was changed. Try again when it has finished. If none is running, delete only the file activate.lock next to current.json (in runtime/current inside the install folder) and try again.',
  changed: 'The install changed while Setup was working, so nothing was switched. Run pots install again.',
  switched: 'Switching to the new copy failed and the previous version was put back. Nothing else was changed.',
  unrestored: 'Switching to the new copy failed and the previous version pointer could not be put back. The install lock was kept so no other update can start until it is checked (the launcher still starts the version current.json names); follow recovery in docs/update.md.',
  unrestoredUnmarked: 'Switching to the new copy failed and the previous version pointer could not be put back. The install lock was kept, but it could not be marked as unsafe to remove, so a later update may not stop for it. Look at current.json yourself before updating again (the launcher still starts the version current.json names); follow recovery in docs/update.md.',
  kept: 'An earlier update could not put the version pointer back and left its lock, so nothing was changed. Next: in the folder runtime/current inside the install folder, check that current.json names a folder that exists inside versions (fix the name if it does not), then delete only the file activate.lock there and run the same command again. The steps are in docs/update.md under Rollback and recovery.',
});

async function localRelease() {
  const files = new Map();
  for (const name of RELEASE_FILES) {
    const file = path.join(CHECKOUT, ...name.split('/')); await plain(file);
    files.set(name, await fs.readFile(file));
  }
  const version = JSON.parse(files.get('package.json')).version;
  if (!validVersion(version)) fail(UPGRADE_ERRORS.stage);
  const declared = declaredFiles(files.get('package.json'));
  if (declared !== undefined && !sameNames(declared, RELEASE_FILES)) fail(UPGRADE_ERRORS.stage);
  await asError(async () => compatible(files.get('package.json'), version));
  return { version, files, digest: 'sha256:' + sha(zip([...files].map(([name, data]) => ({ name, data })))) };
}

// Clean-up after a failed attempt removes only what this attempt wrote, proven byte for byte immediately before each
// delete: a file or folder somebody else added or edited meanwhile is never deleted, and whatever cannot be proven ours
// is simply left where it is (the next run reports it).
const recordBytes = (release, files) => {
  const record = { version: 1, release: release.version, digest: release.digest, files: {} };
  for (const name of [...files.keys()].sort()) record.files[name] = sha(files.get(name));
  return Buffer.from(JSON.stringify(record) + '\n');
};
const parents = name => { const rows = []; for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) rows.push(parent); return rows; };
async function removeExact(base, files, dirs, partial = false) {
  try {
    for (const entry of await fs.readdir(base, { recursive: true, withFileTypes: true })) {
      const rel = path.relative(base, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory() ? !dirs.has(rel) : !entry.isFile() || !files.has(rel)) return false;
    }
    const matches = (now, data) => now.equals(data) || (partial && now.length < data.length && data.subarray(0, now.length).equals(now));
    // Preflight: every file must still be exactly ours before any is deleted, so a refusal leaves the folder whole.
    for (const [rel, data] of files) {
      const now = await fs.readFile(path.join(base, ...rel.split('/'))).catch(() => null);
      if (now !== null && !matches(now, data)) return false;
    }
    for (const [rel, data] of files) {
      const file = path.join(base, ...rel.split('/')), now = await fs.readFile(file).catch(() => null);
      if (now === null) continue;
      if (!matches(now, data)) return false;
      await fs.rm(file, { force: true });
    }
    for (const rel of [...dirs].sort((a, b) => b.length - a.length)) await fs.rmdir(path.join(base, ...rel.split('/'))).catch(() => {});
    await fs.rmdir(base);
    return true;
  } catch { return false; }
}
async function removeVerifiedVersion(root, local) {
  const files = new Map([...local.files, [RECORD, recordBytes(local, local.files)]]), dirs = new Set([...local.files.keys()].flatMap(parents));
  return removeExact(path.join(root, VERSIONS, local.version), files, dirs);
}
async function removeCreated(root, local) {
  const prefix = `versions/${local.version}/`, files = new Map([['bridge.mjs', Buffer.from(LAUNCHER)],
    ['current.json', Buffer.from(JSON.stringify({ version: 1, current: local.version, previous: null }) + '\n')],
    [prefix + RECORD, recordBytes(local, local.files)], ...[...local.files].map(([name, data]) => [prefix + name, data])]);
  const dirs = new Set(['versions', 'staging', `versions/${local.version}`, ...[...local.files.keys()].flatMap(parents).map(parent => prefix + parent)]);
  return removeExact(root, files, dirs, true); // a file cut off mid-write is a prefix of ours, still provably ours
}
const sameContent = (record, local) => sameNames(Object.keys(record.files), local.files.keys()) &&
  [...local.files].every(([name, data]) => record.files[name] === sha(data));

// The check runs the new copy's own entry points in child processes: the CLI
// must print its usage (so every module it imports loads on this Node) and the
// MCP server must answer an initialize request. Nothing is queued, bound or written.
export function startCheck(dir, { node = process.execPath, timeout = 60000 } = {}) {
  const child = (args, input) => new Promise(resolve => {
    const env = { ...process.env };
    for (const name of ['OMP_BRIDGE_CONFIG', 'OMP_BRIDGE_STATE', 'OMP_BRIDGE_CONTROLLER', 'NODE_OPTIONS']) delete env[name];
    const proc = spawn(node, args, { cwd: dir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false, timer;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); proc.kill(); resolve(ok ? { code: proc.exitCode, out, err } : null); };
    timer = setTimeout(() => finish(false), timeout);
    proc.stdout.on('data', chunk => { out += chunk; if (out.length > 65536) finish(false); else if (input && out.includes('\n')) finish(true); });
    proc.stderr.on('data', chunk => { err += chunk; if (err.length > 65536) finish(false); });
    proc.on('error', () => finish(false));
    proc.on('close', () => finish(true));
    proc.stdin.on('error', () => {});
    proc.stdin.end(input ?? '');
  });
  return (async () => {
    const cli = await child([path.join(dir, 'bin', 'bridge.mjs')]);
    if (!cli || cli.code !== 1 || !cli.err.includes('Pi on the Side!')) fail(UPGRADE_ERRORS.startCheck);
    const hello = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installer-start-check', version: '1' } } }) + '\n';
    const mcp = await child([path.join(dir, 'bin', 'mcp.mjs')], hello);
    let reply; try { reply = JSON.parse(mcp?.out.split('\n')[0] ?? ''); } catch { /* not JSON */ }
    if (reply?.result?.serverInfo?.name !== 'omp-session-bridge') fail(UPGRADE_ERRORS.startCheck);
  })();
}

const asError = async body => {
  try { return await body(); }
  catch (e) { if (e instanceof Halt) fail(e.status === 'deferred' ? UPGRADE_ERRORS.busy : UPGRADE_ERRORS.stage); throw e; }
};

// `backup.file(name, bytes)` stores a copy of what this call is about to
// change (only the pointer file here) and must not return before it is on disk.
export async function prepareManagedRuntime(target, { probe = startCheck, backup, io = fs } = {}) {
  const root = path.resolve(target);
  if (inside(root, CHECKOUT) || await insideStateFolder(root)) fail(MESSAGES.outside);
  const local = await localRelease();
  const launcher = path.join(root, LAUNCHER_FILE), dir = version => path.join(root, VERSIONS, version);
  const noop = (kind, install) => ({ kind, created: false, upgraded: false, from: install.pointer.current, to: install.pointer.current,
    target: dir(install.pointer.current), launcher, previous: install.pointer.previous, commit: async () => {}, rollback: async () => ({ left: [] }) });
  if (!await exists(root)) {
    await plain(path.dirname(root), true);
    await fs.mkdir(root);
    try {
      await asError(async () => {
        await fs.mkdir(path.join(root, VERSIONS)); await fs.mkdir(path.join(root, STAGING));
        await writeNew(launcher, Buffer.from(LAUNCHER));
        await stageFiles(root, { version: local.version, digest: local.digest }, local.files, io);
      });
      await probe(dir(local.version));
      await writeJson(path.join(root, POINTER), { version: 1, current: local.version, previous: null }, true);
    } catch (e) {
      await removeCreated(root, local);
      throw e;
    }
    return { kind: 'fresh', created: true, upgraded: false, from: null, to: local.version, target: dir(local.version), launcher, previous: null,
      commit: async () => {}, rollback: async () => ({ left: [] }) };
  }
  // An install this code does not recognise is reported as such (MESSAGES.incomplete), never reused or replaced here.
  const install = await loadInstall(root);
  const current = install.pointer.current;
  let record = null;
  try { record = await verifyVersion(root, current); } catch (e) { if (!(e instanceof Halt)) throw e; }
  const order = compareVersions(local.version, current);
  if (order <= 0) {
    if (!record) fail(UPGRADE_ERRORS.damaged);
    if (order === 0 && !sameContent(record, local)) fail(UPGRADE_ERRORS.sameVersion);
    return noop(order === 0 ? 'unchanged' : 'newer-kept', install);
  }
  const staged = !await exists(dir(local.version));
  await asError(async () => {
    if (staged) await stageFiles(root, { version: local.version, digest: local.digest }, local.files, io);
    else {
      let found; try { found = await verifyVersion(root, local.version); } catch (e) { if (e instanceof Halt) fail(UPGRADE_ERRORS.damaged); throw e; }
      if (!sameContent(found, local)) fail(UPGRADE_ERRORS.sameVersion);
    }
  });
  try { await probe(dir(local.version)); }
  catch (e) { if (staged) await removeVerifiedVersion(root, local); throw e; }
  const intended = { version: 1, current: local.version, previous: current };
  const lockFile = path.join(root, BUSY);
  let wrote = null;
  const locked = async body => {
    let busy; try { busy = await acquireLock(lockFile); } catch (e) { if (e.code === 'EEXIST') fail(await isKeptLock(lockFile) ? UPGRADE_ERRORS.kept : UPGRADE_ERRORS.busy); throw e; }
    let keep = false;
    try { return await body(async () => { keep = true; return keepLock(busy); }); }
    finally { await busy.close(); if (!keep) await unlinkRetry(lockFile); }
  };
  return { kind: 'upgrade', created: false, upgraded: true, from: current, to: local.version, target: dir(local.version), launcher, previous: current,
    async commit() {
      await locked(async keep => {
        const fresh = await loadInstall(root);
        if (JSON.stringify(fresh.pointer) !== JSON.stringify(install.pointer)) fail(UPGRADE_ERRORS.changed);
        await asError(() => verifyVersion(root, local.version));
        const original = await fs.readFile(install.file);
        await backup?.file(`${path.basename(root)}-current.json`, original);
        try { await swap(install.file, intended, io, keep); }
        catch (e) {
          if (!(e instanceof Halt)) throw e;
          fail(e.status !== 'activation-failed-unrestored' ? UPGRADE_ERRORS.switched : e.extra.unmarked ? UPGRADE_ERRORS.unrestoredUnmarked : UPGRADE_ERRORS.unrestored);
        }
        wrote = Buffer.from(JSON.stringify(intended) + '\n');
      });
    },
    // Undo of a commit that succeeded when a LATER step failed. Only a pointer this call wrote is put back.
    async rollback() {
      if (!wrote) return { left: [] };
      return locked(async () => {
        const now = await fs.readFile(install.file).catch(() => null);
        if (!now || !now.equals(wrote)) return { left: ['The version pointer changed after Setup switched it, so it was left as it is.'] };
        await writeJson(install.file, install.pointer, false, io);
        wrote = null;
        const restored = await fs.readFile(install.file);
        return restored.equals(Buffer.from(JSON.stringify(install.pointer) + '\n')) ? { left: [] } : { left: ['The previous version pointer could not be verified after putting it back.'] };
      });
    } };
}

// Without confirmation: check and stage only. With confirmation: take the
// install lock and the session lock first (deferring on any lock or unsettled
// bridge work), then download, stage, verify and activate while holding them.
// `probe` (optional) starts the staged version once before the pointer moves; a version that does not start is never switched to.
export async function applyUpdate(stateFolder, { gh, managed, prerelease, confirm, io, now, probe }) {
  const { install } = await managedTarget(managed, stateFolder, now);
  return settle(install.pointer.current, async () => {
    const { status, latest, release } = await select(gh, install.pointer.current, prerelease);
    if (!release) return { status, latest };
    const prepare = async () => {
      const written = await stage(install.root, release, gh);
      if (!probe) return;
      // A copy that does not start is removed (only if every file is still exactly what this run wrote), so the same
      // version can be published again with fixed files without a leftover folder blocking it.
      try { await probe(path.join(install.root, VERSIONS, release.version)); }
      catch { if (written) await removeVerifiedVersion(install.root, { ...release, files: written }); halt('stage-failed'); }
    };
    if (!confirm) { await prepare(); return { status: 'staged', latest, offlineOwnership: OFFLINE }; }
    return { status: 'activated', latest, ...await activate(install, release.version, { io, prepare }) };
  });
}

export async function rollbackUpdate(stateFolder, { managed, confirm, io, now }) {
  const { install } = await managedTarget(managed, stateFolder, now);
  return settle(install.pointer.current, async () => {
    const { previous } = install.pointer;
    if (!previous) halt('no-previous');
    await verifyVersion(install.root, previous);
    if (!confirm) return { status: 'rollback-ready', previous, offlineOwnership: OFFLINE };
    return { status: 'rolled-back', ...await activate(install, previous, { io }) };
  });
}
