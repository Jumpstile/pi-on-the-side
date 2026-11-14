# Coordinator wake-ups

Pi on the Side! can make lane state visible to a coordinating assistant, but it cannot send a message into that assistant's chat. The coordinator must schedule its own visible wake-up in the same conversation. This is a short polling cycle, not a background chat push or a guarantee that work will finish.

## Protocol

When beginning any run that queues work:

1. Call `bridge_coordinator_heartbeat` for each lane you direct, then `bridge_lanes_status` to inspect every registered lane. Heartbeat uses the existing controller capability, never acquires or transfers authority, and requires an explicit `connection` in named mode.
2. Queue the approved work. Schedule exactly one visible next wake-up using the coordinator's own scheduling facility, at the shortest interval that client allows (earlier versions of this protocol said about two minutes; the real delay depends on the client); before scheduling, list and delete other pending ones. Tell the user plainly that it is the assistant's reminder, not a POTS chat push. If no work was queued, do not schedule a run's wake-up.
3. On every wake-up, first validate the bound resume `cycleId` against its `control/state.json` authority when launched by the watchdog; superseded or unavailable cycles exit in one line without work or rearming. Never adopt a newer ID. Then refresh each directed lane's heartbeat and call `bridge_lanes_status`. For every reserved `needsAttention` event, read its result/receipt, close that lane's OMP window only when safe and appropriate, and queue its next approved step after reviewing the result. A stopped lane (`stopped` is true) is continued with `pots lane restore <name>`, or, if its OMP window is still open, by looking at it with `/bridge status` and then `/bridge enable` there; never queue a new step on it and never close its window. Never replay or requeue a failed, malformed, aborted or expired plan; there is no review step, so stop and tell the owner.
4. If `anyRunning` is true, schedule exactly one next visible wake-up at that same interval, retaining the same cycle ID and authority path; first list/delete other pending reminders. Otherwise stop scheduling and cancel pending reminders if supported. Tell the user what was checked and whether another wake-up was scheduled. If listing/cancellation is unavailable, report the limitation.
5. During long coordinator processing, refresh each directed lane at least every 120 seconds. The marker expires after 180 seconds. Keep the project handoff file current so a fresh [CLI/cloud resume](coordinator-resume.md) session can distinguish finished, approved and uncertain work without chat memory. If heartbeat fails, report the failure rather than claim monitoring is active.

A status snapshot is a point-in-time observation. Follow its state and attention signals, and do not automatically replay failed or malformed work or treat a receipt as proof that the task succeeded. If the status call fails or is ambiguous, do not guess or queue a duplicate; explain the problem and use the documented recovery process.

The [local watchdog](coordinator-resume.md#duplicate-events-and-superseded-wake-ups) detects actionable changes without model calls, at a 2-second default cadence (configurable down to 1 second). It emits at most one resume per lane/event identity and keeps the existing launch quotas and heartbeat rule. Faster detection does not make an unavailable external scheduling API controllable. At upgrade, cancel pre-existing reminders that lack the new cycle guard before starting a new chain.

## Cheapest reminder: the lane watcher

Every lane started with the Pi on the Side launcher also keeps a short local log of IDLE, BUSY, RESULT, GONE, ERROR and EXPIRED lines (see [lane watcher](lane-watch.md)). It costs no tokens and no network. A reminder can therefore do only this, instead of a full status review on every wake:

1. Call `bridge_lane_watch_lines` (or, with local command access, the `watch-lines` command Setup prints).
2. No lines: say nothing and stop. Nothing else runs and nothing is rescheduled differently.
3. Any IDLE, RESULT, GONE or EXPIRED line: call `bridge_lanes_status` and continue the protocol above. BUSY lines are informational. An EXPIRED line means a queued task was not started because its time ran out: tell the user and say it has to be queued again. An ERROR line means the watcher could not read its files: it is not a result, so check that lane locally.

What this does **not** change: a process on the PC cannot wake a chat. The check runs only when the assistant's own scheduler fires it, so the real worst case is the reminder interval the client allows (use its shortest), plus up to about 15 seconds for the watcher to notice (up to 2 s for the bridge's own idle sampling, the 8 s idle time and one 5 s poll), plus the assistant's own run time. A ChatGPT desktop session with the local connection open could call the tool (that integration is untested); a ChatGPT task running in the cloud cannot reach this PC (see below). The [CLI resume watchdog](coordinator-resume.md), which the install sets up by itself when Claude Code or Codex is found, is the only option that does not depend on a chat reminder; `pots doctor` shows whether it works.

## Client examples

- **Claude:** use the visible self-scheduled message facility available to that Claude client (for example, a `send_later`-style tool). Schedule the next check in the same chat and make the reminder prompt call `bridge_lanes_status` before taking action. Availability and exact tool name depend on the Claude client and its enabled tools.
- **ChatGPT:** use ChatGPT's own scheduled-task or reminder facility when available. The scheduled instruction should resume the same conversation's check-and-kickstart cycle. Availability and behavior depend on the ChatGPT client and account features.

POTS does not create either external scheduling facility, register a cloud connector, or push chat messages. The client must actually support and execute its scheduling facility; if it cannot, the coordinator cannot provide automatic visible wake-ups in that chat.

## Local and remote limits

The documented ChatGPT integration is local desktop STDIO configuration only. That establishes a local client connection to the bridge, not reachability from ChatGPT web/cloud chat, a remote scheduled task, or an external service. Do not copy local command configuration into a cloud environment or claim that POTS creates a route. Remote use requires a separately available, authorized client route; this product supplies none.

Claude/ChatGPT client availability, local tool permissions and scheduling features vary by product version and account. A scheduled chat may not run while its client is closed, the device sleeps, connectivity is unavailable, or the service/tool is unavailable. The coordinator may also fail to call status, process every attention lane, or re-arm a reminder. If a wake-up is missed, no POTS message is pushed to recover the conversation. Tell the user about each scheduled wake-up and each failure or inability to continue; do not imply guaranteed monitoring.

The CLI watchdog, set up by the install, starts Claude Code or Codex when a lane needs attention and no coordinator marker is fresh. That starts a CLI session from the handoff file; it cannot reopen or message the chat that was open before. Cloud reminder text is best-effort: a fresh cloud session has no chat memory, may be unable to reach local PCs, and may stall at permission prompts.

## Setup choice and privacy

`pots install` turns coordinator wake-ups on for a new install without asking; `pots install --no-coordinator-wakeups` (or `setup-auto --no-coordinator-wakeups`) turns them off, and the choice is stored. `pots install --coordinator-wakeups` turns them on again, whenever you like; the two flags together are refused. When it is on, the install also sets up the [CLI resume watchdog](coordinator-resume.md) by itself if Claude Code or Codex is found (a scheduled task, a handoff file and a self-test), so there is nothing to set up for it. A chat's own reminders are still scheduled by the assistant in that chat, because no program can schedule inside a chat. The lane watcher is part of the install; `pots install` and `pots upgrade` keep the watchdog, and `pots doctor` checks it.

Lane status is bounded and content-free: it is for monitoring state, not a transcript or task-text feed. A coordinator should read only the lane result needed for the next action, avoid quoting private output unnecessarily, and never include prompts, credentials, private paths or sensitive transcript content in scheduled reminder text. Reminder content is visible in the coordinating chat and is subject to that client's own storage and privacy practices. Review the client's settings and the bridge [privacy/security guidance](../SECURITY.md) before enabling it.
