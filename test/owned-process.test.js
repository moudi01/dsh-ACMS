import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { startOwnedProcess, spawnNode, bounded } from '../src/runtime/owned-process.js';

const tree = fileURLToPath(new URL('./fixtures/owned-tree.mjs', import.meta.url));
const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 5000) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) { if (await fn()) return; await sleep(10); }
  assert.fail('fixture deadline exceeded');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
async function treeRun(t, mode) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'acms-owned-test-'));
  const file = path.join(cwd, 'pids.jsonl'); let pids = [];
  const run = await startOwnedProcess({ argv: [process.execPath, tree, file, mode], cwd, runMs: 10000 });
  run.stdout.resume(); run.stderr.resume(); run.stdin.end();
  t.after(async () => {
    await run.cleanup().catch(() => {});
    // Never signal raw fixture PIDs; wait for containment or the fixture TTL.
    await until(() => pids.every(pid => !alive(pid)), 10000);
    await rm(cwd, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
  });
  await until(async () => {
    try { pids = (await readFile(file, 'utf8')).trim().split('\n').map(s => JSON.parse(s).pid); return pids.length === 3; }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  });
  return { run, pids };
}

test('private Windows job kills real detached child and grandchild; unrelated process survives', windows, async t => {
  const other = spawnNode({ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'] });
  t.after(async () => { other.terminate(); await other.done; });
  let otherEnded = false; other.done.finally(() => { otherEnded = true; });
  const { run, pids } = await treeRun(t, 'hold');
  const before = Date.now(); await run.cleanup();
  assert(Date.now() - before < 6000);
  assert.equal((await run.done).cleanup.confirmed, true);
  assert(pids.every(pid => !alive(pid))); assert.equal(otherEnded, false);
});

for (const mode of ['parent-exit', 'natural-race']) test(`job identity survives ${mode} without root PID lookup`, windows, async t => {
  const { run, pids } = await treeRun(t, mode);
  if (mode === 'natural-race') await run.cleanup();
  const result = await bounded(run.done, 6000, 'test natural exit deadline');
  assert.equal(result.cleanup.confirmed, true); assert(pids.every(pid => !alive(pid)));
});

test('failed CreateProcess produces positive no-root cleanup evidence', windows, async () => {
  const run = await startOwnedProcess({ argv: [path.join(tmpdir(), 'acms-nonexistent-executable.exe')], cwd: process.cwd(), runMs: 1000 });
  run.stdout.resume(); run.stderr.resume(); run.stdin.end();
  const result = await bounded(run.done, 6000, 'test failed launch deadline');
  assert.equal(result.cleanup.confirmed, true); assert.match(result.cleanup.reason, /CreateProcess/); assert.notEqual(result.exitCode, 0);
});

test('abrupt host exit closes the control pipe and reaps the real owned tree', windows, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'acms-owned-crash-'));
  const file = path.join(cwd, 'pids.jsonl'); let pids = [];
  const host = spawnNode({ argv: [process.execPath, fileURLToPath(new URL('./fixtures/owned-host.mjs', import.meta.url)), file], cwd });
  host.stdout.resume(); host.stderr.resume(); host.stdin.end();
  t.after(async () => { host.terminate(); await host.done; await until(() => pids.every(pid => !alive(pid)), 10000); await rm(cwd, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  await until(async () => { try { pids = (await readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x).pid); return pids.length === 3; } catch { return false; } });
  host.terminate(); await host.done;
  await until(() => pids.every(pid => !alive(pid)), 3000);
});

// Explicit transport fault injection; this is not process or model evidence.
function injectedSupervisor({ receipt, hang = false, exitCode = 0, terminateError } = {}) {
  return spec => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const done = Promise.withResolvers();
    const socket = connect(`\\\\.\\pipe\\${spec.argv[1]}`);
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(JSON.stringify({ type: 'started', pid: 123 }) + '\n');
      if (receipt) socket.write(JSON.stringify({ type: 'cleanup', exitCode, ...receipt }) + '\n');
      if (!hang) { done.resolve({ exitCode }); if (!receipt) socket.end(); }
    });
    return { stdin, stdout, stderr, done: done.promise,
      terminate() { socket.destroy(); done.resolve({ exitCode: 1 }); if (terminateError) throw new Error(terminateError); },
    };
  };
}
for (const reason of ['TerminateJobObject: Access is denied', 'QueryInformationJobObject: Access is denied', 'job-empty verification deadline exceeded']) {
  test(`unconfirmed native receipt retains diagnostic: ${reason}`, windows, async () => {
    const run = await startOwnedProcess({ argv: ['never-launched'], cwd: process.cwd() }, {
      helperPath: 'injected', cleanupMs: 100, spawn: injectedSupervisor({ receipt: { confirmed: false, reason } }),
    });
    await assert.rejects(run.done, error => error.cleanupUncertain && error.message.includes(reason));
    await assert.rejects(run.cleanup(), { cleanupUncertain: true });
  });
}
for (const spec of [ { exitCode: 7 }, { hang: true }, { receipt: { confirmed: true }, hang: true }, { hang: true, terminateError: 'Access denied' } ]) {
  test(`missing receipt or supervisor exit is bounded: ${JSON.stringify(spec)}`, windows, async () => {
    const run = await startOwnedProcess({ argv: ['never-launched'], cwd: process.cwd() }, {
      helperPath: 'injected', cleanupMs: 100, startupMs: 100, spawn: injectedSupervisor(spec),
    });
    const before = Date.now();
    await assert.rejects(run.cleanup(), { cleanupUncertain: true });
    await assert.rejects(run.done, { cleanupUncertain: true });
    assert(Date.now() - before < 1500);
  });
}

for (const legacyFailure of ['ENOENT', 'nonzero exit', 'timeout']) test(`taskkill ${legacyFailure} cannot affect native job cleanup`, windows, async () => {
  const run = await startOwnedProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: process.cwd() }, {
    spawn: spec => { assert(!/taskkill/i.test(spec.argv[0]), `taskkill must never be used (${legacyFailure})`); return spawnNode(spec); },
  });
  run.stdout.resume(); run.stderr.resume(); run.stdin.end();
  assert.equal((await bounded(run.done, 6000, 'legacy dependency independence')).cleanup.confirmed, true);
});

test('unsupported containment refuses before invoking the spawn service', async () => {
  await assert.rejects(startOwnedProcess({ argv: ['unused'] }, { platform: 'unsupported', spawn: () => assert.fail('must not launch') }), { code: 'PAIRED_CONTAINMENT_UNSUPPORTED' });
});
