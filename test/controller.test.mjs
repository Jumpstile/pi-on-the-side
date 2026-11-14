import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store, initialize, readJson, writeJson } from '../src/control.mjs';
import { createCredential, acquireController, handoffController, withController, controllerStatus } from '../src/controller.mjs';
import { main } from '../src/cli.mjs';
import { createServer } from '../src/mcp.mjs';
import { registerConnection } from '../src/connections.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-controller-')));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const session = path.join(base, 'saved.jsonl'), root = path.join(base, 'state');
  const sessionId = crypto.randomUUID();
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  assert.equal(await main(['setup', session, root], { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/18.7.0' }), 0);
  const store = new Store(await readJson(path.join(root, 'config.json')));
  const a = path.join(base, 'client-a.json'), b = path.join(base, 'client-b.json');
  await createCredential(a); await createCredential(b);
  const configFile = path.join(root, 'config.json');
  return { base, root, store, a, b, configFile, sessionId, cwd };
}
const input = store => ({ version: 1, id: crypto.randomUUID(), sessionId: store.config.sessionId, expiresAt: Date.now() + 3600000,
  steps: [{ prompt: 'synthetic offline task', continueAfterEnd: false }] });
async function snapshot(root) {
  const out = {};
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const file = path.join(entry.parentPath, entry.name); out[path.relative(root, file)] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  }
  return out;
}
async function mcp(root, credential, name = 'same-display-name') {
  const server = createServer({ stateRoot: root, controllerFile: credential }); let id = 0;
  const rpc = (method, params) => server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } });
  await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  return async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { error: r.result?.isError === true, ...JSON.parse(r.result.content[0].text) }; };
}
async function cli(args, credential) { let out = '', err = ''; const code = await main(args, { controllerFile: credential, stdout: x => { out += x; }, stderr: x => { err += x; } }); return { code, out, err }; }

test('explicit credential/acquisition required; shared reads and legacy refusal do not mutate state', async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  const legacy = await mcp(f.root);
  assert.equal((await legacy('bridge_status')).controller.acquired, false);
  assert.equal((await legacy('bridge_enqueue', { id: crypto.randomUUID(), prompt: 'synthetic' })).error, 'controller credential required');
  assert.equal((await cli(['queue', f.root, 'synthetic'])).err, 'controller credential required');
  assert.equal((await cli(['abort', f.configFile, crypto.randomUUID()])).err, 'controller credential required');
  assert.deepEqual(await snapshot(f.root), before);
  await assert.rejects(withController(f.store, f.a, () => assert.fail()), /controller not acquired/);
  assert.deepEqual(await acquireController(f.store, f.a), { acquired: true, alreadyOwned: false });
  assert.deepEqual(await acquireController(f.store, f.a), { acquired: true, alreadyOwned: true });
  const owned = await snapshot(f.root);
  await assert.rejects(acquireController(f.store, f.b), /another controller/);
  await assert.rejects(withController(f.store, f.b, () => assert.fail()), /another controller/);
  assert.deepEqual(await snapshot(f.root), owned);
});

test('CLI and MCP share ownership; identical MCP IDs retry once; handoff fences former client without altering uncertain work', async t => {
  const f = await fixture(t); await acquireController(f.store, f.a);
  const a = await mcp(f.root, f.a), b = await mcp(f.root, f.b); // deliberately same display name
  const args = { id: crypto.randomUUID(), prompt: 'synthetic' };
  assert.equal((await a('bridge_enqueue', args)).duplicate, false);
  assert.equal((await a('bridge_enqueue', args)).duplicate, true);
  const receipt = { version: 1, id: args.id, sessionId: f.sessionId, state: 'failed', nextStep: 0, updatedAt: Date.now(), outcomes: [], taskSuccess: 'unverified', automaticReplay: false };
  await f.store.save(receipt);
  const waiting = input(f.store); await withController(f.store, f.a, () => f.store.enqueue(waiting));
  const waitingReceipt = { ...receipt, id: waiting.id, state: 'waiting', outcomes: [{ step: 0, submission: 'returned', terminalObservation: 'not_seen' }] };
  await f.store.save(waitingReceipt);
  const before = await snapshot(f.root);
  assert.equal((await b('bridge_enqueue', args)).error, 'another controller owns this session');
  assert.equal((await b('bridge_cancel', { id: args.id })).error, 'another controller owns this session');
  assert.equal((await cli(['cancel', f.root, args.id], f.b)).err, 'another controller owns this session');
  const planFile = path.join(f.base, 'plan.json'); await writeJson(planFile, input(f.store));
  assert.equal((await cli(['enqueue', f.configFile, planFile], f.b)).err, 'another controller owns this session');
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await cli(['controller-handoff', f.root, f.b, f.a])).code, 1);
  assert.equal((await cli(['controller-handoff', f.root, f.a, f.b])).code, 0);
  const after = await snapshot(f.root); delete before[`controller-${f.sessionId}.json`]; delete after[`controller-${f.sessionId}.json`];
  assert.deepEqual(after, before);
  assert.equal((await a('bridge_cancel', { id: args.id })).error, 'another controller owns this session');
  assert.equal((await a('bridge_enqueue', args)).error, 'another controller owns this session');
  assert.equal((await b('bridge_enqueue', args)).duplicate, true);
  assert.deepEqual(await f.store.receipt(args.id), receipt);
  assert.deepEqual(await f.store.receipt(waiting.id), waitingReceipt);
  assert.equal((await b('bridge_enqueue', { ...args, prompt: 'different' })).error, 'plan id already used for different content');
  assert.equal((await b('bridge_cancel', { id: waiting.id })).cancelRequested, true, 'the new controller can cancel a task that is still running');
  assert.equal((await b('bridge_cancel', { id: args.id })).error, 'That task already ended, so there is nothing to cancel.');
  assert.equal((await cli(['queue', f.root, 'new bounded synthetic'], f.b)).code, 0);
});

test('different named sessions admit independent controllers; read-only registry remains shared', async t => {
  const f = await fixture(t), g = await fixture(t), hub = path.join(f.base, 'connections');
  await registerConnection(hub, 'alpha', f.root); await registerConnection(hub, 'beta', g.root);
  await acquireController(f.store, f.a); await acquireController(g.store, g.b);
  const a = await mcp(hub, f.a), b = await mcp(hub, g.b), read = await mcp(hub);
  assert.deepEqual((await read('bridge_status')).connections.map(x => x.name), ['alpha', 'beta']);
  const id = crypto.randomUUID();
  assert.equal((await a('bridge_enqueue', { connection: 'alpha', id, prompt: 'synthetic' })).duplicate, false);
  assert.equal((await b('bridge_enqueue', { connection: 'beta', id, prompt: 'synthetic' })).duplicate, false);
  assert.equal((await a('bridge_cancel', { connection: 'beta', id })).error, 'another controller owns this session');
  assert.equal(await g.store.cancelled(id), false);
});

// Children synchronize through stdin/stdout barriers, not timing sleeps. No
// OMP/model process is involved; a child only takes the same filesystem gate.
function worker(f, file, mode) {
  const control = pathToFileURL(path.resolve(import.meta.dirname, '../src/control.mjs')).href;
  const controller = pathToFileURL(path.resolve(import.meta.dirname, '../src/controller.mjs')).href;
  const code = `import {Store,readJson} from ${JSON.stringify(control)};import {acquireController,withController} from ${JSON.stringify(controller)};
    const s=new Store(await readJson(process.argv[1]));process.stdin.setEncoding('utf8');
    const next=()=>new Promise(r=>process.stdin.once('data',r));console.log('ready');await next();
    try{if(process.argv[3]==='acquire'){await acquireController(s,process.argv[2]);console.log('acquired');}
    else await withController(s,process.argv[2],async()=>{console.log('locked');await next();});}
    catch(e){console.log('error:'+e.message);}process.stdin.destroy();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.configFile, file, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '', stderr = ''; const waiters = [];
  child.stdout.on('data', b => { text += b; for (const w of [...waiters]) if (text.includes(w.marker)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(text); } });
  child.stderr.on('data', b => { stderr += b; });
  const exit = new Promise(resolve => child.once('exit', code => resolve({ code, text, stderr })));
  const until = marker => text.includes(marker) ? Promise.resolve(text) : new Promise((resolve, reject) => { const w = { marker, resolve }; w.timer = setTimeout(() => reject(Error('worker barrier timeout waiting for ' + marker + '; child output: ' + JSON.stringify(text) + '; stderr: ' + stderr)), 60000); waiters.push(w); });
  return { child, until, exit };
}
const realCli = (args, credential) => new Promise(resolve => execFile(process.execPath,
  [path.resolve(import.meta.dirname, '../bin/bridge.mjs'), ...args],
  { windowsHide: true, timeout: 60000, env: { ...process.env, OMP_BRIDGE_CONTROLLER: credential } },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
async function realMcpWrite(root, credential, name, args) {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../bin/mcp.mjs')],
    { windowsHide: true, env: { ...process.env, OMP_BRIDGE_STATE: root, OMP_BRIDGE_CONTROLLER: credential } });
  let output = ''; child.stdout.on('data', b => { output += b; });
  const timeout = setTimeout(() => child.kill(), 60000);
  const exit = new Promise(resolve => child.once('close', resolve));
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'same-display-name', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ]) child.stdin.write(JSON.stringify(message) + '\n');
  child.stdin.end();
  try { assert.equal(await exit, 0); } finally { clearTimeout(timeout); }
  const reply = output.trim().split('\n').map(JSON.parse).find(r => r.id === 2);
  assert.equal(reply.result.isError, true);
  return JSON.parse(reply.result.content[0].text).error;
}
test('concurrent processes: one acquisition, whole-write serialization, handoff busy, crash lock never stolen', async t => {
  const f = await fixture(t), a = worker(f, f.a, 'acquire'), b = worker(f, f.b, 'acquire');
  t.after(() => { a.child.kill(); b.child.kill(); });
  await Promise.all([a.until('ready'), b.until('ready')]); a.child.stdin.write('go\n'); b.child.stdin.write('go\n');
  const results = await Promise.all([a.exit, b.exit]);
  assert.equal(results.filter(r => r.text.includes('acquired')).length, 1);
  const winner = results[0].text.includes('acquired') ? f.a : f.b, loser = winner === f.a ? f.b : f.a;
  await assert.rejects(acquireController(f.store, loser), /another controller/);
  const value = input(f.store); await withController(f.store, winner, () => f.store.enqueue(value));
  const held = worker(f, winner, 'hold'); t.after(() => held.child.kill());
  await held.until('ready'); held.child.stdin.write('go\n'); await held.until('locked');
  await assert.rejects(withController(f.store, winner, () => assert.fail()), /controller write busy/);
  await assert.rejects(handoffController(f.store, winner, loser), /controller write busy/);
  const stateBefore = await snapshot(f.root);
  const cliBlocked = await realCli(['queue', f.root, 'must not be admitted'], winner);
  assert.notEqual(cliBlocked.code, 0); assert.match(cliBlocked.stderr, /controller write busy/);
  const handoffBlocked = await realCli(['controller-handoff', f.root, winner, loser], winner);
  assert.notEqual(handoffBlocked.code, 0); assert.match(handoffBlocked.stderr, /controller write busy/);
  assert.match(await realMcpWrite(f.root, winner, 'bridge_cancel', { id: value.id }), /controller write busy/);
  assert.match(await realMcpWrite(f.root, loser, 'bridge_enqueue', { id: crypto.randomUUID(), prompt: 'must not be admitted' }), /another controller/);
  assert.deepEqual(await snapshot(f.root), stateBefore);
  held.child.stdin.write('finish\n'); assert.equal((await held.exit).code, 0);
  await handoffController(f.store, winner, loser);
  const crashed = worker(f, loser, 'hold'); t.after(() => crashed.child.kill());
  await crashed.until('ready'); crashed.child.stdin.write('go\n'); await crashed.until('locked'); crashed.child.kill(); await crashed.exit;
  assert.equal((await controllerStatus(f.store)).writeLock, 'present');
  await assert.rejects(acquireController(f.store, loser), /controller write busy/);
  await assert.rejects(handoffController(f.store, loser, winner), /controller write busy/);
  await assert.rejects(withController(f.store, loser, () => assert.fail()), /controller write busy/);
});

test('malformed ownership/credential and lost credential fail closed; credentials never appear in status', async t => {
  const f = await fixture(t); await acquireController(f.store, f.a);
  const secret = (await readJson(f.a)).key;
  assert.ok(!JSON.stringify(await controllerStatus(f.store)).includes(secret));
  const before = await fs.readFile(f.a, 'utf8');
  await assert.rejects(createCredential(f.a), /already exists, so nothing was changed.*keep using it.*controller-handoff/);
  assert.equal(await fs.readFile(f.a, 'utf8'), before, 'the existing credential is not touched');
  await fs.writeFile(f.a, '{');
  await assert.rejects(withController(f.store, f.a, () => assert.fail()), /invalid controller credential/);
  await fs.writeFile(path.join(f.root, `controller-${f.sessionId}.json`), '{}');
  await assert.rejects(acquireController(f.store, f.b), /invalid controller ownership/);
});

test('a missing, an unreadable and an invalid controller credential each say what is wrong', async t => {
  const f = await fixture(t), missing = path.join(f.base, 'nowhere.json');
  await assert.rejects(withController(f.store, missing, () => assert.fail()), /credential file was not found/);
  const real = fs.open;
  fs.open = async (file, ...rest) => { if (file === f.a) throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }); return real(file, ...rest); };
  try { await assert.rejects(withController(f.store, f.a, () => assert.fail()), /could not be opened right now.*Do not make a new credential/); }
  finally { fs.open = real; }
  await fs.writeFile(f.a, '{');
  await assert.rejects(withController(f.store, f.a, () => assert.fail()), /invalid controller credential/);
  const folder = path.join(f.base, 'a-folder'); await fs.mkdir(folder);
  await assert.rejects(withController(f.store, folder, () => assert.fail()), /is a folder or a link, not a file.*give the path of the credential file itself/);
});

test('a credential path that goes through a link is named as that, in words that also fit short names and mapped drives', async t => {
  const f = await fixture(t), real = path.join(f.base, 'real'), link = path.join(f.base, 'link');
  await fs.mkdir(real); await fs.writeFile(path.join(real, 'c.json'), '{}'); await fs.symlink(real, link, 'junction');
  await assert.rejects(withController(f.store, path.join(link, 'c.json'), () => assert.fail()), /goes through a folder that is a link, or it is written another way than its real path.*short name.*drive letter.*real path of the file/);
});

test('a controller lock or owner file that is a folder or a link is explained in plain words, never as a bare technical sentence', async t => {
  const f = await fixture(t), lock = path.join(f.root, `controller-${f.sessionId}.lock`);
  await fs.mkdir(lock);
  const plainText = /^A controller file in the session's state folder \(controller-<session id>\.json or controller-<session id>\.lock\) is a folder or a link.*move it away/;
  await assert.rejects(controllerStatus(f.store), error => plainText.test(error.message));
  const status = await (await mcp(f.root))('bridge_status');
  assert.match(status.error, plainText);
  const shown = await cli(['status', f.root]);
  assert.match(shown.err, plainText);
});

test('a controller owner record that is a folder is explained in plain words by the status check too', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, `controller-${f.sessionId}.json`));
  await assert.rejects(controllerStatus(f.store), error => /^A controller file in the session's state folder .*is a folder or a link.*move it away/.test(error.message));
});

test('a lost credential file tells the person what really works, with only commands that exist', async t => {
  const f = await fixture(t);
  await assert.rejects(withController(f.store, path.join(f.base, 'nowhere.json'), () => assert.fail()),
    /never had a controller.*controller-create.*controller-acquire.*already has a controller.*no command can replace it.*delete it, then run controller-create and controller-acquire.*write is busy.*delete the lock file.*controller-<session id>\.lock.*no assistant is running/);
});

test('a scanner holding the write lock file for a moment does not fail a write that already succeeded', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await acquireController(f.store, f.a);
  const real = fs.unlink; let held = 2;
  fs.unlink = async (file, ...rest) => { if (String(file).endsWith('.lock') && held-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); return real(file, ...rest); };
  try { assert.equal(await withController(f.store, f.a, async () => 'done'), 'done'); } finally { fs.unlink = real; }
  assert.equal(await withController(f.store, f.a, async () => 'again'), 'again', 'the lock was removed');
});
