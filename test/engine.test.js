import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

test('untrusted plan nodes cannot inject internal state and do not gain review control', async t => {
  const f = await fixture(t, async input => input.task.kind === 'plan' ? { outcome: 'planned', tasks: [{ key: 'one', title: 'Safe child', stageIndex: 999, kind: 'repair', workflowSnapshot: { steps: [] }, reviewOf: 'foreign-task' }] } : defaultSimulation(input));
  const goal = f.command('goal.create', { title: 'Plan isolation', description: 'Make a verified artifact', acceptance: 'Independent review', projectId: f.project.id });
  await f.start(); await until(() => f.store.require('goals', goal.id).status === 'succeeded');
  const child = f.store.list('tasks').find(t => t.kind === 'work');
  assert.equal(child.reviewOf, null); assert.equal(child.workflowSnapshot, undefined); assert.equal(child.stageIndex, undefined);
  assert(f.adapter.calls.some(c => c.task.kind === 'review'));
});
test('goal runtime budget aborts live execution and only blocks its own branch', async t => {
  const f = await fixture(t); f.adapter.delay = 1800; f.command('policy.update', { patch: { maxGoalRuntimeMs: 1000 } });
  const task = f.task(); await f.start(); await until(() => f.store.require('tasks', task.id).blocker?.kind === 'budget', 5000);
  assert.equal(f.adapter.active, 0); assert.equal(f.company.policy().paused, false); assert.equal(f.store.list('artifacts').length, 0);
});

test('delivery completes with automatic checks and no review unless requested', async t => {
  const f = await fixture(t); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded' && f.store.require('goals', f.goal.id).status === 'succeeded');
  assert.equal(f.adapter.calls.length, 1);
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'review').length, 0);
  assert.equal(f.store.list('tasks').filter(t => t.kind === 'review').length, 0);
  assert.equal(f.store.list('verifications').filter(v => v.passed).length, 1);
});
test('base template creates exactly one goal-level review after delivery', async t => {
  const f = await fixture(t);
  const goal = f.command('goal.create', { title: 'Reviewed goal', description: 'Deliver', acceptance: 'Reviewed once', projectId: f.project.id, templateId: 'base', plan: false });
  f.task({ goalId: goal.id, title: 'Deliver reviewed file' });
  await f.start(); await until(() => f.store.require('goals', goal.id).status === 'succeeded');
  const reviews = f.store.list('tasks').filter(t => t.kind === 'review' && t.goalId === goal.id);
  assert.equal(reviews.length, 1); assert.equal(reviews[0].reviewScope, 'goal');
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'review').length, 1);
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'work').length, 1);
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'goal-review' && v.passed).length, 1);
});
test('review rejection requests manager rework without reopening the delivered task', async t => {
  let reviews = 0;
  const f = await fixture(t, async input => input.task.kind === 'review' && ++reviews === 1 ? { outcome: 'reviewed', decision: 'changes_requested', summary: 'Add explanation', findings: ['Missing context'] } : defaultSimulation(input));
  const goal = f.command('goal.create', { title: 'Rejected goal', description: 'Deliver', acceptance: 'Reviewed once', projectId: f.project.id, templateId: 'base', plan: false });
  const task = f.task({ goalId: goal.id });
  await f.start();
  await until(() => f.store.list('tasks').some(t => t.kind === 'coordination'));
  assert.equal(reviews, 1);
  assert.equal(f.store.require('tasks', task.id).status, 'succeeded');
  assert.equal(f.store.require('goals', goal.id).status, 'active');
  assert.equal(f.store.list('tasks').find(t => t.kind === 'review').passed, false);
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'work').length, 1);
});
test('a human-input wait blocks only its branch and the answer wakes it', async t => {
  const f = await fixture(t, async input => input.task.title === 'Needs material' && !input.task.lastAnswer ? { outcome: 'blocked', kind: 'human', reason: 'Missing required source', question: 'Provide the source.' } : defaultSimulation(input));
  const waiting = f.task({ title: 'Needs material' }); const other = f.task({ title: 'Independent work' }); await f.start();
  await until(() => f.store.require('tasks', other.id).status === 'succeeded');
  assert.equal(f.store.require('tasks', waiting.id).status, 'blocked');
  const interaction = f.store.list('interactions')[0]; f.command('interaction.answer', { id: interaction.id, answer: 'Approved source material' });
  await until(() => f.store.require('tasks', waiting.id).status === 'succeeded');
});
test('cancelled dependencies do not release downstream tasks', async t => {
  const f = await fixture(t); const upstream = f.task(); const downstream = f.task({ title: 'Dependent', dependencies: [upstream.id] });
  f.command('task.cancel', { id: upstream.id }); await f.start(); await new Promise(r => setTimeout(r, 100));
  assert.equal(f.store.require('tasks', downstream.id).status, 'blocked'); assert.equal(f.adapter.calls.length, 0);
});
test('concurrency includes cleanup and leaves space for control work', async t => {
  const f = await fixture(t); f.adapter.delay = 80;
  for (let i = 0; i < 8; i++) f.task({ title: `Parallel ${i}` });
  await f.start(); await until(() => f.store.require('goals', f.goal.id).status === 'succeeded');
  assert(f.adapter.maxActive <= 4); assert.equal(f.adapter.calls.filter(c => c.task.kind === 'review').length, 0);
});
test('invalid artifacts cannot bypass verification', async t => {
  const f = await fixture(t, async input => input.task.kind === 'work' ? { outcome: 'completed', summary: 'Claimed success', artifacts: [{ path: '../outside.txt' }] } : defaultSimulation(input));
  const task = f.task(); await f.start(); await until(() => f.store.list('attempts').some(a => a.taskId === task.id && a.status === 'failed'));
  assert.notEqual(f.store.require('tasks', task.id).status, 'succeeded'); assert.equal(f.store.list('verifications').length, 0);
});
test('automatic planning creates and schedules a dependency graph', async t => {
  const f = await fixture(t); const goal = f.command('goal.create', { title: 'Automatic plan', description: 'Create a demo', acceptance: 'Two verified files', projectId: f.project.id });
  await f.start(); await until(() => f.store.require('goals', goal.id).status === 'succeeded');
  const work = f.store.list('tasks').filter(x => x.goalId === goal.id && x.kind === 'work'); assert.equal(work.length, 2); assert.equal(work[1].dependencies[0], work[0].id);
});
test('pausing an active task aborts its execution and never marks success', async t => {
  const f = await fixture(t); f.adapter.delay = 500; const task = f.task(); await f.start();
  await until(() => f.adapter.active === 1); f.command('task.pause', { id: task.id });
  await until(() => f.store.require('tasks', task.id).status === 'paused' && f.adapter.active === 0);
  assert.equal(f.store.list('artifacts').length, 0); assert.equal(f.store.list('attempts')[0].status, 'interrupted');
});
test('unknown prior execution is reconciled instead of blindly dispatched', async t => {
  const f = await fixture(t); const task = f.task();
  f.store.transaction(() => { f.store.put('tasks', { ...task, status: 'running', activeAttemptId: 'prior' }); f.store.put('attempts', { id: 'prior', taskId: task.id, goalId: task.goalId, taskGeneration: task.generation, status: 'running', agentId: task.agentId, startedAt: new Date().toISOString(), childId: 'old-child' }); });
  f.adapter.reconcile = async () => ({ status: 'unknown', reason: 'Cannot prove old process stopped' });
  await f.start(); await new Promise(r => setTimeout(r, 80));
  assert.equal(f.adapter.calls.length, 0); assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
  f.command('task.reconcile', { id: task.id, confirmedStopped: true, evidence: 'Confirmed old process exit and inspected workspace.' });
  await until(() => !f.store.require('tasks', task.id).recoveryRequested);
  assert.equal(f.adapter.calls.length, 0); assert.equal(f.store.require('attempts', 'prior').cleanupPending, true);
  f.adapter.reconcile = async () => ({ status: 'stopped', cleanupConfirmed: true, reason: 'Explicit test adapter cleanup receipt' });
  f.command('task.reconcile', { id: task.id });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
});
test('a review cannot approve files modified after delivery', async t => {
  const f = await fixture(t, async input => {
    if (input.task.kind === 'review') { await writeFile(path.join(f.store.require('tasks', input.task.reviewOf).workspace.path, 'deliverable.md'), 'Changed during review'); return { outcome: 'reviewed', decision: 'approve', summary: 'Claimed pass' }; }
    return defaultSimulation(input);
  });
  const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  f.command('review.request', { id: task.id });
  await until(() => f.store.list('attempts').some(a => a.kind === 'review' && a.status === 'failed'));
  assert.equal(f.store.require('tasks', task.id).status, 'succeeded');
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'review').length, 0);
});

test('archiving an unverified dependency does not release downstream execution', async t => {
  const f = await fixture(t); const upstream = f.task();
  const downstream = f.task({ title: 'Dependent on verified delivery', dependencies: [upstream.id] });
  f.store.transaction(() => f.store.put('tasks', { ...upstream, status: 'archived' }));
  await f.start(); await f.engine.tick();
  assert.equal(f.adapter.calls.length, 0);
  assert.notEqual(f.store.require('tasks', downstream.id).status, 'succeeded');
});
