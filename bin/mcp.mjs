#!/usr/bin/env node
import { serve } from '../src/mcp.mjs';

// stdout is the JSON-RPC channel: silence console so stray output can never
// corrupt it, and report failures on stderr with fixed text only.
for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table']) console[method] = () => {};
const fatal = () => { process.stderr.write('omp-session-bridge mcp: unexpected error; stopping\n'); process.exit(1); };
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('omp-session-bridge mcp: unsupported node; requires version twenty-two or later\n');
  process.exit(1);
}
// The adapter connects a session saved later by itself, but only with the installer code that sits next to it (the slim
// Claude Desktop extension package has none: the load fails and nothing is connected) and only when it holds the controller
// credential. The installer code is loaded on first use so the adapter starts fast.
let sync;
const sessionSync = async () => { sync ??= (await import('../src/autosetup.mjs')).makeSessionSync(); await sync?.(); };
serve({ sessionSync: process.env.OMP_BRIDGE_CONTROLLER ? sessionSync : undefined });
