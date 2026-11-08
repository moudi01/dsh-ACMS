import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { run } from '../src/runtime/workspaces.js';

test('reviewer gets its own writable verification copy while the original delivery stays unchanged', async t => {
  const f = await fixture(t); const task = f.task(); const sourceWorkspace = await f.workspaces.prepare(task, {});
  await writeFile(path.join(sourceWorkspace.path, 'output.txt'), 'Original delivery');
  f.store.transaction(() => f.store.put('tasks', { ...task, workspace: sourceWorkspace }));
  const reviewWorkspace = await f.workspaces.prepare({ id: 'review-copy-test', reviewOf: task.id, reviewArtifactHash: 'version-1' }, {});
  assert.notEqual(reviewWorkspace.path, sourceWorkspace.path);
  await writeFile(path.join(reviewWorkspace.path, 'output.txt'), 'Scratch experiment');
  assert.equal(await readFile(path.join(sourceWorkspace.path, 'output.txt'), 'utf8'), 'Original delivery');
});

test('clean host shutdown resumes interrupted work automatically on restart', async t => {
  const f = await fixture(t); f.adapter.delay = 500; const task = f.task({ longLived: true }); await f.start();
  await until(() => f.adapter.active === 1); await f.engine.stop();
  assert.equal(f.store.require('tasks', task.id).resumeOnStart, true);
  f.adapter.delay = 5; await f.engine.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.store.require('agents', task.agentId).status, 'available');
  assert.equal(f.adapter.calls[0].attempt.contextKey, f.adapter.calls[1].attempt.contextKey);
});
test('durable completed receipt is accepted after restart without re-running the worker', async t => {
  const f = await fixture(t); let task = f.task(); const workspace = await f.workspaces.prepare(task, {});
  await writeFile(path.join(workspace.path, 'output.md'), 'Recovered durable delivery');
  const attempt = { id: 'durable-result', taskId: task.id, goalId: task.goalId, agentId: task.agentId, taskGeneration: 1, role: 'worker', grants: [], status: 'running', startedAt: new Date().toISOString() };
  f.store.transaction(() => { task = f.store.put('tasks', { ...task, workspace, status: 'running', activeAttemptId: attempt.id }); f.store.put('attempts', attempt); });
  f.adapter.reconcile = async () => ({ status: 'completed', finishedAt: new Date().toISOString(), result: { outcome: 'completed', summary: 'Recovered', artifacts: [{ path: 'output.md' }] } });
  await f.start(); await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.deepEqual(f.adapter.calls.map(c => c.task.kind), ['review']);
  assert(f.store.page(0).entries.some(e => e.type === 'attempt.result.recovered'));
});
test('failed acceptance checks are retained as evidence and block independent approval', async t => {
  const f = await fixture(t);
  f.command('project.save', { id: f.project.id, checks: [{ id: 'reject', command: 'node', args: ['-e', 'console.error("Owner check rejected output");process.exit(2)'] }] });
  const task = f.task(); await f.start(); await until(() => f.store.list('verifications').some(v => v.taskId === task.id && v.passed === false));
  const check = f.store.list('verifications')[0].checks[0]; assert.equal(check.code, 2); assert.match(check.stderr, /Owner check rejected/);
  assert(!f.adapter.calls.some(c => c.task.kind === 'review'));
});
async function gitProject(f, checks = []) {
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=ACMS Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Initial fixture']]) {
    const result = await run('git', args, f.source); assert.equal(result.code, 0, result.stderr);
  }
  f.command('project.save', { id: f.project.id, mode: 'git', autoMerge: true, checks });
  return (await run('git', ['rev-parse', 'HEAD'], f.source)).stdout;
}
test('reviewed Git delivery is validated in an isolated candidate then fast-forwarded', async t => {
  const f = await fixture(t); const before = await gitProject(f); const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
  const saved = f.store.require('tasks', task.id); assert.equal(saved.integration.status, 'merged');
  assert.notEqual((await run('git', ['rev-parse', 'HEAD'], f.source)).stdout, before);
  assert((await readFile(path.join(f.source, 'deliverable.md'), 'utf8')).length > 0);
  assert(saved.changeSet.some(c => c.path === 'deliverable.md'));
});
test('a failed integration candidate opens manager coordination and leaves the source project commit unchanged', async t => {
  const f = await fixture(t); const before = await gitProject(f, [{ id: 'integration-regression', command: 'node', args: ['-e', "process.exit(process.cwd().includes('integration')?1:0)"] }]);
  const task = f.task(); await f.start();
  const routed = await until(() => f.store.page(0, 1000).entries.find(entry => entry.type === 'blocker.coordinated' && entry.blockerKind === 'integration'), 20000);
  assert.equal(routed.route, 'manager');
  const coordinations = f.store.list('tasks').filter(item => item.kind === 'coordination' && item.coordinationOf === task.id);
  assert.equal(coordinations.length, 1);
  assert.equal(coordinations[0].agentId, 'manager');
  // After the manager decision the same blocker is handed to the owner instead of looping.
  const blocked = await until(() => { const saved = f.store.require('tasks', task.id); return saved.blocker?.kind === 'integration' ? saved : null; }, 20000);
  assert.equal(f.store.list('tasks').filter(item => item.kind === 'coordination' && item.coordinationOf === task.id).length, 1);
  assert.equal((await run('git', ['rev-parse', 'HEAD'], f.source)).stdout, before);
  // Project registration now creates host-owned collaboration metadata. A failed
  // integration must still leave every business file and the source commit intact.
  assert.equal((await run('git', ['status', '--porcelain'], f.source)).stdout, '?? .acms/\n');
});
test('workflow migration pins a new version and invalidates the old contract at a safe point', async t => {
  const f = await fixture(t); const task = f.task(); const workflow = f.command('workflow.publish', { id: 'default', name: 'New review', steps: [{ id: 'work', name: 'Work', type: 'work' }, { id: 'review', name: 'Review', type: 'review' }] });
  assert.equal(f.store.require('tasks', task.id).workflowSnapshot.version, 1);
  const changed = f.command('task.migrateWorkflow', { id: task.id, workflowId: workflow.id, reason: 'New acceptance policy' });
  assert.equal(changed.status, 'paused'); assert.equal(changed.workflowSnapshot.version, 2); assert.equal(changed.generation, 2);
});
