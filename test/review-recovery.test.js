import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRoutes } from '../src/host/http.js';
import { executionOccupancy } from '../src/core/execution-capacity.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const reviewTasksFor = (f, predicate) => f.store.list('tasks').filter(task => task.kind === 'review' && task.status !== 'deleted' && predicate(task));

function ownerRequests(f) {
  const routes = new Map(createRoutes(f).map(route => [route.path, route]));
  const base = 'http://localhost/api/acms/';
  return {
    async post(name, args, requestId = randomUUID()) {
      const response = await routes.get('/api/acms/command').fetch(new Request(base + 'command', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, requestId }) }));
      return { status: response.status, ...await response.json() };
    },
    async state() { return (await routes.get('/api/acms/state').fetch(new Request(base + 'state'))).json(); },
  };
}

async function runningReview(t, scope, { uncertain = false, finishBeforeCleanup = false } = {}) {
  const f = await fixture(t);
  const owner = ownerRequests(f);
  f.command('policy.update', { patch: { maxConcurrent: 3, controlSlots: 0 } });
  const goal = f.command('goal.create', { title: 'Review cleanup', description: 'Deliver once', acceptance: 'Keep the deliverable',
    projectId: f.project.id, templateId: scope === 'goal' ? 'base' : f.template.id, plan: false });
  const work = f.task({ goalId: goal.id });
  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded' && !f.engine.live.size);

  const request = scope === 'goal' ? { goalId: goal.id } : { id: work.id };
  const gate = Promise.withResolvers();
  const start = f.adapter.start.bind(f.adapter);
  const reconcile = f.adapter.reconcile.bind(f.adapter);
  let heldAttemptId, disposing, clean = false;
  f.adapter.start = async input => {
    if (heldAttemptId || input.task.kind !== 'review') return start(input);
    heldAttemptId = input.attempt.id;
    const delay = f.adapter.delay;
    let activation;
    try {
      if (!finishBeforeCleanup) f.adapter.delay = 30000;
      activation = await start(input);
    }
    finally { f.adapter.delay = delay; }
    return { ...activation, async dispose() {
      await activation.dispose();
      disposing = true;
      await gate.promise;
      if (uncertain) throw Object.assign(new Error('Waiting for this review cleanup receipt'), { cleanupUncertain: true });
    } };
  };
  f.adapter.reconcile = attempt => attempt.id === heldAttemptId
    ? clean ? { status: 'stopped', cleanupConfirmed: true } : { status: 'unknown', reason: 'Awaiting the review receipt' }
    : reconcile(attempt);
  try {
    const { value: review, status } = await owner.post('review.request', request);
    assert.equal(status, 200);
    await until(() => heldAttemptId && f.store.require('attempts', heldAttemptId).childId, undefined, taskWaitDiagnostics(f, review.id));
    return { ...f, owner, goal, work, request, review, heldAttemptId: () => heldAttemptId,
      disposing: () => disposing, release: gate.resolve, confirm: () => { clean = true; } };
  } catch (error) {
    gate.resolve();
    throw error;
  }
}

for (const scope of ['task', 'goal']) test('owner rebuild waits for the cancelled ' + scope + ' review to release cleanup', async t => {
  const f = await runningReview(t, scope);
  const current = id => f.store.require('tasks', id);
  const reviews = () => reviewTasksFor(f, task => task.goalId === f.goal.id);
  const originalReviewCount = reviews().length;
  const reason = 'The owner intentionally stopped this review';
  try {
    const active = await f.owner.post('review.request', f.request);
    assert.equal(active.value.id, f.review.id);
    assert.equal((await f.owner.post('task.cancel', { id: f.review.id, reason })).status, 200);
    await until(() => f.disposing(), undefined, taskWaitDiagnostics(f, f.review.id));
    assert.equal(current(f.review.id).status, 'cancelled');
    assert.equal(f.store.require('attempts', f.heldAttemptId()).cleanupPending, true);
    assert.equal(executionOccupancy(f.store, f.adapter, f.engine.live).used, 1);
    const requested = await f.owner.post('review.request', f.request);
    assert.equal(requested.status, 409);
    assert.equal(requested.error.code, 'REVIEW_CLEANUP_PENDING');
    assert.equal(reviews().length, originalReviewCount);
  } finally { f.release(); }

  await until(() => f.store.require('attempts', f.heldAttemptId()).cleanupPending === false);
  const snapshot = await f.owner.state();
  const summary = (scope === 'goal' ? snapshot.goals : snapshot.tasks).find(item => item.id === (scope === 'goal' ? f.goal.id : f.work.id)).reviewSummary;
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.cancelReason, reason);
  assert.equal(summary.cancelledBy, 'owner');
  assert.ok(Number.isFinite(Date.parse(summary.cancelledAt)));
  assert.equal(current(f.work.id).status, 'succeeded');
  if (scope === 'goal') assert.equal(snapshot.goals.find(item => item.id === f.goal.id).status, 'active');
  assert.equal(reviews().length, originalReviewCount);

  const requestId = randomUUID();
  const rebuilt = await f.owner.post('review.request', f.request, requestId);
  assert.equal(rebuilt.status, 200);
  assert.notEqual(rebuilt.value.id, f.review.id);
  assert.equal((await f.owner.post('review.request', f.request, requestId)).value.id, rebuilt.value.id);
  await until(() => current(rebuilt.value.id).status === 'succeeded', undefined, taskWaitDiagnostics(f, rebuilt.value.id));
  assert.equal(reviews().length, originalReviewCount + 1);
  assert.equal(f.adapter.calls.filter(call => call.task.id === f.work.id).length, 1);
  assert.equal(f.store.list('tasks').filter(task => task.goalId === f.goal.id && task.kind === 'work').length, 1);
  const events = f.store.page().entries;
  assert.ok(events.some(event => event.entityId === f.review.id && event.type === 'task.cancelled.requested' && event.actor === 'owner' && event.reason === reason));
  assert.ok(events.some(event => event.entityId === f.review.id && event.type === 'review.request.reused' && event.actor === 'owner'));
  assert.ok(events.some(event => event.entityId === rebuilt.value.id && event.type === 'review.requested' && event.actor === 'owner'));
});

test('an accepted review still owns its delivery until execution cleanup finishes', async t => {
  const f = await runningReview(t, 'task', { finishBeforeCleanup: true });
  try {
    await until(() => f.disposing(), undefined, taskWaitDiagnostics(f, f.review.id));
    assert.equal(f.store.require('tasks', f.review.id).passed, true);
    assert.equal(f.store.require('attempts', f.heldAttemptId()).cleanupPending, true);
    const next = await f.owner.post('review.request', f.request);
    assert.equal(next.status, 409);
    assert.equal(next.error.code, 'REVIEW_CLEANUP_PENDING');
    assert.equal(reviewTasksFor(f, review => review.reviewOf === f.work.id).length, 1);
  } finally { f.release(); }
  await until(() => f.store.require('attempts', f.heldAttemptId()).cleanupPending === false);
  const next = await f.owner.post('review.request', f.request);
  assert.equal(next.status, 200);
  assert.notEqual(next.value.id, f.review.id);
});

test('a delayed cleanup receipt after restart cannot make a cancelled review ready again', async t => {
  const f = await runningReview(t, 'goal', { uncertain: true });
  const current = () => f.store.require('tasks', f.review.id);
  const saved = () => f.store.require('attempts', f.heldAttemptId());
  try {
    assert.equal((await f.owner.post('task.cancel', { id: f.review.id, reason: 'Owner cancelled the final review' })).status, 200);
    await until(() => f.disposing(), undefined, taskWaitDiagnostics(f, f.review.id));
  } finally { f.release(); }
  await until(() => current().status === 'reconciling' && !f.engine.live.size);
  await f.engine.stop();
  await f.start();
  assert.equal(saved().cleanupPending, true);
  assert.equal(executionOccupancy(f.store, f.adapter, f.engine.live).used, 1);
  f.confirm();
  assert.equal((await f.owner.post('task.reconcile', { id: f.review.id })).status, 200);
  await until(() => saved().cleanupPending === false, undefined, taskWaitDiagnostics(f, f.review.id));
  assert.equal(current().status, 'cancelled');
  await f.engine.tick();
  assert.equal(f.store.require('goals', f.goal.id).status, 'active');
  assert.equal(f.adapter.calls.filter(call => call.task.id === f.review.id).length, 1);
  assert.equal(f.store.list('verifications').some(row => row.attemptId === f.heldAttemptId()), false);
});

test('owner state selects the real latest review when cancellation and rebuild share a timestamp', async t => {
  const f = await fixture(t);
  const work = f.task();
  await f.start();
  await until(() => f.store.require('tasks', work.id).status === 'succeeded');
  await f.engine.stop();
  const owner = ownerRequests(f);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const scope of ['task', 'goal']) {
    const args = scope === 'task' ? { id: work.id } : { goalId: f.goal.id };
    const previous = (await owner.post('review.request', args)).value;
    await owner.post('task.cancel', { id: previous.id, reason: 'Replace this review' });
    const replacement = (await owner.post('review.request', args)).value;
    assert.equal(previous.createdAt, replacement.createdAt);
    const panel = await owner.state();
    const target = scope === 'task' ? panel.tasks.find(item => item.id === work.id) : panel.goals.find(item => item.id === f.goal.id);
    assert.equal(target.reviewSummary.id, replacement.id);
    assert.equal(target.reviewSummary.status, 'ready');
    if (scope === 'goal') assert.deepEqual(target.reviewHistory.slice(0, 2).map(review => review.id), [replacement.id, previous.id]);
  }
});

test('cancelled goal final review explains the state and can be rebuilt without rerunning work', async t => {
  const f = await fixture(t); f.adapter.delay = 20;
  const goal = f.command('goal.create', { title: 'Recover goal', description: 'Deliver once', acceptance: 'Reviewed', projectId: f.project.id, templateId: 'base', plan: false });
  const work = f.task({ goalId: goal.id, title: 'Deliver once' });
  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 15000);
  await f.engine.stop();

  const review = f.command('review.request', { goalId: goal.id });
  assert.equal(review.reviewScope, 'goal');
  f.command('task.cancel', { id: review.id, reason: 'owner cancelled duplicate review' });

  const snapshot = f.company.snapshot();
  const savedGoal = snapshot.goals.find(item => item.id === goal.id);
  assert.equal(savedGoal.status, 'active');
  assert.equal(savedGoal.reviewSummary.status, 'cancelled');
  assert.equal(savedGoal.reviewSummary.cancelReason, 'owner cancelled duplicate review');
  assert.equal(savedGoal.reviewSummary.cancelledBy, 'owner');
  assert.equal(f.store.require('tasks', work.id).status, 'succeeded');

  // A cancelled review is never rebuilt silently: the goal stays active until
  // the owner explicitly asks again.
  f.company.refreshGoal(goal.id);
  assert.equal(reviewTasksFor(f, task => task.reviewScope === 'goal' && task.goalId === goal.id && !['succeeded', 'cancelled', 'archived', 'failed'].includes(task.status)).length, 0);
  assert.equal(reviewTasksFor(f, task => task.reviewScope === 'goal' && task.goalId === goal.id && task.status === 'cancelled').length, 1);

  const rebuilt = f.command('review.request', { goalId: goal.id });
  const reused = f.command('review.request', { goalId: goal.id });
  assert.equal(reused.id, rebuilt.id);
  assert.equal(reviewTasksFor(f, task => task.reviewScope === 'goal' && task.goalId === goal.id && task.status === 'ready').length, 1);

  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 15000);
  assert.equal(f.store.list('verifications').filter(item => item.kind === 'goal-review' && item.passed).length, 2);
  assert.equal(f.store.list('attempts').filter(item => item.taskId === work.id && item.kind === 'work').length, 1);
});

test('historical reviews for an older delivery never override the current version', async t => {
  const f = await fixture(t); f.adapter.delay = 20;
  const goal = f.command('goal.create', { title: 'Versioned goal', description: 'Deliver', acceptance: 'Reviewed', projectId: f.project.id, templateId: 'base', plan: false });
  const work = f.task({ goalId: goal.id, title: 'Versioned delivery' });
  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 15000);
  await f.engine.stop();

  const old = f.command('review.request', { goalId: goal.id });
  f.command('task.pause', { id: old.id });
  f.store.transaction(() => f.store.put('tasks', { ...f.store.require('tasks', work.id), artifactHash: 'hash-v2' }));
  let snapshot = f.company.snapshot();
  let saved = snapshot.goals.find(item => item.id === goal.id);
  assert.equal(saved.reviewSummary, null);
  assert(saved.reviewHistory.some(item => item.id === old.id && item.status === 'paused'));

  const current = f.command('review.request', { goalId: goal.id });
  snapshot = f.company.snapshot(); saved = snapshot.goals.find(item => item.id === goal.id);
  assert.equal(saved.reviewSummary.id, current.id);
  assert.equal(saved.reviewSummary.deliveryHash, f.company.deliveryHash(goal.id));
  assert.equal(saved.reviewHistory.some(item => item.id === old.id), true);

  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 15000);
  f.command('task.cancel', { id: old.id, reason: 'stale review cancelled late' });
  snapshot = f.company.snapshot(); saved = snapshot.goals.find(item => item.id === goal.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.reviewSummary.id, current.id);
  assert.equal(saved.reviewSummary.status, 'succeeded');
  assert.equal(saved.reviewSummary.passed, true);
  assert.equal(saved.reviewSummary.cancelledAt, null);
});

test('a paused review of an older artifact version does not disable the current task review entry', async t => {
  const f = await fixture(t); f.adapter.delay = 20;
  const task = f.task({ title: 'Versioned task' });
  await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  await f.engine.stop();

  const old = f.command('review.request', { id: task.id });
  f.command('task.pause', { id: old.id });
  f.store.transaction(() => f.store.put('tasks', { ...f.store.require('tasks', task.id), artifactHash: 'hash-task-v2' }));
  assert.equal(f.company.snapshot().tasks.find(item => item.id === task.id).reviewSummary, null);

  const current = f.command('review.request', { id: task.id });
  assert.equal(f.company.snapshot().tasks.find(item => item.id === task.id).reviewSummary.id, current.id);
  await f.start();
  await until(() => f.store.require('tasks', current.id).status === 'succeeded', 15000);
  f.command('task.cancel', { id: old.id, reason: 'stale task review cancelled late' });
  const summary = f.company.snapshot().tasks.find(item => item.id === task.id).reviewSummary;
  assert.equal(summary.id, current.id);
  assert.equal(summary.status, 'succeeded');
  assert.equal(summary.passed, true);
  assert.equal(summary.cancelledAt, null);
});

test('cancelled task review can be rebuilt while the delivered task stays completed', async t => {
  const f = await fixture(t); f.adapter.delay = 20;
  const task = f.task({ title: 'Reviewed delivery' });
  await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  await f.engine.stop();

  const review = f.command('review.request', { id: task.id });
  f.command('task.cancel', { id: review.id, reason: 'review was interrupted' });
  const cancelled = f.store.require('tasks', task.id);
  const cancelledSummary = f.company.snapshot().tasks.find(item => item.id === task.id).reviewSummary;
  assert.equal(cancelled.status, 'succeeded');
  assert.equal(cancelledSummary.status, 'cancelled');
  assert.equal(cancelledSummary.cancelReason, 'review was interrupted');
  assert.equal(cancelledSummary.cancelledBy, 'owner');

  const rebuilt = f.command('review.request', { id: task.id });
  const reused = f.command('review.request', { id: task.id });
  assert.equal(reused.id, rebuilt.id);
  assert.equal(reviewTasksFor(f, item => item.reviewOf === task.id && item.status === 'ready').length, 1);

  await f.start();
  await until(() => f.store.require('tasks', rebuilt.id).status === 'succeeded', 15000);
  assert.equal(f.store.require('tasks', task.id).status, 'succeeded');
  assert.equal(f.store.list('verifications').filter(item => item.kind === 'review' && item.taskId === task.id && item.passed).length, 1);
  assert.equal(f.store.list('attempts').filter(item => item.taskId === task.id && item.kind === 'work').length, 1);
});
