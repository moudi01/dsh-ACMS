import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';

const insertEvent = (store, { at, type, entityId, goalId, body = '{}' }) => store.db.prepare(
  'INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)',
).run(at, type, entityId, goalId, 'system', 'system', null, body);

test('snapshot exposes effective activity and aggregates it to goal and project', async t => {
  const f = await fixture(t); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const snap = f.company.snapshot();
  const saved = snap.tasks.find(item => item.id === task.id);
  const goal = snap.goals.find(item => item.id === task.goalId);
  const project = snap.projects.find(item => item.id === task.projectId);
  assert.ok(saved.activityAt); assert.ok(goal.activityAt); assert.ok(project.activityAt);
  assert.ok(Date.parse(goal.activityAt) >= Date.parse(saved.activityAt));
  assert.ok(Date.parse(project.activityAt) >= Date.parse(goal.activityAt));
});

test('progress and polling events never bump activity', async t => {
  const f = await fixture(t); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const before = f.company.snapshot().tasks.find(item => item.id === task.id).activityAt;
  insertEvent(f.store, { at: new Date(Date.now() + 60_000).toISOString(), type: 'attempt.progress', entityId: task.id, goalId: task.goalId });
  insertEvent(f.store, { at: new Date(Date.now() + 61_000).toISOString(), type: 'task.readiness', entityId: task.id, goalId: task.goalId });
  const after = f.company.snapshot().tasks.find(item => item.id === task.id).activityAt;
  assert.equal(after, before);
});

test('attempt and interaction events are attributed to their task before aggregation', async t => {
  const f = await fixture(t); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const attemptStamp = new Date(Date.now() + 300_000).toISOString();
  f.store.put('attempts', { id: 'attempt_future_activity', taskId: task.id, goalId: task.goalId, agentId: task.agentId, status: 'completed', startedAt: attemptStamp });
  insertEvent(f.store, { at: attemptStamp, type: 'attempt.starting', entityId: 'attempt_future_activity', goalId: task.goalId });
  let snap = f.company.snapshot();
  assert.equal(snap.tasks.find(item => item.id === task.id).activityAt, attemptStamp);
  assert.equal(snap.goals.find(item => item.id === task.goalId).activityAt, attemptStamp);

  const interactionStamp = new Date(Date.now() + 360_000).toISOString();
  f.store.put('interactions', { id: 'interaction_future_activity', taskId: task.id, goalId: task.goalId, status: 'answered', kind: 'human', question: 'q', answer: 'a' });
  insertEvent(f.store, { at: interactionStamp, type: 'interaction.answered', entityId: 'interaction_future_activity', goalId: task.goalId });
  snap = f.company.snapshot();
  assert.equal(snap.tasks.find(item => item.id === task.id).activityAt, interactionStamp);
});

test('parent task activity aggregates deepest descendant activity', async t => {
  const f = await fixture(t);
  const parent = f.task({ title: 'Parent branch' }); const child = f.task({ title: 'Child branch', parentId: parent.id });
  const stamp = new Date(Date.now() + 300_000).toISOString();
  insertEvent(f.store, { at: stamp, type: 'task.changed', entityId: child.id, goalId: child.goalId });
  const snap = f.company.snapshot();
  assert.equal(snap.tasks.find(item => item.id === child.id).activityAt, stamp);
  assert.equal(snap.tasks.find(item => item.id === parent.id).activityAt, stamp);
  assert.equal(snap.goals.find(item => item.id === parent.goalId).activityAt, stamp);
});

test('newer effective activity moves parents to the top and unknown history degrades to creation time', async t => {
  const f = await fixture(t); const first = f.task({ title: 'First' }); const second = f.task({ title: 'Second' });
  await f.start();
  await until(() => f.store.require('tasks', first.id).status === 'succeeded' && f.store.require('tasks', second.id).status === 'succeeded');
  const stamp = new Date(Date.now() + 120_000).toISOString();
  insertEvent(f.store, { at: stamp, type: 'task.changed', entityId: second.id, goalId: second.goalId });
  const snap = f.company.snapshot();
  assert.equal(snap.tasks.find(item => item.id === second.id).activityAt, stamp);
  assert.equal(snap.goals.find(item => item.id === second.goalId).activityAt, stamp);
  assert.equal(snap.projects.find(item => item.id === second.projectId).activityAt, stamp);

  // A record created outside the event stream uses its own creation time rather
  // than "now", so it does not pretend to be freshly active.
  f.store.put('tasks', { id: 'task_manual_history', goalId: f.goal.id, projectId: f.project.id, title: 'Manual history', description: 'x', acceptance: 'x', kind: 'work', status: 'ready', dependencies: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const manual = f.company.snapshot().tasks.find(item => item.id === 'task_manual_history');
  assert.equal(manual.activityAt, '2026-01-01T00:00:00.000Z');
});
