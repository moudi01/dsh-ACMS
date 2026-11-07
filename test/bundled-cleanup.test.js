import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildHost } from '../scripts/host-bundle.mjs';
import { until } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tree = fileURLToPath(new URL('./fixtures/owned-tree.mjs', import.meta.url));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

test('immutable host build publishes a matching content-addressed helper and the bundle locates it', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'acms-bundle-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const built = await buildHost({ root, outDir: directory });
  const source = await readFile(path.join(root, 'src/runtime/owned-job.cs'));
  assert.deepEqual(await readFile(built.resource), source);
  assert.equal(path.basename(built.resource), `owned-job-${createHash('sha256').update(source).digest('hex')}.cs`);
  const bundle = await readFile(built.filename, 'utf8');
  assert(bundle.includes('./' + path.basename(built.resource)));
  assert(!bundle.includes('new URL("./owned-job.cs", import.meta.url)'));
  const repeated = await buildHost({ root, outDir: directory }); assert.equal(repeated.filename, built.filename);
});

for (const mode of ['hold', 'parent-exit', 'natural-race']) test(`bundled runtime proves real child/grandchild cleanup (${mode}) from an isolated dist directory`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'acms-bundle-tree-'));
  // Registered before build too: a restricted build must not leak its directory.
  let run, other, pids = [];
  t.after(async () => {
    await run?.cleanup().catch(() => {}); other?.terminate(); await other?.done;
    await until(() => pids.every(pid => !alive(pid)), 10000);
    await rm(directory, { recursive: true, force: true });
  });
  const built = await buildHost({ root, outDir: directory, entryPoint: 'src/runtime/owned-process.js' });
  // Import the emitted bundle, not the source module. There is no adjacent
  // src/runtime tree, so an unrewritten import.meta.url lookup fails this test.
  const { startOwnedProcess, spawnNode, bounded } = await import(pathToFileURL(built.filename).href);
  other = spawnNode({ argv: [process.execPath, '-e', 'setTimeout(()=>{},8000)'], cwd: directory });
  let otherEnded = false; other.stdout.resume(); other.stderr.resume(); other.stdin.end(); other.done.then(() => { otherEnded = true; });
  const file = path.join(directory, 'tree.jsonl');
  run = await startOwnedProcess({ argv: [process.execPath, tree, file, mode], cwd: directory, runMs: 8000 });
  run.stdout.resume(); run.stderr.resume(); run.stdin.end();
  await until(async () => { try { pids = (await readFile(file, 'utf8')).trim().split('\n').map(s => JSON.parse(s).pid); return pids.length === 3; } catch { return false; } });
  if (mode !== 'parent-exit') await run.cleanup();
  const result = await bounded(run.done, 6000, 'bundled fixture cleanup deadline');
  assert.equal(result.cleanup.confirmed, true); assert(pids.every(pid => !alive(pid))); assert.equal(otherEnded, false);
});
