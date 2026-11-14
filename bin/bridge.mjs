#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// Production dependencies only: real PATH lookup, bounded `--version` probe and
// foreground spawn. No environment variable can attest the host.
process.exitCode = await main(process.argv.slice(2));
