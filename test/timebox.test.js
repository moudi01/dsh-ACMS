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
  f.store.transaction(() => f.store.put('goals', { ...f.store.require('goals', f.goal.id), runtimeMs: f.company.policy().maxGoalRuntimeMs + 1000 }));
  f.engine.block(task, 'budget', '目标累计执行时间额度已用完', '请填写追加额度');
  const question = f.store.list('interactions').find(item => item.taskId === task.id && item.status === 'pending');
  f.command('interaction.answer', { id: question.id, answer: '追加额度', additionalRuntimeMs: 120000 });
  assert.equal(f.store.require('goals', f.goal.id).timeBox, null);
});
