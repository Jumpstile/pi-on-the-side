import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { main } from '../src/cli.mjs';
const FIXTURE_HOST = 'omp/1.2.3';

// Builds the private .mcpb with the allowlist script into a temp folder
// outside the checkout, inspects the ZIP independently, and smokes the
// extracted server. Needs child processes; never installs or enables anything.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const PACK = path.join(CHECKOUT, 'scripts', 'pack-mcpb.mjs');
const EXPECTED = ['NOTICE.md', 'SECURITY.md', 'bin/mcp.mjs', 'docs/controllers.md', 'docs/desktop.md', 'manifest.json', 'package.json',
  'src/connections.mjs', 'src/control.mjs', 'src/controller.mjs', 'src/coordinator-heartbeat.mjs', 'src/host.mjs', 'src/lane-status.mjs', 'src/lane-watch.mjs', 'src/mcp.mjs', 'src/setup.mjs', 'src/transcript.mjs'];
// The update bundle: runtime code only. No tests, docs, manifest or scripts.
const RELEASE = ['NOTICE.md', 'SECURITY.md', 'bin/bridge.mjs', 'bin/coordinator-resume.mjs', 'bin/mcp.mjs', 'extension/bridge.ts', 'package.json', 'src/autosetup.mjs', 'src/cli.mjs', 'src/clients.mjs',
  'src/connections.mjs', 'src/control.mjs', 'src/controller.mjs', 'src/coordinator-heartbeat.mjs', 'src/coordinator-resume.mjs', 'src/coordinator-resume-setup.mjs', 'src/host.mjs', 'src/icon.mjs', 'src/lane-status.mjs', 'src/lane-watch.mjs', 'src/live.mjs', 'src/mcp.mjs', 'src/model-setup.mjs', 'src/setup.mjs', 'src/transcript.mjs', 'src/uninstall.mjs', 'src/update.mjs', 'src/zip.mjs'];
const TOOLS = ['bridge_status', 'bridge_lanes_status', 'bridge_lane_watch_lines', 'bridge_coordinator_heartbeat', 'bridge_enqueue', 'bridge_receipt', 'bridge_cancel'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pack = (...args) => new Promise(resolve => execFile(process.execPath, [PACK, ...args], { windowsHide: true },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

// Independent minimal reader: central directory -> local header -> data.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : assert.fail('compression method');
    assert.equal(data.length, size);
    assert.equal(zlib.crc32(data) >>> 0, crc);
    assert.ok(!entries.has(name), 'duplicate entry');
    entries.set(name, data);
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

async function temp(t, label) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('manifest declares a private node MCPB with required state and supported tools', async t => {
  const manifest = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8'));
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(typeof manifest.description, 'string');
  assert.equal(typeof manifest.author.name, 'string');
  assert.deepEqual(manifest.server, { type: 'node', entry_point: 'bin/mcp.mjs', mcp_config: {
    command: 'node', args: ['${__dirname}/bin/mcp.mjs'], env: { OMP_BRIDGE_STATE: '${user_config.state_root}', OMP_BRIDGE_CONTROLLER: '${user_config.controller_file}' } } });
  assert.deepEqual(Object.keys(manifest.user_config).sort(), ['controller_file', 'state_root']);
  assert.equal(manifest.user_config.controller_file.type, 'file');
  assert.equal(manifest.user_config.controller_file.required, false);
  const root = manifest.user_config.state_root;
  assert.equal(root.type, 'directory');
  assert.equal(root.required, true);
  assert.notEqual(root.multiple, true);
  assert.ok(root.title && root.description);
  assert.deepEqual(manifest.compatibility, { platforms: ['win32'], runtimes: { node: '>=22' } });
  assert.deepEqual(manifest.tools.map(tool => tool.name), TOOLS);
  assert.notEqual(manifest.tools_generated, true);
  assert.equal(manifest.prompts, undefined);
});

test('pack writes an allowlisted, reproducible archive outside the checkout and never overwrites', async t => {
  const out = await temp(t, 'omp bridge pack ');
  const first = path.join(out, 'bridge one.mcpb'), second = path.join(out, 'bridge two.mcpb');
  const result = await pack(first);
  assert.equal(result.code, 0, result.stderr);
  const bytes = await fs.readFile(first);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sha256, sha(bytes));
  const entries = unzip(bytes);
  assert.deepEqual([...entries.keys()].sort(), EXPECTED);
  for (const [name, data] of entries) assert.equal(sha(data), sha(await fs.readFile(path.join(CHECKOUT, name))), name);
  assert.deepEqual(report.files, EXPECTED.map(name => ({ path: name, sha256: sha(entries.get(name)) })));
  // Every relative import of a packaged module is itself packaged.
  for (const [name, data] of entries) {
    if (!name.endsWith('.mjs')) continue;
    for (const [, spec] of data.toString('utf8').matchAll(/\bfrom\s+'(\.[^']+)'/g))
      assert.ok(entries.has(path.posix.join(path.posix.dirname(name), spec)), `${name} imports ${spec}`);
  }
  assert.equal((await pack(second)).code, 0);
  assert.equal(sha(await fs.readFile(second)), report.sha256, 'same sources give the same archive hash');

  // No overwrite, no relative output, no output inside the checkout, no missing parent.
  assert.equal((await pack(first)).stderr.trim(), 'output already exists');
  assert.equal(sha(await fs.readFile(first)), report.sha256);
  const inside = path.join(CHECKOUT, 'bridge-' + crypto.randomUUID() + '.mcpb');
  for (const [args, message] of [[[inside], 'output must be outside the checkout'], [['relative.mcpb'], 'output must be an absolute .mcpb path'],
    [[path.join(out, 'x.zip')], 'output must be an absolute .mcpb path'], [[path.join(out, 'missing', 'x.mcpb')], 'output folder must exist'],
    [[], 'usage: node scripts/pack-mcpb.mjs <absolute-output.mcpb> | --release <absolute-output.zip>']]) {
    const refused = await pack(...args);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stderr.trim(), message);
  }
  await assert.rejects(fs.lstat(inside), e => e.code === 'ENOENT');
});

test('release pack writes the exact runtime allowlist under the versioned asset name only', async t => {
  const out = await temp(t, 'omp bridge release pack ');
  const pkg = JSON.parse(await fs.readFile(path.join(CHECKOUT, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg.engines, 'omp'), false, 'POTS has no list or pin of OMP versions');
  assert.equal(pkg.engines.node, '>=22');
  const file = path.join(out, `omp-session-bridge-${pkg.version}.zip`);
  const result = await pack('--release', file);
  assert.equal(result.code, 0, result.stderr);
  const bytes = await fs.readFile(file);
  assert.equal(JSON.parse(result.stdout).sha256, sha(bytes));
  const entries = unzip(bytes);
  assert.deepEqual([...entries.keys()].sort(), RELEASE.toSorted());
  for (const [name, data] of entries) {
    assert.equal(sha(data), sha(await fs.readFile(path.join(CHECKOUT, name))), name);
    for (const [, spec] of data.toString('utf8').matchAll(/\bfrom\s+'(\.[^']+)'/g))
      assert.ok(entries.has(path.posix.join(path.posix.dirname(name), spec)), `${name} imports ${spec}`);
  }
  assert.equal((await pack('--release', file)).stderr.trim(), 'output already exists');
  for (const name of ['bridge.zip', `omp-session-bridge-${pkg.version}.mcpb`, 'omp-session-bridge-9.9.9.zip']) {
    const refused = await pack('--release', path.join(out, name));
    assert.equal(refused.stderr.trim(), 'release output must be an absolute omp-session-bridge-<package version>.zip path');
  }
  assert.equal((await pack('--release', path.join(CHECKOUT, `omp-session-bridge-${pkg.version}.zip`))).stderr.trim(), 'output must be outside the checkout');
});

test('the extracted package serves supported tools against a disposable setup', async t => {
  const out = await temp(t, 'omp bridge extract ');
  const archive = path.join(out, 'bridge.mcpb');
  assert.equal((await pack(archive)).code, 0);
  const extracted = path.join(out, 'extracted');
  for (const [name, data] of unzip(await fs.readFile(archive))) {
    await fs.mkdir(path.dirname(path.join(extracted, name)), { recursive: true });
    await fs.writeFile(path.join(extracted, name), data);
  }
  const cwd = path.join(out, 'project'); await fs.mkdir(cwd);
  const session = path.join(out, 'session.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: '00000000-0000-4000-8000-000000000031', cwd }) + '\n');
  const state = path.join(out, 'state');
  const quiet = { stdout: () => {}, stderr: () => {} };
  assert.equal(await main(['setup', session, state], { ...quiet, locate: async () => path.join(out, 'omp.exe'), detect: async () => FIXTURE_HOST }), 0);

  const proc = spawn(process.execPath, [path.join(extracted, 'bin', 'mcp.mjs')], { env: { ...process.env, OMP_BRIDGE_STATE: state }, windowsHide: true });
  let stdout = '';
  proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolve => proc.on('close', resolve));
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } },
  ]) proc.stdin.write(JSON.stringify(message) + '\n');
  proc.stdin.end();
  assert.equal(await exited, 0);
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3]);
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'manifest.json'), 'utf8'));
  assert.deepEqual(replies[0].result.serverInfo, { name: manifest.name, version: manifest.version });
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), TOOLS);
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text).plans, []);
});
