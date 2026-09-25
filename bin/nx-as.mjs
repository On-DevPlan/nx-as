#!/usr/bin/env node
import { runCli } from '../src/runtime/cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
