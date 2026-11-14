import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { HelperFailure, runWindowsHelper, runPowerShell, windowsProcessFinder, windowsRegistry, windowsPermissions } from '../src/uninstall.mjs';
import { windowsProcesses } from '../src/live.mjs';
import { diagnostic } from '../src/setup.mjs';

// The Windows helper (powershell.exe) is replaced by a node child that behaves like it: it reads the same script text and
// environment, writes what the script would write, and runs under the REAL execFile limits (timeout, maxBuffer). No real
// PowerShell, registry, process list or install is touched.
const FAKE = String.raw`
const script = process.env.FAKE_SCRIPT, mode = process.env.FAKE_MODE || '';
const out = text => process.stdout.write(text), n = Number(process.env.FAKE_N || 0), k = Number(process.env.FAKE_K || 0);
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'flood') out('x'.repeat(5 * 1024 * 1024));
else if (mode === 'error') { process.stderr.write('#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">Get-CimInstance : Access denied_x000D__x000A_</S></Objs>'); process.exit(1); }
else if (mode === 'garbage') out('this is not json');
else if (script.includes('PI_UNINSTALL_ROOTS')) {
  // Same failure Windows PowerShell 5.1 gives for: @($env:X | ConvertFrom-Json) when X is not set.
  if (process.env.PI_UNINSTALL_ROOTS === undefined) { process.stderr.write('ConvertFrom-Json : Cannot bind argument to parameter InputObject because it is null.'); process.exit(1); }
  const roots = JSON.parse(process.env.PI_UNINSTALL_ROOTS).map(r => r.toLowerCase() + '\\'), pids = [];
  for (let i = 0; i < n; i++) {
    const underRoot = i % 97 === 0, line = (underRoot ? '"C:\\Program Files\\nodejs\\node.exe" ' + process.env.FAKE_ROOT + '\\runtime\\bridge.mjs ' : 'C:\\work\\lane-' + (i % 50) + '\\node.exe ') + 'a'.repeat(k);
    if (roots.some(r => line.toLowerCase().includes(r))) pids.push(1000 + i);
  }
  out(JSON.stringify({ pids }));
}
else if (script.includes('PI_UNINSTALL_BASE')) {
  const apps = []; for (let i = 0; i < n; i++) apps.push(i % 1500 === 0 ? 'PiOnTheSide-' + String(i).padStart(24, '0') : 'Some App ' + i);
  out(JSON.stringify({ roots: apps.filter(a => a.startsWith('PiOnTheSide-')).map(a => 'C:\\Users\\x\\' + a) }));
}
else if (script.includes("Name='omp.exe'")) {
  const rows = []; for (let i = 0; i < n; i++) rows.push({ pid: 100 + i, executable: 'C:\\omp.exe', commandLine: 'omp.exe --session x' + 'a'.repeat(k), createdAt: 1 });
  out(JSON.stringify({ processes: rows }));
}
else { process.stderr.write('unknown script'); process.exit(2); }
`;
const fakeExec = (env = {}, calls = []) => (exe, args, options, callback) => {
  calls.push({ exe, args, options });
  return execFile(process.execPath, ['-e', FAKE], { ...options, env: { ...options.env, FAKE_SCRIPT: args.at(-1), ...env } }, callback);
};
const ROOT = 'C:\\Users\\busy\\AppData\\Local\\OMP Session Bridge Local';

test('the process finder refuses to run without folders instead of asking Windows a question that cannot be answered', async () => {
  const calls = [], finder = windowsProcessFinder({ exec: fakeExec({}, calls) });
  for (const bad of [undefined, null, [], [''], [3], 'C:\\x']) await assert.rejects(finder(bad), { message: 'uninstall refused: process ownership unavailable' });
  assert.equal(calls.length, 0);
});

test('a busy PC: hundreds of processes with multi-KB command lines and thousands of Installed apps entries give the exact answer', async () => {
  const finder = windowsProcessFinder({ exec: fakeExec({ FAKE_N: '600', FAKE_K: '6000', FAKE_ROOT: ROOT }) });
  const pids = await finder([ROOT]);
  assert.deepEqual(pids, [0, 97, 194, 291, 388, 485, 582].map(i => 1000 + i));
  const registry = windowsRegistry({ exec: fakeExec({ FAKE_N: '3000' }) });
  assert.deepEqual(await registry.list(), ['C:\\Users\\x\\PiOnTheSide-' + '0'.repeat(24), 'C:\\Users\\x\\PiOnTheSide-' + '1500'.padStart(24, '0')]);
  const rows = await windowsProcesses({ SystemRoot: 'C:\\Windows' }, { exec: fakeExec({ FAKE_N: '40', FAKE_K: '6000' }) });
  assert.equal(rows.length, 40);
});

test('every kind of helper failure says what failed in plain words and keeps the technical cause under Details', async () => {
  const step = 'check which programs are running from an install folder';
  const run = (env, options = {}) => runWindowsHelper(step, 'powershell.exe', [], { exec: fakeExec(env), ...options });
  const fails = async (promise, kind) => { try { await promise; } catch (error) { assert.ok(error instanceof HelperFailure, String(error)); assert.equal(error.kind, kind); return error; } assert.fail('expected a helper failure'); };
  const slow = await fails(run({ FAKE_MODE: 'hang' }, { timeout: 1000 }), 'timeout');
  assert.match(slow.message, /^Windows did not finish within 1 second when Setup tried to check which programs are running/);
  assert.match(slow.detail, /no answer within 1000 ms/);
  const big = await fails(run({ FAKE_MODE: 'flood' }, { maxBuffer: 4096 }), 'output');
  assert.match(big.message, /^Windows returned more text than Setup can read when it tried to check which programs/);
  assert.match(big.detail, /more than 4096 bytes/);
  const bad = await fails(run({ FAKE_MODE: 'error' }), 'script');
  assert.match(bad.message, /^Windows reported a problem when Setup tried to check which programs/);
  assert.match(bad.detail, /exit code 1: Get-CimInstance : Access denied$/, 'the script\'s own text, without the CLIXML wrapper');
  const missing = await fails(runWindowsHelper(step, path.join(os.tmpdir(), 'no-such-helper-' + process.pid + '.exe'), []), 'start');
  assert.match(missing.message, /^Setup could not start the Windows helper to check which programs/);
  const noWindows = await fails(runPowerShell(step, 'x', { env: {} }), 'start');
  assert.match(noWindows.detail, /SystemRoot is not set/);
  // Beginners read the first line only: no codes, byte counts or script text there.
  for (const error of [slow, big, bad, missing, noWindows]) assert.doesNotMatch(error.message, /exit code|bytes|ENOENT|CLIXML|\bms\b/);
  // The technical text is trimmed.
  const long = await fails(runWindowsHelper(step, 'x', [], { exec: (exe, args, options, callback) => execFile(process.execPath, ['-e', 'process.stderr.write("e".repeat(50000));process.exit(3)'], options, callback) }), 'script');
  assert.ok(long.detail.length < 400, String(long.detail.length));
  // An answer that is not what the question asked for is also a plain failure, not a crash on JSON.
  const finder = windowsProcessFinder({ exec: fakeExec({ FAKE_MODE: 'garbage' }) });
  await assert.rejects(finder([ROOT]), error => error instanceof HelperFailure && error.kind === 'script' && /not valid JSON/.test(error.detail));
});

test('the text for a helper failure is the plain line plus Details; other unknown errors stay generic', async () => {
  const error = new HelperFailure('Windows did not finish within 20 seconds when Setup tried to list the installs in Installed apps.', 'list the installs in Installed apps: no answer within 20000 ms', 'timeout');
  const [first, ...rest] = diagnostic(error).split('\n');
  assert.equal(first, error.message);
  assert.deepEqual(rest, ['Details: ' + error.detail]);
  assert.equal(diagnostic(new Error('boom')), 'unexpected error');
});

test('more OMP programs than Setup can check is reported by name, not as a missing answer', async () => {
  await assert.rejects(windowsProcesses({ SystemRoot: 'C:\\Windows' }, { exec: fakeExec({ FAKE_N: '65', FAKE_K: '10' }) }),
    error => error instanceof HelperFailure && /65 running OMP programs/.test(error.message) && /list the running OMP programs/.test(error.detail));
  await assert.rejects(windowsProcesses({ SystemRoot: 'C:\\Windows' }, { exec: fakeExec({ FAKE_MODE: 'garbage' }) }), error => error instanceof HelperFailure && error.kind === 'script');
});

test('a permission check that could not run is not reported as a folder that needs review', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-helper-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const permissions = windowsPermissions({ SystemRoot: path.join(dir, 'no-windows-here') });
  await assert.rejects(permissions.verifyTree(dir), error => error instanceof HelperFailure && error.kind === 'start');
  await assert.rejects(permissions.verify(dir), error => error instanceof HelperFailure && error.kind === 'start');
});

// The folder check never opens a link. The link named `disabled` (the pause marker) is allowed; any other link is refused.
// A fake Windows folder stops the check right after the link walk, so "could not start" means the walk let the tree through.
test('the permission check lets the pause marker be a link without opening it, and refuses any other link', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-helper-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outside = path.join(dir, 'outside'), root = path.join(dir, 'install'), control = path.join(root, 'coordinator-resume', 'control');
  await fs.mkdir(path.join(outside, 'deeper'), { recursive: true }); await fs.mkdir(control, { recursive: true });
  try { await fs.symlink(outside, path.join(outside, 'deeper', 'inner'), 'junction'); } catch (error) { t.skip(`links cannot be made here (${error.code})`); return; }
  const permissions = windowsPermissions({ SystemRoot: path.join(dir, 'no-windows-here') });
  // The target holds a link of its own: opening `disabled` would find it and refuse.
  await fs.symlink(outside, path.join(control, 'disabled'), 'junction');
  await assert.rejects(permissions.verifyTree(root), error => error instanceof HelperFailure && error.kind === 'start');
  await fs.symlink(outside, path.join(root, 'elsewhere'), 'junction');
  await assert.rejects(permissions.verifyTree(root), error => error.message === 'private permissions require local review');
});
