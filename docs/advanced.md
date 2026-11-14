# Advanced config-file commands

The [README](../README.md) setup folder is the supported routine path. These earlier commands remain for integrations that manage their own 3-key config and plan files. They do not derive identity from the session file, check the OMP host or record launch metadata.

```powershell
node bin/bridge.mjs init C:\PrivateBridge\state
```

`init` creates a new state root with `plans`, `receipts` and `control`; it never adopts an existing folder. Write the config yourself with the exact saved-session ID and canonical absolute paths (keys exactly `cwd`, `root`, `sessionId`):

```json
{"sessionId":"00000000-0000-4000-8000-000000000001","cwd":"C:\\Projects\\example","root":"C:\\PrivateBridge\\state"}
```

Before any write, create a separate private controller credential, explicitly
acquire this config's session with `controller-acquire <config-file> <credential-file>`,
and set `OMP_BRIDGE_CONTROLLER` for the current CLI process. Advanced enqueue
and abort enforce the same ownership gate as directory CLI and MCP;
status/launch-plan do not acquire ownership. See [controllers](controllers.md).

```powershell
node bin/bridge.mjs launch-plan local-config.json C:\PrivateSessions\example.jsonl
node bin/bridge.mjs enqueue local-config.json plan.private.json
node bin/bridge.mjs status local-config.json
node bin/bridge.mjs abort local-config.json <plan-id>
```

`launch-plan` validates the saved-session header against the config and prints a command specification with `started:false`; it never launches. A manual launch sets `OMP_BRIDGE_CONFIG` to the config path and resumes the same session with `--extension` pointing at `extension/bridge.ts`, after the offline ownership checks in [operations](operations.md). `enqueue` accepts a full plan file (schema in [protocol](protocol.md)), including up to 8 steps and explicit `continueAfterEnd:true` transitions. `abort` is the same future-step cancellation as `cancel`.

`queue`, `status` and `cancel`/`abort` accept either a config file or a setup folder. A setup folder additionally gets full revalidation of its generated metadata and the saved session header on every command.

A setup folder holds `config.json` (the same 3-key schema, usable as `OMP_BRIDGE_CONFIG`), `launch.json` (`version`, absolute `sessionFile` and `executable`), the three record directories and, while a supervisor runs or after a crash, its `supervisor-<sessionId>.lock`. Any other entry, a missing or changed record or a foreign root makes every command refuse with `not a complete bridge setup folder`; a saved session whose header no longer matches gives `transcript identity mismatch`. Files are left unchanged. Interrupted setups are not repaired; choose a new folder.
