import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { OWNER, SYSTEM } from '../src/core/util.js';
import { Company } from '../src/core/domain.js';
import { Store } from '../src/core/store.js';
import { stableActor } from '../src/core/agent-identity.js';
import { goalRuntimeLimit, goalTimeBoxLimit, MAX_GOAL_RUNTIME_MS } from '../src/core/runtime-budget.js';

test('time box limit keeps efficiency box, extension and wrap-up reserve separate', () => {
  const base = { maxGoalRuntimeMs: 1000, goalTimeBoxMs: 600, timeBoxReserveMs: 100 };
  assert.equal(goalTimeBoxLimit({}, base), 600);
  assert.equal(goalTimeBoxLimit({ runtimeExtraMs: 200 }, base), 800);
  assert.equal(goalTimeBoxLimit({}, { maxGoalRuntimeMs: 1000, goalTimeBoxMs: 0, timeBoxReserveMs: 100 }), 900);
  assert.equal(goalTimeBoxLimit({}, { maxGoalRuntimeMs: 1000, goalTimeBoxMs: 0, timeBoxReserveMs: 0 }), null);
  assert.equal(goalTimeBoxLimit({ runtimeExtraMs: 120000 }, { maxGoalRuntimeMs: 1000, goalTimeBoxMs: 0, timeBoxReserveMs: 0 }), null);
  assert.equal(goalTimeBoxLimit({}, { maxGoalRuntimeMs: 1000, goalTimeBoxMs: 5000, timeBoxReserveMs: 0 }), 1000);
});

function exhaust(f, goal = f.goal) {
  f.store.transaction(() => f.store.put('goals', { ...goal, runtimeMs: f.company.policy().maxGoalRuntimeMs + 1000 }));
}
function waitForBudget(f, task) {
  f.engine.block(task, 'budget', '目标执行时间额度已用完', '请增加额度');
  return f.store.list('interactions').find(i => i.taskId === task.id && i.status === 'pending');
}

test('text-only budget replies cannot claim to resume or create another blocking question', async t => {
  const f = await fixture(t); const task = f.task(); exhaust(f);
  const question = waitForBudget(f, task);
  assert.throws(() => f.command('interaction.answer', { id: question.id, answer: '继续' }), { code: 'GOAL_BUDGET_EXHAUSTED' });
  assert.equal(f.store.require('interactions', question.id).status, 'pending');
  assert.equal(f.store.require('tasks', task.id).status, 'blocked');
  assert.equal(f.store.list('interactions').length, 1);
});

test('an explicit extension resumes only that goal budget waits and preserves material and pause gates', async t => {
  const f = await fixture(t);
  const first = f.task(), sibling = f.task({ title: 'Sibling' }), paused = f.task({ title: 'Paused' }), material = f.task({ title: 'Materials' });
  const downstream = f.task({ title: 'Dependent', dependencies: [first.id] });
  const otherGoal = f.command('goal.create', { title: 'Other', description: 'Other', acceptance: 'Other', projectId: f.project.id, plan: false });
  const other = f.task({ goalId: otherGoal.id, title: 'Other goal task' });
  exhaust(f); exhaust(f, otherGoal);
  const question = waitForBudget(f, first);
  for (const task of [sibling, paused, downstream, other]) waitForBudget(f, task);
  f.command('task.pause', { id: paused.id });
  f.engine.block(material, 'human', '缺少材料', '材料齐备后再审查');
  const used = f.store.require('goals', f.goal.id).runtimeMs;
  const policy = f.company.policy();
  const key = randomUUID(), args = { id: question.id, answer: '追加60分钟并继续', additionalRuntimeMs: 3600000 };
  f.command('interaction.answer', args, OWNER, key);
  f.command('interaction.answer', args, OWNER, key);
  const goal = f.store.require('goals', f.goal.id);
  assert.equal(goal.runtimeMs, used);
  assert.equal(policy.maxGoalRuntimeMs + goal.runtimeExtraMs, used + 3600000);
  assert.deepEqual(f.company.policy(), policy);
  assert.equal(f.store.require('goals', otherGoal.id).runtimeExtraMs, undefined);
  assert.equal(f.store.require('tasks', first.id).status, 'ready');
  assert.equal(f.store.require('tasks', sibling.id).status, 'ready');
  assert.equal(f.store.require('tasks', downstream.id).status, 'blocked');
  assert.equal(f.store.require('tasks', paused.id).status, 'paused');
  assert.equal(f.store.require('tasks', material.id).blocker.kind, 'human');
  assert.equal(f.store.require('tasks', other.id).blocker.kind, 'budget');
  assert.equal(f.store.list('interactions').filter(i => i.goalId === f.goal.id && i.kind === 'budget' && i.status === 'pending').length, 0);
  await f.start();
  await until(() => [first, sibling, downstream].every(t => f.store.require('tasks', t.id).status === 'succeeded'));
  assert.equal(f.store.require('tasks', material.id).status, 'blocked');
  assert.equal(f.store.require('tasks', paused.id).status, 'paused');
});

test('invalid or stale budget extensions cannot change the allowance', async t => {
  const f = await fixture(t); const task = f.task(); exhaust(f); const question = waitForBudget(f, task);
  for (const amount of [-1, 0.5, NaN, Infinity, '3600000']) {
    assert.throws(() => f.command('interaction.answer', { id: question.id, answer: '继续', additionalRuntimeMs: amount }));
    assert.equal(f.store.require('goals', f.goal.id).runtimeExtraMs, undefined);
  }
  assert.throws(() => f.command('interaction.answer', { id: question.id, expectedRevision: question.revision + 1, answer: '继续', additionalRuntimeMs: 3600000 }), { code: 'CONFLICT' });
  assert.equal(f.store.require('goals', f.goal.id).runtimeExtraMs, undefined);
  const human = f.task({ title: 'Human gate' }); f.engine.block(human, 'human', 'Missing', 'Provide materials');
  const input = f.store.list('interactions').find(i => i.taskId === human.id);
  assert.throws(() => f.command('interaction.answer', { id: input.id, answer: '继续', additionalRuntimeMs: 3600000 }), { code: 'INVALID_INPUT' });
});

test('a live budget interruption does not start repair and can resume with an explicit extension', async t => {
  const f = await fixture(t); f.adapter.delay = 1800;
  f.command('policy.update', { patch: { maxGoalRuntimeMs: 1000, maxAttempts: 1 } });
  const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).blocker?.kind === 'budget' && !f.store.list('attempts').some(a => a.cleanupPending), 5000);
  assert.equal(f.store.list('tasks').filter(t => t.kind === 'repair').length, 0);
  const interrupted = f.store.list('attempts').find(a => a.taskId === task.id);
  assert.equal(interrupted.status, 'interrupted');
  const question = f.store.list('interactions').find(i => i.taskId === task.id && i.status === 'pending');
  f.adapter.delay = 0;
  f.command('interaction.answer', { id: question.id, answer: '追加时间继续', additionalRuntimeMs: 60000 });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.store.require('attempts', interrupted.id).status, 'interrupted');
  assert.equal(f.store.list('attempts').filter(a => a.taskId === task.id && a.status === 'completed').length, 1);
});

test('an owner can extend a running goal once, with parallel usage and a durable audit', async t => {
  const f = await fixture(t);
  const policy = f.company.policy();
  const first = f.task(), second = f.task({ title: 'Parallel task' });
  const other = f.command('goal.create', { projectId: f.project.id, title: 'Other goal', description: 'Other', acceptance: 'Other', plan: false });
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  f.store.transaction(() => {
    f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 60000 });
    for (const [task, elapsed] of [[first, 10000], [second, 20000]]) {
      f.store.put('attempts', { id: randomUUID(), taskId: task.id, goalId: task.goalId, startedAt: new Date(now - elapsed).toISOString(), status: 'running' });
    }
  });
  const before = f.store.require('goals', f.goal.id);
  const args = { id: before.id, expectedRevision: before.revision, additionalRuntimeMs: 3600000 };
  const requestId = randomUUID();
  const saved = f.command('goal.runtime.extend', args, OWNER, requestId);
  assert.equal(goalRuntimeLimit(saved, policy), policy.maxGoalRuntimeMs + args.additionalRuntimeMs);
  assert.equal(saved.runtimeMs, 60000);
  assert.equal(f.store.list('attempts').every(a => a.status === 'running'), true);
  assert.deepEqual(f.company.policy(), policy);
  assert.deepEqual(f.store.require('goals', other.id), other);
  assert.equal(f.store.list('interactions').length, 0);

  const reopened = new Store(f.store.filename);
  try {
    assert.deepEqual(new Company(reopened).command(OWNER, requestId, 'goal.runtime.extend', args, { meta: true }), { value: saved, replayed: true });
    const extensions = reopened.page().entries.filter(e => e.type === 'goal.runtime.extended');
    assert.equal(extensions.length, 1);
    const [event] = extensions;
    assert.equal(event.actor, OWNER.id);
    assert.equal(event.entityId, before.id);
    assert.equal(event.usedMs, 90000);
    assert.equal(event.previousLimitMs, policy.maxGoalRuntimeMs);
    assert.equal(event.nextLimitMs, goalRuntimeLimit(saved, policy));
  } finally { reopened.close(); }
});

test('goal extensions enforce owner authorization, revisions, and the hard limit', async t => {
  const f = await fixture(t);
  const goal = f.store.require('goals', f.goal.id);
  const args = { id: goal.id, expectedRevision: goal.revision, additionalRuntimeMs: 60000 };
  const { credential } = f.command('agentCredential.create', { name: 'Owner delegate', projectIds: [f.project.id] });
  const manager = f.store.require('agents', 'manager');
  f.store.transaction(() => f.store.put('agents', { ...manager, grants: [...manager.grants, 'goal.runtime.extend'] }));
  assert.throws(() => f.command('goal.runtime.extend', args, stableActor(credential)), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('goal.runtime.extend', args, { kind: 'agent', id: manager.id, goalId: goal.id }), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('goal.runtime.extend', args, SYSTEM), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('goal.runtime.extend', { ...args, expectedRevision: undefined }), { code: 'CONFLICT' });
  assert.throws(() => f.command('goal.runtime.extend', { ...args, expectedRevision: goal.revision - 1 }), { code: 'CONFLICT' });
  for (const amount of [0, -1, 0.5, '60000', MAX_GOAL_RUNTIME_MS]) {
    assert.throws(() => f.command('goal.runtime.extend', { ...args, additionalRuntimeMs: amount }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(f.store.require('goals', goal.id), goal);
  f.command('goal.cancel', { id: goal.id });
  assert.throws(() => f.command('goal.runtime.extend', { ...args, expectedRevision: f.store.require('goals', goal.id).revision }), { code: 'GOAL_CLOSED' });
});

test('a direct extension releases only budget waits and keeps paused work and cleanup fences', async t => {
  const f = await fixture(t);
  const budget = f.task(), paused = f.task({ title: 'Paused' }), material = f.task({ title: 'Materials' });
  const cleanup = f.task({ title: 'Cleanup' });
  exhaust(f);
  const question = waitForBudget(f, budget);
  waitForBudget(f, paused);
  f.command('task.pause', { id: paused.id });
  f.engine.block(material, 'human', '缺少材料', '请提供材料');
  const held = f.store.transaction(() => {
    f.store.put('tasks', { ...cleanup, status: 'reconciling' });
    return f.store.put('attempts', { id: randomUUID(), goalId: f.goal.id, taskId: cleanup.id, status: 'reconciling', cleanupPending: true });
  });
  const control = f.command('goal.pause', { id: f.goal.id, afterCurrent: true }).executionControl;
  const before = f.store.require('goals', f.goal.id);
  f.command('goal.runtime.extend', { id: before.id, expectedRevision: before.revision, additionalRuntimeMs: 60000 });
  const extension = f.store.page().entries.find(e => e.type === 'goal.runtime.extended');
  const released = f.store.require('interactions', question.id);
  assert.equal(released.status, 'cancelled');
  assert.equal(released.resolvedByEventSeq, extension.seq);
  assert.deepEqual(f.store.require('goals', f.goal.id).executionControl, control);
  assert.equal(f.store.require('tasks', budget.id).status, 'ready');
  assert.equal(f.store.require('tasks', paused.id).status, 'paused');
  assert.equal(f.store.require('tasks', material.id).blocker.kind, 'human');
  assert.equal(f.store.require('tasks', cleanup.id).status, 'reconciling');
  assert.deepEqual(f.store.require('attempts', held.id), held);
});

test('an extension arriving during a budget abort allows resumption after confirmed cleanup', async t => {
  const f = await fixture(t);
  f.command('policy.update', { patch: { maxGoalRuntimeMs: 60000, maxAttempts: 1 } });
  f.adapter.delay = 10000;
  const settle = Promise.withResolvers(), clean = Promise.withResolvers();
  const originalStart = f.adapter.start.bind(f.adapter);
  f.adapter.start = async input => {
    const activation = await originalStart(input);
    if (f.adapter.calls.length !== 1) return activation;
    activation.result = activation.result.catch(async error => { await settle.promise; throw error; });
    const dispose = activation.dispose;
    activation.dispose = async () => { await clean.promise; await dispose(); };
    return activation;
  };
  const task = f.task();
  try {
    await f.start();
    await until(() => f.adapter.calls.length === 1);
    const first = f.adapter.calls[0];
    f.store.transaction(() => f.store.put('attempts', { ...f.store.require('attempts', first.attempt.id), startedAt: new Date(Date.now() - 65000).toISOString() }));
    await until(() => first.signal.aborted);
    assert.equal(first.signal.reason.code, 'GOAL_RUNTIME_BUDGET');

    const goal = f.store.require('goals', f.goal.id);
    f.command('goal.runtime.extend', { id: goal.id, expectedRevision: goal.revision, additionalRuntimeMs: 60000 });
    f.adapter.delay = 0;
    settle.resolve();
    await until(() => f.store.require('attempts', first.attempt.id).cleanupPending);
    await f.engine.tick();
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(f.store.list('interactions').some(i => i.kind === 'budget'), false);

    clean.resolve();
    await until(() => f.store.require('tasks', task.id).status === 'succeeded');
    assert.equal(f.store.require('attempts', first.attempt.id).status, 'interrupted');
    assert.equal(f.adapter.calls.length, 2);
  } finally { settle.resolve(); clean.resolve(); }
});
