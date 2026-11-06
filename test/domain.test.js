import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { OWNER } from '../src/core/util.js';

test('commands are durable, idempotent and reject changed payloads', async t => {
  const f = await fixture(t); const key = randomUUID(); const args = { goalId: f.goal.id, title: 'Unique task' };
  const first = f.command('task.create', args, OWNER, key); const second = f.command('task.create', args, OWNER, key);
  assert.equal(first.id, second.id); assert.equal(f.store.list('tasks').length, 1);
  assert.throws(() => f.command('task.create', { ...args, title: 'Different' }, OWNER, key), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('dependency cycles and cross-goal edges are rejected transactionally', async t => {
  const f = await fixture(t); const a = f.task({ title: 'A' }); const b = f.task({ title: 'B', dependencies: [a.id] });
  assert.throws(() => f.command('task.dependencies', { id: a.id, dependencies: [b.id] }), { code: 'DEPENDENCY_CYCLE' });
  assert.deepEqual(f.store.require('tasks', a.id).dependencies, []);
  const other = f.command('goal.create', { title: 'Other', description: 'Other', acceptance: 'Other', projectId: f.project.id, plan: false });
  assert.throws(() => f.command('task.create', { goalId: other.id, title: 'Forbidden edge', dependencies: [a.id] }), { code: 'SCOPE_DENIED' });
});
test('stale edits and direct completion bypasses are rejected', async t => {
  const f = await fixture(t); const task = f.task();
  f.command('task.edit', { id: task.id, expectedRevision: task.revision, patch: { title: 'Changed' } });
  assert.throws(() => f.command('task.edit', { id: task.id, expectedRevision: task.revision, patch: { title: 'Stale' } }), { code: 'CONFLICT' });
  assert.throws(() => f.command('task.edit', { id: task.id, patch: { status: 'succeeded' } }), { code: 'INVALID_INPUT' });
});
test('manager can publish workflows but cannot expand owner policy', async t => {
  const f = await fixture(t); const actor = { kind: 'agent', id: 'manager', goalId: f.goal.id };
  assert.throws(() => f.command('policy.update', { patch: { maxConcurrent: 32 } }, actor), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('goal.create', { title: 'New business' }, actor), { code: 'FORBIDDEN' });
  const task = f.task(); const old = f.store.require('workflows', 'default');
  const updated = f.command('workflow.publish', { id: old.id, name: 'New process', steps: old.steps, maxReworks: 1, expectedRevision: old.revision }, actor);
  assert.equal(updated.version, 2); assert.equal(f.store.require('tasks', task.id).workflowSnapshot.version, 1);
  assert.throws(() => f.command('workflow.publish', { name: 'Skip review', steps: [{ id: 'a', name: 'A', type: 'work' }, { id: 'b', name: 'B', type: 'work' }] }, actor), { code: 'VERIFICATION_REQUIRED' });
});
test('agent grants, provider limits and self elevation are enforced', async t => {
  const f = await fixture(t); const actor = { kind: 'agent', id: 'manager', goalId: f.goal.id };
  assert.throws(() => f.command('agent.save', { id: 'manager', name: 'Super owner', role: 'manager' }, actor), { code: 'SELF_MODIFICATION' });
  assert.throws(() => f.command('agent.save', { name: 'Escalate', role: 'worker', grants: ['policy.update'] }), { code: 'GRANT_DENIED' });
  f.command('policy.update', { patch: { allowedProviders: ['approved'] } });
  assert.throws(() => f.command('agent.save', { name: 'Bad provider', role: 'worker', provider: 'not-approved' }), { code: 'PROVIDER_DENIED' });
});
test('task commands cannot inject internal workflow state or bypass mandatory review', async t => {
  const f = await fixture(t);
  for (const patch of [{ workflowSnapshot: { steps: [] } }, { stageIndex: 999 }, { reviewOf: 'foreign-task' }, { kind: 'repair' }]) {
    assert.throws(() => f.task(patch), /Internal task/);
  }
  assert.equal(f.store.list('tasks').length, 0);
});
