import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './helpers.js';
import { readCommandCleanup, runContained } from '../src/runtime/host-command.js';
import { cleanupError } from '../src/runtime/owned-process.js';
import { executionOccupancy } from '../src/core/execution-capacity.js';

const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const tree = fileURLToPath(new URL('./fixtures/owned-tree.mjs', import.meta.url));

function configure(f, args) {
  f.command('project.save', { id: f.project.id, checks: [{ id: 'owned', command: 'node', args }] });
  return f.task();
}

async function treePids(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
}

function assertGone(pids) {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

for (const mode of ['task.cancel', 'company.pause', 'host.stop']) {
  test(`delivery check waits for the owned tree to stop on ${mode}`, windows, async t => {
    const f = await fixture(t);
    const file = path.join(f.root, 'tree.jsonl');
    const task = configure(f, [tree, file]);
    if (mode === 'task.cancel') {
      const start = f.adapter.start.bind(f.adapter);
      f.adapter.start = async input => ({ ...await start(input), provider: 'paired:fixture' });
      f.adapter.reconcile = async () => assert.fail('a deliberately discarded result must not be replayed');
    }
    await f.start();
    const pids = await until(async () => {
      const pids = await treePids(file);
      return pids.length === 3 && pids;
    });
    const attemptId = f.store.require('tasks', task.id).activeAttemptId;
    assert.equal(f.store.require('attempts', attemptId).hostCheck.checkId, 'owned');
    if (mode === 'host.stop') await f.engine.stop();
    else f.command(mode, mode === 'task.cancel' ? { id: task.id } : {});
    const expected = mode === 'task.cancel' ? 'cancelled' : 'paused';
    await until(() => f.store.require('tasks', task.id).status === expected &&
      !f.store.require('attempts', attemptId).cleanupPending);
    assertGone(pids);
    assert.equal(f.store.require('attempts', attemptId).hostCheck, null);
    assert.equal(f.store.list('verifications').length, 0);
    assert.equal(f.adapter.calls.length, 1);
  });
}

test('cancelling a recovered result also stops its delivery check', windows, async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'tree.jsonl');
  const task = configure(f, [tree, file]);
  const workspace = await f.workspaces.prepare(task, {});
  await writeFile(path.join(workspace.path, 'deliverable.md'), 'Recovered fixture');
  const attempt = { id: 'recovered-check', taskId: task.id, goalId: task.goalId, agentId: task.agentId,
    taskGeneration: task.generation, role: 'worker', status: 'running', startedAt: new Date().toISOString() };
  f.store.transaction(() => {
    f.store.put('attempts', attempt);
    f.store.put('tasks', { ...task, workspace, status: 'running', activeAttemptId: attempt.id });
  });
  f.adapter.reconcile = async () => ({ status: 'completed', cleanupConfirmed: true, finishedAt: new Date().toISOString(),
    result: { outcome: 'completed', artifacts: [{ path: 'deliverable.md' }] } });
  const startup = f.start();
  const pids = await until(async () => {
    const pids = await treePids(file);
    return pids.length === 3 && pids;
  });
  f.command('task.cancel', { id: task.id });
  await startup;
  assert.equal(f.store.require('tasks', task.id).status, 'cancelled');
  assert.equal(f.store.require('attempts', attempt.id).cleanupPending, false);
  assertGone(pids);
  assert.equal(f.adapter.calls.length, 0);
});

test('contained host command times out with verified cleanup, including descendants', windows, async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'tree.jsonl');
  const cleanupReceipt = path.join(f.root, 'receipt.json');
  const result = await runContained('node', [tree, file], f.root, { timeout: 2000, cleanupReceipt });
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal((await readCommandCleanup(cleanupReceipt)).confirmed, true);
  const pids = await treePids(file);
  assert.equal(pids.length, 3);
  assertGone(pids);
});

test('contained host command records non-start when executable lookup fails', windows, async t => {
  const f = await fixture(t);
  const cleanupReceipt = path.join(f.root, 'receipt.json');
  await assert.rejects(runContained(path.join(f.root, 'missing.exe'), [], f.root, { cleanupReceipt }), { code: 'ENOENT' });
  assert.deepEqual(await readCommandCleanup(cleanupReceipt), { confirmed: true, exitCode: 1, notStarted: true });
});

test('unknown delivery check survives restart and cannot be cleared by a model receipt', async t => {
  const f = await fixture(t);
  const task = configure(f, ['-e', 'process.exit(0)']);
  let receipt, signal, modelLookups = 0, invocations = 0;
  f.adapter.reconcile = async () => {
    modelLookups++;
    return { status: 'stopped', cleanupConfirmed: true, reason: 'simulated model cleanup' };
  };
  f.workspaces.runDeliveryCheck = async (_command, _args, _cwd, options) => {
    invocations++;
    receipt = options.cleanupReceipt;
    signal = options.signal;
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw cleanupError('TerminateJobObject: Access is denied');
  };
  await f.start();
  await until(() => receipt);
  f.command('task.cancel', { id: task.id });
  await until(() => f.store.require('tasks', task.id).status === 'reconciling' && !f.engine.live.size);
  assert.equal(signal.aborted, true);
  await f.engine.stop();
  await writeFile(receipt, JSON.stringify({ confirmed: false, exitCode: 1 }));
  await f.start();
  const saved = f.store.require('tasks', task.id);
  const attempt = f.store.require('attempts', saved.activeAttemptId);
  assert.equal(saved.status, 'reconciling');
  assert.equal(saved.stopRequested, 'cancelled');
  assert.equal(attempt.hostCheck.checkId, 'owned');
  assert.equal(attempt.cleanupPending, true);
  assert.match(attempt.cleanupError, /Access is denied/);
  assert.equal(executionOccupancy(f.store).used, 1);
  assert.equal(modelLookups, 0);
  assert.equal(f.store.list('verifications').length, 0);
  await writeFile(receipt, JSON.stringify({ confirmed: true, exitCode: 1 }));
  await f.engine.recover(task.id);
  assert.equal(f.store.require('tasks', task.id).status, 'cancelled');
  assert.equal(f.store.require('attempts', attempt.id).hostCheck, null);
  assert.equal(executionOccupancy(f.store).used, 0);
  assert.equal(modelLookups, 1);
  assert.equal(invocations, 1);
  assert.equal(f.adapter.calls.length, 1);
});
