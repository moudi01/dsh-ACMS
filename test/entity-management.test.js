import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { promptFor } from '../src/runtime/prompt.js';

test('project deletion is reversible, cascades metadata, preserves source and prior trash', async t => {
  const f = await fixture(t); const first = f.task(); const second = f.task();
  f.command('task.delete', { id: first.id });
  f.command('project.delete', { id: f.project.id });
  assert.equal(f.company.snapshot().projects.length, 0); assert.equal(f.company.snapshot().tasks.length, 0);
  assert.equal(f.company.snapshot().entityTrash.length, 1);
  assert.throws(() => f.command('task.restore', { id: first.id }), { code: 'RESTORE_BLOCKED' });
  f.command('project.restore', { id: f.project.id });
  assert.equal(f.store.require('tasks', first.id).status, 'deleted');
  assert.equal(f.store.require('tasks', second.id).status, 'paused');
  assert.equal(f.company.snapshot().projects.length, 1);
  await f.start(); assert.equal(f.adapter.calls.length, 0);
});

test('goal deletion checks cleanup and revision atomically, then restores children paused', async t => {
  const f = await fixture(t); const task = f.task();
  f.store.put('attempts', { id: 'cleanup', taskId: task.id, agentId: task.agentId, status: 'completed', cleanupPending: true });
  assert.throws(() => f.command('goal.delete', { id: f.goal.id }), { code: 'DELETE_BLOCKED' });
  f.store.put('attempts', { id: 'cleanup', taskId: task.id, status: 'completed', cleanupPending: false });
  assert.throws(() => f.command('goal.delete', { id: f.goal.id, expectedRevision: -1 }), { code: 'CONFLICT' });
  assert.equal(f.store.require('tasks', task.id).status, 'ready');
  f.command('goal.delete', { id: f.goal.id });
  assert.throws(() => f.task(), { code: 'GOAL_CLOSED' });
  f.command('goal.restore', { id: f.goal.id }); assert.equal(f.store.require('tasks', task.id).status, 'paused');
});

test('role deletion protects assignments and prevents later assignment until restore', async t => {
  const f = await fixture(t); const task = f.task(); const agentId = task.agentId;
  assert.throws(() => f.command('agent.delete', { id: agentId }), { code: 'DELETE_BLOCKED' });
  f.command('task.cancel', { id: task.id }); f.command('agent.delete', { id: agentId });
  assert.equal(f.company.snapshot().agents.some(a => a.id === agentId), false);
  assert.throws(() => f.task({ agentId }), { code: 'AGENT_RETIRED' });
  f.command('agent.restore', { id: agentId }); assert.equal(f.store.require('agents', agentId).status, 'retired');
  assert.throws(() => f.command('agent.delete', { id: 'manager' }), { code: 'DELETE_BLOCKED' });
});

test('edits notify exact old and new assignees, no-op does not notify, stale updates do not leak', async t => {
  const f = await fixture(t); const task = f.task();
  const replacement = f.command('agent.save', { name: 'Replacement', role: 'worker' });
  f.command('task.edit', { id: task.id, patch: { title: task.title } }); assert.equal(f.store.list('notifications').length, 0);
  const changed = f.command('task.edit', { id: task.id, expectedRevision: task.revision, patch: { title: 'New contract', agentId: replacement.id } });
  const notices = f.store.list('notifications'); assert.deepEqual(new Set(notices.map(n => n.agentId)), new Set([task.agentId, replacement.id]));
  assert.equal(notices[0].changes.find(c => c.field === 'title').before, task.title);
  assert.throws(() => f.command('task.edit', { id: task.id, expectedRevision: task.revision, patch: { title: 'Stale' } }), { code: 'CONFLICT' });
  assert.equal(f.store.list('notifications').length, notices.length);
  const prompt = promptFor(f.company, changed, { id: 'example', agentId: replacement.id, notificationIds: [notices.find(n => n.agentId === replacement.id).id] });
  assert.match(prompt, /changeNotifications/); assert.match(prompt, /New contract/);
  await f.start(); await until(() => f.store.list('notifications').some(n => n.agentId === replacement.id && n.status === 'delivered'));
});

test('goal edit retains owner holds and questions while notifying affected assignees', async t => {
  const f = await fixture(t); const task = f.task(); f.engine.block(task, 'human', 'Missing material', 'Exact material needed');
  const question = f.store.list('interactions')[0];
  f.command('goal.edit', { id: f.goal.id, patch: { description: 'Updated goal scope' } });
  const current = f.store.require('tasks', task.id); assert.equal(current.status, 'blocked');
  assert.equal(f.store.require('interactions', question.id).taskGeneration, current.generation);
  assert.equal(f.store.require('interactions', question.id).status, 'pending');
  assert.equal(f.store.list('notifications')[0].entityKind, 'goal');
});

test('editing a running task stops obsolete execution before the revised run and review', async t => {
  const f = await fixture(t, defaultSimulation); f.adapter.delay = 300;
  const task = f.task(); await f.start(); await until(() => f.adapter.calls.length === 1);
  f.command('task.edit', { id: task.id, patch: { title: 'Revised task' } });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const work = f.adapter.calls.filter(c => c.task.id === task.id); assert.equal(work.length, 2);
  assert.equal(work[1].task.title, 'Revised task'); assert.match(work[1].prompt, /changeNotifications/);
  assert.equal(f.store.list('attempts').find(a => a.id === work[0].attempt.id).status, 'interrupted');
  assert.equal(f.store.list('verifications').filter(v => v.taskId === task.id && v.kind === 'review').length, 1);
});

test('completed task editing requires an available assignee and invalidates the old acceptance', async t => {
  const f = await fixture(t); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded' && !f.store.list('attempts').some(a => a.cleanupPending));
  assert.throws(() => f.command('task.edit', { id: task.id, patch: { agentId: '' } }), { code: 'INVALID_INPUT' });
  const replacement = f.command('agent.save', { name: 'New assignee', role: 'worker' });
  f.command('task.edit', { id: task.id, patch: { acceptance: 'Verify the revised deliverable', agentId: replacement.id } });
  assert.equal(f.store.require('tasks', task.id).status, 'ready');
  assert.equal(f.store.require('goals', task.goalId).status, 'active');
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.adapter.calls.filter(c => c.task.id === task.id).length, 2);
  assert.equal(f.store.list('verifications').filter(v => v.taskId === task.id && v.kind === 'review').length, 2);
});

test('an edit during preparation never starts the obsolete model call', async t => {
  const f = await fixture(t); const original = f.workspaces.prepare.bind(f.workspaces);
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.workspaces.prepare = async (...args) => { const workspace = await original(...args); if (!entered) { entered = true; await gate; } return workspace; };
  const task = f.task(); await f.start(); await until(() => entered);
  f.command('task.edit', { id: task.id, patch: { title: 'Changed before model start' } }); release();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const calls = f.adapter.calls.filter(c => c.task.id === task.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].task.title, 'Changed before model start');
});
