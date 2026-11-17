import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerConnection, BAD_LANE_NAME } from '../src/connections.mjs';

// A lane name that is not allowed must say what the rules are. It used to report
// "invalid connections registry", which reads like a damaged lane list.
test('a lane name that is not allowed gets a plain message and changes nothing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp lane name '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hub = path.join(dir, 'connections');
  for (const name of ['Guide-B-review', 'guide_review', '1lane', '', 'a'.repeat(33), 'has space', undefined, 7]) {
    await assert.rejects(registerConnection(hub, name, path.join(dir, 'state')), error => {
      assert.equal(error.plain, true, String(name));
      assert.equal(error.message, BAD_LANE_NAME);
      assert.doesNotMatch(error.message, /registry/);
      return true;
    });
  }
  await assert.rejects(fs.lstat(hub), { code: 'ENOENT' });
  assert.match(BAD_LANE_NAME, /lowercase letters, digits and hyphens/);
});
