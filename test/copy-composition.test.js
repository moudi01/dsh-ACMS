import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rmdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { applyBackup, planBackup, verifyBackup } from '../scripts/backup.mjs';
import { prunePlan } from '../scripts/prune-data.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { checkoutCopyComposition, copyContentHash } from '../src/runtime/copy-composition.js';
import { run } from '../src/runtime/workspaces.js';
import { compositionWaitDiagnostics, simulateFixtureCleanup, traceFixtureWorkspace } from './fixture-trace.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const result = name => ({ outcome: 'completed', artifacts: [{ path: name }] });
const file = (input, name) => path.join(input.task.workspace.path, name);
const get = (f, task) => f.store.require('tasks', task.id);

async function setup(t, handler, check = 'process.exitCode=0', { finalReview = false, traceWait = false } = {}) {
  const f = await fixture(t, handler);
  f.command('project.save', { id: f.project.id, checks: [{ id: 'joint', command: process.execPath, args: ['-e', check] }] });
  const goal = f.command('goal.create', { title: 'Directory candidate', description: 'Combine a runnable source', acceptance: 'Pass the joint check',
    projectId: f.project.id, templateId: finalReview ? 'base' : f.template.id, plan: false, deliveryMode: 'copy-composite' });
  const trace = traceWait ? traceFixtureWorkspace(f.workspaces, { composition: true }) : null;
  simulateFixtureCleanup(f.workspaces, trace);
  return { f, goal, current: () => f.store.require('goals', goal.id),
    diagnostics: trace && compositionWaitDiagnostics(f, goal.id, trace) };
}

const waitForTask = (f, task, status, diagnostics) => until(() => {
  const current = get(f, task);
  if (current.status === status) return true;
  if (['blocked', 'failed', 'cancelled'].includes(current.status)) {
    if (diagnostics) assert.fail(JSON.stringify(diagnostics()));
    const attempt = f.store.list('attempts').findLast(row => row.taskId === task.id);
    assert.fail(`${current.title}: ${attempt?.summary ?? current.feedback ?? current.blocker?.reason ?? current.status}`);
  }
  return false;
}, 45000, diagnostics ?? taskWaitDiagnostics(f, task.id));

async function waitForComposition(f, goal, current, diagnostics) {
  await until(() => {
    const attempt = f.store.list('attempts').find(row => row.goalId === goal.id && row.status === 'failed');
    if (attempt) assert.fail(diagnostics ? JSON.stringify(diagnostics()) : attempt.summary);
    const state = current();
    if (state.compositionRecheck?.status === 'failed') assert.fail(diagnostics ? JSON.stringify(diagnostics()) : state.compositionRecheck.reason);
    return state.status === 'succeeded';
  }, 45000, diagnostics ?? (() => ({ goal: current().status, recheck: current().compositionRecheck,
    tasks: f.store.list('tasks').filter(row => row.goalId === goal.id).map(({ title, status, feedback }) => ({ title, status, feedback })) })));
}

test('directory dependencies, joint checks and final review use the same fixed contents after restart and backup', async t => {
  const binary = Buffer.from([0, 255, 128, 42]);
  let reviewerHash;
  const { f, goal, current, diagnostics } = await setup(t, async input => {
    if (input.task.kind === 'review') {
      reviewerHash = await copyContentHash(input.task.workspace.path);
      assert.equal(await readFile(file(input, 'app.cjs'), 'utf8'), "require('./new.cjs');\n");
      assert.deepEqual(await readFile(file(input, 'asset.bin')), binary);
      return { outcome: 'reviewed', decision: 'approve', summary: 'Reviewed the real candidate' };
    }
    if (input.task.title === 'A') {
      await writeFile(file(input, 'new.cjs'), 'module.exports = 42;\r\n');
      await writeFile(file(input, 'asset.bin'), binary);
      await writeFile(file(input, 'stable.txt'), 'updated input');
      await mkdir(file(input, 'expected-empty'));
      await unlink(file(input, 'obsolete.txt'));
      return result('new.cjs');
    }
    assert.match(input.prompt, /"selectedCopyInputs"/);
    assert.equal(await readFile(file(input, 'stable.txt'), 'utf8'), 'updated input');
    assert.equal(await readFile(file(input, 'new.cjs'), 'utf8'), 'module.exports = 42;\r\n');
    assert.deepEqual(await readdir(file(input, 'expected-empty')), []);
    assert.deepEqual(await readFile(file(input, 'asset.bin')), binary);
    for (const absent of ['obsolete.txt', 'later.txt', '.env']) await assert.rejects(readFile(file(input, absent)), { code: 'ENOENT' });
    await writeFile(file(input, 'app.cjs'), "require('./new.cjs');\n");
    return result('app.cjs');
  }, "const fs=require('node:fs'); if(fs.existsSync('app.cjs') && (require('./new.cjs')!==42 || fs.readFileSync('asset.bin')[1]!==255 || fs.existsSync('obsolete.txt') || !fs.statSync('expected-empty').isDirectory()))process.exit(7)", { finalReview: true, traceWait: true });
  await writeFile(path.join(f.source, 'stable.txt'), 'fixed source');
  await writeFile(path.join(f.source, 'obsolete.txt'), 'original source');
  await writeFile(path.join(f.source, '.env'), 'private fixture');
  const a = f.task({ title: 'A', goalId: goal.id });
  const b = f.task({ title: 'B', goalId: goal.id, dependencies: [a.id] });
  f.command('task.pause', { id: b.id });
  const prepareCopy = f.workspaces.prepareCopyCompositionTask.bind(f.workspaces);
  let observedPreparation = false;
  f.workspaces.prepareCopyCompositionTask = (task, ...args) => {
    if (task.id === a.id) {
      const observed = diagnostics();
      assert(observed.trace.inFlight.some(span => span.operation === 'prepare' && span.subject === a.id &&
        Number.isSafeInteger(span.elapsedMs)));
      assert(observed.attempts.some(attempt => attempt.taskId === a.id && attempt.status === 'preparing'));
      assert.equal(f.adapter.calls.length, 0);
      observedPreparation = true;
    }
    return prepareCopy(task, ...args);
  };
  try {
    await f.start();
    await waitForTask(f, a, 'succeeded', diagnostics);
    assert(observedPreparation);
  } finally {
    f.workspaces.prepareCopyCompositionTask = prepareCopy;
  }
  const afterPreparation = diagnostics().trace.recent;
  assert(afterPreparation.some(span => span.operation === 'prepare-copy-composition' && span.subject === a.id && span.outcome === 'returned'));
  assert(afterPreparation.some(span => span.operation === 'project-check' && span.exitCode === 0 && span.cleanupConfirmed));
  const aDelivery = get(f, a).integration.delivery;
  const baseline = current().compositionBase.snapshot.sha256;
  await f.engine.stop();
  await writeFile(path.join(f.source, 'later.txt'), 'changed source');
  await writeFile(path.join(get(f, a).workspace.path, 'new.cjs'), 'changed author copy');
  const unattached = await f.workspaces.prepare(get(f, b), {});
  assert.equal(get(f, b).workspace, undefined);
  await f.start();
  f.command('task.resume', { id: b.id });
  await waitForComposition(f, goal, current, diagnostics);
  const candidate = current().composition;
  assert.equal(get(f, b).workspace.path, unattached.path);
  assert.equal(candidate.baseHash, baseline);
  assert.equal(candidate.contentHash, reviewerHash);
  assert.deepEqual(candidate.inputs.map(row => row.taskId), [a.id, b.id]);
  assert.equal(candidate.inputs[0].snapshotSha256, aDelivery.sha256);
  assert(candidate.checks.every(check => check.passed && check.cleanupConfirmed === true && check.checkVersion && check.inputHash && check.log.hash));
  assert.equal(await readFile(path.join(f.source, 'stable.txt'), 'utf8'), 'fixed source');
  assert.equal(await readFile(path.join(f.source, 'obsolete.txt'), 'utf8'), 'original source');
  await f.engine.stop();
  const backup = path.join(f.root, 'backup');
  const emptyDirectory = `workspaces/${a.id}/expected-empty`;
  const plan = await planBackup({ dataDir: f.dataDir, out: backup });
  assert(plan.directories.includes(emptyDirectory));
  await applyBackup(plan);
  const original = await verifyBackup(backup);
  assert(original.ok);
  const restored = path.join(f.root, 'restored-data');
  await restoreBackup({ backup, target: restored });
  const store = new Store(path.join(restored, 'company.db'));
  let restoredGoal;
  try { restoredGoal = store.require('goals', goal.id); } finally { store.close(); }
  assert.equal(restoredGoal.compositionBase.source, current().compositionBase.source);
  assert.deepEqual(restoredGoal.composition.snapshot, candidate.snapshot);
  const checkout = path.join(f.root, 'standalone');
  await checkoutCopyComposition(restoredGoal.composition.snapshot, checkout, restored);
  assert.equal(await copyContentHash(checkout), reviewerHash);
  assert.deepEqual(await readdir(path.join(checkout, 'expected-empty')), []);
  assert.deepEqual(await readFile(path.join(checkout, 'asset.bin')), binary);
  assert.deepEqual(await readdir(path.join(restored, emptyDirectory)), []);
  await assert.rejects(readFile(path.join(checkout, '.env')), { code: 'ENOENT' });
  await rmdir(path.join(backup, emptyDirectory));
  assert((await verifyBackup(backup)).errors.some(message => message.includes(emptyDirectory)));
  const manifest = path.join(backup, 'backup-manifest.json');
  const { directories, ...legacy } = original.manifest;
  await writeFile(manifest, JSON.stringify(legacy));
  assert((await verifyBackup(backup)).ok);
  await writeFile(manifest, JSON.stringify({ ...legacy, directories: ['workspaces/../outside'] }));
  assert((await verifyBackup(backup)).errors.some(message => message.includes('parent segments')));
});

test('a directory parent consumes the child structural changes without losing its draft', async t => {
  let earlier;
  const { f, goal, current, diagnostics } = await setup(t, async input => {
    if (input.task.title === 'Child') {
      await unlink(file(input, 'module'));
      await mkdir(file(input, 'module'));
      await mkdir(file(input, 'module/empty'));
      await writeFile(file(input, 'module/file.cjs'), 'child content');
      return result('module/file.cjs');
    }
    if (!earlier) {
      earlier = input.task.workspace.path;
      await writeFile(file(input, 'draft.txt'), 'parent draft');
      return { outcome: 'decomposed', tasks: [{ key: 'child', title: 'Child', description: 'Replace a file by a directory', acceptance: 'Files present', dependencies: [] }] };
    }
    assert.equal(input.task.workspace.path, earlier);
    assert.equal(await readFile(file(input, 'draft.txt'), 'utf8'), 'parent draft');
    assert.equal(await readFile(file(input, 'module/file.cjs'), 'utf8'), 'child content');
    assert.deepEqual(await readdir(file(input, 'module/empty')), []);
    return result('draft.txt');
  }, undefined, { traceWait: true });
  await writeFile(path.join(f.source, 'module'), 'base file');
  f.task({ title: 'Parent', goalId: goal.id });
  await f.start();
  await waitForComposition(f, goal, current, diagnostics);
  const checkout = path.join(f.root, 'parent-candidate');
  await checkoutCopyComposition(current().composition.snapshot, checkout, f.dataDir);
  assert.equal(await readFile(path.join(checkout, 'draft.txt'), 'utf8'), 'parent draft');
  assert.equal(await readFile(path.join(checkout, 'module/file.cjs'), 'utf8'), 'child content');
  assert.equal(await readFile(path.join(f.source, 'module'), 'utf8'), 'base file');
});

test('parallel conflicting directory edits preserve the two task deliveries and block goal review', async t => {
  const { f, goal, current } = await setup(t, async input => {
    if (input.task.kind !== 'work') return { outcome: 'blocked', kind: 'human', reason: 'Fixture waits for conflict resolution' };
    await writeFile(file(input, 'shared.bin'), Buffer.from([0, input.task.title === 'One' ? 11 : 22]));
    return result('shared.bin');
  });
  await writeFile(path.join(f.source, 'shared.bin'), Buffer.from([0, 99]));
  const one = f.task({ title: 'One', goalId: goal.id });
  const two = f.task({ title: 'Two', goalId: goal.id });
  await f.start();
  await until(() => current().compositionRecheck?.status === 'failed', 45000, () => current().compositionRecheck);
  assert.match(current().compositionRecheck.reason, /shared\.bin.*冲突/);
  assert.equal(get(f, one).status, 'succeeded');
  assert.equal(get(f, two).status, 'succeeded');
  assert.notEqual(get(f, one).integration.delivery.sha256, get(f, two).integration.delivery.sha256);
  assert.equal(current().status, 'active');
  assert.throws(() => f.command('review.request', { goalId: goal.id }), { code: 'COMPOSITE_NOT_VERIFIED' });
  assert.deepEqual(await readFile(path.join(f.source, 'shared.bin')), Buffer.from([0, 99]));
});

test('missing frozen directory data blocks the dependent before dispatch while ordinary copy remains opt-in', async t => {
  const { f, goal } = await setup(t, async input => {
    await writeFile(file(input, 'a.txt'), 'persistent result');
    return result('a.txt');
  });
  const a = f.task({ title: 'A', goalId: goal.id });
  const b = f.task({ title: 'B', goalId: goal.id, dependencies: [a.id] });
  const ordinary = f.task({ title: 'Ordinary copy' });
  f.command('task.pause', { id: b.id });
  await f.start();
  await waitForTask(f, a, 'succeeded');
  const snapshot = get(f, a).integration.delivery.sha256;
  await rename(path.join(f.dataDir, 'deliveries', 'copy', 'trees', snapshot + '.json'), path.join(f.root, 'held-tree.json'));
  f.command('task.resume', { id: b.id });
  await waitForTask(f, b, 'blocked');
  assert.equal(get(f, b).attempts, 0);
  assert(!f.adapter.calls.some(call => call.task.id === b.id));
  const attempt = f.store.list('attempts').find(row => row.taskId === b.id);
  assert.equal(attempt.preflightOnly, true);
  assert.match(attempt.summary, /目录候选文件/);
  await waitForTask(f, ordinary, 'succeeded');
  assert.equal(get(f, ordinary).integration.delivery, undefined);
  assert.equal(get(f, ordinary).workspace.compositionInput, undefined);
});

test('a failed joint directory check keeps both inputs and can be retried on the same candidate', async t => {
  const { f, goal, current } = await setup(t, async input => {
    const name = input.task.title + '.txt';
    await writeFile(file(input, name), name);
    return result(name);
  }, "const fs=require('node:fs'); if(fs.existsSync('left.txt') && fs.existsSync('right.txt'))process.exit(9)");
  const left = f.task({ title: 'left', goalId: goal.id });
  const right = f.task({ title: 'right', goalId: goal.id });
  await f.start();
  await until(() => current().compositionRecheck?.status === 'failed', 45000, () => current().compositionRecheck);
  const failed = f.store.list('integrations').find(row => row.goalId === goal.id && row.phase === 'failed');
  assert.equal(failed.composition.passed, false);
  assert.equal(failed.composition.checks[0].code, 9);
  assert.equal(get(f, left).status, 'succeeded');
  assert.equal(get(f, right).status, 'succeeded');
  assert.equal(f.company.snapshot().goals.find(row => row.id === goal.id).compositionVerified, false);
  assert.throws(() => f.command('review.request', { goalId: goal.id }), { code: 'COMPOSITE_NOT_VERIFIED' });
  const calls = f.adapter.calls.length;
  await f.engine.stop();
  f.command('project.save', { id: f.project.id, checks: [{ id: 'joint', command: process.execPath,
    args: ['-e', "const fs=require('node:fs'); if(!fs.existsSync('left.txt') || !fs.existsSync('right.txt'))process.exit(10)"] }] });
  const queued = f.command('goal.composition.recheck', { id: goal.id }).compositionRecheck;
  await f.start();
  await waitForComposition(f, goal, current);
  assert.equal(current().composition.version, failed.composition.version);
  assert.equal(current().composition.contentHash, failed.composition.contentHash);
  assert.equal(f.adapter.calls.length, calls);
  assert(f.store.list('integrations').some(row => row.compositionRecheckId === queued.id && row.phase === 'completed'));
});

test('the retention dry run protects private drafts and incomplete copy deliveries', async t => {
  const { f, goal, current } = await setup(t, async input => {
    await writeFile(file(input, 'material.bin'), Buffer.from([15, 0, 255]));
    return result('material.bin');
  });
  const task = f.task({ goalId: goal.id });
  await f.start();
  await waitForComposition(f, goal, current);
  await f.engine.stop();
  const workspace = get(f, task).workspace.path;
  const relative = `workspaces/${task.id}`;
  const old = new Date(2000, 0, 1);
  async function age(filename) {
    const entries = await readdir(filename, { withFileTypes: true });
    for (const item of entries) {
      const target = path.join(filename, item.name);
      if (item.isDirectory()) await age(target);
      else await utimes(target, old, old);
    }
    await utimes(filename, old, old);
  }
  const plan = () => prunePlan({ dataDir: f.dataDir, days: 1 });
  await age(workspace);
  assert((await plan()).candidates.some(item => item.path === relative));
  const privateDraft = path.join(workspace, '.env');
  await writeFile(privateDraft, 'private draft present only in workspace');
  await age(workspace);
  assert((await plan()).protected.some(item => item.path === relative));
  await unlink(privateDraft);
  const snapshot = path.join(f.dataDir, 'deliveries', 'copy', 'trees', get(f, task).integration.delivery.sha256 + '.json');
  await rename(snapshot, path.join(f.root, 'held-version.json'));
  await age(workspace);
  assert((await plan()).protected.some(item => item.path === relative));
  assert.deepEqual(await readFile(path.join(workspace, 'material.bin')), Buffer.from([15, 0, 255]));
});

test('a supported project with an included link blocks composition without following it', async t => {
  const { f, goal } = await setup(t, () => assert.fail('the inaccessible input must stop before dispatch'));
  await mkdir(path.join(f.root, 'outside'));
  await writeFile(path.join(f.root, 'outside', 'private.txt'), 'outside approved input');
  await symlink(path.join(f.root, 'outside'), path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const task = f.task({ goalId: goal.id });
  await f.start();
  await waitForTask(f, task, 'blocked');
  const attempt = f.store.list('attempts').find(row => row.taskId === task.id);
  assert.equal(attempt.preflightOnly, true);
  assert.match(attempt.summary, /linked.*链接/);
  assert(!f.adapter.calls.some(call => call.task.id === task.id));
  assert.equal(f.store.require('goals', goal.id).compositionBase, undefined);
});

test('copy contract replacements read approved historic versions and select only current deliveries', async t => {
  const { f, goal, current } = await setup(t, async input => {
    const title = input.task.title;
    if (title === 'Old A') {
      await writeFile(file(input, 'upstream.txt'), 'old upstream');
      await writeFile(file(input, 'retained.bin'), Buffer.from([0, 100, 255]));
      return result('upstream.txt');
    }
    if (title === 'Old B') {
      assert.equal(await readFile(file(input, 'upstream.txt'), 'utf8'), 'old upstream');
      await writeFile(file(input, 'downstream.txt'), 'old downstream');
      return result('downstream.txt');
    }
    if (title === 'New A') {
      assert.equal(await readFile(file(input, 'upstream.txt'), 'utf8'), 'old upstream');
      await writeFile(file(input, 'upstream.txt'), 'new upstream');
      return result('upstream.txt');
    }
    assert.equal(await readFile(file(input, 'upstream.txt'), 'utf8'), 'new upstream');
    assert.equal(await readFile(file(input, 'downstream.txt'), 'utf8'), 'old downstream');
    await writeFile(file(input, 'downstream.txt'), 'new downstream');
    return result('downstream.txt');
  });
  const oldA = f.task({ title: 'Old A', goalId: goal.id });
  const oldB = f.task({ title: 'Old B', goalId: goal.id, dependencies: [oldA.id] });
  await f.start();
  await waitForComposition(f, goal, current);
  f.command('company.pause', { afterCurrent: true });
  const edited = f.command('goal.edit', { id: goal.id, patch: { acceptance: 'Use the changed upstream and downstream' } });
  const newA = f.task({ title: 'New A', goalId: goal.id, dependencies: [oldA.id] });
  const newB = f.task({ title: 'New B', goalId: goal.id, dependencies: [oldB.id, newA.id] });
  f.engine.refreshReadiness();
  const coordinator = f.store.require('tasks', edited.contractChange.coordinationTaskId);
  const attempt = f.engine.claim(coordinator, f.store.require('agents', coordinator.agentId));
  await f.engine.accept(attempt, { outcome: 'coordinated', contractAssessment: { reason: 'Replace both in order', reuse: [], followUps: [
    { taskId: oldA.id, followUp: newA.id }, { taskId: oldB.id, followUp: newB.id },
  ] } }, new AbortController().signal);
  f.store.put('attempts', { ...f.store.require('attempts', attempt.id), cleanupPending: false });
  f.command('company.resume');
  await waitForComposition(f, goal, current);
  assert.deepEqual(current().composition.inputs.map(input => input.taskId), [newA.id, newB.id]);
  const checkout = path.join(f.root, 'replaced-copy-candidate');
  await checkoutCopyComposition(current().composition.snapshot, checkout, f.dataDir);
  assert.equal(await readFile(path.join(checkout, 'upstream.txt'), 'utf8'), 'new upstream');
  assert.equal(await readFile(path.join(checkout, 'downstream.txt'), 'utf8'), 'new downstream');
  assert.deepEqual(await readFile(path.join(checkout, 'retained.bin')), Buffer.from([0, 100, 255]));
});

test('a moved approved directory blocks new copies while an already captured candidate can still be reviewed', async t => {
  const { f, goal, current } = await setup(t, async input => {
    if (input.task.kind === 'review') {
      assert.equal(await readFile(file(input, 'delivery.txt'), 'utf8'), 'accepted directory content');
      return { outcome: 'reviewed', decision: 'approve', summary: 'Verified the persisted candidate' };
    }
    await writeFile(file(input, 'delivery.txt'), 'accepted directory content');
    return result('delivery.txt');
  });
  const a = f.task({ goalId: goal.id });
  await f.start();
  await waitForComposition(f, goal, current);
  const delivered = current().composition;
  await f.engine.stop();
  await rename(f.source, path.join(f.root, 'source-held'));
  await assert.rejects(f.workspaces.prepare({ ...get(f, a), workspace: null }, {}), { code: 'COMPOSITE_BASE', message: /恢复项目目录/ });
  const review = f.command('review.request', { goalId: goal.id });
  await f.start();
  await waitForTask(f, review, 'succeeded');
  assert.equal(get(f, review).passed, true);
  assert.equal(get(f, review).workspace.candidateVersion, delivered.version);
});

test('joint checks cannot approve a directory candidate by removing an empty input directory', async t => {
  const { f, goal, current } = await setup(t, async input => {
    if (input.task.title === 'A') {
      await mkdir(file(input, 'feature.disabled'));
      await writeFile(file(input, 'a.txt'), 'Provided the feature control directory');
      return result('a.txt');
    }
    await writeFile(file(input, 'app.cjs'), "if(require('node:fs').existsSync('feature.disabled'))process.exit(42)");
    return result('app.cjs');
  }, "const fs=require('node:fs'); if(fs.existsSync('app.cjs') && fs.existsSync('feature.disabled')){fs.rmdirSync('feature.disabled');require('./app.cjs')}");
  f.task({ title: 'A', goalId: goal.id });
  f.task({ title: 'B', goalId: goal.id });
  await f.start();
  await until(() => {
    assert.notEqual(current().status, 'succeeded', 'a check on a mutated candidate must not approve the goal');
    return current().compositionRecheck?.status === 'failed';
  }, 45000, () => current().compositionRecheck);
  const record = f.store.list('integrations').find(row => row.goalId === goal.id && row.phase === 'failed');
  const [check] = record.composition.checks;
  assert.equal(check.code, 0);
  assert.equal(check.inputHash, record.composition.contentHash);
  assert.equal(check.inputUnchanged, false);
  assert.equal(check.passed, false);
  assert.throws(() => f.command('review.request', { goalId: goal.id }), { code: 'COMPOSITE_NOT_VERIFIED' });
  const checkout = path.join(f.root, 'empty-directory-candidate');
  await checkoutCopyComposition(record.composition.snapshot, checkout, f.dataDir);
  assert.deepEqual(await readdir(path.join(checkout, 'feature.disabled')), []);
  assert.equal((await run(process.execPath, ['app.cjs'], checkout)).code, 42);
});

for (const corrupt of [false, true]) test(`task review checks the saved copy after the work folder is removed (corrupt=${corrupt})`, async t => {
  const payload = Buffer.from([0, 33, 128, 255]);
  const { f, goal, current } = await setup(t, async input => {
    if (input.task.kind === 'review') {
      assert.deepEqual(await readFile(file(input, 'material.bin')), payload);
      return { outcome: 'reviewed', decision: 'approve', summary: 'Independent review from the persisted copy' };
    }
    await writeFile(file(input, 'material.bin'), payload);
    return result('material.bin');
  });
  const task = f.task({ goalId: goal.id });
  await f.start();
  await waitForComposition(f, goal, current);
  await f.engine.stop();
  const original = get(f, task);
  await rename(original.workspace.path, path.join(f.root, 'held-workspace'));
  if (corrupt) {
    const version = original.integration.delivery.sha256;
    const tree = JSON.parse(await readFile(path.join(f.dataDir, 'deliveries', 'copy', 'trees', version + '.json'), 'utf8'));
    const row = tree.entries.find(([name]) => name === 'material.bin');
    await writeFile(path.join(f.dataDir, 'deliveries', 'copy', 'files', row[2]), Buffer.alloc(payload.length));
  }
  const review = f.command('review.request', { id: task.id });
  await f.start();
  await waitForTask(f, review, corrupt ? 'blocked' : 'succeeded');
  const reviews = f.adapter.calls.filter(call => call.task.id === review.id);
  assert.equal(reviews.length, corrupt ? 0 : 1);
  if (corrupt) {
    assert.equal(get(f, review).attempts, 0);
    assert(get(f, review).environmentBlock?.failures.some(failure => failure.subject === '持久目录交付'));
  } else {
    assert.equal(get(f, review).passed, true);
    assert.equal(get(f, review).reviewArtifactHash, original.artifactHash);
  }
});
