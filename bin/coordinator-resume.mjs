#!/usr/bin/env node
import { runResumeWatchdog } from '../src/coordinator-resume.mjs';

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());
const fatal = () => { process.stderr.write('POTS coordinator resume: safety check failed; nothing further launched.\n'); process.exitCode = 1; };
if (Number(process.versions.node.split('.')[0]) < 22) { process.stderr.write('POTS coordinator resume: this Node.js is too old (it needs Node.js 22 or newer), so nothing was started. Install a newer Node.js, then run pots install.\n'); process.exitCode = 1; }
else {
  process.stdout.write('POTS coordinator resume watchdog (visible, current-user only). Use Disable-Resume.cmd to stop future launches.\n');
  try {
    const result = await runResumeWatchdog(process.argv.slice(2), { signal: stop.signal });
    if (result) process.stdout.write('POTS coordinator resume: ' + result.action + ' (' + result.reason + ').\n');
  } catch { fatal(); }
}
