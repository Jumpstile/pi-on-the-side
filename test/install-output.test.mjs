import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main, shownText } from '../src/cli.mjs';
import { UNINSTALL_ERRORS, registerInstallation } from '../src/uninstall.mjs';
import { CONNECTION_ERRORS } from '../src/connections.mjs';
import { WATCH_ERRORS } from '../src/lane-watch.mjs';
import { MESSAGES as UPDATE_MESSAGES, RELEASE_FILES } from '../src/update.mjs';
import { autoSetup, autoDefaults, resultMessage, resultDetails } from '../src/autosetup.mjs';

// A disposable fake home with the ChatGPT desktop app (a `.codex` folder) and two saved OMP sessions in two projects.
async function fixture(t, { saved = 2 } = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-ui-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const agent = path.join(root, 'agent'), sessions = path.join(agent, 'sessions'), home = path.join(root, 'home');
  await Promise.all([fs.mkdir(sessions, { recursive: true }), fs.mkdir(path.join(home, '.codex'), { recursive: true }), fs.mkdir(path.join(root, 'Packages', 'OpenAI.ChatGPT-Desktop_fixture'), { recursive: true })]);
  const projects = [];
  for (let n = 0; n < saved; n++) {
    const cwd = path.join(root, `project-${n}`); await fs.mkdir(cwd); projects.push(cwd);
    await fs.writeFile(path.join(sessions, `saved-${n}.jsonl`), JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), cwd }) + '\n' +
      JSON.stringify({ type: 'message', content: 'PRIVATE TRANSCRIPT SENTINEL' }) + '\n');
  }
  const deps = { platform: 'win32', env: { PI_CODING_AGENT_DIR: agent, LOCALAPPDATA: root }, home, nodeVersion: process.versions.node, nodeExecutable: process.execPath,
    locate: async () => process.execPath, detect: async () => 'omp/18.8.6', openSessions: async () => 0,
    tasks: undefined, selfTest: undefined, startCheck: async () => {}, which: async () => null,
    permissions: { protect: async () => {}, verify: async () => {}, verifyTree: async () => {} } };
  // The Installed-apps list is a fake: a run must never add an entry to the real one on this PC.
  const rows = new Map(), registry = { read: async id => rows.get(id) ?? null, remove: async id => rows.delete(id), list: async () => [...rows.values()].map(row => row.root),
    write: async (id, entry) => rows.set(id, { root: entry.PiOwnedRoot, command: entry.UninstallString }) };
  deps.registry = registry; deps.registerUninstall = (installRoot, options) => registerInstallation(installRoot, { ...options, registry });
  return { root, projects, deps, rows };
}
// The install result with the same sentence and details `pots install` prints. A failure is the text the person would see.
const install = async (f, over = {}) => {
  try {
    const result = await autoSetup({}, { ...autoDefaults, ...f.deps, ...over });
    return { ...result, message: resultMessage(result), details: resultDetails(result) };
  } catch (error) { throw Object.assign(new Error(shownText(error)), { shown: shownText(error) }); }
};
const pointerOf = async managed => JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).current;
// Turns the copy that Setup just installed into an older version (same layout, own folder, verified record).
async function makeOlder(managed, label) {
  const dir = path.join(managed, 'versions', label), files = {};
  const current = await pointerOf(managed);
  await fs.rm(path.join(managed, 'versions', current), { recursive: true, force: true });
  for (const name of RELEASE_FILES) {
    let data = await fs.readFile(path.join(import.meta.dirname, '..', name));
    if (name === 'package.json') { const { runtimeFiles, ...pkg } = JSON.parse(data); data = Buffer.from(JSON.stringify({ ...pkg, version: label }, null, 2) + '\n'); }
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), data);
    files[name] = crypto.createHash('sha256').update(data).digest('hex');
  }
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify({ version: 1, release: label, digest: 'sha256:' + '0'.repeat(64), files }) + '\n');
  await fs.writeFile(path.join(managed, 'current.json'), JSON.stringify({ version: 1, current: label, previous: null }) + '\n');
  return current;
}

test('one command connects every saved session on the PC and the sentence names the next step', async t => {
  const f = await fixture(t), result = await install(f);
  assert.equal(f.rows.size, 1, 'the run adds exactly one entry, and only to the fake list');
  assert.deepEqual(result.sessions.map(row => row.project).sort(), [...f.projects].sort());
  assert.deepEqual(result.skipped, []);
  assert.ok(result.message.startsWith(`Installed Pi on the Side ${result.upgrade.to}. Next: `), result.message);
  assert.ok(!result.message.includes('\n'), 'one sentence, not the summary');
  // The details name both projects and every launcher, and never a transcript.
  for (const title of ['What happened', 'Version', 'Where it is installed']) assert.ok(result.details.includes(title + '\n'), 'labelled block: ' + title);
  for (const row of result.sessions) assert.ok(result.details.includes(row.project) && result.details.includes(row.launcher));
  assert.ok(!JSON.stringify(result).includes('PRIVATE TRANSCRIPT SENTINEL'));
  // The same fixed program path serves every version and every session.
  assert.equal(result.cliLauncher, path.join(result.installRoot, 'runtime', 'current', 'bridge.mjs'));
});

test('the one next step only a person can do is a command: pots instructions for ChatGPT', async t => {
  const f = await fixture(t), first = await install(f);
  const row = first.assistants.needsYou.find(item => item.action === 'copy-chatgpt-instructions');
  assert.ok(row && path.isAbsolute(row.file));
  assert.match(await fs.readFile(row.file, 'utf8'), /\S/);
  assert.ok(first.message.includes('Run pots instructions'), first.message);
  assert.ok(first.details.includes(row.file), 'the details name the file');
  // `pots instructions` prints just the text on stdout (so `| clip` copies only it) and says where it is saved on stderr.
  const out = [], err = [], code = await main(['instructions'], { ...f.deps, managed: path.dirname(first.cliLauncher), stdout: text => out.push(text), stderr: text => err.push(text) });
  assert.equal(code, 0);
  assert.equal(out.join('\n'), (await fs.readFile(row.file, 'utf8')).trimEnd());
  assert.ok(err.join('\n').includes(row.file) && err.join('\n').includes('Custom instructions'), err.join('\n'));
  // Without the instruction file there is nothing to print, and it says what to do.
  const none = await fixture(t), noneFirst = await install(none), gone = [];
  await fs.rm(noneFirst.assistants.needsYou.find(item => item.file).file);
  assert.equal(await main(['instructions'], { ...none.deps, managed: path.dirname(noneFirst.cliLauncher), stdout: () => {}, stderr: text => gone.push(text) }), 1);
  assert.match(gone.join('\n'), /^There are no ChatGPT instructions to paste because ChatGPT is not set up\. Next: install the ChatGPT desktop app, then run pots install\.$/);
  // Claude Desktop is connected through its own settings file: there is nothing to open or type.
  const d = await fixture(t), appData = path.join(d.root, 'AppData');
  await fs.mkdir(path.join(appData, 'Claude'), { recursive: true }); d.deps.env.APPDATA = appData;
  const desktop = await install(d);
  assert.ok(JSON.parse(await fs.readFile(path.join(appData, 'Claude', 'claude_desktop_config.json'), 'utf8')).mcpServers['omp-session-bridge']);
  assert.ok(!desktop.assistants.needsYou.some(item => item.client === 'Claude Desktop'));
  assert.doesNotMatch(desktop.message, /\.mcpb/);
  for (const text of [first.message, desktop.message, first.details]) assert.doesNotMatch(text, /Click|button|Setup\.exe|Setup window|Show details/i);
});

test('without OMP on PATH a repeat run uses the OMP the install already records, and a first run says what to do', async t => {
  const f = await fixture(t);
  await assert.rejects(install(f, { locate: async () => null }), error => /^pots install could not find OMP on this PC\. Next: install OMP .*then run pots install again\./.test(error.shown) && !/PATH\b/.test(error.shown.split('\nDetails:')[0].replace('on your PATH', '')));
  await assert.rejects(fs.stat(path.join(f.root, 'OMP Session Bridge Local')), { code: 'ENOENT' });
  const first = await install(f), again = await install(f, { locate: async () => null });
  assert.ok(again.message.startsWith(`Pi on the Side ${first.upgrade.to} is already installed; its program files were not changed.`), again.message);
});

test('a saved project that Setup has to skip is explained in words, never as a system code', async t => {
  const f = await fixture(t), gone = path.join(f.root, 'agent', 'sessions', 'saved-1.jsonl'); let first = true;
  // The saved file disappears after Setup found it and before it connects it.
  const result = await install(f, { detect: async () => { if (first) { first = false; await fs.rm(gone); } return 'omp/18.8.6'; } });
  assert.equal(result.sessions.length, 1); assert.equal(result.skipped.length, 1);
  assert.ok(result.summary.some(line => line.includes('skipped (its saved file or folder is gone)')), result.summary.join('\n'));
  assert.ok(!/ENOENT/.test(result.summary.join('\n') + result.message + result.skipped[0].reason));
  // With nothing else to do, the sentence still says what to do about the skipped project.
  assert.match(resultMessage({ upgrade: { kind: 'upgrade', message: 'Upgraded to 1.0.0.' }, assistants: { needsYou: [] }, skipped: [{}] }), /^Upgraded to 1\.0\.0\. Next: run pots install again/);
});

test('the result sentence says what happened: installed, unchanged, upgraded (also while a session is open)', async t => {
  const f = await fixture(t, { saved: 1 }), first = await install(f), managed = path.dirname(first.cliLauncher), version = first.upgrade.to;
  const again = await install(f);
  assert.ok(again.message.startsWith(`Pi on the Side ${version} is already installed; its program files were not changed. `), again.message);
  // A session is open: the upgrade still happens, the open session keeps what it loaded, and the sentence says so.
  await makeOlder(managed, '0.2.20');
  const open = await install(f, { openSessions: async () => 2 });
  assert.ok(open.message.startsWith(`Upgraded to ${version}. A session is open, so the new version starts with the next session. `), open.message);
  assert.equal(open.upgrade.sessionOpen, true);
  assert.equal(await pointerOf(managed), version);
  assert.ok(!/refus|close every|close all/i.test(open.message));
  // Nothing open: the plain sentence only.
  await makeOlder(managed, '0.2.20');
  const quiet = await install(f);
  assert.ok(quiet.message.startsWith(`Upgraded to ${version}. `) && !quiet.message.includes('session is open'), quiet.message);
  // Every result line says what happened and then gives a real next step or says nothing is left.
  for (const row of [first, again, open, quiet]) assert.match(row.message, /(Nothing else to do\.|Next: .{15,})$/, row.message);
  assert.equal(await pointerOf(managed), version);
});

test('without a saved session Setup says so in plain words and changes nothing', async t => {
  const f = await fixture(t, { saved: 0 });
  await assert.rejects(install(f), error => /create a saved session in OMP first/.test(error.shown) && !/unexpected error/.test(error.shown));
  await assert.rejects(fs.stat(path.join(f.root, 'OMP Session Bridge Local')), { code: 'ENOENT' });
});

test('install takes no folders or choices: any other word is refused with the usage text', async t => {
  const f = await fixture(t);
  for (const args of [['install', '--session', 'C:\\x.jsonl'], ['install', 'now'], ['install', '--json']]) {
    const err = [], code = await main(args, { ...f.deps, stdout: () => {}, stderr: text => err.push(text) });
    assert.equal(code, 1, args.join(' ')); assert.match(err.join(''), /Usage|usage|Pi on the Side/);
  }
});

test('pots install shows the plain reason for uninstall, connection, watcher and update failures, not a bare unexpected error', () => {
  for (const reason of [UNINSTALL_ERRORS.find(text => /registration failed/.test(text)), CONNECTION_ERRORS.at(-1), WATCH_ERRORS[0], Object.values(UPDATE_MESSAGES)[0]]) {
    assert.ok(reason);
    assert.ok(shownText(new Error(reason)).includes(reason), reason);
  }
  assert.match(shownText(new Error('uninstall refused: foreign registry entry')), /Nothing was removed or lost/);
  assert.equal(shownText(new Error('some private path C:/secret')), 'unexpected error');
});

test('a folder of an earlier install that cannot be read is explained, and what could not be undone is named', () => {
  assert.match(shownText(new Error('not a complete bridge setup folder')), /^Setup found a folder of an earlier install.*Run pots install again/s);
  const undone = Object.assign(new Error('private permission setup failed'), { left: ['One file is still changed.'] });
  assert.match(shownText(undone), /private permission setup failed\nSetup could not undo all of its changes: One file is still changed\. Close all OMP windows/);
});
