import { COMMAND_HOLD_MS, config, isModelSelector, proveModel, readJson, same, Store, Supervisor, writeJson, LocalTrace, LaneEvents } from '../src/control.mjs';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { validateSavedSession, fence, reconcileAdmission, captureNativeAdmission, invokeNativeAdmission,
  observeNativeAdmission, reconcileNativeAdmission, commitNativeAdmission, nativeAssistantStamp, nativeCompactionEnd } from '../src/transcript.mjs';
import { detectHost, terminalSignal, isOmpVersion, COPY_CLAIM, copyShouldStayOff, isCatalogCopy } from '../src/host.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

// OMP detaches message_end from agent_end. responseId is the native
// message identity when present; local fingerprints are bounded-work, bounded-memory replay evidence.
const MAX_IDENTITY_DEPTH = 128, MAX_IDENTITY_CHARACTERS = 65536, MAX_IDENTITY_NODES = 8192;
type IdentityBudget = { characters: number; nodes: number };
const identityBudget = (): IdentityBudget => ({ characters: MAX_IDENTITY_CHARACTERS, nodes: MAX_IDENTITY_NODES });
const consumeIdentityNode = (budget: IdentityBudget) => {
  if (budget.nodes <= 0) return false;
  budget.nodes--;
  return true;
};
function hashJsonString(hash: any, value: string, budget: IdentityBudget): boolean {
  if (value.length > budget.characters) return false;
  budget.characters -= value.length;
  hash.update('"');
  let chunk = '';
  const flush = () => { if (chunk) { hash.update(chunk); chunk = ''; } };
  const append = (part: string) => { if (chunk.length + part.length > 4096) flush(); chunk += part; };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22) append('\\"');
    else if (code === 0x5c) append('\\\\');
    else if (code === 0x08) append('\\b');
    else if (code === 0x0c) append('\\f');
    else if (code === 0x0a) append('\\n');
    else if (code === 0x0d) append('\\r');
    else if (code === 0x09) append('\\t');
    else if (code < 0x20) append(`\\u00${code.toString(16).padStart(2, '0')}`);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) append(value.slice(index, ++index + 1));
      else append(`\\u${code.toString(16).padStart(4, '0')}`);
    } else if (code >= 0xdc00 && code <= 0xdfff) append(`\\u${code.toString(16).padStart(4, '0')}`);
    else append(value[index]);
  }
  flush(); hash.update('"');
  return true;
}

function hashJsonValue(hash: any, value: any, depth: number, active: WeakSet<object>, budget: IdentityBudget, inArray = false): boolean {
  if (!consumeIdentityNode(budget)) return false;
  if (value === null) { hash.update('null'); return true; }
  if (typeof value === 'string') return hashJsonString(hash, value, budget);
  if (typeof value === 'boolean') { hash.update(value ? 'true' : 'false'); return true; }
  if (typeof value === 'number') { hash.update(Number.isFinite(value) ? JSON.stringify(value) : 'null'); return true; }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    if (inArray) { hash.update('null'); return true; }
    return false;
  }
  if (typeof value !== 'object' || depth >= MAX_IDENTITY_DEPTH || active.has(value)) return false;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of [Object.getOwnPropertyDescriptor(value, 'toJSON'),
    prototype && Object.getOwnPropertyDescriptor(prototype, 'toJSON')]) {
    if (descriptor && (descriptor.get || descriptor.set || typeof descriptor.value === 'function')) return false;
  }
  active.add(value);
  try {
    if (array) {
      hash.update('[');
      for (let index = 0; index < value.length; index++) {
        if (index) hash.update(',');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          if (String(index) in value || !hashJsonValue(hash, null, depth + 1, active, budget, true)) return false;
          continue;
        }
        if (descriptor.get || descriptor.set || !hashJsonValue(hash, descriptor.value, depth + 1, active, budget, true)) return false;
      }
      hash.update(']'); return true;
    }
    hash.update('{');
    let first = true;
    for (const key in value) {
      if (!consumeIdentityNode(budget)) return false;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) continue;
      if (descriptor.get || descriptor.set || !hashJsonString(hash, key, budget)) return false;
      const child = descriptor.value;
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      if (!first) hash.update(',');
      hash.update(':');
      if (!hashJsonValue(hash, child, depth + 1, active, budget)) return false;
      first = false;
    }
    hash.update('}'); return true;
  } finally { active.delete(value); }
}

function nativeResponseKey(message: any): string | null | undefined {
  const responseId = message?.responseId;
  if (responseId === undefined) return undefined;
  if (typeof responseId !== 'string' || !responseId) return null;
  const hash = createHash('sha256');
  if (!hashJsonString(hash, responseId, identityBudget())) return null;
  return hash.digest('hex');
}

function messageKey(message: any): string | undefined {
  if (message?.role !== 'assistant' ||
      !Number.isSafeInteger(message.timestamp) || message.timestamp <= 0 ||
      typeof message.provider !== 'string' || !message.provider || typeof message.model !== 'string' || !message.model ||
      typeof message.stopReason !== 'string' || !message.stopReason || !Array.isArray(message.content)) return;
  try {
    const hash = createHash('sha256'), active = new WeakSet<object>(), budget = identityBudget();
    hash.update('[');
    if (!hashJsonValue(hash, message.timestamp, 0, active, budget)) return;
    hash.update(',');
    if (!hashJsonString(hash, message.provider, budget)) return;
    hash.update(',');
    if (!hashJsonString(hash, message.model, budget)) return;
    hash.update(',');
    if (!hashJsonString(hash, message.stopReason, budget)) return;
    hash.update(',');
    if (!hashJsonValue(hash, message.content, 0, active, budget)) return;
    hash.update(']');
    return `fingerprint:${hash.digest('hex')}`;
  } catch { return; }
}

function verifiedTerminalStepReceipt(receipt: any, sessionId: string, planId: string, step: number): boolean {
  if (!receipt || receipt.id !== planId || receipt.sessionId !== sessionId ||
      !['waiting', 'completed'].includes(receipt.state) || receipt.automaticReplay !== false ||
      receipt.taskSuccess !== 'unverified' || !Number.isSafeInteger(step) || step < 0 ||
      !Number.isSafeInteger(receipt.nextStep) || receipt.nextStep !== step + 1 ||
      !Array.isArray(receipt.outcomes) || receipt.outcomes.length !== receipt.nextStep) return false;
  return receipt.outcomes.every((outcome: any, index: number) =>
    outcome?.step === index && outcome.admission === 'exact_user_record_observed' &&
    outcome.terminalObservation === 'run_end_observed');
}



const TUI_COMMANDS: Record<string, true> = {
  help: true, model: true, switch: true, new: true, fresh: true, resume: true, delete: true, session: true, tree: true, branch: true,
  compact: true, clear: true, export: true, rename: true, settings: true, login: true, logout: true, mcp: true,
  retry: true, handoff: true, usage: true, tools: true, advisor: true, skills: true, shutdown: true, quit: true,
  pause: true, live: true, record: true, force: true, security: true, ssh: true, todo: true, dump: true, share: true,
  collab: true, trace: true, stats: true, jobs: true, fast: true, slow: true, shake: true, move: true,
};
type BridgeBinding = { sessionId: string; cwd: string; root: string };
const processUptimeMs = () => Math.floor(process.uptime() * 1000);


function slashName(text: string): string | undefined {
  return /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(text)?.[1];
}

function modelName(text: string): string | undefined {
  const match = /^\/model\s+(\S+)$/.exec(text);
  return match && isModelSelector(match[1]) ? match[1] : undefined;
}

type PiModel = Parameters<ExtensionAPI['setModel']>[0];
type OmpModels = { list(): Promise<unknown>; resolve(name: string, listed: unknown): Promise<unknown>; current(): Promise<unknown> };
const field = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
const call = (value: unknown, key: string, ...args: unknown[]): unknown => {
  const member = field(value, key);
  return typeof member === 'function' ? Reflect.apply(member, value, args) : undefined;
};
const selectorOf = (model: unknown): string | null => {
  const provider = field(model, 'provider'), id = field(model, 'id');
  const value = typeof provider === 'string' && typeof id === 'string' ? `${provider}/${id}` : null;
  return value !== null && isModelSelector(value) ? value : null;
};
// What OMP reports as the running model right now (live `ctx.models.current()`, else `ctx.model`).
const currentModel = (ctx: unknown): unknown => {
  const facade = field(ctx, 'models');
  return typeof field(facade, 'current') === 'function' ? call(facade, 'current') : field(ctx, 'model');
};
// The running model selector for status output; never throws.
const runningModel = (ctx: unknown): string | null => { try { return selectorOf(currentModel(ctx)); } catch { return null; } };
// OMP's own `ctx.models` lists and resolves names exactly as `--model` does. A host without it
// still exposes its registry, which supports an exact provider/id only. POTS keeps no model list,
// alias or guess: every name is confirmed by OMP at the moment of use.
function ompModels(ctx: unknown): OmpModels | undefined {
  const facade = field(ctx, 'models'), registry = field(ctx, 'modelRegistry');
  if (typeof field(facade, 'list') === 'function' && typeof field(facade, 'resolve') === 'function') {
    return { list: async () => call(facade, 'list'), resolve: async name => call(facade, 'resolve', name), current: async () => currentModel(ctx) };
  }
  if (typeof field(registry, 'getAvailable') === 'function') {
    return { list: async () => call(registry, 'getAvailable'), current: async () => currentModel(ctx),
      resolve: async (name, listed) => Array.isArray(listed) ? listed.find(entry => selectorOf(entry) === name) : undefined };
  }
  return undefined;
}
const reportedText = (reported: string[]): string => {
  const names = [...new Set(reported)].sort();
  let text = '';
  for (const [index, entry] of names.entries()) {
    if (text.length + entry.length > 1500) return `${text} (+${names.length - index} more)`;
    text += (text ? ', ' : '') + entry;
  }
  return text || 'no available models';
};

async function processCommand(store: Store, pi: ExtensionAPI, ctx: ExtensionContext, bound: BridgeBinding,
  file: string, supervisor: Supervisor, laneEvents?: InstanceType<typeof LaneEvents>, proofOptions?: { attempts?: number; delayMs?: number }) {
  if (supervisor.closed || supervisor.admissionInterrupted || !ctx.isIdle() || ctx.hasPendingMessages() ||
      supervisor.active || ctx.sessionManager.getSessionId() !== bound.sessionId) return;
  for (const id of await store.commandIds()) {
    let receipt: any;
    try { receipt = await store.commandReceipt(id); } catch { continue; } // an unreadable receipt stays held (Store.modelHold) and must not block later requests
    if (receipt?.state !== 'queued') continue;
    if (store.now() - receipt.updatedAt > COMMAND_HOLD_MS) { await store.updateCommandReceipt(id, 'cancelled', 'no reply in time; not sent'); continue; }
    let request;
    try { request = await store.commandRequest(id); } catch { continue; } // same: an unreadable request is held on its own
    const name = slashName(request.command);
    if (!name) { await store.updateCommandReceipt(id, 'unsupported', 'invalid slash command'); continue; }
    if (name !== 'model') {
      if (typeof pi.getCommands !== 'function') {
        await store.updateCommandReceipt(id, 'unsupported', 'OMP command discovery capability unavailable; slash not submitted as model text');
        continue;
      }
      let registered: ReturnType<ExtensionAPI['getCommands']>;
      try { registered = pi.getCommands(); }
      catch {
        await store.updateCommandReceipt(id, 'unsupported', 'OMP command discovery failed; slash not submitted as model text');
        continue;
      }
      if (!Array.isArray(registered)) {
        await store.updateCommandReceipt(id, 'unsupported', 'OMP command discovery returned invalid data; slash not submitted as model text');
        continue;
      }
      const command = registered.find(entry => entry.name === name);
      const reason = command ? `native ${command.source} command dispatch is not exposed by OMP ExtensionAPI`
        : TUI_COMMANDS[name] ? 'built-in TUI dispatcher is not exposed by OMP ExtensionAPI'
          : 'command not exposed by getCommands; it may be TUI-only or unknown; no model prompt fallback';
      await store.updateCommandReceipt(id, 'unsupported', reason);
      continue;
    }
    const requested = modelName(request.command);
    if (!requested) {
      await store.updateCommandReceipt(id, 'unsupported', 'native /model menu or malformed selection cannot be invoked through ExtensionAPI');
      continue;
    }
    const omp = ompModels(ctx);
    if (typeof pi.setModel !== 'function' || !omp) {
      await store.updateCommandReceipt(id, 'unsupported', 'OMP setModel or model registry capability unavailable', { requested });
      continue;
    }
    if (supervisor.closed || supervisor.admissionInterrupted) return;
    let listed: unknown;
    try { listed = await omp.list(); }
    catch {
      await store.updateCommandReceipt(id, 'unsupported', 'OMP could not list its available models; nothing was switched', { requested });
      continue;
    }
    if (supervisor.closed || supervisor.admissionInterrupted) return;
    const reported = Array.isArray(listed) ? listed.map(selectorOf).filter((entry): entry is string => entry !== null) : [];
    // A bare name carried by several providers is ambiguous: OMP would rank them silently, a lane must not.
    const carriers = requested.includes('/') || requested.startsWith('@') ? [] : reported.filter(entry => entry.slice(entry.indexOf('/') + 1).toLowerCase() === requested.toLowerCase());
    if (carriers.length > 1) {
      await store.updateCommandReceipt(id, 'unsupported', `model name "${requested}" is ambiguous; use the exact provider/id. OMP reports: ${carriers.join(', ')}`, { requested });
      continue;
    }
    let resolved: unknown;
    try { resolved = await omp.resolve(requested, listed); } catch { resolved = undefined; }
    const wanted = selectorOf(resolved);
    if (!wanted || !reported.includes(wanted)) {
      await store.updateCommandReceipt(id, 'unsupported', `OMP does not recognise model "${requested}" as an available model. OMP reports: ${reportedText(reported)}`, { requested });
      continue;
    }
    const fileNow = ctx.sessionManager.getSessionFile?.();
    if (supervisor.closed || supervisor.admissionInterrupted || ctx.sessionManager.getSessionId() !== bound.sessionId ||
        !same(fileNow ?? '', file) || !same(ctx.cwd, bound.cwd) || !ctx.isIdle() || ctx.hasPendingMessages() || supervisor.active) return;
    const started = await store.updateCommandReceipt(id, 'dispatching', 'native model selection admitted');
    if (started?.state !== 'dispatching') continue;
    const lifecycleInterrupted = supervisor.closed || supervisor.admissionInterrupted;
    if (lifecycleInterrupted || ctx.sessionManager.getSessionId() !== bound.sessionId ||
        !same(ctx.sessionManager.getSessionFile?.() ?? '', file) ||
        !same(ctx.cwd, bound.cwd) || !ctx.isIdle() || ctx.hasPendingMessages() || supervisor.active) {
      await store.updateCommandReceipt(id, 'failed', lifecycleInterrupted
        ? 'bridge lifecycle interrupted after admission; request will not replay'
        : 'native session changed after admission; request will not replay');
      return;
    }
    const asked = { requested, resolved: wanted };
    try {
      // Nothing to switch when OMP already reports the requested model; the proof below still runs.
      let already = false;
      try { already = selectorOf(await omp.current()) === wanted; } catch { already = false; }
      // The resolved value is a Model object OMP itself returned; selectorOf confirmed its identity above.
      const changed = already ? true : await pi.setModel(resolved as PiModel);
      if (changed === true) {
        // setModel's return value is not evidence. Only OMP's own report of the running model proves the switch.
        const proof = await proveModel(async () => selectorOf(await omp.current()), wanted, proofOptions);
        const seen = { ...asked, ...(proof.actual ? { actual: proof.actual } : {}) };
        if (proof.proven) {
          await store.updateCommandReceipt(id, 'verified', 'OMP reports the requested model is running', seen);
          laneEvents?.record('model_switched', { requested, model: proof.actual });
        } else {
          await store.updateCommandReceipt(id, proof.actual ? 'mismatch' : 'returned-unverified', proof.actual
            ? `setModel returned true but OMP reports ${proof.actual} running, not ${wanted}; switch not proven, send no task`
            : 'setModel returned true but OMP did not report the running model; switch not proven, send no task', seen);
          laneEvents?.record('model_mismatch', { requested, model: proof.actual });
        }
      }
      else if (changed === false) await store.updateCommandReceipt(id, 'unsupported', 'setModel returned false; requested model was not selected', asked);
      else await store.updateCommandReceipt(id, 'failed', 'setModel returned an unrecognized result; request will not replay', asked);
    } catch {
      await store.updateCommandReceipt(id, 'failed', 'setModel outcome could not be observed; request will not replay', asked);
    }
    return;
  }
}
export default createBridge(detectHost);

const SELF_FILE = fileURLToPath(import.meta.url);
const copyClaim = globalThis as unknown as Record<symbol, string | undefined>;

// `detect` is injectable so offline tests can model the supported host without
// an OMP binary; production always uses detectHost on the running executable.
// The optional hook is a test-only barrier for deterministic persistence-race fixtures.
export function createBridge(detect: () => Promise<string | null>, testHooks?: {
  afterEmptyAdmissionProbe?: () => void | Promise<void>;
  beforeSubmissionFence?: (text: string) => void | Promise<void>;
  modelProof?: { attempts?: number; delayMs?: number };
}) {
  return function bridge(pi: ExtensionAPI) {
  let supervisor: Supervisor | undefined, timer: any, bound: any, sessionContext: any, activeSessionFile: string | undefined, host: string | null = null;
  let lane = Promise.resolve();
  // Set when a stop failed and left this session's own lock file behind: the next enable may take that one file over.
  let ownLockLeft = false;
  let trace: any, laneEvents: InstanceType<typeof LaneEvents> | undefined, lastLaneIdle: boolean | undefined;
  // Local runtime observations contain only fixed metadata, never task/error text.
  // Its independent persistence lane never changes supervisor admission or receipts.
  let diagnosticLane = Promise.resolve(), diagnosticWriting = false, pendingDiagnostic: any;
  let tickCount = 0, lastTickAt: number | null = null;
  let lastTickFinishedAt: number | null = null, lastSupervisorError: string | null = null;
  let terminalConflictPending = false, terminalMessagePending: any, terminalPendingTicket: any, recentTerminal: any;
  let ownerEpoch = 0, fenceOwnerEpoch = 0, nativeAdmission: any;
  const invalidateOwnership = () => {
    ownerEpoch++;
    if (nativeAdmission) nativeAdmission.valid = false;
    if (currentRunToken) currentRunToken.valid = false;
    if (stagedStart?.token) stagedStart.token.valid = false;
    awaitingStart = undefined; // a "late START" is only read for the ownership it was announced under
    if (terminalPendingTicket?.token) terminalPendingTicket.token.valid = false;
    supervisor?.active?.admissionAbort?.abort();
  };
  const observeAdmission = (phase: string, event: any) => {
    const wasValid = nativeAdmission?.valid;
    const ownedPhaseToken = currentRunExpected?.owner === supervisor?.active && !stagedStart ? currentRunToken : undefined;
    observeNativeAdmission(nativeAdmission, phase, event, ownedPhaseToken);
    if (wasValid && !nativeAdmission.valid) {
      trace?.record('admission_failure', {failure:nativeAdmission.failure});
      invalidateOwnership();
    }
  };
  const snapshot = (phase: string) => {
    if (!bound) return Promise.resolve();
    const flag = (read: () => boolean) => { try { const value = read(); return typeof value === 'boolean' ? value : null; } catch { return null; } };
    const record = { version: 1, bridgeVersion: '1.0.11', pid: process.pid, parentPid: process.ppid,
      processUptimeMs: processUptimeMs(), observedAt: Date.now(), phase, timerPresent: timer !== undefined, tickCount, lastTickAt,
      lastTickFinishedAt, idle: flag(() => sessionContext.isIdle()),
      pendingMessages: flag(() => sessionContext.hasPendingMessages()),
      sessionMatches: flag(() => sessionContext.sessionManager.getSessionId() === bound.sessionId),
      cwdMatches: flag(() => same(sessionContext.cwd, bound.cwd)),
      sessionFileMatches: flag(() => activeSessionFile !== undefined &&
        same(sessionContext.sessionManager.getSessionFile(), activeSessionFile)),
      supervisorPresent: Boolean(supervisor), supervisorClosed: supervisor?.closed ?? null,
      supervisorLockHeld: Boolean(supervisor?.lock), activeState: supervisor?.active?.row.state ?? null,
      runPresent: supervisor?.run !== null && supervisor?.run !== undefined, lastSupervisorError, model: runningModel(sessionContext) };
    trace?.record('heartbeat', {idle:record.idle,pending:record.pendingMessages,sessionMatches:record.sessionMatches,cwdMatches:record.cwdMatches,sessionFileMatches:record.sessionFileMatches,closed:record.supervisorClosed,active:Boolean(record.activeState),ticks:tickCount});
    const file = path.join(bound.root, 'control', 'dispatch-diagnostic.json');
    // One writer and one latest snapshot: a slow filesystem cannot accumulate
    // an unbounded telemetry queue or delay the supervisor's serial lane.
    pendingDiagnostic = { file, record };
    if (!diagnosticWriting) {
      diagnosticWriting = true;
      diagnosticLane = (async () => {
        while (pendingDiagnostic) {
          const next = pendingDiagnostic; pendingDiagnostic = undefined;
          try { await writeJson(next.file, next.record); } catch { /* Status is best effort; admission is unchanged. */ }
        }
        diagnosticWriting = false;
      })();
    }
    return diagnosticLane;
  };
  // Coordinator-visible idle/busy edge, sampled on the 2 s timer (and once at
  // enable), independent of the serialized supervisor lane so a slow admission
  // cannot delay it. Idle means ready for the next plan: native idle, nothing
  // pending, and no active bridge plan. Reasons are a fixed vocabulary.
  const observeLane = () => {
    const owned = supervisor, ctx = sessionContext;
    if (!laneEvents || !owned || owned.closed || !ctx) return;
    let idle: unknown, pending: unknown;
    try { idle = ctx.isIdle(); pending = ctx.hasPendingMessages(); } catch { return; }
    if (typeof idle !== 'boolean' || typeof pending !== 'boolean') return;
    const activeId = owned.active?.row.id;
    // An OMP turn the bridge could not match holds queued tasks (unless its release is already waiting for the next wake), so the lane is not ready then either.
    const ready = idle && !pending && !activeId && (!unownedBlocked || Boolean(unownedRelease));
    if (ready === lastLaneIdle) return;
    lastLaneIdle = ready;
    laneEvents.record(ready ? 'idle' : 'busy', { planId: ready ? undefined : activeId,
      reason: ready ? 'native_idle' : !idle ? 'native_busy' : pending ? 'pending_messages' : activeId ? 'plan_active' : 'native_busy' });
  };
  const bindingMatches = (ctx: any, settings: any, file = activeSessionFile) => {
    try {
      return Boolean(file) && sessionContext === ctx && ctx.agent.kind === 'main' &&
        bound?.sessionId === settings.sessionId && same(bound.cwd, settings.cwd) && same(bound.root, settings.root) &&
        settings.sessionId === ctx.sessionManager.getSessionId() && same(settings.cwd, ctx.cwd) &&
        activeSessionFile !== undefined && same(activeSessionFile, file) &&
        same(ctx.sessionManager.getSessionFile(), file);
    } catch { return false; }
  };
  const wakeVerifiedTerminal = async (ticket: any) => {
    const owned = ticket?.owned, settings = ticket?.settings, ctx = ticket?.ctx;
    if (!owned || !settings || !ctx || ticket.token?.valid === false ||
        terminalConflictPending || terminalMessagePending === ticket.token ||
        supervisor !== owned || owned.closed || sessionContext !== ctx || bound !== settings ||
        !bindingMatches(ctx, settings)) return;
    try {
      const receipt = await new Store(settings).receipt(ticket.planId);
      if (!verifiedTerminalStepReceipt(receipt, settings.sessionId, ticket.planId, ticket.step) ||
          ticket.token.valid === false || terminalConflictPending || terminalMessagePending === ticket.token ||
          supervisor !== owned || owned.closed || sessionContext !== ctx || bound !== settings ||
          !bindingMatches(ctx, settings)) return;
      wake(true);
    } catch { /* No durable terminal receipt, no event-driven handoff. */ }
  };

  const notify = (ctx: any, text: string, type: 'info' | 'warning' = 'info') => ctx.ui.notify(text, type);

  // The last lane edge the watcher read may be `busy`. Once the bridge stops (disabled or faulted) nothing samples the lane any more,
  // so a closing `idle` edge says the bridge no longer holds the lane; otherwise the watcher would report `busy` until OMP exits.
  const endLaneFeed = () => {
    if (laneEvents && lastLaneIdle === false) { lastLaneIdle = true; laneEvents.record('idle', { reason: 'bridge_stopped' }); }
  };
  const stop = async () => {
    invalidateOwnership();
    supervisor?.interruptAdmission();
    if (timer !== undefined) { sessionContext.clearTimer(timer); timer = undefined; }
    clearTimeout(idleRetry); idleRetry = undefined; wakePending = false; idleRetryCount = 0;
    const pending = terminalPendingTicket;
    if (terminalMessagePending && pending && supervisor === pending.owned) {
      terminalConflictPending = true;
      let quarantined = false;
      try { quarantined = await pending.owned.invalidateRun(pending.token, pending.planId, pending.step); } catch { /* reported below */ }
      // Not stopped: leave the supervisor faulted (no more polls) so /bridge status says so and /bridge enable stops it again first.
      if (!quarantined) { pending.owned.beginClose(); endLaneFeed(); throw new Error('Bridge could not stop yet: a finished task is not matched to its receipt. Run /bridge enable to try again; if it keeps failing, inspect local receipts and offline recovery.'); }
      terminalMessagePending = undefined; terminalPendingTicket = undefined; terminalConflictPending = false;
    }
    endLaneFeed();
    const owned = supervisor; supervisor = undefined;
    // Even when the close fails (its lock stays; the next enable takes over this session's own leftover lock) nothing is running here any more: forget this run's state.
    try { if (owned) { owned.beginClose(); await owned.close(); } }
    catch (error) { ownLockLeft = true; throw error; }
    finally { activeSessionFile = undefined; resetRunState(); recentTerminal = undefined; }
  };
  const start = async (ctx: any, automatic = false) => {
    if (!bound || ctx.agent.kind !== 'main') throw new Error('Run setup and launch this saved session with OMP_BRIDGE_CONFIG first.');
    const settings = config(await readJson(process.env.OMP_BRIDGE_CONFIG!).catch(() => { throw new Error('Saved bridge settings could not be read. Run setup again and launch this saved session with OMP_BRIDGE_CONFIG.'); }));
    if (JSON.stringify(settings) !== JSON.stringify(bound) || settings.sessionId !== ctx.sessionManager.getSessionId() ||
        !same(settings.cwd, ctx.cwd)) throw new Error('Saved bridge binding does not match this OMP session.');
    const file = ctx.sessionManager.getSessionFile?.();
    if (!file) throw new Error('Saved session file is unavailable.');
    await validateSavedSession(file, settings);
    // A supervisor that closed itself after an error is not running: stop it so this enable starts a fresh one.
    if (supervisor?.closed) await stop();
    if (supervisor) {
      // A hold left by an OMP turn the bridge could not match: with OMP idle and nothing of the bridge's in flight, queued tasks may start.
      const owned = supervisor;
      const quiet = !runOpen && !owned.active && !owned.run && !owned.continuationPending && !terminalConflictPending &&
        !terminalMessagePending && ctx.isIdle() === true && ctx.hasPendingMessages() === false;
      if (unownedBlocked && quiet) {
        unownedBlocked = false; unownedRelease = undefined;
        notify(ctx, 'Bridge was holding queued tasks after an OMP turn it could not match. It will start them now.'); wake(); return;
      }
      notify(ctx, unownedBlocked ? 'Bridge is holding queued tasks until OMP is idle and its current turn has ended. Run /bridge enable again then.'
        : 'Bridge already running for session ' + settings.sessionId + '.');
      return;
    }
    // No supervisor runs now, so a gate or pending terminal left by an earlier failed disable guards nothing: clear it so queued work can start.
    terminalConflictPending = false; terminalMessagePending = undefined; terminalPendingTicket = undefined; recentTerminal = undefined;
    await new Store(settings).recoverCommands();
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Wait for native OMP work to finish before /bridge enable.');
    // /bridge disable then /bridge enable is a lifecycle boundary: no supervisor ran in between and native OMP is idle now,
    // so a hold left by an ordinary OMP turn cannot hide any bridge work.
    unownedBlocked = false;
    unownedRelease = undefined;
    // Automatic startup has the same host gate as a manual enable. Probe again
    // on manual enable so correlation uses the host that admitted this supervisor.
    if (!automatic) host = await detect().catch(() => null);
    if (!isOmpVersion(host)) throw new Error('Bridge requires a recognized OMP executable.');
    // A frequent version bump is not incompatibility. Refuse missing APIs before
    // any supervisor lock or submission; unknown event shapes still stop unknown.
    if (typeof pi.sendUserMessage !== 'function' || typeof ctx.isIdle !== 'function' ||
        typeof ctx.hasPendingMessages !== 'function' || typeof ctx.setInterval !== 'function' ||
        typeof ctx.clearTimer !== 'function' || typeof ctx.sessionManager?.getSessionId !== 'function' ||
        typeof ctx.sessionManager?.getSessionFile !== 'function')
      throw new Error('Bridge requires saved-session, message, idle and timer capabilities.');
    const exactTarget = () => !unownedBlocked && !terminalConflictPending && !terminalMessagePending && !runOpen && bindingMatches(ctx, settings, file);
    const nativeIdle = () => {
      try { return exactTarget() && ctx.isIdle() && !ctx.hasPendingMessages(); } catch { return false; }
    };
    const next = new Supervisor(new Store(settings), {
      isIdle: nativeIdle,
      // Same gate, sampled synchronously before the durable reservation.
      canReserve: nativeIdle,
      send: (text: string) => {
        invokeNativeAdmission(nativeAdmission);
        const marker = markerLine(text);
        if (marker && !knownSubmissionMarkers.has(marker)) {
          if (knownSubmissionMarkers.size >= MAX_TRACKED_SUBMISSIONS) throw new Error('submission correlation capacity reached');
          knownSubmissionMarkers.set(marker, textHash(text)!);
        }
        return pi.sendUserMessage(text);
      },
      fence: async (text: string) => {
        await testHooks?.beforeSubmissionFence?.(text);
        const proof = await fence(file, settings, text);
        const owner = next.active, capturedEpoch = ownerEpoch, manager = ctx.sessionManager;
        fenceOwnerEpoch = capturedEpoch;
        nativeAdmission = captureNativeAdmission(manager,
          {...settings,planId:owner?.row.id,step:owner?.row.nextStep}, proof, text, host, capturedEpoch,
          () => ownerEpoch === capturedEpoch && supervisor === next && next.active === owner &&
            owner?.submittedStep === owner?.row.nextStep && !next.closed && !next.admissionInterrupted &&
            sessionContext === ctx && ctx.sessionManager === manager && bindingMatches(ctx, settings, file));
        return proof;
      },
      receiptFence: (proof: any) => {
        if (!proof || typeof proof.dev !== 'string' || !/^(0|[1-9][0-9]*)$/.test(proof.dev) ||
            typeof proof.ino !== 'string' || !/^(0|[1-9][0-9]*)$/.test(proof.ino) ||
            !Number.isSafeInteger(proof.start) || !Number.isSafeInteger(proof.offset) ||
            proof.start < 0 || proof.start > proof.offset || proof.offset - proof.start > 32768 ||
            !/^[a-f0-9]{64}$/.test(proof.prefix) || !/^[a-f0-9]{64}$/.test(proof.textHash))
          throw new Error('invalid admission fence');
        return { fileDev: proof.dev, fileIno: proof.ino, start: proof.start, offset: proof.offset,
          prefixHash: proof.prefix, textHash: proof.textHash };
      },
      admitted: async (proof: object, admissionOptions: any) => {
        // Compaction ownership requires its authenticated terminal endpoint on
        // current disk, even when the ordinary raw scan could admit one cut.
        if (nativeAdmission?.rawFence === proof && nativeAdmission.compactionEnd)
          return reconcileNativeAdmission(nativeAdmission, {
            ...admissionOptions, onFailure: (fields: object) => trace?.record('admission_failure', fields),
          });
        let failure: string | undefined;
        const admitted = await reconcileAdmission(proof, {
          ...admissionOptions,
          onFailure: (fields: any) => { failure = fields.failure; trace?.record('admission_failure', fields); },
          ...(testHooks?.afterEmptyAdmissionProbe ? { testHooks: {
            ...admissionOptions?.testHooks, afterEmptyAdmissionProbe: testHooks.afterEmptyAdmissionProbe,
          } } : {}),
        });
        if (admitted) return true;
        // Raw-file proof stays strict. Only live native authority plus a fresh
        // complete persisted-lineage scan can supply a distinct alternate proof.
        return ['file_identity_mismatch','fence_changed','file_truncated','transcript_changed','append_integrity_mismatch'].includes(failure ?? '') &&
          nativeAdmission?.rawFence === proof && await reconcileNativeAdmission(nativeAdmission, {
            ...admissionOptions, onFailure: (fields: object) => trace?.record('admission_failure', fields),
          });
      },
      finalizeAdmission: (proof: object, evidence: any, admissionOptions: any) =>
        nativeAdmission?.rawFence === proof && reconcileNativeAdmission(nativeAdmission, {
          ...admissionOptions, previousProof: evidence,
          onFailure: (fields: object) => trace?.record('admission_failure', fields),
        }),
      commitAdmission: (proof: object, evidence: any, token: any) => {
        if (fenceOwnerEpoch !== ownerEpoch || supervisor !== next || next.active?.fence !== proof ||
            next.closed || next.admissionInterrupted || token?.valid === false || !bindingMatches(ctx, settings, file)) return false;
        return evidence?.kind === 'native-lineage-v1'
          ? nativeAdmission?.rawFence === proof && commitNativeAdmission(nativeAdmission, evidence) : true;
      },
      retired: (owner: any) => {
        if (nativeAdmission?.binding.planId === owner.row.id) { nativeAdmission.valid = false; nativeAdmission = undefined; }
        // Durable failure/cancellation retires its adapter-only phase gate,
        // even if native work never sends a matching END. Native idle/pending
        // checks still gate all subsequent submissions.
        if (currentRunExpected?.owner === owner || stagedStart?.expected?.owner === owner) resetRunState();
        if (owner.row.state !== 'completed' && terminalPendingTicket?.owned === next &&
            terminalPendingTicket.planId === owner.row.id) {
          terminalMessagePending = undefined; terminalPendingTicket = undefined; terminalConflictPending = false;
        }
      },
      laneEvent: (event: string, fields: Record<string, unknown>) => laneEvents?.record(event, fields),
      trace: (event: string, fields: any) => trace?.record(event, fields),
    });
    try { await next.open(ownLockLeft); ownLockLeft = false; }
    catch { ownLockLeft ||= next.lockLeft; throw new Error('Bridge lock unavailable; /bridge status and inspect offline recovery. No lock was reclaimed.'); }
    supervisor = next; sessionContext = ctx; activeSessionFile = file;
    tickCount = 0; lastTickAt = null; lastTickFinishedAt = null; lastSupervisorError = null; lastLaneIdle = undefined;
    // Event wakes handle verified terminal transitions; the bounded timer
    // also discovers queue updates with no native lifecycle event.
    timer = ctx.setInterval(() => { observeLane(); wake(); }, 2000);
    if (!automatic) notify(ctx, 'Bridge enabled for session ' + settings.sessionId + '. Local queue ready; desktop/provider availability is not verified.');
    observeLane();
    wake();
  };
  // What /bridge enable and /bridge disable show for a failure. Messages that already name the cause and the next step are shown as they are,
  // the internal ones below get a plain sentence, and any other error stays the generic line (it may quote private text).
  const SHOWN_ERRORS = /^(Run setup|Saved bridge|Saved session|Wait for native|Bridge requires|Bridge lock|Bridge could not stop)/;
  const PLAIN_ERRORS: Record<string, string> = {
    'shutdown receipt failed; lock retained': 'Bridge could not save the receipt of the task that was running, so it kept its lock file. Make sure the receipts folder can be written, then run /bridge enable.',
    'transcript changed': 'The saved OMP session file changed while the bridge was checking it, so the bridge did not start. Run /bridge enable again.',
    'transcript header invalid': 'The saved OMP session file has no valid header, so the bridge did not start. Run setup again and launch this saved session.',
    'transcript identity mismatch': 'The saved OMP session file belongs to a different session or folder, so the bridge did not start. Run setup again and launch this saved session.',
    'invalid config': 'The saved bridge settings are not valid, so the bridge did not start. Run setup again and launch this saved session.',
    'config paths must be canonical': 'The saved bridge settings name a folder that is not a full, clean path, so the bridge did not start. Run setup again and launch this saved session.',
  };
  // Commands share one lifecycle lane; repeated or overlapping start/stop cannot
  // create a second timer or acquire another lock. Errors are fixed diagnostics.
  pi.registerCommand('bridge', { description: 'Bridge enable, disable, status for this saved session', handler: async (args, ctx) => {
    if (args.trim() === 'disable') { terminalConflictPending = true; supervisor?.interruptAdmission(); }
    const operation = lane.then(async () => {
      const action = args.trim();
      if (action === 'disable') {
        await stop(); terminalConflictPending = false; terminalMessagePending = undefined; terminalPendingTicket = undefined; recentTerminal = undefined;
        notify(ctx, 'Bridge stopped. Native OMP work is not interrupted; queued plans remain.');
      }
      else if (action === 'enable') await start(ctx);
      else if (action === 'status' || !action) {
        // The sentence about a leftover lock file only shows while the file is still there (the person may have deleted it since).
        if (ownLockLeft && bound) ownLockLeft = await readJson(path.join(bound.root, 'supervisor-' + bound.sessionId + '.lock')).then(() => true, (error: { code?: string } | undefined) => error?.code !== 'ENOENT');
        notify(ctx, bound
          ? 'Bridge ' + (supervisor ? (supervisor.closed ? 'faulted; stop and inspect receipts' : 'running') : 'stopped') + ' for session ' + bound.sessionId +
            '. Runtime polls: ' + tickCount + '; idle: ' + String(ctx.isIdle()) + '; pending messages: ' + String(ctx.hasPendingMessages()) +
            '. Queue is local; lock ownership is ' + (supervisor?.lock ? 'held here' : ownLockLeft ? 'not held here, and this session left its lock file behind; run /bridge enable to take it over' : 'not held here') +
            (supervisor && !supervisor.closed && unownedBlocked && ctx.isIdle() ? '. Queued tasks are on hold after an OMP turn the bridge could not match; run /bridge enable while OMP is idle' : '') +
            '. Desktop/provider connectivity is not verified.'
          : 'Bridge not configured for this session. Run setup and launch with the saved binding.');
      }
      else notify(ctx, 'Use /bridge enable, /bridge disable, or /bridge status.', 'warning');
    });
    lane = operation.catch(() => {});
    try { await operation; } catch (error) {
      const message = error instanceof Error ? error.message : '';
      notify(ctx, Object.hasOwn(PLAIN_ERRORS, message) ? PLAIN_ERRORS[message] : SHOWN_ERRORS.test(message) ? message : 'Bridge operation failed; inspect local receipts and offline recovery.', 'warning');
    }
  } });
  let transientShown = false;
  const report = (error?: any) => {
    const code = error?.code;
    const fixed = ['supervisor stopped', 'supervisor not opened', 'file changed', 'file too large', 'linked or non-plain path', 'linked ancestor', 'receipt identity mismatch', 'queue capacity exceeded'];
    if (lastSupervisorError === null || error?.message !== 'supervisor stopped') lastSupervisorError = ['EPERM','EACCES','EBUSY','ENOENT','EIO'].includes(code) ? code
      : fixed.includes(error?.message) ? error.message : 'other-fixed-category';
    void snapshot('supervisor-error');
    // Only a supervisor that closed itself is stopped; any other failure is retried by the next 2 s tick.
    if (!supervisor || supervisor.closed) { endLaneFeed(); sessionContext?.ui.notify('OMP bridge stopped on uncertain state; inspect local receipts.', 'warning'); }
    else if (!transientShown) { transientShown = true; sessionContext?.ui.notify('OMP bridge could not read its files just now and will try again. Nothing was lost.', 'info'); }
  };
  let wakePending = false, wakeQueued = false, idleRetry: NodeJS.Timeout | undefined, idleRetryCount = 0;
  const wake = (retryWhenBusy = false) => {
    const owned = supervisor, ctx = sessionContext;
    if (!owned || !ctx || owned.closed) return;
    if (wakeQueued) { wakePending ||= retryWhenBusy; return; }
    wakeQueued = true;
    const work = lane.then(async () => {
      if (supervisor !== owned || owned.closed || sessionContext !== ctx) return;
      // Only a validated unowned terminal observation can release its evidence
      // hold. Idle alone, a changed lifecycle, or an in-flight bridge run cannot.
      const release = unownedRelease;
      if (unownedBlocked === 'evidence' && release && release.owned === owned && release.settings === bound &&
          release.ctx === ctx && release.ownerEpoch === ownerEpoch && !runOpen && !owned.active && !owned.run &&
          !owned.continuationPending && !terminalConflictPending && !terminalMessagePending &&
          bindingMatches(ctx, release.settings) && ctx.isIdle() === true && ctx.hasPendingMessages() === false) {
        unownedBlocked = false; unownedRelease = undefined;
      }
      wakePending = false;
      tickCount++; lastTickAt = Date.now(); void snapshot('before-event');
      // A pending model switch is attempted before any plan is admitted in the same wake.
      if (bound && activeSessionFile && sessionContext === ctx) await processCommand(new Store(bound), pi, ctx, bound, activeSessionFile, owned, laneEvents, testHooks?.modelProof);
      await owned.tick(); void snapshot('after-tick'); await owned.continue();
      lastTickFinishedAt = Date.now(); transientShown = false; void snapshot('after-event');
      if (retryWhenBusy && (!ctx.isIdle() || ctx.hasPendingMessages())) wakePending = true;
    });
    lane = work.catch(report).finally(() => {
      wakeQueued = false;
      if (wakePending && supervisor === owned && !owned.closed && idleRetryCount < 20) {
        wakePending = false;
        idleRetryCount++;
        clearTimeout(idleRetry);
        idleRetry = setTimeout(() => { idleRetry = undefined; wake(true); }, 250);
      } else if (!wakePending) idleRetryCount = 0;
    });
  };
  pi.on('session_start', async (_event, ctx) => {
    // Only the main session owns a bridge: another kind of context must not tear down a running one.
    if (ctx.agent.kind !== 'main') return;
    invalidateOwnership();
    terminalConflictPending = true; supervisor?.interruptAdmission();
    // Stopping, binding and the automatic start run on the lane like /bridge enable and disable, so neither command can slip in between and be undone.
    const startup = lane.then(async () => {
      let stopFailed = false;
      try { await stop(); } catch { stopFailed = true; }
      bound = undefined; sessionContext = ctx;
      terminalConflictPending = false; terminalMessagePending = undefined; terminalPendingTicket = undefined; recentTerminal = undefined;
      unownedBlocked = false; unownedRelease = undefined;
      // After a failed stop the binding is still kept, so /bridge enable can try the stop again and then start.
      if (stopFailed) notify(ctx, 'Bridge did not start. Use /bridge enable for the reason; inspect setup and lock recovery.', 'warning');
      if (!process.env.OMP_BRIDGE_CONFIG) return;
      try {
        const settings = config(await readJson(process.env.OMP_BRIDGE_CONFIG));
        if (settings.sessionId !== ctx.sessionManager.getSessionId() || !same(settings.cwd, ctx.cwd)) {
          notify(ctx, 'Saved bridge binding does not match this OMP session.', 'warning'); return;
        }
        if (copyShouldStayOff({ held: copyClaim[COPY_CLAIM], self: SELF_FILE, catalogCopy: isCatalogCopy(SELF_FILE),
          fullInstall: Boolean(process.env.LOCALAPPDATA) && existsSync(path.join(process.env.LOCALAPPDATA!, 'OMP Session Bridge Local')) })) {
          notify(ctx, 'Another copy of Pi on the Side is already set up here, so this copy stays off.', 'info'); return;
        }
        copyClaim[COPY_CLAIM] = SELF_FILE;
        bound = settings; trace = new LocalTrace(settings.root); laneEvents = new LaneEvents(settings.root, settings.sessionId);
        trace.record('connection_bound', {sessionMatches:true}); trace.record('session_start', {}); host = await detect().catch(() => null);
        if (!stopFailed) await start(ctx, true);
      } catch { notify(ctx, 'Bridge did not start. Use /bridge enable for the reason; inspect setup and lock recovery.', 'warning'); }
    });
    lane = startup.catch(() => {});
    await startup;
  });
    let nextEpoch = 0, epoch = 0, eventOrder = 0, startOrder = 0, runOpen = false;
    let currentRunToken: any, currentRunExpected: any, stagedStart: any, awaitingStart: any;
    // Evidence gaps may settle within the same unowned run, and a later turn that starts clear of any other run is checked on its own;
    // an ambiguous hold otherwise stays until a new session lifecycle or /bridge enable. Neither changes past receipts.
    type UnownedEndObservation = {
      userTextHash: string | undefined; userMultiplicity: number; assistantEvidence: string;
      willContinue: boolean | undefined; assistantStop: boolean; messageKey: string | undefined;
      nativeKey: string | null | undefined; assistantCount: number; evidenceValid?: boolean;
    };
    type UnownedRelease = {
      owned: Supervisor | undefined; settings: BridgeBinding | undefined; ctx: ExtensionContext | undefined;
      ownerEpoch: number; key: string; nativeKey: string | undefined;
    };
    let unownedBlocked: false | 'evidence' | 'ambiguous' = false;
    let unownedPhase: UnownedEndObservation | undefined, unownedUnknownEnd: UnownedEndObservation | undefined;
    let unownedRelease: UnownedRelease | undefined;
    const resetRunState = () => {
      runOpen = false; currentRunToken = undefined; currentRunExpected = undefined;
      stagedStart = undefined; awaitingStart = undefined; observed = undefined; ambiguous = false; invalidNativeIdentity = false;
      unownedPhase = undefined; unownedUnknownEnd = undefined;
    };
    // Direct END ownership binds exact user text. An elided user additionally
    // needs authenticated native compaction and a persisted assistant endpoint.
    let observed: {key: string | undefined; nativeKey: string | undefined; order: number} | undefined;
    const seen = new Map<string, number>();
    const knownSubmissionMarkers = new Map<string, string>();
    const claimedEndMarkers = new Map<string, any>();
    // Multiple nonterminal phases belong to one submission, not one final claim.
    const phaseEndMarkers = new Map<string, any[]>();
    const compactionEndClaims = new Map<string, any>();
    const completedUnownedEnds = new Set<string>();
    let phaseClaimCount = 0;
    const MAX_TRACKED_SUBMISSIONS = 100000;
    const userText = (message: any): string | undefined => {
      if (message?.role !== 'user') return undefined;
      if (typeof message.content === 'string') return message.content;
      return Array.isArray(message.content) && message.content.length === 1 &&
        message.content[0]?.type === 'text' && typeof message.content[0].text === 'string'
        ? message.content[0].text : undefined;
    };
    const markerLine = (text: string | undefined): string | undefined => {
      if (typeof text !== 'string') return undefined;
      const end = text.indexOf('\n'), line = end < 0 ? text : text.slice(0, end);
      return line.length > 13 && line.startsWith('[OMP bridge ') && line.endsWith(']') && !line.slice(12, -1).includes(']')
        ? line : undefined;
    };
    const textHash = (text: string | undefined): string | undefined => typeof text === 'string'
      ? createHash('sha256').update(text, 'utf16le').digest('hex') : undefined;
    const sameEndObservation = (a: any, b: any) => a.userTextHash === b.userTextHash &&
      a.userMultiplicity === b.userMultiplicity && a.assistantEvidence === b.assistantEvidence &&
      a.willContinue === b.willContinue && a.assistantStop === b.assistantStop &&
      a.messageKey === b.messageKey && a.nativeKey === b.nativeKey && a.assistantCount === b.assistantCount;
    const invalidateEndClaim = (claim: any) => {
      if (claim.quarantined || claim.invalidationPending || !claim.owned) return;
      claim.invalidationPending = true;
      const sameOwner = claim.owned === supervisor && claim.settings === bound && claim.ctx === sessionContext;
      if (!sameOwner) { claim.quarantined = true; return; } // A retired owner no longer holds the controller lock.
      const holdsActivePlan = supervisor?.active?.row.id === claim.planId;
      if (holdsActivePlan) terminalConflictPending = true;
      if (holdsActivePlan) resetRunState();
      if (claim.token && typeof claim.token === 'object') claim.token.valid = false;
      void claim.owned.invalidateRun(claim.token, claim.planId, claim.step).then(invalidated => {
        if (!invalidated) return;
        claim.invalidationPending = false; claim.quarantined = true;
        const stillOwner = claim.owned === supervisor && claim.settings === bound && claim.ctx === sessionContext;
        if (holdsActivePlan && stillOwner) terminalConflictPending = false;
        if (stillOwner && claim.token && terminalMessagePending === claim.token) {
          terminalMessagePending = undefined; terminalPendingTicket = undefined;
        }
      }).catch(report);
    };
    const MAX_SEEN_KEYS = MAX_TRACKED_SUBMISSIONS;
    let saturated = false, ambiguous = false, invalidNativeIdentity = false;
    const markSeen = (keys: (string | undefined)[]) => {
      let replayed = false;
      for (const key of keys) {
        if (key === undefined) continue;
        const prior = seen.get(key);
        if (prior !== undefined && prior !== epoch) replayed = true;
        if (prior === undefined) {
          if (seen.size >= MAX_SEEN_KEYS) saturated = true;
          else seen.set(key, epoch);
        }
      }
      if (replayed) ambiguous = true;
      return replayed;
    };
    const recordCorrelation = (fields: any) => { try { trace?.record('run_correlation', fields); } catch { /* Diagnostics never authorize work. */ } };
    // A run of a subagent is never the plan's run. A context without an agent kind (older hosts) is not judged here.
    const fromSubagent = (ctx?: ExtensionContext) => ctx?.agent !== undefined && ctx.agent.kind !== 'main';
    pi.on('agent_start', (_event, ctx) => {
      if (fromSubagent(ctx)) return;
      const owner = supervisor?.active;
      // Capture eligibility at native callback time; a START during fence
      // persistence cannot retroactively claim a later submitted step.
      const eligible = owner && owner.submissionInvoked === true && owner.submittedStep === owner.row.nextStep &&
        typeof owner.submittedText === 'string' && typeof owner.row.id === 'string' &&
        typeof owner.row.sessionId === 'string';
      const expected = eligible ? {owner,sessionId:owner.row.sessionId,planId:owner.row.id,
        step:owner.row.nextStep,text:owner.submittedText} : undefined;
      if (owner && !eligible) owner.prematureStart = true;
      const token = {epoch:++nextEpoch,valid:Boolean(eligible),ownerEpoch};
      eventOrder++; awaitingStart = undefined; // a START now explains the next run itself
      unownedRelease = undefined;
      // A turn that starts clear of any other run is checked on its own: an earlier turn the bridge could not match no longer holds queued tasks for ever,
      // but this one still needs a validated END before they run. A turn that overlaps another keeps the hold it had.
      if (!expected) unownedBlocked = runOpen || terminalMessagePending !== undefined ? unownedBlocked || 'evidence' : 'evidence';
      if (runOpen && !currentRunExpected) {
        if (expected) unownedBlocked = 'ambiguous';
        if (!currentRunToken && !stagedStart) {
          epoch = token.epoch; startOrder = eventOrder; currentRunToken = token;
        } else if (!stagedStart) stagedStart = {token,startOrder:eventOrder};
        else unownedBlocked = 'ambiguous';
        return;
      }
      const sameSubmission = expected && currentRunExpected &&
        expected.owner === currentRunExpected.owner && expected.step === currentRunExpected.step &&
        expected.sessionId === currentRunExpected.sessionId && expected.planId === currentRunExpected.planId &&
        expected.text === currentRunExpected.text;
      if (runOpen && sameSubmission && !stagedStart && !terminalMessagePending) {
        // START is eager; predecessor END notification is detached. Do not
        // replace its token, observation, or replay epoch before classification.
        stagedStart = {token,expected,startOrder:eventOrder};
        return;
      }
      const overlap = runOpen || terminalMessagePending !== undefined;
      if (overlap && runOpen) {
        const priorExpected = currentRunExpected;
        resetRunState();
        if (supervisor && priorExpected)
          void supervisor.ended(undefined, undefined, priorExpected).catch(report);
        return;
      }
      epoch = token.epoch; startOrder = eventOrder; runOpen = true;
      observed = undefined; ambiguous = overlap; invalidNativeIdentity = false;
      currentRunToken = token; currentRunExpected = expected;
      if (!terminalMessagePending) recentTerminal = undefined;
      recordCorrelation({phase:'agent_start',runEpoch:epoch,eventOrder,startOrder,runPresent:overlap,startObserved:true,
        tokenRejection:overlap ? 'overlap' : 'none'});
      const pending = terminalPendingTicket;
      if (terminalMessagePending && pending && pending.owned === supervisor &&
          pending.settings === bound && pending.ctx === sessionContext) {
        pending.token.valid = false;
        terminalConflictPending = true;
        void pending.owned.invalidateRun(pending.token, pending.planId, pending.step).then(invalidated => {
          if (invalidated) {
            terminalMessagePending = undefined; terminalPendingTicket = undefined; terminalConflictPending = false;
          }
        }).catch(report);
      }
      if (supervisor) void supervisor.started(currentRunToken, expected).catch(report);
    });
    pi.on('input', (event, ctx) => { if (!fromSubagent(ctx)) observeAdmission('input', event); });
    pi.on('before_agent_start', (event, ctx) => { if (!fromSubagent(ctx)) observeAdmission('before_agent_start', event); });
    pi.on('message_start', (event, ctx) => { if (!fromSubagent(ctx)) observeAdmission('message_start', event); });
    pi.on('message_end', (event, ctx) => {
      if (fromSubagent(ctx)) return;
      observeAdmission('message_end', event);
      if (event?.message?.role !== 'assistant') return;
      eventOrder++;
      // No native phase ID disambiguates assistant events between staged
      // START and predecessor END. Never guess which phase produced them.
      if (stagedStart) {
        ambiguous = true;
        if (!currentRunExpected) unownedBlocked = 'ambiguous';
      }
      const key = messageKey(event.message), nativeKey = nativeResponseKey(event.message);
      const invalidNative = nativeKey === null, replayed = markSeen([
        typeof nativeKey === 'string' ? `native:${nativeKey}` : undefined, key]);
      if (invalidNative) { ambiguous = true; invalidNativeIdentity = true; }
      observed = {key,nativeKey:typeof nativeKey === 'string' ? nativeKey : undefined,order:eventOrder};
      if (unownedRelease && (invalidNative || replayed || key !== unownedRelease.key || nativeKey !== unownedRelease.nativeKey)) {
        unownedBlocked = 'ambiguous'; unownedRelease = undefined;
      }
      const late = !runOpen ? (terminalMessagePending ? terminalPendingTicket : recentTerminal) : undefined;
      const contradictsEnd = Boolean(late && (invalidNative || replayed ||
        (typeof nativeKey === 'string' && late.nativeKeys.size > 0 && !late.nativeKeys.has(nativeKey))));
      recordCorrelation({phase:'message_end',runEpoch:epoch,eventOrder,startOrder,runPresent:runOpen,startObserved:runOpen,
        messageEndObserved:true,messageKeyAvailable:key !== undefined,assistantStop:event.message.stopReason === 'stop',
        tokenRejection:invalidNative ? 'identity_invalid' : replayed ? 'replayed_identity' : contradictsEnd ? 'native_identifier_mismatch' : 'none',
        lineage:nativeKey ? 'native_response_id' : key !== undefined ? 'same_run_message_end' : 'unavailable'});
      if (late && late.owned === supervisor && late.settings === bound && late.ctx === sessionContext) {
        if (contradictsEnd && late.token.valid !== false) {
          late.token.valid = false;
          terminalConflictPending = true;
          void late.owned.invalidateRun(late.token, late.planId, late.step).then(invalidated => {
            if (invalidated) {
              terminalConflictPending = false;
              if (terminalMessagePending === late.token) {
                terminalMessagePending = undefined; terminalPendingTicket = undefined;
              }
            }
          }).catch(report);
        } else if (!contradictsEnd && terminalMessagePending === late.token) {
          terminalMessagePending = undefined; terminalPendingTicket = undefined;
          void wakeVerifiedTerminal(late);
        }
      }
    });
    pi.on('agent_end', (event, agentContext) => {
      if (fromSubagent(agentContext)) return;
      eventOrder++;
      const owned = supervisor, settings = bound, ctx = sessionContext;
      const active = owned?.active, row = active?.row;
      const step = Number.isSafeInteger(row?.nextStep) ? row.nextStep : undefined;
      const expected = (row?.state === 'submitted' || row?.state === 'submitting') && typeof row.id === 'string' &&
        typeof row.sessionId === 'string' && step !== undefined &&
        active.submittedStep === step && typeof active.submittedText === 'string'
        ? {sessionId:row.sessionId,planId:row.id,step,text:active.submittedText,
          textHash:textHash(active.submittedText),marker:markerLine(active.submittedText)} : undefined;
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      let lastUserIndex = -1, lastUserText: string | undefined;
      const userTexts: (string | undefined)[] = [];
      for (let i = 0; i < messages.length; i++) if (messages[i]?.role === 'user') {
        lastUserIndex = i; lastUserText = userText(messages[i]); userTexts.push(lastUserText);
      }
      const eventMarker = markerLine(lastUserText);
      const currentAssistantMessages = messages.filter((message, index) => index > lastUserIndex && message?.role === 'assistant');
      const last = currentAssistantMessages.at(-1);
      const currentSubmissionHash = expected?.marker ? knownSubmissionMarkers.get(expected.marker) : undefined;
      const claimMarker = eventMarker ?? (userTexts.length === 0 && currentSubmissionHash === expected?.textHash ? expected?.marker : undefined);
      const phases = claimMarker ? phaseEndMarkers.get(claimMarker) : undefined;
      const predecessor = runOpen && !currentRunExpected ? unownedPhase : phases?.at(-1)?.signature;
      const nativeKeys = new Set<string>(), assistantEvidenceHash = createHash('sha256');
      let prefixEvidence: string | undefined, evidenceValid = true;
      let key: string | undefined, nativeKey: string | null | undefined;
      for (let index = 0; index < currentAssistantMessages.length; index++) {
        const message = currentAssistantMessages[index];
        nativeKey = nativeResponseKey(message); key = messageKey(message);
        if (typeof nativeKey === 'string') nativeKeys.add(nativeKey);
        if (nativeKey === null || key === undefined) evidenceValid = false;
        // IDs alone cannot prove an unchanged predecessor. Include the bounded
        // UTF16-preserving content/identity fingerprint even when IDs survive.
        assistantEvidenceHash.update(nativeKey === null ? 'n;' : typeof nativeKey === 'string' ? `s${nativeKey};` : 'u;');
        assistantEvidenceHash.update(key === undefined ? 'u;' : `${key};`);
        if (index + 1 === predecessor?.assistantCount && evidenceValid)
          prefixEvidence = assistantEvidenceHash.copy().digest('hex');
      }
      const assistantEvidence = assistantEvidenceHash.digest('hex');
      const assistantStop = last?.stopReason === 'stop';
      const willContinue = terminalSignal(event);
      if (willContinue === undefined) recordCorrelation({phase:'agent_end',runEpoch:epoch,eventOrder,startOrder,continuation:'unreadable',
        terminalSignalReason:'non_boolean_field'});
      const userMultiplicity = userTexts.filter(text => text === lastUserText).length;
      const signature = {userTextHash:textHash(lastUserText),userMultiplicity,assistantEvidence,
        willContinue,assistantStop,messageKey:key,nativeKey,assistantCount:currentAssistantMessages.length};
      const extendsPredecessor = !predecessor || (predecessor.evidenceValid && evidenceValid &&
        signature.userTextHash === predecessor.userTextHash && userMultiplicity === predecessor.userMultiplicity &&
        currentAssistantMessages.length > predecessor.assistantCount &&
        prefixEvidence === predecessor.assistantEvidence);
      Object.assign(signature, {evidenceValid});
      const ownsCurrent = Boolean(expected?.marker && currentSubmissionHash === expected.textHash &&
        lastUserText === expected.text && userMultiplicity === 1);
      const endpointStamp = expected && nativeAdmission?.valid &&
        key !== undefined && typeof nativeKey === 'string' ? nativeAssistantStamp(last) : undefined;
      const elision = !ownsCurrent && expected?.marker && currentSubmissionHash === expected.textHash && userTexts.length === 0 &&
        runOpen && !ambiguous && !saturated && evidenceValid && currentRunToken?.valid === true &&
        currentRunExpected?.owner === active && currentRunExpected?.sessionId === expected.sessionId &&
        currentRunExpected?.planId === expected.planId && currentRunExpected?.step === expected.step &&
        currentRunExpected?.text === expected.text && nativeAdmission?.binding.planId === expected.planId &&
        nativeAdmission?.binding.step === expected.step
        ? nativeCompactionEnd(nativeAdmission, endpointStamp, predecessor?.endpointStamp, willContinue) : undefined;
      const owns = ownsCurrent || Boolean(elision);
      const priorSubmissionHash = eventMarker ? knownSubmissionMarkers.get(eventMarker) : undefined;
      const exactPriorSubmission = Boolean(eventMarker && eventMarker !== expected?.marker &&
        priorSubmissionHash !== undefined && priorSubmissionHash === textHash(lastUserText) && userMultiplicity === 1);
      const unownedEndKey = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
      if (completedUnownedEnds.has(unownedEndKey)) return;
      // A validated unowned END leaves one pending release. Any different END
      // before the next wake contradicts it; this precedes historical claims so
      // the contradiction latches the hold without rewriting a prior receipt.
      if (unownedRelease && !runOpen) {
        unownedBlocked = 'ambiguous'; unownedRelease = undefined;
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,runPresent:false,
          continuation:typeof willContinue === 'boolean' ? String(willContinue) : 'unreadable',tokenRejection:'overlap'});
        return;
      }
      // Native response IDs identify previous elided END claims even though
      // their callback contains no user marker. Conflicts still quarantine.
      const compactionClaim = userTexts.length === 0 && typeof nativeKey === 'string' ? compactionEndClaims.get(nativeKey) : undefined;
      if (compactionClaim) {
        if (!sameEndObservation(compactionClaim.signature, signature)) invalidateEndClaim(compactionClaim);
        return;
      }
      // Retire unowned phases before consulting owned historical claims. Full
      // history retaining an old bridge user does not transfer START ownership.
      if (runOpen && !currentRunExpected) {
        if (unownedPhase && sameEndObservation(unownedPhase, signature)) return;
        if (!currentRunToken || currentRunToken.ownerEpoch !== ownerEpoch || ambiguous || saturated || !evidenceValid || !extendsPredecessor ||
            (stagedStart && willContinue !== true) ||
            (unownedUnknownEnd && !sameEndObservation(unownedUnknownEnd, {...signature,willContinue:undefined}))) {
          unownedBlocked = 'ambiguous'; if (willContinue === false) resetRunState(); return;
        }
        if (typeof willContinue !== 'boolean') {
          unownedBlocked ||= 'evidence'; unownedUnknownEnd = signature; return;
        }
        if (unownedBlocked === 'ambiguous') { if (!willContinue) resetRunState(); return; }
        if (!willContinue) {
          if (!assistantStop || key === undefined || !observed || observed.order <= startOrder ||
              observed.order >= eventOrder || observed.key !== key || observed.nativeKey !== nativeKey ||
              completedUnownedEnds.size >= MAX_TRACKED_SUBMISSIONS ||
              markSeen([typeof nativeKey === 'string' ? `native:${nativeKey}` : undefined,key])) {
            unownedBlocked = 'ambiguous'; resetRunState(); return;
          }
          completedUnownedEnds.add(unownedEndKey);
          unownedRelease = {owned,settings,ctx,ownerEpoch,key,nativeKey};
        }
        const successor = stagedStart;
        resetRunState();
        if (willContinue) {
          runOpen = true; unownedPhase = signature;
          currentRunToken = successor?.token;
          if (successor) { epoch = successor.token.epoch; startOrder = successor.startOrder; }
        }
        return;
      }
      if (phases?.some(claim => sameEndObservation(claim.signature, signature))) return;
      const priorClaim = claimMarker ? claimedEndMarkers.get(claimMarker) : undefined;
      if (priorClaim) {
        const same = sameEndObservation(priorClaim.signature, signature);
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,
          tokenRejection:same ? 'claimed_submission' : 'conflicting_claimed_submission',lineage:'claimed_submission'});
        if (!same) invalidateEndClaim(priorClaim);
        return;
      }
      if (exactPriorSubmission) {
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,tokenRejection:'prior_submission',lineage:'prior_submission'});
        return;
      }
      if (!expected) {
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,runPresent:runOpen,
          tokenRejection:'no_submitted_target',continuation:typeof willContinue === 'boolean' ? String(willContinue) : 'unreadable'});
        resetRunState();
        return;
      }
      if (owns && predecessor && !extendsPredecessor &&
          !(elision?.rebasesPrevious && predecessor.compactionId !== elision.compactionId)) {
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,
          tokenRejection:'replayed_identity',lineage:'unavailable'});
        invalidateEndClaim(phases!.at(-1));
        return;
      }
      Object.assign(signature, {endpointStamp,compactionId:elision?.compactionId});
      const claim = {signature,sessionId:expected.sessionId,planId:expected.planId,step:expected.step,
        owned,settings,ctx,token:currentRunToken,quarantined:!owns};
      if (expected.marker) {
        if (willContinue === true) {
          if (phaseClaimCount >= MAX_TRACKED_SUBMISSIONS) saturated = true;
          else {
            const claims = phaseEndMarkers.get(expected.marker) ?? [];
            claims.push(claim); phaseEndMarkers.set(expected.marker, claims); phaseClaimCount++;
          }
        } else claimedEndMarkers.set(expected.marker, claim);
      }
      if (!owns) {
        if (currentRunToken && typeof currentRunToken === 'object') currentRunToken.valid = false;
        recordCorrelation({phase:'agent_end',eventOrder,startOrder,runEpoch:epoch,runPresent:runOpen,
          messageEndObserved:observed !== undefined,tokenRejection:'submission_marker_unconfirmed',
          submissionMarkerPresent:Boolean(expected.marker),submissionMarkerMatches:currentSubmissionHash === expected.textHash,
          submissionUserMatches:lastUserText === expected.text,submissionUserUnique:userMultiplicity === 1,
          continuation:typeof willContinue === 'boolean' ? String(willContinue) : 'unreadable',lineage:'unavailable'});
        resetRunState();
        void owned!.ended(undefined, willContinue,
          {sessionId:expected.sessionId,planId:expected.planId,step:expected.step}).catch(report);
        return;
      }
      const replayed = markSeen([typeof nativeKey === 'string' ? `native:${nativeKey}` : undefined, key]);
      const prior = observed; observed = undefined;
      const messageEndBeforeEnd = prior !== undefined && prior.order < eventOrder;
      const messageKeyMatches = prior?.key !== undefined && key === prior.key;
      const nativeIdCompared = prior?.nativeKey !== undefined && nativeKeys.size > 0;
      const nativeIdMatches = nativeIdCompared && nativeKeys.has(prior!.nativeKey!);
      const nativeMismatch = nativeIdCompared && !nativeIdMatches;
      let wasOpen = runOpen; runOpen = false;
      // The continuing END before this one said another run follows, and no START was seen for it: OMP may send the START late or not at all.
      // The same submission, a history that extends the earlier END and a message_end after it still have to match below, so this END
      // is read as the end of that next run, on a fresh token. A START that arrives instead is handled as a new run (END-before-START).
      if (!wasOpen && awaitingStart && active && awaitingStart.owner === active && expected && !stagedStart && !terminalMessagePending &&
          awaitingStart.sessionId === expected.sessionId && awaitingStart.planId === expected.planId && awaitingStart.step === expected.step && awaitingStart.text === expected.text) {
        wasOpen = true; currentRunToken = {epoch:++nextEpoch,valid:true,ownerEpoch}; epoch = currentRunToken.epoch; startOrder = awaitingStart.order;
        currentRunExpected = {owner:active,sessionId:expected.sessionId,planId:expected.planId,step:expected.step,text:expected.text};
        void owned!.started(currentRunToken, currentRunExpected).catch(report);
      }
      awaitingStart = undefined;
      const invalidNative = nativeKey === null || invalidNativeIdentity;
      if (invalidNative) ambiguous = true;
      // A continuing END ends a phase, not the plan: willContinue is OMP's own "another run follows" (after a tool call, a retried model call, an
      // advisor note, a length continuation). Whatever the last stop reason, it only retires the phase; the plan still ends only on a true END with a stop.
      const phaseStop = assistantStop || (willContinue === true && typeof last?.stopReason === 'string');
      const tokenRejection = !wasOpen ? 'run_missing' : !phaseStop ? 'terminal_stop_missing'
        : (stagedStart || nativeAdmission?.pendingPreparation) && willContinue !== true ? 'overlap'
        : elision && (!prior || prior.order >= eventOrder || prior.key !== key || prior.nativeKey !== nativeKey)
          ? 'native_identifier_mismatch'
        : invalidNative || (key === undefined && nativeKey === undefined) ? 'identity_invalid' : nativeMismatch ? 'native_identifier_mismatch'
        : saturated || ambiguous || replayed ? 'replayed_identity' : 'none';
      const token = tokenRejection === 'none' ? currentRunToken : undefined;
      claim.token = token; claim.quarantined = token === undefined;
      if (token && nativeAdmission) nativeAdmission.compactionEnd = elision;
      if (token && elision && typeof nativeKey === 'string') compactionEndClaims.set(nativeKey, claim);
      // Callback-time classification, not Supervisor FIFO progress, authorizes
      // the next native preparation hook for this same submitted user.
      if (token && willContinue === true) observeAdmission('phase_continuation', {token});
      const successor = token && willContinue === true ? stagedStart : undefined;
      resetRunState();
      const lineage = token === undefined ? 'unavailable'
        : elision ? 'compaction_elided'
        : nativeIdCompared ? 'native_response_id' : messageKeyMatches ? 'same_run_message_end' : 'run_local_fenced';
      recordCorrelation({phase:'agent_end',runEpoch:epoch,eventOrder,startOrder,runPresent:wasOpen,startObserved:wasOpen,
        messageEndObserved:prior !== undefined,messageEndOrder:prior?.order ?? 0,messageEndBeforeEnd,
        messageKeyAvailable:key !== undefined,messageKeyMatches,nativeIdCompared,nativeIdMatches,assistantStop,
        continuation:typeof willContinue === 'boolean' ? String(willContinue) : 'unreadable',tokenPresent:token !== undefined,
        tokenMatches:token?.epoch === epoch,tokenRejection,lineage});
      // Only a true END (willContinue false) gets a terminal ticket: it holds dispatch until its message_end is matched, then the plan advances and a wake follows.
      // A continuing END only retires the phase: no ticket, no receipt advance, no wake.
      const ticket = token && owned && willContinue === false
        ? {token,nativeKeys,planId:expected.planId,step:expected.step,owned,settings,ctx} : undefined;
      if (ticket) recentTerminal = ticket;
      if (ticket && prior === undefined) { terminalMessagePending = token; terminalPendingTicket = ticket; }
      if (owned) {
        void owned.ended(token, willContinue,
          {sessionId:expected.sessionId,planId:expected.planId,step:expected.step})
          .then(() => { if (ticket) return wakeVerifiedTerminal(ticket); }).catch(report);
        if (successor) {
          epoch = successor.token.epoch; startOrder = successor.startOrder; runOpen = true;
          currentRunToken = successor.token; currentRunExpected = successor.expected;
          // Queue immediately behind predecessor END, preserving callback-time owner.
          void owned.started(successor.token, successor.expected).catch(report);
        } else if (token && token.valid !== false && willContinue === true && active) awaitingStart = {owner:active,sessionId:expected.sessionId,planId:expected.planId,step:expected.step,text:expected.text,order:eventOrder};
      }
    });
    // Teardown retires the snapshot source, then drains both telemetry writers with a bound so no temp or lock file outlives shutdown.
    const drained = (work: Promise<unknown>, ms = 5000) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => reject(new Error('telemetry drain timeout')), ms); timer.unref?.();
      work.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      return promise;
    };
    const retire = async () => {
      invalidateOwnership();
      terminalConflictPending = true; supervisor?.interruptAdmission();
      await lane;
      try { await stop(); } catch { report(); }
      bound = undefined;
      try { await drained(diagnosticLane); await drained(trace?.flush() ?? Promise.resolve()); await drained(laneEvents?.flush() ?? Promise.resolve()); }
      catch { report(); }
      trace = undefined; laneEvents = undefined;
      if (copyClaim[COPY_CLAIM] === SELF_FILE) delete copyClaim[COPY_CLAIM];
    };
    pi.on('session_before_switch', retire);
    pi.on('session_shutdown', retire);
    // Verified OMP lifecycle names: tree navigation includes resetLeaf/branch,
    // including switch-away-and-back. Endpoint snapshots alone cannot see it.
    pi.on('session_before_branch', invalidateOwnership);
    pi.on('session_branch', invalidateOwnership);
    pi.on('session_before_tree', invalidateOwnership);
    pi.on('session_tree', invalidateOwnership);
    pi.on('session_switch', invalidateOwnership);
  };
}
