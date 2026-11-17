import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyShouldStayOff, isCatalogCopy } from '../src/host.mjs';

const A = 'C:\\Users\\x\\AppData\\Local\\OMP Session Bridge Local\\program\\extension\\bridge.ts';
const B = 'C:\\Users\\x\\.omp\\plugins\\node_modules\\omp-session-bridge\\extension\\bridge.ts';

test('a copy in a package folder is recognized as a catalog copy', () => {
  assert.equal(isCatalogCopy(B), true);
  assert.equal(isCatalogCopy(A), false);
  assert.equal(isCatalogCopy('/home/x/node_modules/omp-session-bridge/extension/bridge.ts'), true);
});

test('only one copy runs: the first claim wins, the same copy may restart, a catalog copy yields to the full install', () => {
  assert.equal(copyShouldStayOff({ held: undefined, self: A, catalogCopy: false, fullInstall: true }), false);
  assert.equal(copyShouldStayOff({ held: A, self: A, catalogCopy: false, fullInstall: true }), false);
  assert.equal(copyShouldStayOff({ held: A, self: B, catalogCopy: true, fullInstall: false }), true);
  assert.equal(copyShouldStayOff({ held: B, self: A, catalogCopy: false, fullInstall: true }), true);
  assert.equal(copyShouldStayOff({ held: undefined, self: B, catalogCopy: true, fullInstall: true }), true);
  assert.equal(copyShouldStayOff({ held: undefined, self: B, catalogCopy: true, fullInstall: false }), false, 'a catalog copy alone still runs');
});

test('the extension asks the guard before binding and gives the claim back when it retires', async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, '..', 'extension', 'bridge.ts'), 'utf8');
  const guard = source.indexOf('copyShouldStayOff({');
  assert.ok(guard > 0);
  assert.ok(guard < source.indexOf('bound = settings; trace = new LocalTrace'), 'guard runs before the bridge binds');
  assert.match(source, /delete copyClaim\[COPY_CLAIM\]/);
});
