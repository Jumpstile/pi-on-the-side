import path from 'node:path';
import { withController, controllerStatus, CONTROLLER_ERRORS } from './controller.mjs';
import { NAME, CONNECTION_ERRORS, readConnections, loadConnections } from './connections.mjs';
import { MODEL_SELECTOR, isModelSelector, plan, QUEUE_LIMIT_MS, readJson, TERMINAL, UUID } from './control.mjs';
import { CANCEL_NOTE, diagnostic, exists, FIXED, loadSetup, MESSAGES } from './setup.mjs';
import { isOmpVersion } from './host.mjs';
import { lanesStatus, LANE_ERRORS, requireModelProven, startLaneTask } from './lane-status.mjs';
import { refreshCoordinatorHeartbeat } from './coordinator-heartbeat.mjs';
import { readNewWatchLines, WATCH_ERRORS } from './lane-watch.mjs';

// Optional local stdio MCP adapter over the same validated core. Trust boundary:
// the client (a desktop assistant) may only read explicitly registered setups'
// receipts, add finite one-prompt plans and cancel future steps. It cannot pick
// an unregistered session, path, continuation, deadline, review, recovery or launch. Nothing
// here listens on a network or starts OMP. A local controller capability file
// is read only at the write boundary; it is never exposed as a tool argument.
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = Object.freeze({ name: 'omp-session-bridge', version: '1.0.3' });
const MAX_FRAME = 64 * 1024;
const MAX_PENDING = 16;
const MAX_RETAINED = MAX_PENDING * MAX_FRAME;
const INSTRUCTIONS = 'Pi on the Side! lets your AI assistant control multiple OMP sessions over a local connection. Designed across OMP versions; compatibility problems are bugs to fix, though not every release has been tested. Choose a project, send an approved task, check progress and cancel before OMP accepts it. Work may continue during a temporary assistant disconnection only while OMP and its provider remain available. Receipts are observations, not proof; work that did not complete is never replayed automatically.';
const ENDED = 'That task already ended, so there is nothing to cancel.';
const NOT_FOUND = 'That task could not be found to cancel.';
const ALLOWED = new Set([...FIXED, ...CONNECTION_ERRORS, ...CONTROLLER_ERRORS, ...LANE_ERRORS, ...WATCH_ERRORS, 'invalid coordinator heartbeat', 'unknown plan id', ENDED, NOT_FOUND, 'plan id already used for different content', 'receipt not recognized', 'plan not recognized']);
const fail = message => { throw new Error(message); };

const ID = { type: 'string', pattern: UUID.source, description: 'Lowercase UUID of the plan.' };
const closed = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
export const TOOLS = Object.freeze([
  { name: 'bridge_status', title: 'Check progress',
    description: 'Check recorded progress for the selected project, or list named project connections. Prompts and conversation text are not returned.',
    inputSchema: closed(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'bridge_lanes_status', title: 'Check all lane states',
    description: 'Read a compact, content-free status for every registered lane, including recent transitions, queue state, attention flags and whether a visible coordinator wake-up is recommended. Never reviews or replays unknown receipts.',
    inputSchema: closed(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'bridge_lane_watch_lines', title: 'Read new lane watcher lines',
    description: 'Print only the lane watcher lines (IDLE, BUSY, RESULT, GONE, ERROR, EXPIRED) that were not shown before, for every registered lane, then mark them as shown. At most 100 lines come back per call: when "more" is true, more lines can be fetched, so call again right away until it is gone. A lane named in "unreadable" never keeps "more" on, because calling again cannot help it. An ERROR line means the watcher could not read its files: check that lane locally. An EXPIRED line means a queued task was not started because its time ran out: tell the user to queue it again. An empty list means nothing changed: stop without further calls. Reads local files only; no model, network or task text. It does not review, replay or change any receipt.',
    inputSchema: closed(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'bridge_coordinator_heartbeat', title: 'Mark coordinator active',
    description: 'Refresh the current directing coordinator marker for this lane. Requires the existing controller capability. Refresh each active lane every cycle and at least every 120 seconds while processing; suppresses watchdog launches for 180 seconds. Does not change task authority or review receipts.',
    inputSchema: closed(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'bridge_enqueue', title: 'Send one approved task',
    description: 'Send one task you approve to the selected OMP session. It expires after 24 hours (waiting behind a long task counts) and never starts follow-on work automatically. Provider availability and OMP approvals still apply. Provide a fresh plan ID; retrying identical content returns the existing plan.',
    inputSchema: closed({ id: ID, prompt: { type: 'string', minLength: 1, maxLength: 6000,
      description: 'The task instruction you approved. Tabs and newlines are the only control characters allowed.' },
      model: { type: 'string', pattern: MODEL_SELECTOR.source, description: 'Optional. A model name exactly as OMP lists it (for example from `omp models`). The task is queued only after OMP itself reports that model running; otherwise nothing is queued.' } }, ['id', 'prompt']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  { name: 'bridge_receipt', title: 'Check what was recorded',
    description: 'See what the bridge recorded for one task. A receipt is not proof that the task succeeded.',
    inputSchema: closed({ id: ID }, ['id']), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'bridge_cancel', title: 'Cancel future work',
    description: "Cancel future bridge steps before they start. This cannot stop work OMP has accepted; use OMP's own controls for that.",
    inputSchema: closed({ id: ID }, ['id']), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
]);
const SIGNATURES = new Map([['bridge_status', ''], ['bridge_lanes_status', ''], ['bridge_lane_watch_lines', ''], ['bridge_coordinator_heartbeat', ''], ['bridge_enqueue', ['id,prompt', 'id,model,prompt']], ['bridge_receipt', 'id'], ['bridge_cancel', 'id']]);
const single = (id, sessionId, prompt, expiresAt) => ({ version: 1, id, sessionId, expiresAt, steps: [{ prompt, continueAfterEnd: false }] });

// Schema enforcement happens before any state access; prompt rules are the core's.
function argumentsFor(name, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![SIGNATURES.get(name)].flat().includes(Object.keys(value).filter(key => key !== 'connection').sort().join())) return null;
  if ('model' in value && !isModelSelector(value.model)) return null;
  if ('connection' in value && (typeof value.connection !== 'string' || !NAME.test(value.connection))) return null;
  if (['bridge_lanes_status', 'bridge_lane_watch_lines'].includes(name) && 'connection' in value) return null;
  if ('id' in value && (typeof value.id !== 'string' || !UUID.test(value.id))) return null;
  if ('prompt' in value) {
    try { plan(single(value.id, value.id, value.prompt, Date.now() + QUEUE_LIMIT_MS)); } catch { return null; }
  }
  return value;
}

// Receipts are relayed only in their exact known shape; anything else is refused.
const STATES = new Set(['reserved', 'submitting', 'submitted', 'waiting', 'completed', 'failed', 'aborted', 'expired', 'malformed']);
// Exactly the reason codes the core (control.mjs Supervisor) writes. Any other
// text, however harmless it looks, could be private content and is refused.
const REASONS = new Set(['restart', 'future_steps_cancelled_execution_may_continue', 'execution_may_continue',
  'cancelled_before_submission', 'expired_before_submission', 'invalid_plan', 'plan_identity_mismatch',
  'session_changed_before_submission', 'admission_fence_unavailable', 'context_changed_before_submission', 'submission_exception',
  'overlapping_or_unexpected_run', 'start_event_missing', 'end_not_matched_to_message', 'cancel_check_failed', 'malformed_end', 'message_not_confirmed_in_transcript',
  'all_planned_submissions_ended_success_unverified', 'continuation_not_authorized', 'supervisor_shutdown']);
const RECEIPT_KEYS = new Set(['version', 'id', 'sessionId', 'state', 'reason', 'nextStep', 'updatedAt', 'outcomes', 'taskSuccess', 'automaticReplay']);
const OUTCOME_KEYS = new Set(['step', 'submission', 'admission', 'terminalObservation', 'observedAt',
  'admissionFence', 'admissionProgress', 'admissionProof']);
const step = value => Number.isSafeInteger(value) && value >= 0 && value <= 8;
const optional = (value, test) => value === undefined || test(value);
const fileIdentity = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const fileNumber = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function safeAdmissionFence(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === 'fileDev,fileIno,offset,prefixHash,start,textHash' &&
    fileIdentity(value.fileDev) && fileIdentity(value.fileIno) && fileNumber(value.start) &&
    fileNumber(value.offset) && value.start <= value.offset && value.offset - value.start <= 32768 &&
    hash(value.prefixHash) && hash(value.textHash);
}
function safeAdmissionProgress(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === 'appendHash,fenceOffset,fileDev,fileIno,processedOffset' &&
    fileIdentity(value.fileDev) && fileIdentity(value.fileIno) && fileNumber(value.fenceOffset) &&
    fileNumber(value.processedOffset) && value.processedOffset >= value.fenceOffset && hash(value.appendHash);
}
function safeNativeAdmissionProof(value) {
  const keys = ['kind','host','operationId','ownerEpoch','managerToken','sessionId','planId','step','cwd','file',
    'originalFence','anchorId','prefixCount','prefixDigest','idSetDigest','userId','userParentId','textLength',
    'textHash','userDigest','ancestryDigest','branchDigest','leafId','nativeDigest','headerDigest',
    'fileDev','fileIno','byteLength','contentDigest'];
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === keys.sort().join() && value.kind === 'native-lineage-v1' &&
    isOmpVersion(value.host) &&
    ['operationId','managerToken','sessionId','planId'].every(k => typeof value[k] === 'string' && UUID.test(value[k])) &&
    fileNumber(value.ownerEpoch) && step(value.step) &&
    ['cwd','file'].every(k => typeof value[k] === 'string' && value[k].length <= 32768 && path.isAbsolute(value[k])) &&
    safeAdmissionFence(value.originalFence) &&
    ['anchorId','userId','userParentId','leafId'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 256) &&
    fileNumber(value.prefixCount) && value.prefixCount > 0 && value.prefixCount <= 100000 &&
    fileNumber(value.textLength) && value.textLength <= 65536 &&
    ['prefixDigest','idSetDigest','textHash','userDigest','ancestryDigest','branchDigest','nativeDigest','headerDigest','contentDigest'].every(k => hash(value[k])) &&
    value.textHash === value.originalFence.textHash &&
    fileIdentity(value.fileDev) && fileIdentity(value.fileIno) && fileNumber(value.byteLength) && value.byteLength > 0;
}
function safeAdmissionProof(value) {
  if (value?.kind === 'native-lineage-v1') return safeNativeAdmissionProof(value);
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === 'appendHash,endOffset,fenceOffset,fileDev,fileIno' &&
    fileIdentity(value.fileDev) && fileIdentity(value.fileIno) && fileNumber(value.fenceOffset) &&
    fileNumber(value.endOffset) && value.endOffset >= value.fenceOffset && hash(value.appendHash);
}
function safeOutcome(row, receipt) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).every(key => OUTCOME_KEYS.has(key)) ||
      !step(row.step) || !['not_seen', 'returned'].includes(row.submission) || !['not_seen', 'run_end_observed'].includes(row.terminalObservation) ||
      !optional(row.admission, value => value === 'exact_user_record_observed') || !optional(row.observedAt, Number.isSafeInteger) ||
      !optional(row.admissionFence, safeAdmissionFence) || !optional(row.admissionProgress, safeAdmissionProgress) ||
      !optional(row.admissionProof, safeAdmissionProof) ||
      (row.admissionProof?.kind === 'native-lineage-v1' && !row.admissionFence) ||
      (row.admissionProgress && row.admissionFence && (row.admissionProgress.fileDev !== row.admissionFence.fileDev ||
        row.admissionProgress.fileIno !== row.admissionFence.fileIno || row.admissionProgress.fenceOffset !== row.admissionFence.offset)) ||
      (row.admissionProof && row.admissionFence && (row.admissionProof.kind === 'native-lineage-v1'
        ? Object.keys(row.admissionFence).some(k => row.admissionProof.originalFence[k] !== row.admissionFence[k]) ||
          row.admissionProof.sessionId !== receipt.sessionId || row.admissionProof.planId !== receipt.id || row.admissionProof.step !== row.step
        : row.admissionProof.fileDev !== row.admissionFence.fileDev ||
          row.admissionProof.fileIno !== row.admissionFence.fileIno || row.admissionProof.fenceOffset !== row.admissionFence.offset)) ||
      (row.admissionProgress && row.admissionProof && (row.admissionProof.kind === 'native-lineage-v1' ||
        row.admissionProof.endOffset < row.admissionProgress.processedOffset)))
    fail('receipt not recognized');
  return { step: row.step, submission: row.submission, terminalObservation: row.terminalObservation,
    ...(row.admission === undefined ? {} : { admission: row.admission }), ...(row.observedAt === undefined ? {} : { observedAt: row.observedAt }) };
}
function safeReceipt(row) {
  if (!Object.keys(row).every(key => RECEIPT_KEYS.has(key)) || row.version !== 1 || !STATES.has(row.state) ||
      !optional(row.reason, value => REASONS.has(value)) || !step(row.nextStep) ||
      !Number.isSafeInteger(row.updatedAt) || !Array.isArray(row.outcomes) || row.outcomes.length > 8 ||
      row.taskSuccess !== 'unverified' || row.automaticReplay !== false) fail('receipt not recognized');
  return { id: row.id, state: row.state, ...(row.reason === undefined ? {} : { reason: row.reason }), nextStep: row.nextStep,
    updatedAt: row.updatedAt, outcomes: row.outcomes.map(outcome => safeOutcome(outcome, row)), taskSuccess: 'unverified', automaticReplay: false };
}
const planFile = (store, id) => store.file('plans', id);
// A plan file is this session's only if it passes the core plan() rules (shape,
// prompts, step count, size) under its own filename. Expiry is checked for type
// only, by validating against an instant just before it: expired plans stay listed.
const ownPlan = (value, id, sessionId) => {
  if (value === null || typeof value !== 'object' || value.id !== id || value.sessionId !== sessionId || !Number.isSafeInteger(value.expiresAt)) return false;
  try { plan(value, value.expiresAt - 1); return true; } catch { return false; }
};
// Without a receipt, only a recognized own-session plan may be reported or cancelled.
async function recognized(store, id) {
  const row = await store.receipt(id);
  if (!row && !ownPlan(await readJson(planFile(store, id)), id, store.config.sessionId)) fail('plan not recognized');
  return row;
}
async function view(store, id) {
  const row = await recognized(store, id);
  const base = row ? safeReceipt(row) : { id, state: 'queued', taskSuccess: 'unverified', automaticReplay: false };
  return { ...base, cancelRequested: await store.cancelled(id) };
}

const OPERATIONS = {
  async bridge_coordinator_heartbeat({ store }, args, now) {
    return refreshCoordinatorHeartbeat(store, now());
  },
  async bridge_status({ store, lockFile }) {
    const plans = [];
    // One unusable receipt or plan file is reported by itself; the others stay visible.
    for (const id of await store.ids()) {
      try { plans.push(await view(store, id)); }
      catch { plans.push({ id, state: 'unreadable', problem: 'This plan or its receipt file could not be read. The other plans are shown normally.', taskSuccess: 'unverified', automaticReplay: false }); }
    }
    return { supervisorLock: await exists(lockFile) ? 'present' : 'absent', plans,
      note: 'A lock does not prove OMP is running. Receipts are observations; taskSuccess is always unverified.' };
  },
  async bridge_enqueue({ store }, { id, prompt }, now) {
    const value = single(id, store.config.sessionId, prompt, now() + QUEUE_LIMIT_MS);
    const result = (duplicate, expiresAt, state) => ({ id, state, duplicate, expiresAt, steps: 1, continueAfterEnd: false,
      note: 'Queued work starts only while OMP runs with this bridge; taskSuccess stays unverified.' });
    if (!await exists(planFile(store, id))) {
      try { await requireModelProven(store); await store.enqueue(value); return result(false, value.expiresAt, 'queued'); }
      catch (e) { if (e.message !== 'plan id already used') throw e; }
    }
    // Retry of the identical request is reported, never queued twice.
    const prior = await readJson(planFile(store, id)).catch(e => { if (e.code !== 'ENOENT') throw e; return null; }); // gone: retired after it ended
    const sameRequest = ownPlan(prior, id, store.config.sessionId) && prior.steps.length === 1 &&
      prior.steps[0].prompt === prompt && prior.steps[0].continueAfterEnd === false;
    if (!prior) fail('plan id already used'); // its plan was retired after the task ended: the id is spent, the content cannot be compared
    if (!sameRequest) fail('plan id already used for different content');
    return result(true, prior.expiresAt, (await view(store, id)).state);
  },
  // A finished task's plan may be retired to make room (Store.retire); its receipt stays, so a receipt alone answers.
  async bridge_receipt({ store }, { id }) {
    if (!await exists(planFile(store, id)) && !await store.receipt(id)) fail('unknown plan id');
    return view(store, id);
  },
  async bridge_cancel({ store }, { id }) {
    const row = await store.receipt(id), planned = await exists(planFile(store, id));
    if (!planned) {
      if (!row) fail('unknown plan id');
      safeReceipt(row);
    }
    if (row && TERMINAL.has(row.state)) fail(ENDED); // an ended task has nothing to cancel, so no cancel record is written
    if (!planned) fail(NOT_FOUND);
    await recognized(store, id);
    let alreadyRequested = false;
    try { await store.abort(id); }
    catch (e) { if (e.code !== 'EEXIST' || !await store.cancelled(id)) throw e; alreadyRequested = true; }
    return { id, cancelRequested: true, alreadyRequested, note: CANCEL_NOTE };
  },
};

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value, isError) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const validId = id => (typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const initializeParams = params => typeof params.protocolVersion === 'string' && params.protocolVersion.length > 0 &&
  params.protocolVersion.length <= 64 && record(params.capabilities) && record(params.clientInfo) &&
  typeof params.clientInfo.name === 'string' && typeof params.clientInfo.version === 'string';

// Shape for a chat client: just the lines. Empty means "nothing new, stop".
const watchLines = async (rows, now) => {
  const { lines, more, unreadable, unsaved } = await readNewWatchLines(rows, { now });
  const problems = [...unreadable.map(lane => ({ lane, problem: 'This lane\'s log could not be read. The other lanes are shown normally.' })),
    ...unsaved.map(lane => ({ lane, problem: 'This lane\'s place could not be saved, so the lines not shown here were held back and will come again on the next call. The other lanes are shown normally.' }))];
  return { lines, ...(more ? { more: true } : {}), ...(problems.length ? { unreadable: problems } : {}) };
};
// `modelTiming` (tries, retry delay, wait) exists for tests; production uses the defaults.
export function createServer({ stateRoot, controllerFile, now = Date.now, modelTiming = {}, sync } = {}) {
  // Lifecycle: 'new' -> 'initializing' (initialize answered) -> 'ready'
  // (notifications/initialized received). Tools are served only when ready.
  let phase = 'new';
  let tail = Promise.resolve();
  let pinned = null;
  const operate = async (name, loaded, args) => {
    if (name === 'bridge_enqueue' && args.model && !await exists(planFile(loaded.store, args.id)) && !await loaded.store.receipt(args.id)) {
      // Verify-then-send: the switch (several controller writes) happens first and the task is stored only after
      // OMP proves the model. A retry of an existing plan id skips the switch and reports the existing plan.
      let queued;
      const started = await startLaneTask({ store: loaded.store, model: args.model, controllerFile, ...modelTiming,
        enqueue: async () => { queued = await withController(loaded.store, controllerFile, () => OPERATIONS.bridge_enqueue(loaded, { id: args.id, prompt: args.prompt }, now)); return args.id; } });
      if (!started.started) fail('model switch not verified; task not sent');
      return { ...queued, model: { requested: started.model.requested, resolved: started.model.resolved ?? null, actual: started.model.actual ?? null, state: 'verified' } };
    }
    if (name === 'bridge_enqueue' || name === 'bridge_cancel' || name === 'bridge_coordinator_heartbeat') {
      return withController(loaded.store, controllerFile, () => OPERATIONS[name](loaded, args, now));
    }
    const result = await OPERATIONS[name](loaded, args, now);
    return name === 'bridge_status' ? { ...result, controller: await controllerStatus(loaded.store) } : result;
  };
  // The pinned root is revalidated on every call. The first valid setup's
  // session and launch identity is pinned for this process: a later, even
  // coherent, replacement of config and launch metadata is refused.
  const configured = async () => {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || stateRoot !== path.resolve(stateRoot) ||
        !await exists(stateRoot)) fail(MESSAGES.notConfigured);
    const loaded = await loadSetup(stateRoot, now);
    const identity = JSON.stringify([loaded.settings.sessionId, loaded.settings.cwd, loaded.launch.sessionFile, loaded.launch.executable]);
    pinned ??= identity;
    if (identity !== pinned) fail(MESSAGES.mismatch);
    return loaded;
  };
  // One bridge for every OMP session on this PC: a session saved after setup is bound automatically (only by an adapter that
  // holds the controller credential), and the list of connections is read fresh on every call.
  const refresh = async () => { try { await sync?.(); } catch { /* the sessions already bound keep working */ } };
  const listedTools = async () => {
    await refresh();
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || !await exists(path.join(stateRoot, 'connections.json'))) return TOOLS;
    if (pinned !== null) fail('connections changed; restart the adapter');
    const registry = await readConnections(stateRoot);
    const names = registry.connections.map(row => row.name);
    return TOOLS.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
      properties: ['bridge_lanes_status', 'bridge_lane_watch_lines'].includes(tool.name) ? tool.inputSchema.properties :
        { ...tool.inputSchema.properties, connection: { type: 'string', enum: names, description: 'Exact authorized connection; never inferred.' } },
      ...(['bridge_status','bridge_lanes_status','bridge_lane_watch_lines'].includes(tool.name) ? {} : { required: [...(tool.inputSchema.required ?? []), 'connection'] }) } }));
  };
  async function call(id, params) {
    if (!Object.keys(params).every(key => ['name', 'arguments', '_meta'].includes(key))) return error(id, -32602, 'Invalid params');
    if (typeof params.name !== 'string' || !SIGNATURES.has(params.name)) return error(id, -32602, 'Unknown tool');
    const args = argumentsFor(params.name, params.arguments);
    if (!args) return error(id, -32602, 'Invalid params');
    try {
      await refresh();
      if (typeof stateRoot === 'string' && path.isAbsolute(stateRoot) && await exists(path.join(stateRoot, 'connections.json'))) {
        if (pinned !== null) fail('connections changed; restart the adapter');
        const registry = await readConnections(stateRoot);
        if (params.name === 'bridge_status' && args.connection === undefined) {
          const { rows, unavailable } = await loadConnections(registry, now), connections = [];
          for (const row of rows) connections.push({ name: row.name, ...await operate('bridge_status', row.loaded, {}) });
          return reply(id, text({ connections: [...connections, ...unavailable.map(row => ({ name: row.name, unavailable: row.problem }))] }));
        }
        if (params.name === 'bridge_lanes_status' || params.name === 'bridge_lane_watch_lines') {
          const { rows, unavailable } = await loadConnections(registry, now);
          const shown = params.name === 'bridge_lanes_status' ? await lanesStatus(rows) : await watchLines(rows, now);
          return reply(id, text(unavailable.length ? { ...shown, unavailable: unavailable.map(({ name, problem }) => ({ name, problem })) } : shown));
        }
        if (!args.connection) fail('explicit connection required');
        const row = registry.connections.find(row => row.name === args.connection);
        if (!row) fail('unknown connection');
        const { rows: [found], unavailable } = await loadConnections({ connections: [row] }, now);
        if (!found) return reply(id, text({ error: unavailable[0].problem }, true));
        return reply(id, text({ connection: row.name, ...await operate(params.name, found.loaded, args) }));
      }
      if (args.connection !== undefined) fail('unknown connection');
      if (params.name === 'bridge_lanes_status') return reply(id, text(await lanesStatus([{ name: 'default', loaded: await configured() }])));
      if (params.name === 'bridge_lane_watch_lines') return reply(id, text(await watchLines([{ name: 'default', loaded: await configured() }], now)));
      return reply(id, text(await operate(params.name, await configured(), args)));
    }
    catch (e) { return reply(id, text({ error: diagnostic(e, ALLOWED) }, true)); }
  }
  async function dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return error(null, -32600, 'Invalid Request');
    const hasId = Object.hasOwn(message, 'id');
    const id = hasId && validId(message.id) ? message.id : null;
    // Responses to requests this server never sends carry no authority.
    if (typeof message.method !== 'string') return hasId && ('result' in message || 'error' in message) ? undefined : error(id, -32600, 'Invalid Request');
    if (!hasId) {
      // Notifications never act and never get a reply. Only the initialized
      // notification changes lifecycle state, and only after initialize.
      if (message.method === 'notifications/initialized' && message.jsonrpc === '2.0' && phase === 'initializing') phase = 'ready';
      return undefined;
    }
    if (message.jsonrpc !== '2.0' || id === null) return error(id, -32600, 'Invalid Request');
    const params = message.params ?? {};
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return error(id, -32602, 'Invalid params');
    switch (message.method) {
      case 'ping': return reply(id, {});
      case 'initialize':
        if (phase !== 'new') return error(id, -32600, 'Already initialized');
        if (!initializeParams(params)) return error(id, -32602, 'Invalid params');
        phase = 'initializing';
        return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      case 'tools/list':
        if (phase !== 'ready') return error(id, -32600, 'Server not initialized');
        try { return reply(id, { tools: await listedTools() }); }
        catch (e) { return error(id, -32603, diagnostic(e, ALLOWED)); }
      case 'tools/call': return phase === 'ready' ? call(id, params) : error(id, -32600, 'Server not initialized');
      default: return error(id, -32601, 'Method not found');
    }
  }
  // One operation at a time, in arrival order.
  const serial = operation => {
    const run = tail.then(operation).catch(() => error(null, -32603, 'Internal error'));
    tail = run;
    return run;
  };
  return { handle: line => serial(() => dispatch(line)), after: value => serial(() => value) };
}

// Newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol only;
// stderr carries fixed diagnostics only, each at most once per process.
// Flow control: an operation (oversized-frame errors included) stays pending
// until its reply has been handed to stdout, and replies are written only while
// stdout is not backed up. Lines are consumed only while fewer than MAX_PENDING
// operations are pending; otherwise input is paused and the unconsumed rest of
// the current read is kept. Retained input above MAX_RETAINED stops reading
// without acting on it. A client that stops reading therefore cannot make the
// server act or buffer without bound, and nothing it sent is skipped silently.
export function serve({ input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env, sessionSync } = {}) {
  const said = new Set();
  const say = message => { if (!said.has(message)) { said.add(message); errors.write('omp-session-bridge mcp: ' + message + '\n'); } };
  const stateRoot = env.OMP_BRIDGE_STATE;
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || stateRoot !== path.resolve(stateRoot)) say(MESSAGES.notConfigured);
  const server = createServer({ stateRoot, controllerFile: env.OMP_BRIDGE_CONTROLLER, sync: sessionSync });
  let parts = [], size = 0, discarding = false, pending = 0, blocked = false, backlog = null, stopped = false;
  const outbox = [];
  const flush = () => {
    while (outbox.length && !blocked) {
      pending--;
      if (!output.write(outbox.shift())) {
        blocked = true;
        output.once('drain', () => { blocked = false; flush(); pump(); });
      }
    }
  };
  const queue = work => {
    pending++;
    work().then(value => {
      if (value === undefined) pending--; else outbox.push(JSON.stringify(value) + '\n');
      flush(); pump();
    });
  };
  const line = buffer => {
    const text = buffer.toString('utf8').replace(/\r$/, '');
    if (text.trim()) queue(() => server.handle(text));
  };
  const tooLarge = () => { say('request too large; discarded'); queue(() => server.after(error(null, -32600, 'Request too large'))); };
  function pump() {
    while (backlog && !blocked && pending < MAX_PENDING) {
      const end = backlog.indexOf(10);
      if (end < 0) {
        // Partial frame: keep at most MAX_FRAME bytes, then discard to the next newline.
        if (!discarding && size + backlog.length > MAX_FRAME) { discarding = true; parts = []; size = 0; }
        else if (!discarding) { parts.push(backlog); size += backlog.length; }
        backlog = null;
        break;
      }
      const piece = backlog.subarray(0, end);
      backlog = end + 1 < backlog.length ? backlog.subarray(end + 1) : null;
      if (discarding || size + piece.length > MAX_FRAME) tooLarge();
      else line(Buffer.concat([...parts, piece]));
      parts = []; size = 0; discarding = false;
    }
    if (stopped) return;
    if (backlog || blocked || pending >= MAX_PENDING) input.pause(); else input.resume();
  }
  input.on('data', chunk => {
    if (stopped) return;
    if ((backlog?.length ?? 0) + chunk.length > MAX_RETAINED) {
      // Unconsumed input this large is never acted on: stop reading entirely.
      stopped = true; backlog = null; parts = [];
      say('input too large; stopping');
      input.destroy();
      return;
    }
    backlog = backlog ? Buffer.concat([backlog, chunk]) : chunk;
    pump();
  });
}
