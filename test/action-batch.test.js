import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

async function setup(t) {
  const f = await fixture(t); const task = f.task({ agentId: 'manager' });
  f.store.put('tasks', { ...task, status: 'running' });
  const actor = { kind: 'agent', id: 'manager', goalId: f.goal.id, grants: f.store.require('agents', 'manager').grants };
  const actions = [
    { command: 'agent.save', args: { name: 'Batch worker', role: 'worker', grants: [], temporary: true } },
    { command: 'task.create', args: { goalId: f.goal.id, parentId: task.id, agentId: '$actions[0].id', title: 'Assigned work' } },
  ];
  const batch = { taskId: task.id, generation: task.generation, batchId: 'hire-and-assign-v1', actions };
  return { ...f, actor, batch, rootTask: task };
}

test('atomic actions resolve actual IDs, audit the manager, and deduplicate retries', async t => {
  const f = await setup(t); const result = f.company.runActions(f.actor, f.batch);
  assert.equal(result.results[1].agentId, result.results[0].id);
  const cursor = f.store.cursor();
  assert.deepEqual(f.company.runActions(f.actor, structuredClone(f.batch)), result);
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.list('tasks').length, 2);
  assert(f.store.page().entries.some(e => e.type === 'task.created' && e.entityId === result.results[1].id && e.actor === 'manager'));
  const changed = structuredClone(f.batch); changed.actions[0].args.name = 'Changed';
  assert.throws(() => f.company.runActions(f.actor, changed), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.company.runActions({ ...f.actor, grants: ['agent.save'] }, f.batch), { code: 'FORBIDDEN' });
  f.command('agent.save', { id: 'manager', grants: ['agent.save'] });
  assert.throws(() => f.company.runActions(f.actor, f.batch), { code: 'FORBIDDEN' });
});

test('later action failure rolls back roles, tasks, command receipts and audit events', async t => {
  const f = await setup(t); const agents = f.store.list('agents'); const cursor = f.store.cursor();
  const commands = f.store.db.prepare('SELECT count(*) AS n FROM commands').get().n;
  f.batch.actions[1].args.title = '';
  assert.throws(() => f.company.runActions(f.actor, f.batch), { code: 'INVALID_INPUT' });
  assert.deepEqual(f.store.list('agents'), agents); assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM commands').get().n, commands);
  assert.equal(f.store.list('actionBatches').length, 0);
  f.batch.actions[1].args.title = 'Corrected task';
  assert.equal(f.company.runActions(f.actor, f.batch).results.length, 2);
});

test('references cannot point forward, evaluate properties or cross goal boundaries', async t => {
  const f = await setup(t);
  for (const ref of ['$actions[1].id', '$actions[0].__proto__', '$actions[-1].id', '$actions[999].id']) {
    f.batch.actions[1].args.agentId = ref;
    assert.throws(() => f.company.runActions(f.actor, f.batch), { code: 'INVALID_ACTION_REFERENCE' });
  }
  f.batch.actions[1].args.agentId = '$actions[0].id';
  const other = f.command('goal.create', { projectId: f.project.id, title: 'Other', description: 'Other', acceptance: 'Other', plan: false });
  f.batch.actions[1].args.goalId = other.id;
  assert.throws(() => f.company.runActions(f.actor, f.batch), { code: 'SCOPE_DENIED' });
  assert.equal(f.store.list('agents').length, 2);
  assert.equal(f.store.list('actionBatches').length, 0);
});

test('caller-supplied goal cannot disguise a task from another goal', async t => {
  const f = await setup(t);
  const other = f.command('goal.create', { projectId: f.project.id, title: 'Other', description: 'Other', acceptance: 'Other', plan: false });
  const target = f.command('task.create', { goalId: other.id, title: 'Protected task' });
  assert.throws(() => f.command('task.edit', { id: target.id, goalId: f.goal.id, patch: { title: 'Spoofed scope' } }, f.actor), { code: 'SCOPE_DENIED' });
  f.batch.actions.push({ command: 'task.edit', args: { id: target.id, goalId: f.goal.id, patch: { title: 'Spoofed batch scope' } } });
  const agents = f.store.list('agents');
  assert.throws(() => f.company.runActions(f.actor, f.batch), { code: 'SCOPE_DENIED' });
  assert.deepEqual(f.store.list('agents'), agents); assert.equal(f.store.require('tasks', target.id).title, 'Protected task');
});

test('default, explicit, edited and captured delegation cannot widen effective grants', async t => {
  const f = await fixture(t);
  const restricted = f.command('agent.save', { name: 'Restricted', role: 'manager', grants: ['agent.save'] });
  const actor = { kind: 'agent', id: restricted.id, goalId: f.goal.id };
  const created = f.command('agent.save', { name: 'New manager', role: 'manager' }, actor);
  assert.deepEqual(created.grants, ['agent.save']);
  assert.deepEqual(f.command('agent.save', { id: created.id, name: 'Rename only' }, actor).grants, ['agent.save']);
  assert.throws(() => f.command('agent.save', { name: 'Explicit elevation', role: 'manager', grants: ['task.create'] }, actor), { code: 'GRANT_DENIED' });
  assert.throws(() => f.command('agent.save', { id: 'manager', name: 'Edit superior' }, actor), { code: 'GRANT_DENIED' });
  f.command('agent.save', { id: restricted.id, grants: ['agent.save', 'task.create'] });
  assert.deepEqual(f.command('agent.save', { name: 'Captured restriction', role: 'manager' }, { ...actor, grants: ['agent.save'] }).grants, ['agent.save']);
  assert.deepEqual(f.command('agent.save', { name: 'Worker', role: 'worker', grants: [] }, actor).grants, []);
});

test('external-style manager receives results on automatic wakeup and completes verified delegation', async t => {
  let managerTurns = 0; let received;
  const f = await fixture(t, async input => {
    if (input.task.agentId === 'manager') {
      managerTurns++;
      const contract = JSON.parse(input.prompt.split('CONTRACT:\n')[1]);
      if (!contract.managementResults.length) return { outcome: 'managed', actionBatchId: 'dispatch-v1', summary: 'Hire and dispatch', actions: [
        { command: 'agent.save', args: { name: 'External worker', role: 'worker', grants: [], temporary: true } },
        { command: 'task.create', args: { goalId: f.goal.id, parentId: input.task.id, agentId: '$actions[0].id', title: 'Delegated child' } },
      ] };
      received = contract.managementResults[0].results;
      assert.equal(received[1].agentId, received[0].id);
    }
    return defaultSimulation(input);
  });
  const root = f.task({ agentId: 'manager' }); await f.start();
  await until(() => f.store.require('goals', f.goal.id).status === 'succeeded');
  assert.equal(managerTurns, 2); assert.equal(f.store.list('actionBatches').length, 1);
  assert.equal(f.store.require('tasks', received[1].id).parentId, root.id);
  assert.equal(f.store.require('tasks', received[1].id).status, 'succeeded');
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'review').length, 0);
});
