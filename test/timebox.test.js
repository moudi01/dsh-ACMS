import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { Company } from '../src/core/domain.js';

const events = f => f.store.page(0, 2000).entries;
const timeboxTasks = f => f.store.list('tasks').filter(task => task.kind === 'coordination' && task.origin?.kind === 'timebox');

test('time box warns the manager once, pauses ordinary dispatch and resumes after the wrap-up decision', async t => {
  const f = await fixture(t); f.adapter.delay = 250;
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000 } });
  const task = f.task({ title: 'Timed work' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  await f.start();
  const warning = await until(() => events(f).find(entry => entry.type === 'goal.timebox.warning'), 15000);
  assert.equal(warning.boxLimitMs, 60000);
  assert.ok(warning.checkpoint.tasks.some(item => item.id === task.id));
  assert.equal(f.store.list('attempts').some(attempt => attempt.taskId === task.id), false);
  assert.equal(f.store.list('interactions').some(interaction => interaction.kind === 'budget'), false);
  const coordination = timeboxTasks(f);
  assert.equal(coordination.length, 1);
  assert.equal(coordination[0].agentId, 'manager');
  const warningEvent = f.store.require('goals', f.goal.id).timeBox;
  assert.equal(warningEvent.coordinationTaskId, coordination[0].id);
  assert.equal(warningEvent.releasedAt, null);
  await f.engine.tick();
  assert.equal(timeboxTasks(f).length, 1);
  await until(() => f.store.require('goals', f.goal.id).timeBox?.releasedAt, 15000);
  assert(events(f).some(entry => entry.type === 'goal.timebox.released'));
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
});

for (const [kind, reserveMs] of [['work', 360000], ['plan', 420000]]) {
  test(`a ${reserveMs} ms reserve covering a 360000 ms cap triggers wrap-up before ${kind} dispatch`, async t => {
    const f = await fixture(t);
    f.command('policy.update', { patch: { maxGoalRuntimeMs: 360000, timeBoxReserveMs: reserveMs } });
    let task;
    if (kind === 'plan') {
      f.command('goal.cancel', { id: f.goal.id });
      const goal = f.command('goal.create', { title: 'Fresh planning goal', description: 'Plan delivery', acceptance: 'Deliver a file',
        projectId: f.project.id, templateId: f.template.id });
      task = f.store.list('tasks').find(item => item.goalId === goal.id && item.kind === 'plan');
    } else {
      task = f.task({ title: 'Work waiting for initial wrap-up' });
    }
    f.command('agent.save', { id: 'manager', status: 'retired' });
    await f.start();
    const warnings = () => events(f).filter(entry => entry.type === 'goal.timebox.warning' && entry.entityId === task.goalId);
    const taskAttempts = () => f.store.list('attempts').filter(attempt => attempt.taskId === task.id);
    await until(() => warnings().length || taskAttempts().length || f.store.require('tasks', task.id).status === 'blocked', 15000);
    const [warning] = warnings();
    assert.ok(warning, 'expected a time-box warning before ordinary dispatch');
    assert.equal(warning.boxLimitMs, 0);
    assert.equal(warning.usedMs, 0);
    assert.ok(warning.checkpoint.tasks.some(item => item.id === task.id));
    assert.equal(f.store.require('tasks', task.id).status, 'ready');
    assert.equal(taskAttempts().length, 0);
    assert.equal(f.store.list('interactions').some(item => item.kind === 'budget'), false);

    const question = f.store.list('interactions').find(item => item.taskId === warning.coordinationTaskId && item.status === 'pending');
    assert.ok(question);
    f.command('agent.save', { id: 'manager', status: 'available' });
    f.command('interaction.answer', { id: question.id, answer: '请负责人决定收尾范围' });
    await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
    assert.equal(f.store.require('tasks', warning.coordinationTaskId).status, 'succeeded');
    assert.ok(f.store.require('goals', task.goalId).timeBox.releasedAt);
    assert.equal(warnings().length, 1);
  });
}

test('hard cap still blocks and does not create a time-box warning', async t => {
  const f = await fixture(t); f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxGoalRuntimeMs: 100000 } });
  const task = f.task({ title: 'Over hard cap' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  await f.start();
  await until(() => f.store.require('tasks', task.id).blocker?.kind === 'budget', 15000);
  assert.equal(timeboxTasks(f).length, 0);
  assert(f.store.list('interactions').some(interaction => interaction.kind === 'budget' && interaction.status === 'pending'));
});

test('missing manager creates one answerable owner gate, then releases after the manager decides', async t => {
  const f = await fixture(t); f.adapter.delay = 200;
  f.command('agent.save', { id: 'manager', status: 'retired' });
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000 } });
  const task = f.task({ title: 'Time box without manager' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  await f.start();
  const gate = await until(() => timeboxTasks(f).find(item => item.status === 'blocked'), 15000);
  const interaction = await until(() => f.store.list('interactions').find(item => item.taskId === gate.id && item.status === 'pending'), 15000);
  await f.engine.tick();
  assert.equal(timeboxTasks(f).length, 1);
  assert.equal(f.store.list('attempts').some(attempt => attempt.taskId === task.id), false);
  f.command('agent.save', { id: 'manager', status: 'available' });
  f.command('interaction.answer', { id: interaction.id, answer: '由负责人决定收尾范围' });
  await until(() => f.store.require('goals', f.goal.id).timeBox?.releasedAt, 15000);
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
});

test('a host restart does not duplicate the time-box warning or owner question', async t => {
  const f = await fixture(t);
  f.command('agent.save', { id: 'manager', status: 'retired' });
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000 } });
  f.task({ title: 'Restart box' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  await f.start();
  await until(() => timeboxTasks(f).some(item => item.status === 'blocked'), 15000);
  await f.engine.stop(); await f.engine.start(); await f.engine.tick();
  assert.equal(timeboxTasks(f).length, 1);
  assert.equal(f.store.list('interactions').filter(item => item.kind === 'assignment' && item.status === 'pending').length, 1);
  assert.equal(f.store.require('goals', f.goal.id).timeBox?.releasedAt, null);
});

test('extensions keep one outstanding time-box decision until it is settled', async t => {
  const f = await fixture(t);
  f.command('agent.save', { id: 'manager', status: 'retired' });
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxGoalRuntimeMs: 360000 } });
  const task = f.task({ title: 'Work waiting for wrap-up' });
  const materials = f.task({ title: 'Keep the goal open' });
  f.engine.block(materials, 'human', 'Missing material', 'Please provide the material');
  const setRuntime = runtimeMs => f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs }));
  setRuntime(120000);
  await f.start();
  const wrapUp = await until(() => timeboxTasks(f).find(item => item.status === 'blocked'), 15000);
  const question = f.store.list('interactions').find(item => item.taskId === wrapUp.id && item.status === 'pending');
  const firstBox = f.store.require('goals', f.goal.id).timeBox;
  const warnings = () => events(f).filter(event => event.type === 'goal.timebox.warning');
  const assertHeld = () => {
    assert.deepEqual(f.store.require('goals', f.goal.id).timeBox, firstBox);
    assert.deepEqual(timeboxTasks(f).map(item => item.id), [wrapUp.id]);
    assert.deepEqual(f.store.list('interactions').filter(item => item.kind === 'assignment' && item.status === 'pending').map(item => item.id), [question.id]);
    assert.equal(warnings().length, 1);
    assert.equal(f.store.list('attempts').some(attempt => attempt.taskId === task.id), false);
  };

  // The first extension raises the threshold to the amount already used. The
  // second raises it beyond current usage while the same decision is still open.
  for (const expectedExtraMs of [60000, 120000]) {
    const goal = f.store.require('goals', f.goal.id);
    f.command('goal.runtime.extend', { id: goal.id, expectedRevision: goal.revision, additionalRuntimeMs: 60000 });
    await f.engine.tick();
    assert.equal(f.store.require('goals', f.goal.id).runtimeExtraMs, expectedExtraMs);
    assertHeld();
  }
  await f.engine.stop(); await f.engine.start(); await f.engine.tick();
  assertHeld();

  f.command('agent.save', { id: 'manager', status: 'available' });
  f.command('interaction.answer', { id: question.id, answer: '请完成本轮收尾决定' });
  await until(() => f.store.require('goals', f.goal.id).timeBox?.releasedAt, 15000);
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
  assert.equal(warnings().length, 1);

  setRuntime(180000);
  const next = await until(() => warnings().find(event => event.boxLimitMs === 180000), 15000);
  assert.notEqual(next.coordinationTaskId, wrapUp.id);
  assert.equal(warnings().length, 2);
});

async function cancelExtendedTimeBox(t) {
  const f = await fixture(t);
  f.command('agent.save', { id: 'manager', status: 'retired' });
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxGoalRuntimeMs: 360000 } });
  const work = f.task({ title: 'Work after a cancelled wrap-up' });
  f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 });
  await f.start();
  const original = await until(() => timeboxTasks(f).find(task => task.status === 'blocked'), 15000);
  const goal = f.store.require('goals', f.goal.id);
  f.command('goal.runtime.extend', { id: goal.id, expectedRevision: goal.revision, additionalRuntimeMs: 120000 });
  await f.engine.stop();
  f.command('task.cancel', { id: original.id, reason: 'Cancel the old wrap-up' });
  const question = f.store.list('interactions').find(item => item.taskId === original.id);
  assert.equal(question.status, 'cancelled');
  assert.equal(f.store.require('tasks', work.id).status, 'ready');
  assert.equal(f.store.list('attempts').length, 0);
  return { f, work, original };
}

test('after restart a cancelled wrap-up below the extended threshold lets ordinary work finish', async t => {
  const { f, work, original } = await cancelExtendedTimeBox(t);
  await f.engine.start();
  await until(() => f.store.require('tasks', work.id).status === 'succeeded', 10000);
  assert.equal(f.store.require('goals', f.goal.id).status, 'succeeded');
  assert.equal(f.store.require('goals', f.goal.id).timeBox, null);
  assert.deepEqual(timeboxTasks(f).map(task => [task.id, task.status]), [[original.id, 'cancelled']]);
  assert.equal(events(f).filter(event => event.type === 'goal.timebox.warning').length, 1);
});

test('at the current threshold a cancelled wrap-up is replaced by one actionable decision', async t => {
  const { f, work, original } = await cancelExtendedTimeBox(t);
  f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 180000 });
  await f.engine.start();
  const replacement = await until(() => timeboxTasks(f).find(task => task.id !== original.id && task.status === 'blocked'), 10000);
  assert.equal(f.store.require('goals', f.goal.id).timeBox.boxMs, 180000);

  // At the same threshold, an older cancelled task with the same key must not be reused.
  f.command('task.cancel', { id: replacement.id });
  const current = await until(() => timeboxTasks(f).find(task => task.coordinationKey === replacement.coordinationKey && task.id !== replacement.id && task.status === 'blocked'), 10000);
  await f.engine.stop(); await f.engine.start(); await f.engine.tick();
  const pending = f.store.list('interactions').filter(item => item.kind === 'assignment' && item.status === 'pending');
  assert.deepEqual(pending.map(item => item.taskId), [current.id]);
  assert.equal(f.store.require('goals', f.goal.id).timeBox.coordinationTaskId, current.id);
  assert.equal(f.store.list('attempts').length, 0);

  f.command('agent.save', { id: 'manager', status: 'available' });
  f.command('interaction.answer', { id: pending[0].id, answer: '请完成收尾' });
  await until(() => f.store.require('tasks', work.id).status === 'succeeded', 15000);
  assert.equal(f.store.require('goals', f.goal.id).status, 'succeeded');
  assert.equal(events(f).filter(event => event.type === 'goal.timebox.warning').length, 3);
  assert.equal(events(f).filter(event => event.type === 'goal.timebox.released').length, 1);
});

for (const requiresRecovery of [false, true]) test(`a running time-box cancellation holds dispatch until ${requiresRecovery ? 'recovery confirms cleanup' : 'dispose confirms cleanup'}`, async t => {
  const f = await fixture(t);
  const finishDispose = Promise.withResolvers();
  const start = f.adapter.start.bind(f.adapter);
  f.adapter.delay = 30000;
  f.adapter.start = async input => {
    const activation = await start(input);
    if (input.agent.id !== 'manager') return activation;
    return { ...activation, async dispose() {
      await finishDispose.promise;
      await activation.dispose();
      if (requiresRecovery) throw new Error('Cleanup receipt is not yet available');
    } };
  };
  let confirmed = false;
  f.adapter.reconcile = async () => confirmed
    ? { status: 'stopped', cleanupConfirmed: true, reason: 'Verified cleanup' }
    : { status: 'unknown', reason: 'Missing cleanup receipt' };
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxGoalRuntimeMs: 360000 } });
  const work = f.task({ title: 'Work after cleanup' });
  f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 });
  try {
    await f.start();
    const original = await until(() => f.adapter.calls.find(call => call.task.origin?.kind === 'timebox'), 15000);
    const originalAttempt = () => f.store.require('attempts', original.attempt.id);
    const manager = f.command('agent.save', { name: 'Replacement manager', role: 'manager' });
    f.command('agent.save', { id: 'manager', status: 'retired' });
    if (requiresRecovery) {
      const goal = f.store.require('goals', f.goal.id);
      f.command('goal.runtime.extend', { id: goal.id, expectedRevision: goal.revision, additionalRuntimeMs: 120000 });
    }
    f.adapter.delay = 10;
    f.command('task.cancel', { id: original.task.id });
    await until(() => f.store.require('tasks', original.task.id).status === 'cancelled' && originalAttempt().cleanupPending);
    await until(() => !f.engine.ticking);
    await f.engine.tick();
    assert.equal(f.adapter.active, 1);
    assert.equal(f.adapter.calls.length, 1);
    assert.deepEqual(timeboxTasks(f).map(task => task.id), [original.task.id]);
    assert.equal(f.store.require('tasks', work.id).status, 'ready');
    assert.equal(f.store.require('tasks', original.task.id).stopRequested, 'cancelled');

    finishDispose.resolve();
    if (requiresRecovery) {
      await until(() => originalAttempt().status === 'reconciling' && !f.engine.live.has(original.attempt.id));
      await f.engine.stop();
      // A previous host could persist the cancelled task without a stop intent
      // if it exited after failure settlement while dispose was still pending.
      const task = f.store.require('tasks', original.task.id);
      f.store.put('tasks', { ...task, status: 'cancelled', stopRequested: null });
      await f.engine.start(); await f.engine.tick();
      assert.equal(originalAttempt().cleanupPending, true);
      assert.equal(f.adapter.calls.length, 1);
      confirmed = true;
      f.command('task.reconcile', { id: original.task.id });
    }
    await until(() => f.store.require('tasks', work.id).status === 'succeeded', 15000);
    assert.equal(originalAttempt().cleanupPending, false);
    assert.equal(f.store.require('tasks', original.task.id).status, 'cancelled');
    const wrapUps = f.adapter.calls.filter(call => call.task.origin?.kind === 'timebox');
    assert.equal(wrapUps.length, requiresRecovery ? 1 : 2);
    if (!requiresRecovery) {
      const replacement = wrapUps[1];
      assert.equal(replacement.agent.id, manager.id);
      assert.equal(replacement.task.coordinationKey, original.task.coordinationKey);
      const cleaned = events(f).find(event => event.type === 'attempt.cleanup.confirmed' && event.entityId === original.attempt.id);
      const claimed = events(f).find(event => event.type === 'attempt.claimed' && event.entityId === replacement.attempt.id);
      assert.ok(cleaned.seq < claimed.seq);
    }
  } finally { finishDispose.resolve(); }
});

test('capacity failure keeps an owner entry and does not stop other goals', async t => {
  const f = await fixture(t);
  f.adapter.delay = 20;
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxTasksPerGoal: 1 } });
  const limited = f.task({ title: 'Task at goal limit' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  const otherGoal = f.command('goal.create', { title: 'Other goal', description: 'Other', acceptance: 'Other', projectId: f.project.id, templateId: f.template.id, plan: false });
  const otherTask = f.task({ goalId: otherGoal.id, title: 'Other work' });
  await f.start();
  await until(() => f.store.require('tasks', otherTask.id).status === 'succeeded', 15000);
  assert.equal(f.engine.lastError, null);
  assert.equal(f.store.list('tasks').filter(task => task.goalId === f.goal.id).length, 1);
  assert.equal(f.store.require('tasks', limited.id).status, 'blocked');
  assert(f.store.list('interactions').some(item => item.taskId === limited.id && item.kind === 'capacity' && item.status === 'pending'));
  assert(f.store.page(0, 1000).entries.some(entry => entry.type === 'goal.timebox.blocked'));
});

test('time-box coordination completion refreshes a goal whose last work already finished', async t => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const f = await fixture(t, async input => {
    if (input.task.kind === 'coordination') { await sleep(700); return { outcome: 'coordinated', summary: '收尾决定' }; }
    return defaultSimulation(input);
  });
  f.adapter.delay = 40;
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000 } });
  const goal = f.command('goal.create', { title: 'Boxed reviewed goal', description: 'Deliver', acceptance: 'Reviewed', projectId: f.project.id, templateId: 'base', plan: false });
  const task = f.task({ goalId: goal.id, title: 'Work finishing before wrap-up' });
  await f.start();
  await until(() => f.store.list('attempts').some(attempt => attempt.taskId === task.id && attempt.status === 'running'), 15000);
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', goal.id), runtimeMs: 120000 }));
  await until(() => f.store.list('tasks').some(item => item.kind === 'coordination' && item.origin?.kind === 'timebox'), 15000);
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 15000);
  await until(() => f.store.list('tasks').some(item => item.origin?.kind === 'timebox' && item.status === 'succeeded'), 15000);
  await until(() => f.store.list('tasks').some(item => item.kind === 'review' && item.goalId === goal.id), 15000);
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 20000);
});

test('capacity entry is attached after an in-flight task fails and becomes attachable', async t => {
  let workRuns = 0;
  const f = await fixture(t, async input => {
    if (input.task.kind === 'work' && workRuns++ === 0) return { outcome: 'blocked', kind: 'technical', reason: 'temporary failure' };
    return defaultSimulation(input);
  });
  f.adapter.delay = 250;
  f.command('policy.update', { patch: { goalTimeBoxMs: 80, maxTasksPerGoal: 1 } });
  const task = f.task({ title: 'Long failing work' });
  await f.start();
  await until(() => f.store.require('goals', f.goal.id).timeBox?.capacityBlocked, 10000);
  await until(() => f.store.require('tasks', task.id).status === 'blocked', 10000);
  const interaction = f.store.list('interactions').find(item => item.taskId === task.id && item.kind === 'capacity' && item.status === 'pending');
  assert.ok(interaction);
  assert(f.store.page(0, 1000).entries.some(entry => entry.type === 'goal.timebox.blocked'));
  assert.equal(f.engine.lastError, null);
  f.command('policy.update', { patch: { maxTasksPerGoal: 2 } });
  f.command('interaction.answer', { id: interaction.id, answer: '提高任务上限后继续收尾' });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
});

test('existing owner question is preserved and capacity retries do not spam events', async t => {
  const f = await fixture(t);
  f.command('policy.update', { patch: { goalTimeBoxMs: 60000, maxTasksPerGoal: 1 } });
  const task = f.task({ title: 'Blocked human task' });
  f.engine.block(task, 'human', 'missing material', 'provide material');
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: 120000 }));
  await f.start();
  await until(() => f.store.page(0, 2000).entries.some(entry => entry.type === 'goal.timebox.blocked'), 10000);
  const before = f.store.page(0, 2000).entries.length;
  await new Promise(resolve => setTimeout(resolve, 400));
  const after = f.store.page(0, 2000).entries.length;
  assert.equal(after, before);
  assert.equal(f.store.list('interactions').filter(item => item.kind === 'capacity').length, 0);
  assert(f.store.list('interactions').some(item => item.taskId === task.id && item.kind === 'human' && item.status === 'pending'));
  assert.equal(f.store.require('tasks', task.id).status, 'blocked');
});

test('old policies without time-box fields normalize to zero and remain savable', async t => {
  const f = await fixture(t);
  const { goalTimeBoxMs, timeBoxReserveMs, ...legacy } = f.store.require('policy', 'company');
  assert.equal(goalTimeBoxMs, 0); assert.equal(timeBoxReserveMs, 0);
  f.store.put('policy', legacy);
  const normalized = new Company(f.store).policy();
  assert.equal(normalized.goalTimeBoxMs, 0);
  assert.equal(normalized.timeBoxReserveMs, 0);
  f.command('policy.update', { patch: { maxConcurrent: 3 } });
  const saved = f.company.policy();
  assert.equal(saved.maxConcurrent, 3);
  assert.equal(saved.goalTimeBoxMs, 0);
  assert.equal(saved.timeBoxReserveMs, 0);
});

test('budget extension clears the old time-box decision so a later box can warn again', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Extended goal' });
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: f.company.policy().maxGoalRuntimeMs + 1000,
    timeBox: { boxMs: 60000, releasedAt: new Date().toISOString() } }));
  f.engine.block(task, 'budget', '目标累计执行时间额度已用完', '请填写追加额度');
  const question = f.store.list('interactions').find(item => item.taskId === task.id && item.status === 'pending');
  f.command('interaction.answer', { id: question.id, answer: '追加额度', additionalRuntimeMs: 120000 });
  assert.equal(f.store.require('goals', f.goal.id).timeBox, null);
});
