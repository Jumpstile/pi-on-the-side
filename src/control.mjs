import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = 64 * 1024;
const MAX_PLANS = 128;
export const TERMINAL = new Set(['completed', 'failed', 'aborted', 'expired', 'malformed']);
// The plan ids in a plans folder: only plan-shaped names count, so a leftover temporary file never takes a place in the queue.
const planNames = names => names.filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5))).map(n => n.slice(0, -5));
// Receipts written by older versions used other words. They read as the definite words that replaced them, so nobody has
// to edit a file: state "unknown" -> failed (aborted when its reason was continuation_not_authorized), state "exhausted" ->
// completed, reasons uncorrelated_end / admission_unconfirmed -> their specific successors, and outcome values "unknown" -> not_seen.
const LEGACY_REASON = { uncorrelated_end: 'end_not_matched_to_message', admission_unconfirmed: 'message_not_confirmed_in_transcript' };
const readable = row => {
  if (!row) return row;
  const reason = Object.hasOwn(LEGACY_REASON, row.reason) ? LEGACY_REASON[row.reason] : row.reason;
  const oldOutcomes = Array.isArray(row.outcomes) && row.outcomes.some(o => o && (o.submission === 'unknown' || o.terminalObservation === 'unknown'));
  if (row.state !== 'unknown' && row.state !== 'exhausted' && reason === row.reason && !oldOutcomes) return row;
  const state = row.state === 'exhausted' ? 'completed' : row.state !== 'unknown' ? row.state : reason === 'continuation_not_authorized' ? 'aborted' : 'failed';
  return { ...row, state, ...(reason === undefined ? {} : { reason }),
    ...(oldOutcomes ? { outcomes: row.outcomes.map(o => o && typeof o === 'object' ? { ...o, ...(o.submission === 'unknown' ? { submission: 'not_seen' } : {}), ...(o.terminalObservation === 'unknown' ? { terminalObservation: 'not_seen' } : {}) } : o) } : {}) };
};
export const same = (a, b) => {
  if (process.platform !== 'win32') return a === b;
  const left = a.toLowerCase(), right = b.toLowerCase();
  // Bun Windows realpath returns bare drive roots (C:) for canonical C:\.
  // Accept only this exact root spelling; all other paths remain exact.
  return left === right || (/^[a-z]:$/.test(left) && right === left + '\\') ||
    (/^[a-z]:$/.test(right) && left === right + '\\');
};
const fail = (message) => { throw new Error(message); };
// A model name, a role alias or a provider/id selector exactly as OMP reports or accepts it.
// This is only a syntax bound for stored text; it names no model and never guesses one.
export const MODEL_SELECTOR = /^[a-zA-Z0-9_.:/+@-]{1,240}$/;
export const isModelSelector = value => typeof value === 'string' && MODEL_SELECTOR.test(value);
// After a switch, the only proof is OMP's own report of the running model. A
// setModel return value is never proof. `observe` returns the selector OMP says
// is running (or null when OMP cannot say); it is asked a few times because the
// report may lag the switch. `actual` is the last report: null means unobservable.
export async function proveModel(observe, expected, { attempts = 5, delayMs = 200 } = {}) {
  let actual = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise(resolve => setTimeout(resolve, delayMs));
    try { const seen = await observe(); actual = isModelSelector(seen) ? seen : null; } catch { actual = null; }
    if (actual !== null && actual === expected) return { proven: true, actual, attempts: attempt };
  }
  return { proven: false, actual, attempts };
}
async function bounded(operation, milliseconds, reason) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function config(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid config');
  const keys = Object.keys(value).sort().join();
  if (value.clients === 'muse') fail('Muse is no longer supported; choose Claude, ChatGPT, or both.');
  if (!['cwd,root,sessionId','coordinatorWakeups,cwd,root,sessionId','clients,coordinatorWakeups,cwd,root,sessionId'].includes(keys) ||
      !UUID.test(value.sessionId) || !path.isAbsolute(value.cwd) || !path.isAbsolute(value.root) ||
      (value.coordinatorWakeups !== undefined && typeof value.coordinatorWakeups !== 'boolean') ||
      (value.clients !== undefined && !['claude','chatgpt','both'].includes(value.clients))) fail('invalid config');
  if (value.cwd !== path.resolve(value.cwd) || value.root !== path.resolve(value.root)) fail('config paths must be canonical');
  return Object.freeze({ ...value, coordinatorWakeups: value.coordinatorWakeups ?? true, clients: value.clients ?? 'both' });
}

// The longest a plan may be valid, and the time a normally queued task is given. The wait behind a long-running task counts, so it is the longest the format allows (minus a minute of margin).
const MAX_PLAN_MS = 86400000;
export const QUEUE_LIMIT_MS = MAX_PLAN_MS - 60000;
export function plan(value, now = Date.now()) {
  if (!value || Object.keys(value).sort().join() !== 'expiresAt,id,sessionId,steps,version' || value.version !== 1 ||
      !UUID.test(value.id) || !UUID.test(value.sessionId) || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now || value.expiresAt > now + MAX_PLAN_MS || !Array.isArray(value.steps) ||
      value.steps.length < 1 || value.steps.length > 8) fail('invalid plan');
  for (const step of value.steps) {
    if (!step || Object.keys(step).sort().join() !== 'continueAfterEnd,prompt' || typeof step.continueAfterEnd !== 'boolean' ||
        typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 6000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(step.prompt)) fail('invalid step');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('plan too large');
  return structuredClone(value);
}

// Resolve every component before opening files. This rejects junctions as well
// as symlinks. The private directory's ACL is still the principal trust boundary.
export async function plain(file, directory = false) {
  const absolute = path.resolve(file);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      !same(await fs.realpath(absolute), absolute)) fail('linked or non-plain path');
  let parent = path.dirname(absolute);
  while (true) {
    if ((await fs.lstat(parent)).isSymbolicLink() || !same(await fs.realpath(parent), parent)) fail('linked ancestor');
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return stat;
}

export async function readJson(file) {
  const stat = await plain(file);
  if (stat.size > MAX_BYTES) fail('file too large');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail('file changed');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) fail('file too large');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

// Same-volume replacement gives readers a complete old or new JSON record.
// fsync precedes rename. Directory-fsync availability differs on Windows;
// this is crash recovery, not a promise against storage-controller power loss.
export async function writeJson(file, value, exclusive = false, io = fs) {
  const bytes = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('record too large');
  await plain(path.dirname(file), true);
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await io.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) {
      // Hard-link publication cannot overwrite a previously used request ID.
      await io.link(tmp, file);
      // Publication is committed at link(). A cleanup failure must not report
      // a failed enqueue or encourage retry of an already published identity.
      await io.unlink(tmp).catch(() => {});
    } else {
      try { await plain(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await replace(io, tmp, file);
    }
  } catch (e) { await io.unlink(tmp).catch(() => {}); throw e; }
}

// On Windows, MoveFileEx cannot replace a target that any process (including a
// concurrent readJson of a receipt) holds open; it fails EPERM/EACCES/EBUSY
// until that handle closes. Readers hold handles only for one bounded read, so
// retry the same atomic rename briefly. The rename either happens once or the
// write fails; it never produces a partial record.
const SHARING = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function replace(io, tmp, file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { return await io.rename(tmp, file); }
    catch (e) {
      if (process.platform !== 'win32' || !SHARING.has(e.code) || Date.now() >= deadline) throw e;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

// Removes a file this process owns (a lock it just released), retrying the same sharing failure for up to two seconds.
// Returns false instead of throwing when the file is still held: the caller's real work is already done.
export async function unlinkRetry(file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { await fs.unlink(file); return true; }
    catch (e) {
      if (e.code === 'ENOENT') return true;
      if (process.platform !== 'win32' || !SHARING.has(e.code) || Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

// A plain read that hits a passing sharing error (a scanner or indexer holding the file) is tried again for a moment.
// Anything else, or a file that stays held, still throws, so a record that really cannot be read stops the supervisor.
async function readRetry(read) {
  const deadline = Date.now() + 500;
  for (;;) {
    try { return await read(); }
    catch (e) {
      if (process.platform !== 'win32' || !SHARING.has(e.code) || Date.now() >= deadline) throw e;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export async function initialize(root) {
  if (!path.isAbsolute(root) || root !== path.resolve(root)) fail('root must be canonical and absolute');
  await plain(path.dirname(root), true);
  await fs.mkdir(root, { mode: 0o700 }); // Never adopt an existing/unknown directory.
  // A later folder that cannot be made takes this call's own folders away again (plain rmdir: only empty ones), so a retry is not refused by a half-made state folder.
  const inside = ['plans', 'receipts', 'control'];
  try { for (const name of inside) await fs.mkdir(path.join(root, name), { mode: 0o700 }); }
  catch (error) {
    for (const name of inside) await fs.rmdir(path.join(root, name)).catch(() => {});
    await fs.rmdir(root).catch(() => {});
    throw error;
  }
}

// A /model request nobody answers within this long stops holding plans and is never sent. A command lock is held for one
// read and one write; one older than the second limit was left by a crash.
export const COMMAND_HOLD_MS = 5 * 60 * 1000;
const COMMAND_LOCK_MS = 60 * 1000;
export class Store {
  constructor(settings, now = Date.now) { this.config = config(settings); this.now = now; }
  file(kind, id) {
    if (!['plans', 'receipts', 'control'].includes(kind) || !UUID.test(id)) fail('invalid record identity');
    return path.join(this.config.root, kind, id + '.json');
  }
  async ready() {
    await plain(this.config.root, true);
    for (const kind of ['plans', 'receipts', 'control']) await plain(path.join(this.config.root, kind), true);
  }
  async enqueue(input) {
    await this.ready();
    const value = plan(input, this.now());
    if (value.sessionId !== this.config.sessionId) fail('wrong session');
    // Only plans that never ran are written: a receipt means this ID was used (even if its plan was retired) and must never be queued again.
    const used = () => fail('plan id already used');
    if (await this.receipt(value.id)) used();
    const planIds = planNames(await fs.readdir(path.join(this.config.root, 'plans')));
    if (planIds.length >= MAX_PLANS && !await this.retire(planIds, planIds.length - MAX_PLANS + 1)) fail('queue capacity reached');
    try { await writeJson(this.file('plans', value.id), value, true); } catch (e) { if (e.code === 'EEXIST') used(); throw e; }
    return value.id;
  }
  // A full queue frees room by retiring the plans of tasks that already ended, oldest first. Only the plan file goes: the
  // receipt stays, so the ID is still reserved and the record of how the task ended is kept. Unfinished plans are never touched.
  async retire(ids, count) {
    const ended = [];
    for (const id of ids) {
      const row = await this.receipt(id).catch(() => null);
      if (row && TERMINAL.has(row.state)) ended.push({ id, at: row.updatedAt ?? 0 });
    }
    const oldest = ended.sort((a, b) => a.at - b.at).slice(0, count);
    if (oldest.length < count) return false;
    for (const { id } of oldest) if (!await unlinkRetry(this.file('plans', id))) return false;
    return true;
  }
  async ids() {
    await this.ready();
    const ids = planNames(await fs.readdir(path.join(this.config.root, 'plans')));
    if (ids.length > MAX_PLANS) fail('queue capacity exceeded');
    return ids.sort();
  }
  async receipt(id) {
    await this.ready();
    try {
      const row = await readJson(this.file('receipts', id));
      if (row.id !== id || row.sessionId !== this.config.sessionId) fail('receipt identity mismatch');
      return readable(row);
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async save(row) {
    if (row.sessionId !== this.config.sessionId || !UUID.test(row.id)) fail('receipt identity mismatch');
    await this.ready();
    await writeJson(this.file('receipts', row.id), row);
  }
  async abort(id) {
    await this.ready();
    const value = await readJson(this.file('plans', id));
    if (value.sessionId !== this.config.sessionId) fail('wrong session');
    // Cancellation is a persistent signal, never a claim that OMP stopped.
    await writeJson(this.file('control', id), { version: 1, id, sessionId: value.sessionId, action: 'abort' }, true);
  }
  // The record normally does not exist. One passing OS error (a scanner or indexer holding the folder) must not read as
  // "cannot tell", which turns a verified task into unknown; retry briefly, then still fail closed.
  async cancelled(id) {
    const deadline = Date.now() + 500;
    for (;;) {
      try {
        const row = await readJson(this.file('control', id));
        if (row.version !== 1 || row.id !== id || row.sessionId !== this.config.sessionId || row.action !== 'abort') fail('invalid control record');
        return true;
      } catch (e) {
        if (e.code === 'ENOENT') return false;
        if (typeof e.code !== 'string' || Date.now() >= deadline) throw e;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  commandFile(id, receipt = false) {
    if (!UUID.test(id)) fail('invalid record identity');
    return path.join(this.config.root, 'control', `command-${id}${receipt ? '.receipt' : ''}.json`);
  }
  async requestCommand(id, command) {
    await this.ready();
    if (!UUID.test(id) || typeof command !== 'string' || command.length > 4096 ||
        !/^\/[a-z][a-z0-9-]*(?:\s+[^\r\n\0]+)?$/.test(command)) fail('invalid command request');
    const request = { version: 1, id, sessionId: this.config.sessionId, command, createdAt: this.now() };
    await writeJson(this.commandFile(id), request, true);
    await writeJson(this.commandFile(id, true), { version: 1, id, sessionId: this.config.sessionId, state: 'queued', updatedAt: this.now() }, true);
    return id;
  }
  async commandIds() {
    await this.ready();
    return (await fs.readdir(path.join(this.config.root, 'control')))
      .map(name => name.match(/^command-([a-f0-9-]{36})\.json$/)?.[1])
      .filter(id => id && UUID.test(id)).sort();
  }
  async commandRequest(id) {
    const request = await readJson(this.commandFile(id));
    if (request.version !== 1 || request.id !== id || request.sessionId !== this.config.sessionId) fail('command identity mismatch');
    return request;
  }
  async commandReceipt(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const receipt = await readJson(this.commandFile(id, true));
        if (receipt.version !== 1 || receipt.id !== id || receipt.sessionId !== this.config.sessionId) fail('command identity mismatch');
        return readable(receipt);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error?.constructor === Error && error.message === 'file changed' && attempt < 2) continue;
        throw error;
      }
    }
    return null;
  }
  commandLock(id) {
    if (!UUID.test(id)) fail('invalid record identity');
    return path.join(this.config.root, 'control', `command-${id}.lock`);
  }
  // `details` carries only OMP-reported model selectors: what the caller asked
  // for, what OMP resolved it to, and what OMP says is running afterwards.
  async updateCommandReceipt(id, state, observation, details = {}) {
    if (!['dispatching', 'verified', 'mismatch', 'returned-unverified', 'unsupported', 'failed', 'cancelled'].includes(state)) fail('invalid command receipt');
    let lock;
    for (let again = true; !lock; again = false) {
      try { lock = await fs.open(this.commandLock(id), 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // The lock is held for a read and a write. One much older than that was left by a crash and would freeze this record for good.
        const old = again && await fs.lstat(this.commandLock(id)).then(stat => Date.now() - stat.mtimeMs > COMMAND_LOCK_MS, () => false);
        if (!old) return this.commandReceipt(id);
        await unlinkRetry(this.commandLock(id));
      }
    }
    try {
      const prior = await this.commandReceipt(id);
      const allowed = prior?.state === 'queued'
        ? ['dispatching', 'unsupported', 'cancelled'].includes(state)
        : prior?.state === 'dispatching' && ['verified', 'mismatch', 'returned-unverified', 'unsupported', 'failed'].includes(state);
      if (!prior || !allowed) return prior;
      const models = {};
      for (const key of ['requested', 'resolved', 'actual']) if (isModelSelector(details?.[key])) models[key] = details[key];
      const next = { version: 1, id, sessionId: this.config.sessionId, state, updatedAt: this.now(),
        ...(observation ? { observation } : {}), ...models };
      await writeJson(this.commandFile(id, true), next);
      return next;
    } finally {
      await lock.close();
      await unlinkRetry(this.commandLock(id));
    }
  }
  // A request saved without its first receipt (the second write was cut off) is cancelled by giving it the receipt it lacks.
  async cancelCommand(id) {
    let prior = await this.commandReceipt(id);
    if (!prior) {
      try { await plain(this.commandFile(id)); } catch (e) { if (e.code === 'ENOENT') fail('unknown command id'); throw e; }
      try { await writeJson(this.commandFile(id, true), { version: 1, id, sessionId: this.config.sessionId, state: 'cancelled', updatedAt: this.now(), observation: 'cancelled before native dispatch' }, true); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      prior = await this.commandReceipt(id);
    }
    if (prior.state !== 'queued') return { id, state: prior.state, cancelled: prior.state === 'cancelled' };
    // The adapter holds the record's lock for a read and a write (milliseconds). A cancel that met it got the unchanged receipt back, so
    // it asks again until the receipt has moved (cancelled, or already handed over to OMP); the caller must never read "queued" as cancelled.
    let next = await this.updateCommandReceipt(id, 'cancelled', 'cancelled before native dispatch');
    for (let tries = 0; next.state === 'queued' && tries < 20; tries++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      next = await this.updateCommandReceipt(id, 'cancelled', 'cancelled before native dispatch');
    }
    return { id, state: next.state, cancelled: next.state === 'cancelled' };
  }
  // Any /model request that has not been answered yet holds plans, whatever other receipts say, including the
  // instant between its request file and its first receipt, so a plan can never slip in ahead of a switch on its
  // way. A request nobody answers within COMMAND_HOLD_MS stops holding (a crash can leave one for ever).
  // Among answered requests the newest decides: anything other than a proven switch holds, and only a later
  // verified switch releases the hold (switching to the model the lane already runs is verified at once, so a stuck
  // hold is always clearable). Receipts of other commands never hold.
  // An unreadable file cannot be trusted either way: it holds, dated by its file time, so a later
  // verified switch still outranks it and a damaged file cannot strand the lane.
  async modelHold() {
    let latest = null, pending = null;
    const fileTime = async file => { try { return Math.floor((await fs.stat(file)).mtimeMs); } catch { return Number.MAX_SAFE_INTEGER; } };
    for (const id of await this.commandIds()) {
      let receipt;
      try { receipt = await this.commandReceipt(id); }
      catch { receipt = { id, state: 'failed', requested: null, updatedAt: await fileTime(this.commandFile(id, true)) }; }
      if (receipt?.state === 'cancelled') continue;
      if (!receipt || ['queued', 'dispatching'].includes(receipt.state)) {
        let request;
        try { request = await this.commandRequest(id); }
        catch { request = null; }
        const model = request === null ? undefined : /^\/model(?:\s+(\S+))?\s*$/.exec(request.command);
        if (request !== null && !model) continue; // another command: never holds
        receipt = { id, state: 'pending', requested: isModelSelector(model?.[1]) ? model[1] : null,
          updatedAt: receipt?.updatedAt ?? (request?.createdAt ?? await fileTime(this.commandFile(id))) };
      } else if (receipt.requested !== null && receipt.requested !== undefined && !isModelSelector(receipt.requested)) continue;
      else if (receipt.requested === undefined) continue; // a receipt for another command
      if (receipt.state === 'pending') {
        if (this.now() - receipt.updatedAt > COMMAND_HOLD_MS) continue; // never answered in time: it stops holding (and the adapter never sends it, see processCommand)
        if (!pending || receipt.updatedAt >= pending.updatedAt) pending = receipt;
      }
      else if (!latest || receipt.updatedAt >= latest.updatedAt) latest = receipt;
    }
    const held = pending ?? (latest?.state !== 'verified' ? latest : null);
    return held ? { id: held.id, requested: held.requested, state: held.state } : null;
  }
  async recoverCommands() {
    for (const id of await this.commandIds()) {
      let receipt;
      try { receipt = await this.commandReceipt(id); } catch { continue; } // an unreadable receipt keeps its hold (modelHold); it must not stop the others
      if (receipt?.state === 'dispatching') {
        // Keep which model was asked for, so an interrupted switch still holds queued plans until a later switch is proven (see modelHold).
        let asked;
        try { asked = /^\/model(?:\s+(\S+))?\s*$/.exec((await this.commandRequest(id)).command)?.[1]; } catch { asked = undefined; }
        await this.updateCommandReceipt(id, 'failed', 'adapter restarted after dispatch admission', isModelSelector(asked) ? { requested: asked } : {});
      }
    }
  }
}

const SETTLE_MS = 5000; // A plan that did not complete (failed or malformed) holds queued plans this long, then releases them. Never replayed.
export class Supervisor {
  constructor(store, adapter) {
    this.store = store; this.adapter = adapter; this.active = null; this.run = null; this.continuationPending = false;
    this.tail = Promise.resolve(); this.closed = false; this.lock = null; this.lockLeft = false; this.admissionInterrupted = false;
  }
  trace(event, fields) { try { this.adapter.trace?.(event, fields); } catch { /* Observers never gate work. */ } }
  // Machine-readable lane transitions for the coordinator (control/lane-events.jsonl).
  // Fixed fields only; best effort, never gates admission, receipts or dispatch.
  laneEvent(event, fields) { try { this.adapter.laneEvent?.(event, fields); } catch { /* Observers never gate work. */ } }
  // All API sends, lifecycle observations and persistence share one serial lane.
  // A persistence failure closes the lane before another side effect is allowed.
  serial(fn) {
    const operation = this.tail.then(async () => { if (this.closed) fail('supervisor stopped'); return fn(); });
    this.tail = operation.catch(error => { this.closed = true; this.trace('error', {code:error?.message === 'file changed' ? 'FILE_CHANGED' : error?.code ?? 'other'}); });
    return operation;
  }
  // `ownLeftover`: the caller's own earlier stop failed and left this session's lock file behind. That one file (written by this
  // process for this session, held by nobody now) is taken over; a lock of any other process or session is never touched.
  async open(ownLeftover = false) {
    await this.store.ready();
    const file = path.join(this.store.config.root, 'supervisor-' + this.store.config.sessionId + '.lock');
    try { this.lock = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      const mine = ownLeftover && error.code === 'EEXIST' && await readJson(file).then(
        lock => lock?.pid === process.pid && lock.sessionId === this.store.config.sessionId, () => false);
      if (!mine || !await unlinkRetry(file)) throw error;
      this.lock = await fs.open(file, 'wx', 0o600);
    }
    this.lockFile = file;
    try {
      await this.lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, up: os.uptime(), startedAt: this.store.now(), sessionId: this.store.config.sessionId }));
      await this.lock.sync();
    } catch (error) {
      // This call made the file: take it away again so the next try is not refused by a lock nobody can claim.
      await this.lock.close().catch(() => {}); this.lock = null; await unlinkRetry(file);
      throw error;
    }
    this.trace('supervisor_open', {});
    try {
      // No stale-lock reclamation and no replay of any persisted in-flight step.
      for (const id of await this.store.ids()) {
        const row = await this.store.receipt(id);
        if (row && !TERMINAL.has(row.state)) {
          row.state = 'failed'; row.reason = 'restart'; row.updatedAt = this.store.now();
          await this.store.save(row);
          this.laneEvent('plan_done', {planId: id, state: 'failed', reason: 'restart'});
        }
      }
    } catch (e) { await this.close().catch(() => {}); throw e; }
  }
  async finish(state, reason) {
    const row = this.active.row;
    row.state = state; row.reason = reason; row.updatedAt = this.store.now();
    await this.store.save(row);
    delete this.active.admissionAbort;
    this.adapter.retired?.(this.active);
    this.trace('task_terminal', {state, reason, step:row.nextStep});
    this.laneEvent('plan_done', {planId: row.id, state, reason});
    this.active = null; this.run = null; this.continuationPending = false;
  }
  tick() { return this.serial(async () => {
    if (!this.lock) fail('supervisor not opened');
    if (this.active) {
      if (await this.store.cancelled(this.active.row.id)) await this.finish('aborted', 'future_steps_cancelled_execution_may_continue');
      else if (this.store.now() >= this.active.value.expiresAt) await this.finish('expired', 'execution_may_continue');
      return;
    }
    if (!this.adapter.isIdle()) { this.trace('gate', {reason:'native-busy-or-pending'}); return; }
    // A model switch that was asked for and not proven holds every queued plan (fail closed,
    // including when the receipts cannot be read) until a later switch is verified.
    let held = true;
    try { held = Boolean(await this.store.modelHold()); } catch { held = true; }
    if (held) { this.trace('gate', {reason:'model-switch-unproven'}); return; }
    const queue = await readRetry(() => this.store.ids());
    for (const id of queue) {
      const head = await readRetry(() => this.store.receipt(id));
      if ((head?.state === 'failed' || head?.state === 'malformed') && this.store.now() - head.updatedAt < SETTLE_MS) { this.trace('gate', {reason:'settle-wait'}); return; }
    }
    for (const id of await readRetry(() => this.store.ids())) {
      const prior = await readRetry(() => this.store.receipt(id));
      if (prior) continue; // A durable receipt reserves the ID forever.
      const value = await readRetry(() => readJson(this.store.file('plans', id)));
      const object = value !== null && typeof value === 'object';
      if (object && value.sessionId !== this.store.config.sessionId) continue; // Foreign session: never touch.
      const row = { version: 1, id, sessionId: this.store.config.sessionId, state: 'reserved', nextStep: 0,
        updatedAt: this.store.now(), outcomes: [], taskSuccess: 'unverified', automaticReplay: false };
      this.active = { value, row, submittedText: undefined, submittedStep: undefined,
        submissionInvoked: false, prematureStart: false };
      if (await this.store.cancelled(id)) { await this.finish('aborted', 'cancelled_before_submission'); return; }
      if (object && value.expiresAt <= this.store.now()) { await this.finish('expired', 'expired_before_submission'); return; }
      try { plan(value, this.store.now()); } catch { await this.finish('failed', 'invalid_plan'); return; }
      // Text, receipts and abort records key on the filename ID; a divergent
      // embedded ID would make correlation ambiguous.
      if (value.id !== id) { await this.finish('failed', 'plan_identity_mismatch'); return; }
      // The idle gate above precedes awaited queue reads, and native callbacks
      // (an unowned START/END hold) can land in between. Recheck with no await
      // before the durable reservation: a hold seen here leaves the plan queued
      // without a receipt. A callback after this point still fails closed below.
      if (typeof this.adapter.canReserve === 'function' && !this.adapter.canReserve()) {
        this.active = null; this.trace('gate', {reason:'native-busy-or-pending'}); return;
      }
      await this.store.save(row); // Durable reservation before any OMP API call.
      this.trace('reserved', {state:'reserved',step:row.nextStep});
      await this.submit();
      return;
    }
  }); }
  async submit() {
    const { value, row } = this.active;
    if (this.active.prematureStart) return this.finish('failed', 'context_changed_before_submission');
    if (await this.store.cancelled(row.id)) return this.finish('aborted', 'cancelled_before_submission');
    if (this.store.now() >= value.expiresAt) return this.finish('expired', 'expired_before_submission');
    if (!this.adapter.isIdle()) return this.finish('failed', 'session_changed_before_submission');
    const step = row.nextStep;
    this.active.submissionInvoked = false;
    this.active.prematureStart = false; this.active.startSeen = false;
    row.state = 'submitting'; row.updatedAt = this.store.now();
    row.outcomes.push({ step, submission: 'not_seen', terminalObservation: 'not_seen' });
    await this.store.save(row);
    const text = `[OMP bridge ${row.id} step ${step}]\n${value.steps[step].prompt}`;
    this.active.submittedText = text; this.active.submittedStep = step;
    try { this.active.fence = await bounded(() => this.adapter.fence(text), 2500, 'fence timeout'); }
    catch { return this.finish('failed', 'admission_fence_unavailable'); }
    if (!this.active.fence) return this.finish('failed', 'admission_fence_unavailable');
    if (typeof this.adapter.receiptFence === 'function') {
      try {
        row.outcomes.at(-1).admissionFence = this.adapter.receiptFence(this.active.fence);
        row.updatedAt = this.store.now();
        await this.store.save(row);
      } catch { return this.finish('failed', 'admission_fence_unavailable'); }
    }
    if (await this.store.cancelled(row.id)) return this.finish('aborted', 'cancelled_before_submission');
    if (this.active.prematureStart || !this.adapter.isIdle() || this.store.now() >= value.expiresAt)
      return this.finish('failed', 'context_changed_before_submission');
    // Fence/persistence awaits and bounded()'s microtask can yield to context changes.
    // Recheck the exact idle/session binding inside the callback, adjacent to the API.
    let invoked = false, invocationBlocked = false;
    const sending = this.active;
    try { await bounded(() => {
      if (this.closed) return;
      // START can arrive while the fence is pending. Only the actual native
      // send invocation opens ownership, never earlier reservation/awaits.
      const idle = this.adapter.isIdle();
      if (!idle || sending !== this.active || sending.prematureStart) { invocationBlocked = true; return; }
      invoked = true;
      sending.submissionInvoked = true;
      this.trace('dispatch_call', {step});
      return this.adapter.send(text);
    }, 5000, 'submission timeout'); }
    catch (error) {
      // Some OMP versions keep the send call open until the whole run ends. A call still open
      // after the wait is not a failure when this plan's run was seen to start (startSeen is set
      // as the START arrives, before the queued callback runs). The saved-session check at the run's
      // end is the proof of delivery. A call that stays open with no START seen was never taken, and an
      // error from the call is always a failure.
      if (!(invoked && error?.message === 'submission timeout' && sending.startSeen)) { await this.finish('failed', 'submission_exception'); return; }
    }
    // A changed native context before send is a durable unknown reservation; never retry it.
    if (!invoked) {
      if (invocationBlocked && !this.closed) await this.finish('failed', 'context_changed_before_submission');
      return;
    }
    row.outcomes.at(-1).submission = 'returned';
    this.trace('dispatch_returned', {state:'submitted',step});
    row.state = 'submitted'; row.updatedAt = this.store.now();
    await this.store.save(row);
  }
  started(token, expected) {
    if (expected?.owner && expected.owner === this.active && expected.owner.submissionInvoked) expected.owner.startSeen = true;
    return this.serial(async () => {
    const target = this.active;
    // The native callback captured this owner at event time, not when FIFO
    // work finally executes. Never adopt an earlier START retroactively.
    const targetMatches = target && expected?.owner === target &&
      expected.sessionId === target.row.sessionId && expected.planId === target.row.id &&
      expected.step === target.row.nextStep && target.submissionInvoked === true &&
      target.submittedStep === expected.step;
    if (!targetMatches) return;
    const runPresent = this.run !== null;
    const tokenInvalid = token && typeof token === 'object' && token.valid === false;
    const tokenRejection = !this.active ? 'supervisor_missing' : runPresent ? 'overlap'
      : this.active.row.state !== 'submitted' ? 'unexpected_state' : token === undefined || token === null || tokenInvalid ? 'token_mismatch' : 'none';
    this.trace('run_correlation', {phase:'supervisor_start',runEpoch:typeof token === 'object' ? token.epoch : token,runPresent,tokenPresent:token !== undefined && token !== null,tokenRejection});
    if (!this.active) return;
    if (tokenInvalid) return this.finish('failed', 'end_not_matched_to_message');
    if (runPresent || this.active.row.state !== 'submitted' || token === undefined || token === null)
      return this.finish('failed', 'overlapping_or_unexpected_run');
    if (this.continuationPending) this.continuationPending = false;
    this.run = token;
  }); }
  invalidateRun(token, planId, step) {
    if (!planId || !Number.isSafeInteger(step) || step < 0) return Promise.resolve(false);
    const activeMatchesTicket = this.active?.row.id === planId &&
      this.active.row.outcomes?.some(outcome => outcome.step === step);
    if (activeMatchesTicket && this.active.row.nextStep === step) {
      if (token && typeof token === 'object') token.valid = false;
      this.active.admissionAbort?.abort();
    }
    return this.serial(async () => {
      if (this.active?.row.id === planId) {
        const activeOutcome = this.active.row.outcomes?.find(outcome => outcome.step === step);
        if (!activeOutcome) return false;
        if (token && typeof token === 'object') token.valid = false;
        // A contradictory recorded step taints its whole multi-step plan.
        await this.finish('failed', 'end_not_matched_to_message');
        return true;
      }
      const row = await this.store.receipt(planId);
      if (!row) return false;
      if (row.state === 'failed' || row.state === 'malformed') return true;
      const outcome = row.outcomes?.find(item => item.step === step);
      if (['aborted','expired'].includes(row.state)) {
        if (!outcome) return true; // No submitted step exists; this terminal receipt cannot replay.
      } else if (!['waiting','completed'].includes(row.state) || !outcome ||
          outcome.admission !== 'exact_user_record_observed' ||
          outcome.terminalObservation !== 'run_end_observed') return false;
      if (token && typeof token === 'object') token.valid = false;
      row.state = 'failed'; row.reason = 'end_not_matched_to_message'; row.updatedAt = this.store.now();
      await this.store.save(row);
      this.trace('task_terminal', {state:'failed',reason:'end_not_matched_to_message',step});
      this.laneEvent('plan_done', {planId, state: 'failed', reason: 'end_not_matched_to_message'});
      return true;
    });
  }
  // Callback-time ownership is rechecked inside FIFO execution; a delayed END cannot finish a replacement row.
  ended(token, willContinue, expected) { return this.serial(async () => {
    const target = this.active;
    const targetMatches = typeof expected?.sessionId === 'string' && typeof expected.planId === 'string' &&
      Number.isSafeInteger(expected.step) && expected.step >= 0 && target?.row.sessionId === expected.sessionId &&
      target.row.id === expected.planId && target.row.nextStep === expected.step &&
      target.row.state === 'submitted' && target.submittedStep === expected.step;
    if (!targetMatches) {
      this.trace('run_correlation', {phase:'supervisor_end',tokenRejection:'submission_target_mismatch',step:Number.isSafeInteger(expected?.step) ? expected.step : -1});
      return;
    }
    const runPresent = this.run !== null;
    const tokenInvalid = token && typeof token === 'object' && token.valid === false;
    const tokenMatches = runPresent && token !== undefined && token !== null && token === this.run && !tokenInvalid;
    const continuation = typeof willContinue === 'boolean' ? String(willContinue) : 'unreadable';
    const tokenRejection = !this.active ? 'supervisor_missing' : !runPresent ? 'run_missing'
      : !tokenMatches ? 'token_mismatch' : typeof willContinue !== 'boolean' ? 'continuation_unreadable'
      : willContinue ? 'continuation_true' : this.closed || this.admissionInterrupted ? 'supervisor_shutdown' : 'none';
    this.trace('run_correlation', {phase:'supervisor_end',runEpoch:typeof token === 'object' ? token.epoch : token,runPresent,tokenPresent:token !== undefined && token !== null,
      tokenMatches,continuation,tokenRejection,fencePresent:Boolean(this.active?.fence)});
    if (!this.active) return;
    if (!runPresent) return this.finish('failed', 'start_event_missing');
    if (!tokenMatches) return this.finish('failed', 'end_not_matched_to_message');
    // The end matched this exact submission but its terminal field cannot be read: its own state, never replayed.
    if (typeof willContinue !== 'boolean') return this.finish('malformed', 'malformed_end');
    if (this.closed || this.admissionInterrupted) return this.finish('failed', 'supervisor_shutdown');
    // A true nonterminal phase retires only this native phase. The next START
    // must still match the captured submission owner, and no message is resent.
    if (willContinue) {
      this.run = null;
      this.continuationPending = true;
      return;
    }
    if (await this.store.cancelled(this.active.row.id)) return this.finish('aborted', 'future_steps_cancelled_execution_may_continue');
    if (this.closed || this.admissionInterrupted) return this.finish('failed', 'supervisor_shutdown');
    const active = this.active;
    const controller = new AbortController();
    active.admissionAbort = controller;
    let admission = false;
    let admissionFinished = false, cancellationObserved = false, cancellationCheckFailed = false, finalizingAdmission = false;
    let cancellationMonitorWake;
    const waitForNextCancellationCheck = () => new Promise(resolve => {
      let settled = false, timer;
      const done = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (cancellationMonitorWake === done) cancellationMonitorWake = undefined;
        resolve();
      };
      timer = setTimeout(done, 250);
      cancellationMonitorWake = done;
    });
    const cancellationMonitor = (async () => {
      while (!admissionFinished && !controller.signal.aborted) {
        try {
          if (await bounded(() => this.store.cancelled(active.row.id), 1000, 'cancel status timeout')) {
            cancellationObserved = true; controller.abort(); return;
          }
        } catch { cancellationCheckFailed = true; controller.abort(); return; }
        if (!admissionFinished && !controller.signal.aborted) await waitForNextCancellationCheck();
      }
    })();
    this.trace('run_correlation', {phase:'admission_start',runEpoch:typeof token === 'object' ? token.epoch : token,runPresent:true,tokenPresent:true,tokenMatches:token?.valid !== false,
      continuation:'false',fencePresent:Boolean(active.fence),admissionAttempted:true,lineage:'run_local_fenced'});
    const admissionOptions = {
      signal: controller.signal,
      onProgress: async progress => {
        if (this.active !== active) fail('active task changed during admission');
        active.row.outcomes.at(-1).admissionProgress = progress;
        active.row.updatedAt = this.store.now();
        await this.store.save(active.row);
      },
      onVerified: async evidence => {
        if (this.active !== active) fail('active task changed during admission');
        const outcome = active.row.outcomes.at(-1);
        delete outcome.admissionProgress;
        outcome.admissionProof = evidence;
        active.row.updatedAt = this.store.now();
        await this.store.save(active.row);
        // Final cancellation observation follows the final proof write. Native
        // reconciliation still checks file identity and live semantics afterward.
        if (finalizingAdmission) {
          try {
            if (await bounded(() => this.store.cancelled(active.row.id), 1000, 'cancel status timeout')) {
              cancellationObserved = true; controller.abort();
            }
          } catch { cancellationCheckFailed = true; controller.abort(); }
        }
      },
    };
    try {
      try {
        admission = await this.adapter.admitted(active.fence, admissionOptions);
      } catch { /* Unavailable proof stays unknown. */ }
      this.trace('run_correlation', {phase:'admission_result',runEpoch:typeof token === 'object' ? token.epoch : token,runPresent:true,tokenPresent:true,tokenMatches:token?.valid !== false,
        continuation:'false',fencePresent:Boolean(active.fence),admissionAttempted:true,admissionVerified:admission === true,
        lineage:admission === true ? 'exact_user_record_observed' : 'unproven'});
      if (this.active !== active) fail('active task changed during admission');
      if (this.closed || this.admissionInterrupted) return await this.finish('failed', 'supervisor_shutdown');
      if (cancellationCheckFailed) return await this.finish('failed', 'cancel_check_failed');
      if (cancellationObserved) return await this.finish('aborted', 'future_steps_cancelled_execution_may_continue');
      let cancelled = false;
      try { cancelled = await bounded(() => this.store.cancelled(active.row.id), 1000, 'cancel status timeout'); }
      catch { return await this.finish('failed', 'cancel_check_failed'); }
      if (this.closed || this.admissionInterrupted) return await this.finish('failed', 'supervisor_shutdown');
      if (cancellationCheckFailed) return await this.finish('failed', 'cancel_check_failed');
      if (cancelled || cancellationObserved) return await this.finish('aborted', 'future_steps_cancelled_execution_may_continue');
      if (controller.signal.aborted) return await this.finish('failed', 'supervisor_shutdown');
      if (admission !== true || (typeof this.adapter.receiptFence === 'function' &&
          active.row.outcomes.at(-1).admissionProof === undefined))
        return await this.finish('failed', 'message_not_confirmed_in_transcript');
      // Final revalidation includes a bounded cancellation observation after
      // proof persistence, followed by the native file/live-semantic checks.
      if (active.row.outcomes.at(-1).admissionProof?.kind === 'native-lineage-v1' &&
          typeof this.adapter.finalizeAdmission === 'function') {
        finalizingAdmission = true;
        try {
          admission = await this.adapter.finalizeAdmission(active.fence, active.row.outcomes.at(-1).admissionProof, admissionOptions);
        } catch { admission = false; }
      }
      if (this.closed || this.admissionInterrupted) return await this.finish('failed', 'supervisor_shutdown');
      if (cancellationCheckFailed) return await this.finish('failed', 'cancel_check_failed');
      if (cancellationObserved) return await this.finish('aborted', 'future_steps_cancelled_execution_may_continue');
      if (controller.signal.aborted) return await this.finish('failed', 'supervisor_shutdown');
      if (admission !== true) return await this.finish('failed', 'message_not_confirmed_in_transcript');
      // No await may separate this final live-owner/token gate from advancement.
      if (this.active !== active || this.run !== token || token?.valid === false)
        return await this.finish('failed', 'end_not_matched_to_message');
      let committed = false;
      try {
        committed = typeof this.adapter.commitAdmission !== 'function' ||
          this.adapter.commitAdmission(active.fence, active.row.outcomes.at(-1).admissionProof, token) === true;
      } catch { /* A failed commit cannot advance. */ }
      if (!committed) return await this.finish('failed', 'message_not_confirmed_in_transcript');
      delete active.admissionAbort;
      const { row, value } = active;
      row.outcomes.at(-1).admission = 'exact_user_record_observed';
      row.outcomes.at(-1).terminalObservation = 'run_end_observed';
      row.outcomes.at(-1).observedAt = this.store.now();
      row.nextStep++;
      this.run = null;
      active.submissionInvoked = false;
      active.prematureStart = false;
      if (row.nextStep === value.steps.length) return await this.finish('completed', 'all_planned_submissions_ended_success_unverified');
      // A terminal event does not prove successful work. The owner must explicitly
      // allow this transition in the plan, regardless of the preceding result.
      if (!value.steps[row.nextStep - 1].continueAfterEnd) return await this.finish('aborted', 'continuation_not_authorized');
      row.state = 'waiting'; row.updatedAt = this.store.now();
      await this.store.save(row);
    } finally {
      // Await terminal saves above before draining: otherwise a rejected save
      // can remain unhandled while an in-flight cancellation read completes.
      admissionFinished = true;
      cancellationMonitorWake?.();
      await cancellationMonitor;
    }
  }); }
  continue() { return this.serial(async () => {
    if (this.active?.row.state === 'waiting' && this.adapter.isIdle()) await this.submit();
  }); }
  interruptAdmission() {
    this.admissionInterrupted = true;
    this.active?.admissionAbort?.abort();
  }
  beginClose() {
    this.closed = true;
    this.interruptAdmission();
  }
  async close() {
    // Stop new admission synchronously and interrupt transcript observation,
    // then drain the serial lane. The native task itself is never cancelled.
    this.beginClose();
    await this.tail;
    // Retain the lock after any failed persistence; explicit offline recovery
    // is required so a second process cannot silently resume uncertain work.
    if (this.active) {
      try { await this.finish('failed', 'supervisor_shutdown'); }
      catch { if (this.lock) await this.lock.close(); this.lock = null; throw new Error('shutdown receipt failed; lock retained'); }
    }
    let left = false;
    if (this.lock) { await this.lock.close(); this.lock = null; this.lockLeft = left = !await unlinkRetry(this.lockFile); }
    this.trace('supervisor_close', {});
    // The adapter treats a failed close as "this session's own lock is left", so the next /bridge enable can take it over.
    if (left) throw new Error('Bridge lock file could not be removed because another program is holding it. Run /bridge enable to try again, or close OMP and delete that file.');
  }
}


// Private best-effort traces never control admission, receipts or authentication.
const TRACE_EVENTS = new Set(['connection_bound','session_start','supervisor_open','heartbeat','gate','reserved','dispatch_call','dispatch_returned','task_terminal','supervisor_close','error','admission_failure','run_correlation']);
const TRACE_CODES = new Set(['EPERM','EACCES','EBUSY','ENOENT','EIO','FILE_CHANGED','other']);
const TRACE_STATES = new Set(['reserved','submitting','submitted','waiting','completed','failed','aborted','expired','malformed']);
const TRACE_REASONS = new Set(['native-busy-or-pending','settle-wait','current-active','cancelled_before_submission','expired_before_submission','execution_may_continue','invalid_plan','plan_identity_mismatch','admission_fence_unavailable','session_changed_before_submission','context_changed_before_submission','submission_exception','overlapping_or_unexpected_run','start_event_missing','end_not_matched_to_message','cancel_check_failed','future_steps_cancelled_execution_may_continue','message_not_confirmed_in_transcript','all_planned_submissions_ended_success_unverified','continuation_not_authorized','supervisor_shutdown','model-switch-unproven','malformed_end']);
const TRACE_ADMISSION_FAILURES = new Set(['invalid_proof','file_identity_mismatch','file_truncated','fence_changed','malformed_json','branch_switch','ambiguous_compaction','user_count','user_content_shape','user_text_mismatch','probe_error','transcript_changed','append_integrity_mismatch','admission_aborted','admission_checkpoint_failed','admission_proof_persist_failed','native_snapshot_invalid','native_duplicate_id','native_parent_invalid','native_leaf_mismatch','native_branch_mismatch','native_header_invalid','native_owner_changed','native_continuation_conflict','native_prefix_changed','native_anchor_missing','native_boundary','native_user_count','native_user_mismatch','native_user_identity_changed','native_event_order','native_compaction_unconfirmed','native_endpoint_mismatch']);
const TRACE_CORRELATION_PHASES = new Set(['agent_start','message_end','agent_end','supervisor_start','supervisor_end','admission_start','admission_result']);
const TRACE_CONTINUATIONS = new Set(['false','true','unreadable']);
const TRACE_TOKEN_REJECTIONS = new Set(['none','run_missing','overlap','unexpected_state','token_mismatch','continuation_unreadable','continuation_true','supervisor_shutdown','terminal_stop_missing','identity_invalid','replayed_identity','native_identifier_mismatch','history_capacity','supervisor_missing','submission_target_mismatch','submission_marker_unconfirmed','conflicting_claimed_submission','no_submitted_target','claimed_submission','prior_submission']);
const TRACE_LINEAGES = new Set(['native_response_id','same_run_message_end','run_local_fenced','unavailable','exact_user_record_observed','unproven','claimed_submission','prior_submission','compaction_elided']);
const TRACE_TERMINAL_SIGNAL_REASONS = new Set(['non_boolean_field']);
function traceFields(input) {
  const out = {};
  for (const key of ['idle','pending','sessionMatches','cwdMatches','sessionFileMatches','closed','active','runPresent','tokenPresent','tokenMatches','startObserved','messageEndObserved','messageEndBeforeEnd','messageKeyAvailable','messageKeyMatches','nativeIdCompared','nativeIdMatches','assistantStop','fencePresent','admissionAttempted','admissionVerified']) if (typeof input[key] === 'boolean') out[key] = input[key];
  for (const key of ['submissionMarkerPresent','submissionMarkerMatches','submissionUserMatches','submissionUserUnique'])
    if (typeof input[key] === 'boolean') out[key] = input[key];
  for (const key of ['step','ticks','dropped','runEpoch','eventOrder','startOrder','messageEndOrder']) if (Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 1000000000) out[key] = input[key];
  if (TRACE_CODES.has(input.code)) out.code = input.code;
  else if (input.code !== undefined) out.code = 'other';
  if (TRACE_STATES.has(input.state)) out.state = input.state;
  if (TRACE_REASONS.has(input.reason)) out.reason = input.reason;
  if (TRACE_ADMISSION_FAILURES.has(input.failure)) out.failure = input.failure;
  if (TRACE_CORRELATION_PHASES.has(input.phase)) out.phase = input.phase;
  if (TRACE_CONTINUATIONS.has(input.continuation)) out.continuation = input.continuation;
  if (TRACE_TOKEN_REJECTIONS.has(input.tokenRejection)) out.tokenRejection = input.tokenRejection;
  if (TRACE_LINEAGES.has(input.lineage)) out.lineage = input.lineage;
  if (TRACE_TERMINAL_SIGNAL_REASONS.has(input.terminalSignalReason)) out.terminalSignalReason = input.terminalSignalReason;
  for (const key of ['identityMatches','fenceMatches','textMatches']) if (typeof input[key] === 'boolean') out[key] = input[key];
  if (Number.isSafeInteger(input.processedBytes) && input.processedBytes >= 0) out.processedBytes = input.processedBytes;
  if (Number.isSafeInteger(input.userCount) && input.userCount >= 0) out.userCount = Math.min(2, input.userCount);
  return out;
}
export class LocalTrace {
  // Three files <=48 KiB each; at most 32 pending records. Test limits only shrink.
  constructor(root, maxBytes = 49152) {
    this.directory = path.join(root, 'control'); this.file = path.join(this.directory, 'bridge-trace.jsonl');
    this.maxBytes = Number.isSafeInteger(maxBytes) ? Math.min(49152, Math.max(1024, maxBytes)) : 49152; this.queue = []; this.writing = false;
    this.tail = Promise.resolve(); this.dropped = 0; this.times = new Map(); this.lastGate = null;
  }
  record(event, input = {}) {
    if (!TRACE_EVENTS.has(event)) return;
    const now = Date.now();
    if (['heartbeat','admission_failure'].includes(event) && now - (this.times.get(event) ?? -Infinity) < 60000) return;
    if (event === 'gate' && input.reason === this.lastGate) return;
    if (event === 'gate') this.lastGate = input.reason;
    this.times.set(event, now);
    if (this.queue.length >= 32) { this.dropped = Math.min(1000000000, this.dropped + 1); return; }
    const row = { version: 1, time: now, pid: process.pid, event, ...traceFields(input) };
    if (this.dropped) { row.dropped = this.dropped; this.dropped = 0; }
    this.queue.push(JSON.stringify(row) + '\n');
    if (!this.writing) {
      this.writing = true;
      this.tail = (async () => {
        while (this.queue.length) {
          const line = this.queue.shift();
          try { await this.append(line); } catch { /* Trace failure never affects native work. */ }
        }
        this.writing = false;
      })();
    }
  }
  async append(line) {
    await plain(this.directory, true);
    // An exclusive, empty local guard serializes rotation across processes.
    // A stale guard disables traces only; it is never reclaimed automatically.
    const guard = path.join(this.directory, 'trace-write.lock');
    const lock = await fs.open(guard, 'wx', 0o600);
    try { await this.appendOwned(line); } finally { await lock.close(); await unlinkRetry(guard); }
  }
  async appendOwned(line) {
    await plain(this.directory, true);
    const files = [this.file, this.file + '.1', this.file + '.2'];
    // Refuse preexisting malformed, oversized or non-plain traces; never share
    // arbitrary old file contents under the sanitizer's name.
    for (const file of files) {
      try {
        const stat = await plain(file); if (stat.size > this.maxBytes) throw Error('trace bounds');
        if (!this.checked) {
          const text = await fs.readFile(file, 'utf8');
          for (const textRow of text.trimEnd().split('\n').filter(Boolean)) {
            const row = JSON.parse(textRow), cleaned = {version:1,time:row.time,pid:row.pid,event:row.event,...traceFields(row)};
            if (!TRACE_EVENTS.has(row.event) || !Number.isSafeInteger(row.time) || !Number.isSafeInteger(row.pid) || (Object.keys(cleaned).sort().join() !== Object.keys(row).sort().join() || Object.keys(row).some(key => row[key] !== cleaned[key]))) throw Error('trace shape');
          }
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.checked = true;
    let size = 0; try { size = (await plain(this.file)).size; } catch(e) { if(e.code !== 'ENOENT') throw e; }
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      await fs.unlink(files[2]).catch(e=>{if(e.code !== 'ENOENT') throw e;});
      await fs.rename(files[1],files[2]).catch(e=>{if(e.code !== 'ENOENT') throw e;});
      await fs.rename(files[0],files[1]);
    }
    const handle = await fs.open(this.file, 'a', 0o600);
    try { await handle.writeFile(line); } finally { await handle.close(); }
  }
  flush() { return this.tail; }
}

// Append-only lane transition log for the coordinator: control/lane-events.jsonl.
// One JSON line per transition, written within milliseconds of the event (the
// adapter samples native idle/busy every 2 s). Fixed fields and fixed vocabularies
// only: never task text, prompts, receipts' free text, host strings or errors.
// Two files of <=32 KiB (current + `.1`); a failure never affects native work.
export const LANE_EVENTS = Object.freeze(['idle', 'busy', 'plan_done', 'model_switched', 'model_mismatch', 'start_failed']);
const LANE_EVENT_SET = new Set(LANE_EVENTS);
const LANE_PLAN_STATES = new Set(['completed', 'failed', 'aborted', 'expired', 'malformed']);
const LANE_REASONS = new Set([...TRACE_REASONS, 'restart', 'native_idle', 'native_busy', 'pending_messages', 'plan_active', 'model_unverified', 'prompt_not_delivered', 'bridge_stopped']);
// A writer releases its guard by removing exactly the file it wrote (inode, creation time and the words it wrote into it). A file made since (a writer that was frozen past GUARD_HELD_MS can find its guard taken over), or one with other words in it, is never touched.
// When something holds the file at that moment (a scanner, say), the process remembers it and tries again at the next write to that same lane's log, or from a short timer of its own when nothing writes again, so the guard does not block every writer of the log until this process ends.
const leftGuards = new Map();
const guardMark = stat => `${stat.ino}:${stat.birthtimeMs}`;
const GUARD_HELD_MS = 10000;
async function removeLeftGuard(guard, tries = 5) {
  const left = leftGuards.get(guard);
  if (left === undefined) return true;
  leftGuards.delete(guard); // taken here, so two callers never both unlink
  // `ours` is undefined while the file cannot be read (held): that is tried again, like a held unlink.
  const ours = await Promise.all([fs.lstat(guard), fs.readFile(guard, 'utf8')]).then(([stat, text]) => guardMark(stat) === left.mark && text === left.text, e => e.code === 'ENOENT' ? false : undefined);
  if (ours === false || (ours && await unlinkRetry(guard))) return true;
  leftGuards.set(guard, left);
  if (tries > 1) setTimeout(() => removeLeftGuard(guard, tries - 1), 1000).unref();
  return false;
}
export class LaneEvents {
  constructor(root, sessionId, maxBytes = 32768) {
    if (!UUID.test(sessionId)) fail('invalid lane identity');
    this.sessionId = sessionId; this.directory = path.join(root, 'control'); this.file = path.join(this.directory, 'lane-events.jsonl');
    this.maxBytes = Number.isSafeInteger(maxBytes) ? Math.min(32768, Math.max(1024, maxBytes)) : 32768;
    this.queue = []; this.writing = false; this.tail = Promise.resolve(); this.dropped = 0; this.seq = 0;
  }
  record(event, input = {}) {
    if (!LANE_EVENT_SET.has(event)) return;
    if (this.queue.length >= 64) { this.dropped = Math.min(1000000000, this.dropped + 1); return; }
    const row = { version: 1, seq: ++this.seq, time: Date.now(), pid: process.pid, sessionId: this.sessionId, event };
    if (typeof input.planId === 'string' && UUID.test(input.planId)) row.planId = input.planId;
    if (LANE_PLAN_STATES.has(input.state) && (event === 'plan_done')) row.state = input.state;
    if (input.reason !== undefined) row.reason = LANE_REASONS.has(input.reason) ? input.reason : 'other';
    // Model rows carry OMP-reported selectors only: `requested` is the caller's name, `model` is what OMP says is running.
    if (event === 'model_switched' || event === 'model_mismatch') {
      if (isModelSelector(input.requested)) row.requested = input.requested;
      if (isModelSelector(input.model)) row.model = input.model;
    }
    const carried = this.dropped;
    if (carried) { row.dropped = carried; this.dropped = 0; }
    this.queue.push([JSON.stringify(row) + '\n', carried]);
    if (!this.writing) {
      this.writing = true;
      this.tail = (async () => {
        while (this.queue.length) {
          const [line, carried] = this.queue.shift();
          try { await this.append(line); } catch { this.dropped = Math.min(1000000000, this.dropped + 1 + carried); /* Lane events never affect native work; the lost row, and the count it carried, are counted in the next one. */ }
        }
        this.writing = false;
      })();
    }
  }
  async append(line) {
    await plain(this.directory, true);
    // Two writers (the OMP adapter and a failed model start) can reach the rotation together: a guard file makes them take turns.
    // A real writer holds the guard for a few milliseconds. A guard older than GUARD_HELD_MS is taken over by the next writer: its writer is gone (even when Windows has since given its process number to another program, judged by the start marker the guard records, which a changed clock cannot move) or is frozen, and then its own release leaves the new guard alone.
    const guard = path.join(this.directory, 'lane-events.lock');
    // A guard this process could not remove last time (something held the file) is still its own: remove it now, before waiting for it.
    if (!await removeLeftGuard(guard)) throw new Error('lane event guard could not be removed');
    let lock;
    for (const deadline = Date.now() + 2000; !lock;) {
      try { lock = await acquireLock(guard, { heldMs: GUARD_HELD_MS }); }
      catch (e) {
        if ((e.code !== 'EEXIST' && !SHARING.has(e.code)) || Date.now() >= deadline) throw e;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      const backup = this.file + '.1';
      let size = 0;
      try { size = (await plain(this.file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try { await plain(backup); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        await fs.unlink(backup).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await fs.rename(this.file, backup);
      }
      const handle = await fs.open(this.file, 'a', 0o600);
      try { await handle.writeFile(line); } finally { await handle.close(); }
    } finally {
      const stat = await lock.stat().catch(() => null);
      await lock.close();
      if (stat) { leftGuards.set(guard, { mark: guardMark(stat), text: lock.written }); await removeLeftGuard(guard); }
    }
  }
  flush() { return this.tail; }
}

// A guard file left by a crash must not block uninstall or upgrade forever. It is stale only when its owner is provably
// gone: it names a process that no longer runs, the PC has restarted since it was written (any process id in it was handed
// to someone else), or it names nobody and is older than any real run. A lock records how long the PC had been running when
// it was written (`up`); a restart makes that number start again from zero, and a corrected clock cannot change it, so a live
// run's lock never looks old when the clock is set forward. A lock without `up` (an older version wrote it) is judged by the
// clock. (Supervisor locks have their own rule.)
export const STALE_LOCK_MS = 30 * 60 * 1000;
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export async function isStaleLock(file, { now = Date.now, alive = pidAlive, uptime = os.uptime, heldMs = Infinity } = {}) {
  let stat, pid, up, kept;
  try {
    stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) return false;
    try { ({ pid, up, kept } = JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* no owner recorded */ }
  } catch { return false; }
  if (kept === true) return false; // marked by keepLock: only a person (or the documented check) removes it
  const beforeStart = stat.mtimeMs < now() - uptime() * 1000, old = now() - stat.mtimeMs > STALE_LOCK_MS;
  if (Number.isSafeInteger(pid) && pid > 0) return !alive(pid) || (typeof up === 'number' ? uptime() < up || (uptime() - up) * 1000 > heldMs : beforeStart && old);
  return beforeStart || old;
}
// An update that could not confirm its version pointer keeps its lock and marks it, so a later update cannot take it over as a dead owner's.
export async function keepLock(handle) {
  for (let tries = 1; ; tries++) {
    try { await handle.truncate(0); await handle.write(JSON.stringify({ pid: process.pid, kept: true }), 0); return true; }
    catch { if (tries >= 3) return false; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
}
export const isKeptLock = file => fs.readFile(file, 'utf8').then(text => { try { return JSON.parse(text)?.kept === true; } catch { return false; } }, () => false);
// Creates the guard file exclusively and records the owner. A stale leftover is removed once; EEXIST means a live owner.
export async function acquireLock(file, options) {
  for (let again = true; ; again = false) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      handle.written = JSON.stringify({ pid: process.pid, up: os.uptime() }); // the words in the file, kept so a caller can tell later that it is still this file
      await handle.writeFile(handle.written);
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST' || !again || !await isStaleLock(file, options)) throw error;
      await fs.unlink(file).catch(() => {});
    }
  }
}
