import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { submitGoal } from '../src/core/external-access.js';
import { OWNER } from '../src/core/util.js';

function blockingSimulation() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const handler = async input => {
    if (input.task.kind === 'work') { calls.push(input.task); await gate; }
    return defaultSimulation(input);
  };
  return { handler, calls, release: () => release() };
}

function goal(f, title, priority) {
  return f.command('goal.create', { title, description: `${title} 描述`, acceptance: `${title} 验收`, projectId: f.project.id, templateId: f.template.id, plan: false, priority });
}
function task(f, goalRecord, title, priority) {
  return f.task({ goalId: goalRecord.id, title, priority });
}

test('单名额下目标优先级决定同类任务的首次派发', async t => {
  const sim = blockingSimulation();
  const f = await fixture(t, sim.handler);
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  const low = goal(f, '低优先级目标', 0);
  const high = goal(f, '高优先级目标', 100);
  const lowTask = task(f, low, '低优先级目标的任务');
  const highTask = task(f, high, '高优先级目标的任务');
  await f.start();
  await until(() => sim.calls.length === 1);
  assert.equal(sim.calls[0].goalId, high.id);
  sim.release();
  await until(() => f.store.get('tasks', highTask.id)?.status === 'succeeded' && f.store.get('tasks', lowTask.id)?.status === 'succeeded');
});

test('同优先级目标按任务创建时间稳定派发', async t => {
  const sim = blockingSimulation();
  const f = await fixture(t, sim.handler);
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  const first = goal(f, '同优先级先创建', 50);
  const second = goal(f, '同优先级后创建', 50);
  const firstTask = task(f, first, '先创建目标的任务');
  const secondTask = task(f, second, '后创建目标的任务');
  await f.start();
  await until(() => sim.calls.length === 1);
  assert.equal(sim.calls[0].goalId, first.id);
  sim.release();
  await until(() => f.store.get('tasks', firstTask.id)?.status === 'succeeded' && f.store.get('tasks', secondTask.id)?.status === 'succeeded');
});

test('高优先级目标不可派发时不阻塞其他目标', async t => {
  const sim = blockingSimulation();
  const f = await fixture(t, sim.handler);
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  const paused = goal(f, '高优先级但暂停', 100);
  const ready = goal(f, '低优先级可执行', 0);
  const pausedTask = task(f, paused, '暂停目标的任务');
  const readyTask = task(f, ready, '可执行目标的任务');
  f.command('goal.pause', { id: paused.id });
  await f.start();
  await until(() => sim.calls.length === 1);
  assert.equal(sim.calls[0].goalId, ready.id);
  assert.equal(f.store.get('tasks', pausedTask.id)?.status, 'ready');
  sim.release();
  await until(() => f.store.get('tasks', readyTask.id)?.status === 'succeeded');
});

test('任务优先级高于目标优先级，目标优先级只在同类任务之间比较', async t => {
  const sim = blockingSimulation();
  const f = await fixture(t, sim.handler);
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  const highGoal = goal(f, '高优先级目标低优先级任务', 100);
  const lowGoal = goal(f, '低优先级目标高优先级任务', 0);
  const slow = task(f, highGoal, '目标优先级高但任务优先级低', 0);
  const fast = task(f, lowGoal, '目标优先级低但任务优先级高', 100);
  await f.start();
  await until(() => sim.calls.length === 1);
  assert.equal(sim.calls[0].goalId, lowGoal.id);
  sim.release();
  await until(() => f.store.get('tasks', fast.id)?.status === 'succeeded' && f.store.get('tasks', slow.id)?.status === 'succeeded');
});

test('所有者可以修改目标优先级，且优先级变化不触发合同变更', async t => {
  const f = await fixture(t);
  const record = goal(f, '可编辑优先级目标', 50);
  assert.equal(record.priority, 50);
  const edited = f.command('goal.edit', { id: record.id, expectedRevision: record.revision, patch: { priority: 10 } });
  assert.equal(edited.priority, 10);
  assert.equal(edited.contractVersion, record.contractVersion);
  assert.equal(edited.status, record.status);
  assert.throws(() => f.command('goal.edit', { id: record.id, expectedRevision: edited.revision, patch: { priority: 101 } }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.command('goal.edit', { id: record.id, expectedRevision: edited.revision, patch: { priority: 'high' } }), { code: 'INVALID_INPUT' });
});

test('外部目标提交的优先级默认 50，显式值原样保存', async t => {
  const f = await fixture(t);
  const actor = { kind: 'user-agent', id: 'external-test-agent', onBehalfOf: OWNER };
  const base = { description: '外部提交目标', acceptance: '完成', projectId: f.project.id, plan: false };
  const submitted = f.store.transaction(() => submitGoal(f.company, { ...base, title: '外部默认优先级' }, actor, { transport: 'test' }));
  assert.equal(f.store.require('goals', submitted.goalId).priority, 50);
  const explicit = f.store.transaction(() => submitGoal(f.company, { ...base, title: '外部显式优先级', priority: 7 }, actor, { transport: 'test' }));
  assert.equal(f.store.require('goals', explicit.goalId).priority, 7);
});
