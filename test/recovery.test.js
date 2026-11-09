import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultSimulation } from '../src/adapters/simulated.js';
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
  assert.deepEqual(f.adapter.calls.map(c => c.task.kind), []);
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
test('goal templates are pinned on creation and later versions do not change in-flight goals', async t => {
  const f = await fixture(t);
  const template = f.command('workflow.publish', { id: 'pin', name: 'v1', phases: [{ id: 'plan', name: '拆分' }, { id: 'execute', name: '执行' }, { id: 'final-review', name: '最终审查' }] });
  const goal = f.command('goal.create', { title: 'Pinned review', description: 'Deliver', acceptance: 'Reviewed', projectId: f.project.id, templateId: template.id, plan: false });
  f.task({ goalId: goal.id });
  // Republishing the same template without final review must not change the
  // in-flight goal: it keeps the creation-time snapshot.
  f.command('workflow.publish', { id: template.id, name: 'v2 direct', phases: [{ id: 'execute', name: '执行' }], expectedRevision: template.revision });
  await f.start();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 15000);
  assert.equal(f.store.require('goals', goal.id).templateSnapshot.version, 1);
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'review').length, 1);

  // The reverse also holds: a goal created without final review does not gain
  // one when a newer template version adds it.
  const direct = f.command('workflow.publish', { id: 'direct', name: 'direct', phases: [{ id: 'execute', name: '执行' }] });
  const plain = f.command('goal.create', { title: 'Pinned direct', description: 'Deliver', acceptance: 'Delivered', projectId: f.project.id, templateId: direct.id, plan: false });
  f.task({ goalId: plain.id });
  f.command('workflow.publish', { id: direct.id, name: 'with review', phases: [{ id: 'plan', name: '拆分' }, { id: 'execute', name: '执行' }, { id: 'final-review', name: '最终审查' }], expectedRevision: direct.revision });
  await until(() => f.store.require('goals', plain.id).status === 'succeeded', 15000);
  assert.equal(f.adapter.calls.filter(c => c.task.kind === 'review').length, 1);
});
test('template versions are pinned for new goals without rewriting existing ones', async t => {
  const f = await fixture(t); const goal = f.goal;
  const template = f.command('workflow.publish', { name: '带最终审查', phases: [{ id: 'plan', name: '拆分' }, { id: 'execute', name: '执行' }, { id: 'final-review', name: '最终审查' }] });
  assert.equal(template.version, 1); assert.equal(template.finalReview, true);
  assert.equal(f.store.require('goals', goal.id).templateId, f.template.id);
  const next = f.command('workflow.publish', { id: template.id, name: '带最终审查', phases: template.phases, expectedRevision: template.revision });
  assert.equal(next.version, 2);
  assert.equal(f.store.require('goals', goal.id).templateId, f.template.id);
  const child = f.task();
  assert.equal(child.workflowSnapshot, undefined); assert.equal(child.stageIndex, undefined);
});


test('coordinated Git integration uses the existing worktree, artifacts and checks', async t => {
  let checkpoint;
  const f = await fixture(t, async input => {
    if (input.task.kind === 'coordination') {
      checkpoint = f.store.require('tasks', input.task.coordinationOf);
      await unlink(path.join(f.source, 'temporary.txt'));
      return { outcome: 'coordinated', summary: 'Target is clean, retry integration from the existing checkpoint' };
    }
    return defaultSimulation(input);
  });
  await gitProject(f);
  await writeFile(path.join(f.source, 'temporary.txt'), 'Block integration until coordination');
  const task = f.task();
  await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
  const final = f.store.require('tasks', task.id);
  assert.equal(final.integration.status, 'merged');
  assert.equal(final.generation, checkpoint.generation);
  assert.deepEqual(final.workspace, checkpoint.workspace);
  assert.deepEqual(final.artifactIds, checkpoint.artifactIds);
  assert.equal(final.artifactHash, checkpoint.artifactHash);
  assert.equal(f.store.list('verifications').filter(record => record.taskId === task.id).length, 1);
  assert.equal(f.adapter.calls.filter(call => call.task.id === task.id).length, 1);
  const events = f.store.page(0, 1000).entries;
  const seq = type => events.find(event => event.type === type && (event.sourceTaskId === task.id || event.entityId === task.id)).seq;
  assert(seq('coordination.decided') < seq('coordination.applied'));
  assert(seq('coordination.applied') < seq('task.integration.resumed'));
  assert(seq('task.integration.resumed') < seq('task.succeeded'));
});

for (const outcome of ['success', 'failure']) test(`late integration ${outcome} leaves a cancelled task alone`, async t => {
  const f = await fixture(t);
  const task = f.task();
  let finish;
  let current;
  f.workspaces.integrate = async (_task, isCurrent) => {
    current = isCurrent;
    await new Promise(resolve => { finish = resolve; });
    if (outcome === 'failure') throw new Error('Late integration failure');
    return { status: 'available' };
  };
  await f.start();
  await until(() => finish);
  f.command('task.cancel', { id: task.id });
  assert.equal(current(), false);
  finish();
  await f.engine.integration;
  assert.equal(f.store.require('tasks', task.id).status, 'cancelled');
  assert.equal(f.store.list('interactions').length, 0);
  assert.equal(f.store.list('tasks').filter(row => row.kind === 'coordination').length, 0);
});


test('editing goal acceptance invalidates the integration checkpoint before coordination releases it', async t => {
  const f = await fixture(t, async input => {
    if (input.task.kind === 'coordination') return { outcome: 'coordinated', summary: 'Continue the existing task' };
    await writeFile(path.join(input.task.workspace.path, 'delivery.txt'), `Delivery for generation ${input.task.generation}`);
    return { outcome: 'completed', artifacts: [{ path: 'delivery.txt' }] };
  });
  const integrationHashes = [];
  f.workspaces.integrate = async task => {
    integrationHashes.push(task.artifactHash);
    if (integrationHashes.length === 1) {
      f.command('company.pause', { afterCurrent: true });
      throw new Error('Isolated integration failure');
    }
    return { status: 'available' };
  };

  const task = f.task();
  await f.start();
  const blocked = await until(() => {
    const current = f.store.require('tasks', task.id);
    return current.blocker?.kind === 'coordination' && current;
  });
  assert.equal(blocked.integrationPending, true);
  const acceptance = 'Delivery must satisfy the revised goal contract';
  f.command('goal.edit', { id: task.goalId, patch: { acceptance } });
  const edited = f.store.require('tasks', task.id);
  assert.equal(edited.generation, blocked.generation + 1);
  assert.equal(edited.integrationPending, false);
  f.command('company.resume');

  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const delivered = f.store.require('tasks', task.id);
  const calls = f.adapter.calls.filter(call => call.task.id === task.id);
  assert.deepEqual(calls.map(call => call.attempt.taskGeneration), [blocked.generation, edited.generation]);
  assert.match(calls[1].prompt, /Delivery must satisfy the revised goal contract/);
  assert.notEqual(delivered.artifactHash, blocked.artifactHash);
  assert.deepEqual(integrationHashes, [blocked.artifactHash, delivered.artifactHash]);
  assert.deepEqual(f.store.list('verifications').filter(record => record.taskId === task.id).map(record => record.artifactHash), integrationHashes);
});
