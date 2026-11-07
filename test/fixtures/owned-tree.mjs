// Real process fixture, never a model response. Every member has a safety TTL.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [file, mode = 'hold', depthText = '0'] = process.argv.slice(2);
const depth = Number(depthText);
appendFileSync(file, JSON.stringify({ pid: process.pid, depth }) + '\n');
setTimeout(() => process.exit(0), 8000);
if (depth < 2) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), file, mode, String(depth + 1)], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
  });
  child.on('error', () => process.exit(2));
  child.once('message', () => {
    if (depth) process.send?.('ready');
    else {
      process.stdout.write('TREE_READY\n');
      if (mode === 'parent-exit') process.exit(0);
      if (mode === 'overflow') process.stdout.write('x'.repeat(2097153));
      if (mode === 'natural-race') setTimeout(() => process.exit(0), 20);
    }
  });
} else process.send?.('ready');
