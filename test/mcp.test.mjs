import test from 'node:test';
import { QUEUE_LIMIT_MS } from '../src/control.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { main } from '../src/cli.mjs';
import { createServer, serve } from '../src/mcp.mjs';
import { createCredential, acquireController } from '../src/controller.mjs';
import { Store, readJson } from '../src/control.mjs';
import { MESSAGES } from '../src/setup.mjs';
const FIXTURE_HOST = 'omp/1.2.3';
import { formatWatchLine } from '../src/lane-watch.mjs';

// Drives the stdio MCP adapter over a disposable setup folder. Setup uses the
// CLI module with an injected host probe; the MCP adapter never probes or
// launches OMP. The child-process smoke at the end needs process creation.
const SERVER = path.resolve(import.meta.dirname, '../bin/mcp.mjs');
const NOW = 1800000000000;
const sessionId = '00000000-0000-4000-8000-000000000021';
const otherId = '00000000-0000-4000-8000-000000000022';
const PLAN = 'aaaaaaaa-1111-4111-8111-111111111111';
const PLAN2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const INIT = Object.freeze({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } });
const SECRET = 'S3NT1N3L-private-prompt';
const TOOLS = ['bridge_status', 'bridge_lanes_status', 'bridge_lane_watch_lines', 'bridge_coordinator_heartbeat', 'bridge_enqueue', 'bridge_receipt', 'bridge_cancel'];

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge mcp ')));
  const children = [];
  t.after(async () => {
    for (const close of children) await close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const cwd = path.join(base, 'project dir'); await fs.mkdir(cwd);
  const session = path.join(base, 'saved session.jsonl');
  const header = id => JSON.stringify({ type: 'session', version: 3, id, cwd }) + '\n';
  await fs.writeFile(session, header(sessionId));
  const state = path.join(base, 'private state');
  const quiet = { stdout: () => {}, stderr: () => {} };
  assert.equal(await main(['setup', session, state], { ...quiet, locate: async () => path.join(base, 'omp.exe'), detect: async () => FIXTURE_HOST }), 0);
  const controllerFile = path.join(base, 'controller.json');
  await createCredential(controllerFile);
  await acquireController(new Store(await readJson(path.join(state, 'config.json'))), controllerFile);
  const server = createServer({ stateRoot: state, controllerFile, now: () => NOW });
  let next = 1;
  const rpc = async (method, params, id = next++) => server.handle(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
  const call = (name, args) => rpc('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
  const ready = async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } });
    assert.equal(await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), undefined);
  };
  return { base, cwd, session, state, controllerFile, header, server, rpc, call, ready, children };
}
const body = reply => { assert.equal(reply.jsonrpc, '2.0'); assert.ok(reply.result, JSON.stringify(reply)); return JSON.parse(reply.result.content[0].text); };
const ok = reply => { assert.notEqual(reply.result.isError, true, reply.result.content?.[0]?.text); assert.equal(reply.result.content.length, 1); assert.equal(reply.result.content[0].type, 'text'); return body(reply); };
const toolError = reply => { assert.equal(reply.result.isError, true); return body(reply).error; };
const protocolError = (reply, code) => { assert.equal(reply.result, undefined); assert.equal(reply.error.code, code); return reply.error.message; };
const exposed = (f, text) => [f.base, f.base.replaceAll('\\', '\\\\'), f.base.replaceAll('\\', '/'), sessionId, SECRET].filter(value => text.includes(value));

const notify = (server, method, params) => server.handle(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));

test('initialize negotiates 2025-06-18 on a fresh server for any requested version and declares only tools', async t => {
  const f = await fixture(t);
  for (const requested of ['2025-06-18', '2099-01-01']) {
    const server = createServer({ stateRoot: f.state, now: () => NOW });
    const reply = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init-' + requested, method: 'initialize', params: { ...INIT, protocolVersion: requested } }));
    assert.equal(reply.id, 'init-' + requested);
    assert.equal(reply.result.protocolVersion, '2025-06-18');
    assert.deepEqual(reply.result.capabilities, { tools: {} });
    assert.deepEqual(Object.keys(reply.result.serverInfo).sort(), ['name', 'version']);
    assert.ok(reply.result.instructions.length <= 512);
  }
});

test('lifecycle: tools wait for notifications/initialized, ping always answers, initialize is validated and accepted once', async t => {
  const f = await fixture(t);
  const notReady = async () => {
    assert.equal(protocolError(await f.rpc('tools/list'), -32600), 'Server not initialized');
    assert.equal(protocolError(await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' }), -32600), 'Server not initialized');
  };
  await notReady();
  assert.deepEqual((await f.rpc('ping')).result, {});
  const invalid = [undefined, {}, { ...INIT, protocolVersion: 7 }, { ...INIT, protocolVersion: '' }, { ...INIT, capabilities: null },
    { ...INIT, capabilities: [] }, { ...INIT, capabilities: 'all' }, { protocolVersion: INIT.protocolVersion, capabilities: {} },
    { ...INIT, clientInfo: null }, { ...INIT, clientInfo: { name: 'fixture' } }, { ...INIT, clientInfo: { name: 1, version: '0' } },
    { ...INIT, clientInfo: [SECRET] }];
  for (const params of invalid) {
    const reply = await f.rpc('initialize', params);
    assert.equal(protocolError(reply, -32602), 'Invalid params', JSON.stringify(params));
    assert.deepEqual(exposed(f, JSON.stringify(reply)), []);
  }
  // The initialized notification means nothing before a successful initialize.
  assert.equal(await notify(f.server, 'notifications/initialized'), undefined);
  await notReady();
  assert.equal((await f.rpc('initialize', INIT)).result.protocolVersion, '2025-06-18');
  // Between the initialize response and the initialized notification only ping works.
  await notReady();
  assert.deepEqual((await f.rpc('ping')).result, {});
  for (const method of ['notifications/cancelled', 'tools/call', 'shell/exec'])
    assert.equal(await notify(f.server, method, { name: 'bridge_cancel', arguments: { id: PLAN } }), undefined);
  assert.equal(await f.server.handle(JSON.stringify({ jsonrpc: '1.0', method: 'notifications/initialized' })), undefined);
  await notReady();
  assert.equal(await notify(f.server, 'notifications/initialized'), undefined);
  assert.deepEqual((await f.rpc('tools/list')).result.tools.map(tool => tool.name), TOOLS);
  assert.deepEqual((await f.rpc('ping')).result, {});
  // A second initialize on the same connection is refused and changes nothing.
  assert.equal(protocolError(await f.rpc('initialize', { ...INIT, protocolVersion: '2099-01-01' }), -32600), 'Already initialized');
  assert.equal(await notify(f.server, 'notifications/initialized'), undefined);
  assert.equal(ok(await f.call('bridge_status')).plans.length, 0);
  assert.equal(await f.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })), undefined, 'client responses are ignored');
  for (const dir of ['plans', 'receipts', 'control']) assert.deepEqual(await fs.readdir(path.join(f.state, dir)), [], 'a notification never acts');
});

test('a second initialize before the initialized notification is also refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('initialize', INIT)).result.protocolVersion, '2025-06-18');
  assert.equal(protocolError(await f.rpc('initialize', INIT), -32600), 'Already initialized');
});

test('protocol errors are fixed JSON-RPC errors that never echo input', async t => {
  const f = await fixture(t);
  await f.ready();
  const cases = [
    ['{"jsonrpc":"2.0","id":1,"method":"' + SECRET, null, -32700],
    [JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), null, -32600],
    [JSON.stringify({ jsonrpc: '1.0', id: 2, method: 'ping' }), 2, -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }), null, -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: { x: SECRET }, method: 'ping' }), null, -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'ping' }), null, -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: 3, method: SECRET }), 3, -32601],
    [JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }), 4, -32601],
    [JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: [SECRET] }), 5, -32602],
    [JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: SECRET, arguments: {} } }), 6, -32602],
    [JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bridge_status', arguments: {}, extra: SECRET } }), 7, -32602],
  ];
  for (const [line, id, code] of cases) {
    const reply = await f.server.handle(line);
    assert.equal(reply.id, id, line);
    protocolError(reply, code);
    assert.deepEqual(exposed(f, JSON.stringify(reply)), [], line);
  }
});

test('tools/list exposes closed schemas and truthful read/write annotations', async t => {
  const f = await fixture(t);
  await f.ready();
  const { tools } = (await f.rpc('tools/list')).result;
  assert.deepEqual(tools.map(tool => tool.name), TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.description, 'string');
  }
  const [status, lanes, watchLines, heartbeat, enqueue, receipt, cancel] = tools;
  assert.deepEqual(Object.keys(status.inputSchema.properties), []);
  assert.deepEqual(Object.keys(lanes.inputSchema.properties), []);
  assert.deepEqual(Object.keys(watchLines.inputSchema.properties), []);
  assert.deepEqual(enqueue.inputSchema.required.sort(), ['id', 'prompt']);
  assert.equal(enqueue.inputSchema.properties.prompt.maxLength, 6000);
  assert.deepEqual(receipt.inputSchema.required, ['id']);
  assert.deepEqual(cancel.inputSchema.required, ['id']);
  assert.equal(status.annotations.readOnlyHint, true);
  assert.equal(lanes.annotations.readOnlyHint, true);
  assert.equal(watchLines.annotations.readOnlyHint, false, 'it advances the local cursor, so it is not read-only');
  assert.equal(watchLines.annotations.idempotentHint, false);
  assert.equal(watchLines.annotations.destructiveHint, false);
  assert.equal(heartbeat.annotations.readOnlyHint, false);
  assert.equal(receipt.annotations.readOnlyHint, true);
  assert.equal(enqueue.annotations.readOnlyHint, false);
  assert.equal(cancel.annotations.readOnlyHint, false);
});
test('bridge_lanes_status reports bounded lane state and queue attention without task text or UNKNOWN replay', async t => {
  const f = await fixture(t);
  await f.ready();
  const config = await readJson(path.join(f.state, 'config.json'));
  const store = new Store(config, () => NOW);
  const queued = id => ({ version: 1, id, sessionId, expiresAt: NOW + 60000,
    steps: [{ prompt: SECRET, continueAfterEnd: false }] });
  await store.enqueue(queued(PLAN));
  await store.enqueue(queued(PLAN2));
  await store.save({ version: 1, id: PLAN2, sessionId, state: 'failed', reason: 'message_not_confirmed_in_transcript',
    nextStep: 0, updatedAt: NOW, outcomes: [], taskSuccess: 'unverified', automaticReplay: false });
  const event = { version: 1, seq: 1, time: NOW - 1000, pid: process.pid, sessionId, event: 'busy', planId: PLAN, reason: 'plan_active' };
  await fs.writeFile(path.join(f.state, 'control', 'lane-events.jsonl'), JSON.stringify(event) + '\n');
  await fs.writeFile(path.join(f.state, `supervisor-${sessionId}.lock`), 'fixture lock');
  const report = ok(await f.call('bridge_lanes_status'));
  assert.equal(report.anyRunning, true);
  assert.equal(report.nextWakeUpSeconds, 120);
  assert.equal(report.lanes.length, 1);
  const { eventId, ...lane } = report.lanes[0];
  assert.equal(eventId, null);
  assert.deepEqual(lane, { connection: 'default', status: 'busy', lastEventTime: NOW - 1000,
    lastPlanId: PLAN, lastPlanState: 'busy', queuedCount: 1, needsAttention: false,
    model: { actual: null, requested: null, state: null, holdingPlans: false } });
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.equal(JSON.stringify(report).includes(sessionId), false, 'the assistant is never given the OMP session id');
  assert.equal((await store.receipt(PLAN2)).state, 'failed');
});

test('a receipt an older version wrote as unknown is shown as failed with the new reason, and a failed last plan needs attention', async t => {
  const f = await fixture(t);
  await f.ready();
  const store = new Store(await readJson(path.join(f.state, 'config.json')), () => NOW);
  await store.enqueue({ version: 1, id: PLAN, sessionId, expiresAt: NOW + 60000, steps: [{ prompt: SECRET, continueAfterEnd: false }] });
  const file = path.join(f.state, 'receipts', PLAN + '.json');
  for (const [oldReason, reason] of [['uncorrelated_end', 'end_not_matched_to_message'], ['admission_unconfirmed', 'message_not_confirmed_in_transcript'], ['restart', 'restart']]) {
    await fs.writeFile(file, JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'unknown', reason: oldReason, nextStep: 0, updatedAt: NOW,
      outcomes: [], taskSuccess: 'unverified', automaticReplay: false }) + '\n');
    const receipt = ok(await f.call('bridge_receipt', { id: PLAN }));
    assert.deepEqual([receipt.state, receipt.reason, receipt.automaticReplay], ['failed', reason, false]);
  }
  assert.deepEqual(ok(await f.call('bridge_status')).plans.map(row => row.state), ['failed']);
  const event = { version: 1, seq: 1, time: NOW, pid: process.pid, sessionId, event: 'plan_unknown', planId: PLAN, state: 'unknown', reason: 'restart' };
  await fs.writeFile(path.join(f.state, 'control', 'lane-events.jsonl'), JSON.stringify(event) + '\n');
  const lane = ok(await f.call('bridge_lanes_status')).lanes[0];
  assert.deepEqual([lane.lastPlanState, lane.needsAttention], ['failed', true]);
});

test('a receipt an older version wrote as exhausted, with unknown outcome values, is shown as completed with not_seen, and an old exhausted lane row reads as completed', async t => {
  const f = await fixture(t);
  await f.ready();
  const store = new Store(await readJson(path.join(f.state, 'config.json')), () => NOW);
  await store.enqueue({ version: 1, id: PLAN, sessionId, expiresAt: NOW + 60000, steps: [{ prompt: SECRET, continueAfterEnd: false }] });
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'exhausted', reason: 'all_planned_submissions_ended_success_unverified',
    nextStep: 1, updatedAt: NOW, outcomes: [{ step: 0, submission: 'returned', terminalObservation: 'unknown' }], taskSuccess: 'unverified', automaticReplay: false }) + '\n');
  const receipt = ok(await f.call('bridge_receipt', { id: PLAN }));
  assert.deepEqual([receipt.state, receipt.outcomes[0].terminalObservation], ['completed', 'not_seen']);
  const event = { version: 1, seq: 1, time: NOW, pid: process.pid, sessionId, event: 'plan_done', planId: PLAN, state: 'exhausted' };
  await fs.writeFile(path.join(f.state, 'control', 'lane-events.jsonl'), JSON.stringify(event) + '\n');
  assert.equal(ok(await f.call('bridge_lanes_status')).lanes[0].lastPlanState, 'completed');
});

test('bridge_lanes_status skips one unreadable receipt, reports it, still counts the other plans, and asks for attention', async t => {
  const f = await fixture(t);
  await f.ready();
  const store = new Store(await readJson(path.join(f.state, 'config.json')), () => NOW);
  for (const id of [PLAN, PLAN2]) await store.enqueue({ version: 1, id, sessionId, expiresAt: NOW + 60000, steps: [{ prompt: SECRET, continueAfterEnd: false }] });
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({ version: 1, id: PLAN2, sessionId, state: 'failed' }) + '\n');
  const lane = ok(await f.call('bridge_lanes_status')).lanes[0];
  assert.deepEqual(lane.unreadable.map(row => [row.id, row.state]), [[PLAN, 'unreadable']]);
  assert.ok(lane.unreadable[0].problem);
  assert.equal(lane.queuedCount, 1);
  assert.equal(lane.needsAttention, true);
});

test('bridge_lane_watch_lines prints each new lane line once, nothing when nothing changed, and takes no arguments', async t => {
  const f = await fixture(t);
  await f.ready();
  assert.deepEqual(ok(await f.call('bridge_lane_watch_lines')), { lines: [] });
  const row = kind => formatWatchLine({ time: NOW, seq: kind === 'IDLE' ? 2 : 1, kind, fields: kind === 'IDLE' ? { pid: 4242, since: new Date(NOW - 10000).toISOString(), src: 'events' } : { pid: 4242 } });
  await fs.writeFile(path.join(f.state, 'control', 'lane-watch.log'), row('START') + '\n' + row('IDLE') + '\n');
  assert.deepEqual(ok(await f.call('bridge_lane_watch_lines')), { lines: ['default ' + row('IDLE')] }, 'START is never shown');
  assert.deepEqual(ok(await f.call('bridge_lane_watch_lines')), { lines: [] }, 'shown once');
  for (const args of [{ connection: 'default' }, { id: PLAN }, { peek: true }, []]) {
    const reply = await f.call('bridge_lane_watch_lines', args);
    assert.equal(protocolError(reply, -32602), 'Invalid params', JSON.stringify(args));
  }
  assert.deepEqual(exposed(f, JSON.stringify(ok(await f.call('bridge_lane_watch_lines')))), []);
});

test('bridge_lane_watch_lines tells the coordinator in plain words when the lane watch records are damaged', async t => {
  const f = await fixture(t);
  await f.ready();
  await fs.writeFile(path.join(f.state, 'control', 'lane-watch.log'), 'x'.repeat(2 * 65536 + 1));
  assert.equal(toolError(await f.call('bridge_lane_watch_lines')), 'lane watch records differ; inspect locally');
});

test('bridge_lane_watch_lines says whether a lane log could not be read or its place could not be saved', async t => {
  const f = await fixture(t), log = path.join(f.state, 'control', 'lane-watch.log'), cursor = path.join(f.state, 'control', 'lane-watch-cursor.json');
  await f.ready();
  const row = kind => formatWatchLine({ time: NOW, seq: kind === 'IDLE' ? 2 : 1, kind, fields: kind === 'IDLE' ? { pid: 4242, since: new Date(NOW - 10000).toISOString(), src: 'events' } : { pid: 4242 } });
  await fs.writeFile(log, row('START') + '\n' + row('IDLE') + '\n');
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (String(to) === cursor) throw Object.assign(new Error('disk'), { code: 'EIO' }); return rename.call(fs, from, to); };
  let unsaved;
  try { unsaved = ok(await f.call('bridge_lane_watch_lines')); } finally { fs.rename = rename; }
  assert.deepEqual(unsaved.lines, []);
  assert.match(unsaved.unreadable[0].problem, /place could not be saved.*lines not shown here were held back and will come again/);
  assert.deepEqual(ok(await f.call('bridge_lane_watch_lines')), { lines: ['default ' + row('IDLE')] }, 'the held line comes on the next call');
  await fs.rm(log); await fs.mkdir(log);
  const unread = ok(await f.call('bridge_lane_watch_lines'));
  assert.deepEqual(unread.unreadable.map(item => [item.lane, item.problem]), [['default', 'This lane\'s log could not be read. The other lanes are shown normally.']]);
});

test('bridge_lane_watch_lines returns at most 100 lines and says "more" while lines are still waiting', async t => {
  const f = await fixture(t), log = path.join(f.state, 'control', 'lane-watch.log');
  await f.ready();
  const row = seq => formatWatchLine({ time: NOW, seq, kind: 'IDLE', fields: { pid: 4242, since: new Date(NOW - 10000).toISOString(), src: 'events' } });
  await fs.writeFile(log, Array.from({ length: 101 }, (_, i) => row(i + 1)).join('\n') + '\n');
  const first = ok(await f.call('bridge_lane_watch_lines'));
  assert.equal(first.lines.length, 100); assert.equal(first.more, true);
  assert.deepEqual(ok(await f.call('bridge_lane_watch_lines')), { lines: ['default ' + row(101)] }, 'the last line comes next, and "more" is gone');
});

test('only the directing coordinator can refresh its marker without changing plans or receipts', async t => {
  const f = await fixture(t);
  await f.ready();
  const marker = path.join(f.state, 'control', 'coordinator-active.json');
  const readonly = createServer({ stateRoot: f.state, now: () => NOW });
  await readonly.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }));
  await notify(readonly, 'notifications/initialized');
  const rejected = await readonly.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_coordinator_heartbeat', arguments: {} } }));
  assert.equal(toolError(rejected), 'controller credential required');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.deepEqual(ok(await f.call('bridge_coordinator_heartbeat')), { active: true, expiresAt: NOW + 180000 });
  assert.deepEqual(await readJson(marker), { version: 1, updatedAt: NOW });
  for (const directory of ['plans', 'receipts']) assert.deepEqual(await fs.readdir(path.join(f.state, directory)), []);
  await fs.writeFile(marker, JSON.stringify({ private: SECRET }));
  assert.equal(toolError(await f.call('bridge_coordinator_heartbeat')), 'invalid coordinator heartbeat');
  assert.equal(await fs.readFile(marker, 'utf8'), JSON.stringify({ private: SECRET }));
});

test('invalid tool arguments are rejected before touching state, including cross-session and path arguments', async t => {
  const f = await fixture(t);
  await f.ready();
  const invalid = [
    ['bridge_status', { sessionId: otherId }], ['bridge_status', { root: f.base }], ['bridge_status', []],
    ['bridge_enqueue', undefined], ['bridge_enqueue', { id: PLAN }], ['bridge_enqueue', { prompt: 'x' }],
    ['bridge_enqueue', { id: PLAN, prompt: 'x', sessionId: otherId }], ['bridge_enqueue', { id: PLAN, prompt: 'x', continueAfterEnd: true }],
    ['bridge_enqueue', { id: PLAN, prompt: 'x', expiresAt: NOW + 86400000 }], ['bridge_enqueue', { id: PLAN, prompt: 'x', steps: [] }],
    ['bridge_enqueue', { id: PLAN.toUpperCase(), prompt: 'x' }], ['bridge_enqueue', { id: 'not-a-uuid', prompt: 'x' }],
    ['bridge_enqueue', { id: PLAN, prompt: 7 }], ['bridge_enqueue', { id: PLAN, prompt: '' }], ['bridge_enqueue', { id: PLAN, prompt: '  ' }],
    ['bridge_enqueue', { id: PLAN, prompt: 'x'.repeat(6001) }], ['bridge_enqueue', { id: PLAN, prompt: SECRET + '\u0007' }],
    ['bridge_enqueue', { id: PLAN + '\n', prompt: 'x' }], ['bridge_enqueue', { id: PLAN, prompt: ['x'] }],
    ['bridge_receipt', {}], ['bridge_receipt', { id: '../' + PLAN }], ['bridge_receipt', { id: PLAN, path: f.state }],
    ['bridge_cancel', { id: 42 }], ['bridge_cancel', { id: PLAN, sessionId }],
  ];
  for (const [name, args] of invalid) {
    const reply = await f.call(name, args);
    assert.equal(protocolError(reply, -32602), 'Invalid params', JSON.stringify(args));
    assert.deepEqual(exposed(f, JSON.stringify(reply)), []);
  }
  for (const dir of ['plans', 'receipts', 'control']) assert.deepEqual(await fs.readdir(path.join(f.state, dir)), [], dir);
});

test('enqueue writes one finite 24-hour single-prompt plan; retries with the same id are duplicates, never new work', async t => {
  const f = await fixture(t);
  await f.ready();
  const first = ok(await f.call('bridge_enqueue', { id: PLAN, prompt: SECRET }));
  assert.deepEqual(first, { id: PLAN, state: 'queued', duplicate: false, expiresAt: NOW + QUEUE_LIMIT_MS, steps: 1, continueAfterEnd: false,
    note: first.note });
  assert.match(first.note, /taskSuccess|unverified/);
  const file = path.join(f.state, 'plans', PLAN + '.json');
  const written = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(written), { version: 1, id: PLAN, sessionId, expiresAt: NOW + QUEUE_LIMIT_MS, steps: [{ prompt: SECRET, continueAfterEnd: false }] });

  const retry = ok(await f.call('bridge_enqueue', { id: PLAN, prompt: SECRET }));
  assert.equal(retry.duplicate, true);
  assert.equal(toolError(await f.call('bridge_enqueue', { id: PLAN, prompt: 'different work' })), 'plan id already used for different content');
  assert.equal(await fs.readFile(file, 'utf8'), written);
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [PLAN + '.json']);
  // The task ended and its plan was retired to make room: the id stays spent, and a retry is refused, never queued again.
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'completed', nextStep: 1, updatedAt: NOW, outcomes: [], taskSuccess: 'unverified', automaticReplay: false }) + '\n');
  // A finished task whose plan is still there has ended too: nothing is cancelled and no cancel record is written.
  assert.equal(toolError(await f.call('bridge_cancel', { id: PLAN })), 'That task already ended, so there is nothing to cancel.');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'control')), []);
  assert.equal(ok(await f.call('bridge_receipt', { id: PLAN })).cancelRequested, false);
  await fs.rm(file);
  assert.equal(toolError(await f.call('bridge_enqueue', { id: PLAN, prompt: SECRET })), 'plan id already used');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), []);
  // Its receipt is still readable through the tools, and cancelling says the task already ended.
  assert.equal(ok(await f.call('bridge_receipt', { id: PLAN })).state, 'completed');
  assert.equal(toolError(await f.call('bridge_cancel', { id: PLAN })), 'That task already ended, so there is nothing to cancel.');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'control')), []);
  // A task that is still running is never called ended just because its plan file is missing; the person is told it could not be found.
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'submitted', nextStep: 0, updatedAt: NOW, outcomes: [], taskSuccess: 'unverified', automaticReplay: false }) + '\n');
  assert.equal(toolError(await f.call('bridge_cancel', { id: PLAN })), 'That task could not be found to cancel.');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'control')), []);
  // A damaged receipt behind a missing plan is not called ended or missing.
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'completed', nextStep: 1, updatedAt: NOW, outcomes: [], taskSuccess: 'yes', automaticReplay: false }) + '\n');
  assert.equal(toolError(await f.call('bridge_cancel', { id: PLAN })), 'receipt not recognized');

  // Concurrent duplicate calls are serialized: exactly one creates the plan.
  const replies = await Promise.all([1, 2, 3].map(() => f.call('bridge_enqueue', { id: PLAN2, prompt: 'Synthetic fixture prompt.' })));
  assert.deepEqual(replies.map(reply => ok(reply).duplicate).sort(), [false, true, true]);
  for (const reply of [first, retry]) assert.deepEqual(exposed(f, JSON.stringify(reply)), []);
});

test('status and receipt expose only bounded safe metadata', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_enqueue', { id: PLAN, prompt: SECRET }));
  ok(await f.call('bridge_enqueue', { id: PLAN2, prompt: SECRET }));
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({
    version: 1, id: PLAN, sessionId, state: 'failed', reason: 'message_not_confirmed_in_transcript', nextStep: 0, updatedAt: NOW,
    outcomes: [{ step: 0, submission: 'returned', terminalObservation: 'not_seen' }], taskSuccess: 'unverified', automaticReplay: false,
  }) + '\n');
  const status = ok(await f.call('bridge_status'));
  assert.equal(ok(await f.call('bridge_status', {})).plans.length, 2);
  assert.equal(status.supervisorLock, 'absent');
  assert.deepEqual(status.plans.map(row => [row.id, row.state, row.taskSuccess]), [[PLAN, 'failed', 'unverified'], [PLAN2, 'queued', 'unverified']]);
  const receipt = ok(await f.call('bridge_receipt', { id: PLAN }));
  assert.deepEqual(receipt, { id: PLAN, state: 'failed', reason: 'message_not_confirmed_in_transcript', nextStep: 0, updatedAt: NOW,
    outcomes: [{ step: 0, submission: 'returned', terminalObservation: 'not_seen' }], taskSuccess: 'unverified', automaticReplay: false,
    cancelRequested: false });
  assert.deepEqual(ok(await f.call('bridge_receipt', { id: PLAN2 })), { id: PLAN2, state: 'queued', taskSuccess: 'unverified', automaticReplay: false, cancelRequested: false });
  assert.equal(toolError(await f.call('bridge_receipt', { id: crypto.randomUUID() })), 'unknown plan id');

  // A receipt carrying unexpected content is refused, not relayed.
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), JSON.stringify({
    version: 1, id: PLAN, sessionId, state: 'failed', reason: SECRET + ' ' + f.base, nextStep: 0, updatedAt: NOW,
    outcomes: [], taskSuccess: 'unverified', automaticReplay: false,
  }) + '\n');
  const refused = await f.call('bridge_receipt', { id: PLAN });
  assert.equal(toolError(refused), 'receipt not recognized');
  // One unusable receipt hides nobody else: status reports that plan alone as unreadable and still shows the other plan.
  const listed = ok(await f.call('bridge_status'));
  assert.deepEqual(listed.plans.map(row => [row.id, row.state]), [[PLAN, 'unreadable'], [PLAN2, 'queued']]);
  for (const reply of [refused, await f.call('bridge_status')]) assert.deepEqual(exposed(f, JSON.stringify(reply)), []);
  await fs.writeFile(path.join(f.state, `supervisor-${sessionId}.lock`), '{}');
  await fs.rm(path.join(f.state, 'receipts', PLAN + '.json'));
  assert.equal(ok(await f.call('bridge_status')).supervisorLock, 'present');
});

test('internal transcript integrity metadata is validated but never relayed', async t => {
  const f = await fixture(t); await f.ready();
  ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'Synthetic fixture prompt.' }));
  const fence = { fileDev: '1', fileIno: '2', start: 0, offset: 100,
    prefixHash: 'a'.repeat(64), textHash: 'b'.repeat(64) };
  const progress = { fileDev: '1', fileIno: '2', fenceOffset: 100, processedOffset: 150, appendHash: 'c'.repeat(64) };
  const proof = { fileDev: '1', fileIno: '2', fenceOffset: 100, endOffset: 200, appendHash: 'd'.repeat(64) };
  const outcome = { step: 0, submission: 'returned', terminalObservation: 'not_seen',
    admissionFence: fence, admissionProgress: progress, admissionProof: proof };
  const file = path.join(f.state, 'receipts', PLAN + '.json');
  const row = { version: 1, id: PLAN, sessionId, state: 'failed', reason: 'message_not_confirmed_in_transcript',
    nextStep: 0, updatedAt: NOW, outcomes: [outcome], taskSuccess: 'unverified', automaticReplay: false };
  await fs.writeFile(file, JSON.stringify(row) + '\n');
  const receipt = ok(await f.call('bridge_receipt', { id: PLAN }));
  assert.deepEqual(receipt.outcomes, [{ step: 0, submission: 'returned', terminalObservation: 'not_seen' }]);
  const returned = JSON.stringify(receipt);
  for (const secret of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'fileDev', 'processedOffset'])
    assert.equal(returned.includes(secret), false);
  await fs.writeFile(file, JSON.stringify({ ...row, outcomes: [{ ...outcome,
    admissionProof: { ...proof, path: 'C:/private/session.jsonl' } }] }) + '\n');
  assert.equal(toolError(await f.call('bridge_receipt', { id: PLAN })), 'receipt not recognized');
  const native = {kind:'native-lineage-v1',host:'omp/18.13.3',operationId:crypto.randomUUID(),ownerEpoch:3,
    managerToken:crypto.randomUUID(),sessionId,planId:PLAN,step:0,cwd:f.base,file:path.join(f.base,'native.jsonl'),
    originalFence:fence,anchorId:'anchor',prefixCount:3,prefixDigest:'a'.repeat(64),idSetDigest:'a'.repeat(64),
    userId:'new-user',userParentId:'anchor',textLength:5,textHash:fence.textHash,userDigest:'a'.repeat(64),
    ancestryDigest:'a'.repeat(64),branchDigest:'a'.repeat(64),leafId:'final',nativeDigest:'a'.repeat(64),
    headerDigest:'a'.repeat(64),fileDev:'1',fileIno:'3',byteLength:300,contentDigest:'a'.repeat(64)};
  const nativeOutcome={step:0,submission:'returned',terminalObservation:'not_seen',admissionFence:fence,admissionProof:native};
  await fs.writeFile(file,JSON.stringify({...row,outcomes:[nativeOutcome]})+'\n');
  const nativeReceipt=ok(await f.call('bridge_receipt',{id:PLAN}));
  assert.deepEqual(nativeReceipt.outcomes,receipt.outcomes);
  assert.equal(JSON.stringify(nativeReceipt).includes('native-lineage'),false);
  assert.equal(JSON.stringify(nativeReceipt).includes(f.base),false);
  await fs.writeFile(file,JSON.stringify({...row,outcomes:[{...nativeOutcome,admissionProof:{...native,host:'not-omp/18.13.4'}}]})+'\n');
  assert.equal(toolError(await f.call('bridge_receipt',{id:PLAN})),'receipt not recognized');
  await fs.writeFile(file,JSON.stringify({...row,outcomes:[{...nativeOutcome,admissionProof:{...native,planId:PLAN2}}]})+'\n');
  assert.equal(toolError(await f.call('bridge_receipt',{id:PLAN})),'receipt not recognized');
  await fs.writeFile(file,JSON.stringify({...row,outcomes:[{...nativeOutcome,admissionProof:{...native,unexpected:SECRET}}]})+'\n');
  assert.equal(toolError(await f.call('bridge_receipt',{id:PLAN})),'receipt not recognized');
});

const receiptRow = reason => JSON.stringify({ version: 1, id: PLAN, sessionId, state: 'failed', reason, nextStep: 0, updatedAt: NOW,
  outcomes: [], taskSuccess: 'unverified', automaticReplay: false }) + '\n';

test('receipt reasons are relayed only from the core reason codes; any other lowercase text is refused', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'Synthetic fixture prompt.' }));
  const file = path.join(f.state, 'receipts', PLAN + '.json');
  for (const reason of ['restart', 'message_not_confirmed_in_transcript', 'all_planned_submissions_ended_success_unverified', 'supervisor_shutdown']) {
    await fs.writeFile(file, receiptRow(reason));
    assert.equal(ok(await f.call('bridge_receipt', { id: PLAN })).reason, reason);
  }
  const secret = 'owner_private_lowercase_note';
  for (const reason of [secret, 'toString', 'constructor', '']) {
    await fs.writeFile(file, receiptRow(reason));
    const refused = await f.call('bridge_receipt', { id: PLAN });
    assert.equal(toolError(refused), 'receipt not recognized', reason);
    assert.deepEqual(ok(await f.call('bridge_status')).plans.map(row => row.state), ['unreadable'], reason);
    for (const reply of [refused, await f.call('bridge_status')]) assert.equal(JSON.stringify(reply).includes(secret), false);
  }
});

test('a malformed-end receipt is relayed with its own state and reason, and status lists it as malformed', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'Synthetic fixture prompt.' }));
  await fs.writeFile(path.join(f.state, 'receipts', PLAN + '.json'), receiptRow('malformed_end').replace('"failed"', '"malformed"'));
  const receipt = ok(await f.call('bridge_receipt', { id: PLAN }));
  assert.deepEqual([receipt.state, receipt.reason, receipt.automaticReplay], ['malformed', 'malformed_end', false]);
  assert.deepEqual(ok(await f.call('bridge_status')).plans.map(row => row.state), ['malformed']);
});

test('a duplicate enqueue relays the prior plan only in its exact finite single-prompt shape', async t => {
  const f = await fixture(t);
  await f.ready();
  const file = path.join(f.state, 'plans', PLAN + '.json');
  const secret = 'owner private lowercase expiry note';
  const prior = (changes, step = {}) => JSON.stringify({ version: 1, id: PLAN, sessionId, expiresAt: NOW + 1000,
    steps: [{ prompt: 'x', continueAfterEnd: false, ...step }], ...changes }) + '\n';
  for (const text of [prior({ expiresAt: { note: secret } }), prior({ expiresAt: secret }), prior({ expiresAt: [NOW] }),
    prior({ expiresAt: 1.5 }), prior({ expiresAt: Number.MAX_SAFE_INTEGER + 2 }), prior({ note: secret }), prior({}, { note: secret }),
    prior({ version: 2 }), prior({ steps: [{ prompt: 'x', continueAfterEnd: false }, { prompt: 'x', continueAfterEnd: false }] })]) {
    await fs.writeFile(file, text);
    const reply = await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' });
    assert.equal(toolError(reply), 'plan id already used for different content', text);
    assert.equal(JSON.stringify(reply).includes(secret), false);
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  // An expired but legitimate plan is still a duplicate: reported, never resubmitted.
  await fs.writeFile(file, prior({ expiresAt: NOW - 1000 }));
  const expired = ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' }));
  assert.equal(expired.duplicate, true);
  assert.equal(expired.expiresAt, NOW - 1000);
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [PLAN + '.json']);
});

test('plans of another session or of unknown shape are never shown as queued, cancelled or reused', async t => {
  const f = await fixture(t);
  await f.ready();
  const file = path.join(f.state, 'plans', PLAN + '.json');
  const valid = { version: 1, id: PLAN, sessionId, expiresAt: NOW + 1000, steps: [{ prompt: 'x', continueAfterEnd: false }] };
  const step = changes => ({ ...valid, steps: [{ prompt: 'x', continueAfterEnd: false, ...changes }] });
  const foreign = [{ ...valid, sessionId: otherId }, { ...valid, id: PLAN2 }, { ...valid, steps: undefined }, { ...valid, extra: SECRET },
    { ...valid, expiresAt: SECRET }, { ...valid, version: 2 }, { ...valid, steps: [] }, { ...valid, steps: Array(9).fill(valid.steps[0]) },
    step({ prompt: '   ' }), step({ prompt: 'x\u0007' }), step({ prompt: 'x'.repeat(6001) }), step({ prompt: 7 }),
    step({ continueAfterEnd: 'no' }), step({ note: SECRET }), [valid], 'x'];
  for (const value of foreign) {
    const text = JSON.stringify(value) + '\n';
    await fs.writeFile(file, text);
    const replies = [await f.call('bridge_receipt', { id: PLAN }), await f.call('bridge_cancel', { id: PLAN })];
    for (const reply of replies) {
      assert.equal(toolError(reply), 'plan not recognized', text);
      const out = JSON.stringify(reply);
      assert.deepEqual([...exposed(f, out), otherId, PLAN2].filter(value => out.includes(value)), []);
    }
    // The status list reports that one plan as unreadable (never as queued) and shows nothing from the file.
    const listed = JSON.stringify(ok(await f.call('bridge_status')));
    assert.deepEqual(ok(await f.call('bridge_status')).plans.map(row => row.state), ['unreadable'], text);
    assert.deepEqual([...exposed(f, listed), otherId, PLAN2].filter(value => listed.includes(value)), []);
    assert.equal(toolError(await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' })), 'plan id already used for different content');
    assert.equal(await fs.readFile(file, 'utf8'), text);
    for (const dir of ['receipts', 'control']) assert.deepEqual(await fs.readdir(path.join(f.state, dir)), [], dir);
  }
  // A source over the 64 KiB record limit is refused too, never listed as queued.
  const oversized = JSON.stringify({ ...valid, steps: Array(8).fill({ prompt: '\u00e9'.repeat(6000), continueAfterEnd: false }) }) + '\n';
  await fs.writeFile(file, oversized);
  for (const reply of [await f.call('bridge_receipt', { id: PLAN }), await f.call('bridge_cancel', { id: PLAN })])
    assert.equal(toolError(reply), 'file too large');
  assert.deepEqual(ok(await f.call('bridge_status')).plans.map(row => row.state), ['unreadable']);
  // This session's exact shape is an ordinary queued plan, including after expiry.
  for (const expiresAt of [NOW + 1000, NOW - 1000]) {
    await fs.writeFile(file, JSON.stringify({ ...valid, expiresAt }) + '\n');
    assert.equal(ok(await f.call('bridge_receipt', { id: PLAN })).state, 'queued');
  }
});

test('cancel records future-step cancellation only and is idempotent', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'Synthetic fixture prompt.' }));
  const cancel = ok(await f.call('bridge_cancel', { id: PLAN }));
  assert.equal(cancel.cancelRequested, true);
  assert.equal(cancel.alreadyRequested, false);
  assert.match(cancel.note, /future bridge steps only/);
  assert.match(cancel.note, /OMP's own controls/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.state, 'control', PLAN + '.json'), 'utf8')), { version: 1, id: PLAN, sessionId, action: 'abort' });
  assert.equal(ok(await f.call('bridge_cancel', { id: PLAN })).alreadyRequested, true);
  assert.equal(ok(await f.call('bridge_receipt', { id: PLAN })).cancelRequested, true);
  assert.equal(toolError(await f.call('bridge_cancel', { id: PLAN2 })), 'unknown plan id');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'control')), [PLAN + '.json']);
});

test('every call revalidates the pinned setup and session identity', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_status'));
  // Changing the saved session's identity after setup refuses subsequent calls.
  const original = await fs.readFile(f.session);
  await fs.writeFile(f.session, f.header(otherId));
  for (const [name, args] of [['bridge_status'], ['bridge_enqueue', { id: PLAN, prompt: 'x' }], ['bridge_receipt', { id: PLAN }], ['bridge_cancel', { id: PLAN }]])
    assert.equal(toolError(await f.call(name, args)), 'transcript identity mismatch', name);
  await fs.writeFile(f.session, original);
  ok(await f.call('bridge_status'));
  // Foreign config, stray files and unconfigured roots are refused.
  const configFile = path.join(f.state, 'config.json');
  const config = await fs.readFile(configFile);
  // A config naming another session also conflicts with the controller binding.
  await fs.writeFile(configFile, JSON.stringify({ sessionId: otherId, cwd: f.cwd, root: f.state }) + '\n');
  assert.equal(toolError(await f.call('bridge_status')), 'not a complete bridge setup folder');
  await fs.writeFile(configFile, JSON.stringify({ sessionId, cwd: f.cwd, root: path.join(f.base, 'elsewhere') }) + '\n');
  assert.equal(toolError(await f.call('bridge_status')), 'not a complete bridge setup folder');
  await fs.writeFile(configFile, config);
  await fs.writeFile(path.join(f.state, 'stray.json'), '{}');
  assert.equal(toolError(await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' })), 'not a complete bridge setup folder');
  await fs.rm(path.join(f.state, 'stray.json'));
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), []);
  for (const stateRoot of [undefined, '', 'relative state', f.state + path.sep + '.', path.join(f.base, 'missing')]) {
    const server = createServer({ stateRoot, now: () => NOW });
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }));
    await notify(server, 'notifications/initialized');
    const reply = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } }));
    assert.equal(toolError(reply), 'bridge state not configured', String(stateRoot));
    assert.deepEqual(exposed(f, JSON.stringify(reply)), []);
  }
});

test('a running server stays pinned to its first session even when config and launch are jointly replaced', async t => {
  const f = await fixture(t);
  await f.ready();
  ok(await f.call('bridge_status'));
  const configFile = path.join(f.state, 'config.json'), launchFile = path.join(f.state, 'launch.json');
  const [config, launch] = [await fs.readFile(configFile, 'utf8'), await fs.readFile(launchFile, 'utf8')];
  // This test replaces an unowned setup; ownership must never migrate with a
  // rewritten session config (covered separately by controller tests).
  const ownerFile = path.join(f.state, `controller-${sessionId}.json`);
  const ownership = await fs.readFile(ownerFile); await fs.unlink(ownerFile);
  const otherCwd = path.join(f.base, 'other project'); await fs.mkdir(otherCwd);
  const otherSession = path.join(f.base, 'other session.jsonl');
  await fs.writeFile(otherSession, JSON.stringify({ type: 'session', version: 3, id: otherId, cwd: otherCwd }) + '\n');
  const executable = JSON.parse(launch).executable;
  const replacements = [
    [{ sessionId: otherId, cwd: otherCwd, root: f.state }, { version: 1, executable, sessionFile: otherSession }],
    [JSON.parse(config), { version: 1, executable: path.join(f.base, 'other omp.exe'), sessionFile: f.session }],
  ];
  for (const [settings, record] of replacements) {
    await fs.writeFile(configFile, JSON.stringify(settings) + '\n');
    await fs.writeFile(launchFile, JSON.stringify(record) + '\n');
    // The replacement is a coherent setup: a newly started server would accept it.
    const fresh = createServer({ stateRoot: f.state, now: () => NOW });
    await fresh.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }));
    await notify(fresh, 'notifications/initialized');
    ok(await fresh.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } })));
    for (const [name, args] of [['bridge_status'], ['bridge_enqueue', { id: PLAN, prompt: 'x' }], ['bridge_receipt', { id: PLAN }], ['bridge_cancel', { id: PLAN }]]) {
      const reply = await f.call(name, args);
      assert.equal(toolError(reply), MESSAGES.mismatch, name);
      assert.equal(JSON.stringify(reply).includes(otherId), false);
    }
    for (const dir of ['plans', 'control']) assert.deepEqual(await fs.readdir(path.join(f.state, dir)), [], dir);
  }
  await fs.writeFile(configFile, config);
  await fs.writeFile(launchFile, launch);
  await fs.writeFile(ownerFile, ownership);
  assert.equal(ok(await f.call('bridge_enqueue', { id: PLAN, prompt: 'x' })).duplicate, false);
});

// In-process stdio with a client that never reads stdout: output must stay
// bounded and no further input may be acted on until the client drains it.
function blockedStdio(f) {
  const input = new PassThrough();
  const held = [], lines = [], stderr = [];
  const output = new Writable({ highWaterMark: 64, write(chunk, _encoding, done) { held.push(done); } });
  const write = output.write.bind(output);
  output.write = text => { lines.push(JSON.parse(text)); return write(text); };
  serve({ input, output, errors: { write: text => { stderr.push(text); return true; } }, env: { OMP_BRIDGE_STATE: f.state, OMP_BRIDGE_CONTROLLER: f.controllerFile } });
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const send = async text => { input.write(text + '\n'); for (let i = 0; i < 4; i++) await tick(); };
  const drain = async until => {
    for (let i = 0; i < 2000 && !until(); i++) { while (held.length) held.shift()(); await tick(); }
  };
  return { input, output, lines, stderr, send, drain };
}
const tooLarge = (id, pad = 70000) => '{"jsonrpc":"2.0","id":' + id + ',"method":"ping","params":{"pad":"' + SECRET + 'x'.repeat(pad) + '"}}';
const enqueueLine = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bridge_enqueue', arguments: { id: PLAN, prompt: SECRET } } });

test('stdio pauses input while stdout is blocked; a flood of oversized frames neither acts nor queues output, and nothing is lost', async t => {
  const f = await fixture(t);
  const s = blockedStdio(f);
  t.after(() => { s.input.destroy(); s.output.destroy(); });
  await s.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }));
  await s.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  for (let i = 0; i < 40; i++) await s.send(tooLarge(100 + i));
  await s.send(enqueueLine(2));
  assert.deepEqual(s.lines.map(line => line.id), [1], 'no reply is written past backpressure');
  assert.deepEqual(s.stderr, [], 'no oversized frame was even read while stdout was blocked');
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [], 'nothing acted while stdout was blocked');
  // Once the client reads, the retained input resumes in order: every frame is
  // answered once and the request is served exactly once.
  await s.drain(() => s.lines.some(line => line.id === 2));
  assert.deepEqual(s.lines.map(line => line.id), [1, ...Array(40).fill(null), 2]);
  assert.equal(ok(s.lines.at(-1)).duplicate, false);
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [PLAN + '.json']);
  assert.ok(new Set(s.stderr).size === s.stderr.length, 'each fixed diagnostic is written at most once');
  assert.deepEqual(exposed(f, JSON.stringify(s.lines) + s.stderr.join('')), []);
});

test('one read carrying an oversized-frame flood is consumed only up to the pending bound while stdout is blocked', async t => {
  const f = await fixture(t);
  const s = blockedStdio(f);
  t.after(() => { s.input.destroy(); s.output.destroy(); });
  // 15 frames just over the 64 KiB frame limit keep the whole read under the retained-input cap.
  await s.send([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ...Array.from({ length: 15 }, (_, i) => tooLarge(i, 65600)), enqueueLine(2)].join('\n'));
  assert.deepEqual(s.lines.map(line => line.id), [1], 'no reply is written past backpressure');
  assert.deepEqual(s.stderr, ['omp-session-bridge mcp: request too large; discarded\n']);
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [], 'the request after the pending bound was not consumed');
  await s.drain(() => s.lines.some(line => line.id === 2));
  assert.deepEqual(s.lines.map(line => line.id), [1, ...Array(15).fill(null), 2]);
  for (const line of s.lines.slice(1, -1)) assert.deepEqual(line, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
  assert.equal(ok(s.lines.at(-1)).duplicate, false);
  assert.deepEqual(await fs.readdir(path.join(f.state, 'plans')), [PLAN + '.json']);
  assert.equal(s.stderr.length, 1);
});

test('a single read above the retained-input cap is never acted on and stops input', async t => {
  const f = await fixture(t);
  const s = blockedStdio(f);
  t.after(() => s.output.destroy());
  await s.send([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    enqueueLine(2), ...Array.from({ length: 20 }, (_, i) => tooLarge(i)), enqueueLine(3)].join('\n'));
  assert.equal(s.input.destroyed, true);
  assert.deepEqual(s.lines, []);
  assert.deepEqual(s.stderr, ['omp-session-bridge mcp: input too large; stopping\n']);
  for (const dir of ['plans', 'receipts', 'control']) assert.deepEqual(await fs.readdir(path.join(f.state, dir)), [], dir);
});

// Real stdio framing through bin/mcp.mjs: stdout must carry only JSON-RPC lines.
function child(env, children) {
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => proc.on('close', code => resolve(code)));
  // Always reap this exact owned child before removing its fixture, including
  // assertion failures before stdin.end(). Never leave an adapter running.
  children.push(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    let timer;
    try {
      proc.stdin.destroy(); proc.kill();
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned MCP fixture child did not close.')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  });
  // stdout chunks may end inside a JSON frame. Poll only complete frames;
  // the final assertions still require every response and a trailing newline.
  const lines = () => stdout.slice(0, stdout.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  // Ends when the child has sent nothing new for 60 s (or exited), so a slow PC that keeps answering is never cut off.
  const until = async count => {
    let seen = lines().length, deadline = Date.now() + 60000;
    while (lines().length < count && Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (lines().length > seen) { seen = lines().length; deadline = Date.now() + 60000; }
    }
    return lines();
  };
  return { proc, exited, until, output: () => ({ stdout, stderr }) };
}

test('stdio child process: newline JSON-RPC only on stdout, bounded frames and queue, fixed stderr', async t => {
  const f = await fixture(t);
  const env = { ...process.env, OMP_BRIDGE_STATE: f.state, OMP_BRIDGE_CONTROLLER: f.controllerFile };
  const c = child(env, f.children);
  const send = value => c.proc.stdin.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_enqueue', arguments: { id: PLAN, prompt: SECRET } } });
  // Oversized frame: discarded with one fixed error; the stream stays usable.
  send('{"jsonrpc":"2.0","id":4,"method":"ping","params":{"pad":"' + SECRET + 'x'.repeat(70000) + '"}}');
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bridge_receipt', arguments: { id: PLAN } } });
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bridge_cancel', arguments: { id: PLAN } } });
  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } });
  const replies = await c.until(7);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, null, 5, 6, 7]);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), TOOLS);
  assert.equal(ok(replies[2]).id, PLAN);
  assert.equal(protocolError(replies[3], -32600), 'Request too large');
  assert.equal(ok(replies[4]).state, 'queued');
  assert.equal(ok(replies[5]).cancelRequested, true);
  assert.deepEqual(ok(replies[6]).plans.map(row => row.id), [PLAN]);

  // A burst beyond the pending bound is read under flow control: every request is
  // answered in order, at most MAX_PENDING at a time, none refused or dropped.
  const burst = Array.from({ length: 40 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } })).join('\n');
  c.proc.stdin.write(burst + '\n');
  const all = await c.until(47);
  const burstReplies = all.slice(7);
  assert.deepEqual(burstReplies.map(reply => reply.id), Array.from({ length: 40 }, (_, i) => 100 + i));
  for (const reply of burstReplies) assert.deepEqual(ok(reply).plans.map(row => row.id), [PLAN]);

  c.proc.stdin.end();
  assert.equal(await c.exited, 0);
  const { stdout, stderr } = c.output();
  for (const line of stdout.split('\n').filter(Boolean)) {
    const value = JSON.parse(line);
    assert.equal(value.jsonrpc, '2.0');
    assert.ok('result' in value !== 'error' in value);
  }
  assert.ok(stdout.endsWith('\n'));
  assert.deepEqual(exposed(f, stdout + stderr), []);
  for (const line of stderr.split(/\r?\n/).filter(Boolean)) assert.match(line, /^omp-session-bridge mcp: [a-z ;,'-]+$/);
});

test('stdio child process without a configured state root serves protocol but refuses tools', async t => {
  const f = await fixture(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'OMP_BRIDGE_STATE'));
  const c = child(env, f.children);
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }) + '\n');
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } }) + '\n');
  const replies = await c.until(2);
  assert.equal(toolError(replies[1]), 'bridge state not configured');
  c.proc.stdin.end();
  assert.equal(await c.exited, 0);
  assert.match(c.output().stderr, /omp-session-bridge mcp: bridge state not configured/);
  assert.deepEqual(exposed(f, c.output().stdout + c.output().stderr), []);
});
