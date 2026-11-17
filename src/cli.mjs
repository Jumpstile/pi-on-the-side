import {uninstall,UNINSTALL_ERRORS,REVIEW,reviewText} from './uninstall.mjs';
import { registerConnection, closeConnection, closeFinishedConnections, laneOverview, savedLaneState, readConnections, loadConnections, CONNECTION_ERRORS, MAX_CONNECTIONS } from './connections.mjs';
import { createCredential, acquireController, handoffController, withController, CONTROLLER_ERRORS } from './controller.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, initialize, isStaleLock, readJson, Store, plain, unlinkRetry, QUEUE_LIMIT_MS } from './control.mjs';
import { LANE_ERRORS, laneSessionRunning, lanesStatus, NOT_RUNNING_NOTE, NOT_RUNNING_WARNING, requireModelProven, startLaneTask, switchModel, unstartedPlans, UNSTARTED_TEXT } from './lane-status.mjs';
import { validateSavedSession } from './transcript.mjs';
import { detectHost } from './host.mjs';
import { CANCEL_NOTE, CHECKOUT, diagnostic, exists, FIXED, loadSetup, locateOmp, MESSAGES, nodeSupported, OWNER_ONLY,
  PROVIDER_AUTH, requireHost, setup } from './setup.mjs';
import { applyUpdate, checkUpdate, installUpdate, MESSAGES as UPDATE_MESSAGES, noteOf, NOTES, REASONS, rollbackUpdate, runGh, startCheck, SUCCESS } from './update.mjs';
import { autoSetup, autoDefaults, discoverSessions, inside, resultDetails, resultMessage, NOTHING_LEFT, AUTO_ERRORS, INSTALL_STOPPED } from './autosetup.mjs';
import { startLaneWatch, readNewWatchLines, readWatchStates, WATCH_DEFAULTS, WATCH_ERRORS } from './lane-watch.mjs';
import { resumeHealth, healthText, logProblem, WAKEUPS_ON_AGAIN } from './coordinator-resume-setup.mjs';
import { execFile } from 'node:child_process';

// What bare `pots` prints, and the top of the usage text for a command that is not known.
const COMMANDS = 'Pi on the Side! commands:\n' +
  '  pots install     install or repair it and connect your saved OMP sessions (--no-coordinator-wakeups turns wake-ups off, --coordinator-wakeups on again)\n' +
  '  pots upgrade     get the newest version\n' +
  '  pots doctor      check that your assistant is woken when a lane finishes\n' +
  '  pots status      show what is installed and connected\n' +
  '  pots lane restore <name>  continue a lane that a restart or crash stopped, or put a closed lane back and continue it (the same limits as start can be added)\n' +
  '  pots lane close <name>    take a lane that is not running off the list to free a place (its saved session is not touched)\n' +
  '  pots lane close --finished  take every finished lane off the list at once (one lane always stays)\n' +
  '  pots lane list   show each lane on the list as running or finished, and the lanes you can bring back\n' +
  '  pots instructions  print the text to paste into ChatGPT\n' +
  '  pots --version   show the version\n' +
  '  pots uninstall   remove it (pots uninstall --all lists every install that Windows lists and removes them only when --confirm-offline is added)';
const USAGE = COMMANDS + '\n\n' +
  'Pi on the Side! lets your AI assistant control multiple Oh My Pi (OMP) sessions through a reliable local connection.\n' +
  'It is designed to work across OMP versions; compatibility problems are bugs to fix, though not every past or future release has been tested. Choose a named project, send one approved task, check recorded progress, and cancel before OMP accepts it. Queued work may continue through a temporary assistant-connection interruption only while OMP and its provider remain available; this is not guaranteed. Receipts are observations, not proof of success; work that did not complete is never replayed automatically.\n' +
  'Uninstall: uninstall <installation-root> [--all] [--confirm-offline] [--purge --confirm-purge]\n' +
  'Usage: bridge.mjs setup-auto (connects every saved session; --session <saved-file> connects only that one) [--root <private-folder>] [--name <connection>] [--session-dir <sessions-folder>] [--clients claude|chatgpt|both] [--coordinator-wakeups | --no-coordinator-wakeups] | connect <connections-folder> <name> <saved-state-folder> | setup <saved-session.jsonl> <new-state-folder> | start <state-folder> [--confirm-offline] | ' +
  'Resume opt-in: --resume-cli none|claude|chatgpt|both --resume-cloud none|claude|chatgpt|both --handoff-file <absolute-file> [--claude-executable <absolute-exe>] [--codex-executable <absolute-exe>] [--claude-session <id> | --claude-continue] [--resume-dry-run] [--resume-poll-ms 1000..15000]. Cloud text is manual best-effort; fresh sessions lack memory/local access and may stall on permissions. CLI resume is the reliable path.\n' +
  'controller-create <new-credential-file> | controller-acquire <state-folder> <credential-file> | controller-handoff <state-folder> <current-credential-file> <next-credential-file> | ' +
  'command <state-folder> <command-id> <slash-command> | command-status <state-folder> <command-id> | command-cancel <state-folder> <command-id> | ' +
  'model <state-folder> <model-name-as-OMP-lists-it> | lane-task <state-folder> <model-name> <prompt> | queue <state-folder> <prompt> [--model <model-name>] | status <state-folder> | cancel <state-folder> <plan-id>\n' +
  'Lane limits (optional, none by default): start <state-folder> [--confirm-offline] [--warn-cost <dollars>] [--max-cost <dollars>] [--max-time <time such as 30m or 2h>]\n' +
  'Update: update check [--prerelease] | update install <new-install-folder> [--prerelease] | ' +
  'update migrate <existing-install-folder> <state-folder> [--confirm-offline] [--prerelease] | update apply <state-folder> [--confirm-offline] [--prerelease] | update rollback <state-folder> [--confirm-offline]\n' +
  'Advanced: init <new-state-dir> | enqueue <config> <plan> | status <config> | abort <config> <plan-id> | ' +
  'launch-plan <config> <saved-session>\n' +
  'Lane watcher (reads local files only): watch-lines <connections-or-state-folder> [--peek] prints only the lane lines not shown before | watch-state <connections-or-state-folder> prints each lane\'s latest state';
export const ALLOWED = new Set([...UNINSTALL_ERRORS, ...FIXED, ...CONNECTION_ERRORS, ...CONTROLLER_ERRORS, ...LANE_ERRORS, ...AUTO_ERRORS, ...WATCH_ERRORS, ...Object.values(UPDATE_MESSAGES), USAGE]);
const EXTENSION = path.join(CHECKOUT, 'extension', 'bridge.ts');
const NOT_INSTALLED = 'This command works from the installed copy. Install Pi on the Side first (the quickstart has the one line), then use the pots command.';
const BOTH_WAKEUP_FLAGS = 'Use either --coordinator-wakeups or --no-coordinator-wakeups, not both. Nothing was changed.';
const OFF_WITH_RESUME = 'Use --no-coordinator-wakeups without the resume options (--resume-cli, --resume-cloud, --handoff-file and the others), or leave it out. Nothing was changed.';
const CANCEL_RECORDED_NOTE = 'cancel recorded; the task will not run and is marked cancelled when the lane is next running';
const NO_SUCH_TASK = 'There is no queued task with that id. Next: run pots status <state-folder> to see the ids of the queued tasks, then try again.';
// The two ways the queue itself refuses a task, in plain words (the task was not stored, so nothing was started).
export const QUEUE_REFUSED = { 'queue capacity reached': 'The queue for this project is full, so the task was not queued. Next: wait for queued tasks to finish or cancel some with pots cancel, then try again.',
  'invalid step': 'The task text was not accepted, so the task was not queued. Next: use 1 to 6000 characters and no control characters other than tabs and new lines, then try again.' };
const ALREADY_CANCELLED = 'Cancelling this task was already recorded earlier, so nothing more was needed. ' + CANCEL_NOTE;
// A lane that cannot be continued, and the limits that were not understood, in plain words.
const LANE_STILL_RUNNING = 'This lane is still running in an OMP window, so nothing was changed. Next: if the assistant says the lane is stopped, run /bridge status in that window; if the bridge is not running there, fix what it says and run /bridge enable. Otherwise let it finish or close that window, then run this command again.';
const LANE_NOT_PROVEN = 'OMP could not say whether this lane is still running, or this OMP is too old to continue a stopped lane, so nothing was started. Next: update OMP, or start a new lane for the project.';
const LANE_NO_SESSION = 'This lane\'s saved OMP session could not be found or read, so it cannot be continued. Next: start a new lane for the project.';
const BAD_LIMITS = 'The limits were not understood, so nothing was started. Use --warn-cost <dollars>, --max-cost <dollars> and --max-time <time such as 30m or 2h>, each at most once.';
const PLAIN = new Set([NOT_INSTALLED, BOTH_WAKEUP_FLAGS, OFF_WITH_RESUME, NO_SUCH_TASK, LANE_STILL_RUNNING, LANE_NOT_PROVEN, LANE_NO_SESSION, BAD_LIMITS, ...Object.values(QUEUE_REFUSED)]);
// Optional limits go to OMP as they are; none is set unless the person asks.
const LIMIT_FLAGS = { '--warn-cost': /^\d+(\.\d+)?$/, '--max-cost': /^\d+(\.\d+)?$/, '--max-time': /^\d+[smh]?$/ };
function laneLimits(flags) {
  const given = [];
  for (let i = 0; i < flags.length; i += 2) {
    if (!Object.hasOwn(LIMIT_FLAGS, flags[i]) || given.includes(flags[i]) || !LIMIT_FLAGS[flags[i]].test(flags[i + 1] ?? '')) throw new Error(BAD_LIMITS);
    given.push(flags[i]);
  }
  return flags;
}
// Asks OMP which of these sessions a running OMP owns (it takes no ownership).
const askLease = (executable, sessionId) => new Promise((resolve, reject) => execFile(executable, ['session', 'lease', '--json', '--', sessionId], { windowsHide: true, timeout: 20000, maxBuffer: 1 << 16 },
  (error, stdout) => { try { const value = JSON.parse(stdout); if (error || !Array.isArray(value.held) || !Array.isArray(value.unknown)) throw error ?? new Error('lease'); resolve(value); } catch (e) { reject(e); } }));

// The exact text the terminal shows for a failure of `pots install`. A bare internal sentence means nothing to a person:
// say what it means first and keep the technical text under Details.
export function shownText(error) {
  const text = diagnostic(error, new Set([...ALLOWED, ...PLAIN]));
  const left = Array.isArray(error?.left) ? error.left.filter(row => typeof row === 'string') : [];
  if (text === MESSAGES.incomplete) return `Setup found a folder of an earlier install that it could not read completely, so it stopped and changed nothing. Nothing is lost. Run pots install again; if this message comes back, send the Details to support.\nDetails: ${text}`;
  if (text === MESSAGES.noOmp) return `pots install could not find OMP on this PC. Next: install OMP (the releases are at https://github.com/can1357/oh-my-pi/releases) so that omp.exe is in a folder on your PATH, then run pots install again.\nDetails: ${text}`;
  const shown = text === REVIEW ? reviewText('pots install') : text;
  return left.length ? `${shown}\nSetup could not undo all of its changes: ${left.join(' ')} Close all OMP windows and try again. If this message comes back, tell support.` : shown;
}

// `pots` is bridge.mjs run from the fixed launcher, so the install folder is two levels above it.
const installRoot = deps => { if (!deps.managed) throw new Error(NOT_INSTALLED); return path.dirname(path.dirname(path.resolve(deps.managed))); };
const packageVersion = async () => (await readJson(path.join(CHECKOUT, 'package.json'))).version;
// What `pots upgrade` says when it could not upgrade: the plain note, then the one thing the person can do (or that there is none).
const UPGRADE_NEXT = { 'gh-missing': 'Next: install the GitHub CLI (gh), then run pots upgrade again.', 'auth-missing': 'Next: run gh auth login, then run pots upgrade again.',
  'no-access': 'Next: log in to GitHub with an account that can read the releases (gh auth login), then run pots upgrade again.',
  unavailable: 'Next: check your internet connection, then run pots upgrade again.', 'download-failed': 'Next: check your internet connection, then run pots upgrade again.' };
// The same recovery steps for a pointer that could not be put back and for the lock an earlier upgrade kept because of it.
const recoverPointer = managed => `Next: in ${managed}, check that current.json names a folder that exists inside versions (fix the name if it does not), then delete only the file activate.lock there and run pots upgrade again. The steps are in docs/update.md under Rollback and recovery.`;
const deferredNext = (reason, managed) => reason === REASONS.changed ? 'Next: run pots upgrade again.' : reason === REASONS.kept ? recoverPointer(managed) : 'Next: wait until the other upgrade has finished, then run pots upgrade again.';
async function upgrade(flags, deps) {
  const root = installRoot(deps), open = await (deps.openSessions?.() ?? 0).catch(() => 1);
  // The same rule as managed Start and the updater: the newest published release, prereleases included.
  const result = await applyUpdate(undefined, { gh: deps.gh, managed: deps.managed, prerelease: true, confirm: true, io: deps.io, now: deps.now, probe: deps.startCheck ?? startCheck });
  let sentence, finished = true;
  if (result.status === 'activated') sentence = `Upgraded to ${result.current}.${open > 0 ? ' A session is open, so the new version starts with the next session.' : ''}${result.lockLeft ? ` The upgrade worked, but Windows would not let go of the file activate.lock in ${deps.managed}. It is harmless; delete it if a later upgrade says another update is running.` : ''}`;
  else if (result.status === 'up-to-date') sentence = `Pi on the Side ${result.current} is already the newest version.`;
  else if (result.status === 'activation-failed-unrestored') sentence = `The upgrade failed, and Pi on the Side could not put the old version back, so it is not sure which version is active. ${result.unmarked ? 'It left a lock file but could not mark it, so a later upgrade may start without stopping for it;' : 'It left a lock file so no other upgrade can start until you have checked;'} OMP still starts whichever version current.json names. ${recoverPointer(deps.managed)}`;
  else { sentence = `Nothing was changed. ${noteOf(result) ?? NOTES.failed} ${(result.status === 'deferred' ? deferredNext(result.reason, deps.managed) : UPGRADE_NEXT[result.status]) ?? 'Nothing else to do: the version you have keeps working.'}`; finished = false; }
  // The new version (or the one already there) finishes its own setup, so nothing is left to do by hand.
  if (['activated', 'up-to-date'].includes(result.status) && deps.reinstall) {
    const again = await deps.reinstall(deps.managed);
    if (again.ok) sentence += again.text ? `\n${again.text}` : ` ${NOTHING_LEFT}`;
    else { sentence += ` Finishing the setup failed, so some parts may be out of date. Next: run pots install.${again.text ? ' ' + again.text : ''}`; finished = false; }
  } else if (SUCCESS.has(result.status)) sentence += ` ${NOTHING_LEFT}`;
  deps.stdout(sentence);
  if (flags.includes('--details')) deps.stdout(`\nWhat happened\n  Status: ${result.status}\n  Before: ${result.previous ?? result.current}\n  Latest published: ${result.latest ?? 'unknown'}\n  Install folder: ${root}`);
  return SUCCESS.has(result.status) && finished ? 0 : 1;
}
async function status(flags, deps) {
  const root = installRoot(deps), pointer = await readJson(path.join(deps.managed, 'current.json')), registry = path.join(root, 'connections');
  const saved = (await exists(path.join(registry, 'connections.json'))) ? (await readConnections(registry)).connections : [];
  const { rows: loadedRows, unavailable } = await loadConnections({ connections: saved }, deps.now), connected = saved.filter(row => !unavailable.some(bad => bad.name === row.name));
  const agent = deps.env.PI_CODING_AGENT_DIR || path.join(deps.home, '.omp/agent');
  // Every saved session in the default folders that install would connect (a project folder inside the install folder is never connected), plus every connection (a session saved elsewhere, e.g. with --session-dir, is still counted).
  const found = new Set([...(await discoverSessions([path.join(agent, 'sessions'), path.join(agent, 'custom-session-files')]).catch(() => [])).filter(row => !inside(root, row.cwd)).map(row => row.sessionId), ...connected.map(row => row.binding.sessionId)]).size;
  const record = await readJson(path.join(root, 'uninstall-record.json'), 1048576).catch(() => ({}));
  const NAMES = { 'claude-desktop': 'Claude Desktop', codex: 'Codex', 'claude-skill': 'Claude skill' };
  const assistants = [...(record.claudeCode ? ['Claude Code'] : []), ...(record.assistants ?? []).filter(row => NAMES[row.kind]).map(row => NAMES[row.kind])];
  const open = await (deps.openSessions?.() ?? 0).catch(() => 0);
  const capped = connected.length >= MAX_CONNECTIONS && found > connected.length, missing = connected.length < found && !capped;
  const lost = unavailable.filter(row => !row.kept), folderRows = unavailable.filter(row => row.kept);
  const gone = (lost.length ? ` ${lost.length === 1 ? 'One more connection' : `${lost.length} more connections`} cannot be used any more because the saved OMP session was deleted or changed (${lost.map(row => row.name).join(', ')}).` : '') + folderRows.map(row => ` ${row.name}: ${row.problem}`).join('');
  const health = deps.tasks ? await resumeHealth({ root, tasks: deps.tasks, env: deps.env }).catch(() => [{ ok: false, text: 'It could not be checked.' }]) : [], wake = health.filter(row => !row.ok), wakeOff = health.some(row => row.key === 'off'), wakeOld = health.find(row => row.key === 'off-old' || row.key === 'cloud-only');
  const unstarted = await unstartedPlans(loadedRows, deps.now()), unstartedText = unstarted.length ? ` ${UNSTARTED_TEXT} (${unstarted.map(row => row.id).join(', ')})` : '';
  const stopped = (await lanesStatus(loadedRows).catch(() => ({ lanes: [] }))).lanes.filter(row => row.stopped);
  deps.stdout(`Pi on the Side ${pointer.current} is installed in ${root}. ${connected.length} of ${found} saved OMP sessions are connected${capped ? ` (${MAX_CONNECTIONS} is the most it connects at once, so the rest are left out)` : ''}.${gone}${unstartedText} Assistants set up: ${assistants.length ? assistants.join(', ') : 'none'}.${deps.tasks ? (wake.length ? ` Wake-ups: NOT WORKING. ${wake[0].text} Run pots doctor for the whole list.` : wakeOld ? ` ${wakeOld.text}` : wakeOff ? ` Wake-ups: off by your choice.${health.some(row => row.text.endsWith(WAKEUPS_ON_AGAIN)) ? ' ' + WAKEUPS_ON_AGAIN : ''}` : ' Wake-ups: working.') : ''} ${stopped.length ? stopped.map(row => `${row.connection}: ${row.next}`).join(' ') : lost.length ? 'Next: run pots install to remove the connections that cannot be used.' : folderRows.length ? 'Next: fix the folder or link named above, then run pots status again.' : missing ? 'Next: run pots install to connect the rest. If the number stays the same, pots install --details says which project was skipped and why.' : capped ? `Nothing else to do for the ${MAX_CONNECTIONS} that are connected.` : NOTHING_LEFT}`);
  if (flags.includes('--details')) {
    deps.stdout(['', 'Version', `  Now: ${pointer.current}`, `  Before: ${pointer.previous ?? 'none kept'}`, '', 'Where', `  Install folder: ${root}`, `  Program folder: ${path.join(deps.managed, 'versions', pointer.current)}`,
      `  Assistant folder: ${registry}`, '', `Connected sessions (${open} OMP window(s) open now)`, ...connected.map(row => `  ${row.name}: ${row.binding.cwd}`)].join('\n'));
  }
  return 0;
}

// `pots install`: the one code path behind the one-line installer and a repeat run.
async function install(flags, deps) {
  // Run from an installed copy, it repeats the install of THAT folder (a custom --root included), never a second one in the default folder.
  if (flags.includes('--coordinator-wakeups') && flags.includes('--no-coordinator-wakeups')) throw new Error(BOTH_WAKEUP_FLAGS);
  const options = { ...(deps.managed ? { root: installRoot(deps) } : {}), ...(flags.includes('--no-coordinator-wakeups') ? { coordinatorWakeups: false } : {}), ...(flags.includes('--coordinator-wakeups') ? { coordinatorWakeups: true } : {}) };
  const result = await autoSetup(options, deps), message = resultMessage(result), details = resultDetails(result);
  deps.stdout(message);
  if (flags.includes('--details')) deps.stdout('\n' + details);
  // The install itself is done, but a failed wake-up self-test means the wake-up path is not proven: the exit code says so (the reason is in the message above).
  return result.selfTest && !result.selfTest.pass ? 1 : 0;
}
// `pots instructions`: the text to paste into ChatGPT. The guidance goes to stderr and the text alone to stdout,
// so `pots instructions | clip` copies just the text.
async function instructions(deps) {
  const file = path.join(installRoot(deps), 'coordinator-instructions', 'chatgpt-custom-instructions.txt');
  const text = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) { deps.stderr('There are no ChatGPT instructions to paste because ChatGPT is not set up. Next: install the ChatGPT desktop app, then run pots install.'); return 1; }
  deps.stderr(`Paste the text below once into ChatGPT Settings > Personalization > Custom instructions. It is also saved in ${file}. To copy it, run: pots instructions | clip`);
  deps.stdout(text.trimEnd());
  return 0;
}
// `pots doctor`: every part of the wake-up path in plain words, then the throwaway-lane self-test. Exit 1 when anything is not working.
async function doctor(deps) {
  const root = installRoot(deps), rows = await resumeHealth({ root, tasks: deps.tasks, env: deps.env });
  deps.stdout(healthText(rows).join('\n'));
  if (rows.some(row => row.key === 'off' || row.key === 'off-old' || row.key === 'cloud-only')) return rows.every(row => row.ok) ? 0 : 1; // switched off on purpose: nothing to test
  const result = await deps.selfTest({ installRoot: root, laneWatch: { pollSeconds: WATCH_DEFAULTS.pollMs / 1000, idleSeconds: WATCH_DEFAULTS.idleMs / 1000 } });
  deps.stdout(result.text);
  if (!result.pass) await logProblem(root, result.text, deps.now);
  return result.pass ? 0 : 1;
}
// One plain sentence and one next step for every reason uninstall can stop. The raw reason and the items only appear with --details.
const WHY = {
  'host-registration-changed': 'The Pi on the Side entry in Claude Code was changed after Setup made it, so it was left alone. Next: run claude mcp remove omp-session-bridge --scope user, then run pots uninstall again.',
  'unverified-files': 'The install folder has a file that Pi on the Side did not make, so nothing was removed. Next: move your own files out of the install folder (pots uninstall --details lists them), then run pots uninstall again.',
  'unresolved-external-copies': 'Another copy of Pi on the Side was found outside the install folder. Next: remove that copy the way you installed it, then run pots uninstall again.',
  'unverified-recovery-containers': 'The recovery folder next to the install holds something Pi on the Side did not make. Next: look at it (pots uninstall --details names it), keep what you need, then run pots uninstall again.',
  'files-remain': 'Some files are still in the install folder because something is using them. Next: close OMP and your assistants, then run pots uninstall again.',
  'registry-remains': 'Windows still lists Pi on the Side under Installed apps. Next: run pots uninstall again; if it comes back, remove the entry in Settings > Apps.',
  'registry-removal-failed': 'Windows would not remove the Pi on the Side entry under Installed apps. Next: run pots uninstall again.',
  'locked-or-removal-failed': 'Some files could not be removed because something is using them. Next: close OMP and your assistants, then run pots uninstall again.',
  'removal-failed': 'Pi on the Side could not finish removing everything. Next: run pots uninstall again; if it comes back, send the Details to support.',
  'permissions-review': 'A file or folder in the install folder is not private to you, or it is a link, and Pi on the Side does not follow links. Nothing in the install folder was removed. Next: if you made a link inside the install folder, delete the link itself (not the folder it points to), then run pots uninstall again. If you did not, send the Details to support.',
  'recovery-kept': 'The install folder was moved to a private recovery folder, but Pi on the Side could not check it there, so it stopped and kept the files. Next: do not delete the recovery folder; send the Details to support.',
  'installation-changed': 'The install folder changed while uninstall was checking it, so nothing was removed. Next: close OMP and your assistants, then run pots uninstall again.',
  'foreign-registry-entry': 'The Installed apps entry for Pi on the Side belongs to another folder, so nothing was removed. Next: remove it in Settings > Apps if you no longer want it.',
  'recovery-container-remains': 'The recovery folder could not be cleaned up. Next: close OMP and your assistants, then run pots uninstall again.',
  'recovery-parent-remains': 'The recovery folder could not be cleaned up. Next: close OMP and your assistants, then run pots uninstall again.',
};
async function removeAll(deps, flags = []) {
  // Besides this install, plain `pots uninstall` cleans up an Installed-apps entry whose folder is gone (only one Setup wrote). `--all` takes every listed install (or only this one when Windows lists none), so it only shows the list until `--confirm-offline` is added.
  const all = flags.includes('--all'), root = installRoot(deps), result = await uninstall(root, { confirmOffline: !all || flags.includes('--confirm-offline'), orphans: true, all }, deps.uninstallDeps);
  const parts = result.installations ?? [];
  if (result.status === 'preview') {
    const lines = parts.filter(part => part.status === 'ready' || part.orphan).map(part => `${part.root} (${part.status === 'ready' ? 'its files are moved to a private recovery folder next to it, not deleted' : 'the folder is already gone, so only its Installed apps entry is removed'})`);
    deps.stdout(`Nothing was removed. pots uninstall --all would remove ${lines.length === 1 ? 'this install' : 'these installs'}: ${lines.join('; ')}. Next: to go ahead, run pots uninstall --all --confirm-offline.`);
    return 0;
  }
  if (['uninstalled', 'already-absent'].includes(result.status)) {
    // The files the person changed are in each installation's own result.
    const kept = parts.flatMap(part => part.preservedExternal ?? []), settingsKept = parts.flatMap(part => part.preservedSettings ?? []), settingsNote = settingsKept.length ? ' Next: these settings files still have a Pi on the Side entry. Open each file and remove only that entry. Do not delete the file, because it also holds your other settings: ' + settingsKept.join(', ') : '', commandGone = parts.some(part => part.commandRemoved), cameBack = parts.filter(part => part.cameBack).map(part => ` The folder ${part.root} came back while this ran, so it was left alone.`).join('');
    const claudeKept = parts.some(part => part.claudeCodeGone) ? ' Claude Code was not found any more, so its Pi on the Side entry could not be removed with it and was left in Claude Code\'s settings file (.claude.json in your user folder). It does nothing without Pi on the Side. Next: delete the "omp-session-bridge" entry under mcpServers in that file, or install Claude Code again and run: claude mcp remove omp-session-bridge --scope user'
      : parts.some(part => part.claudeCodeKept) ? ' Claude Code\'s settings file could not be read, so its Pi on the Side entry was left. Next: run claude mcp remove omp-session-bridge --scope user.' : '';
    deps.stdout(`Pi on the Side was removed${commandGone ? ', including the pots command' : ''}. Your projects and OMP sessions were not touched.${parts.some(part => part.linkRemoved) ? ' A link named disabled in the wake-up folder was removed (only the link, not what it pointed to).' : ''}${parts.some(part => typeof part.recovery === 'string') ? ' A private copy of what was removed is kept for recovery.' : ''}${cameBack} ${kept.length ? `Next: these files were kept because they look changed after Setup wrote them. Delete them yourself if you do not want them: ${kept.join(', ')}` : settingsKept.length ? settingsNote.trim() : NOTHING_LEFT}${kept.length && settingsKept.length ? settingsNote : ''}${claudeKept}`);
    return 0;
  }
  // An earlier install may already be gone (and the pots command with it) when a later one fails: say what was removed and where its files went.
  const done = parts.filter(part => part.status === 'uninstalled'), shimGone = done.some(part => part.commandRemoved);
  const why = parts.find(row => !['uninstalled', 'already-absent'].includes(row.status)) ?? result;
  const reason = why.reason ?? why.status, items = [...(why.items ?? []), ...(why.pids ?? []).map(pid => `process ${pid}`)];
  const lead = done.length ? `Pi on the Side was only partly removed. Removed: ${done.map(part => part.root + (typeof part.recovery === 'string' ? ` (its files are in ${part.recovery})` : '')).join('; ')}.${why.root ? ` Not removed: ${why.root}.` : ''}${shimGone ? ' The pots command went with the removed install.' : ''}` : 'Pi on the Side was not removed.';
  const next = why.note ?? WHY[reason] ?? 'Close OMP and your assistants, then run pots uninstall again.';
  deps.stdout(`${lead} ${shimGone ? next.replaceAll('run pots uninstall again', 'uninstall again from Settings > Apps > Installed apps (Pi on the Side!)') : next}${typeof why.recovery === 'string' ? ` The files are in ${why.recovery}.` : ''}${why.wakeupsOff ? ' The wake-up task was already removed, so wake-ups are off until you run pots install.' : ''}${flags.includes('--details') ? `\nDetails: ${reason}${items.length ? ` (${items.join(', ')})` : ''}${typeof why.detail === 'string' ? `; ${why.detail}` : ''}` : ''}`);
  return 1;
}
const usage = () => { throw new Error(USAGE); };
const UPDATE_FLAGS = { check: [0, ['--prerelease']], install: [1, ['--prerelease']], apply: [1, ['--confirm-offline', '--prerelease']],
  rollback: [1, ['--confirm-offline']], migrate: [2, ['--confirm-offline', '--prerelease']] };
// Fixed text only (never paths or settings values).
const WATCH_NOTES = { running: 'Lane watcher on: idle, busy, result-file and process-gone changes are logged locally. Zero network, zero model calls.',
  off: 'Lane watcher off.', disabled: 'Lane watcher is turned off in lane-watch.json.',
  invalid: 'Lane watcher off: lane-watch.json is invalid. OMP starts without it.', failed: 'Lane watcher could not start. OMP starts without it.' };
// A connections folder (several lanes) or one saved-state folder (one lane).
async function watchRows(target, deps) {
  const folder = path.resolve(target);
  if (await exists(path.join(folder, 'connections.json'))) return (await loadConnections(await readConnections(folder), deps.now)).rows;
  return [{ name: 'default', loaded: await loadSetup(folder, deps.now) }];
}

// OMP owns the terminal while it runs. Ctrl+C/Ctrl+Break reach every process
// on the console; this wrapper ignores them so it never exits and orphans OMP.
// OMP's own handling of those keys is unchanged.
function launchForeground({ executable, args, cwd, env, onSpawn }) {
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGQUIT'];
    for (const signal of signals) process.on(signal, ignore);
    const done = () => { for (const signal of signals) process.off(signal, ignore); };
    let child;
    try { child = spawn(executable, args, { cwd, env, stdio: 'inherit', shell: false }); onSpawn?.(child.pid); }
    catch (error) { done(); reject(error); return; }
    child.once('error', error => { done(); reject(error); });
    child.once('exit', code => { done(); resolve(code ?? 1); });
  });
}

const DEFAULTS = {
  ...autoDefaults,
  stdout: text => process.stdout.write(text + '\n'),
  stderr: text => process.stderr.write(text + '\n'),
  locate: () => locateOmp(process.env),
  detect: executable => detectHost(executable),
  launch: launchForeground,
  watch: startLaneWatch,
  lease: askLease,
  now: Date.now,
  nodeVersion: process.versions.node,
  gh: (args, limits) => runGh(args, limits),
  io: fs,
  // Set only by a managed install's launcher (never by argv or environment).
  managed: undefined,
  controllerFile: process.env.OMP_BRIDGE_CONTROLLER,
  // After an upgrade the new version finishes its own setup (scheduled task, assistant connections, self-test): the same install command, on the new code.
  reinstall: managed => new Promise(resolve => execFile(process.execPath, [path.join(managed, 'bridge.mjs'), 'install'], { windowsHide: true, timeout: 600000, maxBuffer: 1 << 20 },
    (error, stdout, stderr) => resolve({ ok: !error, text: String(stdout).trim() || String(stderr).trim() }))),
  modelWaitMs: 60000,
  modelTries: 6,
  modelRetryMs: 1000,
  modelPollMs: 250,
};

// A setup folder (directory) gets full revalidation; a file is the advanced
// hand-written 3-key config, unchanged from earlier releases.
async function storeFor(target, now) {
  const file = path.resolve(target);
  let directory = false;
  try { directory = (await fs.lstat(file)).isDirectory(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (directory) return (await loadSetup(file, now)).store;
  const store = new Store(config(await readJson(file)), now);
  await store.ready();
  return store;
}

// Target and lock checks; refuses any lock from a running or crashed
// supervisor and never steals or recovers it.
async function checkTarget(root, now) {
  const current = await loadSetup(root, now);
  await plain(current.settings.cwd, true);
  if (await exists(current.lockFile)) throw new Error(MESSAGES.locked);
  return current;
}

// `restore` continues a stopped lane with OMP's --restore. It first proves nothing owns the session any more: OMP's own lease check, then a supervisor lock that is this lane's own and whose process is gone.
async function freeForRestore(root, deps) {
  const { settings, launch, lockFile } = await loadSetup(root, deps.now).catch(() => { throw new Error(LANE_NO_SESSION); });
  const state = await deps.lease(launch.executable, settings.sessionId).catch(() => { throw new Error(LANE_NOT_PROVEN); });
  if (state.held.includes(settings.sessionId)) throw new Error(LANE_STILL_RUNNING);
  if (state.unknown.includes(settings.sessionId)) throw new Error(LANE_NOT_PROVEN);
  if (!await exists(lockFile)) return;
  const own = await readJson(lockFile).then(lock => lock?.sessionId === settings.sessionId, () => false);
  if (!own || !await isStaleLock(lockFile)) throw new Error(MESSAGES.locked);
  if (!await unlinkRetry(lockFile)) throw new Error(MESSAGES.locked);
}

async function start(target, confirm, deps, { restore = false, limits = [], relist } = {}) {
  const root = path.resolve(target);
  if (restore) { await freeForRestore(root, deps); await relist?.(); }
  const current = await checkTarget(root, deps.now);
  const { settings, launch } = current;
  // Normal Start includes published stable and prerelease versions, never drafts.
  // Managed launcher only: check at start, stage on preview, and on a
  // confirmed start activate inside the lock boundary. This process has the
  // old code loaded, so after activating it exits without launching OMP.
  // A failed or deferred update keeps and launches the current version.
  let update;
  if (deps.managed && !restore) {
    try { update = await applyUpdate(root, { gh: deps.gh, managed: deps.managed, prerelease: true, confirm, io: deps.io, now: deps.now }); }
    catch { update = { status: 'failed' }; }
    update = { ...update, note: noteOf(update) };
    if (update.status === 'activated') {
      deps.stdout(JSON.stringify({ started: false, update,
        next: 'Rerun this start command with --confirm-offline to launch the activated version.' }, null, 2));
      return 0;
    }
  }
  const host = await requireHost(deps.detect, launch.executable);
  // The probe can take seconds. Validate target and lock again immediately
  // before acting; anything that changed in between refuses without launching.
  const recheck = await checkTarget(root, deps.now);
  if (JSON.stringify([recheck.settings, recheck.launch]) !== JSON.stringify([settings, launch])) throw new Error(MESSAGES.changed);
  // --no-extensions stops automatic discovery from loading a second copy of the
  // bridge; the one explicit --extension path still loads. No settings change.
  const args = ['--no-extensions', '--extension', EXTENSION, restore ? '--restore' : '--resume', launch.sessionFile, ...limits];
  const environment = { OMP_BRIDGE_CONFIG: current.configFile };
  if (!confirm) {
    deps.stdout(JSON.stringify({ started: false, foreground: true, sessionId: settings.sessionId, sessionFile: launch.sessionFile,
      cwd: settings.cwd, executable: launch.executable, extension: EXTENSION, args, environment, host,
      providerAuth: PROVIDER_AUTH, ownerOnlyPermissions: OWNER_ONLY,
      offlineOwnership: 'Not checked automatically. Confirm that no OMP window or process is using this saved session, ' +
        'then rerun this command with --confirm-offline to resume it in this terminal.',
      limits: [
        'The bridge lock cannot detect OMP instances started without this bridge or with another state folder.',
        'Other automatically discovered OMP extensions are not loaded in this run.',
        "Cancel stops future bridge steps only; interrupt active work with OMP's own controls.",
        'A plan that did not complete is never retried; inspect it in OMP. A restart turns in-flight work into failed (reason restart).',
      ], update }, null, 2));
    return 0;
  }
  if (update) deps.stderr(`Update ${update.status}${update.reason ? ` (${update.reason})` : ''}: ${update.note}`);
  deps.stderr(restore ? "Continuing the stopped lane in this terminal. Use OMP's own controls to interrupt or exit." : "Starting OMP in this terminal. Use OMP's own controls to interrupt or exit; queue from another terminal.");
  // The lane watcher lives inside this wrapper for exactly as long as OMP runs: no extra process,
  // window or Startup entry. It can never block or fail the launch.
  const watch = await deps.watch({ root: settings.root, sessionId: settings.sessionId, cwd: settings.cwd }).catch(() => ({ status: 'failed', setChildPid() {}, stop: async () => {} }));
  deps.stderr(WATCH_NOTES[watch.status] ?? WATCH_NOTES.failed);
  let code;
  try { code = await deps.launch({ executable: launch.executable, args, cwd: settings.cwd, env: { ...process.env, ...environment }, onSpawn: pid => watch.setChildPid(pid) }); return code; }
  finally { await watch.stop({ exitCode: code }).catch(() => {}); }
}

async function update(action, rest, deps) {
  const flags = rest.filter(arg => arg.startsWith('--')), args = rest.filter(arg => !arg.startsWith('--'));
  const shape = Object.hasOwn(UPDATE_FLAGS, action) ? UPDATE_FLAGS[action] : usage();
  if (args.length !== shape[0] || new Set(flags).size !== flags.length || flags.some(flag => !shape[1].includes(flag))) usage();
  if (!nodeSupported(deps.nodeVersion)) throw new Error(MESSAGES.node);
  const prerelease = flags.includes('--prerelease'), confirm = flags.includes('--confirm-offline');
  const options = { gh: deps.gh, managed: deps.managed, prerelease, confirm, io: deps.io, now: deps.now };
  let result;
  if (action === 'check') result = { ...await checkUpdate(options), channel: prerelease ? 'prerelease' : 'stable', managed: Boolean(deps.managed) };
  else if (action === 'install') result = await installUpdate(args[0], options);
  else if (action === 'apply') result = await applyUpdate(args[0], options);
  // Explicit manual migration uses this verified release's canonical transport.
  // Existing install validation, lock/receipt gates, rollback and no-launch
  // behavior remain in applyUpdate; the old runtime is never edited in place.
  else if (action === 'migrate') result = await applyUpdate(args[1], { ...options, managed: path.resolve(args[0]) });
  else result = await rollbackUpdate(args[0], options);
  deps.stdout(JSON.stringify({ ...result, note: noteOf(result) }, null, 2));
  return SUCCESS.has(result.status) ? 0 : 1;
}

async function dispatch(argv, deps) {
  const [command, target, ...rest] = argv;
  // Exit 1 with the list on stderr on purpose: the start check of every installed version runs a bare `bridge.mjs` and wants exactly that.
  if (!command) { deps.stderr(COMMANDS); return 1; }
  // The pots commands: one word each, no folders to name.
  const flags = argv.slice(1), only = allowed => flags.every(flag => allowed.includes(flag)) && new Set(flags).size === flags.length;
  const requireNode = () => { if (!nodeSupported(deps.nodeVersion)) throw new Error(MESSAGES.node); };
  if (['--version', 'version'].includes(command) && !flags.length) { deps.stdout(`Pi on the Side ${await packageVersion()}`); return 0; }
  if (command === 'install' && only(['--details', '--coordinator-wakeups', '--no-coordinator-wakeups'])) return install(flags, deps);
  if (command === 'instructions' && !flags.length) return instructions(deps);
  if (command === 'upgrade' && only(['--details'])) return upgrade(flags, deps);
  if (command === 'doctor' && !flags.length) return doctor(deps);
  if (command === 'status' && !flags.filter(flag => flag !== '--details').length && flags.length <= 1) return status(flags, deps);
  if (command === 'uninstall' && only(['--details', '--all', '--confirm-offline']) && (flags.includes('--all') || !flags.includes('--confirm-offline'))) return removeAll(deps, flags);
  if (command === 'lane' && target === 'list' && argv.length === 2) {
    const registry = path.join(installRoot(deps), 'connections');
    if (!(await exists(path.join(registry, 'connections.json')))) { deps.stdout('No lanes are on the list yet.'); return 0; }
    const { lanes, offTheList } = await laneOverview(registry);
    deps.stdout([`Lanes on the list (${lanes.length} of ${MAX_CONNECTIONS}):`, ...lanes.map(lane => `  ${lane.name}: ${lane.state}`),
      ...(offTheList.length ? ['Off the list, can be brought back with pots lane restore <lane-name>:', `  ${offTheList.join(', ')}`] : [])].join('\n'));
    return 0;
  }
  if (command === 'lane' && target === 'close' && argv[2] === '--finished' && argv.length === 3) {
    requireNode();
    deps.stdout((await closeFinishedConnections(path.join(installRoot(deps), 'connections'))).note);
    return 0;
  }
  if (command === 'lane' && ['close', 'restore'].includes(target) && argv.length >= 3 && (target === 'restore' || argv.length === 3)) {
    requireNode();
    const registry = path.join(installRoot(deps), 'connections'), name = argv[2];
    if (target === 'close') { deps.stdout((await closeConnection(registry, name)).note); return 0; }
    const saved = (await exists(path.join(registry, 'connections.json'))) ? (await readConnections(registry)).connections : [];
    const row = saved.find(item => item.name === name), state = row?.root ?? await savedLaneState(registry, name);
    if (!state) { deps.stderr(`There is no lane called ${name.slice(0, 40)}. Next: run pots lane list to see the lane names.`); return 1; }
    // A lane that is not on the list (closed, or taken off because the list was full) is put back first; a full list makes room the same way a new lane does.
    const relist = row ? undefined : async () => {
      const added = await registerConnection(registry, name, state);
      deps.stderr(`Lane ${name} was not on the list, so it was put back.` + (added.retiredFinishedLanes ? ` The list was full, so these finished lanes were taken off it: ${added.retiredFinishedLanes.join(', ')}. Their saved sessions were not touched. Bring one back with: pots lane restore <lane-name>` : ''));
    };
    return start(state, true, deps, { restore: true, limits: laneLimits(argv.slice(3)), relist });
  }
  if (command === 'uninstall') {
    const [root,...flags]=argv.slice(1);if(!root||root.startsWith('--')||flags.some(f=>!['--all','--confirm-offline','--purge','--confirm-purge'].includes(f))||new Set(flags).size!==flags.length)usage();
    const result=await uninstall(path.resolve(root),{all:flags.includes('--all'),confirmOffline:flags.includes('--confirm-offline'),purge:flags.includes('--purge'),confirmPurge:flags.includes('--confirm-purge')},deps.uninstallDeps);deps.stdout(JSON.stringify(result,null,2));return ['preview','uninstalled'].includes(result.status)?0:1;
  }
  if (command === 'setup-auto') {
    const options = {}, names = { '--session': 'session', '--root': 'root', '--name': 'name', '--session-dir': 'sessionDir', '--clients': 'clients' };
    const resumeNames = { '--resume-cli': 'cliClients', '--resume-cloud': 'cloudClients', '--handoff-file': 'handoffFile',
      '--claude-executable': 'claudeExecutable', '--codex-executable': 'codexExecutable', '--claude-session': 'claudeSession',
      '--resume-poll-ms': 'pollMs' };
    const args = argv.slice(1);
    for (let i = 0; i < args.length; i++) {
      if (Object.hasOwn(resumeNames, args[i]) || ['--resume-dry-run','--claude-continue'].includes(args[i])) {
        options.coordinatorResume ||= {};
        const key = resumeNames[args[i]] || (args[i] === '--resume-dry-run' ? 'dryRun' : 'claudeContinue');
        if (Object.hasOwn(options.coordinatorResume, key)) throw new Error('invalid automatic setup options');
        if (['dryRun','claudeContinue'].includes(key)) options.coordinatorResume[key] = true;
        else {
          if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid automatic setup options');
          const value = args[++i];
          if (key === 'pollMs' && !/^\d+$/.test(value)) throw new Error('invalid automatic setup options');
          options.coordinatorResume[key] = key === 'pollMs' ? Number(value) : value;
        }
        continue;
      }
      if (['--coordinator-wakeups', '--no-coordinator-wakeups'].includes(args[i])) {
        if (Object.hasOwn(options, 'coordinatorWakeups')) throw new Error('invalid automatic setup options');
        options.coordinatorWakeups = args[i] === '--coordinator-wakeups';
        continue;
      }
      const key = Object.hasOwn(names, args[i]) ? names[args[i]] : undefined;
      if (!key || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid automatic setup options');
      options[key] = args[++i];
    }
    // Off means off: wake-ups switched off together with settings for the watchdog is a contradiction, refused like the two wake-up flags.
    if (options.coordinatorWakeups === false && options.coordinatorResume) throw new Error(OFF_WITH_RESUME);
    deps.stdout(JSON.stringify(await autoSetup(options, deps), null, 2)); return 0;
  }
  if (typeof target !== 'string' || !target) usage();
  const arity = count => { if (rest.length !== count) usage(); };
  switch (command) {
    case 'controller-create':
      arity(0); requireNode();
      await createCredential(path.resolve(target));
      deps.stdout('Controller credential created locally. Keep it private; do not paste it into chats.');
      return 0;
    case 'controller-acquire': {
      arity(1); requireNode();
      deps.stdout(JSON.stringify(await acquireController(await storeFor(target, deps.now), path.resolve(rest[0]))));
      return 0;
    }
    case 'controller-handoff': {
      arity(2); requireNode();
      deps.stdout(JSON.stringify(await handoffController(await storeFor(target, deps.now), path.resolve(rest[0]), path.resolve(rest[1]))));
      return 0;
    }
    case 'connect':
      arity(2); requireNode();
      deps.stdout(JSON.stringify(await registerConnection(target, rest[0], rest[1]), null, 2));
      return 0;
    case 'setup': {
      arity(1); requireNode();
      const report = await setup(target, rest[0], deps);
      deps.stdout(JSON.stringify({ ...report, next: 'node bin/bridge.mjs start "<state-folder>"' }, null, 2));
      return 0;
    }
    case 'start': {
      const confirmed = rest[0] === '--confirm-offline';
      requireNode();
      return start(target, confirmed, deps, { limits: laneLimits(confirmed ? rest.slice(1) : rest) });
    }
    case 'watch-lines': {
      if (!(rest.length === 0 || (rest.length === 1 && rest[0] === '--peek'))) usage();
      requireNode();
      // Prints only the new lines, or nothing at all.
      const { lines, more, unreadable, unsaved } = await readNewWatchLines(await watchRows(target, deps), { peek: rest.length === 1, now: deps.now });
      for (const line of lines) deps.stdout(line);
      for (const lane of unreadable) deps.stdout(`${lane} could not be read.`);
      for (const lane of unsaved) deps.stdout(`${lane} could not save its place, so the lines not shown here will come again next time.`);
      if (more) deps.stdout(rest.length === 1 ? 'Only the first 100 new lines are shown. Run it without --peek to move past them.' : 'More lines are waiting. Run this again.');
      return 0;
    }
    case 'watch-state':
      arity(0); requireNode();
      deps.stdout(JSON.stringify(await readWatchStates(await watchRows(target, deps)), null, 2));
      return 0;
    case 'update':
      return update(target, rest, deps);
    case 'command': {
      if (rest.length < 2) usage();
      const store = await storeFor(target, deps.now), id = rest[0], commandText = rest.slice(1).join(' ');
      deps.stdout(await withController(store, deps.controllerFile, () => store.requestCommand(id, commandText)));
      return 0;
    }
    case 'command-status': {
      arity(1);
      const store = await storeFor(target, deps.now);
      deps.stdout(JSON.stringify(await store.commandReceipt(rest[0]) ?? { id: rest[0], state: 'not_found' }, null, 2));
      return 0;
    }
    case 'command-cancel': {
      arity(1);
      const store = await storeFor(target, deps.now);
      deps.stdout(JSON.stringify(await withController(store, deps.controllerFile, () => store.cancelCommand(rest[0])), null, 2));
      return 0;
    }
    case 'model': {
      arity(1);
      const store = await storeFor(target, deps.now);
      const result = await switchModel(store, rest[0], deps);
      deps.stdout(JSON.stringify(result, null, 2));
      return result.verified ? 0 : 1;
    }
    case 'queue': case 'lane-task': {
      const laneTask = rest.length === 2 && command === 'lane-task', queueModel = rest.length === 3 && rest[1] === '--model';
      if (!(laneTask || queueModel || (rest.length === 1 && command === 'queue'))) usage();
      const store = await storeFor(target, deps.now), prompt = laneTask ? rest[1] : rest[0];
      // One fresh ID, one prompt, 24 hours (the longest a plan may wait), no continuation: finite by construction.
      const enqueue = () => withController(store, deps.controllerFile, () => store.enqueue({ version: 1, id: crypto.randomUUID(), sessionId: store.config.sessionId,
        expiresAt: deps.now() + QUEUE_LIMIT_MS, steps: [{ prompt, continueAfterEnd: false }] })).catch(e => { throw e?.constructor === Error && Object.hasOwn(QUEUE_REFUSED, e.message) ? new Error(QUEUE_REFUSED[e.message]) : e; });
      if (!laneTask && !queueModel) {
        await requireModelProven(store); deps.stdout(await enqueue());
        // Queued, but no running session will take it: say so, with a different exit code (3) from a plain success.
        if (!await laneSessionRunning(store)) { deps.stderr(NOT_RUNNING_WARNING); return 3; }
        return 0;
      }
      // With a model the task is queued only after OMP has proven the switch (retried up to modelTries times);
      // any other outcome queues nothing.
      const started = await startLaneTask({ store, model: laneTask ? rest[0] : rest[2], enqueue, controllerFile: deps.controllerFile,
        tries: deps.modelTries, retryDelayMs: deps.modelRetryMs, modelWaitMs: deps.modelWaitMs, modelPollMs: deps.modelPollMs });
      if (laneTask) {
        if (!started.started) throw new Error(started.model.state === 'invalid' ? 'invalid model id' : 'model switch not verified; task not sent');
        deps.stdout(JSON.stringify({ started: true, model: rest[0], planId: started.planId, proof: started.model }, null, 2));
        return 0;
      }
      deps.stdout(JSON.stringify(started.started ? { queued: true, planId: started.planId, model: started.model }
        : { queued: false, note: 'The model switch was not proven by OMP, so no task was queued.', model: started.model }, null, 2));
      return started.started ? 0 : 1;
    }
    case 'status': {
      arity(0);
      const store = await storeFor(target, deps.now);
      const rows = [];
      const up = await laneSessionRunning(store);
      for (const id of await store.ids()) {
        const receipt = await store.receipt(id);
        if (receipt) { rows.push(receipt); continue; }
        // A cancel is recorded at once, but the task only ends when a running lane reads it: say so instead of a bare queued.
        const note = await store.cancelled(id) ? CANCEL_RECORDED_NOTE : up ? null : NOT_RUNNING_NOTE;
        rows.push({ id, state: 'queued', taskSuccess: 'unverified', ...(note ? { note } : {}) });
      }
      deps.stdout(JSON.stringify(rows, null, 2));
      return 0;
    }
    case 'cancel': case 'abort': {
      arity(1);
      const store = await storeFor(target, deps.now);
      // A mistyped id (no such plan) and a second cancel (already recorded) are said so in plain words; the controller check still comes first.
      const done = await withController(store, deps.controllerFile, () => store.abort(rest[0]).then(() => false, async e => {
        if (e.code === 'ENOENT' || e.message === 'invalid record identity') throw new Error(NO_SUCH_TASK);
        if (e.code === 'EEXIST' && await store.cancelled(rest[0])) return true;
        throw e;
      }));
      if (done) { deps.stdout(ALREADY_CANCELLED); return 0; }
      deps.stdout(CANCEL_NOTE);
      return 0;
    }
    case 'init':
      arity(0);
      await initialize(path.resolve(target));
      deps.stdout('Private state initialized. Verify owner-only ACL before use.');
      return 0;
    case 'enqueue': {
      arity(1);
      const store = new Store(config(await readJson(path.resolve(target))), deps.now);
      await store.ready();
      const input = await readJson(path.resolve(rest[0]));
      deps.stdout(await withController(store, deps.controllerFile, () => store.enqueue(input)));
      if (!await laneSessionRunning(store)) { deps.stderr(NOT_RUNNING_WARNING); return 3; }
      return 0;
    }
    case 'launch-plan': {
      arity(1);
      const configFile = path.resolve(target);
      const settings = config(await readJson(configFile));
      await new Store(settings).ready();
      await plain(settings.cwd, true);
      await validateSavedSession(path.resolve(rest[0]), settings);
      deps.stdout(JSON.stringify({ executable: 'omp', cwd: settings.cwd,
        args: ['--resume', path.resolve(rest[0]), '--extension', EXTENSION],
        environment: { OMP_BRIDGE_CONFIG: configFile }, started: false, requiresOfflineReview: true }, null, 2));
      return 0;
    }
    default: usage();
  }
}

export async function main(argv, overrides = {}) {
  const deps = { ...DEFAULTS, ...overrides };
  try { return await dispatch(argv, deps); }
  catch (error) {
    if (error?.constructor === Error && error.message === INSTALL_STOPPED) return 1;
    const text = diagnostic(error, new Set([...ALLOWED, ...PLAIN])); deps.stderr(argv[0] === 'install' ? shownText(error) : argv[0] === 'uninstall' && text === REVIEW ? reviewText('pots uninstall') : text); return 1;
  }
}
