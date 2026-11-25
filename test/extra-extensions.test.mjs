import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { main } from '../src/cli.mjs';
import { registerConnection } from '../src/connections.mjs';
import { CHECKOUT } from '../src/setup.mjs';

const OWN = path.join(CHECKOUT, 'extension', 'bridge.ts');
const LIST = 'omp-session-bridge-extensions.json';

// A fake lane folder and a fake OMP, with an empty OMP agent folder of its own: no real OMP is started and nothing outside the temporary folder is read or touched.
async function world(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pots-extra-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd);
  const agent = path.join(base, 'agent'); await fs.mkdir(agent);
  const session = path.join(base, 'saved.jsonl'), sessionId = crypto.randomUUID(), state = path.join(base, 'state');
  await fs.writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
  const calls = [], quiet = { stdout: () => {}, stderr: () => {}, locate: async () => process.execPath, detect: async () => 'omp/19.2.0' };
  assert.equal(await main(['setup', session, state], quiet), 0);
  const root = path.join(base, 'install'); await fs.mkdir(root);
  await registerConnection(path.join(root, 'connections'), 'alpha', state);
  const out = [], err = [];
  const deps = { ...quiet, stdout: text => out.push(text), stderr: text => err.push(text), managed: path.join(root, 'runtime', 'current'),
    home: base, env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    watch: async () => ({ status: 'off', setChildPid() {}, stop: async () => {} }),
    launch: async call => { calls.push(call); return 0; }, lease: async () => ({ held: [], unknown: [] }) };
  const run = async (args, over = {}) => { out.length = err.length = 0; calls.length = 0; const code = await main(args, { ...deps, ...over }); return { code, out: out.join('\n'), err: err.join('\n'), calls: [...calls] }; };
  const extension = async name => { const file = path.join(base, name); await fs.writeFile(file, 'export default function () {}\n'); return file; };
  const list = value => fs.writeFile(path.join(agent, LIST), typeof value === 'string' ? value : JSON.stringify(value));
  return { base, agent, session, sessionId, state, run, extension, list };
}

test('with no extra extensions list, OMP gets exactly the bridge extension and nothing else', async t => {
  const w = await world(t);
  const done = await w.run(['start', w.state, '--confirm-offline']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.calls[0].args, ['--no-extensions', '--extension', OWN, '--resume', w.session]);
  assert.doesNotMatch(done.err, /extra/i);
  const preview = JSON.parse((await w.run(['start', w.state])).out);
  assert.equal('extraExtensions' in preview, false, 'the preview is unchanged when nothing is listed');
});

test('every listed extension is added with --extension after the bridge extension, for start, the preview and lane restore', async t => {
  const w = await world(t);
  const memory = await w.extension('memory hook.ts'), other = await w.extension('other.ts');
  await w.list({ extensions: [memory, other] });
  const done = await w.run(['start', w.state, '--confirm-offline', '--max-cost', '5']);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.calls[0].args, ['--no-extensions', '--extension', OWN, '--extension', memory, '--extension', other, '--resume', w.session, '--max-cost', '5']);
  assert.match(done.err, /Extra OMP extensions added to this lane/);
  const preview = JSON.parse((await w.run(['start', w.state])).out);
  assert.deepEqual(preview.extraExtensions, [memory, other]);
  assert.deepEqual(preview.args.slice(0, 7), ['--no-extensions', '--extension', OWN, '--extension', memory, '--extension', other]);
  const restored = await w.run(['lane', 'restore', 'alpha']);
  assert.equal(restored.code, 0, restored.err);
  assert.deepEqual(restored.calls[0].args, ['--no-extensions', '--extension', OWN, '--extension', memory, '--extension', other, '--restore', w.session]);
});

test('a missing file, a list that cannot be read, a wrong shape, a relative path or a repeat never stops the lane or removes the bridge extension', async t => {
  const w = await world(t);
  const good = await w.extension('good.ts');
  const cases = [
    ['an extension file that is not there', { extensions: [path.join(w.base, 'gone.ts'), good] }, [good], /was not found, so it was left out/],
    ['a list that is not JSON', '{ not json', [], /could not be read, so this lane starts without them/],
    ['a list of the wrong shape', { extensions: 'nope' }, [], /must look like/],
    ['a relative path', { extensions: ['hooks/memory.ts', good] }, [good], /not the full path of a file/],
    ['the bridge extension and a repeat', { extensions: [OWN, good, good] }, [good], null],
  ];
  for (const [name, content, expected, note] of cases) {
    await w.list(content);
    const done = await w.run(['start', w.state, '--confirm-offline']);
    assert.equal(done.code, 0, name + ': ' + done.err);
    assert.equal(done.calls.length, 1, name + ': OMP still starts');
    assert.deepEqual(done.calls[0].args, ['--no-extensions', '--extension', OWN, ...expected.flatMap(file => ['--extension', file]), '--resume', w.session], name);
    if (note) assert.match(done.err, note, name);
  }
});

test('at most 8 extra extensions are used, and the lane still starts', async t => {
  const w = await world(t);
  const files = [];
  for (let i = 0; i < 10; i++) files.push(await w.extension(`e${i}.ts`));
  await w.list({ extensions: files });
  const done = await w.run(['start', w.state, '--confirm-offline']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.calls[0].args.filter(arg => arg === '--extension').length, 1 + 8);
  assert.match(done.err, /Only the first 8 extra extensions are used/);
});
