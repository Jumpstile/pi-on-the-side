#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { plain, readJson } from '../src/control.mjs';
import { zip } from '../src/zip.mjs';
import { RELEASE_FILES } from '../src/update.mjs';

// Builds the private .mcpb (a ZIP with manifest.json at its root) or, with
// --release, the update bundle `omp-session-bridge-<version>.zip` from an
// explicit allowlist only: no git metadata, tests, private state, evidence or
// credentials can enter. Entries are stored uncompressed with a fixed
// timestamp so identical sources give an identical archive hash on any Node.
// The .mcpb carries no update code; the update bundle carries runtime code only.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const FILES = ['NOTICE.md', 'SECURITY.md', 'bin/mcp.mjs', 'docs/controllers.md', 'docs/desktop.md', 'manifest.json', 'package.json',
  'src/connections.mjs', 'src/control.mjs', 'src/controller.mjs', 'src/coordinator-heartbeat.mjs', 'src/host.mjs', 'src/lane-status.mjs', 'src/lane-watch.mjs', 'src/mcp.mjs', 'src/setup.mjs', 'src/transcript.mjs'].sort();
const USAGE = 'usage: node scripts/pack-mcpb.mjs <absolute-output.mcpb> | --release <absolute-output.zip>';
const RELEASE_NAME = 'release output must be an absolute omp-session-bridge-<package version>.zip path';
const MESSAGES = new Set([USAGE, RELEASE_NAME, 'output must be an absolute .mcpb path', 'output must be outside the checkout',
  'output folder must exist', 'output already exists', 'packaged file too large']);
const fail = message => { throw new Error(message); };

async function pack(args) {
  const release = args[0] === '--release';
  if (args.length !== (release ? 2 : 1)) fail(USAGE);
  const output = args.at(-1);
  const absolute = path.isAbsolute(output) && output === path.resolve(output);
  if (release) {
    const { version } = await readJson(path.join(CHECKOUT, 'package.json'));
    if (!absolute || path.basename(output) !== `omp-session-bridge-${version}.zip`) fail(RELEASE_NAME);
  } else if (!absolute || !output.toLowerCase().endsWith('.mcpb')) fail('output must be an absolute .mcpb path');
  const relative = path.relative(CHECKOUT, output);
  if (!(relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) fail('output must be outside the checkout');
  try { await plain(path.dirname(output), true); } catch { fail('output folder must exist'); }
  const entries = [];
  for (const name of release ? RELEASE_FILES : FILES) {
    const file = path.join(CHECKOUT, ...name.split('/'));
    if ((await plain(file)).size > 1024 * 1024) fail('packaged file too large');
    entries.push({ name, data: await fs.readFile(file) });
  }
  const bytes = zip(entries);
  let handle;
  try { handle = await fs.open(output, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('output already exists'); throw e; }
  try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); }
  catch (e) { await handle.close().catch(() => {}); await fs.unlink(output).catch(() => {}); throw e; }
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  return { sha256: sha(bytes), bytes: bytes.length, files: entries.map(({ name, data }) => ({ path: name, sha256: sha(data) })) };
}

try {
  process.stdout.write(JSON.stringify(await pack(process.argv.slice(2)), null, 2) + '\n');
} catch (error) {
  process.stderr.write((error?.constructor === Error && MESSAGES.has(error.message) ? error.message : 'pack failed') + '\n');
  process.exitCode = 1;
}
