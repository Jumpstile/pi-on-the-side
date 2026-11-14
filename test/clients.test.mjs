import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { configureAssistants, SERVER_NAME, windowsTasks } from '../src/clients.mjs';

const BEGIN = '# BEGIN Pi on the Side (omp-session-bridge): written by its installer; a backup is kept in the install folder';
const END = '# END Pi on the Side (omp-session-bridge)';
const MARK = '<!-- managed by the Pi on the Side installer; replaced on upgrade -->';
const HEAD = '---\nname: pi-on-the-side\ndescription: "Coordinate Pi on the Side lanes: send approved tasks to OMP sessions, check progress and wake-ups, review results."\n---\n' + MARK + '\n';
const INSTRUCTIONS = 'Coordinate the lanes carefully.\nAsk before sending work.\n';
const CODEX = 'ChatGPT desktop app (Codex)';
const q = value => JSON.stringify(value);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const read = file => fs.readFile(file, 'utf8');
const writeText = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
const writeDoc = (file, doc) => writeText(file, JSON.stringify(doc, null, 2) + '\n');
const readDoc = async file => JSON.parse(await read(file));

// path -> hash/mtime for every file and folder below the given folders.
async function snapshot(...dirs) {
  const out = {};
  const walk = async dir => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out[full + path.sep] = 'dir'; await walk(full); } else {
        const stat = await fs.stat(full);
        out[full] = sha(await fs.readFile(full)) + ':' + stat.mtimeMs;
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return out;
}

// Stands in for the real `claude` CLI: it edits ~/.claude.json the way the CLI does.
function fakeClaude(w, { failAdd = null } = {}) {
  const calls = [];
  const file = path.join(w.home, '.claude.json');
  const load = async () => { try { return JSON.parse(await read(file)); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
  const run = async (exe, args) => {
    calls.push({ exe, args: [...args] });
    if (args[1] === 'add') {
      assert.deepEqual(args.slice(2, 4), ['--scope', 'user']);
      let i = 4;
      const env = {};
      while (args[i] === '--env') { const [key, ...rest] = args[i + 1].split('='); env[key] = rest.join('='); i += 2; }
      assert.equal(args[i], '--transport');
      assert.equal(args[i + 1], 'stdio');
      assert.equal(args[i + 3], '--');
      if (failAdd === 'before-write') throw new Error('claude add failed');
      const doc = await load();
      doc.mcpServers ??= {};
      doc.mcpServers[args[i + 2]] = { type: 'stdio', command: args[i + 4], args: args.slice(i + 5), env };
      await writeDoc(file, doc);
      if (failAdd === 'after-write') throw new Error('claude add crashed');
    } else if (args[1] === 'remove') {
      assert.deepEqual(args.slice(3), ['--scope', 'user']);
      const doc = await load();
      delete doc.mcpServers?.[args[2]];
      await writeDoc(file, doc);
    } else throw new Error('unexpected claude command');
    return { stdout: '' };
  };
  return { run, calls };
}

// Stands in for the installer's private backup folder: records, refuses overwrite.
function fakeBackup({ fail = false } = {}) {
  const records = new Map();
  return {
    records,
    file: async (name, bytes) => {
      assert.match(name, /^[a-z0-9-]+\.json$/);
      if (fail) throw new Error('no space');
      assert.ok(!records.has(name), 'backup name reused: ' + name);
      records.set(name, JSON.parse(Buffer.from(bytes).toString('utf8')));
      return path.join('X:', name);
    }
  };
}

async function world(t, { code = true, desktop = true, codex = true, codexExe = false, claudeFolder = code } = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temp, 'bridge-clients-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const w = { base, home: path.join(base, 'home'), appData: path.join(base, 'appdata'), installRoot: path.join(base, 'install') };
  w.node = path.join(base, 'node', 'node.exe');
  w.launcher = path.join(w.installRoot, 'runtime', '2.0.0', 'bin', 'bridge.mjs');
  w.oldLauncher = path.join(w.installRoot, 'runtime', '1.0.0', 'bin', 'bridge.mjs');
  w.connections = path.join(w.installRoot, 'connections');
  w.credential = path.join(w.installRoot, 'credentials', 'controller.json');
  w.claudeJson = path.join(w.home, '.claude.json');
  w.desktopFolder = path.join(w.appData, 'Claude');
  w.desktopFile = path.join(w.desktopFolder, 'claude_desktop_config.json');
  w.codexFile = path.join(w.home, '.codex', 'config.toml');
  w.skillFile = path.join(w.home, '.claude', 'skills', 'pi-on-the-side', 'SKILL.md');
  w.exes = {};
  await fs.mkdir(w.home, { recursive: true });
  await fs.mkdir(path.join(base, 'bin'), { recursive: true });
  if (code) { w.exes['claude.exe'] = path.join(base, 'bin', 'claude.exe'); await fs.writeFile(w.exes['claude.exe'], 'fake'); }
  if (codexExe) { w.exes['codex.exe'] = path.join(base, 'bin', 'codex.exe'); await fs.writeFile(w.exes['codex.exe'], 'fake'); }
  if (claudeFolder) await fs.mkdir(path.join(w.home, '.claude'), { recursive: true });
  if (desktop) {
    // Claude Desktop's own settings file: Setup adds only its own entry and keeps everything else.
    await writeDoc(w.desktopFile, { theme: 'dark', mcpServers: { other: { command: 'desktop-other', env: { TOKEN: 'secret-desktop-token' } } } });
  }
  if (codex) await fs.mkdir(path.join(w.home, '.codex'), { recursive: true });
  w.backup = fakeBackup();
  w.claude = fakeClaude(w);
  w.options = (over = {}) => ({
    clients: 'both', installRoot: w.installRoot, nodeExecutable: w.node, mcpLauncher: w.launcher, mcpArguments: ['mcp'],
    connectionsFolder: w.connections, credentialFile: w.credential, backup: w.backup,
    coordinatorInstructions: { claude: INSTRUCTIONS }, ...over
  });
  w.go = (over = {}, claude = w.claude) => configureAssistants(w.options(over), {
    home: w.home, env: { APPDATA: w.appData }, which: async name => w.exes[name] ?? null, run: claude.run, now: () => 1760000000000
  });
  w.state = () => snapshot(w.home, w.appData);
  w.block = (launcher, withCredential, credential = w.credential) => [BEGIN, '[mcp_servers.' + SERVER_NAME + ']', 'command = ' + q(w.node),
    'args = [' + q(launcher) + ', "mcp"]',
    'env = { OMP_BRIDGE_STATE = ' + q(w.connections) + (withCredential ? ', OMP_BRIDGE_CONTROLLER = ' + q(credential) : '') + ' }',
    'default_tools_approval_mode = "writes"', END].join('\n');
  w.ccEntry = (launcher, withCredential) => ({ type: 'stdio', command: w.node, args: [launcher, 'mcp'],
    env: { OMP_BRIDGE_STATE: w.connections, ...(withCredential ? { OMP_BRIDGE_CONTROLLER: w.credential } : {}) } });
  w.dEntry = (launcher, withCredential) => ({ command: w.node, args: [launcher, 'mcp'],
    env: { OMP_BRIDGE_STATE: w.connections, ...(withCredential ? { OMP_BRIDGE_CONTROLLER: w.credential } : {}) } });
  return w;
}
const byClient = (result, client, what = 'connection') => result.items.find(entry => entry.client === client && entry.what === what);
const statuses = result => result.items.map(entry => `${entry.client}/${entry.what}:${entry.status}`);

async function credentialHolders(w) {
  const holders = [];
  for (const [name, file] of [['code', w.claudeJson], ['desktop', w.desktopFile], ['codex', w.codexFile]]) {
    if (!await exists(file)) continue;
    if ((await read(file)).includes(q(w.credential).slice(1, -1))) holders.push(name);
  }
  return holders;
}

test('fresh machine: Claude Code, Claude Desktop, Codex and the Claude skill are connected, only Claude Code can direct', async t => {
  const w = await world(t);
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:configured', 'Claude Desktop/connection:configured',
    'Claude Code/instructions:configured', CODEX + '/connection:configured']);
  assert.match(byClient(result, 'Claude Desktop').message, /read-only viewer.*next time Claude Desktop is opened\.$/);
  assert.deepEqual(result.needsYou, []);
  assert.deepEqual(result.claudeCode, { exe: w.exes['claude.exe'] });
  // Claude Code: exact vector, then the CLI-written entry.
  assert.deepEqual(w.claude.calls, [{ exe: w.exes['claude.exe'], args: ['mcp', 'add', '--scope', 'user',
    '--env', 'OMP_BRIDGE_STATE=' + w.connections, '--env', 'OMP_BRIDGE_CONTROLLER=' + w.credential,
    '--transport', 'stdio', SERVER_NAME, '--', w.node, w.launcher, 'mcp'] }]);
  assert.deepEqual(await readDoc(w.claudeJson), { mcpServers: { [SERVER_NAME]: w.ccEntry(w.launcher, true) } });
  // Claude Desktop keeps its own settings and gains our entry, as a read-only viewer.
  assert.deepEqual(await readDoc(w.desktopFile), { theme: 'dark', mcpServers: { other: { command: 'desktop-other', env: { TOKEN: 'secret-desktop-token' } }, [SERVER_NAME]: w.dEntry(w.launcher, false) } });
  // Codex: exact TOML block, read-only.
  assert.equal(await read(w.codexFile), w.block(w.launcher, false) + '\n');
  // Skill.
  assert.equal(await read(w.skillFile), HEAD + INSTRUCTIONS);
  assert.deepEqual(await credentialHolders(w), ['code']);
  assert.match(byClient(result, 'Claude Code').message, /directing assistant, which can send and cancel tasks/);
  assert.match(byClient(result, CODEX).message, /read-only viewer, which cannot send or cancel tasks/);
  // Records of what Setup owns outside its folder, for the uninstaller.
  assert.deepEqual(result.owned, [{ kind: 'claude-desktop', file: w.desktopFile }, { kind: 'claude-skill', file: w.skillFile, sha256: sha(HEAD + INSTRUCTIONS) }, { kind: 'codex', file: w.codexFile, sha256: sha(w.block(w.launcher, false)) }]);
  // Backup records hold only our (absent) previous part.
  assert.deepEqual([...w.backup.records.keys()].sort(), ['claude-code-connection.json', 'claude-desktop-connection.json', 'claude-skill-instructions.json', 'codex-connection.json']);
  assert.deepEqual(w.backup.records.get('claude-code-connection.json'), { file: w.claudeJson, existed: false, previous: null });
  assert.deepEqual(w.backup.records.get('claude-desktop-connection.json'), { file: w.desktopFile, existed: true, previous: null });
  assert.deepEqual(w.backup.records.get('codex-connection.json'), { file: w.codexFile, existed: false, previous: null });
});

// A small frontmatter check without a YAML library: each line is `key: value`; a quoted value is one whole quoted string; a plain value has no ": " or " #".
const frontmatterProblems = text => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!block) return ['no frontmatter'];
  return block[1].split('\n').flatMap(line => {
    const pair = /^([A-Za-z][\w-]*): (.+)$/.exec(line);
    if (!pair) return ['not "key: value": ' + line];
    if (pair[2].startsWith('"')) return /^"(?:[^"\\]|\\.)*"$/.test(pair[2]) ? [] : ['quoted value is not one string: ' + line];
    return /: | #|^[[\]{}&*!|>'%@`]/.test(pair[2]) ? ['plain value is not valid YAML: ' + line] : [];
  });
};
test('the Claude skill file starts with frontmatter that a YAML reader accepts', async t => {
  const w = await world(t);
  await w.go();
  assert.deepEqual(frontmatterProblems(await read(w.skillFile)), []);
  assert.ok(frontmatterProblems('---\nname: x\ndescription: Coordinate lanes: send tasks\n---\n').length, 'the check does reject a colon inside a plain value');
});

test('custom CLAUDE_CONFIG_DIR and CODEX_HOME: Setup writes where the apps read, leaves the home folder alone, and undo takes it back', async t => {
  const w = await world(t, { codex: false, claudeFolder: false });
  const claudeDir = path.join(w.base, 'my-claude'), codexDir = path.join(w.base, 'my-codex');
  await fs.mkdir(claudeDir); await fs.mkdir(codexDir);
  const claude = fakeClaude({ ...w, home: claudeDir });
  const result = await configureAssistants(w.options(), { home: w.home, env: { APPDATA: w.appData, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir },
    which: async name => w.exes[name] ?? null, run: claude.run, now: () => 1760000000000 });
  assert.equal(byClient(result, 'Claude Code').status, 'configured'); assert.equal(byClient(result, CODEX).status, 'configured');
  assert.deepEqual(await readDoc(path.join(claudeDir, '.claude.json')), { mcpServers: { [SERVER_NAME]: w.ccEntry(w.launcher, true) } });
  assert.equal(await read(path.join(codexDir, 'config.toml')), w.block(w.launcher, false) + '\n');
  assert.equal(await read(path.join(claudeDir, 'skills', 'pi-on-the-side', 'SKILL.md')), HEAD + INSTRUCTIONS);
  assert.equal(await exists(w.claudeJson), false); assert.equal(await exists(path.join(w.home, '.codex')), false); assert.equal(await exists(path.join(w.home, '.claude')), false);
  await result.undo();
  assert.equal(JSON.stringify(await readDoc(path.join(claudeDir, '.claude.json'))).includes(SERVER_NAME), false, 'the Claude Code entry is removed again');
});

test('Claude Desktop that is not installed produces no item at all', async t => {
  const w = await world(t, { desktop: false });
  const result = await w.go();
  assert.equal(result.items.some(entry => entry.client === 'Claude Desktop'), false);
  assert.equal(result.needsYou.length, 0);
});

test('which finds Claude Code under the plain name claude and Codex by its program when no folder exists', async t => {
  const w = await world(t, { code: false, desktop: false, codex: false, codexExe: true });
  w.exes.claude = path.join(w.base, 'bin', 'claude');
  await fs.writeFile(w.exes.claude, 'fake');
  const result = await w.go();
  assert.equal(byClient(result, 'Claude Code').status, 'configured');
  assert.equal(byClient(result, CODEX).status, 'configured');
  assert.ok(await exists(w.codexFile));
  assert.equal(result.claudeCode.exe, w.exes.claude);
});

test('a second identical run changes nothing: no writes, no claude calls, no backups', async t => {
  const w = await world(t);
  await w.go();
  const calls = w.claude.calls.length, records = w.backup.records.size;
  await pause(30);
  const before = await w.state();
  const second = await w.go();
  assert.deepEqual(statuses(second), ['Claude Code/connection:already-configured', 'Claude Desktop/connection:already-configured',
    'Claude Code/instructions:already-configured', CODEX + '/connection:already-configured']);
  assert.deepEqual(second.needsYou, []);
  assert.equal(w.claude.calls.length, calls);
  assert.equal(w.backup.records.size, records);
  assert.deepEqual(await w.state(), before);
  assert.deepEqual(second.claudeCode, { exe: w.exes['claude.exe'] });
  assert.equal(second.owned.length, 3);
  assert.deepEqual(await second.undo(), { restored: 0, left: [] });
});

test('upgrade: older entries inside the install folder are replaced, everything else stays byte for byte', async t => {
  const w = await world(t);
  const backupFolder = path.join(w.base, 'private-backups');
  const files = [];
  w.backup = { file: async (name, bytes) => {
    await fs.mkdir(backupFolder, { recursive: true });
    const target = path.join(backupFolder, name);
    await fs.writeFile(target, bytes, { flag: 'wx' }); files.push(name);
    return target;
  } };
  const other = { type: 'stdio', command: 'other-server', args: ['--flag'], env: { API_KEY: 'secret-claude-key' } };
  await writeDoc(w.claudeJson, { numStartups: 3, mcpServers: { other, [SERVER_NAME]: w.ccEntry(w.oldLauncher, true) }, tail: true });
  const tomlBefore = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "z"\nenv = { SECRET = "secret-toml-value" }\n\n' +
    w.block(w.oldLauncher, false) + '\n\n[projects.x]\ntrust = "yes"\n';
  await writeText(w.codexFile, tomlBefore);
  const skillBefore = HEAD + 'Old instructions.\n';
  await writeText(w.skillFile, skillBefore);
  const desktopOther = { command: 'desktop-other', env: { TOKEN: 'secret-desktop-token' } };
  await writeDoc(w.desktopFile, { theme: 'dark', mcpServers: { other: desktopOther, [SERVER_NAME]: w.dEntry(w.oldLauncher, false) } });
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:updated', 'Claude Desktop/connection:updated',
    'Claude Code/instructions:updated', CODEX + '/connection:updated']);
  assert.deepEqual(w.claude.calls.map(c => c.args.slice(0, 2).join(' ')), ['mcp remove', 'mcp add']);
  assert.deepEqual(w.claude.calls[0].args, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
  assert.deepEqual(await readDoc(w.claudeJson), { numStartups: 3, mcpServers: { other, [SERVER_NAME]: w.ccEntry(w.launcher, true) }, tail: true });
  assert.equal(await read(w.codexFile), tomlBefore.replace(w.block(w.oldLauncher, false), w.block(w.launcher, false)));
  assert.equal(await read(w.skillFile), HEAD + INSTRUCTIONS);
  assert.deepEqual(await readDoc(w.desktopFile), { theme: 'dark', mcpServers: { other: desktopOther, [SERVER_NAME]: w.dEntry(w.launcher, false) } });
  // The backup folder holds only our previous part, never a foreign key.
  assert.deepEqual(files.sort(), ['claude-code-connection.json', 'claude-desktop-connection.json', 'claude-skill-instructions.json', 'codex-connection.json']);
  assert.deepEqual(await readDoc(path.join(backupFolder, 'claude-code-connection.json')),
    { file: w.claudeJson, existed: true, previous: w.ccEntry(w.oldLauncher, true) });
  assert.deepEqual(await readDoc(path.join(backupFolder, 'claude-desktop-connection.json')),
    { file: w.desktopFile, existed: true, previous: w.dEntry(w.oldLauncher, false) });
  assert.deepEqual(await readDoc(path.join(backupFolder, 'codex-connection.json')),
    { file: w.codexFile, existed: true, previous: w.block(w.oldLauncher, false) });
  assert.deepEqual(await readDoc(path.join(backupFolder, 'claude-skill-instructions.json')),
    { file: w.skillFile, existed: true, previous: skillBefore });
  for (const name of files) {
    const text = await read(path.join(backupFolder, name));
    for (const secret of ['secret-claude-key', 'secret-desktop-token', 'secret-toml-value', 'other-server', 'desktop-other', 'numStartups', 'theme', 'projects', 'model']) {
      assert.ok(!text.includes(secret), name + ' leaked ' + secret);
    }
  }
  // Undo puts back only our previous parts.
  const undo = await result.undo();
  assert.deepEqual(undo, { restored: 4, left: [] });
  assert.deepEqual(await readDoc(w.claudeJson), { numStartups: 3, mcpServers: { other, [SERVER_NAME]: w.ccEntry(w.oldLauncher, true) }, tail: true });
  assert.equal(await read(w.codexFile), tomlBefore);
  assert.equal(await read(w.skillFile), skillBefore);
  assert.deepEqual(w.claude.calls.map(c => c.args[1]), ['remove', 'add', 'remove', 'add']);
  assert.deepEqual(await readDoc(w.desktopFile), { theme: 'dark', mcpServers: { other: desktopOther, [SERVER_NAME]: w.dEntry(w.oldLauncher, false) } });
  assert.deepEqual(await result.undo(), { restored: 0, left: [] });
  assert.equal(w.claude.calls.length, 4);
});

test('foreign entries and files are left untouched and reported as needing the user', async t => {
  const w = await world(t);
  await writeDoc(w.claudeJson, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'someone-elses-node', args: [path.join(w.base, 'else', 'x.mjs')] } } });
  await writeText(w.codexFile, '[mcp_servers.omp-session-bridge]\ncommand = "mine"\n');
  await writeText(w.skillFile, '# my own skill\n');
  await writeDoc(w.desktopFile, { mcpServers: { [SERVER_NAME]: { command: 'someone-elses-node', args: [path.join(w.base, 'else', 'y.mjs')] } } });
  const before = await w.state();
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:needs-you', 'Claude Desktop/connection:needs-you',
    'Claude Code/instructions:needs-you', CODEX + '/connection:needs-you']);
  assert.deepEqual(result.needsYou.map(entry => entry.client), ['Claude Code', 'Claude Desktop', 'Claude Code', CODEX, 'Pi on the Side']);
  assert.deepEqual(result.needsYou.map(entry => entry.action), ['connect-again', 'connect-again', 'connect-again', 'connect-again', 'connect-again']);
  for (const entry of result.needsYou) { assert.ok(entry.message && entry.fix); assert.ok(!/at .*\.mjs:\d+/.test(entry.message)); }
  assert.match(result.needsYou[0].fix, /Close Claude Code, delete the old omp-session-bridge entry, then run pots install again\./);
  assert.deepEqual(await w.state(), before);
  assert.deepEqual(w.claude.calls, []);
  assert.equal(w.backup.records.size, 0);
  assert.equal(result.claudeCode, null);
  assert.deepEqual(result.owned, []);
});

for (const [name, text] of [
  ['plain table', '[mcp_servers.omp-session-bridge]\ncommand = "x"\n'],
  ['quoted table', '[mcp_servers."omp-session-bridge"]\ncommand = "x"\n'],
  ['table with spaces and literal quote', "[ mcp_servers . 'omp-session-bridge' . env ]\nA = \"b\"\n"],
  ['key inside mcp_servers', '[mcp_servers]\nomp-session-bridge = { command = "x" }\n'],
  ['dotted key', 'mcp_servers.omp-session-bridge.command = "x"\n'],
  ['inline table', 'mcp_servers = { omp-session-bridge = { command = "x" } }\n'],
  ['inline table of other servers', 'mcp_servers = { other = { command = "x" } }\n']
]) {
  test('Codex settings with a foreign ' + name + ' are not touched', async t => {
    const w = await world(t, { code: false, desktop: false });
    await writeText(w.codexFile, text);
    const result = await w.go({ clients: 'chatgpt' });
    assert.equal(byClient(result, CODEX).status, 'needs-you');
    assert.equal(result.needsYou.length, 1);
    assert.equal(result.needsYou[0].action, 'connect-again');
    assert.equal(await read(w.codexFile), text);
    assert.equal(w.backup.records.size, 0);
  });
}

test('Codex settings: commented or quoted look-alikes do not count as a foreign entry', async t => {
  const w = await world(t, { code: false, desktop: false });
  const text = '# [mcp_servers.omp-session-bridge]\nnote = """\n[mcp_servers.omp-session-bridge]\n"""\nlist = [\n  ["a"],\n]\n';
  await writeText(w.codexFile, text);
  const result = await w.go({ clients: 'chatgpt' });
  assert.equal(byClient(result, CODEX).status, 'configured');
  assert.equal(await read(w.codexFile), text + '\n' + w.block(w.launcher, true) + '\n');
});

test('unreadable files are left untouched: invalid JSON and damaged or unparsable Codex settings', async t => {
  const w = await world(t);
  await writeText(w.claudeJson, '{ not json');
  await writeText(w.desktopFile, '{ not json');
  await writeText(w.codexFile, 'a = 1\n' + BEGIN + '\n[mcp_servers.omp-session-bridge]\n');
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:needs-you', 'Claude Desktop/connection:left-as-is',
    'Claude Code/instructions:configured', CODEX + '/connection:left-as-is']);
  assert.deepEqual(result.needsYou.map(entry => entry.client), ['Claude Code'], 'Claude Code cannot be read, so the others are not touched');
  assert.equal(await read(w.desktopFile), '{ not json');
  assert.equal(await read(w.claudeJson), '{ not json');
  assert.equal(await read(w.codexFile), 'a = 1\n' + BEGIN + '\n[mcp_servers.omp-session-bridge]\n');
  assert.deepEqual(w.claude.calls, []);
  assert.equal(result.claudeCode, null);
  for (const damaged of [
    BEGIN + '\n' + BEGIN + '\n' + END + '\n',
    END + '\n' + BEGIN + '\n',
    BEGIN + '\n' + END + '\n' + BEGIN + '\n' + END + '\n',
    'a = "unterminated\n'
  ]) {
    const v = await world(t, { code: false, desktop: false });
    await writeText(v.codexFile, damaged);
    const outcome = await v.go({ clients: 'chatgpt' });
    assert.equal(byClient(outcome, CODEX).status, 'needs-you');
    assert.equal(await read(v.codexFile), damaged);
  }
});

test('nothing installed: every assistant is reported as not installed and nothing is created', async t => {
  const w = await world(t, { code: false, desktop: false, codex: false });
  const before = await w.state();
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:not-installed', CODEX + '/connection:not-installed']);
  assert.match(byClient(result, 'Claude Code').message, /was not found on this computer; install it, then run pots install again to connect it\./);
  assert.deepEqual(result.needsYou.map(entry => entry.client), ['Claude', CODEX]);
  assert.deepEqual(result.needsYou.map(entry => entry.action), ['connect-again', 'connect-again']);
  assert.match(result.needsYou[0].fix, /^Install Claude Code or Claude Desktop, then run pots install again\.$/);
  assert.deepEqual(await w.state(), before);
  assert.equal(w.backup.records.size, 0);
  assert.equal(result.claudeCode, null);
  assert.deepEqual(result.owned, []);
});

test('selection limits what is touched and a missing client is informational when another one of the selection is present', async t => {
  const w = await world(t, { code: false, desktop: false, codex: true });
  const both = await w.go();
  assert.deepEqual(statuses(both), ['Claude Code/connection:not-installed', CODEX + '/connection:configured']);
  assert.deepEqual(both.needsYou, []);
  assert.equal(await read(w.codexFile), w.block(w.launcher, true) + '\n');
  const x = await world(t);
  const onlyChat = await x.go({ clients: 'chatgpt' });
  assert.deepEqual(statuses(onlyChat), [CODEX + '/connection:configured']);
  assert.deepEqual(onlyChat.needsYou, []);
  assert.ok(!await exists(x.claudeJson) && !await exists(x.skillFile));
  const y = await world(t);
  const onlyClaude = await y.go({ clients: 'claude' });
  assert.deepEqual(statuses(onlyClaude), ['Claude Code/connection:configured', 'Claude Desktop/connection:configured', 'Claude Code/instructions:configured']);
  assert.ok(!await exists(y.codexFile));
  assert.deepEqual(await credentialHolders(y), ['code']);
  const z = await world(t, { code: false, desktop: true, codex: false });
  const onlyDesktop = await z.go({ clients: 'claude' });
  assert.deepEqual(statuses(onlyDesktop), ['Claude Code/connection:not-installed', 'Claude Desktop/connection:configured']);
  assert.deepEqual(onlyDesktop.needsYou, []);
  assert.deepEqual(await credentialHolders(z), ['desktop'], 'with no Claude Code and no Codex, Claude Desktop directs');
});

test('the credential goes to exactly one assistant, the first present of Claude Code and Codex', async t => {
  for (const combo of ['111', '110', '101', '100', '011', '010', '001', '000']) {
    const w = await world(t, { code: combo[0] === '1', desktop: combo[1] === '1', codex: combo[2] === '1' });
    const result = await w.go();
    const holder = combo[0] === '1' ? 'code' : combo[2] === '1' ? 'codex' : combo[1] === '1' ? 'desktop' : null;
    assert.deepEqual(await credentialHolders(w), holder ? [holder] : [], 'presence ' + combo);
    for (const entry of result.items.filter(i => i.status === 'configured' && i.what === 'connection')) {
      const reader = /read-only viewer/.test(entry.message);
      assert.equal(!reader, { code: 'Claude Code', codex: CODEX, desktop: 'Claude Desktop' }[holder] === entry.client, 'role text ' + combo + ' ' + entry.client);
    }
  }
});

test('a failing claude command is reported as failed, its half-made entry is taken back at once, and undo restores the rest', async t => {
  const w = await world(t);
  const claudeBefore = { numStartups: 1, mcpServers: { other: { type: 'stdio', command: 'o', args: [], env: {} } } };
  await writeDoc(w.claudeJson, claudeBefore);
  await writeText(w.codexFile, 'a = 1');
  const desktopDoc = await readDoc(w.desktopFile);
  w.claude = fakeClaude(w, { failAdd: 'after-write' });
  const result = await w.go();
  assert.equal(byClient(result, 'Claude Code').status, 'failed');
  assert.match(byClient(result, 'Claude Code').message, /^Setup could not finish connecting Claude Code, so the change was not kept\.$/);
  assert.equal(byClient(result, CODEX).status, 'configured', 'one failure does not stop the others');
  assert.equal(result.claudeCode, null);
  assert.deepEqual(await readDoc(w.claudeJson), claudeBefore, 'the entry the failed command wrote is already gone; the user\'s own entry stays');
  assert.match(result.needsYou.find(row => row.client === 'Claude Code').fix, /^Close Claude Code and run pots install again\./);
  const undo = await result.undo();
  assert.equal(undo.left.length, 0);
  assert.equal(undo.restored, 3);
  assert.deepEqual(w.claude.calls.map(c => c.args[1]), ['add', 'remove']);
  assert.deepEqual(await readDoc(w.claudeJson), claudeBefore);
  assert.equal(await read(w.codexFile), 'a = 1');
  assert.ok(!await exists(w.skillFile));
  assert.ok(!await exists(path.dirname(w.skillFile)) && !await exists(path.join(w.home, '.claude', 'skills')));
  assert.ok(await exists(path.join(w.home, '.claude')));
  assert.deepEqual(await readDoc(w.desktopFile), desktopDoc);
  assert.deepEqual(await result.undo(), { restored: 0, left: [] });
  assert.equal(w.claude.calls.length, 2);
});

test('a claude command that fails without writing leaves nothing to remove', async t => {
  const w = await world(t, { desktop: false, codex: false });
  w.claude = fakeClaude(w, { failAdd: 'before-write' });
  const result = await w.go();
  assert.equal(byClient(result, 'Claude Code').status, 'failed');
  assert.ok(!await exists(w.claudeJson));
  await result.undo();
  assert.deepEqual(w.claude.calls.map(c => c.args[1]), ['add']);
  assert.ok(!await exists(w.skillFile));
});

test('undo after a first install removes what was created and keeps changes made meanwhile', async t => {
  const w = await world(t);
  await writeText(w.codexFile, 'a = 1\n');
  const result = await w.go();
  // The user keeps working: adds a Codex table.
  await fs.appendFile(w.codexFile, '[x]\nz = 1\n');
  const undo = await result.undo();
  assert.equal(undo.left.length, 0);
  assert.equal(await read(w.codexFile), 'a = 1\n\n[x]\nz = 1\n');
  assert.ok(!await exists(w.skillFile));
  assert.equal((await readDoc(w.claudeJson)).mcpServers[SERVER_NAME], undefined);
});

test('Claude Desktop: the entry is made in its own settings file, undo deletes a file Setup created and keeps the rest of a file it did not', async t => {
  const w = await world(t, { desktop: false });
  await fs.mkdir(w.desktopFolder, { recursive: true });
  const created = await w.go();
  assert.deepEqual(await readDoc(w.desktopFile), { mcpServers: { [SERVER_NAME]: w.dEntry(w.launcher, false) } });
  assert.equal((await created.undo()).left.length, 0);
  assert.ok(!await exists(w.desktopFile));
  const x = await world(t);
  const before = await readDoc(x.desktopFile);
  const second = await x.go();
  assert.equal(byClient(second, 'Claude Desktop').status, 'configured');
  await second.undo();
  assert.deepEqual(await readDoc(x.desktopFile), before);
});

test('undo deletes files it created and leaves a file somebody changed', async t => {
  const w = await world(t, { code: false, desktop: false, claudeFolder: true });
  const result = await w.go();
  assert.ok(await exists(w.codexFile) && await exists(w.skillFile));
  await fs.appendFile(w.skillFile, 'my own notes\n');
  const undo = await result.undo();
  assert.equal(undo.left.length, 1);
  assert.match(undo.left[0], /was changed after Setup wrote it, so Setup left it as it is\.$/);
  assert.ok((await read(w.skillFile)).endsWith('my own notes\n'));
  assert.ok(!await exists(w.codexFile));
  assert.ok(await exists(path.join(w.home, '.codex')));
  const fresh = await world(t, { code: false, desktop: false, claudeFolder: false });
  const created = await fresh.go();
  assert.ok(await exists(fresh.codexFile));
  assert.equal((await created.undo()).restored, 1);
  assert.ok(!await exists(fresh.codexFile));
});

test('nothing is changed when the backup record cannot be saved', async t => {
  const w = await world(t);
  await writeText(w.codexFile, 'a = 1\n');
  w.backup = fakeBackup({ fail: true });
  const before = await w.state();
  const result = await w.go();
  assert.deepEqual(statuses(result), ['Claude Code/connection:failed', 'Claude Desktop/connection:failed',
    'Claude Code/instructions:failed', CODEX + '/connection:failed']);
  assert.deepEqual(await w.state(), before);
  assert.deepEqual(w.claude.calls, []);
  assert.deepEqual(result.owned, []);
});

test('Codex settings keep their CRLF line endings when a block is added and when it is replaced', async t => {
  const w = await world(t, { code: false, desktop: false });
  const original = 'model = "x"\r\n[a]\r\nb = 1\r\n';
  await writeText(w.codexFile, original);
  await w.go({ clients: 'chatgpt' });
  const added = await read(w.codexFile);
  assert.ok(added.startsWith(original));
  assert.equal(added, original + '\r\n' + w.block(w.launcher, true).replace(/\n/g, '\r\n') + '\r\n');
  assert.ok(!/(^|[^\r])\n/.test(added));
  const other = path.join(w.installRoot, 'credentials', 'other.json');
  w.backup = fakeBackup(); // a new run gets a new private backup folder
  const second = await w.go({ clients: 'chatgpt', credentialFile: other });
  assert.equal(byClient(second, CODEX).status, 'updated');
  const replaced = await read(w.codexFile);
  assert.equal(replaced, original + '\r\n' + w.block(w.launcher, true, other).replace(/\n/g, '\r\n') + '\r\n');
  assert.ok(!/(^|[^\r])\n/.test(replaced));
});

test('an unrelated user table after our block survives replacement', async t => {
  const w = await world(t, { code: false, desktop: false });
  const tomlBefore = w.block(w.oldLauncher, true) + '\n\n[projects.keep]\ntrust = "yes"\n# trailing note';
  await writeText(w.codexFile, tomlBefore);
  const result = await w.go({ clients: 'chatgpt' });
  assert.equal(byClient(result, CODEX).status, 'updated');
  assert.equal(await read(w.codexFile), w.block(w.launcher, true) + '\n\n[projects.keep]\ntrust = "yes"\n# trailing note');
  assert.deepEqual(w.backup.records.get('codex-connection.json'), { file: w.codexFile, existed: true, previous: w.block(w.oldLauncher, true) });
  await result.undo();
  assert.equal(await read(w.codexFile), tomlBefore);
});

test('TOML strings escape backslashes, quotes and control characters', async t => {
  const w = await world(t, { code: false, desktop: false });
  const launcher = path.join(w.installRoot, 'a"b\tc.mjs');
  await w.go({ clients: 'chatgpt', mcpLauncher: launcher });
  const text = await read(w.codexFile);
  assert.ok(text.includes('args = [' + q(launcher) + ', "mcp"]'));
  assert.ok(text.includes('\\"b\\tc.mjs'));
});

test('invalid options are rejected before anything is read or written', async t => {
  const w = await world(t);
  await assert.rejects(w.go({ clients: 'muse' }), /invalid assistant setup options/);
  await assert.rejects(w.go({ credentialFile: 'relative.json' }), /invalid assistant setup options/);
  await assert.rejects(w.go({ backup: undefined }), /invalid assistant setup options/);
  assert.deepEqual(w.claude.calls, []);
  assert.ok(!await exists(w.claudeJson));
});

// Each real run writes its copies into a new backup folder, so a later run gets a new sink.
const again = (w, over) => { w.backup = fakeBackup(); return w.go(over); };

// Write access follows the directing assistant: a later run with another client choice must not leave it with two.
test('choosing another client later moves the write credential: the earlier director keeps its connection as a read-only viewer', async t => {
  const w = await world(t, { desktop: false });
  await w.go();
  assert.deepEqual(await credentialHolders(w), ['code']);
  const second = await again(w, { clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex'], 'exactly one holder after the change');
  assert.deepEqual(await readDoc(w.claudeJson), { mcpServers: { [SERVER_NAME]: w.ccEntry(w.launcher, false) } }, 'Claude Code stays connected, read-only');
  assert.equal(await read(w.codexFile), w.block(w.launcher, true) + '\n');
  assert.equal(byClient(second, 'Claude Code').status, 'updated');
  assert.match(byClient(second, 'Claude Code').message, /read-only viewer.*because ChatGPT desktop app \(Codex\) directs now/);
  assert.deepEqual(second.needsYou, []);
  assert.deepEqual(second.claudeCode, { exe: w.exes['claude.exe'] }, 'the changed Claude Code registration is reported so it can be tracked again');
  assert.deepEqual(w.backup.records.get('claude-code-connection.json'), { file: w.claudeJson, existed: true, previous: w.ccEntry(w.launcher, true) });
  // and back again
  const third = await again(w, { clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), ['code']);
  assert.equal(await read(w.codexFile), w.block(w.launcher, false) + '\n');
  assert.equal(byClient(third, CODEX).status, 'updated');
  assert.match(byClient(third, CODEX).message, /read-only viewer.*because Claude Code directs now/);
});

test('the earlier director is changed only when it is exactly what Setup wrote; anything else is kept and listed', async t => {
  const w = await world(t, { desktop: false });
  await w.go();
  const edited = await readDoc(w.claudeJson);
  edited.mcpServers[SERVER_NAME].env.EXTRA_SETTING = 'kept';
  await writeDoc(w.claudeJson, edited);
  const claudeBefore = await read(w.claudeJson), calls = w.claude.calls.length;
  const result = await again(w, { clients: 'chatgpt' });
  assert.equal(await read(w.claudeJson), claudeBefore, 'the edited Claude Code entry is untouched');
  assert.equal(w.claude.calls.length, calls, 'no claude command was run');
  assert.deepEqual((await credentialHolders(w)).sort(), ['code', 'codex'], 'both still hold it, and that is said plainly');
  const row = result.items.find(entry => entry.client === 'Claude Code' && entry.status === 'needs-you');
  assert.match(row.message, /still has write access to Pi on the Side from an earlier setup, but ChatGPT desktop app \(Codex\) directs now.*not exactly what Setup wrote/);
  assert.equal(row.file, w.claudeJson);
  assert.equal(result.needsYou.length, 1);
  assert.match(result.needsYou[0].fix, /Remove the OMP_BRIDGE_CONTROLLER setting from the omp-session-bridge connection in Claude Code/);

  const x = await world(t, { desktop: false });
  await x.go({ clients: 'chatgpt' });
  const text = (await read(x.codexFile)).replace('default_tools_approval_mode = "writes"', 'default_tools_approval_mode = "never"');
  await writeText(x.codexFile, text);
  const codexResult = await again(x, { clients: 'claude' });
  assert.equal(await read(x.codexFile), text, 'the edited Codex block is untouched');
  assert.deepEqual((await credentialHolders(x)).sort(), ['code', 'codex']);
  assert.match(codexResult.items.find(entry => entry.client === CODEX && entry.status === 'needs-you').message, /still has write access.*Claude Code directs now/);
  assert.equal(codexResult.needsYou.length, 1);
});

test('a registration that never held this install\'s credential is left alone when another client directs', async t => {
  const w = await world(t, { desktop: false });
  await w.go({ clients: 'claude' });
  const entry = await readDoc(w.claudeJson);
  entry.mcpServers[SERVER_NAME].env.OMP_BRIDGE_CONTROLLER = path.join(w.base, 'other-install', 'controller.json');
  await writeDoc(w.claudeJson, entry);
  const before = await read(w.claudeJson), calls = w.claude.calls.length;
  const result = await again(w, { clients: 'chatgpt' });
  assert.equal(await read(w.claudeJson), before);
  assert.equal(w.claude.calls.length, calls);
  assert.equal(result.items.some(row => row.client === 'Claude Code'), false);
  assert.deepEqual(result.needsYou, []);
});

test('write access is never taken from the earlier director while the new director could not be connected', async t => {
  const w = await world(t, { desktop: false });
  await w.go();
  await writeText(w.codexFile, '[mcp_servers.omp-session-bridge]\ncommand = "someone-elses"\n');
  const claudeBefore = await read(w.claudeJson), calls = w.claude.calls.length;
  const result = await again(w, { clients: 'chatgpt' });
  assert.equal(byClient(result, CODEX).status, 'needs-you');
  assert.equal(await read(w.claudeJson), claudeBefore, 'Claude Code keeps the only write access there is');
  assert.equal(w.claude.calls.length, calls);
  assert.deepEqual(await credentialHolders(w), ['code']);
});

test('an earlier director that cannot be changed because its program is gone is listed, not guessed at', async t => {
  const w = await world(t, { desktop: false });
  await w.go();
  delete w.exes['claude.exe'];
  const claudeBefore = await read(w.claudeJson), calls = w.claude.calls.length;
  const result = await again(w, { clients: 'chatgpt' });
  assert.equal(await read(w.claudeJson), claudeBefore);
  assert.equal(w.claude.calls.length, calls);
  assert.match(result.items.find(entry => entry.client === 'Claude Code' && entry.status === 'needs-you').message, /Claude Code was not found on this computer, so Setup cannot change it/);
  assert.deepEqual((await credentialHolders(w)).sort(), ['code', 'codex']);
});

test('Claude Desktop does not keep write access when a later run connects only ChatGPT; an edited Desktop entry is kept and listed', async t => {
  const w = await world(t, { code: false, desktop: true, codex: false });
  await w.go({ clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), ['desktop']);
  await fs.mkdir(path.join(w.home, '.codex'), { recursive: true });
  const result = await again(w, { clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex'], 'exactly one holder after the change');
  assert.deepEqual((await readDoc(w.desktopFile)).mcpServers[SERVER_NAME], w.dEntry(w.launcher, false), 'Claude Desktop stays connected, read-only');
  assert.match(byClient(result, 'Claude Desktop').message, /read-only viewer.*because ChatGPT desktop app \(Codex\) directs now/);

  const x = await world(t, { code: false, desktop: true, codex: false });
  await x.go({ clients: 'claude' });
  const edited = await readDoc(x.desktopFile);
  edited.mcpServers[SERVER_NAME].env.EXTRA_SETTING = 'kept';
  await writeDoc(x.desktopFile, edited);
  const desktopBefore = await read(x.desktopFile);
  await fs.mkdir(path.join(x.home, '.codex'), { recursive: true });
  const kept = await again(x, { clients: 'chatgpt' });
  assert.equal(await read(x.desktopFile), desktopBefore);
  assert.deepEqual((await credentialHolders(x)).sort(), ['codex', 'desktop']);
  assert.match(byClient(kept, 'Claude Desktop').message, /still has write access.*ChatGPT desktop app \(Codex\) directs now.*not exactly what Setup wrote/);
});

test('Codex does not keep write access when a later run connects only Claude and Claude Desktop is the director; an edited Codex block is kept and listed', async t => {
  const w = await world(t, { code: false, desktop: true, codex: true });
  await w.go({ clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex']);
  const result = await again(w, { clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), ['desktop'], 'exactly one holder after the change');
  assert.equal(await read(w.codexFile), w.block(w.launcher, false) + '\n', 'Codex stays connected, read-only');
  assert.match(byClient(result, CODEX).message, /read-only viewer.*because Claude Desktop directs now/);

  const x = await world(t, { code: false, desktop: true, codex: true });
  await x.go({ clients: 'chatgpt' });
  const text = (await read(x.codexFile)).replace('default_tools_approval_mode = "writes"', 'default_tools_approval_mode = "never"');
  await writeText(x.codexFile, text);
  const kept = await again(x, { clients: 'claude' });
  assert.equal(await read(x.codexFile), text, 'the edited Codex block is untouched');
  assert.deepEqual((await credentialHolders(x)).sort(), ['codex', 'desktop']);
  assert.match(kept.items.find(row => row.client === CODEX && row.status === 'needs-you').message, /still has write access.*Claude Desktop directs now/);
});

test('Codex is reported as still holding write access when its settings could not be changed in the run that gives Claude Code the write access', async t => {
  const w = await world(t, { desktop: false });
  await w.go({ clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex']);
  const damaged = (await read(w.codexFile)) + '\n[mcp_servers.' + SERVER_NAME + '.extra]\nkeep = 1\n';
  await writeText(w.codexFile, damaged);
  const result = await again(w);
  assert.equal(await read(w.codexFile), damaged, 'the Codex settings are untouched');
  assert.deepEqual((await credentialHolders(w)).sort(), ['code', 'codex']);
  assert.ok(result.items.some(row => row.client === CODEX && row.status === 'needs-you' && /still has write access.*Claude Code directs now/.test(row.message)));
  assert.ok(result.needsYou.some(row => row.client === CODEX && /Remove the OMP_BRIDGE_CONTROLLER setting/.test(row.fix)));
});

test('undo after the write access moved puts the earlier director back exactly as it was', async t => {
  const w = await world(t, { desktop: false });
  await w.go();
  const before = { claude: await readDoc(w.claudeJson), codex: await read(w.codexFile) };
  const result = await again(w, { clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex']);
  const report = await result.undo();
  assert.deepEqual(report.left, []);
  assert.deepEqual(await readDoc(w.claudeJson), before.claude);
  assert.equal(await read(w.codexFile), before.codex);
  assert.deepEqual(await credentialHolders(w), ['code']);
});

test('write access is also kept when Claude Code is chosen but cannot be connected: the ChatGPT registration keeps the only credential', async t => {
  const w = await world(t, { desktop: false });
  await w.go({ clients: 'chatgpt' });
  assert.deepEqual(await credentialHolders(w), ['codex']);
  await writeDoc(w.claudeJson, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'someone-elses-node', args: [path.join(w.base, 'else', 'x.mjs')] } } });
  const codexBefore = await read(w.codexFile);
  const result = await again(w, { clients: 'claude' });
  assert.equal(byClient(result, 'Claude Code').status, 'needs-you');
  assert.equal(await read(w.codexFile), codexBefore, 'the ChatGPT registration was not touched');
  assert.deepEqual(await credentialHolders(w), ['codex']);
});

test('Claude Desktop keeps the write access when Claude Code is installed later but cannot be connected', async t => {
  const w = await world(t, { code: false, desktop: true, codex: false });
  await w.go({ clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), ['desktop']);
  w.exes['claude.exe'] = path.join(w.base, 'bin', 'claude.exe');
  await fs.writeFile(w.exes['claude.exe'], 'fake');
  await writeText(w.claudeJson, '{ not json');
  const desktopBefore = await read(w.desktopFile);
  const result = await again(w, { clients: 'claude' });
  assert.equal(byClient(result, 'Claude Code').status, 'needs-you');
  assert.equal(await read(w.desktopFile), desktopBefore, 'Claude Desktop is left exactly as it was');
  assert.deepEqual(await credentialHolders(w), ['desktop']);
  assert.match(byClient(result, 'Claude Desktop').message, /left as it is.*Claude Code could not be connected/);
});

test('when Claude Code cannot be read, an assistant that has no entry yet is told "not connected this time", not "left as it is"', async t => {
  const w = await world(t);
  await writeText(w.claudeJson, '{ not json');
  const desktopBefore = await read(w.desktopFile);
  const result = await w.go();
  for (const client of ['Claude Desktop', CODEX]) assert.match(byClient(result, client).message, /was not connected this time, because Claude Code could not be connected/);
  assert.equal(await read(w.desktopFile), desktopBefore, 'Claude Desktop settings are untouched');
  await assert.rejects(fs.stat(w.codexFile), { code: 'ENOENT' });
});

test('Claude Desktop takes the write access when Claude Code cannot be connected and is known not to hold it', async t => {
  const w = await world(t, { code: false, desktop: true, codex: false });
  w.exes['claude.exe'] = path.join(w.base, 'bin', 'claude.exe');
  await fs.writeFile(w.exes['claude.exe'], 'fake');
  await writeDoc(w.claudeJson, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'someone-elses-node', args: [path.join(w.base, 'else', 'x.mjs')] } } });
  const result = await w.go({ clients: 'claude' });
  assert.equal(byClient(result, 'Claude Code').status, 'needs-you');
  assert.deepEqual(await credentialHolders(w), ['desktop']);
});

test('a Claude Code entry left by another install folder does not make the newly connected assistant read-only', async t => {
  const w = await world(t, { code: false, desktop: true, codex: false });
  w.exes['claude.exe'] = path.join(w.base, 'bin', 'claude.exe');
  await fs.writeFile(w.exes['claude.exe'], 'fake');
  const stale = { type: 'stdio', command: 'someone-elses-node', args: [path.join(w.base, 'else', 'x.mjs')], env: { OMP_BRIDGE_CONTROLLER: path.join(w.base, 'else', 'controller.json') } };
  await writeDoc(w.claudeJson, { mcpServers: { [SERVER_NAME]: stale } });
  await w.go({ clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), ['desktop'], 'the credential of this install goes to the assistant that was just connected');
  assert.deepEqual((await readDoc(w.claudeJson)).mcpServers[SERVER_NAME], stale, 'the other entry is left as it was');
});

test('the install says so when no assistant could be connected, and nothing is given write access', async t => {
  const w = await world(t, { desktop: false, codex: false });
  await writeDoc(w.claudeJson, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'someone-elses-node', args: [path.join(w.base, 'else', 'x.mjs')] } } });
  const result = await w.go({ clients: 'claude' });
  assert.deepEqual(await credentialHolders(w), []);
  assert.ok(result.needsYou.some(row => /No assistant could be connected this time.*already had it keeps it/.test(row.message)));
});

test('removing the scheduled task is reported only when Windows confirmed it: a failed query is not "absent"', async () => {
  const mark = 'Pi on the Side resume watchdog X', name = 'PiOnTheSide-X-Resume', tasks = answer => windowsTasks({ run: async args => answer(args) });
  await assert.rejects(tasks(() => ({ code: 1, stdout: '' })).remove(name, mark), /state unknown/, 'Task Scheduler cannot be asked at all');
  assert.equal(await tasks(args => args.includes('/XML') ? { code: 1, stdout: '' } : { code: 0, stdout: '"\\Other","N/A","Ready"\r\n' }).remove(name, mark), 'absent', 'a working task list without the task proves it is gone');
  await assert.rejects(tasks(args => args.includes('/XML') ? { code: 1, stdout: '' } : { code: 0, stdout: `"\\${name}","N/A","Ready"\r\n` }).remove(name, mark), /state unknown/, 'listed but cannot be read: not proven gone');
  const refused = tasks(args => args.includes('/XML') ? { code: 0, stdout: '<Description>' + mark + '</Description>' } : { code: args.includes('/Delete') ? 1 : 0, stdout: '' });
  await assert.rejects(refused.remove(name, mark), /not removed/);
  assert.equal(await tasks(args => ({ code: 0, stdout: args.includes('/XML') ? '<Description>' + mark + '</Description>' : '' })).remove(name, mark), 'removed');
});
