import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, gitProject, taskWaitDiagnostics, until } from './helpers.js';
import { integrationWaitDiagnostics, traceContainedFixture } from './fixture-trace.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { checkoutGitBundle, verifiedGitBundle } from '../src/runtime/git-delivery.js';
import { run } from '../src/runtime/workspaces.js';
import { Store } from '../src/core/store.js';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { prunePlan } from '../scripts/prune-data.mjs';

const windows = { skip: process.platform !== 'win32' };
const binary = Buffer.from([0, 10, 13, 128, 255, 0]);
const newReadme = Buffer.from('delivery\r\nwith original line endings\r\n');
const stableReadme = Buffer.from('materialized by Git\r\n');

async function git(args, cwd) {
  const result = await run('git', args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function age(directory) {
  const then = new Date(Date.now() - 3 * 86400000);
  async function walk(filename) {
    if ((await lstat(filename)).isDirectory()) {
      for (const name of await readdir(filename)) await walk(path.join(filename, name));
    }
    await utimes(filename, then, then);
  }
  await walk(directory);
}

test('non-merged Git delivery reconstructs exact bytes after ACMS backup and protects unique work', windows, async t => {
  const f = await fixture(t, async input => {
    if (input.task.kind === 'review') {
      assert.deepEqual(await readFile(path.join(input.task.workspace.path, 'source-only.bin')), binary);
      return defaultSimulation(input);
    }
    const workspace = input.task.workspace.path;
    await writeFile(path.join(workspace, 'README.md'), newReadme);
    await unlink(path.join(workspace, 'remove.txt'));
    await writeFile(path.join(workspace, 'source-only.bin'), binary);
    await writeFile(path.join(workspace, 'declared.log'), 'declared but Git ignored');
    const output = await defaultSimulation(input);
    output.artifacts.push({ path: './declared.log', title: 'Ignored declared artifact' });
    return output;
  });
  await writeFile(path.join(f.source, '.gitattributes'), '*.md text eol=lf\nstable.txt text eol=crlf\n');
  await writeFile(path.join(f.source, '.gitignore'), '*.log\n');
  await writeFile(path.join(f.source, 'remove.txt'), 'old file');
  await writeFile(path.join(f.source, 'stable.txt'), 'materialized by Git\n');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  await f.start();
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 30000, taskWaitDiagnostics(f, task.id));
  await f.engine.stop();
  const saved = f.store.require('tasks', task.id);
  const delivery = await verifiedGitBundle(saved, f.dataDir);
  assert(delivery?.worktreeHash);
  assert.equal(delivery.baseCommit, base);
  assert.equal(delivery.artifactHash, saved.artifactHash);
  assert.equal(saved.integration.status, 'available');
  assert.deepEqual(await readFile(path.join(saved.workspace.path, 'stable.txt')), stableReadme);
  assert(!saved.changeSet.some(file => file.path === 'stable.txt'));
  assert.equal(await git(['rev-parse', 'HEAD'], f.source), base);
  assert.equal(await git(['status', '--porcelain', '--', '.', ':(exclude).acms'], f.source), '');
  assert.equal(await git(['rev-parse', saved.workspace.branch], f.source), base, 'the workspace branch is not the delivery version');
  await assert.rejects(readFile(path.join(f.source, 'source-only.bin')), { code: 'ENOENT' });

  const relative = 'workspaces/' + task.id;
  const plan = () => prunePlan({ dataDir: f.dataDir, days: 1 });
  const protectedReason = async () => (await plan()).protected.find(item => item.path === relative)?.reason;
  await age(saved.workspace.path);
  assert((await plan()).candidates.some(item => item.path === relative));
  const unaccepted = path.join(saved.workspace.path, 'unique.log');
  await writeFile(unaccepted, 'local work which has not been delivered');
  await age(saved.workspace.path);
  assert.match(await protectedReason(), /当前内容或索引无法核实/);
  await unlink(unaccepted);
  await age(saved.workspace.path);
  const original = await readFile(delivery.path);
  await writeFile(delivery.path, Buffer.alloc(delivery.bytes, 0));
  assert.match(await protectedReason(), /缺少覆盖完整交付/);
  await writeFile(delivery.path, original);

  const legacyPath = path.join(f.dataDir, 'workspaces', 'task_legacy');
  await mkdir(legacyPath);
  await writeFile(path.join(legacyPath, 'source.js'), 'only the old worktree contains this file');
  f.store.put('tasks', { ...saved, id: 'task_legacy', workspace: { ...saved.workspace, path: legacyPath },
    integration: { status: 'available', path: legacyPath } });
  await age(legacyPath);
  assert((await plan()).protected.some(item => item.path === 'workspaces/task_legacy' && item.reason.includes('缺少覆盖完整交付')));

  const backup = path.join(f.root, 'backup');
  const planBackupResult = await planBackup({ dataDir: f.dataDir, out: backup });
  assert(planBackupResult.files.some(file => file.path === 'deliveries/' + path.basename(delivery.path)));
  assert(planBackupResult.warnings.some(warning => warning.includes('deliveries/')));
  await applyBackup(planBackupResult);
  const restored = path.join(f.root, 'restored');
  await restoreBackup({ backup, target: restored });
  const restoredStore = new Store(path.join(restored, 'company.db'));
  const restoredTask = restoredStore.require('tasks', task.id);
  restoredStore.close();
  const portable = await verifiedGitBundle(restoredTask, restored);
  assert.equal(portable.path, path.join(restored, 'deliveries', path.basename(delivery.path)));
  assert.equal(portable.sha256, delivery.sha256);
  const parked = path.join(f.root, 'source-temporarily-away');
  await rename(f.source, parked);
  try {
    const reconstructed = path.join(f.root, 'reconstructed');
    await checkoutGitBundle(portable, reconstructed, f.root, git);
    assert.equal(await git(['rev-parse', 'HEAD'], reconstructed), portable.commit);
    assert.deepEqual(await readFile(path.join(reconstructed, 'README.md')), newReadme);
    assert.deepEqual(await readFile(path.join(reconstructed, 'stable.txt')), stableReadme);
    assert.deepEqual(await readFile(path.join(reconstructed, 'source-only.bin')), binary);
    assert.equal(await readFile(path.join(reconstructed, 'declared.log'), 'utf8'), 'declared but Git ignored');
    await assert.rejects(readFile(path.join(reconstructed, 'remove.txt')), { code: 'ENOENT' });
  } finally {
    await rename(parked, f.source);
  }

  const review = f.command('review.request', { id: task.id });
  assert.match(await protectedReason(), /未完成的依赖或审查/);
  await rename(saved.workspace.path, path.join(f.root, 'worktree-temporarily-away'));
  await f.start();
  await until(() => f.store.require('tasks', review.id).status === 'succeeded', 20000, taskWaitDiagnostics(f, review.id));
  assert.equal(f.store.require('tasks', review.id).passed, true);
});

test('restart after publishing a Git bundle reuses the version and captures both paths of a staged rename', windows, async t => {
  const f = await fixture(t, async input => {
    await git(['mv', 'rename-old.txt', 'rename-new.txt'], input.task.workspace.path);
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, 'rename-old.txt'), 'rename with unchanged bytes\n');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  const trace = traceContainedFixture(t, f.workspaces);
  const diagnostics = integrationWaitDiagnostics(f, task.goalId, trace);
  const integrate = f.workspaces.integrate.bind(f.workspaces);
  let published;
  f.workspaces.integrate = async (...args) => {
    const result = await integrate(...args);
    if (!published) await trace.observe('bundle-published-before-commit', () => {
      published = result.delivery;
      f.store.releaseLease(f.engine.owner);
    }, task.id);
    return result;
  };
  await trace.observe('engine-start', f.start);
  await until(() => published, 20000, diagnostics);
  await f.engine.integration;
  assert.equal(f.store.require('tasks', task.id).status, 'integrating');
  await trace.observe('engine-stop', () => f.engine.stop());
  await trace.observe('engine-start-recovery', f.start);
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 20000, diagnostics);
  const saved = f.store.require('tasks', task.id);
  assert.deepEqual(saved.integration.delivery, published);
  assert.deepEqual(await readdir(path.dirname(published.path)), [path.basename(published.path)]);
  assert.equal(f.adapter.calls.filter(call => call.task.id === task.id).length, 1);
  assert.equal(await git(['rev-parse', 'HEAD'], f.source), base);
  const rebuilt = path.join(f.root, 'rebuilt');
  await checkoutGitBundle(published, rebuilt, f.root, git);
  await assert.rejects(readFile(path.join(rebuilt, 'rename-old.txt')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(rebuilt, 'rename-new.txt'), 'utf8'), /rename with unchanged bytes/);
  await age(saved.workspace.path);
  assert((await prunePlan({ dataDir: f.dataDir, days: 1 })).protected.some(item => item.path === 'workspaces/' + task.id &&
    item.reason.includes('索引无法核实')));
});

test('retention requires proof of the reconstructed tree even when the Git index hides local changes', windows, async t => {
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    await git(['update-index', '--assume-unchanged', 'tracked.txt'], cwd);
    await writeFile(path.join(cwd, 'tracked.txt'), 'unique unsaved source\n');
    await writeFile(path.join(cwd, 'private.log'), 'an ignored file outside the delivery');
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, '.gitignore'), '*.log\n');
  await writeFile(path.join(f.source, 'tracked.txt'), 'committed starter\n');
  await gitProject(f);
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  await f.start();
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 30000, taskWaitDiagnostics(f, task.id));
  const saved = f.store.require('tasks', task.id);
  assert(!saved.changeSet.some(file => file.path === 'tracked.txt'));
  assert(saved.gitDeliveryInputHash);
  const delivery = await verifiedGitBundle(saved, f.dataDir);
  assert(delivery);
  assert.equal(delivery.worktreeHash, null);
  const rebuilt = path.join(f.root, 'rebuilt');
  await checkoutGitBundle(delivery, rebuilt, f.root, git);
  assert.equal(await readFile(path.join(rebuilt, 'tracked.txt'), 'utf8'), 'unique unsaved source\n');
  await assert.rejects(readFile(path.join(rebuilt, 'private.log')), { code: 'ENOENT' });
  await age(saved.workspace.path);
  const plan = await prunePlan({ dataDir: f.dataDir, days: 1 });
  assert(plan.protected.some(item => item.path === 'workspaces/' + task.id && item.reason.includes('缺少覆盖完整交付')));
  assert(!plan.candidates.some(item => item.path === 'workspaces/' + task.id));
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`Git delivery preserves a deletion concealed by ${flag}`, windows, async t => {
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    await git(['update-index', flag, 'tracked.txt'], cwd);
    await unlink(path.join(cwd, 'tracked.txt'));
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, 'tracked.txt'), 'delete in the complete worktree\n');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  const trace = traceContainedFixture(t, f.workspaces);
  await f.start();
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 30000,
    integrationWaitDiagnostics(f, task.goalId, trace));
  const saved = f.store.require('tasks', task.id);
  assert(!saved.changeSet.some(file => file.path === 'tracked.txt'));
  const delivery = await verifiedGitBundle(saved, f.dataDir);
  assert(delivery?.worktreeHash);
  const rebuilt = path.join(f.root, 'rebuilt');
  await checkoutGitBundle(delivery, rebuilt, f.root, git);
  await assert.rejects(readFile(path.join(rebuilt, 'tracked.txt')), { code: 'ENOENT' });
  assert.equal(await git(['rev-parse', 'HEAD'], f.source), base);
  await age(saved.workspace.path);
  assert((await prunePlan({ dataDir: f.dataDir, days: 1 })).candidates.some(item => item.path === 'workspaces/' + task.id));
});

test('Git delivery explicitly waits for a complete checkout if sparse checkout omits a baseline file', windows, async t => {
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    await git(['sparse-checkout', 'set', '--no-cone', '/README.md'], cwd);
    await assert.rejects(readFile(path.join(cwd, 'tracked.txt')), { code: 'ENOENT' });
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, 'tracked.txt'), 'intentionally omitted by sparse checkout\n');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  await f.start();
  await until(() => f.store.list('integrations').some(record => record.taskId === task.id && record.phase === 'failed'), 20000,
    taskWaitDiagnostics(f, task.id));
  const saved = f.store.require('tasks', task.id);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.integration?.delivery, undefined);
  assert.match(f.store.list('integrations').find(record => record.taskId === task.id).reason, /稀疏检出.*完整检出后重新交付/);
  assert.equal(await git(['rev-parse', 'HEAD'], f.source), base);
});

test('Git delivery keeps distinct paths with leading spaces in tracked and untracked results', windows, async t => {
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    await writeFile(path.join(cwd, ' created.txt'), 'new path begins with a space\n');
    await writeFile(path.join(cwd, ' edited.txt'), 'existing path begins with a space\n');
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, 'created.txt'), 'ordinary path already in the base\n');
  await writeFile(path.join(f.source, ' edited.txt'), 'old bytes at the space-prefixed path\n');
  await gitProject(f);
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  await f.start();
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 30000, taskWaitDiagnostics(f, task.id));
  const saved = f.store.require('tasks', task.id);
  assert.deepEqual(saved.changeSet.map(file => file.path), [' created.txt', ' edited.txt', 'deliverable.md']);
  const delivery = await verifiedGitBundle(saved, f.dataDir);
  assert(delivery?.worktreeHash);
  const rebuilt = path.join(f.root, 'rebuilt');
  await checkoutGitBundle(delivery, rebuilt, f.root, git);
  assert.deepEqual(await readFile(path.join(rebuilt, 'created.txt')), await readFile(path.join(saved.workspace.path, 'created.txt')));
  assert.equal(await readFile(path.join(rebuilt, ' created.txt'), 'utf8'), 'new path begins with a space\n');
  assert.equal(await readFile(path.join(rebuilt, ' edited.txt'), 'utf8'), 'existing path begins with a space\n');
});

test('Git delivery preserves the exact tree name of a Windows case-only rename', windows, async t => {
  const f = await fixture(t, async input => {
    await git(['mv', '-f', 'tracked.txt', 'TRACKED.TXT'], input.task.workspace.path);
    return defaultSimulation(input);
  });
  await writeFile(path.join(f.source, 'tracked.txt'), 'same content at the new spelling\n');
  const base = (await gitProject(f)).trim();
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  await f.start();
  await until(() => f.store.require('goals', task.goalId).status === 'succeeded', 30000, taskWaitDiagnostics(f, task.id));
  const saved = f.store.require('tasks', task.id);
  assert.deepEqual(saved.changeSet.find(file => file.path === 'tracked.txt'), { path: 'tracked.txt', deleted: true });
  assert(saved.changeSet.find(file => file.path === 'TRACKED.TXT')?.hash);
  const delivery = await verifiedGitBundle(saved, f.dataDir);
  assert(delivery?.worktreeHash);
  const rebuilt = path.join(f.root, 'rebuilt');
  await checkoutGitBundle(delivery, rebuilt, f.root, git);
  const filenames = (await git(['ls-tree', '-r', '--name-only', 'HEAD'], rebuilt)).split(/\r?\n/);
  assert(filenames.includes('TRACKED.TXT'));
  assert(!filenames.includes('tracked.txt'));
  assert.deepEqual(await readFile(path.join(rebuilt, 'TRACKED.TXT')), await readFile(path.join(saved.workspace.path, 'TRACKED.TXT')));
  assert.equal(await git(['rev-parse', 'HEAD'], f.source), base);
});
