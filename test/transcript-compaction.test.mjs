import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fence } from '../src/transcript.mjs';
import { admitted } from './admitted-helper.mjs';

const sessionId = '00000000-0000-4000-8000-000000000002';
const user = text => JSON.stringify({ type: 'message', message: { role: 'user', content: text } }) + '\n';
const stop = text => JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: text } }) + '\n';
const row = obj => JSON.stringify(obj) + '\n';
const compaction = row({ type: 'compaction', summary: 's' });
const custom = row({ type: 'custom', customType: 'x', data: {} });

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-admit-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'session.jsonl');
  const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: base }) + '\n';
  await fs.writeFile(file, header + row({ type: 'message', message: { role: 'user', content: 'old' } }));
  const identity = { sessionId, cwd: base };
  const proof = await fence(file, identity, 'exact');
  return { file, proof };
}

test('trailing compaction after exact user and terminal stop is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction);
  assert.equal(await admitted(proof), true);
});

test('trailing compaction followed by custom row is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + custom);
  assert.equal(await admitted(proof), true);
});

test('mid-run compaction before a settled final stop is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: 'x' } }) + '\n' + compaction + stop('done') + custom);
  assert.equal(await admitted(proof), true);
});

test('compaction before the sole user stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, compaction + user('exact') + stop('done'));
  assert.equal(await admitted(proof), false);
});

test('compaction with wrong request text stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('other') + stop('done') + compaction);
  assert.equal(await admitted(proof), false);
});

test('compaction without a terminal stop stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: 'x' } }) + '\n' + compaction);
  assert.equal(await admitted(proof), false);
});

test('compaction with no assistant after user stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + compaction);
  assert.equal(await admitted(proof), false);
});

test('tool-use row after the mid-run compaction stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: 'x' } }) + '\n');
  assert.equal(await admitted(proof), false);
});

test('two compactions stay unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + compaction);
  assert.equal(await admitted(proof), false);
});

test('branch summary with trailing compaction stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + row({ type: 'branch_summary', summary: 's' }) + compaction);
  assert.equal(await admitted(proof), false);
});

test('extraneous user after terminal compaction stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + user('exact'));
  assert.equal(await admitted(proof), false);
});

test('trailing compaction with a second user before the stop stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + user('other') + stop('done') + compaction);
  assert.equal(await admitted(proof), false);
});

test('trailing compaction with unterminated final line stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction.trimEnd());
  assert.equal(await admitted(proof), false);
});

test('null or typeless row after trailing compaction stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + 'null\n');
  assert.equal(await admitted(proof), false);
  await fs.appendFile(file, '{"x":1}\n');
  assert.equal(await admitted(proof), false);
});

const customMessage = (extra = {}) => row({ type: 'custom_message', customType: 'ext', content: 'context', display: false, ...extra });
const toolUse = JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: 'x' } }) + '\n';

test('exact sanitized OMP shape with mid-run compaction and two custom_message rows is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage() + customMessage());
  assert.equal(await admitted(proof), true);
});

test('custom_message after trailing compaction and terminal stop is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage());
  assert.equal(await admitted(proof), true);
});

test('more than two custom_message rows after the terminal stop stay unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage() + customMessage() + customMessage());
  assert.equal(await admitted(proof), false);
});

test('custom_message with a message field stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage({ message: { role: 'user', content: 'exact' } }));
  assert.equal(await admitted(proof), false);
});

test('custom_message with a top-level role field stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage({ role: 'user' }));
  assert.equal(await admitted(proof), false);
});

test('custom_message with non-string customType stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage({ customType: 7 }));
  assert.equal(await admitted(proof), false);
});

test('extra user after custom_message stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + stop('done') + customMessage() + user('exact'));
  assert.equal(await admitted(proof), false);
});

test('tool-use row after custom_message stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage() + toolUse);
  assert.equal(await admitted(proof), false);
});

test('custom_message after non-terminal stop stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + toolUse + compaction + customMessage());
  assert.equal(await admitted(proof), false);
});

test('unterminated custom_message after terminal stop stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage().trimEnd());
  assert.equal(await admitted(proof), false);
});

test('custom_message with non-boolean display stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage({ display: 'yes' }));
  assert.equal(await admitted(proof), false);
});

test('custom_message with object content stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage({ content: { text: 'x' } }));
  assert.equal(await admitted(proof), false);
});

test('custom_message whose customType is exactly 128 bytes is admitted', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage({ customType: 'a'.repeat(128) }));
  assert.equal(await admitted(proof), true);
});

test('custom_message with a multi-byte customType over 128 bytes stays unknown', async t => {
  const { file, proof } = await fixture(t);
  await fs.appendFile(file, user('exact') + stop('done') + compaction + customMessage({ customType: '\u00e9'.repeat(65) }));
  assert.equal(await admitted(proof), false);
});
