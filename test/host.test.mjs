import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { detectHost, isOmpVersion, ompVersionLine, terminalSignal } from '../src/host.mjs';

// One rule for every OMP version: omitted = finished, true = continuing, false = finished, anything else = malformed.
test('terminalSignal: one version-independent rule', () => {
  assert.equal(terminalSignal({}), false);
  assert.equal(terminalSignal({ willContinue: undefined }), false);
  assert.equal(terminalSignal({ willContinue: false }), false);
  assert.equal(terminalSignal({ willContinue: true }), true);
  for (const value of [null, 'true', 'false', 0, 1, {}, []]) assert.equal(terminalSignal({ willContinue: value }), undefined);
  assert.equal(terminalSignal(undefined), false);
});
test('an OMP executable is recognized by the form of its version answer, whatever the version', () => {
  for (const version of ['omp/0.0.1', 'omp/18.7.0', 'omp/18.18.1', 'omp/99.99.99', 'omp/19.0.0-canary.1']) assert.equal(isOmpVersion(version), true, version);
  for (const version of [null, undefined, '', 'v22.0.0', '18.8.6', 'omp/18.8', 'omp/18.8.6 evil', 'not-omp/18.8.6']) assert.equal(isOmpVersion(version), false, String(version));
});
test('a banner line next to the version is ignored; no version line, or two different ones, is not OMP', () => {
  assert.equal(ompVersionLine('omp/18.7.0\n'), 'omp/18.7.0');
  assert.equal(ompVersionLine('Update available: run omp update\r\nomp/18.7.0\r\n'), 'omp/18.7.0', 'a banner before the version');
  assert.equal(ompVersionLine('omp/18.7.0\nomp/18.7.0\n'), 'omp/18.7.0', 'the same line twice is still one version');
  for (const text of ['', 'v22.0.0\n', 'omp/18.8\n', 'omp/18.8.6 evil\n', 'banner omp/18.8.6\n', 'omp/18.7.0\nomp/18.8.0\n']) assert.equal(ompVersionLine(text), null, JSON.stringify(text));
});
test('host detection fails closed for non-OMP or missing executables', async () => {
  assert.equal(await detectHost(process.execPath), null);
  assert.equal(await detectHost(path.join(os.tmpdir(), 'omp-bridge-missing-executable')), null);
});
