import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

const taskState = (f, task) => f.store.require('tasks', task.id);
const goalState = (f, goal = f.goal) => f.store.require('goals', goal.id);
const control = (f, action, goal = f.goal, args = {}) => f.command('goal.' + action,
  { id: goal.id, expectedRevision: goalState(f, goal).revision, ...args });
const createGoal = (f, title, plan = false) => f.command('goal.create', {
  title, description: title, acceptance: 'Deliver a file', projectId: f.project.id, templateId: f.template.id, plan,
});

test('immediate goal pause interrupts only its goal and preserves independent holds on resume', async t => {
  const started = new Set();
  const finishOther = Promise.withResolvers();
  const f = await fixture(t, async input => {
    started.add(input.task.id);
    if (input.task.title === 'Live B') await finishOther.promise;
    if (input.task.title === 'Live A' && input.task.attempts === 1) {
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      input.signal.throwIfAborted();
    }
    return defaultSimulation(input);
  });
  const other = createGoal(f, 'B');
  const manuallyPaused = f.task({ title: 'Manually paused' });
  f.command('task.pause', { id: manuallyPaused.id });
  const cancelled = f.task({ title: 'Previously cancelled' });
  f.command('task.cancel', { id: cancelled.id });
  const waiting = f.task({ title: 'Materials needed' });
  const budget = f.task({ title: 'Awaiting budget' });
  f.store.transaction(() => {
    f.engine.blockForOwner(waiting, 'human', 'Need material', 'Supply the file');
    f.engine.blockForOwner(budget, 'budget', 'Need budget', 'Supply minutes');
  });
  const a = f.task({ title: 'Live A' });
  const b = f.task({ goalId: other.id, title: 'Live B' });
  await f.start();
  try {
    await until(() => started.has(a.id) && started.has(b.id));
    control(f, 'pause');
    await until(() => taskState(f, a).status === 'paused' && !f.engine.live.has(taskState(f, a).activeAttemptId));
    assert.equal(taskState(f, b).status, 'running');
  } finally { finishOther.resolve(); }
  await until(() => taskState(f, b).status === 'succeeded');
  assert.equal(f.company.snapshot().goals.find(goal => goal.id === f.goal.id).controlSummary.phase, 'paused');
  assert.equal(f.adapter.calls.filter(call => call.task.id === a.id).length, 1);
  assert.throws(() => f.command('task.resume', { id: a.id }), { code: 'GOAL_PAUSED' });
  f.command('company.pause', { afterCurrent: true });
  control(f, 'resume');
  await f.engine.tick();
  assert.equal(taskState(f, a).status, 'ready');
  assert.equal(f.adapter.calls.filter(call => call.task.id === a.id).length, 1);
  f.command('company.resume');
  await until(() => taskState(f, a).status === 'succeeded');
  assert.equal(taskState(f, manuallyPaused).status, 'paused');
  assert.equal(taskState(f, cancelled).status, 'cancelled');
  assert.equal(taskState(f, waiting).blocker.kind, 'human');
  assert.equal(taskState(f, budget).blocker.kind, 'budget');
  assert(![manuallyPaused, cancelled, waiting, budget].some(task => started.has(task.id)));
});

test('graceful pause drains the planner, persists its result, and applies it once after restart and resume', async t => {
  let started = false;
  const release = Promise.withResolvers();
  const f = await fixture(t, async input => {
    if (input.task.kind === 'plan') { started = true; await release.promise; }
    return defaultSimulation(input);
  });
  const goal = createGoal(f, 'Draining planner', true);
  const plan = f.store.list('tasks').find(task => task.goalId === goal.id);
  await f.start();
  try {
    await until(() => started);
    control(f, 'pause', goal, { afterCurrent: true });
    assert.equal(f.company.snapshot().goals.find(g => g.id === goal.id).controlSummary.phase, 'draining');
    const manager = f.store.require('agents', 'manager');
    const principal = { kind: 'agent', id: manager.id, goalId: goal.id, grants: manager.grants };
    assert.throws(() => f.command('task.create', { goalId: goal.id, parentId: plan.id, title: 'Late child' }, principal), { code: 'GOAL_PAUSED' });
    assert.throws(() => f.company.runActions(principal, { taskId: plan.id, generation: plan.generation, batchId: 'late',
      actions: [{ command: 'task.create', args: { goalId: goal.id, parentId: plan.id, title: 'Late action' } }] }), { code: 'GOAL_PAUSED' });
  } finally { release.resolve(); }
  await until(() => taskState(f, plan).status === 'paused' && !f.engine.live.size);
  assert.equal(f.store.list('plans').length, 0);
  assert.equal(f.store.list('tasks').filter(task => task.goalId === goal.id).length, 1);
  assert.equal(f.store.list('deferredResults').length, 1);
  await f.engine.stop();
  await f.start();
  assert.equal(taskState(f, plan).status, 'paused');
  control(f, 'resume', goal);
  await until(() => goalState(f, goal).status === 'succeeded');
  assert.equal(f.store.list('plans').filter(row => row.goalId === goal.id).length, 1);
  assert.equal(f.adapter.calls.filter(call => call.task.id === plan.id).length, 1);
  assert.equal(f.store.list('attempts').filter(attempt => attempt.taskId === plan.id).length, 1);
  assert.equal(f.store.list('deferredResults').length, 0);
});

test('a graceful pause arriving before the outbound model request holds the launch', async t => {
  const f = await fixture(t);
  const task = f.task();
  const release = Promise.withResolvers();
  let starting = false;
  const start = f.adapter.start.bind(f.adapter);
  f.adapter.start = async input => {
    starting = true;
    await release.promise;
    input.assertCurrent();
    return start(input);
  };
  await f.start();
  try {
    await until(() => starting);
    control(f, 'pause', f.goal, { afterCurrent: true });
  } finally { release.resolve(); }
  await until(() => !f.engine.live.size && taskState(f, task).status === 'ready');
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(taskState(f, task).attempts, 0);
  control(f, 'resume');
  await until(() => taskState(f, task).status === 'succeeded');
  assert.equal(f.adapter.calls.length, 1);
});

test('goal cancellation retains deliveries and reviews and rejects late results and restart', async t => {
  let lateStarted = false;
  const late = Promise.withResolvers();
  const f = await fixture(t, async input => {
    if (input.task.title === 'Late result') { lateStarted = true; return late.promise; }
    return defaultSimulation(input);
  });
  const delivered = f.task();
  await f.start();
  await until(() => taskState(f, delivered).status === 'succeeded');
  const review = f.command('review.request', { id: delivered.id });
  await until(() => taskState(f, review).status === 'succeeded');
  // This goal was delivered. Use a second, still-active goal for the in-flight
  // stop and use the first to verify cancellation leaves history readable.
  const active = createGoal(f, 'Cancelled active goal');
  const other = createGoal(f, 'Unaffected goal');
  const running = f.task({ goalId: active.id, title: 'Late result' });
  const dependent = f.task({ goalId: active.id, title: 'Queued behind the cancelled task', dependencies: [running.id] });
  const unaffected = f.task({ goalId: other.id });
  try {
    await until(() => lateStarted);
    control(f, 'cancel', active);
    control(f, 'cancel');
  } finally { late.resolve({ outcome: 'decomposed', tasks: [{ key: 'late', title: 'Do not create' }] }); }
  await until(() => taskState(f, running).status === 'cancelled' && !f.engine.live.size);
  await until(() => taskState(f, unaffected).status === 'succeeded');
  assert.equal(taskState(f, dependent).status, 'cancelled');
  assert.equal(goalState(f).status, 'cancelled');
  assert.equal(taskState(f, delivered).status, 'succeeded');
  assert.equal(taskState(f, review).passed, true);
  assert(f.store.list('artifacts').some(a => a.taskId === delivered.id));
  assert(f.store.list('verifications').some(v => v.kind === 'review' && v.taskId === delivered.id));
  assert.throws(() => control(f, 'resume', active), { code: 'INVALID_TRANSITION' });
  assert.throws(() => f.command('task.create', { goalId: active.id, title: 'Do not reopen' }), { code: 'GOAL_CLOSED' });
  assert.throws(() => f.command('review.request', { id: delivered.id }), { code: 'GOAL_CLOSED' });
  await f.engine.stop();
  await f.start();
  assert.equal(goalState(f, active).status, 'cancelled');
  assert.equal(f.store.list('tasks').filter(task => task.goalId === active.id).length, 2);
  assert.equal(f.adapter.calls.filter(call => call.task.goalId === active.id).length, 1);
});

test('resuming a goal leaves its unconfirmed stop held until a clean receipt arrives', async t => {
  const f = await fixture(t);
  let proveCleanup = false, first = true;
  const launch = f.adapter.start.bind(f.adapter);
  f.adapter.start = async input => {
    const activation = await launch(input);
    if (!first) return activation;
    first = false;
    return { ...activation, async dispose() {
      await activation.dispose();
      throw Object.assign(new Error('Fixture cleanup unconfirmed'), { cleanupUncertain: true });
    } };
  };
  f.adapter.reconcile = async () => proveCleanup ? { status: 'stopped', cleanupConfirmed: true } : { status: 'unknown', reason: 'Awaiting receipt' };
  f.adapter.delay = 500;
  const task = f.task();
  await f.start();
  await until(() => f.adapter.calls.length === 1);
  control(f, 'pause');
  await until(() => taskState(f, task).status === 'reconciling' && !f.engine.live.size);
  assert.equal(f.company.snapshot().goals.find(g => g.id === f.goal.id).controlSummary.phase, 'reconciling');
  control(f, 'resume');
  await f.engine.tick();
  assert.equal(taskState(f, task).status, 'reconciling');
  assert.equal(f.adapter.calls.length, 1);
  proveCleanup = true;
  f.command('task.reconcile', { id: task.id });
  await until(() => taskState(f, task).status === 'succeeded');
  assert.equal(f.adapter.calls.length, 2);
});
