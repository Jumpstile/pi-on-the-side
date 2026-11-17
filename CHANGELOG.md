# Changelog

## v1.0.8 - 2026-11-17

- Install and upgrade no longer stop with "record too large" on a PC with many lanes and many kept program versions. The list of installed files can now grow to 1 MiB (it was cut off at 64 KiB), and `pots status` reads it the same way.
- If the last lane on the list is dropped, commands now say that no lanes are connected and to run `pots install`. Before, they said the lane list was invalid.
- If Setup cannot prepare the launcher for a lane, that lane is taken off the list again instead of staying as a row nobody can start.
- An update check or update is no longer refused because of a harmless leftover temp file in the install folder.
- The wake-up log is now written reliably even when another program has the file open for a moment.
- Setup no longer overwrites a change made to Claude Desktop's settings file while Setup was working. It stops for that item, and running `pots install` again starts from the new contents.
- On a Node older than 22, `pots` and the Claude connection now print one plain sentence instead of a stack trace.
- Two documentation pages that disagreed about whether the Claude connection was tested now say the same thing.

## v1.0.7 - 2026-11-16

- If the lane list cannot be saved and the old list cannot be put back automatically, the message now names the backup copy only when one was made. Before, it always pointed to a backup that exists only after a lane is removed, so it could send you to a missing or older file. When a lane was being added, it now says to run pots install instead.

## v1.0.6 - 2026-11-16

- When you uninstall and one of your own assistant settings files (Claude Desktop or Codex) still has a Pi on the Side entry, it now says to open the file and remove only that entry. Before, it said to delete the whole file, which would have erased your other settings.
- If Oh My Pi restarts while a model switch is in progress, queued tasks now wait until a later model switch is confirmed. Before, the next task could start on a model you did not choose.
- Fixed places where the documentation did not match what Pi on the Side really does: the queue limit, the record size limit, the setup file keys, an error message name, the tester checklist, and two out-of-date examples.

## v1.0.5 - 2026-11-16

- Choosing a lane name that is not allowed now says what the rules are (lowercase letters, digits and hyphens, starting with a letter, up to 32 characters). Before, it reported a damaged lane list, which was misleading.

## v1.0.4 - 2026-11-16

- If Pi on the Side is installed twice (the normal install and the Oh My Pi catalog copy), only one copy runs in a session. The extra copy stays off and says so, and the normal install always wins.

## v1.0.3 - 2026-11-15

- Pi on the Side can now be listed in the Oh My Pi package catalog. Nothing changes in how it works or installs for you.

## v1.0.2 - 2026-11-14

### Fixes

- After you cancel a task that is waiting for a lane that is not running, `pots status` now says the cancel is recorded and the task will not run, instead of still showing "queued, session not running".

## v1.0.1 - 2026-11-14

### Fixes

- Queuing a task for a lane whose session is not running no longer looks like a success. The task is still queued, but you now get a plain warning, the command exits with code 3, and `pots status` and the lane status show "queued, session not running" instead of a bare "queued". Restore the lane to continue, or cancel the task.


## v1.0.0 - 2026-11-14

The first full release. It is the 0.2.25 test build plus the changes below.

### New

- Pi on the Side is now released under the MIT License.
- `pots lane list` shows each lane on the list as running, finished or stopped recently, and names the lanes that were taken off the list and can be brought back.
- `pots lane close --finished` takes every finished lane off the list at once. One lane always stays, and a running lane is never touched.
- `pots lane restore <name>` now also brings back a lane that was taken off the list even when no saved launcher for it exists, using the copies of the old list that are kept.

### Fixes

- When a saved session is skipped, the message now says why in plain words: the session is already connected through another saved copy of its file, it was connected with a different OMP program than the one installed now, or it no longer matches. Before, every case said the same thing.
- The hints in the messages now point to `pots lane list` for the lane names.

## v0.2.25 - 2026-11-13

Fixes for a full lane list, with the changes below.

### Fixes

- Connecting a new lane no longer fails with "too many connections" when 64 lanes are listed. Finished lanes (OMP not running and quiet for 2 hours) are taken off the list by itself, oldest first, and their saved sessions are not touched. If every lane is still running, you get a plain message with how many are running and the command that frees a place.
- New `pots lane close <name>` takes a lane that is not running off the list. `pots lane restore <name>` now also puts a lane that is not on the list back before it continues it.
- The old lane list is kept as `connections.json.bak1` to `.bak5` before any lane is removed from it (also when Setup removes a connection whose saved session was deleted), and `pots uninstall` removes those copies.

## v0.2.24 - 2026-11-09

The 0.2.23 test build with the changes listed below. It has a new version number, so `pots upgrade` can move an earlier 0.2.23 test build to it (the same number with different files is refused).

### Fixes

- The one pasted line now names `github.com` itself (`gh api --hostname github.com`, `-R github.com/...`), so a `GH_HOST` in your environment can never send it to another host. The installer puts your own `GH_HOST` back when it ends.
- If Claude Code is gone but Codex is still there, a wake-up now starts Codex. Before, the watchdog kept trying only Claude Code and never started anything.
- A lock left behind by a crashed lane is no longer taken for an open session, so `pots install` can change your choices again.
- `pots install --no-coordinator-wakeups` stays off when a session was open at the time: a later plain `pots install` or `pots upgrade` keeps wake-ups off, `pots status` and `pots doctor` say "off by your choice", and the open session follows once it is closed.
- `pots install --coordinator-wakeups` turns wake-ups on again after `--no-coordinator-wakeups` (also on `setup-auto`). It removes the stored "off" choice, sets the scheduled task up again and runs the self-test. An OMP session that is open at the time follows the first install after it closes, and a later plain `pots install` or `pots upgrade` keeps wake-ups on. Both flags together are refused with a plain message. `pots status` and `pots doctor` now name this command when wake-ups are off by your choice, and `pots uninstall` works after either choice.
- `pots doctor` no longer fails after `Disable-Resume.cmd`: it says wake-ups are off by your choice, runs no self-test and exits 0.
- The Claude Desktop tool text says a task waits up to 24 hours, as the program does.
- The coordinator instructions, the tool texts and the documentation now name the `EXPIRED` line too, so a queued task that ran out of time is reported to you. Instruction files of the earlier 0.2.23 build are updated in place.
- When old wake-up files cannot be checked, the install now says so (and skips the wake-up test) instead of printing that no Claude Code or Codex was found.
- `bridge_lanes_status` no longer returns the OMP session id to the assistant, and the wake-up prompt no longer contains it.
- A repeated `pots install` says "its program files were not changed" instead of "nothing was changed", because the choices of that run are still applied.
- A PC with only Claude Code is no longer told to paste ChatGPT instructions.
- A finished lane no longer shows as failed (`end_not_matched_to_message`) when OMP went on after a failed model call (for example an advisor note started another turn that failed and was retried). The task still counts as done only on the real final end of the run.
- A task that was stored is no longer reported as "prompt delivery not confirmed" because listing the plans failed once or twice for a moment. When the plan list cannot be read at all, the message says the task may have been queued and to check `pots status` before queueing it again. When the queue itself refuses a task (it is full, or the text is not accepted) you now read that reason, and no failed lane start is recorded; a queue write that fails at the disk (for example disk full) does leave a failed lane start.
- A PC with 17 or more connected lanes no longer stops the wake-ups for good when 17 or more lanes finish in one check. The watchdog log accepts what the program can really write, and `pots install` repairs a log an earlier test build had already damaged this way.
- A watchdog lock left behind by a crash or restart no longer blocks the wake-ups when Windows has given the same process number to another program, also with Windows Fast Startup (a "shutdown" that keeps the PC's start time): the next start takes the lock when the watchdog's own log has been silent for a minute or more and stays silent one poll later. A running watchdog, or one that has only just started, is never touched, also after the PC's clock was changed. When the watchdog is still stopped, `pots doctor` names the lock folder and the one step that clears it.
- Two watchdogs that start at the same moment on a lock left behind no longer both run. Exactly one gets the lock, the other backs off, and a watchdog only ever removes its own lock when it stops. Before, both could run, so a wake-up could start a coordinator twice.
- `pots status`, `pots doctor` and the install summary no longer say Claude Code or Codex "was not found" when you chose cloud-only or selected no command-line program. They say what is true and the real next step: a cloud-only choice (`--resume-cli none` together with a cloud choice) is called cloud-only, and `--resume-cli none` with no cloud choice says that you chose none, so nothing was set up. A saved "off" choice next to wake-up files Setup could not switch off says what is really still there (the scheduled task, a running watchdog, and how to stop it); when neither is there it just says wake-ups are off.
- The ChatGPT paste step now follows the ChatGPT desktop app itself, not the Codex folder: a PC with only the Codex command-line program is no longer asked to paste instructions, and one with the app is.
- Turning wake-ups off now says that it also forgets their saved settings (which handoff file to read, check interval, cloud task choice). The handoff file itself is not deleted, and the README, SECURITY.md and the docs now say so. `pots install --no-coordinator-wakeups` leaves the scheduled task alone, and says so, when old wake-up files cannot be checked as Setup's own. `setup-auto --no-coordinator-wakeups` together with a resume option is refused, so off always means off.
- A wake-up file that Setup does not own (one you made, or changed after Setup wrote it) is named in the install result, and `pots uninstall` stops for it, with `--purge` too: it is never moved into the recovery copy and never deleted. Move it out of the install folder and run `pots uninstall` again (`pots uninstall --details` names it).
- `pots status` counts the sessions `pots install` would connect: a session whose project folder holds the install folder is never connected, so it is no longer counted, and a session saved elsewhere that is connected still is.
- The handoff file is made whenever wake-ups are on and its path is the standard one and it is missing, also for a cloud-only setup and also when old wake-up files are left as they are. `pots doctor` checks it for a cloud-only setup too, and for a handoff file at your own path it says to create that file again or run `setup-auto --handoff-file`, instead of a step that changed nothing.
- The cloud-only next step names the values the command accepts (`claude`, `chatgpt` for Codex, or `both`). A program at your own path (`--claude-executable`, `--codex-executable`) that went missing is named with that path and a step that fits.
- A cut-off last line in the watchdog log is repaired by `pots install` also when Setup leaves old wake-up files alone, as long as no watchdog is running.
- A branch or tree change in OMP now also forgets a "late START" that was announced before it, so a true END that arrives after the change is not read as that run.
- The receipt of a plan whose run continues after a failed model call is correct whether OMP sends the next START before the continuing END, after it, or not at all before the true END.
- If the PC lost power in the middle of `pots install` (once or twice in a row), running `pots install` again now repairs it, as the page said it would. Before, it kept saying the wake-up files were left as they are, for ever. This includes a cut-off uninstall list: it is saved in one step now, and a list that was cut off anyway is rewritten by the next `pots install`; `pots uninstall` says to run `pots install` first. A wake-up file you changed is still left alone. Wake-up files are saved in one step too, so a power cut cannot leave half a file or a stray temporary file.
- `pots uninstall` (also `--purge`) no longer stops for what Pi on the Side itself left after a crash or power cut: the `staging` folders of an interrupted update, a `runtime\managed-...` folder an interrupted install moved aside, temporary `<name>.<uuid>.tmp` files of the files Setup saves, a half-made watchdog lock folder, and the empty folders Setup makes (for a launcher, a backup, a project's records or the assistant instructions), and the lone `launch-settings.json` an older version could leave in a launcher folder. Only those exact shapes are accepted; any other file, also inside them, still stops it.
- `pots uninstall --purge` no longer deletes your handoff file for good: it is copied next to the install folder first (`Pi on the Side handoff.md`) and the result names the copy. The copy is made before anything is removed, so if it cannot be made the purge stops with that reason and keeps the scheduled task. Both purge warnings say where the file goes and that anyone who can open that folder can read it.
- If the Windows-window removal is stopped because of a file of yours, or its confirmation window fails or is not answered, wake-ups are switched back on, as the page said. Before, they stayed paused.
- A folder or link named `disabled` in the wake-up folder no longer makes `pots install` fail or silently leave wake-ups off, and no longer stops `pots uninstall` (a link is removed itself, never what it points to). The install and `pots doctor` say it is in the way and what to do.
- A lock file left by a power cut no longer blocks `pots install`, `pots upgrade` and `pots update` for ever when Windows gave its process number to another program after the restart. The message now names the file (`activate.lock`) too. The lock of a run of this version that is still going is never taken because the PC's clock was corrected or moved forward after the PC started (the lock notes how long the PC had been on, which a clock change cannot move; a lock an older version wrote is judged by the clock: after a restart it is taken once it is over 30 minutes old).
- A launcher folder, a backup folder or a project's record folder that Setup had made but not yet filled (the PC lost power, the disk was full), or a launcher folder with only one of its two files, no longer makes `pots install` fail for good or `pots uninstall` stop. The next install fills it in or removes it, and a folder Setup could not finish is taken away again.
- `pots install` says plainly, instead of a bare error code, when it stops at a link or a folder that is not private to you, and what to do. `pots uninstall` says the same in plain words. A link named `disabled` is never opened or followed, by the check or by the install.
- When `pots update install` cannot finish and cannot remove what it had made, it says what to do (delete that folder yourself, then run it again). A `coordinator-instructions` file you changed is kept, and the install says that `pots uninstall` will stop at it until you move or delete it.
- A lane that was asked to switch model and never answered (for example after a power cut) no longer holds all later tasks for ever. After 5 minutes the request stops holding and is never sent. `command-cancel` now also cancels a request that never got its first answer, and an old leftover lock file for a model request is cleared.
- One lane with an over-full event file no longer breaks `bridge_lanes_status` for every lane or stops the wake-ups: that lane alone is shown as "unknown" and needing attention.
- A temporary file left in the state folder by a power cut no longer makes the folder "not a complete bridge setup folder". A file of someone else still does.
- A result is now seen in a project folder with more than 2000 files, and a lane-watch line is no longer lost when its log rotates while it is being read.
- A failed `pots update install` removes the folder it made, so the same command can be run again.
- `pots uninstall` that is stopped because a file or folder is not private (or is a link) no longer switches off the wake-ups first, removes nothing before the checks pass (a link named `disabled` included), and says why in plain words. If the files were already moved to the recovery folder, it names that folder, and any stop after the wake-up task was removed says wake-ups are off until `pots install`, also when only the Installed apps entry could not be removed. A Windows helper that does not finish, a failed Claude Code removal or any other error says what happened and keeps the cause under `--details`; only a file that is really in use reads as "something is using them". This is also what `pots uninstall --purge` prints. Before, it said "something is using them" or showed a bare sentence.
- `pots upgrade` no longer reports a failure when the new version is already in place but Windows still holds the small file `activate.lock`. It waits a moment and, if the file stays, says the upgrade worked and the file is harmless. The text about that lock no longer says it stops OMP from starting: it only stops another update.
- A `Start-OMP.ps1` you changed, alone in its launcher folder, is no longer deleted by `pots install`; the install stops and keeps it, and says which file it is, that it may come from an older version of Setup, and to move or delete it. A lone settings file is removed only when it is exactly what Setup writes.
- `pots cancel` says so in plain words when the task was already cancelled, or when no task has that id (also a mistyped or cut-short id), instead of printing `EEXIST`, `ENOENT` or `invalid record identity`. `pots queue` says in plain words when the queue is full or the text is not accepted.
- `bridge_lane_watch_lines` says "lane watch records differ; inspect locally" when a lane's watch log is damaged, instead of "unexpected error".
- A project no longer stops taking tasks for good after 128 tasks. When its queue is full, the plans of the oldest finished tasks are retired to make room; their receipts stay and a retired id is never accepted again. 128 unfinished tasks still refuse new ones until some finish or are cancelled (OMP must be running to close a cancelled task).
- A `/bridge disable` that fails, or a stop that fails when another OMP session is loaded, no longer leaves the bridge stuck. `/bridge status` says it is faulted, and `/bridge enable` (which no longer asks for setup) tries again: it takes over the leftover lock file of this same session on this PC, so queued tasks start again as soon as the problem is fixed. A lock file of another program is never taken.
- `pots install` and `pots upgrade` work on Node 22.0 and 22.1: the release bundle no longer needs a function that only Node 22.2 has.
- A busy install no longer says another `pots install` is working when it is the assistant connection; it says so and to wait a minute. `pots uninstall` no longer tells you to delete the lock of a Setup run that is going; it says to wait.
- A scanner holding a controller or connections lock file for a moment no longer turns a finished write into an error: the removal is retried briefly.
- The assistant no longer connects a new session while `pots install` is working, and a connection that is unreadable for a moment is no longer taken off the list. A model switch that gets no answer is cancelled with a short retry, and if the cancel still cannot be recorded it says the request may still be sent.
- Test deadlines no longer fail on a busy PC, and two test runs at the same time no longer disturb each other's temporary folders. Old release folders and old result files moved out of the tree; the lane-line format is written once.
- `bridge_receipt` still shows how a finished task ended after its plan was retired (it says "unknown plan id" only when nothing is stored for that id), and `bridge_cancel` says the task already ended. The lists (`pots status`, `bridge_status`, `bridge_lanes_status`) show only plans that are still kept, so a retired task drops out of them; the README and protocol say so.
- `pots enqueue` with an id that was already used says "plan id already used" instead of `EEXIST`.
- A leftover temporary file in the plans folder no longer takes a place in the 128-task queue.
- Write access now moves in every case: when a later install connects only ChatGPT, Claude Desktop becomes read-only too, and when a later install connects only Claude and Claude Desktop is the one that directs, ChatGPT becomes read-only (an edited entry is left alone and named). When Codex's settings cannot be changed in the install that gives Claude Code write access, the install result says Codex still has write access.
- `Disable-Resume.cmd` now really switches wake-ups off after an install that was cut off: the empty note that install left is filled in, so the next `pots install` keeps wake-ups off. An install that is still finishing at that moment no longer removes the note again.
- One damaged `/model` request no longer stops every queued task from starting; only that request is held.
- Two readers of the lane lines that meet a dead lane at the same moment now write one `GONE` line, with its own number, and a peek never writes anything. A lock left behind by a reader that crashed no longer hides that line for good.
- `bridge_cancel` says a task already ended, and writes nothing, only when its receipt really says it ended, also while its plan is still stored. A task that is still running is not called ended because its plan file is missing (it says the task could not be found to cancel), and a damaged receipt is reported as damaged.
- A run of a subagent is never taken as the run of a queued task, and a subagent that starts while a task is starting cannot make that task fail.
- If Claude Code is installed but cannot be connected (its settings file is damaged, someone else's entry is there, or Claude Code refuses), the assistant that could send tasks before keeps that ability. The install result says so when no assistant could be connected.
- `pots uninstall` accepts the install folder in any letter case. The success message names the `pots` command only when Setup added it and this uninstall really deleted it, not when you had already deleted it yourself.
- A brief file-sharing hiccup (for example a virus scanner) while the queue is read no longer stops the bridge for good; a file that stays unreadable still does. A command lock that Windows holds for a moment is removed after a short retry.
- `bridge_lane_watch_lines` and the `watch-lines` command name a lane whose log cannot be read and still show the other lanes. A lane-watch lock stamped more than a minute ahead of the clock counts as left behind.
- An ordinary OMP turn whose end reaches the bridge before its message no longer stops queued tasks for the rest of the session. `/bridge status` and the lane feed (busy) now say when tasks are on hold after a turn the bridge could not match, and the hold ends after the next clean OMP turn or with `/bridge enable` while OMP is idle.
- `/bridge disable` or `/bridge enable` typed while OMP is still starting the bridge is no longer undone by the automatic start.
- A first install whose new folder cannot be made private takes that folder away again, so the next install uses the same folder and never says Setup did not make it. A virus scanner holding the install's small `setup.lock` file at the very end no longer turns a finished install into a bare `EPERM`.
- `pots setup` and `pots init` that cannot make all of their folders (for example the disk is full) remove what they made, so the next try is not refused.
- A lane whose place in the lane lines cannot be saved holds back only that lane's lines that were not shown yet and shows them on the next call. Before, the lines of the lanes before it were lost, and so could lines of that lane. It is now told apart from a lane whose log cannot be read: `watch-lines` prints `<lane> could not save its place, so the lines not shown here will come again next time.` for the first and `<lane> could not be read.` for the second; `bridge_lane_watch_lines` says the same in its `unreadable` answer.
- When Claude Code cannot be read, an assistant that was never connected is told it "was not connected this time", not that it "was left as it is".
- The documentation now matches the program: the `unreadable` answer of the lane lines, where the coordinator command is printed, what `pack-mcpb` prints, `update rollback` taking no `--prerelease`, what happens to an edited `Start-OMP.ps1`, and the case where Claude Code's settings cannot be read.
- A cloud-only wake-up choice (`--resume-cli none` with a cloud task) no longer gives a reminder that tells the cloud task to exit unless a file exists that only the watchdog writes. That reminder has no such rule any more. The cloud task text that comes with a watchdog is unchanged.
- `pots connect` on a folder that already holds other files now stops with a plain sentence before writing anything, and leaves those files alone. Before, it said it had worked and every later command then said "invalid connections registry".
- A coordinator note that is dated a few minutes ahead (for example after the PC clock was set back) now counts as active instead of stopping all wake-ups. A note dated more than five minutes ahead is still refused, and `pots doctor` now names that note's file. It says the note can stop wake-ups, and still shows the advice for any other cause.
- A failed start no longer keeps asking for attention after the model is switched again with `pots model`.
- `controller-create` on a file that already exists says so in plain words, how to keep it or move a session to a new credential (`controller-handoff`), and leaves the file as it is. A missing, an unreadable, a damaged, a folder-or-link and a linked-parent-folder controller credential path are now told apart, and a lost credential file for a session that already has a controller says what really works, with commands that exist, including the stale write lock.
- OMP is still recognized when it prints a banner or a long warning next to its version: the line that is exactly `omp/x.y.z` is used. No such line, or two different version lines, still means it is not OMP.
- A runtime folder that `pots install` moved aside after an interrupted install no longer stops `pots uninstall` for good: the launcher Setup itself left in it is now listed as Setup's own. A file of someone else in that folder still stops it. This also holds when the install stopped right after moving the folder and a later install moved nothing: every such folder whose launcher is Setup's own is listed.
- `bridge_lane_watch_lines` and `watch-lines` now say when more than 100 lines are waiting (`"more": true`, or the line `More lines are waiting. Run this again.`), so a coordinator asks again instead of stopping early. `more` is not set for a lane whose place could not be saved, because asking again cannot help; that lane is still named. The tool text and the docs state the 100-line limit.
- Ctrl+C during `pots install` shows the one stop line and no longer also prints `unexpected error`.
- A credential path that goes through a link, a short `PROGRA~1`-style name or a mapped drive is explained in words that fit all three. A controller lock or owner file that is a folder or a link now gets a plain sentence in `pots status` and `bridge_status` (also from the status check of the owner file), and `pots install` keeps that connection instead of removing it.
- `pots uninstall` says in plain words when a program folder under `runtime` has a pointer but no program files, and that you move that folder out of the install folder yourself.
- A lane that died without a trace gets its `GONE reason=lost` line once, also when its state could not be saved the first time.
- The docs list Claude Desktop as the last directing assistant everywhere, the tester checklist names the receipt states a tester really sees, and a dead link and an already shipped fix in the history file are removed.
- Stopping a lane, the trace guard, the check for new sessions, the wake-up watchdog and a cut-off install now wait out a short Windows hold on their lock file instead of leaving it behind. A supervisor lock left behind that way stopped the lane from starting again.
- When an upgrade cannot put the old version pointer back, the lock it keeps is now marked, and no later upgrade takes it over, so it really stops other upgrades until the pointer is checked and the file `activate.lock` is deleted. The next upgrade says so and what to do. A lock left by a crash is still taken over once its owner is gone.
- `pots upgrade` and `pots start` give the real reason when an upgrade is turned away (the install changed while it was being prepared, or an earlier upgrade left its lock) and the matching next step, not "another update is running, wait".
- A lane that cannot be read wakes the coordinator again the next time it happens, after it was read normally in between. Before, the second time was ignored.
- `bridge_status` with a named connection gives the plain sentence for a controller file that is a folder or a link, like the list does. The lane lists carry only each lane's name and the problem.
- `pots install` that meets a damaged program folder no longer tells you to run `pots uninstall`; it says to run the same command again.
- A runtime folder that an earlier build moved aside is still recognised by `pots uninstall` when a later build with another launcher ran in between. A launcher Setup never shipped is still never accepted.
- `/bridge disable` that cannot remove its lock file (another program holds it for more than two seconds) now says so, `/bridge status` says this session left its lock file behind until the file is deleted, and the next `/bridge enable` takes that lock over. Before, disable said it had stopped and enable then refused the leftover lock. A new lock file that could not be written (for example the disk is full) is taken away again, so the next `/bridge enable` is not refused by it.
- `/bridge enable` and `/bridge disable` now give the reason when the receipt of the running task cannot be saved, when the saved session file changed or belongs to another session, and when the saved settings cannot be read, instead of one general sentence.
- `pots uninstall` removes an Installed apps entry whose folder is already gone, but only when the entry names that folder (letter case does not matter) and the uninstall command Setup wrote for it. An entry of anything else is left alone, and one leftover entry no longer stops the removal of an install that still works. If the folder of a leftover entry is back by the time it would be removed, that working install is left alone and the result says so. Plain `pots uninstall` removes only this install and such leftover entries.
- `pots uninstall --all` is now understood as that option (it was taken as a folder name). On its own it removes nothing: it lists every install that Windows lists, with what happens to its files, and says to add `--confirm-offline` to go ahead. With `--confirm-offline` it removes them all (this install only, when Windows lists none). `pots uninstall` in the help list says the same.
- When `pots uninstall` removed an install and a later one could not be removed, it said "was not removed". It now says which installs were removed and where their files went, which one was not, and how to uninstall again when the `pots` command went with the removed install (Settings > Apps > Installed apps).
- The Claude Code instruction file Setup writes now starts with valid YAML (the description is quoted), so tools that read its header accept it.
- A Claude Code entry left by another install folder no longer makes the assistant you just connected read-only.
- A call of the lane lines returns at most 100 lines again, also after a lane's place could not be saved. What does not fit waits for the next call, and `"more": true` stays on.
- `pots uninstall` explains a lock that an unfinished update kept as exactly that, with the check of `current.json`, like `pots upgrade` and `pots install`. All three name the folder `runtime/current`; so does the sentence for an update that is turned away because another one is running. For any other lock file `pots uninstall` no longer says a crash left it: a running program may be holding it.
- If the mark on the kept upgrade lock cannot be written, it is tried again. If it still fails the result says so: a later update may then take the lock over, so check `current.json` first.
- A wake-up check with nothing to do is no longer ended by a state file that is damaged or cannot be read for a moment.
- Two writers of the lane event log that reach the 32 KiB rotation at the same moment no longer drop rows. If something holds the small guard file of that log for more than two seconds, the program that left it behind removes it at the next write to that lane's log or from a short retry of its own (a few seconds), so the log does not stay frozen until OMP is closed; that program removes only the file it wrote. A guard file that is more than 10 seconds old (a real writer holds it for a few milliseconds) is taken over by the next writer, also when Windows has given its owner's process number to another program, so a leftover guard whose owner is still running no longer stops the log until the PC restarts. A guard younger than 10 seconds whose owner still runs is never removed by another program; a guard whose owner is gone is taken at any age; a guard that cannot be read is left for 30 minutes (or until the PC restarts). A row that could not be written is counted in `dropped` of the next row, together with any count that lost row carried.
- A lane-events writer that was frozen for more than 10 seconds and finds its guard taken over no longer removes the new owner's guard when it continues; it removes only the file it wrote.
- `pots lane restore <name>` continues a lane that a restart or crash stopped, using OMP's `--restore`; it checks the Node version like `start`, waits out a short Windows hold on the leftover lock file, and says plainly when the lane is still running (with what to do when its bridge stopped in that open OMP window) or cannot be continued. `pots status` and `bridge_lanes_status` now report a lane whose running task no bridge is running any more as stopped, and the coordinator wake-up, the resume prompt and the pasted assistant instructions treat it as needing attention and tell the assistant to restore it (or, when its OMP window is still open, to look at it with `/bridge status` and then `/bridge enable`), never to queue a new step on it and never to close its window.
- A lane can be started or restored with `--warn-cost`, `--max-cost` and `--max-time`, passed to OMP. No limit is set unless you give one.

## v0.2.23 - 2026-11-09

### Features

- The install and `pots upgrade` now set up everything the product needs, with no questions. A finished lane could be noticed within seconds but nothing carried that news to an assistant, and the install never said so. Now a scheduled task keeps a small watchdog running (it starts at log-in, is back within 5 minutes if it ever stops, and is never started twice). When a lane finishes and no assistant has been active for 3 minutes, it starts Claude Code or Codex once for that event. The handoff file it reads is made for you. It needs Claude Code or Codex installed; without one the install and `pots doctor` say so in plain words.
- Claude Desktop is connected by the install itself, through its own settings file, so there is no extension to open and no folder to type. Claude Desktop shows the connection the next time it is opened. Uninstall takes back only that one entry.
- `pots doctor` checks every part in plain words (wake-ups on, program found, handoff file, scheduled task, watchdog running, last start) and times a self-test on a throwaway lane that does nothing. It prints PASS or FAIL with the measured seconds and says what it could not prove, then removes the temporary folder it made, also when you press Ctrl+C or close the window. `pots install` and `pots upgrade` run the same self-test at the end, `pots status` shows one line, and every failure is also written to `pots.log` in the install folder.
- `pots upgrade` now finishes the setup of the version it switches to, so assistant connections, the scheduled task and the watchdog are replaced with the new ones, never doubled. `pots uninstall` deletes the scheduled task, and only if it is the install's own.

### Fixes

- A wake-up watchdog that was stopped by a crash or a restart no longer stays stuck: it takes over its old lock when the program that held it is gone. A lock held by a program that is still running is never taken, even if the PC clock was changed. A lock with no readable owner note is cleared after 5 minutes.
- After an upgrade the wake-up watchdog now runs the new version, and one you switched off yourself stays off.
- The old Startup-folder file of earlier versions is removed when it is unchanged, because the scheduled task replaces it.
- Reading the lane watcher's lines no longer fails now and then with "file changed" when it happens to read at the moment the watcher saves its state or its place in the lines.
- Install and uninstall are no longer blocked by a large, linked or unreadable `.claude.json`. Claude Code's file is only opened when the install says it connected Claude Code, files up to 16 MiB are accepted, and an entry that cannot be checked is left alone and reported with the command to remove it. A Claude Code entry that was only reformatted still counts as ours.
- The wake-up watchdog no longer stops for good after about 500 launches: its list of handled events drops the oldest ones, never one that is still current, so nothing is launched twice. If its own safety check ever keeps failing, `pots status` and `pots doctor` show a failing row with the next step.
- `pots install --no-coordinator-wakeups` works as documented. It removes an existing scheduled task, keeps everything else, skips the self-test and says "off by your choice" in the install result, `pots status` and `pots doctor` instead of a false FAIL. The choice sticks: a session saved later and a later plain install keep it, and so does a `--clients` choice. An OMP session that is open keeps its old choice until it is closed (the install says so and still removes the task). Old wake-up files that Setup cannot prove are its own are left alone, and the result says so instead of "off by your choice".
- `pots install` and `pots upgrade` now end with exit code 1 and the plain reason when the wake-up self-test fails.
- `pots uninstall` says it removed the scheduled task only when Windows confirmed it is gone. If Task Scheduler cannot be asked, nothing is removed and it says what to check. Every reason it stops now has a plain sentence and one next step; `pots uninstall --details` adds the technical reason.
- The command-line assistant that a wake-up starts is started with its window hidden.
- Documentation matches what the product does: no `review` command, no OMP download, wake-ups are on by default when Claude Code or Codex is found, and the desktop adapter has seven tools. The verification page now lists only what is true for this version.
- Pressing Ctrl+C, closing the window or stopping `pots install` half way now undoes what it had started (including a scheduled task it had just made), says "Install was stopped. What it had started was undone. Run `pots install` again when you are ready.", and exits with 130, 143 or 129. If the undo itself cannot finish, or connecting your assistants was still running after 10 seconds, it says that part may not be undone and that running `pots install` again is safe. Windows ends a program a few seconds after its window is closed, so a slow undo can be cut short; a program that is killed by force cannot undo anything. In both cases `pots install` run again repairs the half install. Ctrl+C during the final wake-up self-test stops only the test: it prints the install result and says the install is complete.
- `pots install` and `pots upgrade` of an install in a custom folder (`setup-auto --root`) now repeat that install. They no longer make a second install in the default folder or move `pots` to it.
- The one-line installer forces `GH_HOST` to `github.com`, gives each `gh` call a time limit and a size cap, and checks the downloaded size before the checksum. Run as a file it exits with code 1 when it did not install.
- `pots install` and `pots upgrade` after `Disable-Resume.cmd` say that wake-ups are switched off by the owner marker and which file to delete, run no self-test and finish with exit code 0.
- The wake-up self-test limit follows the lane's own quiet time and poll time (it is never shorter than both plus 5 seconds), so a lane set to 30 s polling and 20 s idle no longer fails every install.
- `pots uninstall` is no longer blocked when Claude Code has been uninstalled: it removes the install, leaves the one settings entry and says how to remove it. A blocked uninstall takes its own pause of the watchdog away again, and the scheduled task is removed only after every check has passed.
- An old Startup launcher from an earlier version that was changed after Setup wrote it is kept, named in the install result and in the uninstall result.
- `/bridge enable` restarts a bridge that stopped itself on an error instead of saying it is already running. Turning the bridge off, or its stopping, while a plan is active closes the lane feed with an idle edge (reason `bridge_stopped`), so the lane watcher does not stay busy. A failure that does not stop the bridge says it will try again instead of "stopped on uncertain state". A session of another kind no longer closes a running bridge, and a bridge that cannot be closed cleanly at a new session says so.
- The wake-up watchdog no longer launches a finished event again after other lanes filled its list of handled events, no longer stops when it tracks more than 64 lane rate records (the oldest go), and writes its log through a temporary file. A cut-off last line is skipped; `pots doctor` names it and `pots install` repairs it.
- If Task Scheduler cannot be asked whether the watchdog's task exists, an undo of a stopped install leaves that task alone.
- A task queued behind a long-running task is no longer lost silently. It now keeps waiting for up to 24 hours (the longest a plan may wait; the wait counts, so it cannot run long after you stopped caring) instead of one hour, it still never runs twice, and when its time does run out the lane watcher prints an `EXPIRED plan=<id>` line and `pots status` says "A queued task was not started because the lane stayed busy until its time limit ran out. Queue it again when the lane is free." with the task id.

## v0.2.22 - 2026-11-09

### Features

- Commands only, like OMP. One pasted line installs (`gh release download (gh api 'repos/Jumpstile/pi-on-the-side/releases?per_page=1' --jq '.[0].tag_name') -R Jumpstile/pi-on-the-side -p install.ps1 -O - | iex`, checksum verified). After that `pots` is a real command: `pots install`, `pots upgrade`, `pots status`, `pots instructions`, `pots --version` and `pots uninstall`. Typing `pots` alone lists them. The install line and `pots upgrade` take the newest published release, prereleases included, the same one Start sees. The release is the update bundle, the Claude Desktop extension (`.mcpb`) and `install.ps1`; there is no installer program.
- One install for every OMP session. `pots install` asks nothing: it connects every saved session it finds (newest first, at most 64; projects connected earlier keep their places), and the assistant adapter connects sessions saved later (only when it holds the controller credential). It finds the OMP the install already records when none is on PATH, and says plainly what to install when there is none. An upgrade is never blocked by an open session or a running plan; the result says "Upgraded to X." (or adds "A session is open, so the new version starts with the next session."). Every version runs from the fixed path `runtime\current\bridge.mjs`; old `runtime\managed-...` folders are kept untouched, with a copy of each pointer in the backup folder.
- Claude Code and the ChatGPT desktop app are connected for you. Only one of them can send or cancel tasks. The others can only look.
- The two steps no program can do are one plain next step each: `pots instructions` prints the text to paste into ChatGPT (and says which file holds it), and the Claude Desktop extension step names the exact `.mcpb` file to open and the folder to type.
- A lane status tool shows every lane in one short answer: busy or idle, what is waiting, and whether the assistant should look again soon.
- A small lane watcher notices when a lane goes idle, gets busy again, writes its result files or stops, and prints an `ERROR` line when it cannot read. It uses no model and no network.
- You can switch the model of a lane. Short model names work, and a switch counts only when OMP says the new model is running.
- Updating is one step: `pots upgrade`. If something fails, everything is put back and the old version keeps working. In the rare case that it cannot put the version pointer back, it says so and names the one step that fixes it.
- Install, upgrade and uninstall explain problems in plain words, with the technical details underneath. `pots uninstall` names any file it kept because you changed it.

### Fixes

- A task that runs and finishes normally is now recorded as completed, and the next queued task goes ahead.
- Every task now ends as completed, failed, malformed, aborted or expired, and a failed task says why. There is no "unknown" result to review any more.
- There is no list of supported OMP versions. Every OMP version follows the same rule, and the install keeps the OMP you already have.
- Starting several lanes at the same time no longer fails with "invalid connections registry".
- Install, uninstall and upgrades no longer get stuck on a leftover lock file, an empty backups folder, or files that the install did not write. Your own files are never removed.
- The uninstall program in the install folder starts again.
- A coordinator text file you wrote yourself is never counted as the install's own, so uninstall will not remove it.
- If an install fails part-way, it removes what it just made, so you can run it again.
- A release without the update file (`omp-session-bridge-<version>.zip`) is refused by the updater with a plain reason that names the missing file.
- A skipped saved project is explained in words, not as a system code.
- A saved session that was deleted or changed no longer breaks the status tools or stops new sessions from connecting. That one connection is shown as unavailable, and `pots status` and `pots install` tell you and remove only that connection (never your saved sessions).
- If one assistant app cannot be connected, Pi on the Side is still installed. The result names that app and what to do next.
- `/bridge disable` followed by `/bridge enable` after an ordinary OMP turn no longer leaves queued tasks waiting.
- Uninstall blocked by a leftover OMP lock file now names the file and says to delete only that file. A lock whose program is gone no longer blocks uninstall.
- `pots upgrade` no longer says "Nothing was changed" when the old version pointer could not be put back; it says what happened and the one step to fix it.
- A new version that fails its start check is removed, so the same version number can be published again with fixed files.
- The shared assistant instructions no longer depend on the order the install found the sessions in.
- A tool call that names one deleted connection directly now says which connection it is and to run `pots status`, then `pots install`.
