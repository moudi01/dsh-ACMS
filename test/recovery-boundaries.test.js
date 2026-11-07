import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './helpers.js';
import { executionIdentity, ExecutionReceipt, readExecution } from '../src/runtime/execution-receipt.js';
import { canReconcileTask } from '../src/core/task-actions.js';
import { spawnNode, bounded } from '../src/runtime/owned-process.js';

const host = fileURLToPath(new URL('./fixtures/blocked-accept-host.mjs', import.meta.url));
const output = { outcome: 'blocked', kind: 'human', reason: 'Explicit state fixture: needs input', question: 'Fixture question?', reversibleDefault: 'Fixture handoff' };
function seed(f, task, extra = {}) {
  const ref = executionIdentity({ id: 'paired:boundary', model: 'state-fixture', persistent: false },
    { mode: 'task', attemptId: 'boundary-attempt', contextKey: 'boundary-context', generation: task.generation, kind: task.kind });
  const a = { id: ref.attemptId, provider: ref.provider, model: ref.model, contextKey: ref.contextKey, kind: ref.kind, execution: ref,
    taskGeneration: task.generation, taskId: task.id, goalId: task.goalId, agentId: task.agentId, role: 'worker', grants: [],
    status: 'running', startedAt: new Date(Date.now() - 1000).toISOString(), ...extra };
  f.store.transaction(() => { f.store.put('attempts', a); f.store.put('tasks', { ...task, status: 'running', activeAttemptId: a.id }); });
  f.adapter.reconcile = old => readExecution(f.dataDir, old);
  return { a, ref };
}

for (const branch of ['human', 'technical-retry', 'technical-repair', 'repair-limit']) {
  for (const crashPoint of ['after-commit', 'before-business-write']) {
    test(`blocked ${branch}: real host exits ${crashPoint}, restart preserves exactly one business effect`, { timeout: 15000 }, async t => {
      const f = await fixture(t);
      f.command('company.pause', { afterCurrent: true }); // recover, but do not execute fixture retry/repair tasks
      let task = f.task();
      task = { ...task, attempts: branch === 'technical-retry' ? 1 : f.company.policy().maxAttempts,
        ...(branch === 'repair-limit' ? { repairs: f.company.policy().maxReworks } : {}) };
      const { a, ref } = seed(f, task);
      new ExecutionReceipt(f.dataDir, ref).finish({ executed: true, output: { ...output, kind: branch === 'human' ? 'human' : 'technical' } });
      const child = spawnNode({ argv: [process.execPath, host, f.store.filename, f.dataDir, a.id, crashPoint], cwd: process.cwd() });
      let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.resume(); child.stdin.end();
      t.after(async () => { child.terminate(); await child.done; });
      const exited = await bounded(child.done, 10000, 'fault host deadline');
      assert.equal(exited.exitCode, 86, stderr);
      const before = f.store.require('attempts', a.id);
      if (crashPoint === 'before-business-write') {
        assert.equal(before.status, 'running'); assert.equal(before.resultAccepted, undefined);
        assert.equal(f.store.list('interactions').length, 0); assert.equal(f.store.list('tasks').length, 1);
        assert.equal(f.store.require('goals', task.goalId).runtimeMs, 0);
      } else {
        assert.equal(before.resultAccepted, true);
        assert.notEqual(f.store.require('tasks', task.id).status, 'running');
      }
      await f.start();
      const saved = f.store.require('tasks', task.id), accepted = f.store.require('attempts', a.id);
      assert.equal(saved.status, branch === 'technical-retry' ? 'ready' : 'blocked');
      assert.equal(accepted.status, 'completed'); assert.equal(accepted.resultAccepted, true);
      assert.equal(accepted.handoff, output.reversibleDefault); assert.equal(accepted.cleanupPending, false);
      if (branch === 'technical-retry') { assert.equal(saved.feedback, output.reason); assert(saved.retryAt); }
      const questions = f.store.list('interactions').filter(i => i.taskId === task.id && i.status === 'pending');
      assert.equal(questions.length, branch === 'human' ? 1 : 0);
      if (branch === 'human') assert.equal(questions[0].question, output.question);
      assert.equal(f.store.list('tasks').filter(t => t.repairOf === task.id).length, branch === 'technical-repair' ? 1 : 0);
      assert.equal(f.store.list('tasks').filter(t => t.kind === 'coordination' && t.coordinationOf === task.id).length, branch === 'repair-limit' ? 1 : 0);
      const elapsed = f.store.require('goals', task.goalId).runtimeMs;
      await f.engine.recover(); await f.engine.tick();
      assert.equal(f.store.require('goals', task.goalId).runtimeMs, elapsed);
      assert.equal(f.store.page(0, 1000).entries.filter(e => e.type === 'attempt.finished').length, 1);
      assert.equal(f.adapter.calls.length, 0);
    });
  }
}

for (const action of ['pause', 'cancel']) for (const receiptStatus of ['stopped', 'completed']) {
  for (const priorStatus of ['running', 'completed']) {
    test(`${action}: ${priorStatus} attempt keeps occupancy until ${receiptStatus} receipt and then applies stop intent`, async t => {
      const f = await fixture(t), task = f.task();
      const { a, ref } = seed(f, task, { status: priorStatus, resultAccepted: priorStatus === 'completed', cleanupPending: true, cleanupUncertain: true });
      if (priorStatus === 'completed') f.store.transaction(() => f.store.put('tasks', { ...f.store.require('tasks', task.id), status: 'blocked' }));
      // Missing receipt is deliberately unknown, regardless of accepted output.
      await f.start();
      assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
      f.command(`task.${action}`, { id: task.id });
      await until(() => !f.store.require('tasks', task.id).recoveryRequested);
      let saved = f.store.require('tasks', task.id);
      assert.equal(saved.status, 'reconciling'); assert.equal(saved.stopRequested, action === 'pause' ? 'paused' : 'cancelled');
      assert.equal(canReconcileTask(saved, f.store.list('attempts')), true);
      assert.equal(f.store.require('attempts', a.id).cleanupPending, true); assert.equal(f.adapter.calls.length, 0);
      // Model/progress text is not evidence. Install only a matching, clean terminal state fixture.
      const receipt = new ExecutionReceipt(f.dataDir, ref);
      receipt.finish(receiptStatus === 'completed' ? { executed: true, output } : null);
      f.command('task.reconcile', { id: task.id });
      await until(() => f.store.require('tasks', task.id).status === (action === 'pause' ? 'paused' : 'cancelled'));
      saved = f.store.require('tasks', task.id);
      assert.equal(saved.stopRequested, null); assert.equal(saved.recoveryRequested, false);
      assert.equal(canReconcileTask(saved, f.store.list('attempts')), false);
      const settled = f.store.require('attempts', a.id);
      assert.equal(settled.cleanupPending, false); assert.equal(settled.cleanupUncertain, false);
      assert.equal(settled.status, priorStatus === 'completed' ? 'completed' : 'interrupted');
      assert.equal(f.store.list('interactions').length, 0); assert.equal(f.store.list('tasks').length, 1);
      await f.engine.tick(); assert.equal(f.adapter.calls.length, 0);
    });
  }
}

for (const action of ['pause', 'cancel']) test(`persisted stopping ${action} across host restart still exposes receipt refresh`, async t => {
  const f = await fixture(t), task = f.task(), { a, ref } = seed(f, task, { status: 'reconciling', cleanupPending: true });
  const target = action === 'pause' ? 'paused' : 'cancelled';
  // Legacy state from an older host's controlTask; no live activation exists.
  const stopping = { ...f.store.require('tasks', task.id), status: 'stopping', stopRequested: target };
  f.store.transaction(() => f.store.put('tasks', stopping));
  assert.equal(canReconcileTask(stopping, f.store.list('attempts')), true);
  f.command('task.reconcile', { id: task.id });
  new ExecutionReceipt(f.dataDir, ref).finish(null);
  await f.start(); await f.engine.tick();
  assert.equal(f.store.require('tasks', task.id).status, target);
  assert.equal(f.store.require('attempts', a.id).cleanupPending, false); assert.equal(f.adapter.calls.length, 0);
});

test('a completed attempt still awaiting cleanup cannot be cancelled as already released', async t => {
  const f = await fixture(t), task = f.task();
  const { a } = seed(f, task, { status: 'completed', resultAccepted: true, cleanupPending: true });
  const saved = f.command('task.cancel', { id: task.id });
  assert.equal(saved.status, 'stopping'); assert.equal(saved.stopRequested, 'cancelled');
  assert.equal(canReconcileTask(saved, f.store.list('attempts')), true);
  assert.equal(f.store.require('attempts', a.id).cleanupPending, true);
});

for (const action of ['pause', 'cancel']) test(`${action} arriving after live acceptance is applied when final cleanup succeeds`, async t => {
  const f = await fixture(t), task = f.task();
  let finishCleanup, starts = 0;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  t.after(() => finishCleanup());
  f.engine.adapter = { start: async () => {
    starts++;
    return { provider: 'paired:state-fixture', result: Promise.resolve(JSON.stringify(output)), dispose: () => cleanup };
  } };
  await f.start(); await until(() => f.store.require('tasks', task.id).status === 'blocked');
  const a = f.store.list('attempts')[0];
  assert.equal(a.resultAccepted, true); assert.equal(a.cleanupPending, true);
  f.command(`task.${action}`, { id: task.id });
  assert.equal(f.store.require('tasks', task.id).status, 'stopping');
  finishCleanup();
  await until(() => f.store.require('tasks', task.id).status === (action === 'pause' ? 'paused' : 'cancelled'));
  assert.equal(f.store.require('tasks', task.id).stopRequested, null);
  assert.equal(f.store.require('attempts', a.id).cleanupPending, false);
  assert.equal(starts, 1);
});
