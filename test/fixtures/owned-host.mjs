// A disposable host used to exercise a real control-pipe loss.
import { startOwnedProcess } from '../../src/runtime/owned-process.js';
import { fileURLToPath } from 'node:url';
const run = await startOwnedProcess({ argv: [process.execPath, fileURLToPath(new URL('./owned-tree.mjs', import.meta.url)), process.argv[2], 'hold'], cwd: process.cwd(), runMs: 10000 });
run.stdout.resume(); run.stderr.resume(); run.stdin.end();
try { await run.done; } finally { await run.cleanup(); }
