import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { beginPanelRewind, selectPanelSnapshot } from '../src/client/panel-snapshot.js';
import { Store } from '../src/core/store.js';
import { createRoutes } from '../src/host/http.js';
import { OWNER } from '../src/core/util.js';

const routesFor = fixture => {
  const routes = new Map(createRoutes(fixture).map(route => [route.path, route.fetch]));
  return async resource => {
    const url = new URL('/api/acms/' + resource, 'http://dsh');
    const response = await routes.get(url.pathname)(new Request(url));
    return { status: response.status, value: await response.json() };
  };
};

test('panel keeps live and held attempts while scoped history retains old evidence and isolates tasks', async t => {
  const f = await fixture(t);
  const a = f.task();
  const projectB = f.command('project.save', { name: 'another project', repoRoot: f.root, mode: 'copy' });
  const goalB = f.command('goal.create', { title: 'another goal', description: 'history isolation', acceptance: 'verified',
    projectId: projectB.id, templateId: f.template.id, plan: false });
  const b = f.task({ goalId: goalB.id });
  const deleted = f.task();
  f.command('task.delete', { id: deleted.id });

  function attempt(task, id, extra = {}) {
    f.store.put('attempts', { id, taskId: task.id, goalId: task.goalId, agentId: 'manager', status: 'completed',
      summary: 'history for ' + id, meteredUsage: { privateFixture: true }, environment: { report: id }, ...extra });
  }
  f.store.transaction(() => {
    attempt(a, 'a-recovery', { status: 'reconciling', cleanupPending: true, recovery: { reason: 'original receipt still unverified' } });
    attempt(a, 'a-legacy-hold', { cleanupUncertain: true });
    attempt(a, 'a-memory-only');
    for (let index = 0; index < 34; index++) attempt(a, 'a-' + index);
    for (let index = 0; index < 9; index++) attempt(b, 'b-' + index);
    attempt(deleted, 'deleted-hold', { cleanupPending: true });
    f.store.put('verifications', { id: 'a-old-verification', attemptId: 'a-0', summary: 'original evidence' });
    f.store.put('verifications', { id: 'b-verification', taskId: b.id, attemptId: 'b-0', summary: 'other evidence' });
  });
  f.engine.live.set('a-memory-only', {});
  const read = routesFor(f);
  const counted = { tasks: 0, attempts: 0, deliveries: 0 };
  const list = f.store.list.bind(f.store), delivered = f.store.deliveredWorkForGoal.bind(f.store);
  f.store.list = collection => {
    if (collection === 'tasks' || collection === 'attempts') counted[collection]++;
    return list(collection);
  };
  f.store.deliveredWorkForGoal = id => { counted.deliveries++; return delivered(id); };

  const legacy = (await read('state')).value;
  assert.deepEqual(counted, { tasks: 1, attempts: 1, deliveries: 0 });
  assert.equal(legacy.attemptsView, undefined);
  assert.equal(legacy.attempts.length, 46);
  Object.assign(counted, { tasks: 0, attempts: 0, deliveries: 0 });
  const panel = (await read('state?view=panel')).value;
  assert.deepEqual(counted, { tasks: 1, attempts: 0, deliveries: 0 });
  assert.equal(panel.attemptsView, 'panel');
  assert.deepEqual(panel.attempts.map(item => item.id),
    ['a-recovery', 'a-legacy-hold', 'a-memory-only', ...Array.from({ length: 8 }, (_, index) => 'b-' + (index + 1))]);
  assert(panel.attempts.every(item => !item.summary && !item.meteredUsage && !item.environment));
  assert(panel.runtime.capacity.entries.some(entry => entry.id === 'deleted-hold' && entry.phase === 'cleanupPending'));
  assert.match(panel.trash[0].purgeReason, /执行资源/);
  const { attempts: rawAttempts, ...rest } = legacy;
  const { attempts: panelAttempts, attemptsView, ...panelRest } = panel;
  assert.deepEqual(panelRest, rest);

  const { value: first } = await read('task-attempts?taskId=' + a.id);
  const { value: older } = await read('task-attempts?taskId=' + a.id + '&before=' + first.nextBefore);
  assert.equal(first.cursor, panel.cursor);
  assert.equal(first.taskId, a.id);
  assert.equal(first.attempts.length, 30);
  assert.equal(first.attempts[0].summary, 'history for a-33');
  assert.equal(first.activeAttempts.find(item => item.id === 'a-recovery').recovery.reason, 'original receipt still unverified');
  assert.deepEqual(first.verifications.map(item => item.id), ['a-old-verification']);
  assert.equal(older.nextBefore, null);
  assert.equal(older.verifications, undefined);
  assert.equal(older.attempts.at(-1).id, 'a-recovery');
  assert(first.attempts.at(-1).historyPosition > older.attempts[0].historyPosition);
  f.store.put('attempts', { ...f.store.require('attempts', 'a-recovery'), cleanupPending: false, status: 'completed' });
  attempt(a, 'a-new-without-event');
  const updated = (await read('task-attempts?taskId=' + a.id + '&refresh=a-recovery&refresh=b-0')).value;
  assert.equal(updated.cursor, first.cursor);
  assert.equal(updated.attempts[0].id, 'a-new-without-event');
  assert(updated.attempts[0].historyPosition > first.attempts[0].historyPosition);
  assert.deepEqual(updated.refreshedAttempts.map(item => [item.id, item.status]), [['a-recovery', 'completed']]);
  assert.equal((await read('task-attempts?taskId=' + a.id + '&before=' + first.nextBefore + '&refresh=a-recovery')).status, 400);
  const visible = [...first.attempts, ...older.attempts];
  assert.equal(new Set(visible.map(item => item.id)).size, 37);
  assert(visible.every(item => item.taskId === a.id && item.meteredUsage === undefined));
  assert.deepEqual((await read('task-attempts?taskId=' + b.id)).value.attempts
    .map(item => item.taskId), Array(9).fill(b.id));
  assert.equal((await read('task-attempts?taskId=' + deleted.id)).status, 404);
  assert.equal((await read('task-attempts?taskId=' + a.id + '&before=0')).status, 400);
});

test('confirmed panel rewind invalidates in-flight state before a restored database can catch up', () => {
  const select = (previous, cursor, request, epoch = 0) => selectPanelSnapshot(previous, { cursor }, request, epoch);
  const newest = select(null, 20, 1);
  assert.equal(select(newest, 19, 2), newest);
  const advanced = select(newest, 21, 1);
  assert.equal(advanced.state.cursor, 21);
  const resetting = beginPanelRewind(advanced, 0);
  assert.equal(resetting.state, null);
  assert.equal(resetting.epoch, 1);
  assert.equal(select(resetting, 22, 4, 0), resetting);
  assert.equal(beginPanelRewind(resetting, 0), resetting);
  assert.equal(beginPanelRewind(resetting, 1), resetting);

  for (const cursor of [8, 21, 25]) {
    const restored = select(resetting, cursor, 3, 1);
    assert.equal(restored.epoch, 1);
    assert.equal(restored.state.cursor, cursor);
    assert.equal(select(restored, 26, 4, 0), restored);
    assert.equal(beginPanelRewind(restored, 0), restored);
    assert.equal(select(restored, cursor + 1, 5, 1).state.cursor, cursor + 1);
  }
});

test('panel state, capacity and event cursor come from the same SQLite read snapshot', async t => {
  const f = await fixture(t);
  const task = f.task();
  const initialCursor = f.store.cursor();
  const writer = new Store(f.store.filename);
  const list = f.store.list.bind(f.store);
  let updated = false;
  f.store.list = collection => {
    if (collection === 'goals' && !updated) {
      updated = true;
      writer.transaction(() => {
        writer.put('tasks', { ...writer.require('tasks', task.id), title: 'new checkpoint', status: 'running' });
        writer.put('attempts', { id: 'attempt-new', taskId: task.id, goalId: f.goal.id, status: 'running' });
        writer.event('task.changed', task.id, {}, OWNER);
      });
    }
    return list(collection);
  };

  try {
    const read = routesFor(f);
    const { value: first } = await read('state?view=panel');
    assert.equal(first.cursor, initialCursor);
    assert.equal(first.tasks[0].title, task.title);
    assert.equal(first.runtime.capacity.used, 0);
    const { value: page } = await read('events?after=' + first.cursor);
    assert.deepEqual(page.entries.map(item => item.type), ['task.changed']);
    const { value: next } = await read('state?view=panel');
    assert.equal(next.cursor, page.nextCursor);
    assert.equal(next.tasks[0].title, 'new checkpoint');
    assert.equal(next.runtime.capacity.entries[0].id, 'attempt-new');
  } finally { writer.close(); }
});
