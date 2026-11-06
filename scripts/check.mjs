import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
async function walk(dir) { const entries = await readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name)))).flat(); }
let failed = false;
for (const file of [...await walk('src'), ...await walk('scripts'), ...await walk('test'), ...await walk('packages/codex-runtime/lib')].filter(f => /\.(js|mjs|cjs)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(file, result.stderr); }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!pkg.dsh?.bundle?.patch || !pkg.exports?.['./client']) { failed = true; console.error('Missing DSH package exports'); }
if (failed) process.exit(1);
console.log('Syntax and package contract checks passed.');
