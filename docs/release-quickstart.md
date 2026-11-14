# Pi on the Side! - Start here

Pi on the Side! lets your AI assistant (Claude or ChatGPT) send work to your Oh My Pi (OMP) sessions on this PC. One install covers every saved OMP session.

## Install

Open PowerShell and paste this one line:

```powershell
gh release download (gh api --hostname github.com 'repos/Jumpstile/pi-on-the-side/releases?per_page=1' --jq '.[0].tag_name') -R github.com/Jumpstile/pi-on-the-side -p install.ps1 -O - | iex
```

It downloads the newest release, checks its checksum, installs it and sets up everything the product needs: your assistants (Claude Code, Claude Desktop and Codex, whichever are on this PC), a small scheduled task that starts Claude Code or Codex when a lane finishes, and the `pots` command. It prints one sentence that says what happened and what to do next; when wake-ups are on it also runs a self-test and adds PASS or FAIL for them. You need Node.js 22 or newer, OMP and the GitHub CLI (`gh`) logged in (`gh auth login`); the line downloads none of them, and says which one is missing. For automatic wake-ups, Claude Code or Codex should be installed too. There is nothing to pick and nothing to answer.

## Commands

After the install, `pots` is a real command, like `omp`:

- `pots install` - install again or repair, and connect saved OMP sessions that are not connected yet.
- `pots upgrade` - get the newest version, then finish its setup for you (connections, the wake-up watchdog and, when wake-ups are on, the self-test). It never waits for you: if an OMP session is open it says "Upgraded to X. A session is open, so the new version starts with the next session." If anything fails it keeps the version you have.
- `pots doctor` - checks in plain words that an assistant is woken when a lane finishes, and times a test. Anything that is not working is named, with the next step.
- `pots status` - the version, where it is installed, how many sessions are connected, which assistants are set up and whether wake-ups work (`pots status --details` says more).
- `pots lane list` - shows every lane as running or finished, and the lanes you can bring back.
- `pots lane close <name>` - takes a lane that is not running off the list. `pots lane close --finished` takes every finished lane off at once (one lane always stays).
- `pots lane restore <name>` - continues a lane that a restart or crash stopped, or puts a closed lane back and continues it.
- `pots instructions` - prints the text to paste into ChatGPT, and says which file holds it.
- `pots --version` - the version.
- `pots uninstall` - removes Pi on the Side and the `pots` command. Your projects and OMP sessions are not touched.

Type `pots` alone to see this list.

## Use it

1. Open your project with its `Start-OMP.ps1` (in the install folder under `launchers`) and type `START` when it asks. Starting OMP this way is what lets your assistant send work to that project. Do not open the same saved session in another OMP terminal.
2. Ask your assistant for the status of the project, approve one small task, then check the result in OMP. A receipt is an observation, not proof that the task worked.
3. In OMP, `/bridge disable` pauses new work from your assistant and `/bridge enable` resumes it.

## What you may still do once

- **ChatGPT custom instructions** are an account setting that no program can change. Run `pots instructions | clip` to copy them, then paste them once in ChatGPT under Settings > Personalization > Custom instructions.
- **Claude Desktop** loads new connections only when it starts. The install already added the connection; close Claude Desktop completely and open it again once.

## Details

- Windows has the tested path. The installer only changes files it made itself.
- The one program path never changes between versions: `<install folder>\runtime\current\bridge.mjs`. The `pots` command is a one-line `pots.cmd` in the WindowsApps folder that runs it.
- More help: [troubleshooting](https://github.com/Jumpstile/pi-on-the-side/blob/v1.0.1/docs/windows-setup.md#troubleshooting).
