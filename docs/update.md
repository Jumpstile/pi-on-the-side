# Optional updates

This is an optional way to check for and apply a newer Pi on the Side! version; everyday setup and use do not require it. See [install](../README.md#install). Normal managed Start, `pots upgrade` and the one-line install (`scripts/install.ps1`) all pick the same release: the newest published one, prereleases included, drafts excluded. Standalone `update` commands retain their stable-only default; add `--prerelease` when using those advanced manual commands. A check offers only a strictly newer version.

## Authority

- **One source.** Only the releases of the repository `Jumpstile/pi-on-the-side` on `github.com`. No repository, host, URL, mirror, token or authentication option exists, and no environment variable changes this.
- **Your existing GitHub CLI login.** Requests go through `gh` (GitHub CLI) with fixed argument vectors, for example `gh api --hostname github.com repos/Jumpstile/pi-on-the-side/releases/latest`. The child runs without a shell, with `GH_HOST=github.com` forced and prompts disabled, under a timeout and an output cap. GitHub CLI uses its existing authentication, including inherited environment settings. The bridge does not retrieve, embed or store tokens and never starts `gh auth login` or creates a grant.
- **Manual commands: stable by default.** Stable follows GitHub's "latest release" (the newest non-draft, non-prerelease release) and requires a `v<semver>` tag without a prerelease suffix. `--prerelease` is an opt-in for `update check`, `update install`, `update apply` and `update migrate`; `update rollback` does not accept it. Start, `pots upgrade` and the one-line install already include prereleases. It lists every release, at most 5 pages of 100. If there could be more, it refuses with `too-many-releases` rather than guess. Only a strictly newer semantic version is offered; nothing is ever downgraded.
- **Integrity, not publisher authentication.** The release and its update asset `omp-session-bridge-<version>.zip` (exactly one asset with that name; other assets such as the .mcpb are ignored) must name exactly this repository on `github.com`/`api.github.com`. The asset must be `uploaded`, at most 4 MiB and carry a GitHub `digest` of the form `sha256:<64 hex>` ([release assets API](https://docs.github.com/en/rest/releases/assets)). The download uses `gh release download <tag> --repo github.com/Jumpstile/pi-on-the-side --pattern <asset> --output -`, GitHub CLI's supported download path. Any redirect to GitHub's asset storage is followed by `gh` itself; the bridge never sees or fetches a URL. The bridge reads at most the declared size from `gh`'s output and requires the exact size and SHA-256. The digest proves that the bytes match what the authenticated metadata describes. It does not independently prove who published them: anyone who can publish releases in that repository is trusted.
- **Exact bundle.** The stored-only update ZIP contains exactly the files its own `package.json` declares in `runtimeFiles`, plus nothing else. That list travels inside every release, so a release may add or remove runtime files. A bundle is refused for an undeclared extra file, a declared file that is missing, a declared name that is not a runtime-shaped file (only `NOTICE.md`, `SECURITY.md`, `package.json` and `.mjs`/`.ts` files directly under `bin/`, `src/` or `extension/` qualify), or a missing file the launcher needs. A bundle that declares no list must carry exactly the list of the running version. The archive is also refused for traversal, absolute or drive paths, backslashes, links or directories, duplicates (including case-folded), compression, encryption, comments or trailing data. An installed version folder is judged by the list in its own `release.json`, so a release that changes the list never blocks an update, an upgrade, a rollback or an uninstall.
- **Static compatibility.** Before activation, the bundle must satisfy the runtime's fixed package-metadata contract, including the Node engine field. A mismatch is refused before bundle code runs. This metadata check is separate from probing the currently selected OMP executable and its runtime capabilities.

## Commands

```powershell
node bin/bridge.mjs update check [--prerelease]
node bin/bridge.mjs update install "C:\Private Bridge\managed" [--prerelease]
node "<install folder>\runtime\current\bridge.mjs" update apply "<state-folder>" [--confirm-offline] [--prerelease]
node "<install folder>\runtime\current\bridge.mjs" update rollback "<state-folder>" [--confirm-offline]
node bin/bridge.mjs update migrate "<existing-managed-install>" "<state-folder>" [--confirm-offline] [--prerelease]
```

`<state-folder>` is any connected project's folder, `<install folder>\sessions\<id>`. It is checked and read; an update never writes it.

**`--confirm-offline` is the "do it" switch.** Without it, `update apply` downloads, verifies and stages the new version (`staged`) and `update rollback` only verifies the retained version (`rollback-ready`); nothing is switched. With it, the version pointer is switched. The name is historical: it does **not** require OMP to be closed, and a lock or a queued plan never makes `apply` or `rollback` refuse. `start` still asks you to be sure that no other OMP window has that saved session; that is a different question (two OMP copies on one saved session can mix up work).

Each command prints JSON with a `status`, the `current` version and a fixed `note`; `gh` output is never relayed. The exit code is 0 for `up-to-date`, `update-available`, `no-releases`, `staged`, `installed`, `activated`, `rollback-ready` and `rolled-back`, and 1 otherwise.

| Status | Meaning |
| --- | --- |
| `gh-missing` | `gh` not on PATH |
| `auth-missing` | `gh` has no usable `github.com` login (exit 4 or HTTP 401). Log in with GitHub CLI yourself if you want updates |
| `no-access` | HTTP 403/404: the login cannot read this repository |
| `unavailable` | offline, timed out or another `gh` failure |
| `no-releases` | no eligible release (stable: no full release; prerelease: none at all) |
| `invalid-release`, `missing-digest`, `too-many-releases` | metadata refused. `invalid-release` for a release without its update file also carries a plain `detail`, for example `This release has no update file named omp-session-bridge-<version>.zip` |
| `download-failed`, `digest-mismatch`, `invalid-bundle`, `incompatible` | download or bundle refused; nothing staged |
| `stage-failed` | staging failed, or the new version did not pass its start check. The staged folder is removed (only if every file in it is still exactly what this run wrote), so the same version number can be published again with fixed files |
| `conflict` | a different folder already exists for that version; left untouched |
| `deferred` | another update or rollback holds the install lock, the install changed while this one ran, or an earlier update left its lock to be checked (see `reason`) |
| `activation-failed` | switching the pointer failed and the original pointer is back in place |
| `activation-failed-unrestored` | switching failed and the original pointer could not be put back; the install lock is kept (see [recovery](#rollback-and-recovery)) |

All of these keep the current version, except `activation-failed-unrestored`: there the pointer may already name the new version, so follow [recovery](#rollback-and-recovery). `pots upgrade` says so in plain words and names the one step.

## Release checklist: attach the update file

The updater accepts a release only if it carries **exactly one** asset named `omp-session-bridge-<version>.zip`: the stored-only update bundle of runtime files. The `.mcpb` is not an update file; a release with only it is refused with `invalid-release` and the `detail` above, so nobody can update to it through the bridge, and managed Start never offers it. When building a release:

1. `node scripts/pack-mcpb.mjs --release <absolute omp-session-bridge-<version>.zip>` builds the update bundle `omp-session-bridge-<version>.zip` (the runtime files only); `node scripts/pack-mcpb.mjs <absolute omp-session-bridge-<version>.mcpb>` builds the Claude Desktop extension. Each prints JSON with `sha256` and `bytes` of the file it made and `files` (the `path` and `sha256` of every file inside); the file name is the one you gave it. Neither file is overwritten.
2. Upload all three files to the release: the update bundle, the `.mcpb` and `scripts/install.ps1`. GitHub then adds the `sha256:` digest the updater needs. The one-line install downloads `install.ps1` from the newest release, so a release without it breaks that line.
3. Check from an older install: `node bin/bridge.mjs update check --prerelease` must say `update-available`, not `invalid-release`.

## One managed install for every session

Setup keeps **one** managed install, shared by every connected project, at `<install folder>\runtime\current`. Its launcher path, `<install folder>\runtime\current\bridge.mjs`, is the same for every version; scripts and assistant settings may call it forever. Its initial digest is the SHA-256 of a deterministic local runtime ZIP, not evidence of a GitHub download or publisher signature. Local MCP settings use that same file with the `mcp` argument. No state, controller or credential is replaced by an update.

```
runtime/current/bridge.mjs            fixed launcher, written once
runtime/current/current.json          {"version":1,"current":"0.2.1","previous":"0.2.0"}
runtime/current/versions/<version>/   read-only files plus release.json (digest and per-file SHA-256)
runtime/current/staging/              private temporary folders
```

A version is written to a fresh `staging/<random>` folder, marked read-only and published with one rename. An existing version folder is never modified: it is reused only if it verifies with the same digest. Old versions are never deleted automatically. Code, the install pointer and bridge state (config, launch metadata, plans, receipts, control records) stay in separate folders. Updates never write bridge state.

Running OMP sessions load `versions/<version>/extension/bridge.ts` and keep those files until they exit. Because a version folder is never edited, an update can happen while sessions are open or plans are running, and the next start uses the new version.

**Source checkout.** `update check` works here. `apply` and `rollback` refuse with `running from a source checkout; apply and rollback need the managed launcher (nothing changed)`: a checkout, dirty or not, is never written. Update it with git and review the diff as before.

**`update install <new-folder>`** (advanced) creates a separate managed install in a folder that must not exist, outside the checkout and any state folder. It creates nothing unless the release downloads and verifies.

Managed `start` checks for updates when you run it; there is no daemon, timer, service or scheduled task:

- `start` (preview) checks published stable releases and prereleases and stages a newer verified version. It reports `update` in the preview and activates nothing.
- `start --confirm-offline` activates a staged or newly verified version, then exits **without launching OMP**: the running process already has the old code loaded. Rerun the same command to launch the new version.
- A failed check (`gh-missing`, `auth-missing`, `unavailable`, ...) or a `deferred` apply prints a one-line status and launches the current version.

**Claude Desktop extension (MCPB).** Claude Desktop manages installed extensions. The updater cannot replace an installed `.mcpb` and does not claim to. The `.mcpb` contains no update code, and its tools give no update authority. Updating the desktop adapter means installing the newer private package through Claude Desktop's own install prompt (open the new `.mcpb` file with Claude Desktop), after owner approval.

## What apply and rollback do

A confirmed `update apply`, `update rollback` or `update migrate`:

1. Creates `<managed>/activate.lock` exclusively, or reports `deferred` (`another update or rollback is running`). This lock is the only thing that stops two updates running at once. It is never stolen, except when its owner process is gone, or the PC has been restarted since it was written (the lock notes how long the PC had been on, so a process number that belongs to another program since the restart is not mistaken for the owner, and a corrected clock cannot make a running update look old). A lock written by an older build does not note that, so after a restart it is stolen only once it is also over 30 minutes old. A lock that names no owner is stolen when it was written before the PC last started or is over 30 minutes old. A lock that an update kept because it could not put the pointer back is marked and is never stolen, whatever its age or owner (see [Rollback and recovery](#rollback-and-recovery)). The message names the file `activate.lock`; if no update is running, delete only that file.
2. Checks that the pointer is still what it was when the command began (otherwise `deferred`, `install changed during update`).
3. For `apply`: downloads, checks the sha256 digest and stages the new version if needed. Any failure stops here with the pointer untouched.
4. Verifies the target version folder against its `release.json`.
5. Replaces `current.json` atomically (temporary file, fsync, rename) with `previous` set to the old version. If that fails, the original bytes are written back.
6. Removes the lock, retrying briefly while Windows or a scanner still has the file open. If it still cannot be removed, the switch has already happened and counts as done: the result carries `lockLeft: true` and `pots upgrade` says the upgrade worked and the harmless file `activate.lock` can be deleted. Receipts, plans, config and launch metadata are byte-identical before and after.

Nothing here looks at open OMP sessions, locks held by a running bridge or queued plans. This does not make two OMP copies on one saved session safe; that rule belongs to `start`.

## Rollback and recovery

`update rollback "<state-folder>"` checks that the retained `previous` version still matches its `release.json` exactly (same files, same hashes, compatible `package.json`) and reports `rollback-ready`. With `--confirm-offline` it swaps `current` and `previous`. It reports `no-previous` or `verification-failed` when it cannot.

If replacing the pointer fails, the original `current.json` bytes are written back, the lock is released and the status is `activation-failed`. If the original cannot be restored, the status is `activation-failed-unrestored` and the install lock `activate.lock` is **kept** and marked, so no other update or rollback can take it over until you have checked and deleted it. If the mark cannot be written (it is tried three times), the result says so: the lock is then an ordinary one that a later update can take over once its owner is gone, so check `current.json` yourself before updating again. The lock does not stop the launcher: it starts whichever version `current.json` names, so check that file first. Recovery is manual: check that `current.json` names an existing version folder (`update rollback` without `--confirm-offline` verifies `previous`), repair the pointer from the reported versions if necessary, then remove only that one lock file. A crash during activation leaves an ordinary lock, not a marked one: the next update takes it over once its owner is gone, and the pointer is replaced in one step, so it names one version or the other. See also [offline recovery](operations.md#plans-that-did-not-complete-and-recovery).

## Limits

- Prereleases are explicitly marked on GitHub. Production update activation against a live GitHub release remains unverified; offline fixtures cover the documented API and `gh` behavior. Managed Start, `pots upgrade` and the one-line install include published prereleases; manual stable checks still need `--prerelease`.
- The integrity check depends on GitHub's asset digest and on `gh`'s TLS and redirect handling. It is not a code signature.
- Read-only file attributes and the folder layout show intent, not an ACL. A same-account writer can change any of these files. Restrict the install folder to your account as you do the state folder.
- Automatic apply happens only through the managed launcher's confirmed `start` or an explicit confirmed `apply`. It is not available for a source checkout or the desktop extension.

## Repository rename and existing installs

The repository is now `Jumpstile/pi-on-the-side`. GitHub's authenticated old-slug release API still resolves, but returned release and asset URLs use the new slug. Updaters distributed in v0.2.1 and earlier pin the old slug and reject that metadata as `invalid-release` when an eligible release is considered. They do not silently adopt another endpoint; the current runtime remains available. A future release with the new canonical endpoint needs a reviewed manual install to restore update discovery. Historical tags and download bytes are unchanged; commands, package IDs, credentials, saved bindings and state paths are unchanged.

## Upgrading with Setup

To upgrade, run `pots upgrade` (or `pots install` from a newer release's bundle). It works in one step, with no "install alongside" and no manual migration. A running session or plan never blocks it. After the new version is active, `pots upgrade` runs that version's own `install` once, so assistant connections, the wake-up scheduled task and the watchdog are replaced with the new ones (never doubled), and the wake-up self-test result is printed as the last line; if that last step fails it says so and names `pots install`. Upgrading from 0.2.22 or earlier uses the old version's `pots upgrade`, which only switches the version: after it, run `pots upgrade` once more (it reports the version is already newest and finishes the setup) or paste the install line. Setup says one of:

- `Upgraded to X.`
- `Upgraded to X. A session is open, so the new version starts with the next session.`
- `Installed Pi on the Side X.` (nothing was installed before)
- `Pi on the Side X is already installed; its program files were not changed.` (the same version again; what you asked for in that run, such as `--no-coordinator-wakeups`, is still applied and reported after it)
- `A newer version (X) is already installed and was kept.` (Setup never downgrades)

Order of events:

1. **Add the new version beside the old one.** Setup writes the new version into `runtime\current\versions\<new>`, checks every file against its list and hashes, and runs a start check (the new copy's own command line and MCP entry points). Nothing existing is touched. A session that is running keeps using its old files; it is not restarted.
2. **Only then switch what the installer owns:** the single version pointer `current.json` (taken under the install lock, copied into `<install folder>\backups\<timestamp>\` first, replaced atomically, restored if that fails); a launcher an older Setup made for the same project (backed up first); and the assistant connections.
3. **If any step fails, every switched step is undone in reverse**, the old version keeps working and the message says in plain words what happened. If a step cannot be undone (for example the version pointer cannot be written back), the message says which one and what to do; for the pointer, follow [recovery](#rollback-and-recovery). A new folder that failed staging or its start check is removed.

**From 0.2.20 and earlier.** Those versions kept one program copy per session in `runtime\managed-<id>`. The first run of this Setup builds the one shared `runtime\current`, leaves every `managed-<id>` folder exactly as it is, and puts a copy of each of their pointers in the backup folder. Those folders are the way back and are never edited or removed by Setup. Their launcher files are replaced by the new one only when they were made by an older Setup for the same project and are backed up first. A `runtime\current` folder that cannot be read and holds only Setup's own launcher or empty work folders (an interrupted first install) is moved aside, never deleted, and rebuilt; any other unreadable folder there stops Setup unchanged.

Copies of what was replaced are kept in `<install folder>\backups\<timestamp>\`: only files the installer itself wrote (the old pointer, old launcher files, old coordinator text, and the installer's own previous part of an assistant setting). A copy of an assistant app's whole settings file is never made. Each folder carries a manifest (`backup-manifest.json`) with the SHA-256 of every file Setup put there. After a successful run Setup keeps only that run's own copies and deletes the folders of earlier runs, each only if everything in it is exactly what its manifest lists, checked again right before each delete. A folder holding anything else (a file you added, a changed copy, a folder without a manifest) is kept as it is and listed as "left alone". Uninstall recognises the folders and the manifest as owned data.

Other rules:

- Running the same version again changes no program file and makes no backup. Your other choices of that run (for example `--no-coordinator-wakeups`) are still applied.
- The same version number with different files is refused with a plain message; a rebuild always gets a new version number, so `pots upgrade` can move an earlier test build to it.
- Running `pots install` again keeps your earlier choices (coordinator clients, wake-ups, the resume watchdog). To change the wake-up choice, add `--no-coordinator-wakeups` (off) or `--coordinator-wakeups` (on again); both together are refused.
- Only one assistant can send or cancel work. If a later run uses `--clients` to pick a different assistant, the private write-access file moves with the directing assistant: the earlier one stays connected as a read-only viewer. Setup changes the earlier registration only if it is exactly what Setup wrote; otherwise it is kept as it is and listed in the summary with the one setting to remove.
- If one assistant app cannot be connected (for example its settings file cannot be written), Setup still finishes: the new version is installed and the result names that app and the next step (close it, then run `pots install` again). The failed change in that app is undone, so nothing is left half done there.

When an upgrade stops, Setup shows one of these plain messages: the same version with different files; the installed copy failed its file check; the new copy failed its start check (nothing was switched and the previous version keeps working); the new copy could not be written; another update is running or was interrupted; the install changed while Setup worked; or switching failed and the previous version was put back. A second Setup running at the same time is told to wait, and changes nothing.

`update migrate` (preview, then `--confirm-offline`) applies the newest verified release to an existing managed install folder you name. It follows the same lock rules and verification as `update apply`, never edits the old version folders and starts no OMP. Updaters from v0.2.11 and earlier cannot apply a bundle with a changed file list by themselves, which is why `pots install` does the upgrade instead of them.

If you use the Claude Desktop extension, open the new `.mcpb` file with Claude Desktop; it shows its own install prompt, and the configuration fields stay the same. Do not edit version folders or `current.json` by hand to force an upgrade.

### Older copies are left alone

Setup installs a fixed set of program files and replaces them on each upgrade. After a run has installed the new version, passed its start check and connected the assistants to it, Setup only removes the copies of earlier runs from its own `backups` folder, and only those it can prove it wrote itself (checked byte for byte again right before each delete).

- **Not touched:** older version folders stay (the previous version is the rollback target), and so do the `runtime\managed-<id>` folders and any older setup folder, runtime, launcher script, start-up entry or Installed apps entry from another layout. Setup never deletes anything it did not install. Remove such leftovers yourself; Setup lists a folder it found but did not make.
- **Assistants:** a registration that points into an older setup folder is somebody else's to Setup: it is listed with the one step that fixes it, never replaced silently.
- **Uninstall** removes the recorded install only and reports what it left.
