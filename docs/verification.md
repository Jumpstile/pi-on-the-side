# Verification record

What was checked for this version and what was not. Older run records were removed: they described files and programs that are no longer part of the product.

## Checked by the automated tests (disposable folders and fake scheduled tasks; no real install, registry, GitHub or network)

- Node 26.13.0 on Windows, `node --test` over every test file: 1009 tests, 1009 passed, 0 failed, 0 cancelled, 0 skipped. `npm run check` (syntax check of every Node runtime file; the TypeScript adapter `extension/bridge.ts` is not covered by it and is exercised by the adapter tests instead, which need a Node that strips types) passed. Node 22.0 and 22.1 themselves were not run.
- The install and upgrade path, the `pots` commands, uninstall (recovery, purge, ownership checks, locks, scheduled task), the Claude Code, Claude Desktop and Codex registrations, the lane watcher, the wake-up watchdog (quota, dedupe, event list, lock takeover), the self-test, the MCP adapter and the update bundle.

## Checked once on a real Windows PC (throwaway scheduled tasks, removed afterwards)

- `schtasks /Create /XML` accepts the task XML the installer generates, and the task can be queried, started and deleted.
- `schtasks /End` and `/Delete` do not stop the node program the task started through `wscript`. That is why uninstall and a restart first write the pause marker and wait for the watchdog to exit by itself; they never rely on stopping the task.
- A detached command-line program started with a hidden window still receives its prompt on standard input.
- Task Scheduler's own list shows that a task that was never made is absent, and a 3 MiB `.claude.json` is read.
- Closing the window of a throwaway Node program (its own console window, closed with the window's own close message) runs the program's SIGHUP handler, so the install's stop handler is reached when its window is closed. Windows ends the program a few seconds later.
- `scripts/install.ps1` run as a file exits with code 1 when it did not install; pasted into a window (`iex`) it leaves the window open.

## Not checked

- That a wake-up started with a hidden window shows no window: a throwaway comparison of hidden and shown starts could not tell them apart, so the code only asks Windows to hide it.
- A full install undo when the window is closed (only the stop signal was observed).
- A real Claude Code or Codex being started by the watchdog, a real finished lane waking an assistant, and Claude Desktop reading its settings after an install.
- A real install, upgrade or uninstall on a PC with real sessions, and the real Installed apps list.
- The assistants' behavior in a chat: tool use, approvals and scheduling are theirs.
- That a real `omp.exe` is recognized when it prints a banner or a long warning next to its version: the tests check the rule on sample answers, but the disposable folders cannot make a real `omp.exe`.
