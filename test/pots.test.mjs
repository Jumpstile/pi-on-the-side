import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { autoSetup } from '../src/autosetup.mjs';
import { main } from '../src/cli.mjs';
import { installationId, registerInstallation, uninstallDefaults, HelperFailure, REVIEW, reviewText } from '../src/uninstall.mjs';
import { REPOSITORY, RELEASE_FILES } from '../src/update.mjs';
import { zip } from '../src/zip.mjs';

// The pots command and the one-line installer. Fake release folders and fake gh only: no network, no GitHub, no real registry.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const API = `https://api.github.com/repos/${REPOSITORY}/releases/`, WEB = `https://github.com/${REPOSITORY}/releases/`;

async function world(t, count = 2) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-pots-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const agent = path.join(base, 'agent'), sessions = path.join(agent, 'sessions'), apps = path.join(base, 'Microsoft', 'WindowsApps');
  await fs.mkdir(sessions, { recursive: true }); await fs.mkdir(apps, { recursive: true });
  for (let i = 0; i < count; i++) {
    const cwd = path.join(base, 'project-' + i); await fs.mkdir(cwd);
    await fs.writeFile(path.join(sessions, `s${i}.jsonl`), JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
  }
  const out = [], err = [], rows = new Map();
  const registry = { read: async id => rows.get(id) ?? null, write: async (id, entry) => rows.set(id, { root: entry.InstallLocation, command: entry.UninstallString }),
    remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root) };
  const permissions = { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} };
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: base, PATH: apps }, home: base, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
    locate: async () => process.execPath, detect: async () => 'omp/18.8.6', startCheck: async () => {}, which: async () => null, openSessions: async () => 0,
    permissions, tasks: undefined, selfTest: undefined, reinstall: async () => ({ ok: true, text: '' }), registerUninstall: (root, options) => registerInstallation(root, { ...options, registry }),
    uninstallDeps: { ...uninstallDefaults, platform: 'win32', registry, processes: async () => [], permissions, integration: { read: async () => null, remove: async () => {} }, audit: async () => [] },
    stdout: text => out.push(text), stderr: text => err.push(text) };
  const w = { base, apps, deps, out, err, rows };
  w.install = async (flags = []) => { out.length = err.length = 0; return main(['install', ...flags], deps); };
  w.pots = async (args, over = {}) => { out.length = err.length = 0; const code = await main(args, { ...deps, managed: w.managed, ...over }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  assert.equal(await w.install(), 0, err.join('\n'));
  w.managed = path.join(base, 'OMP Session Bridge Local', 'runtime', 'current');
  return w;
}

// A fake release: a version and its bundle (the runtime files with that version). `publish` is the gh that lists the releases it is
// given, in that order, and serves each one's own bundle.
const publish = (...all) => async args => args[0] === 'api' ? { code: 0, stdout: Buffer.from(JSON.stringify(all.map(item => item.meta))), stderr: '' }
  : { code: 0, stdout: all.find(item => item.meta.tag_name === args[2]).served, stderr: '' };
async function release(version, { corrupt = false, prerelease = false, notice = '' } = {}) {
  const files = [];
  for (const name of RELEASE_FILES) {
    let data = await fs.readFile(path.join(CHECKOUT, name));
    if (name === 'package.json') data = Buffer.from(JSON.stringify({ ...JSON.parse(data), version }, null, 2) + '\n');
    if (name === 'NOTICE.md') data = Buffer.concat([data, Buffer.from(notice)]);
    files.push({ name, data });
  }
  const bytes = zip(files), name = `omp-session-bridge-${version}.zip`, tag = 'v' + version;
  const meta = { draft: false, prerelease, tag_name: tag, html_url: WEB + 'tag/' + tag, url: API + '1', assets: [{ name, id: 7, url: API + 'assets/7', browser_download_url: WEB + 'download/' + tag + '/' + name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha(bytes) }] };
  const served = corrupt ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes.at(-1) ^ 1])]) : bytes;
  const item = { meta, served, bytes };
  item.gh = publish(item);
  return item;
}
const tree = async dir => (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath ?? e.path, e.name))).sort();

test('install from a fake release folder: one sentence, the fixed path, the pots command, every session connected', async t => {
  const w = await world(t);
  assert.match(w.out.join('\n'), /^Installed Pi on the Side \d+\.\d+\.\d+\./);
  assert.equal(w.out.length, 1, 'one plain sentence, not a log');
  const shim = path.join(w.apps, 'pots.cmd');
  assert.ok((await fs.readFile(shim, 'utf8')).includes(path.join(w.managed, 'bridge.mjs')), 'the command runs the fixed launcher');
  // The command really runs (cmd.exe, no PATH search needed): it prints the version from the installed copy.
  const version = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8')).version;
  const run = await new Promise(resolve => execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', shim, '--version'], { windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(run.code, 0, run.stderr); assert.equal(run.stdout.trim(), `Pi on the Side ${version}`);
  // A different pots.cmd that this install did not write is never replaced.
  await fs.writeFile(shim, '@echo someone else\r\n');
  assert.equal(await w.install(), 0); assert.equal(await fs.readFile(shim, 'utf8'), '@echo someone else\r\n');
});

test('pots status: one sentence with version, folder, sessions and assistants; details say more', async t => {
  const w = await world(t);
  const short = await w.pots(['status']);
  assert.equal(short.code, 0);
  assert.match(short.out, /^Pi on the Side \d+\.\d+\.\d+ is installed in .+OMP Session Bridge Local\. 2 of 2 saved OMP sessions are connected\. Assistants set up: none\. Nothing else to do\.$/);
  const more = await w.pots(['status', '--details']);
  assert.match(more.out, /\nVersion\n {2}Now: .+\n {2}Before: none kept\n/); assert.match(more.out, /Connected sessions \(0 OMP window\(s\) open now\)\n {2}\S+: .+project-/);
  assert.match((await w.pots(['--version'])).out, /^Pi on the Side \d+\.\d+\.\d+$/);
  // Without an installed copy the command says so in plain words.
  const loose = await w.pots(['status'], { managed: undefined });
  assert.equal(loose.code, 1); assert.match(loose.err, /works from the installed copy/);
});

test('pots status counts a session that was connected from outside the OMP folders, and setup-auto refuses "off" together with wake-up settings', async t => {
  const w = await world(t, 1), outside = path.join(w.base, 'elsewhere'), cwd = path.join(w.base, 'project-outside'), file = path.join(outside, 'saved.jsonl');
  await fs.mkdir(outside); await fs.mkdir(cwd);
  await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n');
  assert.equal((await w.pots(['setup-auto', '--session', file])).code, 0);
  assert.match((await w.pots(['status'])).out, / 2 of 2 saved OMP sessions are connected\./, 'not "2 of 1"');
  const handoff = path.join(w.base, 'handoff.md'), refused = await w.pots(['setup-auto', '--no-coordinator-wakeups', '--resume-cli', 'claude', '--handoff-file', handoff]);
  assert.equal(refused.code, 1); assert.equal(await fs.stat(handoff).then(() => true, () => false), false);
  assert.match(refused.err, /^Use --no-coordinator-wakeups without the resume options .* Nothing was changed\.$/);
  // A deliberate cloud-only setup is shown as what it is, not as a missing program. Its handoff file is the person's own path: while it is missing, status and doctor say so (never "working").
  assert.equal((await w.pots(['setup-auto', '--resume-cli', 'none', '--resume-cloud', 'chatgpt', '--handoff-file', handoff])).code, 0);
  const noHandoff = await w.pots(['status'], { tasks: noTask });
  assert.match(noHandoff.out, /NOT WORKING\. The handoff file the coordinator reads \(.*handoff\.md\) is missing\. Next: create that file again, or run setup-auto with --handoff-file/);
  assert.equal((await w.pots(['doctor'], { tasks: noTask, selfTest: async () => ({ pass: false, text: 'FAIL' }) })).code, 1);
  await fs.writeFile(handoff, 'goal');
  const cloud = await w.pots(['status'], { tasks: noTask });
  assert.match(cloud.out, /Wake-ups from Claude Code or Codex are not set up: this install is set up for cloud tasks only.*run setup-auto with --resume-cli claude, chatgpt \(Codex\) or both/); assert.ok(!/NOT WORKING|not found/.test(cloud.out), cloud.out);
  assert.equal((await w.pots(['doctor'], { tasks: noTask, selfTest: async () => ({ pass: false, text: 'FAIL' }) })).code, 0);
});

test('pots status counts only the sessions pots install would connect: a project folder that holds the install folder is never connected, so it is not counted', async t => {
  const w = await world(t, 1), id = crypto.randomUUID();
  assert.match((await w.pots(['status'])).out, / 1 of 1 saved OMP sessions are connected\. .*Nothing else to do\.$/);
  await fs.writeFile(path.join(w.base, 'agent', 'sessions', 'holds-install.jsonl'), JSON.stringify({ type: 'session', version: 3, id, cwd: w.base }) + '\n');
  const status = await w.pots(['status']);
  assert.match(status.out, / 1 of 1 saved OMP sessions are connected\. .*Nothing else to do\.$/, 'not "1 of 2" with a next step an install can never finish');
  assert.equal(await w.install(), 0); // the install agrees: still one connection, nothing skipped
  assert.match((await w.pots(['status'])).out, / 1 of 1 saved OMP sessions are connected\./);
});

test('pots upgrade while a session is open: staged, checked, switched; the open session keeps its files', async t => {
  const w = await world(t), next = await release('99.0.0');
  const old = await tree(path.join(w.managed, 'versions', (JSON.parse(await fs.readFile(path.join(w.managed, 'current.json'), 'utf8'))).current));
  const result = await w.pots(['upgrade'], { gh: next.gh, openSessions: async () => 1 });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, 'Upgraded to 99.0.0. A session is open, so the new version starts with the next session. Nothing else to do.');
  const pointer = JSON.parse(await fs.readFile(path.join(w.managed, 'current.json'), 'utf8'));
  assert.equal(pointer.current, '99.0.0'); assert.ok(pointer.previous, 'the old version is kept as the way back');
  assert.deepEqual(await tree(path.join(w.managed, 'versions', pointer.previous)), old, 'the old version folder is untouched');
  assert.match((await w.pots(['upgrade'], { gh: next.gh })).out, /^Pi on the Side 99\.0\.0 is already the newest version\. Nothing else to do\.$/);
  // Nothing open: the short sentence.
  const w2 = await world(t), quiet = await w2.pots(['upgrade'], { gh: (await release('99.1.0')).gh });
  assert.equal(quiet.out, 'Upgraded to 99.1.0. Nothing else to do.');
});

test('pots upgrade with a corrupt download or a version that does not start changes nothing and says so', async t => {
  const w = await world(t), before = await fs.readFile(path.join(w.managed, 'current.json')), folders = await fs.readdir(path.join(w.managed, 'versions'));
  const bad = await w.pots(['upgrade'], { gh: (await release('99.0.0', { corrupt: true })).gh });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^Nothing was changed\. The download does not match the published sha256 digest; keeping the current version\. /);
  assert.deepEqual(await fs.readFile(path.join(w.managed, 'current.json')), before);
  assert.deepEqual(await fs.readdir(path.join(w.managed, 'versions')), folders, 'nothing was staged');
  const broken = await w.pots(['upgrade'], { gh: (await release('99.0.0')).gh, startCheck: async () => { throw new Error('does not start'); } });
  assert.equal(broken.code, 1); assert.match(broken.out, /did not start; keeping the current version/);
  assert.deepEqual(await fs.readFile(path.join(w.managed, 'current.json')), before, 'the pointer never moved to a version that does not start');
  // GitHub CLI missing: the one thing the person can do.
  const missing = await w.pots(['upgrade'], { gh: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.equal(missing.code, 1); assert.match(missing.out, /Next: install the GitHub CLI \(gh\)/);
});

test('pots uninstall removes the install and the pots command and says nothing was touched in the projects', async t => {
  const w = await world(t), shim = path.join(w.apps, 'pots.cmd'), root = path.dirname(path.dirname(w.managed));
  assert.ok(await fs.stat(shim));
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /^Pi on the Side was removed, including the pots command\. Your projects and OMP sessions were not touched\..*Nothing else to do\.$/);
  await assert.rejects(fs.stat(shim), { code: 'ENOENT' }); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  assert.equal(w.rows.size, 0, 'the Installed-apps entry is gone');
  for (const name of ['project-0', 'project-1']) assert.ok(await fs.stat(path.join(w.base, name)), 'projects are untouched');
});

test('pots uninstall also removes a leftover Installed apps entry whose folder is gone, and leaves every other entry; pots uninstall --all is a flag, not a folder', async t => {
  const entry = (w, name, command) => { const root = path.join(w.base, name); w.rows.set(installationId(root), { root, command: command ?? `"node.exe" "${path.join(root, 'uninstall.mjs')}" "${root}" --all --ui` }); return installationId(root); };
  const w = await world(t, 1), orphan = entry(w, 'Gone Install'), foreign = entry(w, 'Other Gone Install', 'someone-elses-uninstaller'), other = entry(w, 'Other Install');
  await fs.mkdir(path.join(w.base, 'Other Install'));
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual([...w.rows.keys()].sort(), [foreign, other].sort(), 'only the leftover entry went, not an entry of another command or of a folder that still exists');
  const again = await world(t, 1), againRoot = path.dirname(path.dirname(again.managed)), gone = path.join(again.base, 'Gone Install'); entry(again, 'Gone Install');
  // --all alone only shows what it would remove: nothing is removed until --confirm-offline is added.
  const shown = await again.pots(['uninstall', '--all']);
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.ok(shown.out.startsWith('Nothing was removed.') && shown.out.includes(againRoot) && shown.out.includes(gone) && shown.out.includes('pots uninstall --all --confirm-offline'), shown.out);
  assert.equal(again.rows.size, 2); assert.ok(await fs.stat(againRoot)); assert.ok(await fs.stat(path.join(again.apps, 'pots.cmd')));
  const all = await again.pots(['uninstall', '--all', '--confirm-offline']);
  assert.equal(all.code, 0, all.out + all.err);
  assert.equal(again.rows.size, 0);
  await assert.rejects(fs.stat(againRoot), { code: 'ENOENT' });
  // --confirm-offline alone is not a command of its own.
  assert.equal((await again.pots(['uninstall', '--confirm-offline'])).code, 1);
});

test('pots uninstall says what was removed, where its files went and what was not, when a later entry cannot be removed', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), gone = path.join(w.base, 'Gone Install'), id = installationId(gone);
  w.rows.set(id, { root: gone, command: `"node.exe" "${path.join(gone, 'uninstall.mjs')}" "${gone}" --all --ui` });
  const registry = { ...w.deps.uninstallDeps.registry, remove: async key => { if (key === id) throw new Error('refused'); return w.rows.delete(key); } };
  const result = await w.pots(['uninstall'], { uninstallDeps: { ...w.deps.uninstallDeps, registry } });
  assert.equal(result.code, 1);
  assert.ok(result.out.startsWith('Pi on the Side was only partly removed. Removed: ' + root + ' (its files are in '), result.out);
  assert.ok(result.out.includes('Pi on the Side Recovery') && result.out.includes('Not removed: ' + gone), result.out);
  assert.ok(!result.out.includes('was not removed') && !result.out.includes('run pots uninstall again') && result.out.includes('Settings > Apps > Installed apps'), result.out);
  await assert.rejects(fs.stat(path.join(w.apps, 'pots.cmd')), { code: 'ENOENT' });
  assert.ok(w.rows.has(id), 'the entry that could not be removed is still listed');
});

test('pots uninstall leaves a leftover entry alone when its folder came back before the removal, and says so', async t => {
  const w = await world(t, 1), gone = path.join(w.base, 'Gone Install'), id = installationId(gone);
  w.rows.set(id, { root: gone, command: `"node.exe" "${path.join(gone, 'uninstall.mjs')}" "${gone}" --all --ui` });
  // This install is moved away first; then the other folder reappears.
  const recover = async (...args) => { const moved = await w.deps.uninstallDeps.recover(...args); await fs.mkdir(gone); return moved; };
  const result = await w.pots(['uninstall'], { uninstallDeps: { ...w.deps.uninstallDeps, recover } });
  assert.equal(result.code, 0, result.out + result.err);
  assert.ok(result.out.includes(`The folder ${gone} came back while this ran, so it was left alone.`), result.out);
  assert.ok(await fs.stat(gone)); assert.ok(w.rows.has(id), 'the entry of the folder that came back is kept');
});

test('pots upgrade sees the same newest release as Start: stable only, prerelease only, or both', async t => {
  const stable = await release('99.0.0'), pre = await release('99.1.0-rc.1', { prerelease: true });
  for (const [label, gh, expected] of [['stable only', publish(stable), '99.0.0'], ['prerelease only', publish(pre), '99.1.0-rc.1'], ['both, newest last', publish(stable, pre), '99.1.0-rc.1'], ['both, newest first', publish(pre, stable), '99.1.0-rc.1']]) {
    const w = await world(t, 1), result = await w.pots(['upgrade'], { gh });
    assert.equal(result.code, 0, label + ': ' + result.out + result.err);
    assert.match(result.out, new RegExp(`^Upgraded to ${expected.replaceAll('.', '\\.')}\\.`), label);
  }
  // Nothing published: said in words, not as a network problem.
  const w = await world(t, 1), none = await w.pots(['upgrade'], { gh: publish() });
  assert.match(none.out, /No eligible release is published/); assert.doesNotMatch(none.out, /internet/);
});

test('bare pots lists the commands, led by install, upgrade, status, --version and uninstall (exit 1 and stderr stay as older start checks expect)', async () => {
  const out = [], err = [], code = await main([], { stdout: text => out.push(text), stderr: text => err.push(text) });
  assert.equal(code, 1); assert.deepEqual(out, []); assert.ok(err.join('\n').includes('Pi on the Side!'));
  assert.deepEqual(err.join('\n').split('\n').slice(1, 12).map(line => line.trim().split(/\s{2,}/)[0]), ['pots install', 'pots upgrade', 'pots doctor', 'pots status', 'pots lane restore <name>', 'pots lane close <name>', 'pots lane close --finished', 'pots lane list', 'pots instructions', 'pots --version', 'pots uninstall']);
});

test('uninstall does not claim the pots command was removed when it was kept because the person edited it, and names the file', async t => {
  const w = await world(t, 1), shim = path.join(w.apps, 'pots.cmd');
  await fs.writeFile(shim, '@echo my own pots\r\n');
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.ok(!result.out.includes('including the pots command'), result.out);
  assert.ok(result.out.includes(shim) && /^Pi on the Side was removed\. /.test(result.out) && /Next: .*Delete them yourself/.test(result.out), result.out);
  assert.equal(await fs.readFile(shim, 'utf8'), '@echo my own pots\r\n', 'the file the person edited is left alone');
});

test('uninstall keeps your own assistant settings file and says to remove only the Pi on the Side entry, never to delete the file', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed));
  const settings = path.join(w.base, 'claude_desktop_config.json');
  const original = JSON.stringify({ mcpServers: { 'omp-session-bridge': { command: 'node.exe', args: [path.join(w.base, 'Other Install', 'bridge.mjs')] }, 'my-other-tool': { command: 'tool.exe' } } });
  await fs.writeFile(settings, original);
  const recordFile = path.join(root, 'uninstall-record.json'), record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  record.assistants = [...(record.assistants ?? []).filter(row => row.kind !== 'claude-desktop'), { kind: 'claude-desktop', file: settings }];
  await fs.writeFile(recordFile, JSON.stringify(record));
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.ok(/^Pi on the Side was removed/.test(result.out) && result.out.includes(settings), result.out);
  assert.match(result.out, /remove only that entry/); assert.match(result.out, /Do not delete the file/);
  assert.doesNotMatch(result.out, /Delete them yourself/); assert.doesNotMatch(result.out, /Nothing else to do/);
  assert.equal(await fs.readFile(settings, 'utf8'), original, 'the settings file is left exactly as it was');
});

test('uninstall does not claim the pots command was removed when Setup never recorded one, and leaves that file alone', async t => {
  const w = await world(t, 1), shim = path.join(w.apps, 'pots.cmd'), root = path.dirname(path.dirname(w.managed));
  const recordFile = path.join(root, 'uninstall-record.json'), record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  record.assistants = (record.assistants ?? []).filter(row => row.kind !== 'pots-command');
  await fs.writeFile(recordFile, JSON.stringify(record));
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /^Pi on the Side was removed\. Your projects/);
  assert.ok(await fs.stat(shim), 'a pots command Setup did not record is left alone');
});

test('uninstall does not claim the pots command was removed when the person had already deleted it', async t => {
  const w = await world(t, 1), shim = path.join(w.apps, 'pots.cmd');
  await fs.rm(shim);
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /^Pi on the Side was removed\. Your projects/);
});

test('pots uninstall that is refused for a link or a folder that is not private says so in plain words, keeps the wake-ups, and keeps the install', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), still = async file => fs.stat(file).then(() => true, () => false);
  let removed = 0;
  const refused = { ...w.deps.uninstallDeps, tasks: { remove: async () => { removed++; } }, permissions: { ...w.deps.permissions, verifyTree: async () => { throw new Error(REVIEW); } } };
  const result = await w.pots(['uninstall'], { uninstallDeps: refused });
  assert.equal(result.code, 1);
  assert.match(result.out, /^Pi on the Side was not removed\. A file or folder in the install folder is not private to you, or it is a link.* Next: .*run pots uninstall again/, result.out);
  assert.equal(removed, 0, 'the wake-ups were not switched off'); assert.equal(await still(root), true);
  // --purge looks at an earlier recovery folder first: when that one is refused the person reads the same plain text, never the bare sentence.
  await fs.mkdir(path.join(path.dirname(root), 'Pi on the Side Recovery'));
  const purge = await w.pots(['uninstall', root, '--purge'], { uninstallDeps: { ...w.deps.uninstallDeps, permissions: { ...w.deps.permissions, verify: async file => { if (file.endsWith('Pi on the Side Recovery')) throw new Error(REVIEW); } } } });
  assert.equal(purge.code, 1); assert.equal(purge.err, reviewText('pots uninstall'));
  // pots install says it in its own words and names its own command.
  const shown = [];
  assert.equal(await main(['install'], { ...w.deps, permissions: { ...w.deps.permissions, verify: async () => { throw new Error(REVIEW); } }, stderr: text => shown.push(text) }), 1);
  assert.equal(shown.join('\n'), reviewText('pots install'));
});

test('a stopped pots uninstall says what really happened: a Windows helper that did not finish, a Setup lock that is live, a registry entry left after the files moved', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), base = w.deps.uninstallDeps;
  // The permission check timing out is not "something is using the files": the sentence names it and --details shows the cause.
  const slow = new HelperFailure('Windows did not finish within 60 seconds when Setup tried to check the private permissions of every file in a Setup folder.', 'check the private permissions of every file in a Setup folder: no answer within 60000 ms', 'timeout');
  const timedOut = await w.pots(['uninstall', '--details'], { uninstallDeps: { ...base, permissions: { ...w.deps.permissions, verifyTree: async () => { throw slow; } } } });
  assert.equal(timedOut.code, 1);
  assert.ok(!timedOut.out.includes('something is using'), timedOut.out);
  assert.match(timedOut.out, /^Pi on the Side was not removed\. Windows did not finish within 60 seconds.* Next: run pots uninstall again/);
  assert.match(timedOut.out, /\nDetails: removal-failed; check the private permissions.*no answer within 60000 ms/);
  // A file that really is in use still says so.
  const busy = await w.pots(['uninstall'], { uninstallDeps: { ...base, recover: async () => { throw Object.assign(new Error('in use'), { code: 'EBUSY' }); } } });
  assert.match(busy.out, /something is using them\. Next: close OMP/);
  // The lock of a Setup run that is going is never something to delete.
  const lock = path.join(root, 'setup.lock'); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, up: os.uptime() }));
  const live = await w.pots(['uninstall']);
  assert.match(live.out, /^Pi on the Side was not removed\. Setup or the assistant connection is working on this install right now\. Next: wait a minute/);
  assert.ok(!live.out.includes('delete only that file'), live.out);
  await fs.rm(lock);
  // The files were moved and the wake-up task is gone, but Windows keeps the Installed apps entry: both facts are still told.
  const kept = await w.pots(['uninstall'], { uninstallDeps: { ...base, tasks: { remove: async () => {} }, registry: { ...base.registry, remove: async () => { throw new Error('blocked'); } } } });
  assert.equal(kept.code, 1);
  assert.match(kept.out, /^Pi on the Side was not removed\. Windows would not remove the Pi on the Side entry under Installed apps\. Next: run pots uninstall again\. The files are in .*Pi on the Side Recovery.* The wake-up task was already removed, so wake-ups are off until you run pots install\./);
});

test('an upgrade that worked is never reported as failed because Windows still holds activate.lock; a short hold is waited out', async t => {
  const next = await release('99.0.0'), unlink = fs.unlink;
  const hold = times => { fs.unlink = async (file, ...rest) => { if (String(file).endsWith('activate.lock') && times-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); return unlink(file, ...rest); }; };
  try {
    const brief = await world(t, 1); hold(3);
    const quick = await brief.pots(['upgrade'], { gh: next.gh });
    assert.equal(quick.out, 'Upgraded to 99.0.0. Nothing else to do.', quick.out + quick.err);
    await assert.rejects(fs.stat(path.join(brief.managed, 'activate.lock')), { code: 'ENOENT' });
    const stuck = await world(t, 1); hold(Infinity);
    const kept = await stuck.pots(['upgrade'], { gh: next.gh });
    assert.equal(kept.code, 0, kept.out + kept.err);
    assert.match(kept.out, /^Upgraded to 99\.0\.0\. The upgrade worked, but Windows would not let go of the file activate\.lock in .+\. It is harmless; delete it if a later upgrade says another update is running\./);
    assert.equal(JSON.parse(await fs.readFile(path.join(stuck.managed, 'current.json'), 'utf8')).current, '99.0.0');
  } finally { fs.unlink = unlink; }
});

test('an upgrade that is turned away says the real reason and next step: the install changed, or an earlier upgrade left its lock', async t => {
  const next = await release('99.0.0');
  const changed = await world(t, 1), file = path.join(changed.managed, 'current.json'), pointer = JSON.parse(await fs.readFile(file, 'utf8')); let moved = false;
  const gh = async args => { if (!moved) { moved = true; await fs.writeFile(file, JSON.stringify({ ...pointer, previous: '0.0.1-test' }) + '\n'); } return next.gh(args); };
  const turned = await changed.pots(['upgrade'], { gh });
  assert.equal(turned.code, 1, turned.out + turned.err);
  assert.match(turned.out, /^Nothing was changed\. The install changed while this update was being prepared.* Next: run pots upgrade again\.$/);
  assert.doesNotMatch(turned.out, /wait|another update is running/i);

  const kept = await world(t, 1), pointerFile = path.join(kept.managed, 'current.json'), original = await fs.readFile(pointerFile); let renames = 0;
  const io = { ...fs, rename: async (from, to) => {
    if (to === pointerFile && renames++ > 0) throw Object.assign(new Error('injected'), { code: 'EIO' });
    await fs.rename(from, to);
    if (to === pointerFile) await fs.writeFile(to, '{"broken"');
  } };
  assert.match((await kept.pots(['upgrade'], { gh: next.gh, io })).out, /could not put the old version back/);
  await fs.writeFile(pointerFile, original);
  const again = await kept.pots(['upgrade'], { gh: next.gh });
  assert.equal(again.code, 1, again.out + again.err);
  assert.match(again.out, /^Nothing was changed\. An earlier update could not put its version pointer back.* Next: in .+, check that current\.json names a folder that exists inside versions.*delete only the file activate\.lock/);
  assert.doesNotMatch(again.out, /wait until/i);
});

test('pots install that meets a damaged program folder does not tell the person to run uninstall', async t => {
  const w = await world(t, 1), folder = path.join(w.base, 'OMP Session Bridge Local', 'runtime', 'managed-1a2b3c');
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'current.json'), '{"version":1,"current":"1.0.0"}');
  assert.equal(await w.install(), 1);
  const said = w.err.join('\n') + w.out.join('\n');
  assert.match(said, /is damaged: its files are missing.*Next: move that folder out of the install folder yourself.*run the same command again/);
  assert.doesNotMatch(said, /pots uninstall/);
});

test('the one-line installer takes the newest release (prereleases included), checks its sha256 first, and only then installs', async t => {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-ps-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const bin = path.join(base, 'bin'); await fs.mkdir(bin);
  // Each bundle is a stub whose `install` leaves its version in a marker, so only the choice, the download and the check are tested here.
  const marker = path.join(base, 'ran.txt'), listFile = path.join(base, 'list.json');
  const entry = async (version, { prerelease = false, draft = false, digest, twice = false } = {}) => {
    const stub = Buffer.from(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)} + ' ' + process.argv.slice(2).join(' ')); console.log('Installed Pi on the Side ${version}.');\n`);
    const bytes = zip([{ name: 'bin/bridge.mjs', data: stub }]), name = `omp-session-bridge-${version}.zip`, asset = { name, size: bytes.length, digest: digest ?? 'sha256:' + sha(bytes) };
    await fs.writeFile(path.join(base, `v${version}.zip`), bytes);
    return { draft, prerelease, tag_name: 'v' + version, assets: twice ? [asset, asset] : [asset] };
  };
  const list = async (...entries) => fs.writeFile(listFile, JSON.stringify(entries));
  await fs.writeFile(path.join(bin, 'fake-gh.mjs'), `import fs from 'node:fs'; const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(path.join(base, 'hosts.txt'))}, (process.env.GH_HOST ?? '') + '\\n');
    if (a[0] === 'api') console.log(a.includes('page=1') ? fs.readFileSync(${JSON.stringify(listFile)}, 'utf8') : '[]');
    else fs.copyFileSync(${JSON.stringify(base)} + '/' + a[2] + '.zip', a[a.indexOf('--output') + 1]);\n`);
  await fs.writeFile(path.join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${path.join(bin, 'fake-gh.mjs')}" %*\r\n`);
  const run = async () => {
    await fs.rm(marker, { force: true });
    const script = path.join(CHECKOUT, 'scripts', 'install.ps1');
    const env = { ...process.env, GH_HOST: 'ghe.example.invalid', PATH: [bin, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), path.join(process.env.SystemRoot, 'System32')].join(';') };
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Get-Content -Raw -LiteralPath '${script}' | iex`], { env, windowsHide: true }, (error, stdout, stderr) => resolve({ stdout, stderr })));
  };
  const installed = async (...entries) => { await list(...entries); const out = await run(); return { out, ran: await fs.readFile(marker, 'utf8').catch(() => null) }; };
  // Stable only, prerelease only, and both (in either order): the newest version wins, and its own `install` runs.
  let got = await installed(await entry('1.0.0'));
  assert.equal(got.ran, '1.0.0 install', got.out.stdout + got.out.stderr); assert.match(got.out.stdout, /Installed Pi on the Side 1\.0\.0\./);
  got = await installed(await entry('2.0.0-beta.1', { prerelease: true })); assert.equal(got.ran, '2.0.0-beta.1 install', got.out.stdout);
  for (const order of [[0, 1], [1, 0]]) {
    const both = [await entry('1.0.0'), await entry('1.1.0-rc.1', { prerelease: true })];
    got = await installed(...order.map(i => both[i])); assert.equal(got.ran, '1.1.0-rc.1 install', got.out.stdout);
  }
  // Semantic Versioning order: rc.10 is newer than rc.9, a release is newer than its own prerelease, and a draft is never chosen.
  got = await installed(await entry('1.1.0-rc.9', { prerelease: true }), await entry('1.1.0-rc.10', { prerelease: true })); assert.equal(got.ran, '1.1.0-rc.10 install');
  got = await installed(await entry('1.1.0-rc.1', { prerelease: true }), await entry('1.1.0')); assert.equal(got.ran, '1.1.0 install');
  got = await installed(await entry('1.0.0'), await entry('9.0.0', { draft: true })); assert.equal(got.ran, '1.0.0 install');
  // Nothing published: said in words (not "check your internet"), nothing installed.
  got = await installed();
  assert.match(got.out.stdout, /Pi on the Side was not installed\. No Pi on the Side release was found\. Ask whoever gave you this line to publish one/); assert.doesNotMatch(got.out.stdout, /internet/); assert.equal(got.ran, null);
  // A download that does not match its published checksum, or a release without exactly one bundle, installs nothing.
  got = await installed(await entry('9.9.9', { digest: 'sha256:' + '0'.repeat(64) }));
  assert.match(got.out.stdout, /Pi on the Side was not installed\. The download does not match its published checksum, so nothing was installed\./); assert.equal(got.ran, null);
  got = await installed(await entry('9.9.9', { twice: true }));
  assert.match(got.out.stdout, /exactly one file named omp-session-bridge-9\.9\.9\.zip/); assert.equal(got.ran, null);
  // A GH_HOST set in the person's environment never redirects where the release comes from.
  assert.deepEqual([...new Set((await fs.readFile(path.join(base, 'hosts.txt'), 'utf8')).split('\n').filter(Boolean))], ['github.com']);
});

test('pots status and pots install: a deleted saved session is named, then only its connection is removed', async t => {
  const w = await world(t, 3), sessions = path.join(w.base, 'agent', 'sessions'), stateFolders = path.join(path.dirname(path.dirname(w.managed)), 'sessions');
  await fs.unlink(path.join(sessions, 's0.jsonl'));
  const before = await w.pots(['status']);
  assert.equal(before.code, 0);
  assert.match(before.out, / 2 of 2 saved OMP sessions are connected\. One more connection cannot be used any more because the saved OMP session was deleted or changed \(project-0-[0-9a-f]{8}\)\..* Next: run pots install to remove the connections that cannot be used\.$/);
  const kept = await fs.readdir(stateFolders);
  const fixed = await w.install(['--details']);
  assert.equal(fixed, 0);
  assert.match(w.out.join('\n'), /Removed one connection whose saved OMP session was deleted or changed \(project-0-[0-9a-f]{8}\)\. Your saved sessions and projects were not touched\./);
  assert.deepEqual(await fs.readdir(stateFolders), kept, 'no saved-state folder was removed');
  assert.match((await w.pots(['status'])).out, / 2 of 2 saved OMP sessions are connected\. Assistants set up: none\. Nothing else to do\.$/);
});

test('pots status names a controller folder plainly, and the next install keeps that connection', async t => {
  const w = await world(t, 2), root = path.dirname(path.dirname(w.managed)), registry = path.join(root, 'connections', 'connections.json');
  const names = async () => JSON.parse(await fs.readFile(registry, 'utf8')).connections.map(row => row.name);
  const before = await names(), [id] = await fs.readdir(path.join(root, 'sessions'));
  await fs.mkdir(path.join(root, 'sessions', id, `controller-${id}.lock`));
  const shown = await w.pots(['status']);
  assert.match(shown.out, /is a folder or a link, not the plain file Pi on the Side makes.*Next: fix the folder or link named above/);
  assert.doesNotMatch(shown.out, /deleted or changed/);
  await w.install();
  assert.deepEqual(await names(), before, 'the connection is still listed');
});

test('pots upgrade says plainly when the old version could not be put back, and never says nothing was changed', async t => {
  const w = await world(t), pointer = path.join(w.managed, 'current.json');
  let renames = 0;
  // The new pointer lands damaged and putting the old one back fails too.
  const io = { ...fs, rename: async (from, to) => {
    if (to === pointer && renames++ > 0) throw Object.assign(new Error('injected'), { code: 'EIO' });
    await fs.rename(from, to);
    if (to === pointer) await fs.writeFile(to, '{"broken"');
  } };
  const result = await w.pots(['upgrade'], { gh: (await release('99.0.0')).gh, io });
  assert.equal(result.code, 1);
  assert.ok(!/Nothing was changed/.test(result.out), result.out);
  assert.match(result.out, /could not put the old version back/);
  assert.ok(result.out.includes(path.join(w.managed)) && /delete only the file activate\.lock/.test(result.out), 'it names the one recovery step');
  assert.ok(await fs.stat(path.join(w.managed, 'activate.lock')), 'the lock is kept so no other update starts until it is checked');
});

test('a new version that does not start is removed, so the same version number can be published again with fixed files', async t => {
  const w = await world(t), folders = await fs.readdir(path.join(w.managed, 'versions'));
  const broken = await w.pots(['upgrade'], { gh: (await release('99.0.0')).gh, startCheck: async () => { throw new Error('does not start'); } });
  assert.equal(broken.code, 1); assert.match(broken.out, /did not start; keeping the current version/);
  assert.deepEqual(await fs.readdir(path.join(w.managed, 'versions')), folders, 'the folder of the version that did not start was removed');
  const fixed = await w.pots(['upgrade'], { gh: (await release('99.0.0', { notice: '\nfixed\n' })).gh });
  assert.equal(fixed.code, 0, fixed.out); assert.equal(fixed.out, 'Upgraded to 99.0.0. Nothing else to do.');
});

test('pots uninstall blocked by a leftover OMP lock names the file and what to do', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), id = (await fs.readdir(path.join(root, 'sessions')))[0];
  const lock = path.join(root, 'sessions', id, `supervisor-${id}.lock`);
  await fs.writeFile(lock, JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now(), sessionId: id }));
  const result = await w.pots(['uninstall']);
  assert.equal(result.code, 1);
  assert.ok(result.out.includes(lock), result.out);
  assert.match(result.out, /delete only that file, then run pots uninstall again/);
  assert.ok(!/restart the PC|\(blocked\)/i.test(result.out));
  assert.ok(await fs.stat(root), 'nothing was removed');
  await fs.unlink(lock);
  assert.equal((await w.pots(['uninstall'])).code, 0);
});

// The wake-up path, seen by the person: what pots status, pots doctor and pots upgrade say. Fake scheduled tasks only.
const noTask = { query: async () => null };
test('pots status and pots doctor say in plain words that nothing can wake an assistant when no Claude Code or Codex exists, and doctor fails', async t => {
  const w = await world(t, 1), tasks = noTask, passing = { pass: true, text: 'Wake-up self-test: PASS.' };
  const status = await w.pots(['status'], { tasks });
  assert.match(status.out, /Wake-ups: NOT WORKING\. Nothing can start an assistant by itself when a lane finishes, because no Claude Code or Codex .* was selected for wake-ups\..* Run pots doctor for the whole list\./);
  const doctor = await w.pots(['doctor'], { tasks, selfTest: async () => ({ pass: false, text: 'Wake-up self-test: FAIL. The decision was not made.' }) });
  assert.equal(doctor.code, 1);
  assert.match(doctor.out, /^NOT WORKING: Nothing can start an assistant by itself[^]*\nWake-up self-test: FAIL\./);
  const root = path.dirname(path.dirname(w.managed));
  assert.match(await fs.readFile(path.join(root, 'pots.log'), 'utf8'), /Wake-up self-test: FAIL\./, 'the failure is also in the log');
  assert.equal((await w.pots(['doctor'], { tasks, selfTest: async () => passing })).code, 0, 'the exit code follows the self-test; the rows above it say what is missing');
});

test('pots install --no-coordinator-wakeups removes the scheduled task, runs no self-test and is "off by your choice" everywhere', async t => {
  const w = await world(t, 1); let removed = 0, tested = 0;
  const tasks = { query: async () => null, remove: async () => { removed++; return 'removed'; } }, selfTest = async () => { tested++; return { pass: false, text: 'Wake-up self-test: FAIL. nothing' }; };
  const off = await w.pots(['install', '--no-coordinator-wakeups'], { tasks, selfTest });
  assert.equal(off.code, 0, off.out); assert.equal(removed, 1); assert.equal(tested, 0);
  assert.ok(!/FAIL/.test(off.out) && /off by your choice/.test(off.out), off.out);
  assert.match((await w.pots(['status'], { tasks })).out, /Wake-ups: off by your choice\. To turn them on again, run pots install --coordinator-wakeups\./);
  const doctor = await w.pots(['doctor'], { tasks, selfTest });
  assert.equal(doctor.code, 0); assert.equal(tested, 0); assert.match(doctor.out, /^OK: Wake-ups are off by your choice\. To turn them on again, run pots install --coordinator-wakeups\.$/);
  // The choice is kept by a later plain install.
  assert.equal((await w.pots(['install'], { tasks, selfTest })).code, 0); assert.equal(tested, 0);
});

test('pots install --coordinator-wakeups ends "off by your choice"; both wake-up flags together are refused in plain words and change nothing', async t => {
  const w = await world(t, 1), tasks = { query: async () => null, remove: async () => 'absent' };
  assert.equal((await w.pots(['install', '--no-coordinator-wakeups'], { tasks })).code, 0);
  const both = await w.pots(['install', '--coordinator-wakeups', '--no-coordinator-wakeups'], { tasks });
  assert.equal(both.code, 1); assert.equal(both.err, 'Use either --coordinator-wakeups or --no-coordinator-wakeups, not both. Nothing was changed.');
  assert.match((await w.pots(['status'], { tasks })).out, /Wake-ups: off by your choice\./, 'the refused run changed nothing');
  const on = await w.pots(['install', '--coordinator-wakeups'], { tasks });
  assert.equal(on.code, 0, on.err); assert.ok(!/off by your choice/.test(on.out), on.out);
  assert.ok(!/off by your choice/.test((await w.pots(['status'], { tasks })).out));
  assert.ok(!/off by your choice/.test((await w.pots(['doctor'], { tasks, selfTest: async () => ({ pass: true, text: 'Wake-up self-test: PASS.' }) })).out));
  const auto = await Promise.all([['--coordinator-wakeups', '--no-coordinator-wakeups'], ['--no-coordinator-wakeups', '--coordinator-wakeups']].map(flags => w.pots(['setup-auto', ...flags])));
  assert.deepEqual(auto.map(row => row.code), [1, 1]);
});

test('pots doctor treats Disable-Resume as off by the owner: exit 0, no self-test, and pots status agrees', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), control = path.join(root, 'coordinator-resume', 'control'); let tested = 0;
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(root, 'coordinator-resume', 'config.json'), JSON.stringify({ version: 1, cliClients: 'claude' }));
  await fs.writeFile(path.join(control, 'disabled'), 'POTS coordinator resume disabled.\r\n');
  const selfTest = async () => { tested++; return { pass: false, text: 'Wake-up self-test: FAIL. nothing' }; };
  const doctor = await w.pots(['doctor'], { tasks: noTask, selfTest });
  assert.equal(doctor.code, 0, doctor.out); assert.equal(tested, 0);
  assert.match(doctor.out, /^OK: Wake-ups are off by your choice: you switched them off with Disable-Resume\. To switch them on again, delete .*disabled and run pots install\.$/);
  assert.match((await w.pots(['status'], { tasks: noTask })).out, /Wake-ups: off by your choice\./);
});

test('pots install exits with 1 and says why when the wake-up self-test fails; with no Claude Code or Codex there is nothing to test and it exits 0', async t => {
  const w = await world(t, 1), bin = path.join(w.base, 'bin'); await fs.mkdir(bin); await fs.writeFile(path.join(bin, 'claude.exe'), 'fake');
  const env = { ...w.deps.env, PATH: bin }, fail = async () => ({ pass: false, text: 'Wake-up self-test: FAIL. The watcher did not notice the finished test lane within 15.0 seconds.' });
  const none = await w.pots(['install'], { selfTest: fail });
  assert.equal(none.code, 0, 'OMP only: the install is complete and must not look failed'); assert.ok(!/FAIL/.test(none.out), none.out);
  const failed = await w.pots(['install'], { env, selfTest: fail });
  assert.equal(failed.code, 1); assert.match(failed.out, /Wake-up self-test: FAIL\. The watcher did not notice/);
  assert.equal((await w.pots(['install'], { env, selfTest: async () => ({ pass: true, text: 'Wake-up self-test: PASS.' }) })).code, 0);
});

test('pots uninstall that is blocked says what happened and the one next step in plain words; the code is only under --details', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed));
  await fs.writeFile(path.join(root, 'my-notes.txt'), 'mine');
  const blocked = await w.pots(['uninstall']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /^Pi on the Side was not removed\. The install folder has a file that Pi on the Side did not make.* Next: move your own files out of the install folder/);
  assert.ok(!/unverified-files|\(blocked\)/.test(blocked.out), blocked.out);
  assert.match((await w.pots(['uninstall', '--details'])).out, /\nDetails: unverified-files \(my-notes\.txt\)$/);
  assert.equal(await fs.readFile(path.join(root, 'my-notes.txt'), 'utf8'), 'mine');
});

test('pots upgrade finishes the setup of the version it activated, and says so loudly when that fails', async t => {
  const w = await world(t), next = await release('99.0.0'), seen = [];
  const ok = await w.pots(['upgrade'], { gh: next.gh, reinstall: async managed => { seen.push(managed); return { ok: true, text: 'Pi on the Side 99.0.0 is already installed; its program files were not changed. Wake-up self-test: PASS.' }; } });
  assert.equal(ok.code, 0); assert.deepEqual(seen, [w.managed]);
  assert.equal(ok.out, 'Upgraded to 99.0.0.\nPi on the Side 99.0.0 is already installed; its program files were not changed. Wake-up self-test: PASS.');
  const w2 = await world(t), bad = await w2.pots(['upgrade'], { gh: (await release('99.0.0')).gh, reinstall: async () => ({ ok: false, text: 'boom' }) });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^Upgraded to 99\.0\.0\. Finishing the setup failed, so some parts may be out of date\. Next: run pots install\. boom$/);
});

test('pots install from an install in a custom folder repeats that install and never makes a second one or moves pots', async t => {
  const w = await world(t, 1), custom = path.join(w.base, 'Private POTS');
  assert.ok(await autoSetup({ root: custom }, w.deps));
  const managed = path.join(custom, 'runtime', 'current'), shim = path.join(w.apps, 'pots.cmd');
  const folders = (await fs.readdir(w.base)).sort(), shimBefore = await fs.readFile(shim, 'utf8');
  assert.ok(shimBefore.includes(path.join(managed, 'bridge.mjs')), 'pots points at the custom install');
  const out = [], err = [];
  assert.equal(await main(['install'], { ...w.deps, managed, stdout: text => out.push(text), stderr: text => err.push(text) }), 0, err.join('\n'));
  assert.deepEqual((await fs.readdir(w.base)).sort(), folders, 'no second install folder appeared');
  assert.equal(await fs.readFile(shim, 'utf8'), shimBefore, 'pots still points at the custom install');
  assert.match(out.join('\n'), /already installed; its program files were not changed/);
});

test('pots status says in plain words that a queued task never started, and names it', async t => {
  const w = await world(t, 1), root = path.dirname(path.dirname(w.managed)), state = path.join(root, 'sessions', (await fs.readdir(path.join(root, 'sessions')))[0]);
  const { loadSetup } = await import('../src/setup.mjs'), { Store } = await import('../src/control.mjs');
  const store = (await loadSetup(state)).store, id = crypto.randomUUID();
  await store.enqueue({ version: 1, id, sessionId: store.config.sessionId, expiresAt: Date.now() + 3600000, steps: [{ prompt: 'x', continueAfterEnd: false }] });
  assert.ok(!/was not started/.test((await w.pots(['status'])).out));
  await store.save({ version: 1, id, sessionId: store.config.sessionId, state: 'expired', reason: 'expired_before_submission', nextStep: 0, updatedAt: Date.now(), outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  const out = (await w.pots(['status'])).out;
  assert.ok(out.includes('A queued task was not started because the lane stayed busy until its time limit ran out. Queue it again when the lane is free. (' + id + ')'), out);
});
