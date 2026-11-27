<p align="center"><img src="https://raw.githubusercontent.com/Jumpstile/pi-on-the-side/main/assets/pots-logo-256.png" width="128" alt="Pi on the Side logo"></p>

# Pi on the Side!

Pi on the Side! lets your AI assistant (Claude or ChatGPT) send work to the Oh My Pi (OMP) sessions on your Windows PC, check on it, and tell you when it is finished.

Technical name: `omp-session-bridge`. Existing commands, configuration and connection names stay the same. [Changelog](CHANGELOG.md).

## What it does

- **One line installs everything.** Paste it in PowerShell. Every OMP session you have saved is connected, your assistants are connected and wake-ups are set up. There is nothing to pick and nothing to answer.
- **Your assistant does the sending, you stay in charge.** You approve a task and the assistant hands it to one project's OMP session, then checks on it. Only one assistant can send or cancel work; any other can only look. `/bridge disable` pauses new work and `/bridge enable` resumes it.
- **Every project stays separate.** Each has its own queue, plans and results.
- **You are told when work finishes.** A built-in watcher notices within seconds, and a scheduled wake-up starts Claude Code or Codex for you. Waiting costs no network and no model. See [lane watcher](docs/lane-watch.md) and [waking an assistant](#waking-an-assistant-when-a-lane-finishes).
- **Honest results.** A receipt says what happened, not whether the work was good. Check OMP's output and the project itself.
- **Cancel safely.** Cancel work before OMP accepts it. Use OMP's own controls to stop work it already accepted.
- **Keep the lane list tidy.** `pots lane list` shows every lane, `pots lane close --finished` clears the finished ones, and `pots lane restore <name>` brings one back. When the list is full, finished lanes make room by themselves.
- **Upgrade with one word:** `pots upgrade`. An open OMP session or a running plan never blocks it, and a failed upgrade puts the old version back.
- **Remove it cleanly.** Your projects and OMP sessions are never touched.

## Quick start

1. Paste the one-line install from [Install](#install) into PowerShell.
2. Open your project with its `Start-OMP.ps1` and type `START` once.
3. Ask your assistant for the project's status, then approve one small task.

If something is unclear, run `pots doctor`: it names anything that is not working and the next step.

Pi on the Side is designed to work across OMP versions. Compatibility problems are bugs to fix; not every past or future release has been tested. Provider quotas and OMP permissions still apply. This package does not provide a separate ChatGPT/Dottie cloud connection. See [client setup](docs/client-setup.md) and [limits](docs/windows-setup.md#verification-and-limits).

## Install

```powershell
gh release download (gh api --hostname github.com 'repos/Jumpstile/pi-on-the-side/releases?per_page=1' --jq '.[0].tag_name') -R github.com/Jumpstile/pi-on-the-side -p install.ps1 -O - | iex
```

It finds the newest release (the same one `pots upgrade` uses), checks its sha256, installs it and sets up everything the product needs: your saved sessions, Claude Code, Claude Desktop and Codex connections, the scheduled wake-up watchdog and the `pots` command. It prints one result: what happened, then a real next step or "Nothing else to do." When wake-ups are on, it also runs a wake-up self-test and adds its PASS or FAIL. You need Node.js 22+, OMP and the GitHub CLI (`gh`), logged in; the line downloads none of them.

After the install, `pots` is a real command: `pots install`, `pots upgrade`, `pots doctor` (checks that your assistant is woken when a lane finishes), `pots status` (`--details` for more), `pots lane list` (shows every lane as running or finished, and the lanes you can bring back), `pots lane restore <name>` (continues a lane that a restart or crash stopped, or puts a closed lane back and continues it), `pots lane close <name>` (takes a lane that is not running off the list to free a place), `pots lane close --finished` (takes every finished lane off the list at once), `pots instructions` (the text to paste into ChatGPT), `pots --version`, `pots uninstall`. Type `pots` alone to see the list.

To let your assistant work in a project, open that project with its `Start-OMP.ps1` (in the install folder under `launchers\<name>`, listed by `pots install --details`) and type `START` once. The script asks because a second OMP copy on the same saved session can mix up the work. Starting OMP through that launcher is what lets the assistant send work to that session.

See [Start here](docs/release-quickstart.md), [other local clients](docs/client-setup.md), [coordinator wake-ups](docs/coordinator-wakeups.md), [lane watcher](docs/lane-watch.md), [coordinator resume](docs/coordinator-resume.md) and [troubleshooting](docs/windows-setup.md).

## One bridge for every session

- **`pots install` connects every saved session it finds**, newest first, at most 64 at once. Projects connected earlier keep their places. If more are saved than fit, `pots install --details` says how many were left out, and `pots status` says that 64 is the limit. Connecting one more session by name (for example `setup-auto --session`) when 64 are listed takes finished lanes off the list by itself; see [when the lane list is full](docs/operations.md#when-the-lane-list-is-full).
- **Later sessions connect themselves.** The assistant adapter looks for newly saved sessions at most every 30 seconds and connects them, but only when it holds the controller credential and runs from the full install (the small Claude Desktop extension package has no installer code and never does this; run `pots install` again to connect a new session there). A read-only adapter (no credential) never connects anything by itself.
- **Each project stays separate.** It has its own queue, plans, receipts and controller record under `sessions\<id>`, and its own launcher folder under `launchers\<name>` with `Start-OMP.ps1`. Changes you make to a `Start-OMP.ps1` are not kept: when its folder is complete, the next `pots install` puts Setup's version back and keeps your copy in `backups`; a lone edited script is never touched, and the install stops and names it.
- **One fixed program path:** `<install folder>\runtime\current\bridge.mjs` runs the current version, whatever it is. Scripts may call it forever.
- **Nothing you own is replaced.** `pots install` never overwrites or deletes a file it did not make.

## Upgrading

```powershell
pots upgrade
```

It says one of:

- `Upgraded to X.`
- `Upgraded to X. A session is open, so the new version starts with the next session.`

The upgrade is never refused because OMP is open. A running session keeps the files it already loaded (version folders are never edited) and the next start uses the new version. The download is checked against GitHub's published sha256, the new version must start before the pointer moves, the old version is kept as the way back, and if a step fails the old version is put back (if that cannot be done, the upgrade says so and names the one step that fixes it). Then the new version finishes its own setup, so nothing is left to do by hand: assistant connections, the scheduled task and the watchdog are replaced with the new ones (never duplicated), and the wake-up self-test result is printed as the last line. Folders named `runtime\managed-...` from 0.2.20 and earlier are kept as they are; the first run copies each of their pointers into the install's `backups` folder.

## Details

### Requirements

- Windows (the tested platform), Node.js 22+, no npm dependencies.
- OMP must be reachable as a real `omp.exe` in an absolute `PATH` entry during setup (relative entries and `.cmd`/`.ps1` shims are ignored); a repeat `pots install` also accepts the OMP the install already uses, so an OMP the install already recorded works without PATH. Setup and Start check the executable's version response and required capabilities. If OMP is not on `PATH`, prepend its folder for the current PowerShell window only, for example `$env:Path = "C:\path\to\omp-folder;$env:Path"`; no persistent PATH change is needed.
- A saved OMP session file (`.jsonl`) whose project folder you control. Log in to your provider through OMP's normal workflow; the bridge reports provider login and quota as **not verified**.
- For automatic wake-ups: Claude Code or Codex (the command-line program) on your `PATH`, and Windows Task Scheduler (part of Windows). Without them everything else works, and `pots doctor` says plainly that wake-ups cannot run.

### What `pots install` writes

`node bin/bridge.mjs setup-auto` is what `pots install` runs (`pots install` uses the defaults): it copies an allowlisted runtime, makes the private controller credential, connects every saved session, connects the assistants and sets up the wake-up watchdog. It uses owner-only permissions, never steals an existing controller and never starts OMP. Repeating it replaces no key, binding or receipt; unsafe or ambiguous existing state refuses reuse. Options for the command line: `--session <saved-file>` (connect only that one), `--root`, `--name` (with `--session`), `--session-dir`, `--clients claude|chatgpt|both` (default both), `--no-coordinator-wakeups` (off) or `--coordinator-wakeups` (on again; not both, and the off flag cannot be combined with the resume options), and the wake-up options in [coordinator resume](docs/coordinator-resume.md).

The install folder holds `runtime\current` (launcher and `current.json` pointer, with `versions\<version>` folders), `credentials\controller.json`, `connections` (the list of connected sessions), `sessions\<id>` (one project's private state), `launchers\<name>` and `backups`.

### Assistants

Setup connects what it finds, with no question:

- **Claude Code:** registers the `omp-session-bridge` tool server through Claude Code's own `claude mcp add --scope user` and writes the `pi-on-the-side` Claude skill under your Claude folder.
- **ChatGPT desktop app / Codex:** adds one marked `omp-session-bridge` block to `.codex\config.toml` in your home folder, with write approval set to writes; the rest of the file is kept byte for byte.
- **Claude Desktop:** adds one `omp-session-bridge` entry to `claude_desktop_config.json` in its `Claude` folder under `%APPDATA%`; every other setting in that file is kept.
- **Directing assistant:** exactly one (Claude Code first, then ChatGPT / Codex, then Claude Desktop) gets the private write-access file; any other is a read-only viewer. The one exception: if Claude Code is installed but its settings file cannot be read, Setup cannot tell who holds the write access, so it leaves the other assistants exactly as they are (nobody new is given it) and the install result says so. Fix Claude Code, then run `pots install` again.
- **Never overwritten:** a same-named entry Setup did not create, an unreadable file or a damaged marker is reported with the single fix instead.

The one thing no program can do for you: ChatGPT keeps custom instructions in your account settings, so `pots instructions` prints the text and you paste it once into Settings > Personalization > Custom instructions. The Claude and Codex registration locations were not tried against a real Claude or Codex install.

The ChatGPT setup is a local desktop STDIO connection only. It does not establish ChatGPT web/cloud reachability or a route from a remote scheduled task to this PC.

Claude Desktop is connected through its own settings file, `claude_desktop_config.json`, the place Claude Desktop documents for local tool servers. Claude Desktop reads that file only when it starts, so the connection shows up the next time you open it. Setup never closes it for you. The `omp-session-bridge-<version>.mcpb` package attached to each release is an alternative for people who prefer Claude Desktop's Extensions screen; do not use both at once, because the tools would appear twice. If Claude Code or the ChatGPT app / Codex is connected it directs and Claude Desktop only reads; if Claude Desktop is your only assistant it directs. Keep write tools set to Needs approval; annotations do not enforce approval, and installed-host behavior must be checked. [Desktop setup and limits](docs/desktop.md).

### Waking an assistant when a lane finishes

No program can type into a chat that is already open. So a plain `pots install` or `pots upgrade` sets up the closest thing that needs no action from you:

- **A scheduled task** (Windows Task Scheduler, named after the install, no window) starts at log-in and every 5 minutes after, and never runs twice at once. It keeps a small watchdog running, so a closed or crashed watchdog is back within 5 minutes and after a restart.
- **The watchdog** looks at your lanes every 2 seconds. When a lane has finished (or stopped, or failed) and no assistant has been active for 3 minutes, it starts Claude Code or Codex once for that event, with a handoff file to read. Limits: at most 6 starts an hour, 3 per lane, never twice for the same event.
- **The handoff file** `coordinator-resume\handoff.md` in the install folder is created for you; the started assistant keeps it current. You can write the goal in it.
- **`pots doctor`** checks every part in plain words (switch, program found, handoff, scheduled task, watchdog alive, last start) and then runs a **self-test**: a throwaway lane that does nothing goes idle, and the real watcher, status and wake-up decision are timed (limit 15 seconds, longer when the lane's own wait needs it). `pots install` and `pots upgrade` run the same self-test at the end when wake-ups are on (not with `--no-coordinator-wakeups`, with no Claude Code or Codex, or after Disable-Resume) and print PASS or FAIL with the measured seconds; after a FAIL the command exits with code 1 and says why. `pots status` shows one line. Anything that fails is also written to `pots.log` in the install folder.
- **What it cannot prove:** that Claude Code or Codex actually opens, because that only happens for a real lane. The test starts no program.
- **Prerequisite:** Claude Code or Codex (the command-line programs) installed. Without one, nothing can be started and `pots doctor` says so. `pots install --no-coordinator-wakeups` turns all of it off (it removes the scheduled task, or leaves it and says so when old wake-up files cannot be checked as Setup's own; it forgets the saved wake-up settings such as which handoff file to read, the check interval or the cloud task choice, but the handoff file itself stays; it keeps everything else, skips the self-test, and `pots status` then says wake-ups are off by your choice); `pots install --coordinator-wakeups` turns it on again. `Disable-Resume.cmd` in `coordinator-resume` pauses it; `pots install` then says wake-ups are switched off by that file and runs no self-test.
- **Chats cannot be woken:** a Claude Desktop or ChatGPT chat only checks lanes when you or its own scheduler say so. The started command-line assistant is a new session, not that chat. See [coordinator wake-ups](docs/coordinator-wakeups.md).

Every mutation and receipt read must name its project: `connection:"<name>"`. Status without arguments lists every connected name and its queue observations. There is no default and no broadcast. Names start with a lowercase letter and contain lowercase letters, digits or hyphens (32 characters maximum). The list is read fresh on every call, so a newly connected session needs no adapter restart; a changed session binding is refused rather than silently adopted. [Named connections](docs/desktop.md#named-connections).

### Manual setup (optional)

Use Node 22+ and a recognizable OMP executable. `setup` binds one saved session and project; `start` checks the required runtime capabilities and exact session identity before launching. Use a new private state folder outside the project and checkout.

```powershell
node bin/bridge.mjs setup "C:\Private Sessions\example.jsonl" "C:\Private Bridge\example-state"
node bin/bridge.mjs start "C:\Private Bridge\example-state"
```

The second command previews the saved binding. After confirming no other OMP instance owns that exact session, launch it with the same command plus `--confirm-offline` (the flag that says you are sure, also used by `start` in each launcher):

```powershell
node bin/bridge.mjs start "C:\Private Bridge\example-state" --confirm-offline
```

This opens your normal OMP session with the bridge in process; no second supervisor terminal is needed. Automatic extension discovery is disabled for this isolated launch. Your provider/model and native tool permissions stay unchanged. To add it to a connections folder by hand: `node bin/bridge.mjs connect "C:\Private Bridge\connections" alpha "C:\Private Bridge\example-state"`.

Inside that OMP session:

```text
/bridge status
/bridge disable
/bridge enable
```

The bridge starts quietly on a verified bound launch and polls its local queue in the background of OMP. Only commands and actionable failures produce notices. Enable/disable are local to this OMP process: disable stops new dispatch and releases its owned lock; it does not cancel plans or interrupt native work already admitted. An in-flight bridge receipt becomes failed. Enable requires that native work is idle and rechecks the saved binding and lock. A later bound OMP launch enables again; disable is not a persistent account preference.

Status shows the bound session and local lock ownership; it does not prove a desktop client is connected or that provider auth/quota is available. Exit OMP normally to stop its bridge. OMP itself has no OS service or autostart and is not reachable after it exits. The separate coordinator watchdog (set up by `pots install` when Claude Code or Codex is found) starts only the configured assistant CLI, never OMP. Manual setup does not verify Windows ACLs; restrict private state to your account. Automatic Windows setup applies and verifies current-user-only permissions.

### Controller and local commands

A second terminal remains optional for local queue/status/cancel commands. Before writing, explicitly establish controller ownership once and select its credential for this terminal:

```powershell
node bin/bridge.mjs controller-create "C:\Private Bridge\example-controller.json"
node bin/bridge.mjs controller-acquire "C:\Private Bridge\example-state" "C:\Private Bridge\example-controller.json"
$env:OMP_BRIDGE_CONTROLLER = "C:\Private Bridge\example-controller.json"
```

Each directing assistant uses a different credential. Explicit local handoff changes ownership without changing the OMP session, history, provider/model or existing plan IDs. Competing writes are refused; read-only status stays shared. No timeout takes ownership, and a crashed writer requires offline review. This coordinates trusted same-user clients rather than defending against a malicious Windows-account process. [Details and crash recovery](docs/controllers.md).

Then use:

```powershell
node bin/bridge.mjs queue "C:\Private Bridge\example-state" "Inspect the synthetic fixture and report findings."
node bin/bridge.mjs status "C:\Private Bridge\example-state"
node bin/bridge.mjs cancel "C:\Private Bridge\example-state" <plan-id>
```

`queued` means no execution receipt exists yet; `submitted` means OMP's API returned; `completed` means the planned step ended. None proves success: `taskSuccess` stays `unverified`. Queue creates one prompt with a 24-hour expiry (the wait counts) and no automatic continuation. Cancel affects future steps only; use native OMP controls to interrupt running work.

To run a task on a specific model, add `--model <name>`: `node bin/bridge.mjs queue "<state-folder>" "<task>" --model <name>`. The name is confirmed live by OMP itself (nothing is hard-coded here) and the task is queued only after OMP reports that model running; an unknown or ambiguous name, or an unproven switch, queues nothing and says why. `bridge.mjs model "<state-folder>" <name>` does the switch alone, `bridge.mjs lane-task "<state-folder>" <name> "<task>"` is the same check with a plain error, and the MCP tool `bridge_enqueue` accepts an optional `model` field with the same check. See [controllers](docs/controllers.md#switching-a-lanes-model).

### Plans that did not complete

Every plan ends in a definite state with a plain reason: `completed` (every step ran to its end), `failed` (for example `end_not_matched_to_message` or `message_not_confirmed_in_transcript`), `malformed`, `aborted` or `expired`. A plan that did not complete is never retried and holds queued plans for only about 5 seconds. Inspect the session in OMP and queue new work with a new prompt. A step in flight when OMP stops is marked failed (reason `restart`), at shutdown or at the next start. After a crash the lock stays and `start` refuses; follow [offline recovery](docs/operations.md#plans-that-did-not-complete-and-recovery). Never delete a lock or resend just because a receipt is missing.

Plans hold at most 8 prompts of 6,000 characters and expire within 24 hours; `queue` always makes a one-prompt plan that is valid for 24 hours (the wait behind a long task counts). At most 128 plans are kept: when the queue is full, the oldest plan of a task that already ended is retired (its receipt stays), and 128 unfinished tasks refuse new ones until some finish or are cancelled. At-most-one submission per step relies on the documented lock/journal assumptions; exactly-once delivery is not guaranteed.

What the lists show: `pots status` and `bridge_lanes_status` read only the plans that are still kept, never the receipts folder (that one only grows), so they stay short. Once a finished task's plan is retired, its row is gone from them, and so is the "a queued task was not started, queue it again" line for a task that ran out of time. `bridge_receipt` with the task's id always answers and shows how it ended; the `EXPIRED` line appears once, but only while a lane started through the launcher is being watched. `bridge_cancel` says the task already ended, and queueing the same id again is refused.

### Assistant adapter

A local stdio MCP adapter with seven tools (status, enqueue, receipt, cancel-future, `bridge_lanes_status`, `bridge_lane_watch_lines`, and `bridge_coordinator_heartbeat`) is configured by Setup for Claude Code and the ChatGPT desktop app / Codex, and can be packaged privately for Claude Desktop. See [desktop adapter](docs/desktop.md). Remote Desktop Commander is an optional remote-assistant tool only; this local bridge does not need it.

### Updates and removal

`node bin/bridge.mjs update check` reports whether a newer release of this repository exists, using your existing GitHub CLI login. Managed updates (`pots upgrade`) and the one-line install use the newest published release; drafts are always excluded. The manual `update check` command looks at full releases only unless `--prerelease` is supplied. Every download is checked against its sha256 digest. Apply and rollback never refuse because OMP is open or a plan is running; they keep a backup, take a lock so two cannot run at once, and put the old pointer back if a step fails (if that fails too, the lock is kept and the status says how to recover). This checkout is never changed. See [updates](docs/update.md).

Windows removal (Settings > Apps > Installed apps > Pi on the Side!) moves files for recovery by default; permanent deletion needs a separate confirmation. [Operations](docs/operations.md#uninstall).

### Checks

`npm test` runs offline fixtures (no OMP, provider or network). On Node 22 use `node --experimental-strip-types --test` and check that adapter tests do not skip; Node 22.23.3 does not support `--test-isolation=none`, which can help on the tested Node 26 runtime. CLI, MCP and packaging tests need local child processes. `npm run check` checks JavaScript syntax. Errors print fixed diagnostics, never private input.

[Operations](docs/operations.md) | [Updates](docs/update.md) | [Advanced config commands](docs/advanced.md) | [Desktop adapter](docs/desktop.md) | [Protocol/API](docs/protocol.md) | [Security](SECURITY.md) | [Adapters](docs/adapters.md) | [Tester checklist](docs/tester-checklist.md) | [License](LICENSE) | [Contributing](CONTRIBUTING.md) | [Notice](NOTICE.md)

Released under the [MIT License](LICENSE). The package is marked private in its metadata only to prevent an accidental npm publication.
