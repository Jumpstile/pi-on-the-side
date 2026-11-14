// Offline fixture only. Run each phase in a separate Node process; no OMP/API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { initialize, Store, Supervisor, readJson, writeJson } from '../src/control.mjs';
const [phase, input] = process.argv.slice(2);
if (!input || !path.isAbsolute(input)) throw new Error('supply a new absolute disposable fixture root');
const root = path.resolve(input);
const sessionId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const marker = path.join(root, 'synthetic-fixture.json');
const store = new Store({ root, cwd: root, sessionId });
if (phase === 'prepare') {
  await initialize(root);
  await writeJson(marker, { fixture: 'omp-bridge-offline-restart-v1' }, true);
  await store.enqueue({ version: 1, id, sessionId, expiresAt: Date.now() + 3600000,
    steps: [{ prompt: 'Synthetic offline fixture; no real execution.', continueAfterEnd: false }] });
} else {
  if ((await readJson(marker)).fixture !== 'omp-bridge-offline-restart-v1') throw new Error('not a marked disposable fixture');
  let calls = 0;
  const adapter = { isIdle: () => true, fence: async () => ({ fixture: true }), admitted: async () => true,
    send: async () => { calls++; } };
  if (phase === 'crash') {
    const supervisor = new Supervisor(store, adapter);
    await supervisor.open(); await supervisor.tick();
    if (calls !== 1 || (await store.receipt(id)).state !== 'submitted') throw new Error('fixture submission mismatch');
    console.log('Synthetic submitted receipt persisted; exiting without orderly supervisor close.');
    process.exit(0);
  } else if (phase === 'recover') {
    // Only the marked synthetic fixture may remove this exact crash lock.
    // A real session always requires independent offline owner review.
    const lock = path.join(root, `supervisor-${sessionId}.lock`);
    if (path.dirname(lock) !== root) throw new Error('fixture path escape');
    await fs.unlink(lock);
    const supervisor = new Supervisor(store, adapter);
    await supervisor.open(); await supervisor.tick();
    const receipt = await store.receipt(id);
    await supervisor.close();
    if (calls !== 0 || receipt.state !== 'failed' || receipt.reason !== 'restart') throw new Error('fresh-process replay detected');
    console.log('Fresh-process recovery PASS: failed/restart receipt, zero replay calls.');
  } else throw new Error('phase must be prepare, crash or recover');
}
