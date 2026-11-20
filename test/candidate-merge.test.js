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
import { acquireBareDeliveryFence, bareFenceRef, releaseBareDeliveryFence } from '../src/runtime/bare-delivery-target.js';
import { inside, run, WorkspaceManager } from '../src/runtime/workspaces.js';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { fixture, gitProject, taskWaitDiagnostics, until } from './helpers.js';

const basisRef = 'refs/heads/delivery';
const binary = Buffer.from([0, 8, 255, 128]);
const receipt = (file, fields) => fs.writeFile(file, JSON.stringify({ confirmed: true, ...fields }));
const sourceStatus = cwd => git(cwd, 'status', '--porcelain', '--', '.', ':(exclude).acms');
async function absent(cwd, ref) {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', ref], cwd);
  assert.equal(result.code, 1, `Expected ${ref} to be absent`);
}

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
    saveProject: args => post('command', { name: 'project.save', args, requestId: randomUUID() }),
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
    const apply = args.includes('update-ref') && args.includes('--stdin');
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
  const preview = (selectedBasis = basisRef, targetMode) => routes.preview({ goalId: goal.id, version: current().composition?.version,
    deliveryHash: f.company.deliveryHash(goal.id), basisRef: selectedBasis, targetMode });
  const confirmArgs = request => ({ id: goal.id, previewId: request.id, version: request.selection.version,
    deliveryHash: request.selection.deliveryHash, basisHead: request.basisHead, basisRef: request.basisRef, targetRef: request.targetRef,
    ...(request.targetMode === 'bare' ? { targetMode: 'bare', targetRoot: request.targetRoot } : {}) });
  const waitMerge = status => until(() => {
    const request = current().candidateMerge;
    if (request?.status === status) return request;
    assert(request?.status !== 'failed' && request?.status !== 'cancelled', JSON.stringify(diagnostics()));
  }, 75000, diagnostics);
  return { f, goal, task, base, current, snapshot, diagnostics, checkWork, routes, preview, confirmArgs, ready, waitMerge,
    applyCalls: () => applyCalls, beforeApply: hook => { beforeApply = hook; }, afterGuard: hook => { afterGuard = hook; }, afterApply: hook => { afterApply = hook; } };
}

async function createBare(f, name = 'receiver.git') {
  const target = path.join(f.root, name);
  await git(f.root, 'init', '--bare', '-b', 'main', target);
  await git(f.source, 'push', '--', target, 'HEAD:refs/heads/main', 'HEAD:refs/heads/delivery');
  return fs.realpath(target);
}

async function setupBare(t, options) {
  const s = await setup(t, options);
  const target = await createBare(s.f);
  const approved = await success(await s.routes.saveProject({ id: s.f.project.id, deliveryRepoRoot: target }));
  assert.equal(approved.deliveryRepository.targetRoot, target);
  assert(approved.deliveryRepository.targetIdentity);
  return { ...s, target, approved, previewBare: () => s.preview(basisRef, 'bare') };
}

async function absentFences(target) {
  assert(!(await fs.readdir(target)).some(name => /ACMS_FENCE|^(?:worktrees|index\.lock)$/.test(name)));
}

test('owner approves and advances only the selected branch in an isolated bare delivery repository', async t => {
  const review = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const s = await setupBare(t, { review });
  const { f, base, routes, target, previewBare, confirmArgs } = s;
  const originalRefs = await git(target, 'show-ref');
  try {
    await f.start();
    let reviewing = false;
    review.entered.promise.then(() => { reviewing = true; });
    await until(() => { s.checkWork(); return reviewing; }, 75000, s.diagnostics);
    await failure(await previewBare(), 'CANDIDATE_NOT_READY');
    assert.equal(await git(target, 'show-ref'), originalRefs);
  } finally { review.release.resolve(); }
  const accepted = await s.ready();
  const sourceHook = path.join(f.source, '.git', 'hooks', 'reference-transaction');
  const hookContents = '#!/bin/sh\nexit 1\n';
  await fs.writeFile(sourceHook, hookContents, { mode: 0o700 });
  const originalIndex = await fs.readFile(path.join(f.source, '.git', 'index'));
  const originalFiles = await fs.readFile(path.join(f.source, 'README.md'));
  const rejected = await success(await previewBare());
  assert.equal(rejected.basisHead, base);
  assert.equal(rejected.targetRoot, target);
  assert.equal(rejected.targetRef, basisRef);
  assert.equal(rejected.selection.reviewId, accepted.reviewId);
  assert.equal(rejected.summary.total, 3);
  await success(await routes.decision('reject', { id: s.goal.id, previewId: rejected.id }));
  assert.equal(await git(target, 'show-ref'), originalRefs);
  await absentFences(target);

  const chosen = await success(await previewBare());
  await failure(await routes.decision('confirm', { ...confirmArgs(chosen), targetRoot: f.source }), 'STALE_CANDIDATE_CONFIRMATION');
  s.afterGuard(async () => {
    const current = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
    assert.equal(current.bareFence, true);
    const proof = bareFenceRef(current.id);
    assert.equal(await git(target, 'rev-parse', proof), current.integratedCommit);
    assert.doesNotMatch(await git(f.source, 'ls-remote', target), new RegExp(proof));
    await git(target, 'pack-refs', '--all');
    assert.equal(await git(target, 'rev-parse', proof), current.integratedCommit);
    const linked = await run('git', ['worktree', 'add', '--no-checkout', path.join(f.root, 'linked'), 'delivery'], target);
    assert.notEqual(linked.code, 0);
    assert.match(linked.stderr, /worktrees/);
    const alternate = path.join(f.root, 'manual-index');
    await fs.mkdir(alternate);
    const check = await run('git', ['--git-dir=' + target, '--work-tree=' + alternate, 'checkout', 'delivery'], alternate);
    assert.notEqual(check.code, 0);
    assert.match(check.stderr, /index\.lock/);
    assert.deepEqual(await fs.readdir(alternate), []);
  });
  const args = confirmArgs(chosen);
  await success(await routes.decision('confirm', args));
  const applied = await s.waitMerge('applied');
  const head = await git(target, 'rev-parse', basisRef);
  assert.equal(head, applied.result.integratedCommit);
  assert.equal(await git(target, 'rev-parse', basisRef + '^{tree}'), chosen.selection.tree);
  assert.equal(await git(target, 'rev-list', '--parents', '-n', '1', head), `${head} ${base}`);
  assert.equal(await git(target, 'rev-parse', 'refs/heads/main'), base);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), originalIndex);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'README.md')), originalFiles);
  assert.equal(await fs.readFile(sourceHook, 'utf8'), hookContents);
  await absentFences(target);
  assert.equal((await success(await routes.decision('confirm', args))).result.integratedCommit, head);
  const repeated = await success(await previewBare());
  await success(await routes.decision('confirm', confirmArgs(repeated)));
  assert.equal((await s.waitMerge('applied')).result.proof, 'target-tree');
  assert.equal(await git(target, 'rev-parse', basisRef), head);
  assert.equal(s.applyCalls(), 1);
});

test('owner cannot update a bare target after a concurrent ref write, stale approval or existing worktree', async t => {
  const s = await setupBare(t);
  const { f, base, routes, target, previewBare, confirmArgs } = s;
  await f.start();
  await s.ready();
  const linked = path.join(f.root, 'before-confirm');
  await git(target, 'worktree', 'add', '--no-checkout', linked, 'delivery');
  await failure(await previewBare(), 'BARE_TARGET_BUSY');
  assert(inside(await fs.realpath(f.root), await fs.realpath(linked)));
  await git(target, 'worktree', 'remove', '--force', linked);
  const chosen = await success(await previewBare());
  const different = await git(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
    'commit-tree', chosen.basisTree, '-p', base, '-m', 'Concurrent ref update');
  s.afterGuard(() => git(target, 'update-ref', basisRef, different, base));
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  assert.match((await s.waitMerge('failed')).reason, /cannot lock ref|expected/);
  assert.equal(await git(target, 'rev-parse', basisRef), different);
  assert.equal(await git(target, 'rev-parse', 'refs/heads/main'), base);
  await absentFences(target);

  const next = await success(await previewBare());
  await git(target, 'update-ref', basisRef, base, different);
  await failure(await routes.decision('confirm', confirmArgs(next)), 'TARGET_CHANGED');
  const replaced = await createBare(f, 'other-approved.git');
  await success(await routes.saveProject({ id: f.project.id, deliveryRepoRoot: replaced }));
  await failure(await routes.decision('confirm', confirmArgs(next)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(replaced, 'rev-parse', basisRef), base);
});

test('the native bare transaction rejects a same-tip replacement repository after its last process guard', async t => {
  const s = await setupBare(t);
  const { f, base, routes, target, previewBare, confirmArgs } = s;
  const replacement = await createBare(f, 'similar.git');
  const held = path.join(await fs.realpath(f.root), 'held-original.git');
  assert(inside(await fs.realpath(f.root), target) && inside(await fs.realpath(f.root), replacement));
  await f.start();
  await s.ready();
  const chosen = await success(await previewBare());
  s.afterGuard(async () => {
    const current = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
    await git(replacement, 'fetch', '--no-write-fetch-head', '--', target, current.integratedCommit);
    assert.equal(await git(replacement, 'cat-file', '-t', current.integratedCommit), 'commit');
    await fs.rename(target, held);
    await fs.rename(replacement, target);
  });
  s.afterApply(async result => {
    try {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /ACMS_FENCE/);
      assert.equal(await git(target, 'rev-parse', basisRef), base);
    } finally {
      await fs.rename(target, replacement);
      await fs.rename(held, target);
    }
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('failed');
  assert.equal(await git(target, 'rev-parse', basisRef), base);
  assert.equal(await git(replacement, 'rev-parse', basisRef), base);
  await absentFences(target);
});

test('the locked bare transaction refuses a target made symbolic at the same OID', async t => {
  const s = await setupBare(t);
  const { f, base, routes, target, previewBare, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await previewBare());
  s.afterGuard(() => git(target, 'symbolic-ref', basisRef, 'refs/heads/main'));
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  assert.match((await s.waitMerge('failed')).reason, /no longer a direct branch/);
  assert.equal(await git(target, 'symbolic-ref', basisRef), 'refs/heads/main');
  assert.equal(await git(target, 'rev-parse', basisRef), base);
  assert.equal(await git(target, 'rev-parse', 'refs/heads/main'), base);
  await absentFences(target);
});

test('a bare repository with an existing branch policy retains its hook and rejects owner preview', async t => {
  const s = await setupBare(t);
  const { f, base, routes, target, previewBare } = s;
  const customHooks = path.join(f.root, 'protected-hooks');
  await fs.mkdir(customHooks);
  await git(target, 'config', 'core.hooksPath', customHooks);
  const hook = path.join(customHooks, 'reference-transaction');
  const hookBody = '#!/bin/sh\nexit 1\n';
  await fs.writeFile(hook, hookBody, { mode: 0o700 });
  await failure(await routes.saveProject({ id: f.project.id, deliveryRepoRoot: target }), 'BARE_TARGET_REQUIRED', 400);
  await f.start();
  await s.ready();
  await failure(await previewBare(), 'BARE_TARGET_REQUIRED', 400);
  assert.equal(await fs.readFile(hook, 'utf8'), hookBody);
  assert.equal(await git(target, 'rev-parse', basisRef), base);
  await absentFences(target);
});

test('bare Git fences survive uncertain cleanup and release only after restart reconciles the applied ref', async t => {
  const s = await setupBare(t);
  const { f, base, target, routes, previewBare, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await previewBare());
  let receiptPath;
  s.afterApply((result, filename) => {
    assert.equal(result.code, 0, result.stderr);
    receiptPath = filename;
    throw cleanupError('bare Git command cleanup receipt delayed');
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('reconciling');
  const advanced = await git(target, 'rev-parse', basisRef);
  assert.notEqual(advanced, base);
  assert.equal(await fs.readFile(path.join(target, 'index.lock'), 'utf8'), advanced + '\n');
  await f.engine.stop();
  await f.engine.start();
  assert.equal(s.current().candidateMerge.status, 'reconciling');
  assert.equal(await fs.readFile(path.join(target, 'worktrees'), 'utf8'), advanced + '\n');
  await receipt(receiptPath, { exitCode: 0 });
  assert.equal((await s.waitMerge('applied')).result.integratedCommit, advanced);
  await absentFences(target);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(s.applyCalls(), 1);
});

test('bare fence recovery before marker publication preserves foreign Git metadata', async t => {
  const { f, target, base, approved } = await setupBare(t);
  const record = { ...approved.deliveryRepository, integratedCommit: base, id: 'integration_' + randomUUID() };
  const stage = path.join(target, `.${bareFenceRef(record.id)}.pending`);
  await fs.writeFile(stage, '');
  const otherIndexLock = path.join(target, 'index.lock');
  await fs.writeFile(otherIndexLock, 'other Git process\n');
  releaseBareDeliveryFence(record);
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' });
  assert.throws(() => acquireBareDeliveryFence(record), { code: 'BARE_TARGET_BUSY' });
  releaseBareDeliveryFence(record);
  assert.deepEqual((await fs.readdir(target)).filter(name => /ACMS_FENCE|worktrees|index\.lock/.test(name)), ['index.lock']);
  assert.equal(await fs.readFile(otherIndexLock, 'utf8'), 'other Git process\n');
  assert.equal(await git(target, 'rev-parse', basisRef), base);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
});

test('owner waits for required review, previews a new branch from the chosen basis and confirms the exact Git tree once', async t => {
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
  const checkedOut = await success(await preview('refs/heads/main'));
  assert.equal(checkedOut.basisRef, 'refs/heads/main');
  const otherWorktree = path.join(f.root, 'existing-worktree');
  await git(f.source, 'worktree', 'add', otherWorktree, 'other');
  assert.equal((await success(await preview('refs/heads/other'))).basisRef, 'refs/heads/other');
  const originalWorktrees = await git(f.source, 'worktree', 'list', '--porcelain');
  const rejected = await success(await preview());
  assert.match(rejected.targetRef, /^refs\/heads\/acms-deliveries\/[0-9a-f-]{36}$/);
  assert.equal(rejected.basisRef, basisRef);
  assert.equal(rejected.basisHead, base);
  assert.deepEqual(rejected.summary.items, [{ change: 'M', path: 'README.md' }, { change: 'D', path: 'obsolete.txt' }, { change: 'A', path: 'raw.bin' }]);
  assert.deepEqual(rejected.checks.map(check => [check.id, check.inputHash, check.code]),
    [['binary-check', s.current().composition.checks[0].inputHash, 0]]);
  assert.equal(rejected.selection.reviewId, selected.reviewId);
  assert.equal((await success(await routes.decision('reject', { id: s.goal.id, previewId: rejected.id }))).status, 'rejected');
  await failure(await routes.decision('confirm', confirmArgs(rejected)), 'STALE_CANDIDATE_CONFIRMATION');
  await absent(f.source, rejected.targetRef);
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
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef + '^{tree}'), chosen.selection.tree);
  const head = await git(f.source, 'rev-parse', chosen.targetRef);
  assert.equal(applied.result.integratedCommit, head);
  assert.equal(await git(f.source, 'rev-list', '--parents', '-n', '1', head), `${head} ${base}`);
  assert.equal(await git(f.source, 'rev-parse', 'other'), base);
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
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

test('changed basis HEAD, project checks and divergent basis tree all invalidate approval', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  await git(f.source, 'switch', 'delivery');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Advance HEAD only');
  await git(f.source, 'switch', 'main');
  await failure(await routes.decision('confirm', confirmArgs(chosen)), 'TARGET_CHANGED');
  const newer = await success(await preview());
  assert.notEqual(newer.basisHead, base);
  await git(f.source, 'switch', 'delivery');
  await fs.writeFile(path.join(f.source, 'local.txt'), 'owner work');
  await git(f.source, 'add', 'local.txt');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Change source tree');
  const changed = await git(f.source, 'rev-parse', 'HEAD');
  await git(f.source, 'switch', 'main');
  await failure(await preview(), 'TARGET_BASE_CHANGED');
  f.command('project.save', { id: f.project.id, checks: [{ id: 'different', command: process.execPath, args: ['-e', '0'] }] });
  await failure(await routes.decision('confirm', confirmArgs(newer)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(f.source, 'rev-parse', basisRef), changed);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
  assert.equal(await sourceStatus(f.source), '');
  assert.equal(await git(f.source, 'show', 'delivery:local.txt'), 'owner work');
  assert.equal(s.applyCalls(), 0);
  await absent(f.source, chosen.targetRef);
  await absent(f.source, newer.targetRef);
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
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
  await absent(f.source, chosen.targetRef);
  assert.equal(await sourceStatus(f.source), '');
  assert.equal(s.applyCalls(), 0);
  assert.equal(f.store.list('integrations').find(record => record.candidateMergeId === chosen.id).phase, 'stopped');
});

test('a checkout after the final guard does not redirect the new ref or change the source index', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  let userIndex;
  s.afterGuard(async () => {
    await git(f.source, 'switch', 'delivery');
    userIndex = await fs.readFile(path.join(f.source, '.git', 'index'));
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('applied');
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
  assert.equal(await git(f.source, 'symbolic-ref', 'HEAD'), basisRef);
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef + '^{tree}'), chosen.selection.tree);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), userIndex);
  assert.equal(s.applyCalls(), 1);
});

test('the ref transaction refuses a changed basis after its last guard and creates no branch', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const first = await success(await preview());
  const index = await fs.readFile(path.join(f.source, '.git', 'index'));
  const newHead = await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit-tree', first.basisTree, '-p', base, '-m', 'Concurrent basis update');
  s.afterGuard(() => git(f.source, 'update-ref', basisRef, newHead, base));
  await success(await routes.decision('confirm', confirmArgs(first)));
  assert.match((await s.waitMerge('failed')).reason, /cannot lock ref|expected/);
  assert.equal(await git(f.source, 'rev-parse', basisRef), newHead);
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
  assert.deepEqual(await fs.readFile(path.join(f.source, '.git', 'index')), index);
  await absent(f.source, first.targetRef);
  const second = await success(await preview());
  await f.engine.stop();
  f.command('goal.edit', { id: s.goal.id, patch: { acceptance: 'The candidate must meet the revised contract' } });
  await failure(await routes.decision('confirm', confirmArgs(second)), 'STALE_CANDIDATE_CONFIRMATION');
  assert.equal(await git(f.source, 'rev-parse', 'main'), base);
});

test('the ref transaction refuses a concurrently created target and leaves its commit alone', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  s.afterGuard(() => git(f.source, 'update-ref', chosen.targetRef, base));
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  assert.match((await s.waitMerge('failed')).reason, /cannot lock ref|already exists/);
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef), base);
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
});

test('an unborn user checkout for the preview name blocks confirmation', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  const otherWorktree = path.join(f.root, 'unborn-user-worktree');
  await git(f.source, 'worktree', 'add', '--detach', otherWorktree, base);
  await git(otherWorktree, 'switch', '--orphan', chosen.targetRef.slice('refs/heads/'.length));
  await absent(f.source, chosen.targetRef);
  await failure(await routes.decision('confirm', confirmArgs(chosen)), 'TARGET_BRANCH_EXISTS');
  assert.equal(await git(otherWorktree, 'symbolic-ref', 'HEAD'), chosen.targetRef);
  assert.equal(s.applyCalls(), 0);
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
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef + '^{tree}'), chosen.selection.tree);
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
  const appliedHead = await git(f.source, 'rev-parse', chosen.targetRef);
  assert.notEqual(appliedHead, chosen.basisHead);
  await f.engine.stop();
  await f.engine.start();
  assert.equal(s.current().candidateMerge.status, 'reconciling');
  await success(await routes.decision('reconcile', { id: s.goal.id, previewId: chosen.id }));
  await until(() => !s.current().candidateMerge.recoveryRequested, 75000, s.diagnostics);
  assert.equal(s.current().candidateMerge.status, 'reconciling');
  assert.equal(s.applyCalls(), 1);
  await receipt(cleanupFile, { exitCode: 0 });
  const applied = await s.waitMerge('applied');
  assert.equal(applied.result.integratedCommit, appliedHead);
  assert.equal((await success(await routes.decision('confirm', args))).result.integratedCommit, appliedHead);
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef), appliedHead);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), s.base);
  assert.equal(s.applyCalls(), 1);
});

test('an unstarted transaction resumes the same confirmation after restart and creates one ref', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  s.afterGuard(() => { throw cleanupError('fixture interrupted before ref update'); });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('reconciling');
  const first = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
  assert.equal(await git(f.source, 'rev-parse', basisRef), base);
  await absent(f.source, chosen.targetRef);
  assert.equal(await git(f.source, 'cat-file', '-t', first.integratedCommit), 'commit');
  await f.engine.stop();
  await receipt(path.join(f.dataDir, 'integration-receipts', first.commandId + '.json'), { exitCode: 1, notStarted: true });
  s.afterGuard(null);
  await f.engine.start();
  const applied = await s.waitMerge('applied');
  assert.equal(applied.id, chosen.id);
  assert.equal(applied.result.integratedCommit, first.integratedCommit);
  assert.equal(s.applyCalls(), 1);
  assert.equal(f.store.require('integrations', first.id).phase, 'stopped');
  assert.equal(await git(f.source, 'rev-parse', chosen.targetRef), first.integratedCommit);
});

test('a pending branch creation survives backup without the reclaimed author workspace', async t => {
  const s = await setup(t);
  const { f, base, routes, preview, confirmArgs } = s;
  await f.start();
  await s.ready();
  const chosen = await success(await preview());
  let cleanupFile;
  s.afterApply((result, filename) => {
    assert.equal(result.code, 0, result.stderr);
    cleanupFile = filename;
    throw cleanupError('fixture retains branch transaction at backup');
  });
  await success(await routes.decision('confirm', confirmArgs(chosen)));
  await s.waitMerge('reconciling');
  await f.engine.stop();
  const pending = f.store.list('integrations').find(row => row.candidateMergeId === chosen.id);
  await receipt(cleanupFile, { exitCode: 0 });
  const author = f.store.require('tasks', s.task.id).workspace.path;
  assert(inside(path.join(await fs.realpath(f.dataDir), 'workspaces'), await fs.realpath(author)) && path.basename(author) === s.task.id);
  await git(f.source, 'worktree', 'remove', '--force', author);
  const backup = path.join(f.root, 'backup'), target = path.join(f.root, 'restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  const restored = await restoreBackup({ backup, target });
  assert.equal(restored.startable, true, JSON.stringify(restored.worktrees));
  const store = new Store(path.join(target, 'company.db'));
  const company = new Company(store);
  const engine = new Engine(company, f.adapter, new WorkspaceManager(target, company), { intervalMs: 20 });
  try {
    await engine.start();
    const request = store.require('goals', s.goal.id).candidateMerge;
    assert.equal(request.status, 'applied', JSON.stringify(request));
    assert.equal(request.result.integratedCommit, pending.integratedCommit);
    assert.equal(await git(f.source, 'rev-parse', 'HEAD'), base);
    assert.equal(await git(f.source, 'rev-parse', chosen.targetRef), pending.integratedCommit);
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
