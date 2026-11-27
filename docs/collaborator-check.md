# Claude acceptance check

Pi on the Side! lets your AI assistant control multiple OMP sessions through a local connection so you can send one approved task and review what the bridge recorded. It is designed to work across OMP versions; compatibility problems are bugs to fix. Not every past or future release has been tested.

Features include connecting saved projects, keeping named connections separate, checking progress and receipts, cancelling future bridge work, pausing or resuming new dispatch, reviewing uncertain outcomes without automatic replay, verified updates with rollback, and recoverable removal. Queued work may continue through a temporary assistant-connection interruption only while OMP and its provider remain available; receipts are observations, not proof of success.

Use the **v1.0.11 release**. Confirm its tag commit and the update bundle and MCPB checksums against the digests GitHub shows for that release's files before testing. The withdrawn v0.2.0 draft is not an accepted install. This checklist does not authorize outreach or model invocation by itself.

1. Confirm the candidate checksum. Follow [Start here](https://github.com/Jumpstile/pi-on-the-side/blob/v1.0.11/docs/release-quickstart.md) on
   a disposable local project. Setup connects every saved session it finds, so
   use a disposable account or sessions. Keep one directing assistant. Keep
   existing owner workflows and models untouched.
2. Let Setup connect Claude Code by itself (it registers the server and the
   Claude skill) or, for Claude Desktop, open the `.mcpb` file from the release with Claude Desktop (the install itself already connects Claude Desktop through its settings file, so this is only the manual way). Expect seven bridge tools, including
   `bridge_lanes_status`, `bridge_lane_watch_lines` and `bridge_coordinator_heartbeat`. Ask for status of
   the **exact connection name** shown in the `pots install --details` output; verify its project/session in
   OMP. Never choose a project by window title.
3. With the owner's approval, dispatch one harmless bounded task in that
   disposable project, such as reporting its working directory without changing
   files. Record the returned plan ID and receipt. Observe OMP's actual output;
   `ended` means the agent ended, not that the requested task succeeded.
4. Ask for that exact plan's receipt/status. Disconnect only the assistant and
   reconnect to the same named session. Verify preserved state and no second OMP
   process. The local queue may continue through a temporary assistant-connection
   interruption only while OMP and its provider remain available; this is not
   guaranteed.
5. Approve a separate harmless queued fixture, then cancel it before dispatch.
   Verify no future step runs. Do not assume cancel interrupts an already active
   turn; use OMP's own controls for that. A plan cut off by a crash is recorded as failed
   and is never automatically replayed.
6. Report candidate identifiers, Windows/client/OMP versions, pass/fail per
   step and sanitized output evidence. Do not share credentials, private paths,
   session IDs or transcripts in the repository. If a step fails, retain state
   and stop; do not create duplicate sessions or retry providers.

Claude model-driven acceptance remains pending until these observations pass. ChatGPT desktop/Codex integrations remain untested, and local desktop STDIO does not provide ChatGPT cloud access.

For coordinator wake-up acceptance, observe that the coordinator reports the wake-up to the user, schedules its own visible reminder, checks every lane with `bridge_lanes_status` on each wake, handles all `needsAttention` lanes, rearms only while `anyRunning`, and stops when it becomes false. Verify the client actually supports its scheduling facility; POTS does not push chat messages. Setup's connection of both clients, default-on wake-up behavior and opt-out/config persistence require separate installer verification; no such result is claimed here.
