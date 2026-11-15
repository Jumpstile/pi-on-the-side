#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { plain, readJson } from '../src/control.mjs';
import { RELEASE_FILES } from '../src/update.mjs';

// Builds the folder that is published to npm so the package can be listed in
// the OMP package catalog. The repository's own package.json stays private
// (the in-app updater requires that); this folder gets a public copy of it
// with the catalog fields added. Runtime files only, from the same allowlist
// as the update bundle, plus LICENSE and README.md. Nothing is published here:
// the owner runs `npm publish --access public` inside the folder himself.
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node scripts/pack-npm.mjs <absolute-empty-or-new-output-folder>';
const MESSAGES = new Set([USAGE, 'output must be an absolute path', 'output must be outside the checkout', 'output folder must be empty', 'packaged file too large']);
const fail = message => { throw new Error(message); };

async function build(args) {
  if (args.length !== 1) fail(USAGE);
  const output = args[0];
  if (!path.isAbsolute(output) || output !== path.resolve(output)) fail('output must be an absolute path');
  const relative = path.relative(CHECKOUT, output);
  if (!(relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) fail('output must be outside the checkout');
  try { if ((await fs.readdir(output)).length) fail('output folder must be empty'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const source = await readJson(path.join(CHECKOUT, 'package.json'));
  const { private: _private, runtimeFiles: _runtime, scripts: _scripts, ...rest } = source;
  const files = [...RELEASE_FILES.filter(name => name !== 'package.json'), 'LICENSE', 'README.md'].sort();
  const pub = { ...rest, files };
  for (const name of files) {
    const from = path.join(CHECKOUT, ...name.split('/'));
    if ((await plain(from)).size > 1024 * 1024) fail('packaged file too large');
    await fs.mkdir(path.dirname(path.join(output, ...name.split('/'))), { recursive: true });
    await fs.copyFile(from, path.join(output, ...name.split('/')));
  }
  await fs.writeFile(path.join(output, 'package.json'), JSON.stringify(pub, null, 2) + '\n');
  return { folder: output, name: pub.name, version: pub.version, files: [...files, 'package.json'].sort() };
}

try {
  process.stdout.write(JSON.stringify(await build(process.argv.slice(2)), null, 2) + '\n');
} catch (error) {
  process.stderr.write((error?.constructor === Error && MESSAGES.has(error.message) ? error.message : 'pack failed') + '\n');
  process.exitCode = 1;
}
