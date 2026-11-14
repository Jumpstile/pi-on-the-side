import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { plain, readJson, unlinkRetry, writeJson } from './control.mjs';

export const CONTROLLER_EXISTS = 'That controller credential file already exists, so nothing was changed. Next: keep using it, or give the new one a different file name. To move a session to a new credential, use controller-handoff; deleting the old file by hand would lock that session out.';
const CREDENTIAL_MISSING = 'The controller credential file was not found, so nothing was changed. Next: check the path. If this session never had a controller, make one with controller-create and use it with controller-acquire. If the session already has a controller and its file is lost, no command can replace it: close every assistant that uses the session, copy controller-<session id>.json from the session\'s state folder to a safe place, delete it, then run controller-create and controller-acquire. If controller-acquire says the write is busy, also delete the lock file next to it, controller-<session id>.lock, once you are sure no assistant is running. Plans and receipts are not changed.';
const CREDENTIAL_NOT_FILE = 'The controller credential path is a folder or a link, not a file, so nothing was changed. Next: give the path of the credential file itself.';
const CREDENTIAL_LINKED_FOLDER = 'The path of the controller credential file goes through a folder that is a link, or it is written another way than its real path (for example a short name like PROGRA~1, or a drive letter that points at another folder), so nothing was changed. Next: give the real path of the file.';
const CREDENTIAL_UNREADABLE = 'The controller credential file could not be opened right now (Windows or a scanner may be holding it), so nothing was changed. Next: try again in a moment. Do not make a new credential for this.';
// Thrown for the write lock or the owner record of a session when it is a folder or a link: Setup never makes either.
export const CONTROLLER_RECORD_NOT_FILE = 'A controller file in the session\'s state folder (controller-<session id>.json or controller-<session id>.lock) is a folder or a link, not the plain file Pi on the Side makes, so nothing was changed. Next: if you made that folder or link, move it away (not what it points to), then try again.';
export const CONTROLLER_ERRORS = ['controller credential required', 'invalid controller credential',
  'invalid controller ownership', 'controller not acquired', 'another controller owns this session',
  'controller write busy; offline review required if interrupted', CONTROLLER_EXISTS, CREDENTIAL_MISSING, CREDENTIAL_NOT_FILE, CREDENTIAL_LINKED_FOLDER, CREDENTIAL_UNREADABLE, CONTROLLER_RECORD_NOT_FILE];
const fail = message => { throw new Error(message); };
const HEX = /^[a-f0-9]{64}$/;
const digest = key => crypto.createHash('sha256').update(key).digest('hex');
const files = store => ({ owner: path.join(store.config.root, `controller-${store.config.sessionId}.json`),
  lock: path.join(store.config.root, `controller-${store.config.sessionId}.lock`) });

// Local capability, never supplied as a tool argument or inferred from the
// assistant's display name. The private file/ACL is the trust boundary.
export async function createCredential(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file !== path.resolve(file)) fail('invalid controller credential');
  await plain(path.dirname(file), true);
  try { await writeJson(file, { version: 1, key: crypto.randomBytes(32).toString('hex') }, true); }
  catch (e) { if (e.code === 'EEXIST') fail(CONTROLLER_EXISTS); throw e; }
}
async function credential(file) {
  if (typeof file !== 'string' || !file) fail('controller credential required');
  if (!path.isAbsolute(file) || file !== path.resolve(file)) fail('invalid controller credential');
  let value;
  try { value = await readJson(file); } catch (e) { fail(e.code === 'ENOENT' ? CREDENTIAL_MISSING : /^linked /.test(e.message) ? ((await fs.lstat(file).catch(() => null))?.isFile() ? CREDENTIAL_LINKED_FOLDER : CREDENTIAL_NOT_FILE) : e.code ? CREDENTIAL_UNREADABLE : 'invalid controller credential'); }
  if (!value || Object.keys(value).sort().join() !== 'key,version' || value.version !== 1 || typeof value.key !== 'string' || !HEX.test(value.key)) fail('invalid controller credential');
  return digest(value.key);
}
async function owner(store) {
  let value;
  try { value = await readJson(files(store).owner); } catch (e) { if (e.code === 'ENOENT') return null; fail(/^linked /.test(e.message) ? CONTROLLER_RECORD_NOT_FILE : 'invalid controller ownership'); }
  if (!value || Object.keys(value).sort().join() !== 'controller,sessionId,version' || value.version !== 1 ||
      value.sessionId !== store.config.sessionId || typeof value.controller !== 'string' || !HEX.test(value.controller)) fail('invalid controller ownership');
  return value;
}
const matches = (value, key) => {
  if (!value) fail('controller not acquired');
  if (value.controller !== key) fail('another controller owns this session');
};

// Shared by CLI and each independent MCP process. Hold wx across ownership
// recheck AND the entire mutation, so handoff cannot overtake an admitted write.
// Never reclaim a stale lock or release ownership on process exit/timeout.
async function locked(store, operation) {
  await store.ready();
  const file = files(store).lock;
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('controller write busy; offline review required if interrupted'); throw e; }
  try { return await operation(); }
  finally { await handle.close(); await unlinkRetry(file); }
}
export async function acquireController(store, file) {
  const key = await credential(file);
  await store.ready();
  const prior = await owner(store);
  if (prior) matches(prior, key);
  return locked(store, async () => {
    const current = await owner(store);
    if (current) matches(current, key);
    else await writeJson(files(store).owner, { version: 1, sessionId: store.config.sessionId, controller: key }, true);
    return { acquired: true, alreadyOwned: current !== null };
  });
}
export async function withController(store, file, operation) {
  const key = await credential(file);
  await store.ready();
  matches(await owner(store), key); // conflicting clients do not even create a lock
  return locked(store, async () => { matches(await owner(store), key); return operation(); });
}
export async function handoffController(store, fromFile, toFile) {
  const next = await credential(toFile);
  return withController(store, fromFile, async () => {
    await writeJson(files(store).owner, { version: 1, sessionId: store.config.sessionId, controller: next });
    return { handedOff: true, note: 'Plans, receipts and in-flight work unchanged. Do not replay uncertain work.' };
  });
}
export async function controllerStatus(store) {
  await store.ready();
  const current = await owner(store);
  let busy = false;
  try { await plain(files(store).lock); busy = true; } catch (e) { if (/^linked /.test(e.message)) fail(CONTROLLER_RECORD_NOT_FILE); if (e.code !== 'ENOENT') throw e; }
  return { acquired: current !== null, writeLock: busy ? 'present' : 'absent',
    note: 'Local capability ownership; no timed takeover. This does not identify an assistant or prove it is connected.' };
}
