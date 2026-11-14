# Advanced: one directing controller per session

This page explains the optional private file that lets one local assistant send or cancel tasks. Keep it private; never paste its contents into chat.

The OMP supervisor lock prevents duplicate bridge workers. Controller ownership
separately prevents cooperating assistant clients from issuing conflicting
enqueue/cancel writes. Status and receipts remain shared and read-only.
The same connections registry can be used by multiple clients; different named
sessions may have different owners. No broker, service or network port is added.

## First setup and handoff

Generate one credential file per directing client in a private local folder
outside the source, state, project and connections directories. Never paste its
contents into a prompt or share it between advisors.

```powershell
node bin/bridge.mjs controller-create "C:\Private Bridge\claude-controller.json"
node bin/bridge.mjs controller-create "C:\Private Bridge\dottie-controller.json"
node bin/bridge.mjs controller-acquire "C:\Private Bridge\example-state" "C:\Private Bridge\claude-controller.json"
```

For the clients `pots install` registers itself (Claude Code, the ChatGPT desktop app / Codex, and Claude Desktop), you do not set anything by hand: Setup picks exactly one directing assistant (Claude Code first, then ChatGPT / Codex, then Claude Desktop), gives it the private credential file path as `OMP_BRIDGE_CONTROLLER`, and leaves any other registered assistant as a read-only viewer. The one exception: if Claude Code is installed but its settings file cannot be read, Setup cannot tell who holds the write access, so it leaves the other assistants exactly as they are, nobody new gets write access, and the install result says so; fix Claude Code, then run `pots install` again. For any other client, set `OMP_BRIDGE_CONTROLLER` in that client's launcher to its credential file.
Claude Desktop's reviewed package exposes the optional **Private write-access file** setting. Leave it empty when Claude Code or the ChatGPT app / Codex is the directing assistant; if Claude Desktop is your only assistant, select the **Permission file** path listed by `pots install --details`. Leaving it unset allows reads but refuses enqueue/cancel, and an adapter without the credential never connects newly saved sessions by itself. Do not add the key to tool arguments. The tool names, exact named-session selection and plan schemas are unchanged.

For local CLI queue/enqueue/cancel/abort, set the variable for the current
PowerShell window only:

```powershell
$env:OMP_BRIDGE_CONTROLLER = "C:\Private Bridge\claude-controller.json"
```

To hand off, stop the old advisor from issuing requests, read status/receipts,
and give the new advisor the exact connection name and outstanding plan IDs.
Then explicitly transfer that saved session:

```powershell
node bin/bridge.mjs controller-handoff "C:\Private Bridge\example-state" "C:\Private Bridge\claude-controller.json" "C:\Private Bridge\dottie-controller.json"
```

The new client uses its own credential. The old one is fenced even if its
stdio process remains alive. A handoff racing an admitted write is refused
while the write lock is held; retry only the handoff after reviewing the result.
Handoff neither interrupts nor restarts OMP and changes no plans, cancellation
records, receipts, saved history or provider/model. Queued work may continue;
in-flight work stays in flight. An identical MCP enqueue retry
keeps its original ID and returns its existing state; it never resubmits that ID.
CLI `queue` always creates a fresh ID and is not an idempotent retry interface.
Never turn an uncertain request into a fresh-ID duplicate.

## Native slash-command requests

The controller CLI has a separate slash-command ticket path; it never places slash text in a plan or calls `sendUserMessage` with it:

```powershell
$id = [guid]::NewGuid().ToString()
node bin/bridge.mjs command "C:\Private Bridge\example-state" $id "/model <model-name>"
node bin/bridge.mjs command-status "C:\Private Bridge\example-state" $id
```

Tickets are bound to the configured saved-session ID, require controller ownership, have unique caller-supplied IDs and are never replayed after dispatch admission. The adapter serializes them with native work and requires the same live session file, project folder and idle state immediately before the API call. `command-cancel` cancels only a still-queued ticket. `dispatching` recovered after restart becomes `failed`.

### Switching a lane's model

Pi on the Side keeps no list, table or alias of model names. A model name is accepted only when OMP itself confirms it, live, at the moment of use: through OMP's own model resolver (`ctx.models`, the same resolution as `omp --model`) and its list of available models. A model you subscribe to tomorrow works without any change here. Use the name exactly as `omp models` lists it, or any short name OMP's own resolver accepts.

```powershell
node bin/bridge.mjs model "C:\Private Bridge\example-state" <model-name>
node bin/bridge.mjs queue "C:\Private Bridge\example-state" "<task>" --model <model-name>
node bin/bridge.mjs lane-task "C:\Private Bridge\example-state" <model-name> "<task>"
```

`lane-task` is the same check as `queue --model` with a plain error and a non-zero exit instead of JSON. The MCP tool `bridge_enqueue` takes the same optional `model` field and applies the same check before it stores anything.

- An unknown name is refused with a plain message that lists what OMP reports as available. A bare name that more than one provider carries is refused as ambiguous and lists the exact `provider/id` choices; use one of those.
- A switch is never trusted because `setModel` returned true. After switching, OMP's own report of the running model is read (a few times, in case it lags). Only a match gives receipt state `verified`. `mismatch` (OMP reports a different model) and `returned-unverified` (OMP reports no model) are errors; both record a `model_mismatch` lane event, and `model_switched` is recorded only for a proven switch.
- `model` exits 0 only when the switch is `verified` and prints the requested name, what OMP resolved it to and what OMP reports running. `queue --model`, `lane-task` and `bridge_enqueue` with `model` queue the task only after `verified`; a switch OMP reports as a `mismatch` or `returned-unverified` is retried up to six times, a refused name is not retried, and on any other outcome nothing is queued, the exit is 1 and the reason is printed, with a `start_failed` lane event. A task that cannot be confirmed stored is also a `start_failed` (`prompt_not_delivered`). If the lane does not answer in time the switch request is cancelled so it cannot fire later.
- `bridge_lanes_status` shows `model.actual` (OMP's report each sample), `model.requested` and `model.state` (`verified`, `mismatch`, `changed-since` or null). See [lane events](protocol.md#lane-events-coordinator-visible-transitions).
- Hosts older than OMP's `ctx.models` accept only an exact `provider/id` that the session's `modelRegistry.getAvailable()` lists.
- Plan hold: a `/model` request that is not proven (receipt `mismatch`, `returned-unverified`, `unsupported` including unknown or ambiguous names, or `failed`) holds every queued plan, including plans queued before the request and plans from callers that do not use `queue --model`. Within a wake the adapter attempts a pending switch before it considers admitting a plan; while held it admits nothing (trace gate `model-switch-unproven`), and a plan already running is not interrupted. Only a later `verified` switch releases the hold (re-run `model` with a name OMP confirms; asking for the model the lane already runs, from `model.actual` in `bridge_lanes_status`, is verified at once, so a lane cannot be stuck for good). While held, `queue` and `bridge_enqueue` also refuse new tasks (`model switch not verified; task not sent`); cancelled tickets and other slash commands neither hold nor release. A `/model` request that has not been answered yet also holds, including the moment between its request file and its first receipt. A receipt that cannot be read also holds (it counts as unproven, dated by its file time); the adapter and restart recovery skip it rather than stop, so a later verified switch still runs and releases it. `bridge_lanes_status` reports `model.holdingPlans` and sets `needsAttention` while plans wait behind a hold. A hold is derived from receipts, so it survives an OMP restart.

Only an explicit `/model <name>` can use the supported `pi.setModel` API. `/model` with no name (the native picker), missing API/model availability, and every other command are refused; slash input is never submitted as ordinary model text. Known TUI built-ins report that the TUI dispatcher is unavailable. Registered extension, prompt/file and skill commands are discovered with `pi.getCommands()` but report unsupported because ExtensionAPI does not expose a general dispatcher. Other names not exposed by `getCommands()` are reported as "TUI-only or unknown" rather than guessed. Destructive and interactive commands are therefore refused rather than dispatched without a native approval flow.

This boundary matches OMP v18.12.6 source: `sendUserMessage` feeds the session prompt path; `getCommands()` exposes extension, prompt and skill commands but excludes frontend built-ins; built-ins are dispatched by the interactive TUI registry before session prompting. There is no supported ExtensionAPI method to invoke those handlers. Sources: [OMP extension API](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.12.6/docs/extensions.md), [command aggregation](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.12.6/packages/coding-agent/src/extensibility/extensions/get-commands-handler.ts), [built-in TUI registry](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.12.6/packages/coding-agent/src/slash-commands/builtin-registry.ts), [extension implementation](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.12.6/packages/coding-agent/src/extensibility/extensions/loader.ts).

## Files and failure behavior

The credential contains a random 256-bit key. The state root contains
`controller-<session-id>.json` with version 1, exact session ID and SHA-256 key
digest; no assistant display name establishes identity. The record persists
across adapter restarts. Acquisition is explicit and exclusive: repeated
acquisition by the same credential is idempotent; another credential is refused.
Only the current capability can explicitly hand off to a recipient capability.

Each write checks ownership before creating the exclusive
`controller-<session-id>.lock`, rechecks inside it, and holds it through the entire
mutation. Acquisition and handoff use the same cross-process gate. A contender
is refused rather than silently queued. Normal completion releases only its
temporary gate; ownership remains. A crash can leave that gate present. No
heartbeat, timeout takeover, PID-based stealing or automatic recovery exists.

After a crash, stop all directing clients for that session and establish that no
writer is still active. Preserve a backup and review plans/receipts and uncertain
outcomes locally. Only then may the owner manually remove the stale **controller
write lock**; do not remove ownership or the separate supervisor lock to make
errors disappear (the one exception is a lost credential file, below). Resume with the same credential, or hand off explicitly.
A missing/lost credential or malformed ownership fails closed and requires
offline owner review. This release deliberately has no force-takeover command.
If a session already has a controller and its credential file is lost, the only way
back is by hand, after the same review: close every assistant that uses the session, copy
`controller-<session-id>.json` from its state folder to a safe place, delete it (and a stale
controller write lock, if one is left), then run `controller-create` and `controller-acquire` again. Plans and receipts stay as they are.
No recovery should replay an uncertain plan. Atomic rename/fsync has the same
filesystem/power-loss limitations as existing durable receipts.

## Compatibility and actual trust boundary

Updated CLI/MCP entrypoints refuse legacy unauthenticated writes. Old directory
clients reject the added ownership entries as an incompatible setup; do not mix
old writers with this protocol. Direct core Store calls, old advanced config-file
writers, native OMP prompts/tools, and manually edited files are outside this
adapter boundary. The supervisor can still consume already approved queued
plans; it does not need the advisor credential. `/bridge enable|disable|status`
and quiet in-process lifecycle remain unchanged.

This coordinates trusted same-user clients; it is not authentication against a
malicious process running as the Windows account. Such a process can read keys,
share a credential, edit ownership, call native OMP or bypass adapter code.
Sharing one credential intentionally makes two clients indistinguishable; use
separate credentials and one directing client at a time. Private folder ACLs
remain the security boundary; Unix mode bits do not establish Windows ACLs.
Native host approvals and provider quotas still apply. Ownership does not grant
Dottie a native connector, carry assistant chat history, or change the OMP model.

## Local validation

`node --test test/controller.test.mjs` uses disposable states and deterministic
stdin/stdout barriers between Node processes. It checks initial ownership races,
write/handoff exclusion, crash lock retention, legacy refusal, distinct named
owners, same-display-name refusal, duplicate IDs and failed receipt preservation.
It never starts OMP or calls a model provider. Deployment requires separate
review; writing this source does not update any installed client.
