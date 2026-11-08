import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { OWNER } from '../src/core/util.js';
import { goalTimeBoxLimit } from '../src/core/runtime-budget.js';

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
