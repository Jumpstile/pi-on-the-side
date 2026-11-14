# Advanced: optional desktop assistant adapter (local stdio MCP)

This optional local assistant adapter lets you choose a configured OMP project, send one approved task, review what the bridge recorded, or cancel future work. It cannot stop work OMP has already accepted. Pi on the Side is designed to work across OMP versions; compatibility problems are bugs to fix. Not every past or future release has been tested.

The adapter has seven tools: status, enqueue, receipt, cancel-future, `bridge_lanes_status`, `bridge_lane_watch_lines` and `bridge_coordinator_heartbeat`. The coordinator resume watchdog is separate from the adapter. Testing status and limits are in [verification](verification.md): no Claude Desktop, Claude Code or ChatGPT adapter conversation was exercised, and ChatGPT desktop/Codex activation remains untested. See the [prerelease quickstart](release-quickstart.md) for setup and limits.

`bin/mcp.mjs` is a stdio MCP server (protocol 2025-06-18). The desktop app starts it as a child process and talks newline-delimited JSON-RPC over stdin/stdout. It opens no port or listener, has no OAuth or network code, reads no provider credentials and never starts OMP. Writes read a locally configured private controller capability file; its key is never a tool argument or output. Single-session mode serves exactly one setup folder created by `node bin/bridge.mjs setup`, given in `OMP_BRIDGE_STATE`. Every call revalidates that folder's generated metadata, containment and the saved session's header identity; anything else is refused. The first valid call pins the session ID, project folder, saved session file and OMP executable for the life of the server process. Later replacement is refused; ownership belonging to another session is also refused. Restarting an adapter does not acquire or transfer controller ownership.

## Controller selection

For writes, follow [local credential generation, explicit acquisition and handoff](controllers.md). Set `OMP_BRIDGE_CONTROLLER` in each client's stdio launcher, or select the optional **Private write-access file** in the reviewed Desktop package. For the clients `pots install` registers itself (Claude Code, ChatGPT app / Codex, and Claude Desktop), Setup sets it for the one directing assistant and leaves any other as a read-only viewer; you do not set it by hand. No credential means shared read-only access. A credential owning alpha need not own beta; an exact named connection is still required. Seven tools are available; acquisition/handoff are local CLI actions only. Status includes bounded `controller.acquired` and `controller.writeLock` metadata without keys, fingerprints, paths or advisor names. A present gate may be active or left after a crash; it is never stolen automatically.

## Protocol behavior

- Lifecycle: one `initialize` request whose params carry a non-empty string `protocolVersion`, a `capabilities` object and `clientInfo` with string `name` and `version` (otherwise `Invalid params`). The server answers `2025-06-18`. `tools/list` and `tools/call` are refused with `Server not initialized` until the client sends `notifications/initialized`; a second `initialize` is refused with `Already initialized`. `ping` is answered at any time. Notifications never act and never get a reply.
- Bounds: a frame over 64 KiB is discarded with a fixed `Request too large` error. At most 16 operations (including those errors) are pending, and an operation stays pending until its reply is handed to stdout. Input is read only while fewer than 16 are pending and stdout is not backed up, so a client that stops reading stdout stops the server from reading or acting; requests are answered in order once it reads again. More than 1 MiB of unconsumed input from a single read stops input without acting on any of it. Each fixed stderr diagnostic is written at most once per process.

## Seven tools

| Tool | Authority | Arguments |
| --- | --- | --- |
| `bridge_status` | Read plan IDs, receipt states and whether a lock file exists | none |
| `bridge_lanes_status` | Read bounded lane event/receipt/diagnostic summaries across registered connections, including stable actionable `eventId` (SHA-256 or `null`); no prompts and no review/replay | none |
| `bridge_lane_watch_lines` | Print the [lane watcher](lane-watch.md) lines (IDLE, BUSY, RESULT, GONE, ERROR, EXPIRED) not shown before, for every registered connection, and mark them shown, at most 100 per call (`"more": true` means more can be fetched, so call again; a lane named in `unreadable` never keeps it on); an `ERROR` line means the watcher could not read its files, so check that lane locally; an `EXPIRED` line means a queued task was not started because its time ran out, so tell the user to queue it again; an empty list means nothing changed. Advances a local cursor, so it is not read-only; no controller capability needed, no prompts, no review/replay | none |
| `bridge_coordinator_heartbeat` | Refresh the current director's active marker for 180 seconds; existing controller capability required | none (explicit `connection` in named mode) |
| `bridge_enqueue` | Add one plan: one prompt, expires after 24 hours (waiting behind a long task counts), `continueAfterEnd:false` | `id` (fresh lowercase UUID), `prompt` (up to 6,000 chars), optional `model` (a name as OMP lists it: the task is queued only after OMP itself reports that model running) |
| `bridge_receipt` | Read one plan's bounded receipt metadata | `id` |
| `bridge_cancel` | Cancel that plan's future bridge steps | `id` |

Retrying `bridge_enqueue` with the same `id` and identical prompt reports the existing plan (`duplicate:true`) instead of queuing again; the same `id` with a different prompt is refused. Unknown properties, wrong types, control characters, session IDs, paths, deadlines and continuation flags are rejected as invalid parameters. There is no tool for choosing a session, multi-step plans, recovering locks, starting OMP, interrupting work or running commands.

## What the owner still controls

- Every enqueued prompt is task authority for OMP. Keep per-call approval for `bridge_enqueue` and `bridge_cancel` in the assistant (both are marked not read-only).
- Queued work starts only while OMP runs in the foreground through that project's `Start-OMP.ps1` launcher (which runs `node bin/bridge.mjs start "<state-folder>" --confirm-offline` after you type START).
- `bridge_cancel` does not interrupt running work. Use OMP's own interrupt/exit in the OMP terminal.
- `failed` and `malformed` are not completion and are never retried. Inspect them in OMP; queued plans go ahead after about 5 seconds. Receipts never claim task success.
- After an OMP restart, in-flight work is failed (reason `restart`); after a crash the lock must be recovered offline ([operations](operations.md)).

## Data exposure

Returned to the assistant: plan IDs, receipt state, reason codes from the core's fixed list, step observations, timestamps, cancellation flags and lock presence. Receipts are relayed only in their exact known shape and a plan without a receipt only if its file passes the core plan rules for this session under its own ID (expired plans included); anything else is refused (`receipt not recognized`, `plan not recognized`). A duplicate enqueue reports the prior expiry only from such a plan. Not returned: prompts, file paths, the session ID, transcript content or raw errors (only fixed diagnostic text). The prompts the assistant sends are stored in the private plan files and are also part of that assistant's own conversation with its provider. stderr carries fixed diagnostics only.

## Requirements

The server needs Node.js 22+ in whatever runtime the desktop app uses to launch `node`; the Node version bundled or used by any desktop app has not been checked. Before queued work runs, the bridge identifies the OMP executable, checks required runtime capabilities and exact saved-session binding, and requires safe completion evidence. Missing evidence ends the plan failed rather than guessing. See [host compatibility](host-compatibility.md). Tested platform: Windows.

## Claude Desktop package (preparation only)

```powershell
node scripts/pack-mcpb.mjs "C:\Private Bridge\omp-session-bridge.mcpb"
```

The script writes an `.mcpb` (ZIP) outside the checkout from an explicit allowlist and never overwrites an existing file. It prints archive and per-file SHA-256 values for review. Contents: manifest, package metadata, notices, desktop/controller guides, MCP entrypoint and its core modules, including shared lane status, lane watcher and heartbeat support; no dependencies, tests, git data or private state. Fixed timestamps make identical sources reproducible. The manifest declares `win32`, Node `>=22`, `MIT`, seven tools, required `state_root` and optional private `controller_file`. The package is unsigned; current source changes have not been activated in a client.

Install: `pots install` connects Claude Desktop by itself. It adds one `omp-session-bridge` entry to `%APPDATA%\Claude\claude_desktop_config.json`, the file Claude Desktop documents for local tool servers, keeps every other setting in that file, and takes only its own entry back on uninstall. Claude Desktop loads connections when it starts, so close it completely and open it once more. The `.mcpb` below is an alternative for people who prefer Claude Desktop's Extensions screen: open the reviewed `omp-session-bridge-<version>.mcpb` (attached to the release on GitHub) with Claude Desktop and type the folder into **Assistant setup folder**. Do not use both at once, because the tools would appear twice. If Claude Code or the ChatGPT app / Codex is connected it is the directing assistant, so leave the optional private write-access file empty; if Claude Desktop is your only assistant, `pots install` already gave its settings entry the write access, and an extension needs the **Permission file** path listed by `pots install --details`. Claude web and remote Claude endpoints are out of scope.

Updates: `pots upgrade` rewrites the settings-file entry by itself. An installed `.mcpb` extension is managed by Claude Desktop, and the bridge's optional updater cannot replace one. The `.mcpb` contains no update code, and none of the seven tools grants update authority. A newer adapter requires the newer reviewed package; open the new `.mcpb` file with Claude Desktop to import it after owner approval ([updates](update.md)). The [coordinator resume watchdog](coordinator-resume.md) can start a configured local CLI; it does not restart a Desktop chat.

## ChatGPT desktop app and Codex

OpenAI's [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) and [Codex MCP documentation](https://developers.openai.com/codex/mcp) (checked 2026-10-08) state that the ChatGPT desktop app, Codex CLI and IDE extension share a Codex host's MCP configuration and support STDIO servers with `command`, `args` and `env`, and that `default_tools_approval_mode = "writes"` prompts for tools not marked read-only. That is documented support, not a local result: this bridge has not been configured in or invoked by any of these surfaces. Read-only checks found Codex CLI 0.146.0 (its `codex mcp add --help` lists a stdio `-- <COMMAND>...` form and `--env KEY=VALUE`) and ChatGPT desktop 1.2026.190.0 installed. `pots install` writes an entry of this shape itself, as one marked block in `<home>\.codex\config.toml` with the rest of the file kept byte for byte; that location was not tried against a real Codex or ChatGPT install. Use the example below only for a setup that `pots install` did not do, and add it only after approval:

```toml
[mcp_servers.omp-session-bridge]
command = "node"
args = ['C:\path\to\omp-session-bridge\bin\mcp.mjs']
env = { OMP_BRIDGE_STATE = 'C:\Private Bridge\example-state', OMP_BRIDGE_CONTROLLER = 'C:\Private Bridge\codex-controller.json' }
default_tools_approval_mode = "writes"
```

ChatGPT web does not read local Codex configuration. Its Secure MCP Tunnel needs client/platform keys and access that are not authorized here. There is no supported independent Dottie/ChatGPT callback to this computer: a local MCP server works only while that desktop client is running on this machine.

## Remote Desktop Commander

[Desktop Commander's remote MCP](https://desktopcommander.app/mcp/) (setup: its repository [docs/SETUP.md](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md)) is an optional, advanced remote-assistant tool. It is not part of this package, not a prerequisite for the local bridge and not a way around provider quotas or approvals.

## Named connections

Setup makes a private connections folder (`<install folder>\connections`) and registers every saved session it finds in it, each under a unique name (the Setup details list the names). One assistant installation points its **Assistant setup folder** at that folder. To register one by hand: `node bin/bridge.mjs connect <connections-folder> <name> <saved-state-folder>`. Each registration captures the already-verified session/project/saved-file/executable identity. It cannot select arbitrary sessions or start OMP. Duplicate names, duplicate sessions/roots and more than 64 entries are refused. Names are exact lowercase identifiers, not inferred from conversation.

The full install's adapter, when it holds the controller credential, also registers sessions saved later, at most every 30 seconds, newest first and only up to the 64-entry limit. An adapter without the credential (a read-only viewer) never registers anything by itself. This Claude Desktop extension package carries no installer code, so it never registers sessions by itself: run `pots install` again (or use an assistant that runs the full install's adapter) to connect a session saved later.

In named mode, tools/list adds `connection` with the registered names to the tool schemas. Enqueue, receipt and cancel require it; status may omit it to list all names and bounded queue observations. Example enqueue arguments: `{"connection":"alpha","id":"<fresh lowercase UUID>","prompt":"<approved instruction>"}`. The list of connections is read fresh on every call, so a newly registered session needs no adapter restart. Every selected setup is revalidated against its captured binding on each call; malformed/stale bindings are refused. Queues, receipts, cancellation and locks remain independent, including identical plan UUIDs in different explicitly selected sessions. No broadcast, default target or network listener exists.

This is application-level scope, not an OS sandbox. An enabled Node process runs with the Windows account's capabilities. Per-tool host approval is host-controlled: enqueue showed Allow once in the observed Desktop test, while a repeated cancellation was reported without a popup despite Needs approval. Explicit user-request/session semantics remain uncertain; do not promise a separate popup for every call. Owner task authority and native OMP permissions still apply. No blanket Always allow is required by this adapter.

When no execution receipt file exists, receipt/status synthesize queued metadata plus cancellation presence; there is no explicit receiptExists flag. Missing reason/outcomes is not proof of execution. The bridge_receipt tool can succeed while returning projected queue status rather than an execution receipt.
