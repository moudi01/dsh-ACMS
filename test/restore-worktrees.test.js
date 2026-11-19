import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
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

async function makeFixture(t, { candidate = false, receipt = true, dataAlias, linkWorkspace = false } = {}) {
  const f = await fixture(t);
  if (dataAlias) {
    const alias = await dataAlias(f);
    if (!alias) return null;
    f.workspaces.dataDir = alias;
  }
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
  if (linkWorkspace) {
    const parked = path.join(f.root, 'linked-workspace');
    await rename(workspace.path, parked);
    await fs.symlink(parked, workspace.path, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const dataDir = dataAlias ? await fs.realpath(f.dataDir) : f.dataDir;
  await applyBackup(await planBackup({ dataDir, out: backup }));
  return { f, head, task, workspace, candidateId, candidates, backup, target };
}

async function backlink(workspace) {
  const pointer = (await readFile(path.join(workspace, '.git'), 'utf8')).trim();
  assert(pointer.startsWith('gitdir: '));
  return path.normalize((await readFile(path.join(pointer.slice(8), 'gitdir'), 'utf8')).trim());
}

const canonicalPointer = async workspace => path.join(await fs.realpath(workspace), '.git');
const assertReady = result => assert.equal(result.startable, true, JSON.stringify(result.worktrees));

test('retained original worktrees prevent host startup until the same target safely resumes', async t => {
  const { f, head, task, workspace, candidateId, candidates: [candidate], backup, target } = await makeFixture(t, { candidate: true });
  const oldWorkspacePointer = await backlink(workspace.path);
  const oldCandidatePointer = await backlink(candidate);
  const status = await git(workspace.path, 'status', '--porcelain', '--', 'staged.txt', 'local.bin');
  const sourceStatus = await git(f.source, 'status', '--porcelain', '--', '.', ':(exclude).acms');
  const firstCommand = await run('node', [restoreScript, '--backup', backup, '--target', target, '--json'], f.root);
  assert.equal(firstCommand.code, 2, firstCommand.stderr || firstCommand.stdout);
  const first = JSON.parse(firstCommand.stdout);
  assert.equal(first.startable, false);
  assert.equal(first.worktrees.issues.length, 2);
  assert(first.worktrees.issues.every(item => item.reason.includes('原工作副本仍在')), JSON.stringify(first.worktrees));
  assert.deepEqual(await backlink(path.join(target, 'workspaces', task.id)), oldWorkspacePointer);
  assert.deepEqual(await backlink(path.join(target, 'integration', candidateId)), oldCandidatePointer);
  assert.match(await readFile(path.join(target, 'REBUILD.md'), 'utf8'), /--resume-worktrees/);
  await assert.rejects(apply({}, { dataDir: target }), { code: 'RESTORE_WORKTREES_PENDING' });
  assert.equal((await verifyBackup(target)).ok, true, 'blocked host startup must leave the verified copy resumable');

  const retained = path.join(f.root, 'retained-old-workspace');
  const originalPointer = await readFile(path.join(workspace.path, '.git'));
  const originalIndex = await readFile(await git(workspace.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index'));
  await rename(workspace.path, retained);
  const partial = await restoreBackup({ target, resumeWorktrees: true });
  assert.equal(partial.startable, false);
  assert.equal(await backlink(path.join(target, 'workspaces', task.id)), oldWorkspacePointer, 'a blocked plan does not move other registrations');
  const retainedCandidate = path.join(f.root, 'retained-old-candidate');
  await rename(candidate, retainedCandidate);
  const readyCommand = await run('node', [restoreScript, '--target', target, '--resume-worktrees', '--json'], f.root);
  assert.equal(readyCommand.code, 0, readyCommand.stderr || readyCommand.stdout);
  const ready = JSON.parse(readyCommand.stdout);
  assertReady(ready);
  const restored = path.join(target, 'workspaces', task.id);
  const restoredCandidate = path.join(target, 'integration', candidateId);
  assert.equal(await backlink(restored), await canonicalPointer(restored));
  assert.equal(await backlink(restoredCandidate), await canonicalPointer(restoredCandidate));
  assert.equal(await git(restored, 'symbolic-ref', '--short', 'HEAD'), workspace.branch);
  assert.equal(await git(restoredCandidate, 'rev-parse', 'HEAD'), head);
  const restoredIndex = await git(restored, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  assert.deepEqual(await readFile(restoredIndex), originalIndex);
  assert.equal(await git(restored, 'status', '--porcelain', '--', 'staged.txt', 'local.bin'), status);
  assert.equal(await git(restored, 'show', ':staged.txt'), 'staged version');
  assert.equal(await readFile(path.join(restored, 'staged.txt'), 'utf8'), 'unstaged version\n');
  assert.deepEqual(await readFile(path.join(restored, 'local.bin')), Buffer.from([0, 255, 16]));
  assert.equal(await readFile(path.join(retained, 'staged.txt'), 'utf8'), 'unstaged version\n');
  assert.deepEqual(await readFile(path.join(retained, '.git')), originalPointer);
  assert.notEqual((await run('git', ['add', 'staged.txt'], retained)).code, 0, 'the parked copy cannot write the restored index');
  assert.notEqual((await run('git', ['rev-parse', '--show-toplevel'], retainedCandidate)).code, 0);
  assert.equal(await git(restored, 'show', ':staged.txt'), 'staged version');
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
  assertReady(await restoreBackup({ target, resumeWorktrees: true }));
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

test('publishing the final manifest can fail without opening the startup gate or blocking resume', async t => {
  const { f, task, workspace, backup, target } = await makeFixture(t);
  assert.equal((await restoreBackup({ backup, target })).startable, false);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  const originalWrite = fs.writeFile;
  const fail = t.mock.method(fs, 'writeFile', async (filename, ...args) => {
    if (path.basename(filename).startsWith('backup-manifest.json.acms-')) throw new Error('injected final manifest write failure');
    return originalWrite(filename, ...args);
  });
  try {
    await assert.rejects(restoreBackup({ target, resumeWorktrees: true }), /injected final manifest write failure/);
  } finally { fail.mock.restore(); }

  const restored = path.join(target, 'workspaces', task.id);
  assert.equal(await backlink(restored), await canonicalPointer(restored));
  await assert.rejects(apply({}, { dataDir: target }), { code: 'RESTORE_WORKTREES_PENDING' });
  assert.match(await readFile(path.join(target, 'REBUILD.md'), 'utf8'), /--resume-worktrees/);
  assert.equal((await verifyBackup(target)).ok, true, 'the pending manifest accounts for a migrated pointer');
  assertReady(await restoreBackup({ target, resumeWorktrees: true }));
  assert.equal((await verifyBackup(target)).ok, true);
  assert.equal((await verifyBackup(backup)).ok, true);
});

test('a missing staged blob keeps restore pending until it can actually be read', async t => {
  const { f, task, workspace, backup, target } = await makeFixture(t);
  const object = await git(workspace.path, 'rev-parse', ':staged.txt');
  const common = await git(f.source, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const blob = path.join(common, 'objects', object.slice(0, 2), object.slice(2));
  const parkedBlob = path.join(f.root, 'staged-blob');
  await rename(blob, parkedBlob);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));

  const result = await restoreBackup({ backup, target });
  assert.equal(result.startable, false);
  assert.match(result.worktrees.issues[0].reason, new RegExp(object));
  await assert.rejects(apply({}, { dataDir: target }), { code: 'RESTORE_WORKTREES_PENDING' });
  assert.equal((await verifyBackup(target)).ok, true);
  await rename(parkedBlob, blob);
  assertReady(await restoreBackup({ target, resumeWorktrees: true }));
  assert.equal(await git(path.join(target, 'workspaces', task.id), 'show', ':staged.txt'), 'staged version');
});

test('a second registry write failure rolls back both administrative paths and pointers', async t => {
  const { f, task, workspace, candidateId, candidates: [candidate], backup, target } = await makeFixture(t, { candidate: true });
  assert.equal((await restoreBackup({ backup, target })).startable, false);
  const oldWorkspacePointer = await backlink(workspace.path);
  const oldCandidatePointer = await backlink(candidate);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  await rename(candidate, path.join(f.root, 'old-candidate'));
  let writes = 0;
  const fail = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === 'gitdir' && ++writes === 2) throw new Error('injected second backlink write failure');
    return rename(from, to);
  });
  try {
    const result = await restoreBackup({ target, resumeWorktrees: true });
    assert.equal(result.startable, false);
    assert.match(result.worktrees.issues[0].reason, /injected second backlink write failure/);
  } finally { fail.mock.restore(); }
  assert.equal(await backlink(path.join(target, 'workspaces', task.id)), oldWorkspacePointer);
  assert.equal(await backlink(path.join(target, 'integration', candidateId)), oldCandidatePointer);
  assert.equal((await verifyBackup(target)).ok, true);
  assertReady(await restoreBackup({ target, resumeWorktrees: true }));
});

test('trusted data-root aliases are canonicalized and the same target can resume through another spelling', async t => {
  const { f, task, workspace, backup, target } = await makeFixture(t, { dataAlias: async fixture => {
    const alias = path.join(fixture.root, 'data-alias');
    await fs.symlink(fixture.dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return alias;
  } });
  const initial = await restoreBackup({ backup, target });
  assert.match(initial.worktrees.issues[0].reason, /原工作副本仍在/);
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  const alias = path.join(f.root, 'restored-alias');
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assertReady(await restoreBackup({ target: alias, resumeWorktrees: true }));
  const restored = path.join(target, 'workspaces', task.id);
  assert.equal(await backlink(restored), await canonicalPointer(restored));
  assert.equal(await git(restored, 'show', ':staged.txt'), 'staged version');
});

test('worktree directory links below a trusted data root are excluded and prevent startup', async t => {
  const { task, backup, target } = await makeFixture(t, { linkWorkspace: true });
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
  assert(manifest.excluded.some(entry => entry.path === 'workspaces/' + task.id && entry.reason.includes('链接')));
  const restored = await restoreBackup({ backup, target });
  assert.equal(restored.startable, false);
  assert.equal(restored.worktrees.issues[0].path, 'workspaces/' + task.id);
  assert.match(restored.worktrees.issues[0].reason, /Git 指针/);
});

test('restore accepts a genuine Windows 8.3 data path when short names are available', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await makeFixture(t, { dataAlias: async f => {
    const probe = await run('cmd.exe', ['/d', '/c', 'for %I in (.) do @echo %~sI'], f.root);
    assert.equal(probe.code, 0, probe.stderr || probe.stdout);
    const canonical = await fs.realpath(f.root);
    const short = [f.root, probe.stdout.trim()].find(value => /[\\/][^\\/]*~\d+(?:[\\/]|$)/i.test(value) && path.relative(value, canonical) !== '');
    if (!short) return null;
    assert.equal(path.relative(await fs.realpath(short), canonical), '', `short=${short}`);
    return path.join(short, 'data');
  } });
  if (!fixture) { t.skip('Windows volume does not expose a distinct 8.3 short name for the test directory'); return; }
  const { f, task, workspace, backup } = fixture;
  const target = path.join(path.dirname(f.workspaces.dataDir), 'restored');
  const initial = await restoreBackup({ backup, target });
  assert.match(initial.worktrees.issues[0].reason, /原工作副本仍在/, JSON.stringify(initial.worktrees));
  await rename(workspace.path, path.join(f.root, 'old-worktree'));
  assertReady(await restoreBackup({ target, resumeWorktrees: true }));
  const restored = path.join(target, 'workspaces', task.id);
  assert.equal(await backlink(restored), await canonicalPointer(restored));
  assert.equal(await git(restored, 'show', ':staged.txt'), 'staged version');
});
