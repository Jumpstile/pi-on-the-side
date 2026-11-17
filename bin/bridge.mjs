#!/usr/bin/env node
// An old Node cannot load the program files, so the version is checked first and they load only afterwards.
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('Pi on the Side needs Node.js 22 or newer. Install it from https://nodejs.org, then run the command again.\n');
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.mjs');
  // Production dependencies only: real PATH lookup, bounded `--version` probe and
  // foreground spawn. No environment variable can attest the host.
  process.exitCode = await main(process.argv.slice(2));
}
