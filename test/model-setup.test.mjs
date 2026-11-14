import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRolesStatus } from '../src/model-setup.mjs';

const answer = value => JSON.stringify({ key: 'modelRoles', value });

test('Setup names the OMP model roles that have no model, asks OMP only to read its settings and never chooses one', async () => {
  const calls = [];
  const run = value => async (exe, args, cwd) => { calls.push({ exe, args, cwd }); return answer(value); };
  assert.deepEqual(await modelRolesStatus('omp.exe', 'C:\\project', run({ default: 'provider-a/model', slow: '' })), { status: 'missing', missing: ['advisor', 'slow'] });
  assert.deepEqual(await modelRolesStatus('omp.exe', 'C:\\project', run({ default: 'a/b', advisor: 'a/c', slow: 'a/d' })), { status: 'ready', missing: [] });
  assert.ok(calls.every(call => call.args.join(' ') === 'config get modelRoles --json' && call.cwd === 'C:\\project'));
});

test('an OMP answer Setup cannot read is reported as unchecked, not as missing models', async () => {
  for (const run of [async () => { throw Error('omp failed'); }, async () => 'not json', async () => JSON.stringify({ key: 'other', value: {} }), async () => answer({ default: 'has spaces' })]) {
    assert.deepEqual(await modelRolesStatus('omp.exe', 'C:\\project', run), { status: 'unchecked', missing: [] });
  }
});
