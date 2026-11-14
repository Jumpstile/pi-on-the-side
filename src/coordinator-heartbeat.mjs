import path from 'node:path';
import { plain, readJson, writeJson } from './control.mjs';

const COORDINATOR_HEARTBEAT_TTL_MS = 180000;
// A clock set back a little (time sync) leaves a date slightly ahead of now: that counts as now. A date further ahead is refused.
const CLOCK_DRIFT_MS = 300000;
export const heartbeatFile = root => path.join(root, 'control', 'coordinator-active.json');
const valid = value => value && Object.keys(value).sort().join() === 'updatedAt,version' &&
  value.version === 1 && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0;

// Missing means inactive; malformed, linked, far-future-dated or unreadable means
// uncertain. Watchdogs must suppress launches on uncertainty, not steal a run.
export async function coordinatorHeartbeatFresh(root, now = Date.now()) {
  const file = heartbeatFile(root);
  try {
    const stat = await plain(file);
    if (stat.size > 256) throw Error('invalid coordinator heartbeat');
    const value = await readJson(file);
    if (!valid(value) || value.updatedAt > now + CLOCK_DRIFT_MS) throw Error('invalid coordinator heartbeat');
    return now - value.updatedAt < COORDINATOR_HEARTBEAT_TTL_MS;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Caller holds the existing controller capability lock. Do not adopt an
// unrelated file, even at this fixed product-owned marker name.
export async function refreshCoordinatorHeartbeat(store, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('invalid coordinator heartbeat');
  await store.ready();
  const file = heartbeatFile(store.config.root);
  try {
    const stat = await plain(file);
    if (stat.size > 256 || !valid(await readJson(file))) throw Error('invalid coordinator heartbeat');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJson(file, { version: 1, updatedAt: now });
  return { active: true, expiresAt: now + COORDINATOR_HEARTBEAT_TTL_MS };
}
