# Pi on the Side! - Connect another client

Pi on the Side! connects local clients to OMP sessions. Use an approved local assistant to send work to a chosen project and check what the bridge recorded. The product is designed to work across OMP versions; compatibility problems are bugs to fix. Not every past or future release has been tested.

Complete [OMP setup](release-quickstart.md) once. Setup connects Claude Code and the ChatGPT desktop app / Codex by itself, with coordinator wake-ups on (the command line `setup-auto --clients` and `--no-coordinator-wakeups` can change that), so only another client needs the values below. These are filenames, not credential contents. Exactly one connected assistant directs (Claude Code first, then ChatGPT / Codex, then Claude Desktop) and gets the private write-access file; any other is a read-only viewer. Switching directors needs a separate credential and [explicit handoff](controllers.md).

Setup writes the coordinator instructions itself: for Claude Code it installs the `pi-on-the-side` Claude skill under your Claude folder; ChatGPT custom instructions are an account setting that no program can change, so `pots instructions` prints the text and you paste it once under Settings > Personalization > Custom instructions. These instructions describe coordinator behavior; they do not create a ChatGPT cloud connector. The registration locations Setup uses (the Claude skills folder and `.codex\config.toml`) were not tried against a real Claude or Codex install.

CLI resume is on by default: `pots install` sets it up when it finds Claude Code or Codex, and `pots install --no-coordinator-wakeups` turns it off. Cloud reminder text is off by default and is generated only with the `setup-auto` command line. CLI mode registers a scheduled task that keeps a watchdog running without a window; cloud mode only generates task text for manual scheduling. A fresh cloud session has no chat memory, may not reach this PC, and may stall at permissions. See [coordinator resume](coordinator-resume.md).

## ChatGPT desktop

The documented connection is local desktop STDIO configuration. It does not establish ChatGPT web/cloud reachability, a remote scheduled-task route, or a POTS-created connector. The ChatGPT integration is not tested in this client.

Setup adds the `omp-session-bridge` server to Codex's `config.toml` (one marked block, the rest of the file kept) when the ChatGPT desktop app / Codex is present, with write approval set to writes. Nothing needs to be copied by hand. If the app was not installed when Setup ran, install it and run `pots install` again.

The paste step for ChatGPT's custom instructions (`pots instructions`) appears only when Setup finds an app folder whose name starts with `OpenAI.ChatGPT-Desktop_` in `%LOCALAPPDATA%\Packages` (the name the Windows ChatGPT app has on a PC that has it). Other OpenAI packages, such as Codex, do not count. If your ChatGPT desktop app is installed another way, the step can be missing. `pots instructions` prints the text whenever Setup has saved it, so you can paste it yourself either way.

1. Check for `bridge_status`, `bridge_enqueue`, `bridge_receipt`, `bridge_cancel`, `bridge_lanes_status`, `bridge_lane_watch_lines` and `bridge_coordinator_heartbeat`; request named status first.
2. If the tools are missing, compare these values with the client's local **STDIO** MCP settings: command = the Node.js program Setup used; arguments = `<install folder>\runtime\current\bridge.mjs` then `mcp`; environment `OMP_BRIDGE_STATE` = the **Assistant folder** and `OMP_BRIDGE_CONTROLLER` = the **Permission file** (set only for the one directing assistant). `pots install --details` lists the folder and the file.

If local STDIO settings are unavailable, stop and use the client's official guide rather than editing application internals. Codex CLI/IDE reads the same `config.toml` block; keep write approval enabled.

ChatGPT's local desktop configuration connects only that local client to the local bridge. It does not make ChatGPT web/cloud chat reachable from this PC, and POTS does not create or provision an external connector. See [coordinator wake-ups](coordinator-wakeups.md) for the separate chat scheduling protocol and limitations.

## Other local clients

Other supported local STDIO clients may be configured using values shown by Setup. Compatibility depends on each client; the adapter has been tested through the official MCP SDK with disposable fixtures.

1. Open your client's supported local MCP server settings.
2. Choose local **STDIO** transport.
3. Copy the command, argument and environment values from `pots install --details` (see the list under ChatGPT desktop above).
4. Require approval for writes, save, and refresh that client's server.
5. Check for `bridge_status`, `bridge_enqueue`, `bridge_receipt`, `bridge_cancel`, `bridge_lanes_status`, `bridge_lane_watch_lines` and `bridge_coordinator_heartbeat`; request status for the exact named connection.

A client that accepts only remote URLs cannot connect to this package. If it requires manual configuration, use its own instructions; Setup does not invent a GUI for it. A local shell client can use the [documented CLI](../README.md#manual-setup-optional); no assistant-specific integration is needed.


## Evidence

v0.2.11 adds `bridge_lanes_status`, `bridge_coordinator_heartbeat` and opt-in coordinator resume; a disposable full Windows install of the pre-release candidate did not exercise a client adapter conversation. The earlier v0.2.10 package changed descriptions, setup labels and version metadata only; it was not installed or invoked. Latest installed-package evidence is v0.2.9: 203 Node tests and 33 Windows fixture assertions passed, and the installed Claude adapter passed a read-only MCP handshake, tools/list and status check; no plan was submitted. That v0.2.9 check is not in the [verification record](verification.md) and was not repeated for this version. A separate disposable OMP lifecycle check observed lock/timer/poll activity without a model/provider turn. Exact test inputs and scope are in the [verification record](verification.md). ChatGPT desktop/Codex integrations remain untested; there is no broad claim of model-driven acceptance.

Official client setup references checked 2026-10-09. UI labels above follow official docs; a host's version or organization policy can differ.
