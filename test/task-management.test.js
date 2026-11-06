import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createRoutes } from '../src/host/http.js';
import { browseDirectories } from '../src/host/directories.js';
import { OWNER } from '../src/core/util.js';
import { taskAncestors } from '../src/core/hierarchy.js';

test('deleted plan disappears from overview rollups without deleting its goal', async t => {
  const f = await fixture(t); const goal = f.command('goal.create', { title: 'Empty goal', description: 'Fixture', acceptance: 'Fixture', projectId: f.project.id });
  const plan = f.store.list('tasks').find(t => t.goalId === goal.id); f.command('task.delete', { id: plan.id });
  const snapshot = f.company.snapshot(); assert.equal(snapshot.tasks.some(t => t.id === plan.id), false);
  assert.deepEqual(snapshot.goals.find(g => g.id === goal.id).taskSummary, { status: 'empty', total: 0, done: 0 });
  const parent = f.task({ title: 'Parent' }); const child = f.task({ title: 'Child', parentId: parent.id }); const sub = f.task({ title: 'Nested', parentId: child.id });
  assert.deepEqual(taskAncestors(sub, f.company.snapshot().tasks).map(t => t.title), ['Parent', 'Child']);
});

test('purge requires owner, exact confirmation and no dependent tasks including trash; removes evidence records', async t => {
  const f = await fixture(t); const parent = f.task({ title: 'Parent' }); const child = f.task({ title: 'Child', parentId: parent.id });
  f.command('task.delete', { id: child.id }); f.command('task.delete', { id: parent.id });
  assert.throws(() => f.command('task.purge', { id: parent.id, confirmTitle: parent.title }), { code: 'PURGE_BLOCKED' });
  assert.throws(() => f.command('task.purge', { id: child.id, confirmTitle: 'wrong' }), { code: 'CONFIRM_PURGE' });
  assert.throws(() => f.command('task.purge', { id: child.id, confirmTitle: child.title }, { kind: 'agent', id: 'manager' }), { code: 'FORBIDDEN' });
  for (const collection of ['attempts', 'artifacts', 'verifications', 'interactions']) f.store.put(collection, { id: 'purge-fixture', taskId: child.id, status: 'completed' });
  const request = 'purge-replay-fixture'; const args = { id: child.id, confirmTitle: child.title, expectedRevision: f.store.require('tasks', child.id).revision };
  assert.equal(f.command('task.purge', args, OWNER, request).purged, true); assert.equal(f.command('task.purge', args, OWNER, request).purged, true);
  assert.equal(f.store.get('tasks', child.id), null); for (const c of ['attempts', 'artifacts', 'verifications', 'interactions']) assert.equal(f.store.get(c, 'purge-fixture'), null);
  assert.throws(() => f.command('task.restore', { id: child.id }), { code: 'NOT_FOUND' });
  f.command('task.purge', { id: parent.id, confirmTitle: parent.title }); assert.equal(f.company.snapshot().trash.length, 0);
});

test('delete and restore keep evidence, hide tasks from normal snapshots, and never redispatch restored work', async t => {
  const f = await fixture(t); const task = f.task();
  f.command('task.delete', { id: task.id });
  assert.equal(f.company.snapshot().tasks.length, 0); assert.equal(f.company.snapshot().trash[0].id, task.id);
  assert.equal(f.store.require('tasks', task.id).status, 'deleted');
  assert.throws(() => f.command('task.resume', { id: task.id }), { code: 'INVALID_TRANSITION' });
  f.command('task.restore', { id: task.id }); assert.equal(f.company.snapshot().tasks[0].status, 'paused');
  await f.start(); assert.equal(f.adapter.calls.length, 0); assert.equal(f.company.snapshot().trash.length, 0);
});
test('deletion protects active runs, cleanup, dependencies and owner authority', async t => {
  const f = await fixture(t); const a = f.task(); const b = f.task({ dependencies: [a.id] });
  assert.throws(() => f.command('task.delete', { id: a.id }), { code: 'DELETE_BLOCKED' });
  assert.throws(() => f.command('task.delete', { id: b.id }, { kind: 'agent', id: 'manager', goalId: f.goal.id }), { code: 'FORBIDDEN' });
  f.command('task.delete', { id: b.id });
  f.store.put('attempts', { id: 'test-cleanup', taskId: a.id, status: 'completed', cleanupPending: true });
  assert.throws(() => f.command('task.delete', { id: a.id }), { code: 'DELETE_BLOCKED' });
  f.store.put('attempts', { id: 'test-cleanup', taskId: a.id, status: 'completed', cleanupPending: false });
  f.command('task.delete', { id: a.id }); assert.equal(f.company.snapshot().attempts.length, 0); assert.equal(f.store.list('attempts').length, 1);
});
test('project and goal are created in one transaction; failed goal validation leaves no project', async t => {
  const f = await fixture(t); const before = f.store.list('projects').length;
  const args = { project: { name: 'Inline project', repoRoot: f.source, mode: 'copy' }, goal: { title: 'Inline goal', description: 'Deliver', acceptance: 'Evidence', plan: false } };
  const goal = f.command('goal.createWithProject', args); assert.equal(f.store.require('projects', goal.projectId).name, 'Inline project');
  assert.throws(() => f.command('goal.createWithProject', { ...args, goal: { ...args.goal, title: '' } })); assert.equal(f.store.list('projects').length, before + 1);
  const route = createRoutes(f).find(r => r.path.endsWith('/command'));
  const bad = await route.fetch(new Request('http://dsh/api/acms/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'bad-directory', name: 'goal.createWithProject', args: { ...args, project: { ...args.project, repoRoot: `${f.root}/missing` } } }) }));
  assert.equal(bad.status, 400); assert.equal(f.store.list('projects').length, before + 1);
});
test('directory browser lists real folders and respects configured project roots', async t => {
  const f = await fixture(t); const policy = { allowedProjectRoots: [f.source] };
  const roots = await browseDirectories('', policy); assert.equal(roots.directories.length, 1);
  const listing = await browseDirectories(f.source, policy); assert.equal(listing.path, roots.directories[0].path); assert.equal(listing.parent, '');
  await assert.rejects(browseDirectories(f.root, policy), { code: 'PROJECT_PATH_DENIED' });
});
