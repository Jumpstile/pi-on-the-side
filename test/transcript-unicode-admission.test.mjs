import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fence, reconcileAdmission } from '../src/transcript.mjs';

const sessionId = '0c0ef91f-9004-4660-a0cc-5cbe1caa3931';

async function admittedUser(intended, persisted, asArray = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-utf16-admission-'));
  try {
    const cwd = path.join(root, 'project');
    await fs.mkdir(cwd);
    const file = path.join(root, 'native-session.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n');
    const proof = await fence(file, { sessionId, cwd }, intended);
    const content = asArray ? [{ type: 'text', text: persisted }] : persisted;
    await fs.appendFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content } }) + '\n');
    let diagnostic;
    // Await inside this try block so fixture cleanup cannot race the scan.
    const observed = await reconcileAdmission(proof, { onFailure: value => { diagnostic = value; } });
    if (!observed && intended === persisted) throw new Error('matching user text rejected: ' + JSON.stringify(diagnostic));
    return observed;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const lone = String.fromCharCode(0xd800);
const replacement = String.fromCharCode(0xfffd);

test('small user string admission rejects lossy UTF-8 surrogate collision', async () => {
  const intended = 'Inspect ' + lone;
  assert.notEqual(intended, 'Inspect ' + replacement);
  assert.equal(await admittedUser(intended, 'Inspect ' + replacement), false);
  assert.equal(await admittedUser(intended, intended), true);
});

test('small text-array user admission rejects lossy UTF-8 surrogate collision', async () => {
  const intended = 'Inspect ' + lone;
  assert.equal(await admittedUser(intended, 'Inspect ' + replacement, true), false);
  assert.equal(await admittedUser(intended, intended, true), true);
});

test('streamed user string admission rejects lossy UTF-8 surrogate collision', async () => {
  const prefix = 'x'.repeat(70000);
  assert.equal(await admittedUser(prefix + lone, prefix + replacement), false);
  assert.equal(await admittedUser(prefix + lone, prefix + lone), true);
});

test('streamed text-array user admission rejects lossy UTF-8 surrogate collision', async () => {
  const prefix = 'x'.repeat(70000);
  assert.equal(await admittedUser(prefix + lone, prefix + replacement, true), false);
  assert.equal(await admittedUser(prefix + lone, prefix + lone, true), true);
});

test('streamed raw UTF-8 character crossing scanner chunk boundary hashes exactly', async () => {
  const emoji = '🦊';
  const probe = 'x'.repeat(262140) + emoji + 'tail';
  const row = text => Buffer.from(JSON.stringify({ type: 'message', message: { role: 'user', content: text } }));
  const emojiBytes = Buffer.from(emoji);
  const position = row(probe).indexOf(emojiBytes);
  const adjust = 262143 - position;
  assert.ok(adjust > -200 && adjust < 200);
  const text = 'x'.repeat(262140 + adjust) + emoji + 'tail';
  assert.equal(row(text).indexOf(emojiBytes), 262143);
  assert.equal(await admittedUser(text, text), true);
});
