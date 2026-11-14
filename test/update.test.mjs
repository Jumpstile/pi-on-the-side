import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { main } from '../src/cli.mjs';
import zlib from 'node:zlib';
import { createCredential, acquireController } from '../src/controller.mjs';
import { acquireLock, Store, readJson } from '../src/control.mjs';
import { runGh } from '../src/update.mjs';
import { autoSetup } from '../src/autosetup.mjs';
import { unzip, zip } from '../src/zip.mjs';
const FIXTURE_HOST = 'omp/1.2.3';

// Offline update fixtures only: a synthetic GitHub CLI transport serves local
// release metadata and bundles. No network, real release, gh login or OMP.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const PACK = path.join(CHECKOUT, 'scripts', 'pack-mcpb.mjs');
const REPO = 'Jumpstile/pi-on-the-side';
const NOW = 1800000000000;
const sessionId = '00000000-0000-4000-8000-000000000041';
const API = endpoint => ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', `repos/${REPO}/${endpoint}`];
const LATEST = API('releases/latest');
const PAGE = (page, per = 100) => API(`releases?per_page=${per}&page=${page}`);
const assetName = version => `omp-session-bridge-${version}.zip`;
const DOWNLOAD = version => ['release', 'download', 'v' + version, '--repo', 'github.com/' + REPO, '--pattern', assetName(version), '--output', '-'];
const SOURCE = 'running from a source checkout; apply and rollback need the managed launcher (nothing changed)';
const OUTSIDE = 'install folder must be outside the bridge checkout and state folder';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.lstat(file).then(() => true, () => false);
const ok = stdout => ({ code: 0, stdout, stderr: '', overflow: false, timedOut: false });
const PACKAGE_VERSION = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8')).version;

// The base bundle comes from the real release packer, so the updater is proven
// to accept exactly what the packer produces.
let base;
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge release ')));
after(() => fs.rm(scratch, { recursive: true, force: true }));
async function baseEntries() {
  base ??= (async () => {
    const out = path.join(scratch, assetName(PACKAGE_VERSION));
    const result = await new Promise(resolve => execFile(process.execPath, [PACK, '--release', out], { windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    assert.equal(result.code, 0, result.stderr);
    return unzip(await fs.readFile(out));
  })();
  return base;
}

// Bundle for `version`; `edit` may change the file map or return a raw entry list.
async function bundle(version, edit = files => files) {
  const files = new Map((await baseEntries()).map(({ name, data }) => [name, data]));
  const pkg = JSON.parse(files.get('package.json').toString('utf8'));
  files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, version }, null, 2) + '\n'));
  const edited = edit(files) ?? files;
  const entries = Array.isArray(edited) ? edited : [...edited].sort(([a], [b]) => a < b ? -1 : 1).map(([name, data]) => ({ name, data }));
  return zip(entries);
}

let nextId = 100;
function release(version, bytes, { prerelease = version.includes('-'), draft = false, asset = {}, ...rest } = {}) {
  const tag = 'v' + version, id = nextId++, assetId = nextId++;
  return { url: `https://api.github.com/repos/${REPO}/releases/${id}`, html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    id, tag_name: tag, name: tag, draft, prerelease, ...rest,
    assets: [{ url: `https://api.github.com/repos/${REPO}/releases/assets/${assetId}`, id: assetId, name: assetName(version),
      state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha(bytes), content_type: 'application/zip',
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${assetName(version)}`, ...asset }] };
}

// Synthetic transport modelling GitHub: `latest` is the first (newest-created)
// full non-draft release, listings are pages in creation order. It accepts only
// the fixed argument vectors the updater may use and records every call.
const notFound = () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'gh: Not Found (HTTP 404)', overflow: false, timedOut: false });
function fakeGh(list, assets = {}, { metadata, download } = {}) {
  const calls = [];
  const gh = async (args, limits) => {
    calls.push(args);
    assert.ok(Number.isSafeInteger(limits.timeout) && limits.timeout > 0 && Number.isSafeInteger(limits.maxBytes));
    if (args[0] === 'api') {
      assert.equal(args.length, 6);
      assert.deepEqual(args.slice(0, 5), LATEST.slice(0, 5));
      assert.ok(limits.maxBytes <= 4 * 1024 * 1024);
      if (metadata) return metadata(args);
      if (args[5] === LATEST[5]) {
        const latest = list.find(entry => entry.draft === false && entry.prerelease === false);
        return latest ? ok(Buffer.from(JSON.stringify(latest))) : notFound();
      }
      const [, per, page] = /^repos\/Jumpstile\/pi-on-the-side\/releases\?per_page=(\d+)&page=(\d+)$/.exec(args[5]) ?? assert.fail(args[5]);
      return ok(Buffer.from(JSON.stringify(list.slice((page - 1) * per, page * per))));
    }
    const version = args[2].slice(1);
    assert.deepEqual(args, DOWNLOAD(version));
    assert.ok(limits.maxBytes <= 4 * 1024 * 1024);
    return download ? download(version, limits) : ok(assets[version]);
  };
  return { gh, calls, downloads: () => calls.filter(args => args[0] === 'release').length };
}
const offline = async () => { throw new Error('unexpected gh call'); };

async function snapshot(dir) {
  const rows = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (path.relative(dir, file).split(path.sep)[0] === '.git') continue;
    rows.push([path.relative(dir, file), entry.isFile() ? sha(await fs.readFile(file)) : 'dir']);
  }
  return rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

async function world(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge update ')));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const cwd = path.join(dir, 'project dir'); await fs.mkdir(cwd);
  const session = path.join(dir, 'saved session.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  const state = path.join(dir, 'private state');
  const root = path.join(dir, 'managed install');
  const launches = [];
  const deps = { locate: async () => path.join(dir, 'omp.exe'), detect: async () => FIXTURE_HOST,
    launch: async spec => { launches.push(spec); return 0; }, now: () => NOW, gh: offline };
  const call = async (args, more = {}) => {
    const out = [], err = [];
    const code = await main(args, { ...deps, stdout: text => out.push(text), stderr: text => err.push(text), ...more });
    let json; try { json = JSON.parse(out.join('\n')); } catch { /* not JSON */ }
    return { code, out: out.join('\n'), err: err.join('\n'), json };
  };
  assert.equal((await call(['setup', session, state])).code, 0);
  const controllerFile = path.join(dir, 'controller.json'); await createCredential(controllerFile);
  await acquireController(new Store(await readJson(path.join(state, 'config.json'))), controllerFile);
  deps.controllerFile = controllerFile;
  const pointer = async () => JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
  return { dir, cwd, session, state, root, launches, call, pointer, lockFile: path.join(state, `supervisor-${sessionId}.lock`) };
}

test('a failed update install removes the folder it made, so the same command works again', async t => {
  const w = await world(t), b = await bundle('0.1.0'), gh = fakeGh([release('0.1.0', b)], { '0.1.0': b }).gh, rename = fs.rename;
  const blocked = mock.method(fs, 'rename', async (from, to) => { if (String(from).includes('staging')) throw new Error('blocked'); return rename(from, to); });
  const failed = await w.call(['update', 'install', w.root], { gh });
  blocked.mock.restore();
  assert.notEqual(failed.code, 0);
  assert.equal(await exists(w.root), false, 'nothing is left behind after the failure');
  const again = await w.call(['update', 'install', w.root], { gh });
  assert.equal(again.code, 0, again.out + again.err);
});

// A managed install at 0.1.0 created through `update install`.
async function installed(t) {
  const w = await world(t);
  const b010 = await bundle('0.1.0');
  const result = await w.call(['update', 'install', w.root], { gh: fakeGh([release('0.1.0', b010)], { '0.1.0': b010 }).gh });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.json.status, 'installed');
  const b020 = await bundle('0.2.0');
  const feed = (extra = {}) => fakeGh([release('0.2.0', b020), release('0.1.0', b010)], { '0.1.0': b010, '0.2.0': b020 }, extra);
  return { ...w, b010, b020, feed, managed: { managed: w.root } };
}

const plan = id => ({ version: 1, id, sessionId, expiresAt: NOW + 3600000, steps: [{ prompt: 'Synthetic fixture prompt.', continueAfterEnd: false }] });

test('normal automatic setup uses the managed updater and preserves state across a controlled version transition', async t => {
  const w = await world(t);
  const deps = { platform: 'win32', env: {}, home: w.dir, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
    locate: async () => path.join(w.dir, 'omp.exe'), detect: async () => FIXTURE_HOST,
    startCheck: async () => {},
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  const options = { root: path.join(w.dir, 'automatic'), session: w.session, name: 'example' };
  const first = await autoSetup(options, deps), managed = path.dirname(first.cliLauncher);
  assert.equal(first.updateChannel, 'published stable and prerelease'); assert.deepEqual(first.mcpArguments, ['mcp']);
  const before = await snapshot(first.sessions[0].stateFolder), key = await fs.readFile(first.credentialFile);
  const bytes = await bundle('99.0.0'), transport = fakeGh([release('99.0.0', bytes, { prerelease: true })], { '99.0.0': bytes });
  const update = await w.call(['start', first.sessions[0].stateFolder, '--confirm-offline'], { managed, gh: transport.gh, controllerFile: first.credentialFile });
  assert.equal(update.code, 0, update.err); assert.equal(update.json.started, false);
  assert.equal(update.json.update.status, 'activated'); assert.equal(update.json.update.current, '99.0.0');
  assert.equal(w.launches.length, 0, 'activation exits without loading the old code into OMP');
  assert.deepEqual(await snapshot(first.sessions[0].stateFolder), before); assert.deepEqual(await fs.readFile(first.credentialFile), key);
  const repeat = await autoSetup(options, deps);
  assert.equal(repeat.cliLauncher, first.cliLauncher); assert.equal(repeat.mcpLauncher, first.mcpLauncher);
  assert.equal(path.basename(repeat.runtimeFolder), '99.0.0'); assert.equal(repeat.credentialCreated, false);
  assert.deepEqual(await snapshot(first.sessions[0].stateFolder), before);
  const pointer = await readJson(path.join(managed, 'current.json'));
  assert.deepEqual(pointer, { version: 1, current: '99.0.0', previous: PACKAGE_VERSION });
});
const receipt = (id, state) => ({ version: 1, id, sessionId, state, reason: 'restart', nextStep: 0, updatedAt: NOW, outcomes: [],
  taskSuccess: 'unverified', automaticReplay: false });
async function addPlan(w, state) {
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(w.state, 'plans', id + '.json'), JSON.stringify(plan(id)) + '\n');
  if (state) await fs.writeFile(path.join(w.state, 'receipts', id + '.json'), JSON.stringify(receipt(id, state)) + '\n');
  return id;
}

test('stable check follows GitHub latest through the fixed gh vector, read-only', async t => {
  const w = await world(t);
  const b = await bundle('99.0.0');
  const feed = fakeGh([release('99.0.0', b), release('98.5.0', b), release('99.1.0-beta.1', b), release('99.2.0', b, { draft: true }),
    release('100.0.0', b, { tag_name: 'nightly' })]);
  const before = await snapshot(w.dir);
  const result = await w.call(['update', 'check'], { gh: feed.gh });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.json.status, 'update-available');
  assert.equal(result.json.current, PACKAGE_VERSION, 'source checkout reports its package version');
  assert.equal(result.json.latest, '99.0.0', 'prerelease, draft and non-semver tags are ignored by default');
  assert.equal(result.json.channel, 'stable');
  assert.equal(result.json.managed, false);
  assert.deepEqual(feed.calls, [LATEST], 'check reads metadata only; nothing is downloaded');
  assert.deepEqual(await snapshot(w.dir), before);
});

test('prerelease is explicit opt-in and ordered by semver precedence', async t => {
  const w = await world(t);
  const b = await bundle('99.0.0');
  const list = [release('99.0.0', b), release('99.1.0-beta.2', b), release('99.1.0-beta.10', b), release('99.1.0-alpha.99', b),
    release('99.0.1', b, { prerelease: true })];
  assert.equal((await w.call(['update', 'check'], { gh: fakeGh(list).gh })).json.latest, '99.0.0');
  const opted = await w.call(['update', 'check', '--prerelease'], { gh: fakeGh(list).gh });
  assert.equal(opted.json.latest, '99.1.0-beta.10');
  assert.equal(opted.json.channel, 'prerelease');
  for (const args of [['update', 'check', '--pre'], ['update', 'check', '--prerelease', '--prerelease'], ['update', 'check', 'x'],
    ['update', 'frobnicate'], ['update', 'check', '--repo', 'other/repo'], ['update', 'check', '--url', 'https://example.invalid']])
    assert.notEqual((await w.call(args, { gh: fakeGh(list).gh })).code, 0, args.join(' '));
});

test('stable finds latest behind many prereleases; prerelease pages to a bound and never truncates', async t => {
  const w = await world(t);
  const b = await bundle('99.0.0');
  // Newest-created first: 150 prereleases, then the only full release.
  const crowded = [...Array.from({ length: 150 }, (_, i) => release(`98.0.0-rc.${i}`, b)), release('99.0.0', b)];
  const stable = fakeGh(crowded);
  assert.equal((await w.call(['update', 'check'], { gh: stable.gh })).json.latest, '99.0.0');
  assert.deepEqual(stable.calls, [LATEST]);
  // The highest semver was created early and sits on page 2.
  const backports = [...Array.from({ length: 120 }, (_, i) => release(`98.${i}.0`, b)), release('99.1.0-beta.1', b)];
  const paged = fakeGh(backports);
  const opted = await w.call(['update', 'check', '--prerelease'], { gh: paged.gh });
  assert.equal(opted.json.latest, '99.1.0-beta.1');
  assert.deepEqual(paged.calls, [PAGE(1), PAGE(2)]);
  // Five full pages: the listing may continue past the bound, so refuse.
  const flood = Array.from({ length: 500 }, (_, i) => release(`97.0.${i}`, b));
  const capped = fakeGh(flood);
  const refused = await w.call(['update', 'check', '--prerelease'], { gh: capped.gh });
  assert.equal(refused.code, 1);
  assert.equal(refused.json.status, 'too-many-releases');
  assert.deepEqual(capped.calls, [1, 2, 3, 4, 5].map(page => PAGE(page)));
  // A stable "latest" that is not a v<semver> bridge release is refused.
  assert.equal((await w.call(['update', 'check'], { gh: fakeGh([release('99.0.0', b, { tag_name: 'nightly' })]).gh })).json.status, 'invalid-release');
  // GitHub's latest is never a prerelease; a suffixed version flagged full is refused, not offered on stable.
  const mislabeled = await w.call(['update', 'check'], { gh: fakeGh([release('99.1.0-rc.1', b, { prerelease: false })]).gh });
  assert.equal(mislabeled.json.status, 'invalid-release');
});

test('no newer release, no releases at all and only-prerelease feeds keep the current version', async t => {
  const w = await installed(t);
  const before = await snapshot(w.root);
  const same = await w.call(['update', 'check'], { gh: fakeGh([release('0.1.0', w.b010)]).gh, ...w.managed });
  assert.equal(same.code, 0);
  assert.equal(same.json.status, 'up-to-date');
  assert.equal(same.json.current, '0.1.0', 'managed mode reports the active pointer');
  assert.equal(same.json.managed, true);
  const older = await w.call(['update', 'check'], { gh: fakeGh([release('0.0.9', w.b010)]).gh, ...w.managed });
  assert.equal(older.json.status, 'up-to-date', 'never offers a downgrade');
  const none = await w.call(['update', 'check'], { gh: fakeGh([]).gh, ...w.managed });
  assert.equal(none.code, 0);
  assert.equal(none.json.status, 'no-releases');
  const pre = await w.call(['update', 'check'], { gh: fakeGh([release('0.2.0-rc.1', w.b020)]).gh, ...w.managed });
  assert.equal(pre.json.status, 'no-releases');
  const applied = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: fakeGh([]).gh, ...w.managed });
  assert.equal(applied.json.status, 'no-releases');
  assert.deepEqual(await snapshot(w.root), before);
});

test('missing gh, missing login, no access, offline and timeouts give fixed statuses and keep current', async t => {
  const w = await installed(t);
  const before = await snapshot(w.root);
  const cases = [
    [async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, 'gh-missing'],
    [async () => ({ code: 4, stdout: Buffer.alloc(0), stderr: 'To get started with GitHub CLI, please run:  gh auth login SECRETSENTINEL' }), 'auth-missing'],
    [async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'gh: Bad credentials (HTTP 401) SECRETSENTINEL' }), 'auth-missing'],
    [async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'gh: Not Found (HTTP 404) SECRETSENTINEL' }), 'no-access'],
    [async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'gh: Forbidden (HTTP 403)' }), 'no-access'],
    [async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'error connecting to api.github.com SECRETSENTINEL' }), 'unavailable'],
    [async () => ({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true }), 'unavailable'],
    [async () => ({ code: null, stdout: Buffer.alloc(0), stderr: '', overflow: true }), 'invalid-release'],
    [async () => ok(Buffer.from('<html>SECRETSENTINEL')), 'invalid-release'],
    [async () => ok(Buffer.from('{"message":"x"}')), 'invalid-release'],
  ];
  for (const [metadata, status] of cases) {
    for (const args of [['update', 'check'], ['update', 'apply', w.state, '--confirm-offline']]) {
      const result = await w.call(args, { gh: fakeGh([], {}, { metadata }).gh, ...w.managed });
      assert.equal(result.code, 1, status);
      assert.equal(result.json.status, status, args.join(' '));
      assert.equal(result.json.current, '0.1.0');
      assert.match(result.json.note, /keeping the current version/);
      assert.ok(!(result.out + result.err).includes('SECRETSENTINEL'), 'gh output is never relayed');
    }
  }
  assert.deepEqual(await snapshot(w.root), before);
  assert.equal(await exists(w.lockFile), false);
});

test('metadata naming another repository or host, duplicate assets or tags, or a bad digest is refused', async t => {
  const w = await world(t);
  const b = await bundle('99.0.0');
  const name = assetName('99.0.0');
  const valid = () => release('99.0.0', b);
  const cases = [
    ['asset API in another repository', r => { r.assets[0].url = r.assets[0].url.replace(REPO, 'Jumpstile/other'); }, 'invalid-release'],
    ['asset API on another host', r => { r.assets[0].url = r.assets[0].url.replace('api.github.com', 'api.github.com.evil.example'); }, 'invalid-release'],
    ['download URL on another host', r => { r.assets[0].browser_download_url = `https://evil.example/${REPO}/releases/download/v99.0.0/${name}`; }, 'invalid-release'],
    ['download URL for another tag', r => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('v99.0.0', 'v98.0.0'); }, 'invalid-release'],
    ['release page in another repository', r => { r.html_url = 'https://github.com/someone/omp-session-bridge/releases/tag/v99.0.0'; }, 'invalid-release'],
    ['release API on another host', r => { r.url = 'https://ghe.example/api/v3/repos/' + REPO + '/releases/1'; }, 'invalid-release'],
    ['duplicate asset name', r => { r.assets.push({ ...r.assets[0], id: r.assets[0].id + 1, url: r.assets[0].url.replace(/\d+$/, String(r.assets[0].id + 1)) }); }, 'invalid-release'],
    ['no bundle asset', r => { r.assets[0].name = 'other.zip'; }, 'invalid-release'],
    ['asset not uploaded', r => { r.assets[0].state = 'starter'; }, 'invalid-release'],
    ['oversized asset', r => { r.assets[0].size = 4 * 1024 * 1024 + 1; }, 'invalid-release'],
    ['missing digest', r => { delete r.assets[0].digest; }, 'missing-digest'],
    ['null digest', r => { r.assets[0].digest = null; }, 'missing-digest'],
    ['non-sha256 digest', r => { r.assets[0].digest = 'md5:' + 'a'.repeat(32); }, 'invalid-release'],
    ['uppercase digest', r => { r.assets[0].digest = 'sha256:' + sha(b).toUpperCase(); }, 'invalid-release'],
  ];
  for (const [label, mutate, status] of cases) {
    const r = valid(); mutate(r);
    const result = await w.call(['update', 'check'], { gh: fakeGh([r]).gh });
    assert.equal(result.code, 1, label);
    assert.equal(result.json.status, status, label);
  }
  const twin = valid();
  const duplicate = await w.call(['update', 'check', '--prerelease'], { gh: fakeGh([valid(), twin]).gh });
  assert.equal(duplicate.json.status, 'invalid-release', 'duplicate tag');
  const oversized = fakeGh([], {}, { metadata: () => ok(Buffer.from(JSON.stringify(Array.from({ length: 101 }, () => valid())))) });
  assert.equal((await w.call(['update', 'check', '--prerelease'], { gh: oversized.gh })).json.status, 'invalid-release', 'page above per_page');
});

test('a release with only the .mcpb is refused with the real reason; adding the update bundle makes it installable', async t => {
  const w = await world(t), b = await bundle('99.0.0'), name = assetName('99.0.0');
  const [update] = release('99.0.0', b).assets, other = (extra, id) => ({ ...update, ...extra, id, url: update.url.replace(/\d+$/, String(id)) });
  const withoutBundle = release('99.0.0', b);
  withoutBundle.assets = [other({ name: 'omp-session-bridge-99.0.0.mcpb' }, 9002)];
  const refused = await w.call(['update', 'check'], { gh: fakeGh([withoutBundle]).gh });
  assert.equal(refused.json.status, 'invalid-release');
  assert.ok(refused.json.detail.includes(`no update file named ${name}`), refused.json.detail);
  const complete = release('99.0.0', b); complete.assets.push(...withoutBundle.assets);
  const accepted = await w.call(['update', 'check'], { gh: fakeGh([complete]).gh });
  assert.equal(accepted.json.status, 'update-available');
  assert.equal(accepted.json.detail, undefined);
});

test('failed, oversized or tampered downloads stage nothing and keep current', async t => {
  const w = await installed(t);
  const before = await snapshot(w.root);
  const cases = [
    [async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'release not found' }), 'download-failed'],
    [async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, 'gh-missing'],
    [async () => ({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true }), 'download-failed'],
    [async () => ({ code: null, stdout: w.b020.subarray(0, 10), stderr: '', overflow: true }), 'download-failed'],
    [async () => ok(w.b020.subarray(0, w.b020.length - 1)), 'download-failed'],
    [async () => ok(Buffer.concat([w.b020, Buffer.from('x')])), 'download-failed'],
    [async () => { const tampered = Buffer.from(w.b020); tampered[tampered.length - 40] ^= 1; return ok(tampered); }, 'digest-mismatch'],
  ];
  for (const [download, status] of cases) {
    for (const confirm of [[], ['--confirm-offline']]) {
      const result = await w.call(['update', 'apply', w.state, ...confirm], { gh: w.feed({ download }).gh, ...w.managed });
      assert.equal(result.code, 1);
      assert.equal(result.json.status, status);
    }
  }
  assert.deepEqual(await snapshot(w.root), before);
  assert.deepEqual(await fs.readdir(path.join(w.root, 'staging')), []);
});

test('bundles with traversal, absolute, duplicate, extra, private, linked or missing files are refused', async t => {
  const w = await installed(t);
  const before = await snapshot(w.root);
  const entries = files => [...files].map(([name, data]) => ({ name, data }));
  const linked = async () => {
    const bytes = await bundle('0.2.0');
    const directory = bytes.readUInt32LE(bytes.length - 6);
    // Mark the first central-directory entry as a symbolic link (S_IFLNK).
    bytes.writeUInt32LE(0xa1ff0000, directory + 38);
    return bytes;
  };
  const cases = [
    ['parent traversal', () => bundle('0.2.0', files => [...entries(files), { name: '../evil.mjs', data: Buffer.from('x') }])],
    ['nested traversal', () => bundle('0.2.0', files => [...entries(files), { name: 'src/../../evil.mjs', data: Buffer.from('x') }])],
    ['absolute path', () => bundle('0.2.0', files => [...entries(files), { name: '/src/evil.mjs', data: Buffer.from('x') }])],
    ['drive path', () => bundle('0.2.0', files => [...entries(files), { name: 'C:/evil.mjs', data: Buffer.from('x') }])],
    ['backslash path', () => bundle('0.2.0', files => [...entries(files), { name: 'src\\evil.mjs', data: Buffer.from('x') }])],
    ['duplicate entry', () => bundle('0.2.0', files => [...entries(files), { name: 'src/cli.mjs', data: Buffer.from('x') }])],
    ['case-folded duplicate', () => bundle('0.2.0', files => [...entries(files), { name: 'SRC/cli.mjs', data: Buffer.from('x') }])],
    ['extra test file', () => bundle('0.2.0', files => { files.set('test/update.test.mjs', Buffer.from('x')); })],
    ['extra source module', () => bundle('0.2.0', files => { files.set('src/evil.mjs', Buffer.from('x')); })],
    ['extra bin script', () => bundle('0.2.0', files => { files.set('bin/extra.mjs', Buffer.from('x')); })],
    ['README not in the runtime set', () => bundle('0.2.0', files => { files.set('README.md', Buffer.from('x')); })],
    ['missing runtime module', () => bundle('0.2.0', files => { files.delete('src/zip.mjs'); })],
    ['private note', () => bundle('0.2.0', files => { files.set('docs/owner.private.md', Buffer.from('x')); })],
    ['dotfile', () => bundle('0.2.0', files => { files.set('.env', Buffer.from('x')); })],
    ['directory entry', () => bundle('0.2.0', files => [{ name: 'src/', data: Buffer.alloc(0) }, ...entries(files)])],
    ['missing launcher entry', () => bundle('0.2.0', files => { files.delete('bin/bridge.mjs'); })],
    ['missing extension', () => bundle('0.2.0', files => { files.delete('extension/bridge.ts'); })],
    ['symlink entry', linked],
    ['trailing data', async () => Buffer.concat([await bundle('0.2.0'), Buffer.from('junk')])],
    ['package version differs from tag', () => bundle('0.2.0', files => {
      files.set('package.json', Buffer.from(JSON.stringify({ ...JSON.parse(files.get('package.json')), version: '0.3.0' })));
    })],
    ['foreign package name', () => bundle('0.2.0', files => {
      files.set('package.json', Buffer.from(JSON.stringify({ ...JSON.parse(files.get('package.json')), name: 'other' })));
    })],
  ];
  for (const [label, make] of cases) {
    const bytes = await make();
    const feed = fakeGh([release('0.2.0', bytes), release('0.1.0', w.b010)], { '0.2.0': bytes });
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: feed.gh, ...w.managed });
    assert.equal(result.code, 1, label);
    assert.equal(result.json.status, 'invalid-bundle', label);
  }
  assert.deepEqual(await snapshot(w.root), before);
  assert.deepEqual(await fs.readdir(path.join(w.root, 'staging')), []);
});

test('a release that needs another Node.js version is refused before staging', async t => {
  const w = await installed(t);
  const before = await snapshot(w.root);
  const engines = engines => bundle('0.2.0', files => {
    const pkg = JSON.parse(files.get('package.json'));
    files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, engines })));
  });
  for (const value of [{ node: '>=24' }, { node: '^22' }, {}]) {
    const bytes = await engines(value);
    const feed = fakeGh([release('0.2.0', bytes), release('0.1.0', w.b010)], { '0.2.0': bytes });
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: feed.gh, ...w.managed });
    assert.equal(result.json.status, 'incompatible', JSON.stringify(value));
  }
  assert.deepEqual(await snapshot(w.root), before);
});

test('confirmed apply is never blocked by a lock, queued or in-flight work; only another running update defers it', async t => {
  const cases = [
    ['lock', async w => { await fs.writeFile(w.lockFile, '{}'); }],
    ['queued', async w => { await addPlan(w); }],
    ['in flight', async w => { await addPlan(w, 'submitted'); }],
    ['reserved', async w => { await addPlan(w, 'reserved'); }],
    ['unreadable', async w => { const id = await addPlan(w); await fs.writeFile(path.join(w.state, 'receipts', id + '.json'), '{'); }],
  ];
  for (const [label, prepare] of cases) {
    const w = await installed(t);
    await prepare(w);
    const state = await snapshot(w.state), old = await snapshot(path.join(w.root, 'versions', '0.1.0'));
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
    assert.equal(result.code, 0, label + ': ' + result.out + result.err);
    assert.deepEqual([result.json.status, result.json.current, result.json.previous], ['activated', '0.2.0', '0.1.0'], label);
    assert.deepEqual(await snapshot(w.state), state, label + ': the open session\'s lock, plans and receipts are untouched');
    assert.deepEqual(await snapshot(path.join(w.root, 'versions', '0.1.0')), old, label + ': the version the session loaded is unchanged');
  }
  // Another update that is running right now still defers, and changes nothing.
  const w = await installed(t);
  await fs.writeFile(path.join(w.root, 'activate.lock'), '');
  const install = await snapshot(w.root), feed = w.feed();
  const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: feed.gh, ...w.managed });
  assert.equal(result.code, 1);
  assert.deepEqual([result.json.status, result.json.reason], ['deferred', 'another update or rollback is running']);
  assert.deepEqual(await snapshot(w.root), install);
});

test('the source checkout is never a managed install and is never written', async t => {
  const w = await world(t);
  const b = await bundle('99.0.0');
  const before = await snapshot(CHECKOUT);
  for (const args of [['update', 'apply', w.state, '--confirm-offline'], ['update', 'apply', w.state], ['update', 'rollback', w.state, '--confirm-offline']]) {
    const result = await w.call(args, { gh: fakeGh([release('99.0.0', b)], { '99.0.0': b }).gh });
    assert.equal(result.code, 1);
    assert.equal(result.err.trim(), SOURCE);
  }
  const inside = path.join(CHECKOUT, 'install-' + crypto.randomUUID());
  for (const target of [inside, path.join(w.state, 'install')]) {
    const result = await w.call(['update', 'install', target], { gh: fakeGh([release('99.0.0', b)], { '99.0.0': b }).gh });
    assert.equal(result.code, 1);
    assert.equal(result.err.trim(), OUTSIDE);
    assert.equal(await exists(target), false);
  }
  assert.deepEqual(await snapshot(CHECKOUT), before, 'checkout bytes unchanged');
});

test('install creates an immutable verified version, a launcher and a pointer; the launcher runs it', async t => {
  const w = await installed(t);
  assert.deepEqual((await fs.readdir(w.root)).sort(), ['bridge.mjs', 'current.json', 'staging', 'versions']);
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: null });
  const dir = path.join(w.root, 'versions', '0.1.0');
  const record = JSON.parse(await fs.readFile(path.join(dir, 'release.json'), 'utf8'));
  assert.equal(record.digest, 'sha256:' + sha(w.b010));
  for (const { name, data } of unzip(w.b010)) {
    assert.equal(sha(await fs.readFile(path.join(dir, ...name.split('/')))), sha(data), name);
    assert.equal(record.files[name], sha(data), name);
    await assert.rejects(fs.access(path.join(dir, ...name.split('/')), fs.constants.W_OK), `${name} is read-only`);
  }
  // An existing folder is never adopted or overwritten.
  const again = await w.call(['update', 'install', w.root], { gh: fakeGh([release('0.1.0', w.b010)], { '0.1.0': w.b010 }).gh });
  assert.equal(again.code, 1);
  assert.equal(again.err.trim(), 'install folder already exists');

  // The real launcher (child process, no network) runs the pointer's version.
  const run = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(w.root, 'bridge.mjs'), ...args], { windowsHide: true },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const status = await run('status', w.state);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), []);
  await fs.writeFile(path.join(w.root, 'current.json'), JSON.stringify({ version: 1, current: '../../evil', previous: null }));
  const refused = await run('status', w.state);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.stderr.trim(), 'managed install pointer invalid');
});

test('confirmed apply takes only the install lock, swaps the pointer atomically and leaves state byte-identical', async t => {
  const w = await installed(t);
  await addPlan(w, 'completed');
  const state = await snapshot(w.state);
  const old = await snapshot(path.join(w.root, 'versions', '0.1.0'));
  const launcher = await fs.readFile(path.join(w.root, 'bridge.mjs'));

  // Preview stages and verifies only; no lock, no activation.
  const preview = await w.call(['update', 'apply', w.state], { gh: w.feed().gh, ...w.managed });
  assert.equal(preview.code, 0, preview.out + preview.err);
  assert.equal(preview.json.status, 'staged');
  assert.match(preview.json.offlineOwnership, /--confirm-offline/);
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: null });

  let observed = null;
  const io = { ...fs, rename: async (from, to) => {
    if (to === path.join(w.root, 'current.json')) {
      observed = { sessionLock: await exists(w.lockFile), installLock: await exists(path.join(w.root, 'activate.lock')) };
    }
    return fs.rename(from, to);
  } };
  const feed = w.feed();
  const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: feed.gh, io, ...w.managed });
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual([result.json.status, result.json.current, result.json.previous], ['activated', '0.2.0', '0.1.0']);
  assert.equal(feed.downloads(), 0, 'the verified staged version is reused');
  assert.deepEqual(observed, { sessionLock: false, installLock: true }, 'only the install lock is held while the pointer moves');
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.2.0', previous: '0.1.0' });
  assert.equal(await exists(w.lockFile), false, 'lock released');
  assert.deepEqual(await snapshot(w.state), state, 'config, launch, plans, receipts and control unchanged');
  assert.deepEqual(await snapshot(path.join(w.root, 'versions', '0.1.0')), old, 'previous version retained unchanged');
  assert.deepEqual(await fs.readFile(path.join(w.root, 'bridge.mjs')), launcher);
  assert.deepEqual((await fs.readdir(w.root)).sort(), ['bridge.mjs', 'current.json', 'staging', 'versions']);
  assert.equal((await w.call(['update', 'check'], { gh: w.feed().gh, ...w.managed })).json.status, 'up-to-date');
});

test('activation failure restores the original pointer; an unrestorable pointer keeps the install lock and says so', async t => {
  const pointerOf = w => path.join(w.root, 'current.json');
  {
    const w = await installed(t);
    const original = await fs.readFile(pointerOf(w));
    const state = await snapshot(w.state);
    const io = { ...fs, rename: async (from, to) => { if (to === pointerOf(w)) throw Object.assign(new Error('injected'), { code: 'EIO' }); return fs.rename(from, to); } };
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, io, ...w.managed });
    assert.equal(result.json.status, 'activation-failed');
    assert.deepEqual(await fs.readFile(pointerOf(w)), original);
    assert.equal(await exists(w.lockFile), false);
    assert.deepEqual(await snapshot(w.state), state);
    assert.ok(await exists(path.join(w.root, 'versions', '0.1.0', 'src', 'cli.mjs')));
  }
  {
    // The new pointer lands corrupted; restoring the original succeeds.
    const w = await installed(t);
    const original = await fs.readFile(pointerOf(w));
    let renames = 0;
    const io = { ...fs, rename: async (from, to) => {
      await fs.rename(from, to);
      if (to === pointerOf(w) && renames++ === 0) await fs.writeFile(to, '{"broken"');
    } };
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, io, ...w.managed });
    assert.equal(result.json.status, 'activation-failed');
    assert.deepEqual(await fs.readFile(pointerOf(w)), original);
    assert.equal(await exists(w.lockFile), false);
    assert.equal(await exists(path.join(w.root, 'activate.lock')), false);
  }
  {
    // Corrupted and the restore also fails: report the truth and keep both locks.
    const w = await installed(t), original = await fs.readFile(pointerOf(w));
    let renames = 0;
    const io = { ...fs, rename: async (from, to) => {
      if (to === pointerOf(w) && renames++ > 0) throw Object.assign(new Error('injected'), { code: 'EIO' });
      await fs.rename(from, to);
      if (to === pointerOf(w)) await fs.writeFile(to, '{"broken"');
    } };
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, io, ...w.managed });
    assert.equal(result.code, 1);
    assert.equal(result.json.status, 'activation-failed-unrestored');
    assert.match(result.json.note, /lock/);
    assert.ok(await exists(path.join(w.root, 'activate.lock')));
    // A lock from a dead owner is normally taken over; this one is marked and never is, so an unverified pointer cannot be replaced.
    await assert.rejects(acquireLock(path.join(w.root, 'activate.lock'), { alive: () => false }), { code: 'EEXIST' });
    await fs.writeFile(pointerOf(w), original);
    const again = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
    assert.equal(again.json.status, 'deferred');
    assert.match(again.json.note, /earlier update could not put its version pointer back.*activate\.lock/);
    assert.deepEqual(await fs.readFile(pointerOf(w)), original);
  }
});

test('an existing staged version is reused only if it verifies; a conflicting one is never overwritten', async t => {
  const w = await installed(t);
  const target = path.join(w.root, 'versions', '0.2.0');
  await fs.mkdir(path.join(target, 'src'), { recursive: true });
  await fs.writeFile(path.join(target, 'src', 'cli.mjs'), 'conflicting');
  const before = await snapshot(w.root);
  const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
  assert.equal(result.code, 1);
  assert.equal(result.json.status, 'conflict');
  assert.deepEqual(await snapshot(w.root), before);
});

test('rollback needs the explicit switch, verifies the retained version and swaps back; tampering is refused', async t => {
  const w = await installed(t);
  const fresh = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.equal(fresh.json.status, 'no-previous');
  assert.equal((await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed })).json.status, 'activated');
  const state = await snapshot(w.state);

  const preview = await w.call(['update', 'rollback', w.state], w.managed);
  assert.equal(preview.json.status, 'rollback-ready');
  assert.equal(preview.json.previous, '0.1.0');
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.2.0', previous: '0.1.0' });

  await fs.writeFile(path.join(w.root, 'activate.lock'), '');
  const deferred = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.deepEqual([deferred.json.status, deferred.json.reason], ['deferred', 'another update or rollback is running']);
  await fs.rm(path.join(w.root, 'activate.lock'));

  const file = path.join(w.root, 'versions', '0.1.0', 'src', 'cli.mjs');
  const original = await fs.readFile(file);
  await fs.chmod(file, 0o644); await fs.appendFile(file, '\n// tampered\n');
  const tampered = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.equal(tampered.json.status, 'verification-failed');
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.2.0', previous: '0.1.0' });
  await fs.writeFile(file, original);

  const extra = path.join(w.root, 'versions', '0.1.0', 'src', 'extra.mjs');
  await fs.writeFile(extra, 'x');
  assert.equal((await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed)).json.status, 'verification-failed');
  await fs.rm(extra);

  const done = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.equal(done.code, 0, done.out + done.err);
  assert.deepEqual([done.json.status, done.json.current, done.json.previous], ['rolled-back', '0.1.0', '0.2.0']);
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: '0.2.0' });
  assert.deepEqual(await snapshot(w.state), state);
  assert.equal(await exists(w.lockFile), false);
});

test('managed start checks and stages on preview, activates on confirmed start without launching, then launches', async t => {
  const w = await installed(t);
  const preview = await w.call(['start', w.state], { gh: w.feed().gh, ...w.managed });
  assert.equal(preview.code, 0, preview.err);
  assert.equal(preview.json.started, false);
  assert.equal(preview.json.update.status, 'staged');
  assert.equal(preview.json.update.latest, '0.2.0');
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: null });

  const state = await snapshot(w.state);
  const confirmed = await w.call(['start', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
  assert.equal(confirmed.code, 0, confirmed.err);
  assert.equal(confirmed.json.started, false);
  assert.equal(confirmed.json.update.status, 'activated');
  assert.match(confirmed.json.next, /rerun/i);
  assert.equal(w.launches.length, 0, 'the old process never launches OMP after activating new code');
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.2.0', previous: '0.1.0' });
  assert.deepEqual(await snapshot(w.state), state);

  const rerun = await w.call(['start', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
  assert.equal(rerun.code, 0, rerun.err);
  assert.equal(w.launches.length, 1);
});

test('managed start keeps and launches the current version when the check fails or apply defers', async t => {
  const w = await installed(t);
  const down = fakeGh([], {}, { metadata: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'error connecting to api.github.com' }) });
  const result = await w.call(['start', w.state, '--confirm-offline'], { gh: down.gh, ...w.managed });
  assert.equal(result.code, 0, result.err);
  assert.equal(w.launches.length, 1);
  assert.match(result.err, /unavailable/);
  const preview = await w.call(['start', w.state], { gh: down.gh, ...w.managed });
  assert.equal(preview.json.update.status, 'unavailable');

  await fs.writeFile(path.join(w.root, 'activate.lock'), '');
  const deferred = await w.call(['start', w.state, '--confirm-offline'], { gh: w.feed().gh, ...w.managed });
  assert.equal(deferred.code, 0, deferred.err);
  assert.match(deferred.err, /deferred/);
  assert.equal(w.launches.length, 2);
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: null });
  // Source-checkout start never contacts GitHub.
  assert.equal((await w.call(['start', w.state], { gh: offline })).code, 0);
});

test('the gh runner forces github.com, never uses a shell and bounds output and time', async t => {
  const env = { ...process.env, GH_HOST: 'ghe.example', gh_repo: 'other/repo', GH_FORCE_TTY: '1', GH_DEBUG: 'api' };
  const echo = await runGh(['-e', 'process.stdout.write(JSON.stringify([process.env.GH_HOST, process.env.GH_FORCE_TTY ?? null, ' +
    'process.env.GH_DEBUG ?? null, process.env.GH_PROMPT_DISABLED, process.argv[1]]))', '& echo injected'],
  { command: process.execPath, env, timeout: 60000, maxBytes: 4096 });
  assert.equal(echo.code, 0, echo.stderr);
  const [host, tty, debug, prompt, literal] = JSON.parse(echo.stdout.toString('utf8'));
  assert.deepEqual([host, tty, debug, prompt, literal], ['github.com', null, null, '1', '& echo injected']);
  if (process.platform === 'win32') assert.ok(!echo.stdout.toString('utf8').includes('ghe.example'));

  const flood = await runGh(['-e', 'process.stdout.write(Buffer.alloc(1 << 20)); setTimeout(() => {}, 30000)'],
    { command: process.execPath, env, timeout: 20000, maxBytes: 1000 });
  assert.equal(flood.overflow, true);
  assert.ok(flood.stdout.length <= 1000);
  const slow = await runGh(['-e', 'setTimeout(() => {}, 30000)'], { command: process.execPath, env, timeout: 300, maxBytes: 1000 });
  assert.equal(slow.timedOut, true);
  await assert.rejects(runGh([], { command: path.join(os.tmpdir(), 'no-such-gh-' + crypto.randomUUID()), env, timeout: 1000, maxBytes: 10 }),
    e => e.code === 'ENOENT');
});

test('manual canonical migration defers while another update runs, preserves identity and never launches', async t => {
  const w = await installed(t);
  await fs.writeFile(path.join(w.root, 'activate.lock'), '');
  const beforeLocked = await snapshot(w.state);
  const blocked = await w.call(['update','migrate',w.root,w.state,'--confirm-offline'], {gh:w.feed().gh});
  assert.equal(blocked.json.status,'deferred');
  assert.deepEqual(await snapshot(w.state),beforeLocked);
  assert.equal((await w.pointer()).current,'0.1.0');
  await fs.unlink(path.join(w.root, 'activate.lock'));
  const before = await snapshot(w.state);
  const result = await w.call(['update','migrate',w.root,w.state,'--confirm-offline'], {gh:w.feed().gh});
  assert.equal(result.json.status,'activated');
  assert.equal((await w.pointer()).current,'0.2.0');
  assert.equal((await w.pointer()).previous,'0.1.0');
  assert.deepEqual(await snapshot(w.state),before);
  assert.equal(w.launches.length,0);
});


test('normal managed Start selects newer published prereleases and stable versions deterministically, excluding drafts and downgrades', async t => {
  for (const winner of ['0.3.0-beta.2', '0.3.0']) {
    const w = await installed(t), target = await bundle(winner);
    const list = [release('9.0.0', target, { draft: true }), release('0.0.9', w.b010, { prerelease: true }),
      release('0.3.0-beta.1', target), release('0.2.0', w.b020), release(winner, target, { prerelease: winner.includes('-') })];
    const feed = fakeGh(list.reverse(), { [winner]: target });
    const before = await snapshot(w.state);
    const preview = await w.call(['start', w.state], { gh: feed.gh, ...w.managed });
    assert.equal(preview.code, 0, preview.err); assert.equal(preview.json.update.latest, winner);
    assert.equal(preview.json.update.status, 'staged'); assert.equal(w.launches.length, 0);
    assert.deepEqual(await w.pointer(), { version: 1, current: '0.1.0', previous: null });
    assert.deepEqual(await snapshot(w.state), before); assert.deepEqual(feed.calls[0], PAGE(1));
    const confirmed = await w.call(['start', w.state, '--confirm-offline'], { gh: feed.gh, ...w.managed });
    assert.equal(confirmed.json.update.status, 'activated'); assert.equal(w.launches.length, 0);
    assert.equal((await w.pointer()).current, winner); assert.deepEqual(await snapshot(w.state), before);
  }
  const w = await installed(t), feed = fakeGh([release('9.0.0', w.b010, { draft: true }), release('0.0.9', w.b010, { prerelease: true })]);
  const before = await snapshot(w.root);
  const preview = await w.call(['start', w.state], { gh: feed.gh, ...w.managed });
  assert.equal(preview.json.update.status, 'up-to-date'); assert.equal(feed.downloads(), 0);
  assert.deepEqual(await snapshot(w.root), before); assert.equal(w.launches.length, 0);
});

// The runtime file list may change between releases: a bundle carries the list it declares, and the old list in
// an installed version folder never blocks switching to it or back.
test('a bundle that declares a changed runtime list is applied and rolled back; undeclared, unshaped or incomplete lists are refused', async t => {
  const w = await installed(t);
  const declare = (names, extra = {}) => bundle('0.2.0', files => {
    for (const [name, text] of Object.entries(extra)) files.set(name, Buffer.from(text));
    const pkg = JSON.parse(files.get('package.json'));
    files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, runtimeFiles: names ?? [...files.keys()].sort() })));
  });
  const refused = async (label, bytes) => {
    const before = await snapshot(w.root);
    const result = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: fakeGh([release('0.2.0', bytes)], { '0.2.0': bytes }).gh, ...w.managed });
    assert.equal(result.json.status, 'invalid-bundle', label);
    assert.deepEqual(await snapshot(w.root), before, label);
  };
  const names = (await baseEntries()).map(entry => entry.name);
  await refused('declared list names a file that is not in the bundle', await declare([...names, 'src/ghost.mjs']));
  await refused('a file in the bundle that the declared list does not name', await bundle('0.2.0', files => { files.set('src/undeclared.mjs', Buffer.from('x')); const pkg = JSON.parse(files.get('package.json')); files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, runtimeFiles: names }))); }));
  await refused('declared file outside the runtime shape (docs)', await declare(null, { 'docs/notes.md': 'x' }));
  await refused('declared file outside the runtime shape (test)', await declare(null, { 'test/x.mjs': 'x' }));
  await refused('declared file with a traversal path', await declare(null, { 'src/../evil.mjs': 'x' }));
  await refused('declared list without the launcher entry', await bundle('0.2.0', files => { files.delete('bin/bridge.mjs'); const pkg = JSON.parse(files.get('package.json')); files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, runtimeFiles: [...files.keys()].sort() }))); }));
  await refused('declared list that is not a list', await bundle('0.2.0', files => { const pkg = JSON.parse(files.get('package.json')); files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, runtimeFiles: 'src/cli.mjs' }))); }));
  await refused('declared list that is null', await bundle('0.2.0', files => { const pkg = JSON.parse(files.get('package.json')); files.set('package.json', Buffer.from(JSON.stringify({ ...pkg, runtimeFiles: null }))); }));
  // A real change of the list: one more module. Apply, then roll back to the old list.
  const changed = await declare(null, { 'src/future-feature.mjs': 'export const future = true;\n' });
  const feed = fakeGh([release('0.2.0', changed), release('0.1.0', w.b010)], { '0.1.0': w.b010, '0.2.0': changed });
  const applied = await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: feed.gh, ...w.managed });
  assert.equal(applied.code, 0, applied.out + applied.err); assert.equal(applied.json.status, 'activated');
  assert.equal(await exists(path.join(w.root, 'versions', '0.2.0', 'src', 'future-feature.mjs')), true);
  assert.deepEqual(await w.pointer(), { version: 1, current: '0.2.0', previous: '0.1.0' });
  const back = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.equal(back.json.status, 'rolled-back', back.out + back.err);
  const forward = await w.call(['update', 'rollback', w.state, '--confirm-offline'], w.managed);
  assert.equal(forward.json.status, 'rolled-back', 'the changed-list version still verifies after being left');
  assert.equal((await w.pointer()).current, '0.2.0');
});

test('release bundles are written and read without zlib.crc32, which Node 22.0 and 22.1 do not have', () => {
  const real = zlib.crc32; zlib.crc32 = undefined;
  try {
    const bytes = zip([{ name: 'a.txt', data: Buffer.from('123456789') }]);
    assert.equal(bytes.readUInt32LE(14), 0xcbf43926, 'the standard CRC-32 check value');
    assert.deepEqual(unzip(bytes).map(row => [row.name, row.data.toString()]), [['a.txt', '123456789']]);
  } finally { zlib.crc32 = real; }
});

test('an install lock kept after a failed pointer restore is marked even after a passing write failure, and a lasting one is said plainly', async t => {
  const attempt = async failures => {
    const w = await installed(t), pointer = path.join(w.root, 'current.json'), open = fs.open;
    let renames = 0, left = failures;
    const io = { ...fs, rename: async (from, to) => {
      if (to === pointer && renames++ > 0) throw Object.assign(new Error('injected'), { code: 'EIO' });
      await fs.rename(from, to);
      if (to === pointer) await fs.writeFile(to, '{"broken"');
    } };
    fs.open = async (file, ...rest) => {
      const handle = await open.call(fs, file, ...rest);
      if (path.basename(String(file)) === 'activate.lock') { const truncate = handle.truncate.bind(handle); handle.truncate = async (...args) => { if (left-- > 0) throw Object.assign(new Error('io'), { code: 'EIO' }); return truncate(...args); }; }
      return handle;
    };
    try { return { w, result: await w.call(['update', 'apply', w.state, '--confirm-offline'], { gh: w.feed().gh, io, ...w.managed }) }; } finally { fs.open = open; }
  };
  const passing = await attempt(1);
  assert.equal(passing.result.json.status, 'activation-failed-unrestored');
  assert.doesNotMatch(passing.result.json.note, /could not be marked/);
  await assert.rejects(acquireLock(path.join(passing.w.root, 'activate.lock'), { alive: () => false }), { code: 'EEXIST' }, 'the lock is marked, so a dead owner does not free it');
  const lasting = await attempt(99);
  assert.equal(lasting.result.json.status, 'activation-failed-unrestored');
  assert.match(lasting.result.json.note, /could not be marked as unsafe to remove.*Look at current\.json yourself/);
  assert.ok(await exists(path.join(lasting.w.root, 'activate.lock')), 'the lock file itself is still kept');
});
