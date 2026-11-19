import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, gitProject, taskWaitDiagnostics, until } from './helpers.js';
import { checkoutComposition, composeGitVersions, selectedGitVersions } from '../src/runtime/git-composition.js';
import { orderedCompositionTasks } from '../src/core/composite-delivery.js';
import { executionOccupancy } from '../src/core/execution-capacity.js';
import { run } from '../src/runtime/workspaces.js';

const fromWorkspace = (input, name) => path.join(input.task.workspace.path, name);
const taskState = (f, task) => f.store.require('tasks', task.id);
const goalState = (f, goal) => f.store.require('goals', goal.id);

async function git(cwd, ...args) {
  const result = await run('git', args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function simulateCleanup(f) {
  const invoke = async (command, args, cwd, options) => {
    options.beforeStart?.(command);
    const result = await run(command, args, cwd, options);
    if (options.cleanupReceipt) await writeFile(options.cleanupReceipt, JSON.stringify({ confirmed: true, exitCode: result.code ?? 1 }));
    return { ...result, cleanupConfirmed: true };
  };
  f.workspaces.runIntegrationCommand = invoke;
  f.workspaces.runDeliveryCheck = invoke;
}

async function setup(t, handler, check, { finalReview = false } = {}) {
  const f = await fixture(t, handler);
  await writeFile(path.join(f.source, 'obsolete.txt'), 'remove this from the candidate');
  await writeFile(path.join(f.source, 'shared.txt'), 'base');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, name: f.project.name, repoRoot: f.source, mode: 'git', autoMerge: false,
    checks: [{ id: 'candidate-test', command: process.execPath, args: ['-e', check] }] });
  const goal = f.command('goal.create', { projectId: f.project.id, templateId: finalReview ? 'base' : f.template.id, plan: false,
    title: 'Runnable Git candidate', description: 'Combine selected task versions', acceptance: 'Candidate passes the project check', deliveryMode: 'git-composite' });
  simulateCleanup(f);
  return { f, base, goal };
}

test('a dependent task and final reviewer receive the same selected candidate after the source advances', async t => {
  const binary = Buffer.from([0, 255, 29, 128]);
  let reviewerBytes;
  const { f, base, goal } = await setup(t, async input => {
    if (input.task.origin?.kind === 'goal-contract') return { outcome: 'coordinated', contractAssessment: {
      reason: 'The already delivered inputs cover the revised requirement',
      reuse: f.store.list('tasks').filter(task => task.goalId === goal.id && task.kind === 'work' && task.status === 'succeeded').map(task => task.id),
      followUps: [],
    } };
    if (input.task.kind === 'review') {
      assert.equal(await readFile(fromWorkspace(input, 'app.cjs'), 'utf8'), "require('./lib/a.cjs');\n");
      reviewerBytes = await readFile(fromWorkspace(input, 'asset.bin'));
      assert.doesNotMatch(await readdir(input.task.workspace.path).then(list => list.join(',')), /(^|,)1(,|$)/);
      return { outcome: 'reviewed', decision: 'approve', summary: 'Verified the runnable candidate' };
    }
    if (input.task.title === 'A') {
      await mkdir(fromWorkspace(input, 'lib'));
      await writeFile(fromWorkspace(input, 'lib/a.cjs'), 'module.exports = 1;\n');
      await writeFile(fromWorkspace(input, 'asset.bin'), binary);
      await writeFile(fromWorkspace(input, 'shared.txt'), 'updated by A');
      await unlink(fromWorkspace(input, 'obsolete.txt'));
      return { outcome: 'completed', artifacts: [{ path: 'lib/a.cjs' }] };
    }
    assert.equal(await readFile(fromWorkspace(input, 'lib/a.cjs'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(await readFile(fromWorkspace(input, 'shared.txt'), 'utf8'), 'updated by A');
    assert.deepEqual(await readFile(fromWorkspace(input, 'asset.bin')), binary);
    await assert.rejects(readFile(fromWorkspace(input, 'obsolete.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(fromWorkspace(input, 'later.txt')), { code: 'ENOENT' });
    await writeFile(fromWorkspace(input, 'lib/a.cjs'), 'module.exports = 2;\n');
    await writeFile(fromWorkspace(input, 'app.cjs'), "require('./lib/a.cjs');\n");
    return { outcome: 'completed', artifacts: [{ path: 'app.cjs' }] };
  }, "const fs=require('node:fs'); if(fs.existsSync('app.cjs') && (require('./lib/a.cjs')!==2 || fs.readFileSync('asset.bin')[1]!==255 || fs.existsSync('obsolete.txt'))) process.exit(8)", { finalReview: true });
  const a = f.task({ title: 'A', goalId: goal.id });
  const b = f.task({ title: 'B', goalId: goal.id, dependencies: [a.id] });
  f.command('task.pause', { id: b.id });
  await f.start();
  await until(() => taskState(f, a).status === 'succeeded', 45000, taskWaitDiagnostics(f, a.id));
  const deliveredA = taskState(f, a).integration.delivery;
  assert.equal(goalState(f, goal).compositionBase.commit, base);
  assert.equal(goalState(f, goal).composition, undefined);
  await f.engine.stop();
  await writeFile(path.join(taskState(f, a).workspace.path, 'lib', 'a.cjs'), 'module.exports = 999;\n');
  await writeFile(path.join(f.source, 'later.txt'), 'new source revision');
  await git(f.source, 'add', 'later.txt');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Advance source');
  const advanced = await git(f.source, 'rev-parse', 'HEAD');
  const original = await git(f.source, 'status', '--porcelain');
  // Simulate stopping after provisioning and before the attempt stores its workspace.
  const unattached = await f.workspaces.prepare(taskState(f, b), {});
  assert.equal(taskState(f, b).workspace, undefined);
  await f.start();
  f.command('task.resume', { id: b.id });
  await until(() => {
    const failed = f.store.list('attempts').find(attempt => attempt.goalId === goal.id && attempt.status === 'failed');
    if (failed) assert.fail(failed.summary ?? taskState(f, b).feedback);
    return goalState(f, goal).status === 'succeeded';
  }, 45000, taskWaitDiagnostics(f, b.id));

  const deliveredB = taskState(f, b);
  assert.equal(deliveredB.workspace.path, unattached.path);
  assert.equal(deliveredB.workspace.baseCommit, base);
  assert.equal(deliveredB.workspace.compositionInput.inputs[0].bundleSha256, deliveredA.sha256);
  const result = goalState(f, goal).composition;
  assert.equal(result.passed, true);
  assert.equal(result.baseCommit, base);
  assert.deepEqual(result.inputs.map(row => row.taskId), [a.id, b.id]);
  const actualGoal = goalState(f, goal);
  const actualA = taskState(f, a);
  assert.deepEqual(orderedCompositionTasks(f.store, actualGoal, [deliveredB, actualA]).map(row => row.id), [a.id, b.id]);
  await assert.rejects(selectedGitVersions([{ ...actualA, workspace: { ...actualA.workspace, compositionBase: advanced } }], base, f.dataDir),
    { code: 'COMPOSITE_INPUT_MISSING' });
  assert(result.checks.every(check => check.passed && check.checkVersion && check.environment && check.inputHash && check.log));
  const detached = path.join(f.root, 'detached-goal-candidate');
  await checkoutComposition(result, detached, f.root, f.dataDir, run);
  assert.equal(await readFile(path.join(detached, 'lib/a.cjs'), 'utf8'), 'module.exports = 2;\n');
  assert.deepEqual(await readFile(path.join(detached, 'asset.bin')), binary);
  assert.deepEqual(reviewerBytes, binary);
  assert.equal(f.store.list('tasks').find(task => task.goalId === goal.id && task.reviewScope === 'goal').workspace.candidateVersion, result.version);
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), advanced);
  assert.equal(await git(f.source, 'status', '--porcelain'), original);

  const workCalls = f.adapter.calls.filter(call => call.task.kind === 'work').length;
  f.command('goal.edit', { id: goal.id, patch: { acceptance: 'Retain the runnable candidate and its existing binary asset' } });
  await until(() => goalState(f, goal).contractChange?.status === 'assessed', 45000);
  assert.equal(f.company.snapshot().goals.find(row => row.id === goal.id).compositionVerified, false);
  assert.equal(goalState(f, goal).status, 'active');
  await f.engine.stop();
  const queued = f.command('goal.composition.recheck', { id: goal.id }).compositionRecheck;
  assert.equal(queued.status, 'queued');
  await f.start();
  await until(() => goalState(f, goal).status === 'succeeded', 45000, () => goalState(f, goal).compositionRecheck);
  const reassessed = goalState(f, goal).composition;
  assert.equal(reassessed.version, result.version);
  assert.notEqual(reassessed.ledgerHash, result.ledgerHash);
  assert(f.store.list('integrations').some(row => row.compositionRecheckId === queued.id && row.phase === 'completed'));

  f.command('project.save', { id: f.project.id, checks: [{ id: 'joint-new', command: process.execPath,
    args: ['-e', "if(require('./lib/a.cjs')!==2)process.exit(10)"] }] });
  assert.equal(goalState(f, goal).status, 'active');
  assert.equal(f.company.snapshot().goals.find(row => row.id === goal.id).compositionVerified, false);
  f.command('goal.composition.recheck', { id: goal.id });
  await until(() => goalState(f, goal).status === 'succeeded', 45000, () => goalState(f, goal).compositionRecheck);
  const withNewCheck = goalState(f, goal).composition;
  assert.equal(withNewCheck.bundle.sha256, result.bundle.sha256);
  assert.deepEqual(withNewCheck.checks.map(check => check.id), ['joint-new']);
  assert.equal(f.adapter.calls.filter(call => call.task.kind === 'work').length, workCalls);
  await f.engine.stop();
  f.command('task.edit', { id: a.id, patch: { description: 'A revised input requires a new candidate' } });
  assert.equal(f.company.snapshot().goals.find(row => row.id === goal.id).compositionVerified, false);
  assert.throws(() => f.command('review.request', { goalId: goal.id }), { code: 'COMPOSITE_NOT_VERIFIED' });
});

test('a combined check failure leaves the goal and its final review waiting', async t => {
  const { f, goal } = await setup(t, async input => {
    if (input.task.kind !== 'work') return { outcome: 'blocked', kind: 'human', reason: 'Fixture waits for the owner' };
    const filename = input.task.title + '.txt';
    await writeFile(fromWorkspace(input, filename), input.task.title);
    return { outcome: 'completed', artifacts: [{ path: filename }] };
  }, "const fs=require('node:fs'); if(fs.existsSync('left.txt') && fs.existsSync('right.txt')) process.exit(9)", { finalReview: true });
  const left = f.task({ title: 'left', goalId: goal.id });
  const right = f.task({ title: 'right', goalId: goal.id });
  await f.start();
  const failed = await until(() => f.store.list('integrations').find(record => record.goalId === goal.id && record.phase === 'failed'), 45000);
  assert.equal(failed.composition.passed, false);
  assert.equal(failed.composition.checks[0].code, 9);
  assert.equal(goalState(f, goal).status, 'active');
  assert.equal(taskState(f, left).status, 'succeeded');
  assert.equal(taskState(f, right).status, 'succeeded');
  assert.equal(f.store.list('tasks').some(task => task.goalId === goal.id && task.reviewScope === 'goal'), false);
  assert.throws(() => f.command('review.request', { scope: 'goal', goalId: goal.id }), { code: 'COMPOSITE_NOT_VERIFIED' });
});

test('composition rejects incompatible same-path edits and reuses an identical materialized version', async t => {
  const { f, base, goal } = await setup(t, async input => {
    if (input.task.kind !== 'work') return { outcome: 'blocked', kind: 'human', reason: 'Fixture waits for conflict resolution' };
    await writeFile(fromWorkspace(input, 'shared.txt'), input.task.title);
    return { outcome: 'completed', artifacts: [{ path: 'shared.txt' }] };
  }, 'process.exitCode=0');
  const a = f.task({ title: 'a', goalId: goal.id });
  const b = f.task({ title: 'b', goalId: goal.id });
  f.command('task.pause', { id: b.id });
  await f.start();
  await until(() => taskState(f, a).status === 'succeeded', 45000, taskWaitDiagnostics(f, a.id));
  const accepted = taskState(f, a);
  const input = { taskId: a.id, generation: accepted.generation, artifactHash: accepted.artifactHash, bundle: accepted.integration.delivery };
  const options = { dataDir: f.dataDir, source: f.source, baseCommit: base, inputs: [input], invoke: run };
  const first = await composeGitVersions(options);
  assert.deepEqual(await composeGitVersions({ ...options, invoke: () => assert.fail('the same version can be reused') }), first);

  f.command('task.resume', { id: b.id });
  const failed = await until(() => f.store.list('integrations').find(record => record.goalId === goal.id && record.phase === 'failed'), 45000);
  assert.match(failed.reason, /冲突.*shared.txt/);
  assert.equal(goalState(f, goal).composition, undefined);
  assert.equal(await readFile(path.join(f.source, 'shared.txt'), 'utf8'), 'base');
});

test('missing selected bundle blocks preparation without invoking the dependent worker', async t => {
  const { f, goal } = await setup(t, async input => {
    await writeFile(fromWorkspace(input, 'artifact.txt'), input.task.title);
    return { outcome: 'completed', artifacts: [{ path: 'artifact.txt' }] };
  }, 'process.exitCode=0');
  const a = f.task({ title: 'A', goalId: goal.id });
  const b = f.task({ title: 'B', goalId: goal.id, dependencies: [a.id] });
  f.command('task.pause', { id: b.id });
  await f.start();
  await until(() => taskState(f, a).status === 'succeeded', 45000, taskWaitDiagnostics(f, a.id));
  const filename = taskState(f, a).integration.delivery.path;
  await rename(filename, path.join(f.root, 'held-original.bundle'));
  f.command('task.resume', { id: b.id });
  await until(() => taskState(f, b).status === 'blocked', 45000, taskWaitDiagnostics(f, b.id));
  assert.equal(taskState(f, b).attempts, 0);
  assert.equal(f.adapter.calls.some(call => call.task.id === b.id), false);
  const prepared = f.store.list('attempts').find(attempt => attempt.taskId === b.id);
  assert.match(prepared.summary, /缺少可核对的固定基线或持久 Git 交付/);
  assert.equal(goalState(f, goal).composition, undefined);
});

test('a conventional Git goal keeps individual delivery and completion without composition', async t => {
  const { f } = await setup(t, async input => {
    await writeFile(fromWorkspace(input, 'ordinary.txt'), 'ordinary delivery');
    return { outcome: 'completed', artifacts: [{ path: 'ordinary.txt' }] };
  }, 'process.exitCode=0');
  const task = f.task();
  await f.start();
  await until(() => goalState(f, f.goal).status === 'succeeded', 45000, taskWaitDiagnostics(f, task.id));
  assert.equal(goalState(f, f.goal).composition, undefined);
  assert.equal(taskState(f, task).workspace.compositionInput, undefined);
  assert.equal(taskState(f, task).integration.status, 'available');
});

test('a candidate check with unknown command cleanup owns its slot across restart and resumes after its receipt', async t => {
  const { f, goal } = await setup(t, async input => {
    await writeFile(fromWorkspace(input, 'code.txt'), 'same selected code version');
    return { outcome: 'completed', artifacts: [{ path: 'code.txt' }] };
  }, 'process.exitCode=0');
  const task = f.task({ goalId: goal.id });
  await f.start();
  await until(() => goalState(f, goal).status === 'succeeded', 45000);
  const version = goalState(f, goal).composition.version;
  const invoke = f.workspaces.runIntegrationCommand;
  let receipt;
  f.workspaces.runIntegrationCommand = async (command, args, cwd, options) => {
    if (!receipt && f.engine.activeIntegration?.compositionRecheckId) {
      receipt = options.cleanupReceipt;
      throw Object.assign(new Error('Fixture command cleanup must be reconciled'), { cleanupUncertain: true });
    }
    return invoke(command, args, cwd, options);
  };
  f.command('goal.composition.recheck', { id: goal.id });
  await until(() => goalState(f, goal).compositionRecheck?.status === 'reconciling', 45000);
  assert.equal(executionOccupancy(f.store).integrations, 1);
  assert.equal(taskState(f, task).status, 'succeeded');
  await f.engine.stop();
  await f.start();
  assert.equal(goalState(f, goal).compositionRecheck?.status, 'reconciling');
  assert.equal(executionOccupancy(f.store).integrations, 1);
  await writeFile(receipt, JSON.stringify({ confirmed: true, exitCode: 1 }));
  await until(() => goalState(f, goal).status === 'succeeded', 45000, () => goalState(f, goal).compositionRecheck);
  assert.equal(goalState(f, goal).composition.version, version);
  assert.equal(executionOccupancy(f.store).integrations, 0);
  assert.equal(f.adapter.calls.filter(call => call.task.id === task.id).length, 1);
});

test('case aliases in a combined Windows tree fail with both paths and keep the source versions', { skip: process.platform !== 'win32' }, async t => {
  const { f, goal } = await setup(t, async input => {
    const filename = input.task.title;
    await writeFile(fromWorkspace(input, filename), filename);
    return { outcome: 'completed', artifacts: [{ path: filename }] };
  }, 'process.exitCode=0');
  const upper = f.task({ title: 'Foo.txt', goalId: goal.id });
  const lower = f.task({ title: 'foo.txt', goalId: goal.id });
  await f.start();
  const failed = await until(() => {
    assert.notEqual(goalState(f, goal).status, 'succeeded', 'a combined tree with case aliases must not be verified');
    return f.store.list('integrations').find(item => item.goalId === goal.id && item.phase === 'failed');
  }, 45000, () => ({ upper: taskWaitDiagnostics(f, upper.id)(), lower: taskWaitDiagnostics(f, lower.id)() }));
  assert.match(failed.reason, /Foo\.txt/);
  assert.match(failed.reason, /foo\.txt/);
  assert.equal(goalState(f, goal).composition, undefined);
  assert.equal(taskState(f, upper).status, 'succeeded');
  assert.equal(taskState(f, lower).status, 'succeeded');
});

test('a valid task bundle without worktree coverage cannot approve a complete goal', async t => {
  const bytes = Buffer.from([0, 245, 1, 255]);
  const { f, goal } = await setup(t, async input => {
    await writeFile(fromWorkspace(input, 'settings.bin'), bytes);
    await writeFile(fromWorkspace(input, 'report.txt'), 'the report does not declare the runtime file');
    return { outcome: 'completed', artifacts: [{ path: 'report.txt' }] };
  }, 'process.exitCode=0');
  await writeFile(path.join(f.source, '.gitignore'), 'settings.bin\n');
  await git(f.source, 'add', '.gitignore');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Ignore local settings');
  const task = f.task({ goalId: goal.id });
  await f.start();
  const failed = await until(() => f.store.list('integrations').find(item => item.goalId === goal.id && item.phase === 'failed'), 45000);
  const delivered = taskState(f, task);
  assert.equal(delivered.status, 'succeeded');
  assert.equal(delivered.integration.delivery.worktreeHash, null);
  assert.deepEqual(await readFile(path.join(delivered.workspace.path, 'settings.bin')), bytes);
  assert.match(failed.reason, /未证明覆盖完整工作副本/);
  assert.equal(goalState(f, goal).status, 'active');
  assert.equal(goalState(f, goal).composition, undefined);
});

test('decomposition brings child delivery into the parent without replacing its draft or index', async t => {
  let parentRuns = 0;
  let parentDirectory;
  const { f, goal } = await setup(t, async input => {
    if (input.task.title === 'Child') {
      await writeFile(fromWorkspace(input, 'child.txt'), 'verified child content');
      return { outcome: 'completed', artifacts: [{ path: 'child.txt' }] };
    }
    parentRuns += 1;
    if (parentRuns === 1) {
      parentDirectory = input.task.workspace.path;
      await writeFile(fromWorkspace(input, 'draft.txt'), 'untracked parent draft');
      await writeFile(fromWorkspace(input, 'staged.txt'), 'staged parent draft');
      await git(parentDirectory, 'add', 'staged.txt');
      return { outcome: 'decomposed', tasks: [{ key: 'child', title: 'Child', description: 'Create a child module', acceptance: 'Deliver child.txt', dependencies: [] }] };
    }
    assert.equal(input.task.workspace.path, parentDirectory);
    assert.equal(await readFile(fromWorkspace(input, 'draft.txt'), 'utf8'), 'untracked parent draft');
    assert.equal(await git(parentDirectory, 'show', ':staged.txt'), 'staged parent draft');
    assert.equal(await readFile(fromWorkspace(input, 'child.txt'), 'utf8'), 'verified child content');
    return { outcome: 'completed', artifacts: [{ path: 'draft.txt' }] };
  }, 'process.exitCode=0');
  const task = f.task({ title: 'Parent', goalId: goal.id });
  await f.start();
  await until(() => {
    const failed = f.store.list('attempts').find(item => item.goalId === goal.id && item.status === 'failed');
    if (failed) assert.fail(failed.summary);
    return goalState(f, goal).status === 'succeeded';
  }, 45000, taskWaitDiagnostics(f, task.id));
  assert.equal(parentRuns, 2);
  assert.equal(goalState(f, goal).composition.inputs.length, 2);
  assert.equal(taskState(f, task).workspace.path, parentDirectory);
});

test('a child change overlapping a parent draft leaves the parent files and index untouched', async t => {
  let parentRuns = 0;
  const { f, goal } = await setup(t, async input => {
    if (input.task.title === 'Child') {
      await writeFile(fromWorkspace(input, 'shared.txt'), 'child intent');
      return { outcome: 'completed', artifacts: [{ path: 'shared.txt' }] };
    }
    parentRuns += 1;
    assert.equal(parentRuns, 1);
    await writeFile(fromWorkspace(input, 'shared.txt'), 'staged parent intent');
    await git(input.task.workspace.path, 'add', 'shared.txt');
    await writeFile(fromWorkspace(input, 'shared.txt'), 'unstaged parent intent');
    return { outcome: 'decomposed', tasks: [{ key: 'child', title: 'Child', description: 'Update shared.txt', acceptance: 'Deliver a change', dependencies: [] }] };
  }, 'process.exitCode=0');
  const parent = f.task({ title: 'Parent', goalId: goal.id });
  await f.start();
  await until(() => f.store.list('attempts').some(attempt => attempt.taskId === parent.id && attempt.preflightOnly && attempt.status === 'failed'),
    45000, taskWaitDiagnostics(f, parent.id));
  const directory = taskState(f, parent).workspace.path;
  assert.equal(await readFile(path.join(directory, 'shared.txt'), 'utf8'), 'unstaged parent intent');
  assert.equal(await git(directory, 'show', ':shared.txt'), 'staged parent intent');
  assert.equal(parentRuns, 1);
  assert.equal(goalState(f, goal).status, 'active');
});

async function structuralDecomposition(t, { baseline, update, artifact, inspect }) {
  let directory;
  const { f, goal } = await setup(t, async input => {
    if (input.task.kind !== 'work') return { outcome: 'blocked', kind: 'human', reason: 'Fixture waits for the original failure' };
    if (input.task.title === 'Child') {
      await update(input.task.workspace.path);
      return { outcome: 'completed', artifacts: [{ path: artifact }] };
    }
    if (!directory) {
      directory = input.task.workspace.path;
      await writeFile(fromWorkspace(input, 'draft.txt'), 'retained parent draft');
      await writeFile(fromWorkspace(input, 'staged.txt'), 'retained parent index');
      await git(directory, 'add', 'staged.txt');
      return { outcome: 'decomposed', tasks: [{ key: 'child', title: 'Child', description: 'Update the project shape', acceptance: 'Deliver the validated new path', dependencies: [] }] };
    }
    assert.equal(input.task.workspace.path, directory);
    assert.equal(await readFile(fromWorkspace(input, 'draft.txt'), 'utf8'), 'retained parent draft');
    assert.equal(await git(directory, 'show', ':staged.txt'), 'retained parent index');
    await inspect(directory);
    return { outcome: 'completed', artifacts: [{ path: 'draft.txt' }] };
  }, 'process.exitCode=0');
  await baseline(f.source);
  await git(f.source, 'add', '.');
  await git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Pin structural fixture');
  return { f, goal, task: f.task({ title: 'Parent', goalId: goal.id }), directory: () => directory };
}

async function completedStructuralCheckout({ f, goal, task }) {
  await f.start();
  await until(() => {
    const failed = f.store.list('attempts').find(item => item.goalId === goal.id && item.status === 'failed');
    if (failed) assert.fail(failed.summary);
    const integration = f.store.list('integrations').find(item => item.goalId === goal.id && item.phase === 'failed');
    if (integration) assert.fail(integration.reason);
    const recheck = goalState(f, goal).compositionRecheck;
    if (recheck?.status === 'failed') assert.fail(recheck.reason);
    return goalState(f, goal).status === 'succeeded';
  }, 45000, taskWaitDiagnostics(f, task.id));
  const checkout = path.join(f.root, 'structural-candidate');
  await checkoutComposition(goalState(f, goal).composition, checkout, f.root, f.dataDir, run);
  return checkout;
}

test('child case-only rename preserves the exact spelling and binary bytes in the final Git tree', { skip: process.platform !== 'win32' }, async t => {
  const bytes = Buffer.from([0, 255, 47, 128]);
  const inspect = async directory => {
    const names = await readdir(directory);
    assert(names.includes('name.bin') && !names.includes('Name.bin'));
    assert.deepEqual(await readFile(path.join(directory, 'name.bin')), bytes);
  };
  const scenario = await structuralDecomposition(t, {
    baseline: async directory => writeFile(path.join(directory, 'Name.bin'), bytes),
    update: async directory => git(directory, 'mv', '-f', 'Name.bin', 'name.bin'),
    artifact: 'name.bin', inspect,
  });
  const checkout = await completedStructuralCheckout(scenario);
  await inspect(checkout);
  const files = (await git(checkout, 'ls-tree', '-r', '--name-only', '-z', 'HEAD')).split('\0');
  assert(files.includes('name.bin') && !files.includes('Name.bin'));
  assert((await readdir(scenario.f.source)).includes('Name.bin'));
});

test('child delivery supports both directions of file and directory replacement', async t => {
  for (const toDirectory of [true, false]) {
    const baseline = async directory => {
      const module = path.join(directory, 'module');
      if (toDirectory) return writeFile(module, 'previous file');
      await mkdir(module);
      await writeFile(path.join(module, 'old.cjs'), 'previous nested file');
    };
    const artifact = toDirectory ? 'module/index.cjs' : 'module';
    const update = async directory => {
      const module = path.join(directory, 'module');
      if (toDirectory) { await unlink(module); await mkdir(module); }
      else { await unlink(path.join(module, 'old.cjs')); await rmdir(module); }
      await writeFile(path.join(directory, artifact), 'new input bytes');
    };
    const inspect = async directory => assert.equal(await readFile(path.join(directory, artifact), 'utf8'), 'new input bytes');
    const scenario = await structuralDecomposition(t, { baseline, update, artifact, inspect });
    const checkout = await completedStructuralCheckout(scenario);
    await inspect(checkout);
    const files = (await git(checkout, 'ls-tree', '-r', '--name-only', '-z', 'HEAD')).split('\0');
    assert(files.includes(artifact));
    assert(!files.includes(toDirectory ? 'module' : 'module/old.cjs'));
  }
});

test('a dependency write failure rolls the parent back to its original file and index', async t => {
  const scenario = await structuralDecomposition(t, {
    baseline: directory => writeFile(path.join(directory, 'module'), 'original parent module'),
    update: async directory => {
      const module = path.join(directory, 'module');
      await unlink(module);
      await mkdir(module);
      await writeFile(path.join(module, 'index.cjs'), 'new child module');
    },
    artifact: 'module/index.cjs', inspect: () => assert.fail('the failed overlay must not dispatch a parent attempt'),
  });
  const actualLink = fs.link;
  let injected = false;
  const fault = t.mock.method(fs, 'link', async (from, to) => {
    if (scenario.directory() && to === path.join(scenario.directory(), 'module', 'index.cjs')) {
      injected = true;
      throw Object.assign(new Error('simulated child publication failure'), { code: 'COMPOSITE_DRAFT_CONFLICT' });
    }
    return actualLink(from, to);
  });
  try {
    const { f, task } = scenario;
    await f.start();
    await until(() => f.store.list('attempts').some(attempt => attempt.taskId === task.id && attempt.preflightOnly && attempt.status === 'failed'),
      45000, taskWaitDiagnostics(f, task.id));
    assert.equal(injected, true);
    assert.equal(await readFile(path.join(scenario.directory(), 'module'), 'utf8'), 'original parent module');
    assert.equal(await readFile(path.join(scenario.directory(), 'draft.txt'), 'utf8'), 'retained parent draft');
    assert.equal(await git(scenario.directory(), 'show', ':staged.txt'), 'retained parent index');
  } finally { fault.mock.restore(); }
});

test('a contract replacement reads its approved historical input without selecting retired outputs', async t => {
  const { f, goal } = await setup(t, async input => {
    const task = input.task;
    if (task.title === 'Old upstream') {
      await writeFile(fromWorkspace(input, 'upstream.txt'), 'old upstream');
      await writeFile(fromWorkspace(input, 'keep.txt'), 'retained from the old upstream');
      return { outcome: 'completed', artifacts: [{ path: 'upstream.txt' }] };
    }
    if (task.title === 'Old downstream') {
      assert.equal(await readFile(fromWorkspace(input, 'upstream.txt'), 'utf8'), 'old upstream');
      await writeFile(fromWorkspace(input, 'downstream.txt'), 'old downstream');
      return { outcome: 'completed', artifacts: [{ path: 'downstream.txt' }] };
    }
    if (task.title === 'Replace upstream') {
      assert.equal(await readFile(fromWorkspace(input, 'upstream.txt'), 'utf8'), 'old upstream');
      await writeFile(fromWorkspace(input, 'upstream.txt'), 'new upstream');
      return { outcome: 'completed', artifacts: [{ path: 'upstream.txt' }] };
    }
    assert.equal(await readFile(fromWorkspace(input, 'upstream.txt'), 'utf8'), 'new upstream');
    assert.equal(await readFile(fromWorkspace(input, 'downstream.txt'), 'utf8'), 'old downstream');
    await writeFile(fromWorkspace(input, 'downstream.txt'), 'new downstream');
    return { outcome: 'completed', artifacts: [{ path: 'downstream.txt' }] };
  }, 'process.exitCode=0');
  const oldA = f.task({ title: 'Old upstream', goalId: goal.id });
  const oldB = f.task({ title: 'Old downstream', goalId: goal.id, dependencies: [oldA.id] });
  await f.start();
  await until(() => goalState(f, goal).status === 'succeeded', 45000);
  f.command('company.pause', { afterCurrent: true });
  const edited = f.command('goal.edit', { id: goal.id, patch: { acceptance: 'Use the revised upstream and downstream' } });
  const newA = f.task({ title: 'Replace upstream', goalId: goal.id, dependencies: [oldA.id] });
  const newB = f.task({ title: 'Replace downstream', goalId: goal.id, dependencies: [oldB.id, newA.id] });
  f.engine.refreshReadiness();
  const coordinator = f.store.require('tasks', edited.contractChange.coordinationTaskId);
  const attempt = f.engine.claim(coordinator, f.store.require('agents', coordinator.agentId));
  await f.engine.accept(attempt, { outcome: 'coordinated', contractAssessment: { reason: 'Replace separately', reuse: [], followUps: [
    { taskId: oldA.id, followUp: newA.id }, { taskId: oldB.id, followUp: newB.id },
  ] } }, new AbortController().signal);
  f.store.put('attempts', { ...f.store.require('attempts', attempt.id), cleanupPending: false });
  f.command('company.resume');
  await until(() => {
    const failed = f.store.list('attempts').find(item => [newA.id, newB.id].includes(item.taskId) && item.status === 'failed');
    if (failed) assert.fail(failed.summary);
    return goalState(f, goal).status === 'succeeded';
  }, 45000, () => ({ recheck: goalState(f, goal).compositionRecheck, downstream: taskWaitDiagnostics(f, newB.id)() }));
  const candidate = goalState(f, goal).composition;
  assert.deepEqual(candidate.inputs.map(input => input.taskId), [newA.id, newB.id]);
  const checkout = path.join(f.root, 'replacement-candidate');
  await checkoutComposition(candidate, checkout, f.root, f.dataDir, run);
  assert.equal(await readFile(path.join(checkout, 'upstream.txt'), 'utf8'), 'new upstream');
  assert.equal(await readFile(path.join(checkout, 'downstream.txt'), 'utf8'), 'new downstream');
  assert.equal(await readFile(path.join(checkout, 'keep.txt'), 'utf8'), 'retained from the old upstream');
});
