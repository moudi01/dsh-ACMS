import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, gitProject } from './helpers.js';
import { run, WorkspaceManager } from '../src/runtime/workspaces.js';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { Engine } from '../src/runtime/engine.js';
import { apply } from '../src/host/index.js';
import { applyBackup, planBackup, verifyBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';

const restoreScript = fileURLToPath(new URL('../scripts/restore-backup.mjs', import.meta.url));

async function git(cwd, ...args) {
  const result = await run('git', args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.replace(/\r?\n$/, '');
}

async function makeFixture(t, { candidate = false, receipt = true } = {}) {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'staged.txt'), 'original\n');
  const head = (await gitProject(f)).trim();
  const task = f.task();
  const workspace = await f.workspaces.prepare(task, {});
  await writeFile(path.join(workspace.path, 'staged.txt'), 'staged version\n');
  await git(workspace.path, 'add', 'staged.txt');
  await writeFile(path.join(workspace.path, 'staged.txt'), 'unstaged version\n');
  await writeFile(path.join(workspace.path, 'local.bin'), Buffer.from([0, 255, 16]));
  const candidateId = 'integration_restore_fixture';
  f.command('company.pause');
  f.store.put('tasks', { ...task, workspace, status: candidate ? 'integrating' : 'paused',
    ...(candidate ? { activeIntegrationId: candidateId, artifactHash: 'accepted-artifact' } : {}) });
  const candidates = [];
  if (candidate) {
    const directory = path.join(f.dataDir, 'integration', candidateId);
    await mkdir(path.dirname(directory), { recursive: true });
    await git(f.source, 'worktree', 'add', '--detach', directory, head);
    f.store.put('integrations', { id: candidateId, phase: 'checking', candidate: directory, taskId: task.id, goalId: task.goalId,
      projectId: task.projectId, generation: task.generation, artifactHash: 'accepted-artifact',
      targetRoot: f.source, targetRef: 'refs/heads/main', commandId: 'command_restore_fixture' });
    if (receipt) {
      const receipts = path.join(f.dataDir, 'integration-receipts');
      await mkdir(receipts);
      await writeFile(path.join(receipts, 'command_restore_fixture.json'), JSON.stringify({ confirmed: true, exitCode: 0 }));
    }
    candidates.push(directory);
  }
  const backup = path.join(f.root, 'backup');
  const target = path.join(f.root, 'restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  return { f, head, task, workspace, candidateId, candidates, backup, target };
}

async function backlink(workspace) {
  const pointer = (await readFile(path.join(workspace, '.git'), 'utf8')).trim();
  assert(pointer.startsWith('gitdir: '));
  return path.normalize((await readFile(path.join(pointer.slice(8), 'gitdir'), 'utf8')).trim());
}

test('retained original worktrees prevent host startup until the same target safely resumes', async t => {
  const { f, head, task, workspace, candidateId, candidates: [candidate], backup, target } = await makeFixture(t, { candidate: true });
  const oldWorkspacePointer = await backlink(workspace.path);
  const oldCandidatePointer = await backlink(candidate);
  const status = await git(workspace.path, 'status', '--porcelain', '--', 'staged.txt', 'local.bin');
  const sourceStatus = await git(f.source, 'status', '--porcelain', '--', '.', ':(exclude).acms');
  const firstCommand = await run('node', [restoreScript, '--backup', backup, '--target', target, '--json'], f.root);
  assert.equal(firstCommand.code, 2, firstCommand.stderr);
  const first = JSON.parse(firstCommand.stdout);
  assert.equal(first.startable, false);
  assert.equal(first.worktrees.issues.length, 2);
  assert(first.worktrees.issues.every(item => item.reason.includes('原工作副本仍在')));
  assert.deepEqual(await backlink(path.join(target, 'workspaces', task.id)), oldWorkspacePointer);
  assert.deepEqual(await backlink(path.join(target, 'integration', candidateId)), oldCandidatePointer);
  assert.match(await readFile(path.join(target, 'REBUILD.md'), 'utf8'), /--resume-worktrees/);
  await assert.rejects(apply({}, { dataDir: target }), { code: 'RESTORE_WORKTREES_PENDING' });
  assert.equal((await verifyBackup(target)).ok, true, 'blocked host startup must leave the verified copy resumable');

  const retained = path.join(f.root, 'retained-old-workspace');
  await rename(workspace.path, retained);
  const partial = await restoreBackup({ target, resumeWorktrees: true });
  assert.equal(partial.startable, false);
  assert.equal(await backlink(path.join(target, 'workspaces', task.id)), oldWorkspacePointer, 'a blocked plan does not move other registrations');
  const retainedCandidate = path.join(f.root, 'retained-old-candidate');
  await rename(candidate, retainedCandidate);
  const readyCommand = await run('node', [restoreScript, '--target', target, '--resume-worktrees', '--json'], f.root);
  assert.equal(readyCommand.code, 0, readyCommand.stderr);
  const ready = JSON.parse(readyCommand.stdout);
  assert.equal(ready.startable, true);
  const restored = path.join(target, 'workspaces', task.id);
  const restoredCandidate = path.join(target, 'integration', candidateId);
  assert.equal(await backlink(restored), path.join(restored, '.git'));
  assert.equal(await backlink(restoredCandidate), path.join(restoredCandidate, '.git'));
  assert.equal(await git(restored, 'symbolic-ref', '--short', 'HEAD'), workspace.branch);
  assert.equal(await git(restoredCandidate, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(restored, 'status', '--porcelain', '--', 'staged.txt', 'local.bin'), status);
  assert.equal(await git(restored, 'show', ':staged.txt'), 'staged version');
  assert.equal(await readFile(path.join(restored, 'staged.txt'), 'utf8'), 'unstaged version\n');
  assert.deepEqual(await readFile(path.join(restored, 'local.bin')), Buffer.from([0, 255, 16]));
  assert.equal(await readFile(path.join(retained, 'staged.txt'), 'utf8'), 'unstaged version\n');
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.source, 'status', '--porcelain', '--', '.', ':(exclude).acms'), sourceStatus);
  assert.equal((await verifyBackup(target)).ok, true);
  assert.deepEqual((await restoreBackup({ target, resumeWorktrees: true })).worktrees, ready.worktrees);
  const store = new Store(path.join(target, 'company.db'), { requireWorktreeReady: true });
  const company = new Company(store);
  const engine = new Engine(company, f.adapter, new WorkspaceManager(target, company), { intervalMs: 20 });
  try {
    await engine.start();
    assert.equal(store.require('integrations', candidateId).phase, 'stopped');
    assert.equal(store.require('tasks', task.id).workspace.path, restored);
  } finally {
    await engine.stop();
    store.close();
  }
});

test('missing source Git repository can be restored before continuing the same target', async t => {
  const { f, task, workspace, backup, target } = await makeFixture(t);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  const parked = path.join(f.root, 'old-source');
  await rename(f.source, parked);
  const result = await restoreBackup({ backup, target });
  assert.equal(result.startable, false);
  assert.match(result.worktrees.issues[0].reason, /源 Git 仓库不可用/);
  assert.equal((await verifyBackup(target)).ok, true);
  await rename(parked, f.source);
  assert.equal((await restoreBackup({ target, resumeWorktrees: true })).startable, true);
  assert.equal(await git(path.join(target, 'workspaces', task.id), 'show', ':staged.txt'), 'staged version');
});

test('a changed original index or unverifiable in-flight command prevents Git registration changes', async t => {
  const changed = await makeFixture(t);
  await writeFile(path.join(changed.workspace.path, 'staged.txt'), 'changed after backup\n');
  await git(changed.workspace.path, 'add', 'staged.txt');
  const before = await backlink(changed.workspace.path);
  await rename(changed.workspace.path, path.join(changed.f.root, 'old-worktree'));
  const stale = await restoreBackup({ backup: changed.backup, target: changed.target });
  assert.equal(stale.startable, false);
  assert.match(stale.worktrees.issues[0].reason, /暂存内容与备份证据不一致/);
  assert.equal(await backlink(path.join(changed.target, 'workspaces', changed.task.id)), before);

  const pending = await makeFixture(t, { candidate: true, receipt: false });
  await rename(pending.workspace.path, path.join(pending.f.root, 'old-worktree'));
  await rename(pending.candidates[0], path.join(pending.f.root, 'old-candidate'));
  const unsafe = await restoreBackup({ backup: pending.backup, target: pending.target });
  assert.equal(unsafe.startable, false);
  assert.equal(unsafe.worktrees.issues.length, 2);
  assert(unsafe.worktrees.issues.every(item => item.reason.includes('清理回执无法确认')));
});

test('older backup format remains verifiable and reports missing Git registration evidence', async t => {
  const { f, task, workspace, backup, target } = await makeFixture(t);
  const name = path.join(backup, 'backup-manifest.json');
  const manifest = JSON.parse(await readFile(name, 'utf8'));
  delete manifest.gitWorktrees;
  await writeFile(name, JSON.stringify(manifest));
  assert.equal((await verifyBackup(backup)).ok, true);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  const saved = await restoreBackup({ backup, target });
  assert.equal(saved.ok, true);
  assert.equal(saved.startable, false);
  assert.equal(saved.worktrees.issues[0].path, 'workspaces/' + task.id);
  assert.match(saved.worktrees.issues[0].reason, /旧备份缺少 Git 暂存证据/);
  assert.equal((await verifyBackup(target)).ok, true);
});
