import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dropUnavailableConnections, readConnections } from '../src/connections.mjs';

test('when the last lane is dropped, the next read says in plain words that no lanes are connected, not that the list is invalid', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pots-empty-list-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hub = path.join(root, 'connections');
  await fs.mkdir(hub);
  const row = { name: 'lane-a', root: path.join(root, 'state-a'), binding: { sessionId: '01a00000-0000-7000-8000-000000000001', cwd: path.join(root, 'proj'), sessionFile: path.join(root, 'proj', 's.jsonl'), executable: path.join(root, 'omp.exe') } };
  await fs.writeFile(path.join(hub, 'connections.json'), JSON.stringify({ version: 1, connections: [row] }) + '\n');
  assert.deepEqual(await dropUnavailableConnections(hub), ['lane-a']);
  await assert.rejects(readConnections(hub, { tries: 2, delayMs: 5 }), error => {
    assert.match(error.message, /^No lanes are connected on this PC\. Next: run pots install/);
    assert.notEqual(error.message, 'invalid connections registry');
    return true;
  });
});
