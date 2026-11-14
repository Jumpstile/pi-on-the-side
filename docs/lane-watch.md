# Lane watcher

The lane watcher tells a coordinating assistant, within seconds and without spending a single token, that a lane:

- **IDLE** finished its turn and has done nothing for N seconds (default 8),
- is **BUSY** again,
- wrote its **RESULT** files (a result file plus its hashes file), or
- is **GONE** because its OMP process ended.

It writes one short line per change to a small log on the PC. It never uses the network and never calls a model.

## What it cannot do

A process on your PC cannot wake an assistant that lives in a chat. The watcher only has the news ready; the assistant sees it when something runs the check. There are two ways:

| Way | Who runs the check | Real worst-case delay |
| --- | --- | --- |
| **Scheduled reminder** (default, every assistant) | The assistant's own scheduler, at the interval the client allows | watcher delay (about 15 s) + the reminder interval + the assistant's own run time |
| **CLI resume** (on by default when Claude Code or Codex is found) | A local helper starts Claude Code or Codex | watcher-independent: its own 2 s check + CLI start time; see [coordinator resume](coordinator-resume.md) |

The reminder interval is set by the client, not by Pi on the Side. Use the shortest repeating interval your Claude client or ChatGPT client lets you schedule. A one-minute floor is common, but the actual minimum of each client and plan was not verified for this release, so check yours. At a one-minute reminder the worst case is therefore a little over one minute and fifteen seconds; at a five-minute reminder it is a little over five minutes. No setting in Pi on the Side can make a chat reminder faster.

No push path into an open Claude or ChatGPT chat is used by the watcher: this release found no documented webhook, hook or notification that a local program may use to speak into an open conversation, and none is invented here (not checked against the vendors' current documentation; there was no network access). The only existing push is the [CLI resume](coordinator-resume.md) (on by default when Claude Code or Codex is found, off with `--no-coordinator-wakeups`), which starts a new visible Claude Code or Codex session. It reacts to the bridge's own attention events (a finished plan, a failed or malformed plan, a lane that went away, a stopped lane: a task was running and no bridge is running it any more because OMP closed or crashed, or its bridge stopped), **not** to the watcher's RESULT lines; see [Open questions](#open-questions).

## How it runs (no extra process)

The watcher runs **inside the launcher window** that Setup creates (`bridge start`, the generated `Start-OMP.ps1`). It is one low-priority timer in that same process:

- it starts when the lane starts, before OMP is launched;
- it stops when OMP exits, then writes the `GONE` and `STOP` lines;
- it adds no console window, no Startup entry, no scheduled task and no second process (the separate wake-up watchdog that reads these lanes has its own scheduled task; see [coordinator resume](coordinator-resume.md));
- its timer is marked so that it can never keep a process alive on its own.

If the watcher cannot start (turned off, bad settings file, unusable folder), the launcher prints one fixed line and starts OMP anyway.

A lane that was started some other way (plain `omp`, another launcher) has no watcher and no lines.

## Where the news comes from

1. **Primary: the bridge's lane events.** The bridge extension inside OMP already writes `control/lane-events.jsonl` on every idle/busy change; it samples OMP every 2 seconds, so an event is recorded up to 2 seconds after the real change (see [protocol](protocol.md)). The watcher reads that file. Only events written after the lane started count.
2. **Fallback: the OMP log.** If the lane-event file stays silent for 30 seconds while OMP runs, the watcher reads the tail of OMP's own log for that process (`omp.<date>.<pid>.log` in OMP's log folder) and looks for the `agent_end maintenance routing` row with route `entered`. The turn counts as ended at that row, and the lane as busy again when a later row is more than 15 seconds newer. This is a heuristic. It is used only until the primary source speaks, and every line says which source it used (`src=events` or `src=omplog`).

Result files and process exit do not depend on either source.

## The log

Per lane, in that lane's private `control` folder (the same folder as `lane-events.jsonl`):

| File | Content |
| --- | --- |
| `lane-watch.log` and `lane-watch.log.1` | Append-only change log, at most 64 KiB each; the older file is replaced when the newer fills up |
| `lane-watch-state.json` | Latest state, replaced atomically |
| `lane-watch-cursor.json` | The last log number already shown to the coordinator |
| `lane-watch.json` | Your optional settings (Setup writes the defaults once and never overwrites your edits) |

### Line format

```
<UTC time with milliseconds> <number> <KIND> [key=value ...]
```

```
2026-11-06T13:05:07.123Z 41 IDLE pid=4242 since=2026-11-06T13:04:57.100Z src=events
2026-11-06T13:05:31.800Z 42 BUSY pid=4242 src=events
2026-11-06T13:07:02.014Z 43 RESULT prefix=REPORT files=2
2026-11-06T13:07:20.511Z 44 GONE pid=4242 reason=exit code=0
```

- The time is when the watcher **noticed** the change. `since=` on IDLE is when the turn ended.
- The number rises by one per line and continues across restarts. A reader can drop everything up to the last number it has seen.
- Keys are 1 to 12 lowercase letters. Values are 1 to 64 characters from `A-Z a-z 0-9 . _ : + -`. There are no spaces, quotes, paths or task text, so a line is safe to paste.
- Lines are never edited; a line is at most 512 characters.

| Kind | Meaning | Fields |
| --- | --- | --- |
| `START` | Watcher started (informational) | `pid` (the launcher), `poll`, `idle` (milliseconds) |
| `IDLE` | Turn ended and the lane stayed quiet for the idle time; written once per idle period. A freshly started lane also reports `IDLE` once OMP is ready and waiting for input | `pid`, `since`, `src` |
| `BUSY` | Busy again after an `IDLE` was reported | `pid`, `src` |
| `RESULT` | A group of result files is complete and has stopped changing | `prefix` (`-` for the bare names; the file-name prefix with unusual characters replaced and cut at 64 characters; it is your own file naming, so treat it as visible metadata), `files` |
| `GONE` | The OMP process ended; always the last event of a run | `pid`, `reason` (`exit`, or `lost`), `code` (exit code, when known) |
| `EXPIRED` | A queued task never started because its time ran out while the lane stayed busy (it is not retried). Tell the person: "A queued task was not started because the lane stayed busy until its time limit ran out. Queue it again when the lane is free." | `plan` (the task id) |
| `ERROR` | The watcher could not read events or scan the result folder; once per episode | `reason` (`read`, `scan`) |
| `STOP` | Watcher stopped (informational) | `pid` |

`reason=lost` means the launcher window was killed without a clean exit. The coordinator-side reader notices the dead watcher and appends that one line itself, exactly once.

A short turn that starts and ends between two checks is reported as `BUSY` then `IDLE`. A turn end followed by new work inside the idle time is never reported at all.

### Result files

A result is a group of file names that share a prefix. With the default names `RESULT.md` and `HASHES.json`, these are all groups: `RESULT.md` + `HASHES.json`, `REPORT-RESULT.md` + `REPORT-HASHES.json`, `POTSWATCH_RESULT.md` + `POTSWATCH_HASHES.json`. A prefix and a name are joined by `-` or `_`; case does not matter. The `RESULT` line appears when **every** configured name exists for the prefix and none changed for 2 seconds. A completed group that is written again is reported again. Groups that already existed when the lane started are the baseline and are not news. When OMP exits, files written just before it are reported straight away, before `GONE`.

The folder scanned is the lane's project folder (top level only), or the folders you list.

### Settings (`lane-watch.json`)

```json
{ "version": 1, "enabled": true, "pollMs": 5000, "idleMs": 8000,
  "resultFiles": ["RESULT.md", "HASHES.json"], "resultFolders": [] }
```

| Key | Default | Allowed |
| --- | --- | --- |
| `enabled` | `true` | `true`/`false` |
| `pollMs` | 5000 | 1000 to 60000 |
| `idleMs` | 8000 | 2000 to 600000 |
| `resultFiles` | `RESULT.md`, `HASHES.json` | 1 to 4 plain file names |
| `resultFolders` | empty (the lane's project folder) | up to 4 absolute folders |

Unknown keys or out-of-range values turn the watcher off for that start (OMP still starts). Changes apply the next time the lane starts.

### Notice delay

Worst case for the idle line, counted from the real end of the turn: up to 2 seconds for the bridge's own sampling, plus `idleMs`, plus one `pollMs`: 15 seconds with the defaults (2 + 8 + 5). Result files need up to `pollMs` plus the 2-second settle time.

Measured on synthetic files (the watcher's own tests, not a real OMP session): with poll 1 s and idle 2 s on a real clock the idle line appeared 2.04 s, 2.05 s, 3.01 s and 3.02 s after the event was written in four runs (the idle time plus where the event fell in the poll cycle; the one-poll ceiling is 3.0 s plus scheduling jitter). With the default poll 5 s and idle 8 s on a simulated clock, events landing 0, 1, 2001 and 4999 ms after a poll were noticed 10.0, 10.0, 13.0 and 10.0 s later; 13.0 s is the worst phase (idle time plus one poll). Add up to 2 s for the bridge's own sampling. A measurement with a real OMP session and a real assistant has not been made.

## The coordinator side

One command, printing only new lines, then nothing:

```powershell
& '<node>' '<install>\runtime\...\bin\bridge.mjs' watch-lines '<connections folder>'
```

The exact command for your PC is in the `setup-auto` result (JSON) as `laneWatch.coordinatorCommand`; `pots install` does not print it. It looks like `& '<node>' '<install folder>\runtime\current\bridge.mjs' watch-lines '<install folder>\connections'`, and accepts a connections folder (all lanes) or one saved-state folder. Output is only the new lines, as `<connection name> <log line>`, oldest first, at most 100 per call; if more can be fetched, at most 100 lines are printed, in log order (a lane whose place could not be saved keeps its lines for the next call), then the line `More lines are waiting. Run this again.`, and the rest follow on the next call, so nothing is skipped. `START` and `STOP` are never printed. Each call marks what it printed as shown; `--peek` prints without marking (and ends with `Only the first 100 new lines are shown. Run it without --peek to move past them.` when there are more). Nothing new prints nothing, so a scheduled check costs almost no tokens. A lane that cannot be read this time is named on a line of its own: `<lane> could not be read.` when its log cannot be opened, or `<lane> could not save its place, so the lines not shown here will come again next time.` when its place cannot be saved; the other lanes are still shown, and the named lane's lines that were not shown come on a later call, none skipped and none shown twice.

`watch-state <folder>` prints each lane's latest state as JSON (`not_seen_yet`, `busy`, `ending`, `idle`, `gone`, or `none` when no watcher ever ran; a state file an older version wrote as `unknown` reads as `not_seen_yet`).

For assistants that use the local MCP adapter there is the matching tool `bridge_lane_watch_lines` (no arguments; every registered lane). It returns `{"lines":[...]}`, at most 100 lines per call; an empty list means stop. When more lines can be fetched it also returns `"more": true`: call it again right away until `more` is gone, because a later `GONE`, `RESULT` or `ERROR` line may be in the next batch. A lane named in `unreadable` never keeps `more` on, because calling again cannot help it. When a lane cannot be read this time it also returns `unreadable`, a list of `{"lane":...,"problem":...}`; the problem says either that the lane's log could not be read, or that its place could not be saved so the lines not shown here were held back and will come again. The other lanes' lines are still in `lines`, and the named lane's lines that were not shown come on a later call. It marks lines as shown, so it is not marked read-only, and your client may ask for approval the first time. Allow it, so the reminder can run unattended. The adapter is local stdio only: it does not make a cloud scheduled task reach this PC. A scheduled prompt can use the tool or the command only in a client that actually keeps that local route (a client session with the local connection open, or a local command-line assistant); otherwise it cannot call either.

One cursor per lane is shared by every reader. If two assistants consume the lines, each sees only part of them; give the lines to one coordinator and let others use `--peek` or `watch-state`.

### Reminder text

Short and mechanical, so the cheap model run does nothing when nothing happened:

> Pi on the Side check: call `bridge_lane_watch_lines`. No lines: say nothing and stop. Lines: follow the coordinator protocol.

If the assistant can run local commands, replace the tool name with the command above. When there are IDLE, RESULT, GONE or EXPIRED lines it then calls `bridge_lanes_status` and continues the normal [wake-up protocol](coordinator-wakeups.md). BUSY lines are informational. An EXPIRED line means a queued task was not started because its time ran out: tell the user and say it has to be queued again. An ERROR line means the watcher could not read its files: it is not a result, so check that lane locally.

Setup writes this guidance into the generated coordinator instruction files, with per-client wording.

### Claude

Schedule the shortest repeating reminder or scheduled task your Claude client offers, using the reminder text above. A client with local command access can run `watch-lines`; Claude Desktop uses the MCP tool. Whether a given Claude client offers a repeating schedule, and its shortest interval, depends on the client and plan and was not verified for this release.

### ChatGPT

ChatGPT reaches this PC only through the local desktop (STDIO) connection described in [coordinator wake-ups](coordinator-wakeups.md#local-and-remote-limits). A ChatGPT task that runs in the cloud cannot call `bridge_lane_watch_lines` and cannot reach this PC. Use the reminder only in a session that has the local connection open. Otherwise the CLI resume is the only route that does not depend on a chat.

## Installing and removing

- **Setup** adds the watcher automatically as a normal step: the runtime copy contains it, and Setup writes `lane-watch.json` once (kept if you edited it). No question is asked and no Startup entry is created. The `setup-auto` result (JSON) lists the watcher, its settings and the coordinator command; `pots install` does not print them.
- **Prerequisites**: Node 22 or newer and OMP (any version, as for the rest of Pi on the Side), and starting lanes with the generated launcher.
- **Older installs**: the runtime file list changed (see the [changelog](../CHANGELOG.md)), and an update run by an older version (v0.2.11 or earlier) cannot apply a bundle with a changed list by itself. Run `pots install` from the new release instead: it upgrades in place in one step and the install then contains the watcher. See [updates](update.md#upgrading-with-setup).
- **Uninstall** removes the watcher with the rest of the install: the runtime copy and the five `lane-watch*` data files per lane are recognised as owned and removed (or moved to the recovery folder) like the lane events. Nothing outside the install folder is touched.
- **Turn off** per lane: set `"enabled": false`. The launcher prints that the watcher is off.

## Limits

- The watcher sees lanes started through the launcher only, and only while the launcher window runs.
- `reason=lost` detection depends on the launcher's process number; a recycled number can hide a killed launcher until the next start.
- The OMP-log fallback is a heuristic: a new turn within 15 seconds of the previous turn end can look idle.
- Detection is local and per PC. It says nothing about the provider, quota, approvals or whether the task succeeded.

## Open questions

- Should the CLI resume also start on `RESULT` and `IDLE` lines? Today it reacts to the bridge's attention events only, so a lane that writes result files without a bridge plan does not trigger it. Changing that touches the launch safety rules (cooldowns, caps, event ledger) and was left alone.
- Real end-to-end timing with a live OMP lane and a live assistant has not been measured.
