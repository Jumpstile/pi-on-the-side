import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { initialize, writeJson } from '../src/control.mjs';
const FIXTURE_HOST = 'omp/1.2.3';
import { main, QUEUE_REFUSED } from '../src/cli.mjs';

// Child-process harness: needs process creation (no network, synthetic files).
const cli = path.resolve(import.meta.dirname, '../bin/bridge.mjs');
const SECRET = 'S3NT1N3L';
const NUMBER = 731713371337;
const sessionId = '00000000-0000-4000-8000-000000000005';
const run = (...args) => runWith(process.env, ...args);
const runWith = (env, ...args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { windowsHide: true, env },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
const clean = (result, expected) => {
  assert.notEqual(result.code, 0);
  assert.ok(!result.output.includes(SECRET.slice(0, 3)) && !result.output.includes(String(NUMBER).slice(0, 4)), 'input disclosed');
  assert.equal(result.output.trim(), expected);
};
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp-bridge-cli-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'work'); await fs.mkdir(cwd);
  const root = path.join(base, 'state'); await initialize(root);
  const configFile = path.join(base, 'config.json'); await writeJson(configFile, { sessionId, cwd, root });
  return { base, cwd, configFile };
}

test('malformed config JSON never echoes input', async t => {
  const { base } = await fixture(t);
  const file = path.join(base, 'bad-config.json'); await fs.writeFile(file, `{"cwd": ${SECRET}}`);
  clean(await run('status', file), 'malformed JSON input');
});
test('malformed plan JSON never echoes input', async t => {
  const { base, configFile } = await fixture(t);
  const file = path.join(base, 'bad-plan.json'); await fs.writeFile(file, `{"steps": [${SECRET}`);
  clean(await run('enqueue', configFile, file), 'malformed JSON input');
});
test('malformed transcript header never echoes input', async t => {
  const { base, configFile } = await fixture(t);
  const file = path.join(base, 'session.jsonl'); await fs.writeFile(file, `{"type":"session",${SECRET}\n`);
  clean(await run('launch-plan', configFile, file), 'transcript header invalid');
});
test('unexpected runtime errors print a fixed diagnostic only', async t => {
  const { base } = await fixture(t);
  // A numeric cwd reaches path.isAbsolute, whose TypeError quotes the value.
  const file = path.join(base, 'odd-config.json');
  await fs.writeFile(file, JSON.stringify({ sessionId, cwd: NUMBER, root: base }));
  clean(await run('status', file), 'unexpected error');
});
test('fixed validation diagnostics remain visible', async t => {
  const { base } = await fixture(t);
  const file = path.join(base, 'invalid-config.json'); await fs.writeFile(file, JSON.stringify({ secret: SECRET }));
  clean(await run('status', file), 'invalid config');
});

// Directory workflow through the real bin: production PATH lookup and real
// `--version` probe; no environment variable can attest the host.
async function setupFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'omp bridge cli setup ')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project dir'); await fs.mkdir(cwd);
  const session = path.join(base, 'saved session.jsonl');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  return { base, cwd, session, state: path.join(base, 'private state') };
}
test('setup without OMP on PATH prints a fixed diagnostic and creates nothing', async t => {
  const f = await setupFixture(t);
  const empty = path.join(f.base, 'empty bin'); await fs.mkdir(empty);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  clean(await runWith({ ...env, PATH: empty }, 'setup', f.session, f.state), 'OMP executable not found on PATH');
  await assert.rejects(fs.lstat(f.state), e => e.code === 'ENOENT');
});
test('production start re-probes the recorded executable and refuses a non-OMP host', async t => {
  const f = await setupFixture(t);
  // Setup recorded Node itself as the executable; the real probe must reject it.
  const quiet = { stdout: () => {}, stderr: () => {} };
  assert.equal(await main(['setup', f.session, f.state], { ...quiet, locate: async () => process.execPath, detect: async () => FIXTURE_HOST }), 0);
  for (const args of [['start', f.state], ['start', f.state, '--confirm-offline']])
    clean(await run(...args), 'unrecognized OMP executable or version response');
});
test('queue, status and cancel work on a setup folder through the real CLI without echoing prompts', async t => {
  const f = await setupFixture(t);
  const quiet = { stdout: () => {}, stderr: () => {} };
  assert.equal(await main(['setup', f.session, f.state], { ...quiet, locate: async () => process.execPath, detect: async () => FIXTURE_HOST }), 0);
  const credential = path.join(f.base, 'client.json');
  assert.equal((await run('controller-create', credential)).code, 0);
  assert.equal((await run('controller-acquire', f.state, credential)).code, 0);
  const env = { ...process.env, OMP_BRIDGE_CONTROLLER: credential };
  const unauthenticated = await run('command', f.state, '00000000-0000-4000-8000-000000000098', '/model openai-codex/gpt-6-luna');
  clean(unauthenticated, 'controller credential required');
  const commandId = '00000000-0000-4000-8000-000000000099';
  const command = await runWith(env, 'command', f.state, commandId, '/model', 'openai-codex/gpt-6-luna');
  assert.equal(command.code, 0, command.output);
  assert.equal(command.output.trim(), commandId);
  const duplicate = await runWith(env, 'command', f.state, commandId, '/model', 'openai-codex/gpt-6-luna');
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.output, /EEXIST/);
  const commandStatus = JSON.parse((await run('command-status', f.state, commandId)).output);
  assert.equal(commandStatus.state, 'queued');
  const commandCancel = JSON.parse((await runWith(env, 'command-cancel', f.state, commandId)).output);
  assert.deepEqual(commandCancel, { id: commandId, state: 'cancelled', cancelled: true });
  const queued = await runWith(env, 'queue', f.state, 'Synthetic fixture prompt with spaces.');
  assert.equal(queued.code, 3, queued.output);
  const id = queued.output.trim().split('\n')[0].trim();
  const status = JSON.parse((await run('status', f.state)).output);
  assert.deepEqual(status.map(row => [row.id, row.state, row.taskSuccess]), [[id, 'queued', 'unverified']]);
  const cancel = await runWith(env, 'cancel', f.state, id);
  assert.equal(cancel.code, 0, cancel.output);
  assert.match(cancel.output, /future bridge steps only/);
  clean(await runWith(env, 'queue', f.state, SECRET + '\u0001' + NUMBER), QUEUE_REFUSED['invalid step']);
});
