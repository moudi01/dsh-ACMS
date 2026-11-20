import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Company } from '../src/core/domain.js';
import { Store } from '../src/core/store.js';
import { createRoutes } from '../src/host/http.js';
import { createAgentApi } from '../src/host/agent-api.js';
import { Engine } from '../src/runtime/engine.js';
import { cleanupError } from '../src/runtime/owned-process.js';
import { run, WorkspaceManager } from '../src/runtime/workspaces.js';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { fixture, gitProject, taskWaitDiagnostics, until } from './helpers.js';

const branch = 'refs/heads/delivery';
const binary = Buffer.from([0, 8, 255, 128]);
const receipt = (file, fields) => fs.writeFile(file, JSON.stringify({ confirmed: true, ...fields }));
const sourceStatus = cwd => git(cwd, 'status', '--porcelain', '--', '.', ':(exclude).acms');

async function git(cwd, ...args) {
  const output = await run('git', args, cwd);
  assert.equal(output.code, 0, output.stderr);
  return output.stdout.trim();
}

function ownerRoutes(runtime) {
  const handlers = new Map(createRoutes(runtime).map(route => [route.path, route]));
  const post = (route, body) => handlers.get(`/api/acms/${route}`).fetch(new Request(`http://127.0.0.1/api/acms/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return {
    preview: input => post('composition/merge-preview', input),
    decision: (action, args, requestId = randomUUID()) => post('command', { name: `goal.candidate_merge.${action}`, args, requestId }),
  };
}

async function success(response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.value ?? body;
}

async function failure(response, code, status = 409) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code, body.error.message);
  return body.error;
}

async function setup(t, { review, autoMerge = false } = {}) {
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    if (input.task.kind === 'review') {
      if (!autoMerge) assert.deepEqual(await fs.readFile(path.join(cwd, 'raw.bin')), binary);
      review.entered.resolve();
      await review.release.promise;
      return { outcome: 'reviewed', decision: 'approve', summary: 'Reviewed exact binary candidate' };
    }
    await fs.unlink(path.join(cwd, 'obsolete.txt'));
    await fs.writeFile(path.join(cwd, 'README.md'), '# Checked update\n');
    await fs.writeFile(path.join(cwd, 'raw.bin'), binary);
    return { outcome: 'completed', artifacts: [{ path: 'raw.bin' }] };
  });
  await fs.writeFile(path.join(f.source, 'obsolete.txt'), 'baseline file');
  const checks = [{ id: 'binary-check', command: process.execPath, args: ['-e', `const fs=require('node:fs');
    if (fs.existsSync('obsolete.txt') || !fs.readFileSync('raw.bin').equals(Buffer.from([0,8,255,128]))) process.exit(4);`] }];
  const base = (await gitProject(f, checks)).trim();
  await git(f.source, 'branch', 'delivery');
  f.command('project.save', { id: f.project.id, autoMerge });
  const goal = f.command('goal.create', { projectId: f.project.id, templateId: review ? 'base' : f.template.id, plan: false,
    title: 'Owner acceptance', description: 'Assemble verified Git changes', acceptance: 'Merge the exact accepted source tree',
    ...(autoMerge ? {} : { deliveryMode: 'git-composite' }) });
  const task = f.task({ goalId: goal.id });
  let beforeApply, afterGuard, afterApply;
  let applyCalls = 0;
  f.workspaces.runIntegrationCommand = f.workspaces.runDeliveryCheck = async (command, args, cwd, options) => {
    const apply = args.includes('update-ref') && args.includes('--no-deref');
    if (apply) await beforeApply?.();
    try { options.beforeStart?.(command); }
    catch (error) {
      await receipt(options.cleanupReceipt, { exitCode: 1, notStarted: true });
      throw error;
    }
    if (apply) await afterGuard?.();
    if (apply) applyCalls++;
    const result = await run(command, args, cwd, options);
    if (apply) await afterApply?.(result, options.cleanupReceipt);
    if (options.cleanupReceipt) await receipt(options.cleanupReceipt, { exitCode: result.code ?? 1 });
    return { ...result, cleanupConfirmed: true };
  };
  const current = () => f.store.require('goals', goal.id);
  const snapshot = () => f.company.snapshot().goals.find(row => row.id === goal.id);
  const diagnostics = () => ({ ...taskWaitDiagnostics(f, task.id)(), goalStatus: current().status,
    review: snapshot().reviewSummary, candidateMerge: current().candidateMerge,
    integrations: f.store.list('integrations').filter(record => record.goalId === goal.id).map(({ phase, reason, commandId }) => ({ phase, reason, commandId })) });
  const checkWork = () => {
    const failed = f.store.list('integrations').find(record => record.goalId === goal.id && !record.candidateMergeId && ['failed', 'blocked'].includes(record.phase));
    const attempted = f.store.list('attempts').find(record => record.goalId === goal.id && record.status === 'failed');
    assert(!failed && !attempted, failed?.reason ?? attempted?.summary ?? JSON.stringify(diagnostics()));
  };
  const ready = () => until(() => { checkWork(); return snapshot().finalComposition; }, 75000, diagnostics);
  const routes = ownerRoutes(f);
  const preview = (targetRef = branch) => routes.preview({ goalId: goal.id, version: current().composition?.version,
    deliveryHash: f.company.deliveryHash(goal.id), targetRef });
  const confirmArgs = request => ({ id: goal.id, previewId: request.id, version: request.selection.version,
    deliveryHash: request.selection.deliveryHash, targetHead: request.targetHead, targetRef: request.targetRef });
  const waitMerge = status => until(() => {
    const request = current().candidateMerge;
    if (request?.status === status) return request;
    assert(request?.status !== 'failed' && request?.status !== 'cancelled', JSON.stringify(diagnostics()));
  }, 75000, diagnostics);
  return { f, goal, task, base, current, snapshot, diagnostics, checkWork, routes, preview, confirmArgs, ready, waitMerge,
    applyCalls: () => applyCalls, beforeApply: hook => { beforeApply = hook; }, afterGuard: hook => { afterGuard = hook; }, afterApply: hook => { afterApply = hook; } };
}

test('owner waits for required review, previews a named branch, rejects, then confirms the exact Git tree once', async t => {
  const review = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const s = await setup(t, { review });
  const { f, base, routes, preview, confirmArgs } = s;
  await git(f.source, 'branch', 'other');
  const originalStatus = await sourceStatus(f.source);
  try {
    await f.start();
    let reviewRunning = false;
    review.entered.promise.then(() => { reviewRunning = true; });
    await until(() => { s.checkWork(); return reviewRunning; }, 75000, s.diagnostics);
    assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
    await failure(await preview(), 'CANDIDATE_NOT_READY');
  } finally { review.release.resolve(); }
  const selected = await s.ready();
  assert(selected.reviewId);
  const originalIndex = await fs.readFile(path.join(f.source, '.git', 'index'));
  await failure(await preview('refs/heads/main'), 'TARGET_BRANCH_CHECKED_OUT');
  const otherWorktree = path.join(f.root, 'existing-worktree');
  await git(f.source, 'worktree', 'add', otherWorktree, 'other');
  await failure(await preview('refs/heads/other'), 'TARGET_BRANCH_CHECKED_OUT');
  const originalWorktrees = await git(f.source, 'worktree', 'list', '--porcelain');
  const rejected = await success(await preview());
  assert.equal(rejected.targetRef, branch);
  assert.equal(rejected.targetHead, base);
  assert.deepEqual(rejected.summary.items, [{ change: 'M', path: 'README.md' }, { change: 'D', path: 'obsolete.txt' }, { change: 'A', path: 'raw.bin' }]);
  assert.deepEqual(rejected.checks.map(check => [check.id, check.inputHash, check.code]),
    [['binary-check', s.current().composition.checks[0].inputHash, 0]]);
  assert.equal(rejected.selection.reviewId, selected.reviewId);
  assert.equal((await success(await routes.decision('reject', { id: s.goal.id, previewId: rejected.id }))).status, 'rejected');
  await failure(await routes.decision('confirm', confirmArgs(rejected)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(f.source, 'worktree', 'list', '--porcelain'), originalWorktrees);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), originalIndex);
  assert.equal(await sourceStatus(f.source), originalStatus);
  await assert.rejects(fs.stat(path.join(f.source, '.git', 'FETCH_HEAD')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.source, 'raw.bin')), { code: 'ENOENT' });

  const chosen = await success(await preview());
  const args = confirmArgs(chosen);
  const credential = f.command('agentCredential.create', { name: 'Read scoped', projectIds: [f.project.id], goalIds: [s.goal.id], commands: ['status.read'] });
  const agent = createAgentApi(f);
  await agent.start();
  try {
    const headers = { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' };
    assert.equal((await fetch(agent.baseUrl + '/goals/' + s.goal.id, { headers })).status, 200);
    assert.equal((await fetch(new URL('/api/acms/command', agent.baseUrl), {
      method: 'POST', headers, body: JSON.stringify({ name: 'goal.candidate_merge.confirm', args, requestId: randomUUID() }),
    })).status, 404);
  } finally { await agent.close(); }
  await failure(await routes.decision('confirm', { ...args, targetRef: 'refs/heads/other' }), 'STALE_CANDIDATE_CONFIRMATION');
  const confirmationId = randomUUID();
  assert.equal((await success(await routes.decision('confirm', args, confirmationId))).status, 'queued');
  const applied = await s.waitMerge('applied');
  assert.equal(await git(f.source, 'rev-parse', branch + '^{tree}'), chosen.selection.tree);
  const head = await git(f.source, 'rev-parse', branch);
  assert.equal(applied.result.integratedCommit, head);
  assert.equal(await git(f.source, 'rev-list', '--parents', '-n', '1', head), `${head} ${base}`);
  assert.equal(await git(f.source, 'rev-parse', 'other'), base);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(f.source, 'worktree', 'list', '--porcelain'), originalWorktrees);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), originalIndex);
  await assert.rejects(fs.stat(path.join(f.source, 'raw.bin')), { code: 'ENOENT' });
  const verification = path.join(f.root, 'verified');
  await git(f.source, 'worktree', 'add', '--detach', verification, head);
  assert.deepEqual(await fs.readFile(path.join(verification, 'raw.bin')), binary);
  await assert.rejects(fs.stat(path.join(verification, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await sourceStatus(f.source), originalStatus);
  await success(await routes.decision('confirm', args, confirmationId));
  assert.equal((await success(await routes.decision('confirm', args))).result.integratedCommit, head);
  assert.equal(s.applyCalls(), 1);
  const audit = f.store.page(0, 1000).entries.filter(event => event.type === 'goal.candidate_merge.applied');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entityId, s.goal.id);
});

test('changed checkout, HEAD, project checks and divergent target tree all invalidate approval', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  await git(f.source, 'switch', 'delivery');
  await failure(await routes.decision('confirm', confirmArgs(chosen)), 'TARGET_BRANCH_CHECKED_OUT');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Advance HEAD only');
  await git(f.source, 'switch', 'main');
  await failure(await routes.decision('confirm', confirmArgs(chosen)), 'TARGET_CHANGED');
  const newer = await success(await preview());
  assert.notEqual(newer.targetHead, base);
  await git(f.source, 'switch', 'delivery');
  await fs.writeFile(path.join(f.source, 'local.txt'), 'owner work');
  await git(f.source, 'add', 'local.txt');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Change source tree');
  const changed = await git(f.source, 'rev-parse', 'HEAD');
  await git(f.source, 'switch', 'main');
  await failure(await preview(), 'TARGET_BASE_CHANGED');
  f.command('project.save', { id: f.project.id, checks: [{ id: 'different', command: process.execPath, args: ['-e', '0'] }] });
  await failure(await routes.decision('confirm', confirmArgs(newer)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(f.source, 'rev-parse', branch), changed);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(await sourceStatus(f.source), '');
  assert.equal(await git(f.source, 'show', 'delivery:local.txt'), 'owner work');
  assert.equal(s.applyCalls(), 0);
});

test('withdrawal before the final Git launch leaves the branch unchanged', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  s.beforeApply(async () => {
    const saved = await success(await routes.decision('withdraw', { id: s.goal.id, previewId: chosen.id }));
    assert.equal(saved.stopRequested, true);
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('cancelled');
  assert.equal(await git(f.source, 'rev-parse', branch), base);
  assert.equal(await sourceStatus(f.source), '');
  assert.equal(s.applyCalls(), 0);
  assert.equal(f.store.list('integrations').find(record => record.candidateMergeId === chosen.id).phase, 'stopped');
  assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
});

test('after the final guard a normal checkout cannot replace the reserved target or redirect the write', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  let userIndex;
  s.afterGuard(async () => {
    await git(f.source, 'switch', '-c', 'other');
    const blocked = await run('git', ['switch', 'delivery'], f.source);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /already used by worktree|already checked out/);
    userIndex = await fs.readFile(path.join(f.source, '.git', 'index'));
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('applied');
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
  assert.equal(await git(f.source, 'rev-parse', 'other'), base);
  assert.equal(await git(f.source, 'symbolic-ref', 'HEAD'), 'refs/heads/other');
  assert.equal(await git(f.source, 'rev-parse', branch + '^{tree}'), chosen.selection.tree);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), userIndex);
  assert.equal(s.applyCalls(), 1);
  assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
});

test('the named ref update refuses a new target HEAD after its last guard', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const first = await success(await preview());
  const index = await fs.readFile(path.join(f.source, '.git', 'index'));
  const newHead = await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit-tree', first.targetTree, '-p', base, '-m', 'Concurrent target update');
  s.afterGuard(() => git(f.source, 'update-ref', branch, newHead, base));
  await success(await routes.decision('confirm', confirmArgs(first)));
  assert.match((await s.waitMerge('failed')).reason, /cannot lock ref|expected/);
  assert.equal(await git(f.source, 'rev-parse', branch), newHead);
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), index);
  assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
  const second = await success(await preview());
  await f.engine.stop();
  f.command('goal.edit', { id: s.goal.id, patch: { acceptance: 'The candidate must meet the revised contract' } });
  await failure(await routes.decision('confirm', confirmArgs(second)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
});

test('the source checkout keeps hidden, staged and ignored files byte for byte', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const readme = path.join(f.source, 'README.md');
  await git(f.source, 'sparse-checkout', 'set', '--no-cone', '/README.md', '/obsolete.txt');
  await git(f.source, 'update-index', '--assume-unchanged', '--', 'README.md');
  await fs.writeFile(readme, 'invisible local draft');
  const obsolete = path.join(f.source, 'obsolete.txt');
  await fs.writeFile(obsolete, 'staged local draft');
  await git(f.source, 'add', '--sparse', '--', 'obsolete.txt');
  const localFile = path.join(f.source, 'raw.bin');
  await fs.appendFile(path.join(f.source, '.git', 'info', 'exclude'), '\n/raw.bin\n');
  const localBytes = Buffer.from([0, 7, 138, 255]);
  await fs.writeFile(localFile, localBytes);
  const index = await fs.readFile(path.join(f.source, '.git', 'index'));
  const chosen = await success(await preview());
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('applied');
  assert.equal(s.applyCalls(), 1);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), index);
  assert.deepEqual(await fs.readFile(localFile), localBytes);
  assert.equal(await fs.readFile(readme, 'utf8'), 'invisible local draft');
  assert.equal(await fs.readFile(obsolete, 'utf8'), 'staged local draft');
  assert.equal(await git(f.source, 'rev-parse', branch + '^{tree}'), chosen.selection.tree);
});

test('an applied Git result stays held through restart until cleanup is verified, then settles once', async t => {
  const s = await setup(t);
  const { f, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  let cleanupFile;
  s.afterApply((result, filename) => {
    assert.equal(result.code, 0, result.stderr);
    cleanupFile = filename;
    throw cleanupError('fixture delayed final Git cleanup');
  });
  const args = confirmArgs(chosen);
  await success(await routes.decision('confirm', args));
  await s.waitMerge('reconciling');
  const appliedHead = await git(f.source, 'rev-parse', branch);
  assert.notEqual(appliedHead, chosen.targetHead);
  await f.engine.stop();
  await f.engine.start();
  assert.equal(s.current().candidateMerge.status, 'reconciling');
  assert.match(await git(f.source, 'worktree', 'list', '--porcelain'), /locked acms-owner-/);
  await success(await routes.decision('reconcile', { id: s.goal.id, previewId: chosen.id }));
  await until(() => !s.current().candidateMerge.recoveryRequested, 75000, s.diagnostics);
  assert.equal(s.current().candidateMerge.status, 'reconciling');
  assert.equal(s.applyCalls(), 1);
  await receipt(cleanupFile, { exitCode: 0 });
  const applied = await s.waitMerge('applied');
  assert.equal(applied.result.integratedCommit, appliedHead);
  assert.equal((await success(await routes.decision('confirm', args))).result.integratedCommit, appliedHead);
  assert.equal(await git(f.source, 'rev-parse', branch), appliedHead);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), s.base);
  assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
  assert.equal(s.applyCalls(), 1);
});

test('an unstarted ref update releases its reservation and resumes the same confirmation after restart', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  s.afterGuard(() => { throw cleanupError('fixture interrupted before ref update'); });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('reconciling');
  const first = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
  assert.equal(await git(f.source, 'rev-parse', branch), base);
  assert.equal(await git(f.source, 'cat-file', '-t', first.integratedCommit), 'commit');
  assert.match(await git(f.source, 'worktree', 'list', '--porcelain'), /locked acms-owner-/);
  await f.engine.stop();
  await receipt(path.join(f.dataDir, 'integration-receipts', first.commandId + '.json'), { exitCode: 1, notStarted: true });
  s.afterGuard(null);
  await f.engine.start();
  const applied = await s.waitMerge('applied');
  assert.equal(applied.id, chosen.id);
  assert.equal(applied.result.integratedCommit, first.integratedCommit);
  assert.equal(s.applyCalls(), 1);
  assert.equal(f.store.require('integrations', first.id).phase, 'stopped');
  assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
});

test('a backed-up pending reservation is rebound before a restored host inspects and cleans it', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  let cleanupFile;
  s.afterApply((result, filename) => {
    assert.equal(result.code, 0, result.stderr);
    cleanupFile = filename;
    throw cleanupError('fixture retains reservation at backup');
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('reconciling');
  await f.engine.stop();
  const pending = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
  await receipt(cleanupFile, { exitCode: 0 });
  const backup = path.join(f.root, 'backup'), target = path.join(f.root, 'restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  const restored = await restoreBackup({ backup, target });
  assert.equal(restored.startable, false);
  assert(restored.worktrees.issues.some(item => item.path === `integration/${pending.id}`));
  const workspace = f.store.require('tasks', s.task.id).workspace.path;
  await fs.rename(workspace, path.join(f.root, 'parked-task'));
  await fs.rename(pending.ownerReservation.path, path.join(f.root, 'parked-reservation'));
  const resumed = await restoreBackup({ target, resumeWorktrees: true });
  assert.equal(resumed.startable, true, JSON.stringify(resumed.worktrees));
  const store = new Store(path.join(target, 'company.db'));
  const company = new Company(store);
  const engine = new Engine(company, f.adapter, new WorkspaceManager(target, company), { intervalMs: 20 });
  try {
    await engine.start();
    const request = store.require('goals', s.goal.id).candidateMerge;
    assert.equal(request.status, 'applied', JSON.stringify(request));
    assert.equal(request.result.integratedCommit, pending.integratedCommit);
    assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
    assert.equal(await git(f.source, 'rev-parse', branch), pending.integratedCommit);
    assert.doesNotMatch(await git(f.source, 'worktree', 'list', '--porcelain'), /acms-owner-/);
    assert.equal(s.applyCalls(), 1);
  } finally { await engine.stop(); store.close(); }
});

test('existing automatic merge applies task output before the template final review', async t => {
  const review = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const s = await setup(t, { autoMerge: true, review });
  try {
    await s.f.start();
    let reviewRunning = false;
    review.entered.promise.then(() => { reviewRunning = true; });
    await until(() => { s.checkWork(); return reviewRunning; }, 75000, s.diagnostics);
    assert.notEqual(await git(s.f.source, 'rev-parse', 'HEAD'), s.base);
    assert.deepEqual(await fs.readFile(path.join(s.f.source, 'raw.bin')), binary);
    assert.notEqual(s.snapshot().reviewSummary.passed, true);
    assert.equal(s.current().candidateMerge, undefined);
  } finally { review.release.resolve(); }
});
