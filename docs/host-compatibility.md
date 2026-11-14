# OMP compatibility

**Pi on the Side has no list of supported OMP versions.** There is no pin table, no allow-list and no version check that turns behavior on or off. Every OMP version, old and new, is handled by the same logic. Compatibility problems are bugs to fix, not versions to add to a list.

An OMP executable is recognized only by a line of its `--version` answer having exactly the form `omp/<major>.<minor>.<patch>`; other lines (a banner or a warning) are ignored, and no such line, or two different ones, means it is not recognized. The number itself is never compared. Before starting, the bridge also checks the runtime capabilities it needs (for example that sending a message and reading idle state exist) and binds itself to the selected saved session. Missing capabilities refuse to start, whatever the version.

## The one rule for the end of a run

OMP reports a run that has settled by leaving `willContinue` out of the `agent_end` event, and a scheduled continuation or background-work wait as `willContinue: true`.

- **Omitted** means the run finished.
- **`false`** means the run finished.
- **`true`** means OMP continues; it never advances bridge work by itself.
- **Anything else** (null, a string, a number, an object) is malformed: the plan ends `malformed` (reason `malformed_end`).

## Where safety comes from

Not from the version. A finished run only completes a plan after exact saved-session admission: the transcript proves the exact submitted message ran, and fresh correlated assistant evidence matches. An end that cannot be matched to the submitted message ends `failed` (`start_event_missing`, `end_not_matched_to_message` or `message_not_confirmed_in_transcript`). A malformed or failed plan is never replayed and holds queued plans only for a short settle time. See the [protocol](protocol.md#host-lifecycle-contract).

An unowned native run holds future bridge submissions without rewriting any historical receipt. A valid terminal END, a fresh matching assistant observation, unchanged lifecycle/binding, native idle with no pending messages, and no active bridge run are all required to release its evidence hold. Ambiguous ordering, replay, changed endpoint evidence or missing correlation remains held; idle alone never clears it.

Setup keeps any OMP it finds as it is. It never gates, replaces or downgrades an existing OMP by version. When OMP is missing, Setup stops and says where to get it; it downloads no OMP.

Dated test and source observations are kept in the [verification record](verification.md); they describe what was checked then, not what is allowed now.
