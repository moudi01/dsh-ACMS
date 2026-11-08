import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';

const reviewTasksFor = (f, predicate) => f.store.list('tasks').filter(task => task.kind === 'review' && task.status !== 'deleted' && predicate(task));

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
