# Pi on the Side! - install reference

Pi on the Side! lets your AI assistant control multiple OMP sessions through a reliable local connection. It is designed to work across OMP versions; compatibility problems are bugs to fix. Not every past or future release has been tested.

The short guide is [Start here](release-quickstart.md). Everything here is done with the one-line install and the `pots` commands: `pots install`, `pots upgrade`, `pots doctor`, `pots status`, `pots lane list`, `pots lane close`, `pots lane restore`, `pots instructions`, `pots --version` and `pots uninstall`. Windows security and organization policy remain in force; nothing here bypasses script policy, SmartScreen or administrator controls.

## What it can do

- Install and upgrade with one command (`pots install`, or the install line the first time) and connect every saved OMP session it finds, with no questions.
- Connect Claude Code, Claude Desktop and the ChatGPT desktop app / Codex by itself, with coordinator wake-ups on; with approval your assistant sends one task, checks progress, and reads what the bridge recorded.
- Wake an assistant when a lane finishes: a scheduled watchdog starts Claude Code or Codex by itself; no program can push a message into an open chat or create an external connector.
- Cancel future work before OMP accepts it, pause or resume new bridge dispatch, and review uncertain outcomes without automatic replay.
- Upgrade an existing install in place with `pots upgrade` (an open OMP session or a running plan never blocks it), apply verified managed updates with rollback, or remove the Windows app recoverably; permanent deletion needs a separate confirmation.

## What the install changes

- It needs Node.js 22 or newer and OMP already installed. It downloads neither: if one is missing it says which to install. An OMP that is not on `PATH` is still found when an earlier install already recorded it.
- The managed install records its own per-user **Apps > Installed apps** entry in HKCU; it does not add machine-wide registry settings, PATH entries, services, firewall rules or provider accounts. Windows lists the app there as "Pi on the Side!" with the Pi on the Side logo, and there is only one entry; upgrading keeps it that way. The logo is the file `pots.ico` inside the install folder, so uninstalling removes it with everything else.
- Any recognized existing OMP installation is kept as it is, whatever its version; it is never replaced or downgraded. Required bridge capabilities are checked when loaded.

`pots install` finds every saved OMP session (newest first, at most 64 at once), creates a private bridge setup for each and preserves existing keys, bindings and receipts. It also upgrades an older install by itself: the one sentence it prints says what was done ("Upgraded to X." or "Upgraded to X. A session is open, so the new version starts with the next session."). Changed records or another assistant's write access are refused. It never starts OMP. Starting a project is its own step: that project's `Start-OMP.ps1` asks you to type START once, because a second OMP copy on the same saved session can mix up work, and then repeats the host, session and lock checks. It never restarts a running session.

A first-time user with no saved session sees "no eligible saved OMP sessions; create a saved session in OMP first". Open OMP in your project folder with OMP's own prompts, send a first message (any message you send can use provider quota), close OMP, and run `pots install` again. The install itself never submits a model prompt.

It never picks or changes a model on its own. If an OMP model role has no model chosen, the result says so and you choose one in OMP's own settings. When a lane's model is switched later (`bridge.mjs model` or `queue --model`, see [controllers](controllers.md#switching-a-lanes-model)), the name is confirmed live by OMP itself and the switch is accepted only when OMP reports the requested model running; Pi on the Side keeps no model list that an update would need to refresh.

It connects the coordinator clients it finds, by itself (code in `src/clients.mjs`). Without options it connects both Claude and ChatGPT; the `setup-auto --clients` option on the command line can limit that:

- **Claude Code:** when `claude.exe` is found on PATH, it registers the MCP server `omp-session-bridge` through Claude Code's own `claude mcp add --scope user` (and `claude mcp remove` to replace an older entry of ours). When Claude Code is present it also writes the coordinator instructions as the Claude skill `<home>\.claude\skills\pi-on-the-side\SKILL.md`.
- **ChatGPT desktop app / Codex:** when `<home>\.codex` or `codex` is present, it adds one marked block `[mcp_servers.omp-session-bridge]` (command, args, environment, `default_tools_approval_mode = "writes"`) to `<home>\.codex\config.toml`. The rest of the file is kept byte for byte.
- **Directing assistant:** exactly one assistant (Claude Code first, then ChatGPT / Codex, then Claude Desktop) receives the private write-access file path (`OMP_BRIDGE_CONTROLLER`); any other is a read-only viewer.
- **Never overwritten:** a same-named entry it did not create, an unreadable file or a damaged marker is reported with the single fix instead of being changed.
- **Backups:** copies of what was replaced are in `<install folder>\backups\<timestamp>\`: only files the installer itself wrote (the old pointer, old launcher files, old coordinator text, and the installer's own previous part of an assistant setting). A copy of an assistant app's whole settings file is never made.
- **Claude Desktop:** when the `Claude` folder exists under `%APPDATA%`, it adds one `omp-session-bridge` entry to `claude_desktop_config.json` there (the file Claude Desktop documents for local tool servers) and keeps every other setting in the file. Claude Desktop only reads it when it starts.

What no program can do is reported in the result of `pots install` and in `pots install --details`, with the exact next step:

- **ChatGPT custom instructions** are an account setting. `pots instructions` prints the text and says which file holds it; paste it once under ChatGPT Settings > Personalization > Custom instructions.
- For an app that was not installed when `pots install` ran, install it and run `pots install` again.
- **Claude Desktop** loads its connections only when it starts; the install never closes a chat app, so open it again yourself once.

### Wake-ups: set up by the install, checked by `pots doctor`

No program can type into a chat that is already open. So the install sets up the closest thing that needs nothing from you (see [coordinator resume](coordinator-resume.md)): a Windows scheduled task (named after the install, no window, no administrator) keeps a small watchdog running; when a lane has finished and no assistant has been active for 3 minutes, the watchdog starts Claude Code or Codex once for that event, with a handoff file (`coordinator-resume\handoff.md`, made for you). It is on by default when Claude Code or Codex is found on `PATH` and off with `setup-auto --no-coordinator-wakeups`. `pots upgrade` replaces the task and restarts the watchdog on the new version; `pots uninstall` deletes the task.

`pots doctor` checks each part in plain words and runs a self-test with a throwaway lane (a PASS or FAIL with the measured seconds; the install and `pots upgrade` run it at the end when wake-ups are on). `pots status` shows one line. Every failure is also in `pots.log` in the install folder. The self-test cannot prove that Claude Code or Codex actually opens; that only happens for a real lane. The lane watcher is part of the install. A Claude Desktop or ChatGPT chat is not woken: the started assistant is a new command-line session. See [coordinator wake-ups](coordinator-wakeups.md).

Limits: the registration locations (`.codex\config.toml` and the Claude skills folder) are not stated in this repository's earlier documentation and were not tried against a real Claude or Codex install.

## Troubleshooting

- **Existing OMP:** a recognized existing OMP is kept as it is, whatever its version; there is no OMP update and it is never replaced or downgraded. If the executable's version response cannot be verified, the install stops without changing the existing installation. Required bridge capabilities are checked when loaded; existing models, accounts, settings, executables and global PATH are preserved. Finish live work before changing which binary resumes that session.
- **OMP not found:** install OMP so that `omp.exe` is in a folder on your `PATH`, then run `pots install` again.
- **Sessions saved later:** the assistant adapter connects them by itself, at most every 30 seconds, when it holds the controller credential and runs from the full install (not the small Claude Desktop extension, which never does). A read-only adapter (no credential) never connects anything by itself. At most 64 sessions are connected at once.
- **Installed versus connected:** installing a package does not load it into a running session. A session is connected to your assistant only while it runs through its launcher. Ask your assistant for the bridge status; an empty queue is not connection proof. Finish or safely stop an unbridged session before using its launcher; plugin reload does not attach the bridge.
- **Automatic bridge updates and upgrades:** all projects share one managed install at `<install folder>\runtime\current`, run through the fixed path `runtime\current\bridge.mjs`. On a start you confirmed, a launcher checks published stable releases and prereleases using an existing authorized GitHub CLI login. Missing login/CLI or failed validation keeps the current version. Successful activation exits before launching OMP; start again to load the new version. MCP clients using that launcher load the new adapter when that client restarts its server. Claude Desktop's installed extension is replaced by opening the new `.mcpb` file again. Older installs, including the per-session `runtime\managed-<id>` folders of 0.2.20 and earlier, are upgraded by `pots install` (see below); those older folders are left untouched.
- **Download/checksum error:** nothing from the failing download is executed. Check connectivity; do not substitute a mirror or unchecked binary.
- **No saved sessions:** the install says so. Open OMP in your project folder with OMP's own prompts, finish its normal login and first session, close it, and run `pots install` again.
- **Session already running:** close only that exact session when safe, then retry. Never start a duplicate to work around an error.
- **Controller/permission/record/lock refusal:** preserve state and use [controller](controllers.md) / [recovery](operations.md) instructions. The install does not seize ownership or discard receipts.
- **Claude Desktop missing tools:** Claude Desktop reads its connections only when it starts, so close it completely and open it again once after `pots install`. The install never restarts it. If the tools are still missing, run `pots status`: it lists Claude Desktop under the assistants that are set up.
- **Different directing assistant:** stop the old director's writes and perform [explicit handoff](controllers.md). Do not share one key among advisors.

## Verification and limits

- Installed-host evidence from v0.2.9, source commit `72846ef5eeadbb59abdfaabbfd0f2a8aa023cb9e`. A separate fresh disposable OMP lifecycle check observed the published bridge's matching session identity, supervisor lock, active timer and completed poll with no pending messages or supervisor error. It used no model/provider task and changed no owner session. Exact tested OMP builds and limits are in the [verification record](verification.md); these checks do not establish model-driven behavior or compatibility with every release.
- Model-driven flows remain unverified. See [verification](verification.md) and [collaborator acceptance](collaborator-check.md).

The seven tools, including `bridge_lanes_status`, `bridge_lane_watch_lines` and the director-only `bridge_coordinator_heartbeat`, return bounded observations, not transcript text, code/test results or a success claim. Finite queued work may continue through a temporary assistant-connection interruption only while OMP and its provider remain available; this is not guaranteed. Sleep, OMP exit, provider limits, required approvals, plan expiry and failed or malformed plans can stop progress; no automatic replay or quota bypass exists.

`pots install` sets up the CLI watchdog by itself when it finds Claude Code or Codex, and `pots install --no-coordinator-wakeups` turns it off. The `setup-auto` command line also offers separate CLI watchdog and cloud reminder text choices for Claude, ChatGPT, or both. A scheduled task keeps the watchdog running without a window, and it can start Claude Code or Codex; it does not start OMP or reopen a Desktop chat. Fresh cloud sessions have no chat memory, may lack local-PC reachability and can stall at approvals. Cloud mode generates text for manual scheduling only. See [coordinator resume](coordinator-resume.md) for configuration, disable and ownership-safe removal.

## Upgrade and removal

To upgrade: run `pots upgrade`. It upgrades in place in one step; there is no "install alongside" and no manual migration. An open OMP session or a running plan never blocks it. The new version is added beside the old one and verified, including a start check, before anything is switched; a running session keeps using the files it already loaded and is not restarted. Only then does it switch the one version pointer and the assistant connections; if any step fails, every switched step is undone and the old version keeps working (if the version pointer itself cannot be put back, it says so and names the one step that fixes it). A failed connection to one assistant app does not fail the install: it finishes, names that app and the next step. Running the same version again changes nothing, a newer installed version is never downgraded, and the same version number with different files is refused (use a package with a newer version number). The program path `<install folder>\runtime\current\bridge.mjs` is the same for every version. Old `runtime\managed-<id>` folders from 0.2.20 and earlier are kept untouched (the first `pots install` copies each pointer into the backup folder) and are the way back. Running `pots install` again keeps your earlier choices (coordinator clients, wake-ups, the resume watchdog). Existing bindings and controllers that differ are still refused rather than rewritten. See [updates](update.md#upgrading-with-setup) and [operations](operations.md) for recovery.

To remove: run `pots uninstall`, or use **Settings > Apps > Installed apps > Pi on the Side!**, and follow the verified, recoverable removal in [Operations](operations.md#uninstall). Do not remove OMP, Node, projects, original OMP sessions or untracked client adapters with the bridge. Keep recovery data until unresolved work and receipts have been reviewed.

### Connected projects

`pots install` connects every saved session it finds, newest first, at most 64 at once; projects connected earlier keep their places, and `pots install --details` says how many were left out. For each it makes the private folder `sessions\<id>` (queue, plans, receipts and controller record), a connection name and a launcher folder `launchers\<name>` with `Start-OMP.ps1`. Connecting does not start OMP or prove a live connection. `Start-OMP.ps1` resumes that saved file with the bridge explicitly loaded, and starting through it is what lets your assistant send work to that session. A running session started outside the launcher cannot be hot-attached: finish or safely stop it using OMP, close its terminal, then use the launcher. Do not start another copy or use plugin reload as attachment proof.

A session saved after the install is connected by the assistant adapter at most every 30 seconds, and only when the adapter holds the controller credential and runs from the full install (not the Claude Desktop extension).

Session discovery is read-only across saved projects. Each connected project carries the canonical project folder from that exact session header, and a session whose header no longer matches it is refused. Similar filenames in different projects are not interchangeable.
