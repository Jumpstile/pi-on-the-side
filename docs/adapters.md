# Advanced: assistant-neutral adapter boundary

This reference describes which local assistant connections are implemented and their limits. It does not promise access from cloud-only chats. Pi on the Side is designed to work across OMP versions; compatibility problems are bugs to fix. Not every release has been tested.

The core speaks local JSON/filesystem and exposes a JavaScript runtime contract, not an assistant-specific chat API. A local human or authorized local agent can run `setup`, `queue`, `status` and `cancel` (or the [advanced config commands](advanced.md)). The CLI does not ask which assistant created a request; the owner-only state directory and exact session/cwd are the authority boundary.

| Controller/runtime | Documented supported product surface | Bridge status | Security/communication limit |
| --- | --- | --- | --- |
| Human terminal | Local CLI/filesystem | Implemented and fixture-tested | OMP must be running to consume the queue |
| OMP | Explicit extension path, sendUserMessage, lifecycle and session manager capabilities | Disposable two-step RPC smoke passed; exact host and scope are in the verification record | No provider quota bypass; owner-session activation separate |
| Claude Code | Local CLI/tool execution and MCP stdio/HTTP | A disposable chain passed: authenticated Claude Code CLI ran `enqueue` once and `status`; an isolated OMP session consumed one finite step with exact admission and a terminal receipt (success unverified). The stdio MCP adapter was checked with Claude only by the read-only handshake in v0.2.9 described in [client setup](client-setup.md#evidence); that check is not in the [verification record](verification.md) and was not repeated for this version | Desktop/web Claude is not automatically a local client |
| Consumer Claude | Product-provided integrations | No activation or end-to-end test | No inferred access to this PC/filesystem |
| Claude | Client-specific local integrations | `pots install` connects Claude Code by itself; existing verification limits are in the verification record | No inferred access from cloud chat to this PC |
| ChatGPT desktop | Local desktop STDIO configuration | Setup connects the ChatGPT desktop app / Codex by itself; the bridge integration remains untested | Local STDIO does not establish cloud/remote reachability or a remote scheduled-task route |
| ChatGPT web/cloud task | No connection supplied by this package | No independent external connector or callback is created by POTS | No route to this local queue is established |

`pots install` connects Claude and ChatGPT without asking. It also describes coordinator wake-ups, which are scheduled by the assistant in its own chat, not pushed by the bridge; see [coordinator wake-ups](coordinator-wakeups.md). The default is on, and `pots install --no-coordinator-wakeups` turns them off (and removes the scheduled watchdog task). Capability research and client features may change; verify current official client documentation before configuring it. OMP remains the engineering/runtime workflow; configured primary, advisor and escalation models are not overridden by this package.

For Claude Code, verify the current official [MCP documentation](https://code.claude.com/docs/en/mcp) and [headless documentation](https://code.claude.com/docs/en/headless) before configuring native tooling. Setup registers Claude Code itself; the CLI path needs only an approved local shell.

## Runtime adapter obligations

1. Pin the exact approved main-session ID and canonical cwd before touching state. Do not accept arbitrary remote session selection or subagents.
2. Acquire one supervisor lock for the session. Check that no other session writer exists; the lock alone cannot detect nonparticipating runtimes or another root.
3. Implement idle/pending checks. `send` must use the runtime's supported user-message route once; exceptions end the plan failed (reason `submission_exception`). A call that is still open after 5 seconds is not a failure if the run for that plan was seen to start: some runtimes keep the call open until the run ends, and the exact-user-record check at the end decides. A call that stays open with no start seen fails.
4. Capture a transcript/admission fence before submission and verify the exact sole user record afterward. Do not use assistant/tool echoes, API return, or record counts as delivery proof. This implementation's bounded v3 parser is OMP-specific.
5. Supply unique physical-run tokens and positively correlate terminal observations. The OMP adapter handles cloned notifications using a bounded stable snapshot key within the current epoch. Missing or mismatched observations, overlapping starts, native continuation, manual input or changed admission evidence fail closed.
6. Preserve durable receipts and finite owner transition permissions. Never turn an observed end into a successful project result.
7. Cancel future queue authority durably. If a native abort exists, document and test it separately; this package does not claim to call one.

The optional local stdio MCP adapter is described in [desktop adapter](desktop.md): seven tools over pinned setups, including `bridge_lanes_status`, `bridge_lane_watch_lines` and the controller-authorized `bridge_coordinator_heartbeat`, with no review/recovery/launch authority and no network listener. Its enqueue tool grants workflow authority and needs explicit owner approval to activate. The separate CLI watchdog is described in [coordinator resume](coordinator-resume.md). A consumer API wrapper additionally needs approved reachability, authentication, replay protection, bounded inputs, audit and revocation. No generic arbitrary-command endpoint should be introduced. Do not map model-provider credentials or private desktop platform tokens into either design.
