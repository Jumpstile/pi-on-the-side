import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isModelSelector, LaneEvents, plain, readJson, UUID } from './control.mjs';
import { withController } from './controller.mjs';
import { exists } from './setup.mjs';

const fail = message => { throw new Error(message); };
export const LANE_ERRORS = ['invalid model id', 'model switch not verified; task not sent', 'prompt delivery not confirmed; lane start failed',
  'prompt delivery not confirmed; the task may have been queued, so check pots status before queueing it again'];
// Model and failed-start rows describe an attempt the bridge made; they never change idle/busy state.
const MODEL_EVENTS = ['model_switched', 'model_mismatch'];
const SIDE_EVENTS = [...MODEL_EVENTS, 'start_failed'];
// The writer rotates at 32768 bytes, but two writers can each pass that check on the same size; a few extra lines are normal.
const LANE_FILE_MAX = 32768 + 4096;
// Validated lane rows for one lane (control/lane-events.jsonl.1, then the current file), oldest first.
// Fixed fields and vocabularies only; malformed or foreign rows are skipped, never trusted.
// `events` are the idle/busy/plan transitions; `sideEvents` are model and failed-start rows.
async function readLaneRows(root, sessionId) {
  const directory = path.join(root, 'control');
  const events = [], sideEvents = [];
  for (const name of ['lane-events.jsonl.1', 'lane-events.jsonl']) {
    const file = path.join(directory, name);
    try {
      const stat = await plain(file);
      if (stat.size > LANE_FILE_MAX) fail('file too large');
      const content = await fs.readFile(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || Object.keys(row).some(key => !['version','seq','time','pid','sessionId','event','planId','state','reason','dropped','requested','model'].includes(key)) ||
            row.version !== 1 || !Number.isSafeInteger(row.seq) || row.seq < 1 || !Number.isSafeInteger(row.time) ||
            !Number.isSafeInteger(row.pid) || row.pid < 1 || row.sessionId !== sessionId ||
            !['idle','busy','plan_done','plan_unknown',...SIDE_EVENTS].includes(row.event) ||
            (row.planId !== undefined && !UUID.test(row.planId)) ||
            (row.requested !== undefined && !isModelSelector(row.requested)) || (row.model !== undefined && !isModelSelector(row.model)) ||
            (row.state !== undefined && !['completed','exhausted','unknown','failed','aborted','expired','malformed'].includes(row.state))) continue;
        // Rows written by older versions: "unknown" reads as failed and "exhausted" as completed.
        if (row.event === 'plan_unknown') row.event = 'plan_done';
        if (row.state === 'unknown') row.state = 'failed';
        if (row.state === 'exhausted') row.state = 'completed';
        (SIDE_EVENTS.includes(row.event) ? sideEvents : events).push(row);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const order = (a, b) => a.time - b.time || a.seq - b.seq;
  return { events: events.sort(order), sideEvents: sideEvents.sort(order) };
}
export const readLaneEvents = async (root, sessionId) => (await readLaneRows(root, sessionId)).events;

// Asks the running lane to switch models and waits for OMP's own report of the running model.
// Only `verified` is success. Every other outcome (unknown or ambiguous name, mismatch, nothing
// observed, no reply in time) is a failure and the caller must not send a task.
export async function switchModel(store, requested, { controllerFile, modelWaitMs = 60000, modelPollMs = 250 } = {}) {
  if (!isModelSelector(requested)) return { verified: false, state: 'invalid', requested: String(requested), observation: 'Give one model name or provider/id exactly as OMP lists it (no spaces).' };
  const id = crypto.randomUUID();
  await withController(store, controllerFile, () => store.requestCommand(id, `/model ${requested}`));
  const deadline = Date.now() + modelWaitMs;
  let receipt = await store.commandReceipt(id);
  while (['queued', 'dispatching'].includes(receipt?.state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, modelPollMs));
    receipt = await store.commandReceipt(id);
  }
  let note;
  if (receipt?.state === 'queued') {
    // Never leave a switch pending that could fire after the caller has given up.
    await withController(store, controllerFile, () => store.cancelCommand(id));
    receipt = await store.commandReceipt(id);
    if (receipt?.state === 'cancelled') note = 'No reply from the lane in time (not running, busy or bridge disabled); the request was cancelled.';
    else if (receipt?.state === 'queued') note = 'No reply from the lane in time, and the cancel could not be recorded, so the request may still be sent. Check the lane status.';
  } else if (receipt?.state === 'dispatching') note = 'The lane did not finish the switch in time; its outcome was not seen. Check the lane status.';
  return { verified: receipt?.state === 'verified', id, state: receipt?.state ?? 'not_found', requested,
    ...(receipt?.resolved ? { resolved: receipt.resolved } : {}), ...(receipt?.actual ? { actual: receipt.actual } : {}),
    observation: note ?? receipt?.observation };
}

// A queued task is refused while the newest model switch is unproven (the same condition that
// stops the supervisor admitting plans), so nothing is silently parked behind a bad switch.
// An unreadable receipt fails closed. A later verified switch clears it.
export async function requireModelProven(store) {
  let hold;
  try { hold = await store.modelHold(); } catch { fail('model switch not verified; task not sent'); }
  if (hold) fail('model switch not verified; task not sent');
}

// A lane is running only while its supervisor lock names a live process. A task queued for a lane that is not running waits until the lane is restored.
export async function laneSessionRunning(store) {
  let lock;
  try { lock = await readJson(path.join(store.config.root, 'supervisor-' + store.config.sessionId + '.lock')); } catch { return false; }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) return false;
  try { process.kill(lock.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export const NOT_RUNNING_NOTE = 'queued, session not running';
export const NOT_RUNNING_WARNING = 'Warning: this lane\'s session is not running, so nothing will pick this task up yet. Next: restore the lane with pots lane restore (the task waits for it), or cancel the task with pots cancel if you no longer want it.';

// Start a lane task: switch to the requested model (retrying a switch OMP reports as not matching),
// send the task only after OMP proves it, then confirm the task was stored. Every failure leaves a `start_failed` lane row, except the queue's
// own refusals (full, text not accepted): those are the reason itself and nothing was lost. `enqueue` stores the task and returns its plan id.
const RETRY_STATES = new Set(['mismatch', 'returned-unverified']);
export async function startLaneTask({ store, model, enqueue, controllerFile, tries = 6, retryDelayMs = 1000, ...timing }) {
  let result, attempts = 0;
  const events = new LaneEvents(store.config.root, store.config.sessionId);
  const failed = async reason => { events.record('start_failed', { reason }); await events.flush(); };
  do {
    if (attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    result = await switchModel(store, model, { controllerFile, ...timing });
  } while (!result.verified && RETRY_STATES.has(result.state) && ++attempts < tries);
  if (!result.verified) {
    if (result.state !== 'invalid') await failed('model_unverified');
    return { started: false, model: result };
  }
  // The queue's own refusals pass through unchanged. A failure of the disk or folder (it carries an OS error code, e.g. disk full) leaves a row.
  let planId;
  try { planId = await enqueue(); } catch (e) { if (typeof e?.code === 'string') await failed('prompt_not_delivered'); throw e; }
  // The task is stored now. One failed read of the plan list must not make it look undelivered (the coordinator would queue it a second time):
  // a passing error (a scanner or indexer holding the folder) is retried briefly, as Store.cancelled does.
  let stored = [], listed = false;
  for (const deadline = Date.now() + 500; ;) {
    try { stored = await store.ids(); listed = true; break; }
    catch { if (Date.now() >= deadline) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  // A list that never could be read does not show the task is missing: it may well be queued.
  if (!stored.includes(planId)) { await failed('prompt_not_delivered'); fail(LANE_ERRORS[listed ? 2 : 3]); }
  return { started: true, planId, model: result };
}

async function laneSummary({ store, lockFile }, connection) {
  const directory = path.join(store.config.root, 'control');
  const { events, sideEvents } = await readLaneRows(store.config.root, store.config.sessionId);
  const lastEvent = events.at(-1);
  const receipts = [], unreadable = [], ids = await store.ids();
  let queuedCount = 0, lastQueuedId = null;
  // One unusable plan or receipt is reported by itself (like bridge_status); the other plans are still counted.
  for (const id of ids) {
    try {
      if (!UUID.test(id)) fail('invalid plan identity');
      const receipt = await store.receipt(id);
      if (receipt && (receipt.id !== id || receipt.sessionId !== store.config.sessionId ||
          !['reserved','submitting','submitted','waiting','completed','failed','aborted','expired','malformed'].includes(receipt.state))) fail('invalid receipt identity');
      if (!receipt) { queuedCount++; lastQueuedId ||= id; }
      else receipts.push(receipt);
    } catch { unreadable.push({ id, state: 'unreadable', problem: 'This plan or its receipt file could not be read. The other plans are shown normally.' }); }
  }
  const lockPresent = await exists(lockFile);
  // An unproven model switch holds queued plans (Store.modelHold); a read failure here only hides the flag.
  let hold = null;
  try { hold = await store.modelHold(); } catch { hold = null; }
  const modelBlocked = queuedCount > 0 && hold !== null;
  const diagnosticFile = path.join(directory, 'dispatch-diagnostic.json');
  let diagnosticRow = null;
  try {
    const stat = await plain(diagnosticFile);
    if (stat.size <= 65536) {
      const value = await readJson(diagnosticFile);
      if (value?.version === 1 && Number.isSafeInteger(value.observedAt) &&
          typeof value.supervisorClosed === 'boolean' && typeof value.supervisorLockHeld === 'boolean') diagnosticRow = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Busy or idle comes only from the last idle/busy row: a finished or cancelled plan says nothing about whether OMP itself stopped.
  // A busy lane whose OMP process no longer exists (killed, crashed) is gone.
  const lastState = events.filter(row => row.event === 'idle' || row.event === 'busy').at(-1);
  const pidGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  const goneUnexpectedly = lastState?.event === 'busy' && (!lockPresent || pidGone(lastState.pid) ||
    (diagnosticRow?.supervisorClosed === true && diagnosticRow.observedAt >= lastState.time));
  const status = goneUnexpectedly ? 'gone' : lastState?.event === 'busy' ? 'busy' : 'idle';
  // A plan that was running when its bridge stopped (OMP restarted, crashed or was closed, or only the bridge was switched off) and never finished: no supervisor lock, or the OMP process that wrote the last state is gone.
  const running = receipts.find(row => ['reserved','submitting','submitted','waiting'].includes(row.state));
  const stopped = Boolean(running) && (!lockPresent || (lastState !== undefined && pidGone(lastState.pid)));
  const eventReceipt = lastEvent?.planId && receipts.find(row => row.id === lastEvent.planId);
  const lastReceipt = receipts.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const lastPlanId = lastEvent?.planId || lastReceipt?.id || lastQueuedId || null;
  const lastPlanState = eventReceipt?.state || lastEvent?.state ||
    (lastEvent?.event === 'busy' ? 'busy' : lastReceipt?.state || (lastQueuedId ? 'queued' : null));
  const finishedIdle = status === 'idle' && ['completed','failed','aborted','expired','malformed'].includes(lastPlanState);
  // `actual` is OMP's own live report written by the adapter each sample; the last
  // switch row supplies what was requested and whether OMP proved it.
  const lastModel = sideEvents.filter(row => MODEL_EVENTS.includes(row.event)).at(-1);
  const actual = diagnosticRow ? (isModelSelector(diagnosticRow.model) ? diagnosticRow.model : null) : lastModel?.model ?? null;
  // A proven switch stays `verified` only while OMP still reports that model.
  const model = { actual, requested: lastModel?.requested ?? null,
    state: !lastModel ? null : lastModel.event === 'model_mismatch' ? 'mismatch' : actual === lastModel.model ? 'verified' : 'changed-since',
    holdingPlans: Boolean(hold) };
  // A failed start stays actionable until the lane reports anything newer, or the model is switched (the documented recovery).
  const lastStart = sideEvents.filter(row => row.event === 'start_failed').at(-1);
  const lastSwitch = sideEvents.filter(row => row.event === 'model_switched').at(-1);
  const startFailed = Boolean(lastStart) && ![lastEvent, lastSwitch].some(row => row && row.time > lastStart.time);
  const needsAttention = finishedIdle || goneUnexpectedly || stopped || modelBlocked || model.state === 'mismatch' || startFailed || unreadable.length > 0;
  // Identity describes durable actionable facts, never observedAt/updatedAt or
  // periodic idle samples. A supervisor restart must not re-emit an old result.
  const facts = [];
  if (finishedIdle) {
    if (!UUID.test(lastPlanId)) fail('missing finished plan identity');
    const finished = receipts.filter(row => ['completed','failed','aborted','expired','malformed'].includes(row.state))
      .map(row => [row.id, row.state]);
    if (!finished.some(([id]) => id === lastPlanId)) finished.push([lastPlanId, lastPlanState]);
    facts.push(['finished', finished.sort(([a], [b]) => a.localeCompare(b))]);
  }
  if (goneUnexpectedly) facts.push(['gone', lastState.pid, lastState.seq, lastState.time, lastState.planId ?? null]);
  if (stopped) facts.push(['stopped', running.id, running.state]);
  if (modelBlocked) facts.push(['model-hold', hold.id]);
  if (model.state === 'mismatch') facts.push(['model', lastModel.requested ?? null, lastModel.model ?? null, lastModel.seq, lastModel.time]);
  if (startFailed) facts.push(['start_failed', lastStart.seq, lastStart.time]);
  if (unreadable.length) facts.push(['unreadable', unreadable.map(row => row.id).sort()]);
  const eventId = needsAttention && UUID.test(store.config.sessionId) && facts.length
    ? crypto.createHash('sha256').update(JSON.stringify([1, store.config.sessionId, facts])).digest('hex') : null;
  return { connection, lane: store.config.sessionId, status, lastEventTime: lastEvent?.time ?? null,
    lastPlanId, lastPlanState, queuedCount, ...(queuedCount > 0 && !await laneSessionRunning(store) ? { queuedNote: NOT_RUNNING_NOTE } : {}),
    needsAttention, eventId, model, ...(stopped ? { stopped: true, next: connection === 'default' ? 'Stopped: a task was running and no bridge is running it any more. Next: this lane is not a named connection, so run pots install, then pots status to see its name.' : `Stopped: a task was running and no bridge is running it any more. Next: run pots lane restore ${connection} to continue it.` } : {}), ...(unreadable.length ? { unreadable } : {}) };
}
// The one event id of a lane whose files cannot be read. The watchdog forgets it once the lane reads normally, so a later failure wakes the coordinator again.
export const unreadableEventId = lane => UUID.test(lane) ? crypto.createHash('sha256').update(JSON.stringify([1, lane, [['lane-unreadable']]])).digest('hex') : null;
// The session id (`lane`) is only for the wake-up watchdog on this PC (`internal`); the assistant never receives it.
// One lane whose files cannot be read is marked by itself; the other lanes are still reported.
function unreadableLane({ store }, connection) {
  const lane = store.config.sessionId;
  return { connection, lane, status: 'unknown', lastEventTime: null, lastPlanId: null, lastPlanState: null, queuedCount: 0, needsAttention: true,
    eventId: unreadableEventId(lane),
    model: { actual: null, requested: null, state: null, holdingPlans: false },
    unreadable: [{ id: 'lane', state: 'unreadable', problem: 'This lane\'s status files could not be read. The other lanes are shown normally.' }] };
}
export async function lanesStatus(connections, { internal = false } = {}) {
  const lanes = [];
  for (const row of connections) {
    let summary;
    try { summary = await laneSummary(row.loaded, row.name); } catch { summary = unreadableLane(row.loaded, row.name); }
    const { lane, ...visible } = summary; lanes.push(internal ? { lane, ...visible } : visible);
  }
  const anyRunning = lanes.some(row => row.status === 'busy');
  return { lanes, anyRunning, nextWakeUpSeconds: anyRunning ? 120 : null,
    note: 'Read-only state summary. Every finished plan has a definite state (completed, failed, malformed, aborted or expired) with a plain reason; none is ever replayed, and a plan that did not complete holds queued plans for only a few seconds. Schedule any wake-up at the shortest interval your client allows; nextWakeUpSeconds is only a ceiling.' };
}

// Queued tasks that never started because their time ran out (receipt: expired, expired_before_submission) in the last 7 days.
export const UNSTARTED_TEXT = 'A queued task was not started because the lane stayed busy until its time limit ran out. Queue it again when the lane is free.';
export async function unstartedPlans(rows, now = Date.now()) {
  const found = [];
  for (const { name, loaded } of rows) {
    try {
      for (const id of await loaded.store.ids()) {
        const receipt = await loaded.store.receipt(id);
        if (receipt?.state === 'expired' && receipt.reason === 'expired_before_submission' && now - receipt.updatedAt < 7 * 86400000) found.push({ name, id });
      }
    } catch { /* an unreadable lane is shown by the other checks */ }
  }
  return found;
}
