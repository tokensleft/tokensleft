#!/usr/bin/env node
import { runCli } from '../lib/cli.js';

// node:sqlite (Antigravity / OpenCode) still emits an ExperimentalWarning on
// current Node. Suppress exactly that one; everything else is re-printed in
// Node's one-line default format (attaching a listener removes the built-in
// printer, so the format has to be reproduced here).
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) {
    return;
  }

  const code = warning.code ? `[${warning.code}] ` : '';
  console.error(`(node:${process.pid}) ${code}${warning.name}: ${warning.message}`);
});

runCli().catch((error) => {
  // Expected user-facing errors (bad flags, nothing detected) print as plain
  // messages; unexpected ones keep their stack so bug reports are actionable.
  console.error(error?.friendly ? error.message : error?.stack || String(error));
  process.exitCode = 1;
});
