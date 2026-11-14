import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, isStaleLock, STALE_LOCK_MS } from '../src/control.mjs';

// A guard file left by a crash is reclaimed; one whose owner may still be working never is.
async function folder(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bridge-lock-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const age = (file, ms) => fs.utimes(file, new Date(Date.now() - ms), new Date(Date.now() - ms));

test('a lock whose owner process is gone is taken over and now names this process', async t => {
  const file = path.join(await folder(t), 'setup.lock');
  await fs.writeFile(file, JSON.stringify({ pid: 4242 }));
  const handle = await acquireLock(file, { alive: () => false });
  await handle.close();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
});

test('a lock whose owner is alive is never taken, however it looks', async t => {
  const file = path.join(await folder(t), 'setup.lock');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid }));
  await assert.rejects(acquireLock(file), { code: 'EEXIST' });
  assert.equal(await isStaleLock(file), false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
});

test('a lock with no owner recorded is taken only when it is older than any real run', async t => {
  const file = path.join(await folder(t), 'trace-write.lock');
  await fs.writeFile(file, '');
  assert.equal(await isStaleLock(file), false, 'a fresh empty lock may belong to a run that is starting');
  // Written after the PC started but long enough ago: stale. (Older than the PC's uptime is stale anyway.)
  await age(file, STALE_LOCK_MS + 60000);
  assert.equal(await isStaleLock(file), true);
  await acquireLock(file).then(handle => handle.close());
});

test('a lock whose recorded process is alive is taken only when it was written before this PC started (the process id was reused)', async t => {
  const file = path.join(await folder(t), 'connections.lock');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid }));
  await age(file, 60000);
  assert.equal(await isStaleLock(file), false, 'written after the PC started: its owner may still be working');
  await age(file, Math.max(os.uptime() * 1000, STALE_LOCK_MS) + 60000);
  assert.equal(await isStaleLock(file), true, 'written before the PC started and long ago: the live process is a different program');
  await acquireLock(file).then(handle => handle.close());
});

test('a live run keeps its lock when the clock is set forward after the PC started', async t => {
  const file = path.join(await folder(t), 'setup.lock');
  await (await acquireLock(file)).close();
  const threeYears = 3 * 365 * 24 * 3600 * 1000, forward = { now: () => Date.now() + threeYears };
  assert.equal(await isStaleLock(file, forward), false);
  await assert.rejects(acquireLock(file, forward), { code: 'EEXIST' });
});

test('a lock written before the PC last restarted is taken even though its process number is alive again', async t => {
  const file = path.join(await folder(t), 'setup.lock');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, up: os.uptime() + 3600 }));
  assert.equal(await isStaleLock(file), true);
  await acquireLock(file).then(handle => handle.close());
});

test('a lock with no owner that was written before this PC last started is stale', async t => {
  const file = path.join(await folder(t), 'trace-write.lock');
  await fs.writeFile(file, '');
  await age(file, os.uptime() * 1000 + 60000);
  assert.equal(await isStaleLock(file), true);
});

test('a folder or an oversized file is never treated as a stale lock', async t => {
  const dir = await folder(t), asDirectory = path.join(dir, 'watchdog.lock'), big = path.join(dir, 'big.lock');
  await fs.mkdir(asDirectory); await fs.writeFile(big, 'x'.repeat(5000));
  await age(asDirectory, 1e10); await age(big, 1e10);
  assert.equal(await isStaleLock(asDirectory), false);
  assert.equal(await isStaleLock(big), false);
});
