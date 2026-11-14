import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { plain } from './control.mjs';
import { execFile } from 'node:child_process';

// Connects the assistant apps on this computer to the Pi on the Side MCP server so
// that running the installer is the only configuration step. Every external file
// is backed up before it changes, nothing is overwritten unless it is provably
// ours, and undo() reverses exactly what one configureAssistants() call did.
// All locations and programs are injected (home, env, which, run); nothing here
// reads the real home folder, registry or network by itself.

export const SERVER_NAME = 'omp-session-bridge';

const BEGIN = '# BEGIN Pi on the Side (omp-session-bridge): written by its installer; a backup is kept in the install folder';
const END = '# END Pi on the Side (omp-session-bridge)';
const SKILL_MARK = '<!-- managed by the Pi on the Side installer; replaced on upgrade -->';
const SKILL_HEAD = '---\nname: pi-on-the-side\ndescription: "Coordinate Pi on the Side lanes: send approved tasks to OMP sessions, check progress and wake-ups, review results."\n---\n' + SKILL_MARK + '\n';
export const MAX_BYTES = 16 * 1024 * 1024;

const CC = 'Claude Code';
const CD = 'Claude Desktop';
const CX = 'ChatGPT desktop app (Codex)';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};
const isAbsolutePath = value => typeof value === 'string' && path.isAbsolute(value);
// Where Claude Code and Codex keep their settings: the folder variables they read themselves win over the home folder.
const fromEnv = (env, key) => isAbsolutePath(env?.[key]) ? env[key] : null;
export const claudeLocations = ({ home, env }) => { const dir = fromEnv(env, 'CLAUDE_CONFIG_DIR'); return { folder: dir ?? path.join(home, '.claude'), json: path.join(dir ?? home, '.claude.json') }; };
const codexHome = ({ home, env }) => fromEnv(env, 'CODEX_HOME') ?? path.join(home, '.codex');
const role = director => director
  ? 'the directing assistant, which can send and cancel tasks'
  : 'a read-only viewer, which cannot send or cancel tasks';

// ---------------------------------------------------------------- file helpers

async function readBytes(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await plain(file);
  if (stat.size > MAX_BYTES) throw new Error('file too large');
  return fs.readFile(file);
}

async function dirState(dir) {
  try { await plain(dir, true); return 'dir'; } catch (error) { return error.code === 'ENOENT' ? 'absent' : 'bad'; }
}

const SHARING = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function rename(from, to) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { return await fs.rename(from, to); } catch (error) {
      if (process.platform !== 'win32' || !SHARING.has(error.code) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

// Temp file in the same folder, flushed, then renamed: readers see the old or
// the new file, never half of one. Links are refused for the file and its folders.
async function atomicWrite(file, bytes) {
  await plain(path.dirname(file), true);
  let mode = 0o600;
  try { mode = (await plain(file)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(tmp, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(tmp, file); } catch (error) { await fs.unlink(tmp).catch(() => {}); throw error; }
}

async function ensureDir(ctx, dir) {
  const missing = [];
  for (let current = dir;;) {
    try { await plain(current, true); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const created of missing.reverse()) {
    await fs.mkdir(created);
    ctx.actions.push({ type: 'dir', dir: created });
    await plain(created, true);
  }
}

// Backup record: ONLY the part this installer owns (our previous entry, block or
// instruction text), never a copy of the external file, which may hold other
// programs' secrets. The caller's sink stores it privately and refuses to
// overwrite, so each name is used at most once per call.
async function backup(ctx, name, record) {
  const bytes = Buffer.from(JSON.stringify({ file: record.file, existed: record.existed, previous: record.previous ?? null }, null, 2) + '\n');
  await ctx.options.backup.file(name + '.json', bytes);
}

// Order: backup record of our previous part, folders, atomic replace, and only
// then the undo record (so undo only ever reverses writes that happened).
async function changeFile(ctx, name, file, record, bytes, action) {
  await backup(ctx, name, { file, ...record });
  await ensureDir(ctx, path.dirname(file));
  await atomicWrite(file, bytes);
  ctx.actions.push({ ...action, file });
}

function parseJson(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('not utf-8');
  const value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  if (!isObject(value)) throw new Error('not an object');
  return { value };
}

// ------------------------------------------------------------------ item output

function item(ctx, client, what, status, message, file) {
  const entry = { client, what, status, message };
  if (file) entry.file = file;
  ctx.items.push(entry);
}
function blocked(ctx, client, what, message, fix, file) {
  item(ctx, client, what, 'needs-you', message, file);
  ctx.needsYou.push({ client, message, fix, action: 'connect-again' });
}
const unreadable = (ctx, client, what, file) => blocked(ctx, client, what,
  'Setup could not safely read ' + file + ' as it is now, so it left that file untouched.',
  'Open that file, repair or remove the damaged part (or restore it from a backup), then run pots install again.', file);
const foreignEntry = (ctx, client, file) => blocked(ctx, client, 'connection',
  client + ' already has a different connection named ' + SERVER_NAME + ' that Setup did not create, so Setup left it alone.',
  'Close ' + client + ', delete the old ' + SERVER_NAME + ' entry, then run pots install again.', file);
// The install goes on without this one connection; the person is told which one and what to do.
const failedItem = (ctx, client, what, file, left = []) => {
  const message = 'Setup could not finish connecting ' + client + ', so the change was not kept.' + (left.length ? ' ' + left.join(' ') : '');
  item(ctx, client, what, 'failed', message, file);
  ctx.needsYou.push({ client, message, fix: 'Close ' + client + ' and run pots install again. Pi on the Side itself is installed and works; only this connection is missing.', action: 'connect-again' });
};

function registered(ctx, client, status, director, file) {
  const message = (status === 'configured' ? client + ' is now connected to Pi on the Side as ' + role(director) + '.'
    : status === 'updated' && ctx.releasing ? client + ' is now ' + role(director) + ', because ' + ctx.releasing + ' directs now.'
    : status === 'updated' ? 'The older Pi on the Side connection in ' + client + ' was updated to this version, and it is ' + role(director) + '.'
      : client + ' was already connected to Pi on the Side as ' + role(director) + ', so nothing was changed.')
    + (client === CD && status !== 'already-configured' ? ' Claude Desktop reads its connections when it starts, so the connection shows up the next time Claude Desktop is opened.' : '');
  if (client === CX) ctx.owned.push({ kind: 'codex', file, sha256: crypto.createHash('sha256').update(codexBlock(ctx, director)).digest('hex') });
  item(ctx, client, 'connection', status, message, file);
}

// -------------------------------------------------------- shared entry decisions

// An entry is the installer's when it runs through this install; only then is it replaced instead of being treated as somebody else's.
const ownedByInstaller = (entry, ctx) => isObject(entry) && typeof entry.command === 'string' && Array.isArray(entry.args) &&
  entry.args.some(arg => isAbsolutePath(arg) && inside(arg, ctx.options.installRoot));

function decide(entry, desired, ctx) {
  if (entry === undefined) return 'absent';
  if (sameValue(entry, desired)) return 'equal';
  return ownedByInstaller(entry, ctx) ? 'ours' : 'foreign';
}

function environment(ctx, director) {
  const env = { OMP_BRIDGE_STATE: ctx.options.connectionsFolder };
  if (director) env.OMP_BRIDGE_CONTROLLER = ctx.options.credentialFile;
  return env;
}
const launchArgs = ctx => [ctx.options.mcpLauncher, ...ctx.options.mcpArguments];

// ------------------------------------------------------------------ Claude Code

async function readClaude(file) {
  const bytes = await readBytes(file);
  if (bytes === null) return { existed: false, entry: undefined };
  const { value } = parseJson(bytes);
  if (value.mcpServers === undefined) return { existed: true, entry: undefined };
  if (!isObject(value.mcpServers)) throw new Error('mcpServers invalid');
  return { existed: true, entry: Object.hasOwn(value.mcpServers, SERVER_NAME) ? value.mcpServers[SERVER_NAME] : undefined };
}
const readClaudeEntry = async file => (await readClaude(file)).entry;

function addVector(entry) {
  const vector = ['mcp', 'add', '--scope', 'user'];
  for (const [key, value] of Object.entries(entry.env ?? {})) vector.push('--env', key + '=' + value);
  vector.push('--transport', 'stdio', SERVER_NAME, '--', entry.command, ...entry.args);
  return vector;
}
const removeVector = ['mcp', 'remove', SERVER_NAME, '--scope', 'user'];

async function configureClaudeCode(ctx, exe, director) {
  const file = claudeLocations(ctx.deps).json;
  const desired = { type: 'stdio', command: ctx.options.nodeExecutable, args: launchArgs(ctx), env: environment(ctx, director) };
  let entry, existed;
  try { await plain(exe); ({ entry, existed } = await readClaude(file)); } catch { return unreadable(ctx, CC, 'connection', file); }
  const verdict = decide(entry, desired, ctx);
  if (verdict === 'foreign') return foreignEntry(ctx, CC, file);
  if (verdict === 'equal') { registered(ctx, CC, 'already-configured', director, file); return { exe }; }
  let action;
  try {
    await backup(ctx, 'claude-code-connection', { file, existed, previous: verdict === 'ours' ? entry : null });
    action = { type: 'claude', exe, previous: verdict === 'ours' ? entry : null, added: desired };
    ctx.actions.push(action);
    if (verdict === 'ours') await ctx.deps.run(exe, removeVector);
    await ctx.deps.run(exe, addVector(desired));
    if (!sameValue(await readClaudeEntry(file), desired)) throw new Error('entry not kept');
  } catch {
    // The install carries on without this connection, so whatever this attempt may have changed is put back now.
    const report = { restored: 0, left: [] };
    if (action) { ctx.actions.splice(ctx.actions.indexOf(action), 1); await undoClaude(ctx, action, report).catch(() => report.left.push('Setup could not undo its change to Claude Code settings; check that file by hand.')); }
    failedItem(ctx, CC, 'connection', file, report.left); return null;
  }
  registered(ctx, CC, verdict === 'ours' ? 'updated' : 'configured', director, file);
  return { exe };
}

async function undoClaude(ctx, action, report) {
  const file = claudeLocations(ctx.deps).json;
  let current = await readClaudeEntry(file);
  if (current !== undefined && sameValue(current, action.added)) {
    await ctx.deps.run(action.exe, removeVector);
    current = await readClaudeEntry(file);
    if (current !== undefined) { report.left.push(CC + ' still shows the Pi on the Side connection Setup added; remove it in Claude Code.'); return; }
    if (!action.previous) { report.restored++; return; }
  } else if (current !== undefined && !(action.previous && sameValue(current, action.previous))) {
    report.left.push(CC + ' changed its Pi on the Side connection after Setup, so Setup left it as it is.');
    return;
  } else if (current !== undefined || !action.previous) return;
  const previous = action.previous;
  if (!isObject(previous.env) || !Object.values(previous.env).every(v => typeof v === 'string') ||
      typeof previous.command !== 'string' || !Array.isArray(previous.args)) {
    report.left.push(CC + ' lost its older Pi on the Side connection and Setup could not rebuild it; run pots install again.');
    return;
  }
  await ctx.deps.run(action.exe, addVector(previous));
  if (sameValue(await readClaudeEntry(file), previous)) report.restored++;
  else report.left.push(CC + ' stored its older Pi on the Side connection differently than before; run pots install again to repair it.');
}

// ----------------------------------------------------------------- Codex (TOML)

const tomlString = value => '"' + String(value).replace(/[\\"\u0000-\u001f\u007f]/g, c => {
  const named = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }[c];
  return named ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
}) + '"';

function codexBlock(ctx, director) {
  const env = Object.entries(environment(ctx, director)).map(([key, value]) => key + ' = ' + tomlString(value)).join(', ');
  return [BEGIN, '[mcp_servers.' + SERVER_NAME + ']', 'command = ' + tomlString(ctx.options.nodeExecutable),
    'args = [' + launchArgs(ctx).map(tomlString).join(', ') + ']', 'env = { ' + env + ' }',
    'default_tools_approval_mode = "writes"', END].join('\n');
}

// Minimal TOML skimmer: lists tables and key/value statements with their full key
// paths. It throws on anything it cannot follow so callers fail closed.
function scanToml(text) {
  const statements = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let table = [];
  const bad = () => { throw new Error('toml'); };
  const skipBlank = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
  const skipLine = () => { while (i < n && text[i] !== '\n') i++; };
  const quoted = quote => {
    const start = ++i;
    for (;; i++) {
      if (i >= n || text[i] === '\n') bad();
      if (quote === '"' && text[i] === '\\') { i++; continue; }
      if (text[i] === quote) break;
    }
    const raw = text.slice(start, i++);
    if (quote === "'") return raw;
    try { return JSON.parse('"' + raw + '"'); } catch { return raw; }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      skipBlank();
      if (text[i] === '"' || text[i] === "'") parts.push(quoted(text[i]));
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
        if (!match) bad();
        parts.push(match[0]);
        i += match[0].length;
      }
      skipBlank();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  const value = () => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '"' || c === "'") {
        if (text.startsWith(c + c + c, i)) {
          i += 3;
          for (;;) {
            if (i >= n) bad();
            if (c === '"' && text[i] === '\\') { i += 2; continue; }
            if (text.startsWith(c + c + c, i)) {
              let run = 0;
              while (text[i + run] === c) run++;
              if (run > 5) bad();
              i += run;
              break;
            }
            i++;
          }
        } else quoted(c);
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth < 0) bad(); }
      else if (c === '#') { skipLine(); continue; }
      else if (c === '\n' && depth === 0) break;
      i++;
    }
    if (depth !== 0) bad();
  };
  const endLine = () => {
    skipBlank();
    if (text[i] === '#') skipLine();
    if (text[i] === '\r') i++;
    if (i < n && text[i] !== '\n') bad();
    if (i < n) i++;
  };
  while (i < n) {
    skipBlank();
    if (i >= n) break;
    if (text[i] === '\n' || text[i] === '\r') { i++; continue; }
    if (text[i] === '#') { skipLine(); continue; }
    const start = i;
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const parts = key();
      skipBlank();
      for (let close = array ? 2 : 1; close > 0; close--) { if (text[i] !== ']') bad(); i++; }
      table = parts;
      statements.push({ kind: array ? 'array-table' : 'table', path: parts, start, value: '' });
      endLine();
    } else {
      const parts = key();
      skipBlank();
      if (text[i] !== '=') bad();
      i++;
      skipBlank();
      const from = i;
      value();
      statements.push({ kind: 'kv', path: [...table, ...parts], start, value: text.slice(from, i) });
      endLine();
    }
  }
  return statements;
}

const eolOf = text => {
  const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
};

function locateBlock(text) {
  const lines = [];
  for (let at = 0; at <= text.length;) {
    let stop = text.indexOf('\n', at);
    if (stop === -1) stop = text.length;
    const raw = text.slice(at, stop);
    lines.push({ start: at, end: at + raw.replace(/\r$/, '').length, text: raw.trim() });
    at = stop + 1;
  }
  const begins = lines.filter(line => line.text === BEGIN), ends = lines.filter(line => line.text === END);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].start < begins[0].start) throw new Error('damaged markers');
  return { start: begins[0].start, end: ends[0].end };
}

async function configureCodex(ctx, director, folderExists) {
  const folder = codexHome(ctx.deps);
  const file = path.join(folder, 'config.toml');
  let bytes, text, block, statements;
  try {
    bytes = folderExists ? await readBytes(file) : null;
    text = bytes === null ? '' : bytes.toString('utf8');
    if (bytes !== null && !Buffer.from(text, 'utf8').equals(bytes)) throw new Error('not utf-8');
    block = locateBlock(text);
    statements = scanToml(text);
  } catch { return unreadable(ctx, CX, 'connection', file); }
  const outside = statements.filter(s => !block || s.start < block.start || s.start >= block.end);
  const foreign = outside.some(s => s.path[0] === 'mcp_servers' && (s.path[1] === SERVER_NAME ||
    (s.kind === 'kv' && s.path.length === 1 && s.value.includes(SERVER_NAME))));
  if (foreign) return foreignEntry(ctx, CX, file);
  if (outside.some(s => s.kind === 'kv' && s.path.length === 1 && s.path[0] === 'mcp_servers')) {
    return blocked(ctx, CX, 'connection', 'The Codex settings define mcp_servers in a form Setup cannot add to, so Setup left that file untouched.',
      'Rewrite mcp_servers in ' + file + ' as separate [mcp_servers.name] tables, then run pots install again.', file);
  }
  const desired = codexBlock(ctx, director);
  if (block && text.slice(block.start, block.end).replace(/\r\n/g, '\n') === desired) {
    return registered(ctx, CX, 'already-configured', director, file);
  }
  const eol = eolOf(text);
  const written = desired.replace(/\n/g, eol);
  const previousBlock = block ? text.slice(block.start, block.end).replace(/\r\n/g, '\n') : null;
  let next, appended = null;
  if (block) next = text.slice(0, block.start) + written + text.slice(block.end);
  else {
    next = text;
    if (next.length > 0) {
      if (!next.endsWith('\n')) next += eol;
      if (!/\n[ \t]*\r?\n$/.test(next)) next += eol;
    }
    next += written + eol;
    appended = next.slice(text.length);
  }
  try {
    await changeFile(ctx, 'codex-connection', file, { existed: bytes !== null, previous: previousBlock }, Buffer.from(next, 'utf8'),
      { type: 'toml', existed: bytes !== null, previousBlock, wrote: desired, appended });
  } catch { return failedItem(ctx, CX, 'connection', file); }
  registered(ctx, CX, block ? 'updated' : 'configured', director, file);
}

// ------------------------------------------------- write access moves with the director

// Write access belongs to exactly one assistant. When an earlier run (with another client choice) gave it to a
// registration this run does not configure, that registration loses it again, but only if it is exactly what Setup
// wrote for the directing assistant; anything else is kept as it is and listed for the user.
const stillHolds = (ctx, client, file, why) => {
  const message = client + ' still has write access to Pi on the Side from an earlier setup, but ' + ctx.releasing + ' directs now, so two assistants could send tasks. Setup left '
    + file + ' as it is because ' + why + '.';
  item(ctx, client, 'connection', 'needs-you', message, file);
  ctx.needsYou.push({ client, message, fix: 'Remove the OMP_BRIDGE_CONTROLLER setting from the ' + SERVER_NAME + ' connection in ' + client + ' (or remove the connection), then run pots install again.',
    action: 'connect-again' });
};

// `retry` is false when this run already tried to rewrite Codex's file and failed: the file is then only checked, and a hold is reported.
async function releaseCodex(ctx, retry = true) {
  const file = path.join(codexHome(ctx.deps), 'config.toml');
  let text;
  try {
    const bytes = await readBytes(file);
    if (bytes === null) return;
    text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('not utf-8');
  } catch { return retry ? unreadable(ctx, CX, 'connection', file) : undefined; }
  if (!text.includes('OMP_BRIDGE_CONTROLLER = ' + tomlString(ctx.options.credentialFile))) return;
  if (!retry) return stillHolds(ctx, CX, file, 'Setup could not safely change it in this run');
  let block = null;
  try { block = locateBlock(text); } catch { /* damaged markers: not provably ours */ }
  if (!block || text.slice(block.start, block.end).replace(/\r\n/g, '\n') !== codexBlock(ctx, true)) {
    return stillHolds(ctx, CX, file, 'it is not exactly what Setup wrote');
  }
  return configureCodex(ctx, false, true);
}

async function releaseClaude(ctx, exe) {
  const file = claudeLocations(ctx.deps).json;
  let entry;
  try { ({ entry } = await readClaude(file)); } catch { return unreadable(ctx, CC, 'connection', file); }
  if (!isObject(entry) || !isObject(entry.env) || entry.env.OMP_BRIDGE_CONTROLLER !== ctx.options.credentialFile) return null;
  const wrote = { type: 'stdio', command: ctx.options.nodeExecutable, args: launchArgs(ctx), env: environment(ctx, true) };
  if (!sameValue(entry, wrote)) { stillHolds(ctx, CC, file, 'it is not exactly what Setup wrote'); return null; }
  if (exe === null) { stillHolds(ctx, CC, file, 'Claude Code was not found on this computer, so Setup cannot change it'); return null; }
  return configureClaudeCode(ctx, exe, false);
}

async function releaseDesktop(ctx) {
  if (!isAbsolutePath(ctx.deps.env.APPDATA)) return;
  const file = desktopFile(ctx);
  let entry;
  try { ({ entry } = await readDesktop(file)); } catch { return unreadable(ctx, CD, 'connection', file); }
  if (!isObject(entry) || !isObject(entry.env) || entry.env.OMP_BRIDGE_CONTROLLER !== ctx.options.credentialFile) return;
  const wrote = { command: ctx.options.nodeExecutable, args: launchArgs(ctx), env: environment(ctx, true) };
  if (!sameValue(entry, wrote)) return stillHolds(ctx, CD, file, 'it is not exactly what Setup wrote');
  return configureClaudeDesktop(ctx, false);
}

// ------------------------------------------------------------------ Claude skill

async function configureSkill(ctx) {
  const file = path.join(claudeLocations(ctx.deps).folder, 'skills', 'pi-on-the-side', 'SKILL.md');
  const wanted = Buffer.from(SKILL_HEAD + ctx.options.coordinatorInstructions.claude, 'utf8');
  let bytes;
  try { bytes = await readBytes(file); } catch { return unreadable(ctx, CC, 'instructions', file); }
  if (bytes !== null && bytes.equals(wanted)) {
    ctx.owned.push({ kind: 'claude-skill', file, sha256: crypto.createHash('sha256').update(wanted).digest('hex') });
    return item(ctx, CC, 'instructions', 'already-configured', CC + ' already had the current Pi on the Side coordinator instructions, so nothing was changed.', file);
  }
  if (bytes !== null && !bytes.toString('utf8').split(/\r?\n/).includes(SKILL_MARK)) {
    return blocked(ctx, CC, 'instructions', 'A different file already exists where Setup puts the Pi on the Side instructions for Claude, so Setup left it alone.',
      'Rename or delete ' + file + ', then run pots install again.', file);
  }
  try {
    await changeFile(ctx, 'claude-skill-instructions', file, { existed: bytes !== null, previous: bytes === null ? null : bytes.toString('utf8') }, wanted,
      { type: 'skill', previous: bytes, wrote: wanted });
  } catch { return failedItem(ctx, CC, 'instructions', file); }
  ctx.owned.push({ kind: 'claude-skill', file, sha256: crypto.createHash('sha256').update(wanted).digest('hex') });
  item(ctx, CC, 'instructions', bytes === null ? 'configured' : 'updated', bytes === null
    ? CC + ' now has the Pi on the Side coordinator instructions.'
    : 'The Pi on the Side coordinator instructions in ' + CC + ' were updated to this version.', file);
}

// ---------------------------------------------------------------- Claude Desktop (JSON)

// Claude Desktop documents local MCP servers in %APPDATA%\Claude\claude_desktop_config.json under mcpServers; it reads them when it starts.
const desktopFile = ctx => path.join(ctx.deps.env.APPDATA, 'Claude', 'claude_desktop_config.json');
async function readDesktop(file) {
  const bytes = await readBytes(file);
  const { value } = bytes === null ? { value: {} } : parseJson(bytes);
  if (value.mcpServers !== undefined && !isObject(value.mcpServers)) throw new Error('mcpServers invalid');
  return { existed: bytes !== null, value, entry: value.mcpServers?.[SERVER_NAME] };
}
const desktopText = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

async function configureClaudeDesktop(ctx, director) {
  const file = desktopFile(ctx), desired = { command: ctx.options.nodeExecutable, args: launchArgs(ctx), env: environment(ctx, director) };
  let current;
  try { current = await readDesktop(file); } catch { return unreadable(ctx, CD, 'connection', file); }
  const verdict = decide(current.entry, desired, ctx);
  if (verdict === 'foreign') return foreignEntry(ctx, CD, file);
  if (verdict === 'equal') { ctx.owned.push({ kind: 'claude-desktop', file }); return registered(ctx, CD, 'already-configured', director, file); }
  const previous = verdict === 'ours' ? current.entry : null;
  try {
    await changeFile(ctx, 'claude-desktop-connection', file, { existed: current.existed, previous },
      desktopText({ ...current.value, mcpServers: { ...current.value.mcpServers, [SERVER_NAME]: desired } }),
      { type: 'desktop', existed: current.existed, previous, added: desired });
  } catch { return failedItem(ctx, CD, 'connection', file); }
  ctx.owned.push({ kind: 'claude-desktop', file });
  registered(ctx, CD, previous ? 'updated' : 'configured', director, file);
}

async function undoDesktop(ctx, action, report) {
  const current = await readDesktop(action.file);
  if (!current.existed) return;
  if (current.entry === undefined || !sameValue(current.entry, action.added)) {
    if (current.entry !== undefined && !(action.previous && sameValue(current.entry, action.previous))) report.left.push(changedMessage(action.file));
    return;
  }
  const { [SERVER_NAME]: ours, ...others } = current.value.mcpServers;
  const servers = action.previous ? { ...others, [SERVER_NAME]: action.previous } : others;
  const { mcpServers, ...rest } = current.value;
  const next = Object.keys(servers).length || Object.keys(rest).length ? { ...rest, ...(Object.keys(servers).length ? { mcpServers: servers } : {}) } : null;
  if (next === null && !action.existed) await fs.unlink(action.file); else await atomicWrite(action.file, desktopText(next ?? {}));
  report.restored++;
}

// ------------------------------------------------------------------------ entry

function validate(options, deps) {
  const bad = () => { throw new Error('invalid assistant setup options'); };
  if (!isObject(options) || !isObject(deps)) bad();
  if (!['claude', 'chatgpt', 'both'].includes(options.clients)) bad();
  for (const key of ['installRoot', 'nodeExecutable', 'mcpLauncher', 'connectionsFolder', 'credentialFile']) {
    if (!isAbsolutePath(options[key])) bad();
  }
  if (typeof options.backup?.file !== 'function') bad();
  if (!Array.isArray(options.mcpArguments) || !options.mcpArguments.every(arg => typeof arg === 'string')) bad();
  if (options.clients !== 'chatgpt' && !(typeof options.coordinatorInstructions?.claude === 'string' && options.coordinatorInstructions.claude)) bad();
  if (!isAbsolutePath(deps.home) || typeof deps.which !== 'function' || typeof deps.run !== 'function') bad();
}

const changedMessage = file => file + ' was changed after Setup wrote it, so Setup left it as it is.';

// Each undo re-reads the file as it is now and touches only the part Setup owns,
// so changes made by the user or the app in the meantime survive.
async function undoToml(action, report) {
  const bytes = await readBytes(action.file);
  if (bytes === null) return;
  const text = bytes.toString('utf8');
  const block = locateBlock(text);
  if (!block) return;
  if (text.slice(block.start, block.end).replace(/\r\n/g, '\n') !== action.wrote) { report.left.push(changedMessage(action.file)); return; }
  let next;
  if (action.previousBlock !== null) next = text.slice(0, block.start) + action.previousBlock.replace(/\n/g, eolOf(text)) + text.slice(block.end);
  else if (action.appended !== null && text.endsWith(action.appended)) next = text.slice(0, text.length - action.appended.length);
  else {
    let stop = block.end;
    if (text[stop] === '\r') stop++;
    if (text[stop] === '\n') stop++;
    next = text.slice(0, block.start) + text.slice(stop);
  }
  if (!action.existed && next.trim() === '') await fs.unlink(action.file);
  else await atomicWrite(action.file, Buffer.from(next, 'utf8'));
  report.restored++;
}

async function undoSkill(action, report) {
  const current = await readBytes(action.file);
  if (current === null) return;
  if (!current.equals(action.wrote)) { report.left.push(changedMessage(action.file)); return; }
  if (action.previous === null) await fs.unlink(action.file);
  else await atomicWrite(action.file, action.previous);
  report.restored++;
}

async function undoActions(ctx) {
  const report = { restored: 0, left: [] };
  for (const action of [...ctx.actions].reverse()) {
    try {
      if (action.type === 'claude') await undoClaude(ctx, action, report);
      else if (action.type === 'dir') await fs.rmdir(action.dir).catch(() => {});
      else if (action.type === 'toml') await undoToml(action, report);
      else if (action.type === 'desktop') await undoDesktop(ctx, action, report);
      else await undoSkill(action, report);
    } catch {
      report.left.push('Setup could not undo its change to ' + (action.file ?? 'Claude Code settings') + '; check that file by hand.');
    }
  }
  return report;
}

export async function configureAssistants(options, deps) {
  validate(options, deps);
  const ctx = { options, deps: { ...deps, env: deps.env ?? {} }, items: [], needsYou: [], actions: [], owned: [] };
  const wantClaude = options.clients !== 'chatgpt', wantChat = options.clients !== 'claude';
  const find = async names => {
    for (const name of names) {
      const found = await deps.which(name);
      if (isAbsolutePath(found)) return found;
    }
    return null;
  };

  const exe = wantClaude ? await find(['claude.exe', 'claude']) : null;
  const appData = wantClaude && isAbsolutePath(ctx.deps.env.APPDATA) ? ctx.deps.env.APPDATA : null;
  const desktop = appData ? await dirState(path.join(appData, 'Claude')) : 'absent';
  const codexFolder = wantChat ? await dirState(codexHome(ctx.deps)) : 'absent';
  const codexExe = wantChat && codexFolder === 'absent' ? await find(['codex.exe', 'codex']) : null;
  const present = { code: exe !== null, codex: codexFolder !== 'absent' || codexExe !== null };
  const none = !present.code && !present.codex && desktop === 'absent';

  const guard = async (client, what, work) => {
    try { return await work(); } catch { failedItem(ctx, client, what); return null; }
  };
  let claudeCode = null, ccHolds = false, ccUnknown = false, desktopSlot = null;
  // Claude Code present but not connected may still hold the write access: while its file shows that it does, the others stay read-only;
  // while its file cannot be read to tell, no other assistant is touched at all.
  // "Left as it is" is only true when the assistant has an entry to leave; one with no entry was simply not connected this time.
  const leaveAsIs = async client => {
    let had = true;
    try {
      if (client === CX) { const bytes = await readBytes(path.join(codexHome(ctx.deps), 'config.toml')); had = bytes !== null && bytes.toString('utf8').includes(SERVER_NAME); }
      else had = (await readDesktop(desktopFile(ctx))).entry !== undefined;
    } catch { /* unreadable: it is left alone either way */ }
    item(ctx, client, 'connection', 'left-as-is', client + (had ? ' was left as it is' : ' was not connected this time') + ', because Claude Code could not be connected and may still be the directing assistant. Fix Claude Code first, then run pots install again.');
  };

  if (wantClaude) {
    if (present.code) claudeCode = (await guard(CC, 'connection', () => configureClaudeCode(ctx, exe, true))) ?? null;
    else item(ctx, CC, 'connection', 'not-installed', CC + ' was not found on this computer; install it, then run pots install again to connect it.');
    if (present.code && claudeCode === null) {
      try { const { entry } = await readClaude(claudeLocations(ctx.deps).json); ccHolds = isObject(entry) && isObject(entry.env) && entry.env.OMP_BRIDGE_CONTROLLER === ctx.options.credentialFile; }
      catch { ccUnknown = true; }
    }
    // Claude Desktop is set up after Codex below, once it is known who really holds the write access; its rows are put back here so the result reads as before.
    desktopSlot = { items: ctx.items.length, owned: ctx.owned.length, needsYou: ctx.needsYou.length };
    if (none) {
      ctx.needsYou.push({ client: 'Claude', message: 'Neither Claude Code nor Claude Desktop was found on this computer, so no Claude assistant was connected.',
        fix: 'Install Claude Code or Claude Desktop, then run pots install again.', action: 'connect-again' });
    }
    const claudeFolder = await dirState(claudeLocations(ctx.deps).folder);
    if (claudeFolder !== 'absent' || present.code) await guard(CC, 'instructions', () => configureSkill(ctx));
  }
  if (wantChat) {
    if (present.codex && ccUnknown) await leaveAsIs(CX);
    else if (present.codex) await guard(CX, 'connection', () => configureCodex(ctx, claudeCode === null && !ccHolds, codexFolder === 'dir'));
    else {
      item(ctx, CX, 'connection', 'not-installed', 'The ChatGPT desktop app (Codex) was not found on this computer; install it, then run pots install again to connect it.');
      if (none) {
        ctx.needsYou.push({ client: CX, message: 'The ChatGPT desktop app (Codex) was not found on this computer, so it was not connected.',
          fix: 'Install the ChatGPT desktop app, then run pots install again.', action: 'connect-again' });
      }
    }
  }
  const connected = client => ctx.items.some(row => row.client === client && row.what === 'connection' && ['configured', 'updated', 'already-configured'].includes(row.status));
  // Roles follow who is really connected, so an assistant that already has write access keeps it until another one is connected.
  if (wantClaude && desktop !== 'absent') {
    const first = { items: ctx.items.length, owned: ctx.owned.length, needsYou: ctx.needsYou.length };
    if (ccUnknown) await leaveAsIs(CD);
    else await guard(CD, 'connection', () => configureClaudeDesktop(ctx, claudeCode === null && !ccHolds && !connected(CX)));
    for (const list of ['items', 'owned', 'needsYou']) ctx[list].splice(desktopSlot[list], 0, ...ctx[list].splice(first[list]));
  }
  const director = claudeCode !== null || ccHolds ? 'code' : connected(CX) ? 'codex' : null;

  // The other assistant, when it still has the write access an earlier run gave it.
  if (director === 'code' && !connected(CX)) {
    ctx.releasing = CC;
    await guard(CX, 'connection', () => releaseCodex(ctx, !(wantChat && present.codex)));
  } else if (director === 'codex' && connected(CX)) {
    ctx.releasing = CX;
    claudeCode = (await guard(CC, 'connection', async () => releaseClaude(ctx, await find(['claude.exe', 'claude'])))) ?? null;
    if (!wantClaude) await guard(CD, 'connection', () => releaseDesktop(ctx));
  } else if (director === null && !wantChat && connected(CD)) {
    ctx.releasing = CD;
    await guard(CX, 'connection', () => releaseCodex(ctx));
  }
  if (present.code && !connected(CC) && !connected(CX) && !connected(CD) && !ctx.items.some(row => row.status === 'left-as-is')) {
    ctx.needsYou.push({ client: 'Pi on the Side', message: 'No assistant could be connected this time, so none of them was given the write-access file. An assistant that already had it keeps it.',
      fix: 'Fix the problems listed above, then run pots install again.', action: 'connect-again' });
  }
  ctx.releasing = null;

  let undone = false;
  return {
    items: ctx.items,
    needsYou: ctx.needsYou,
    claudeCode,
    owned: ctx.owned,
    async undo() {
      if (undone) return { restored: 0, left: [] };
      undone = true;
      return undoActions(ctx);
    }
  };
}

// ------------------------------------------------------------ Windows scheduled tasks

// A scheduled task is how something keeps running across log-ins and crashes without a window or a Startup file. Every task this
// installer makes carries a marker in its description; only a task that still carries it is ever removed.
const schtasks = args => new Promise(resolve => execFile('schtasks.exe', args, { windowsHide: true, timeout: 30000 },
  (error, stdout) => resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout) })));
export function windowsTasks({ run = schtasks, folder = os.tmpdir() } = {}) {
  // The task's XML; null only when a working task list shows it does not exist. A failed query alone is not "absent": it fails for
  // "no such task" and for a broken Task Scheduler alike, so an answer that cannot be trusted throws.
  const query = async name => {
    const found = await run(['/Query', '/TN', name, '/XML']);
    if (found.code === 0) return found.stdout;
    const all = await run(['/Query', '/FO', 'CSV', '/NH']);
    if (all.code === 0 && !all.stdout.toLowerCase().includes(name.toLowerCase())) return null;
    throw new Error('scheduled task state unknown');
  };
  return {
    query,
    async register(name, xml) {
      // schtasks reads a task file as UTF-16.
      const file = path.join(folder, name + '.' + crypto.randomUUID() + '.xml');
      await fs.writeFile(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]), { flag: 'wx', mode: 0o600 });
      try { if ((await run(['/Create', '/TN', name, '/XML', file, '/F'])).code !== 0) throw new Error('scheduled task not created'); }
      finally { await fs.unlink(file).catch(() => {}); }
    },
    async stop(name) { await run(['/End', '/TN', name]); },
    async start(name) { if ((await run(['/Run', '/TN', name])).code !== 0) throw new Error('scheduled task not started'); },
    async remove(name, mark) {
      const xml = await query(name);
      if (xml === null) return 'absent';
      if (!xml.includes(mark)) return 'foreign';
      await run(['/End', '/TN', name]);
      if ((await run(['/Delete', '/TN', name, '/F'])).code !== 0) throw new Error('scheduled task not removed');
      return 'removed';
    },
  };
}
