import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coordinatorHeartbeatFresh, refreshCoordinatorHeartbeat, heartbeatFile } from '../src/coordinator-heartbeat.mjs';

const NOW = 1800000000000;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-heartbeat-'));
  await fs.mkdir(path.join(root, 'control'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('heartbeat expires at the precise TTL boundary and can be refreshed for the next cycle', async t => {
  const root = await fixture(t), file = heartbeatFile(root);
  const store = { config: { root }, ready: async () => {} };
  assert.equal(await coordinatorHeartbeatFresh(root, NOW), false);
  await refreshCoordinatorHeartbeat(store, NOW);
  assert.equal(await coordinatorHeartbeatFresh(root, NOW + 179999), true);
  assert.equal(await coordinatorHeartbeatFresh(root, NOW + 180000), false);
  await refreshCoordinatorHeartbeat(store, NOW + 180000);
  assert.equal(await coordinatorHeartbeatFresh(root, NOW + 180001), true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, updatedAt: NOW + 180000 });
});
test('malformed, future, oversized and foreign markers fail closed and foreign bytes are never overwritten', async t => {
  const root = await fixture(t), file = heartbeatFile(root);
  const store = { config: { root }, ready: async () => {} };
  for (const content of ['{', '{}', JSON.stringify({ version: 1, updatedAt: -1 }),
    JSON.stringify({ version: 1, updatedAt: NOW + 300001 }), 'x'.repeat(257),
    JSON.stringify({ version: 1, updatedAt: NOW, private: 'owner data' })]) {
    await fs.writeFile(file, content);
    await assert.rejects(coordinatorHeartbeatFresh(root, NOW));
    if (!content.includes(String(NOW + 300001))) {
      await assert.rejects(refreshCoordinatorHeartbeat(store, NOW));
      assert.equal(await fs.readFile(file, 'utf8'), content);
    }
  }
});
test('a date a little ahead of now (clock set back) counts as active; a date far ahead is refused', async t => {
  const root = await fixture(t);
  await fs.writeFile(heartbeatFile(root), JSON.stringify({ version: 1, updatedAt: NOW + 300000 }));
  assert.equal(await coordinatorHeartbeatFresh(root, NOW), true);
  assert.equal(await coordinatorHeartbeatFresh(root, NOW + 480000), false, 'it still runs out');
  await fs.writeFile(heartbeatFile(root), JSON.stringify({ version: 1, updatedAt: NOW + 300001 }));
  await assert.rejects(coordinatorHeartbeatFresh(root, NOW), { message: 'invalid coordinator heartbeat' });
});
