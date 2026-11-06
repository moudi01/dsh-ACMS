import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

// Independent regression cases reported by the testing workspace.
test('QA-01 purging unused tasks releases temporary-agent capacity', async t => {
  const f = await fixture(t);
  const limit = f.company.policy().maxTemporaryAgents;
  for (let n = 0; n < limit; n++) {
    const task = f.task({ title: `Discarded ${n + 1}` });
    f.command('task.delete', { id: task.id });
    f.command('task.purge', { id: task.id, confirmTitle: task.title });
  }
  assert.equal(f.store.list('tasks').length, 0);
  const activeAgents = f.store.list('agents').filter(a => a.temporary && a.status !== 'retired');
  console.log('QA-01 evidence', JSON.stringify({ remainingTasks: 0, activeTemporaryAgents: activeAgents.length, limit }));
  assert.doesNotThrow(() => f.task({ title: 'New work after emptying trash' }), 'Empty trash and zero tasks must not exhaust temporary-agent capacity');
});

test('QA-02 answering an old question must not silently restart a cancelled task', async t => {
  const f = await fixture(t, async input => input.task.kind === 'work' && !input.task.lastAnswer
    ? { outcome: 'blocked', kind: 'human', reason: 'Fixture input missing', question: 'Supply input' }
    : defaultSimulation(input));
  const task = f.task();
  await f.start();
  await until(() => f.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending') && f.engine.live.size === 0);
  const question = f.store.list('interactions').find(i => i.taskId === task.id && i.status === 'pending');
  f.command('task.cancel', { id: task.id });
  assert.equal(f.store.require('tasks', task.id).status, 'cancelled');
  const attemptsBefore = f.store.list('attempts').length;
  let rejected = null;
  try { f.command('interaction.answer', { id: question.id, answer: 'Fixture answer after cancellation' }); }
  catch (error) { rejected = error.code; }
  await new Promise(resolve => setTimeout(resolve, 300));
  const state = f.store.require('tasks', task.id).status;
  const attemptsAfter = f.store.list('attempts').length;
  console.log('QA-02 evidence', JSON.stringify({ rejected, state, attemptsBefore, attemptsAfter }));
  assert.equal(state, 'cancelled', 'A cancelled task must require an explicit restart instead of accepting an old answer');
  assert.equal(attemptsAfter, attemptsBefore);
});

test('QA-03 a shared temporary worker remains usable for its queued tasks', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  // Hold task two so this assertion cannot race its legitimate final retirement.
  const f = await fixture(t, async input => {
    if (input.task.title === 'Second assigned task') await gate;
    return defaultSimulation(input);
  });
  t.after(() => release());
  const first = f.task({ title: 'First assigned task' });
  const second = f.task({ title: 'Second assigned task', agentId: first.agentId, dependencies: [first.id] });
  await f.start();
  await until(() => f.store.require('tasks', first.id).status === 'succeeded' && f.store.require('tasks', second.id).status === 'running');
  const agent = f.store.require('agents', first.agentId);
  const pending = f.store.require('tasks', second.id);
  console.log('QA-03 evidence', JSON.stringify({ firstStatus: f.store.require('tasks', first.id).status, sharedAgentStatus: agent.status, secondStatus: pending.status, secondAttempts: pending.attempts, engineError: f.engine.lastError }));
  assert.notEqual(agent.status, 'retired', 'Completing one task must not retire a worker with another assigned task waiting');
  release();
  await until(() => f.store.require('tasks', second.id).status === 'succeeded', 1500);
  await until(() => f.store.require('agents', first.agentId).status === 'retired');
});

test('QA-04 deleting the last unfinished task refreshes goal completion', async t => {
  const f = await fixture(t);
  const done = f.task({ title: 'Completed work' });
  const obsolete = f.task({ title: 'Obsolete paused work' });
  f.command('task.pause', { id: obsolete.id });
  await f.start();
  await until(() => f.store.require('tasks', done.id).status === 'succeeded' && f.engine.live.size === 0);
  f.command('task.delete', { id: obsolete.id });
  await new Promise(resolve => setTimeout(resolve, 150));
  const goal = f.company.snapshot().goals.find(g => g.id === f.goal.id);
  console.log('QA-04 evidence', JSON.stringify({ status: goal.status, summary: goal.taskSummary }));
  assert.equal(goal.taskSummary.total, goal.taskSummary.done);
  assert.equal(goal.status, 'succeeded', 'A goal with all remaining work complete must not remain active');
  f.command('task.restore', { id: obsolete.id });
  assert.equal(f.store.require('goals', goal.id).status, 'active');
  assert.equal(f.store.require('tasks', obsolete.id).status, 'paused');
});

test('answering while paused records input without resuming; contract edits invalidate questions', async t => {
  const f = await fixture(t); const task = f.task();
  f.engine.block(task, 'human', 'Input needed', 'Question?');
  const interaction = f.store.list('interactions')[0];
  f.command('task.pause', { id: task.id });
  f.command('interaction.answer', { id: interaction.id, answer: 'Supplied' });
  assert.equal(f.store.require('tasks', task.id).status, 'paused');
  f.engine.block(task, 'human', 'More input', 'Old contract?');
  const old = f.store.list('interactions').at(-1);
  f.command('task.edit', { id: task.id, patch: { description: 'A different contract' } });
  assert.throws(() => f.command('interaction.answer', { id: old.id, answer: 'Obsolete' }), { code: 'ALREADY_ANSWERED' });
});

test('purge preserves a shared worker and refuses to assign retired workers', async t => {
  const f = await fixture(t); const first = f.task(); const second = f.task({ agentId: first.agentId });
  f.command('task.delete', { id: first.id }); f.command('task.purge', { id: first.id, confirmTitle: first.title });
  assert.equal(f.store.require('agents', second.agentId).status, 'available');
  f.command('task.cancel', { id: second.id });
  assert.equal(f.store.require('agents', second.agentId).status, 'retired');
  assert.throws(() => f.task({ agentId: second.agentId }), { code: 'AGENT_RETIRED' });
});

test('retiring an assigned role creates an actionable blocker instead of silently skipping', async t => {
  const f = await fixture(t); const task = f.task();
  f.command('agent.save', { id: task.agentId, status: 'retired' }); await f.start();
  await until(() => f.store.list('interactions').some(i => i.taskId === task.id && i.kind === 'assignment'));
  assert.equal(f.store.require('tasks', task.id).status, 'blocked');
  assert.equal(f.store.list('attempts').length, 0);
});
