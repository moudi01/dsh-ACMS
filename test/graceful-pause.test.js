import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

test('graceful company pause lets the active attempt finish and holds all new work and review until resume', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, async input => {
    if (input.task.kind === 'work' && input.task.title === 'Current work') await gate.promise;
    return defaultSimulation(input);
  });
  t.after(() => gate.resolve());
  const task = f.task({ title:'Current work' }); await f.start();
  await until(() => f.store.list('attempts').some(a => a.taskId === task.id && a.status === 'running'));
  f.command('company.pause', { afterCurrent: true });
  const queued = f.task({ title:'Next work' });
  assert.equal(f.company.policy().pauseMode, 'after-current');
  assert.equal(f.store.require('tasks',task.id).stopRequested, null);
  gate.resolve();
  await until(() => f.store.list('attempts')[0].status === 'completed');
  for (let i=0;i<5;i++) await f.engine.tick();
  assert.equal(f.store.list('attempts').length,1);
  assert.equal(f.store.require('tasks',queued.id).status,'ready');
  assert.equal(f.store.list('tasks').find(t=>t.reviewOf===task.id).status,'ready');
  f.command('company.resume');
  await until(() => [task,queued].every(t=>f.store.require('tasks',t.id).status==='succeeded'));
  assert.equal(f.company.policy().pauseMode,null);
  assert(!f.store.list('attempts').some(a=>a.status==='interrupted'));
});
