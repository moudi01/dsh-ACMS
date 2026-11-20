import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runContained } from './host-command.js';
import { AcmsError, assert, digest } from '../core/util.js';
import { publishCollaboration, syncCollaboration, verifyCollaboration, isCollaborationPath } from './collaboration.js';
import { deliveryGeneration, taskContractVersion } from '../core/goal-contract.js';
import { checkIdentity, copyProject, inputFingerprint, prepareDependencies, verifyInCopy } from './project-environment.js';
import { includedProjectInput } from './project-inputs.js';
import { ARCHIVE_FORMAT } from './delivery-archive.js';
import { validateDeliveryArchive, validateDeliveryText } from './archive-validation.js';
import { isProseFile } from './text-integrity.js';
import { checkoutGitBundle, gitWorktreeFingerprint, publishGitDelivery, removeTemporary, verifiedGitBundle } from './git-delivery.js';
import { checkoutComposition, composeGitVersions, selectedGitVersions, updateCompositionWorkspace, updateWorkspaceInput } from './git-composition.js';
import { captureCopySnapshot, checkoutCopyComposition, composeCopyVersions, copyCheckInputs, copyContentHash, copyDeliveryFor, selectedCopyVersions, verifiedCopyDelivery } from './copy-composition.js';
import { acceptedGoalComposition, compositionCheckContract, compositionMode, COPY_COMPOSITION, orderedCompositionTasks, usesComposition } from '../core/composite-delivery.js';
import { deliveredWork, goalDeliveryHash } from '../core/goal-contract.js';
import { taskSettledForGoal } from '../core/hierarchy.js';
import { assertGoalOpen } from '../core/goal-control.js';

export function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
const dependencyPath = filename => filename.split(/[/\\]/).some(part => part.toLowerCase() === 'node_modules');
const excludeDependencies = ':(exclude,glob,icase)**/node_modules/**';

async function describesReplacedGitLeaf(root, name) {
  const parts = name.split('/');
  if (!parts.every(part => part && !['.', '..'].includes(part) && !/[\\:]/.test(part))) return false;
  let filename = root;
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    const info = await fs.lstat(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink()) return false;
    if (index === parts.length - 1) return info.isDirectory();
    if (!info.isDirectory()) return info.isFile();
  }
  return false;
}

export async function run(command, args, cwd, { signal, timeout = 120000, maxOutput = 100000, env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command === 'node' ? process.execPath : command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    let terminating;
    const terminate = () => {
      if (terminating || !child.pid) return;
      if (process.platform === 'win32') {
        // PID comes directly from the child we own, never from user input.
        terminating = new Promise(done => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('close', done); killer.once('error', () => { child.kill(); done(); }); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} terminating = Promise.resolve(); }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    signal?.addEventListener('abort', terminate, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', terminate); };
    child.stdout.setEncoding('utf8').on('data', b => { stdout = (stdout + b).slice(-maxOutput); });
    child.stderr.setEncoding('utf8').on('data', b => { stderr = (stderr + b).slice(-maxOutput); });
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', async (code, termination) => { cleanup(); await terminating; resolve({ code, signal: termination, timedOut, stdout, stderr }); });
    if (signal?.aborted) terminate();
  });
}
async function git(args, cwd, options, invoke = run) {
  const result = await invoke('git', args, cwd, options);
  assert(result.code === 0 && !result.timedOut, 'GIT_ERROR', result.stderr || result.stdout || 'Git operation failed', { args });
  if (!args.includes('-z')) return result.stdout.trim();
  assert(!result.stdout || result.stdout.endsWith('\0'), 'GIT_PATH_OUTPUT', 'Git returned an incomplete NUL-delimited list');
  return result.stdout;
}
export class WorkspaceManager {
  constructor(dataDir, company) { this.dataDir = dataDir; this.company = company; }
  async publishProject(project) { await this.validateProject(project); return publishCollaboration(this.company, project); }
  async validateProject(project, invoke = run) {
    const root = await fs.realpath(project.repoRoot); const stat = await fs.stat(root); assert(stat.isDirectory(), 'PROJECT_PATH', 'Project root must be a directory');
    const permitted = this.company.policy().allowedProjectRoots;
    if (permitted.length) {
      let allowed = false; for (const entry of permitted) { try { if (inside(await fs.realpath(entry), root)) allowed = true; } catch {} }
      assert(allowed, 'PROJECT_PATH_DENIED', 'Project lies outside the owner-approved roots');
    }
    assert(!inside(root, this.dataDir), 'RECURSIVE_WORKSPACE', 'ACMS data must be stored outside the source project');
    if (project.mode === 'git') await git(['rev-parse', '--show-toplevel'], root, undefined, invoke);
    return root;
  }
  async validateTaskProject(project, goal, invoke) {
    try { return await this.validateProject(project, invoke); }
    catch (error) {
      if (goal?.deliveryMode !== COPY_COMPOSITION || !['ENOENT', 'ENOTDIR', 'PROJECT_PATH'].includes(error.code)) throw error;
      throw new AcmsError('COMPOSITE_BASE', '已批准的源目录不可用，请恢复项目目录后继续。', { source: project.repoRoot });
    }
  }
  async prepare(task, attempt) {
    // A goal-level review has no single author workspace: materialize the
    // immutable artifact blobs of every delivered task into a fresh copy.
    if (task.reviewScope === 'goal') return this.prepareGoalReview(task);
    if (task.reviewOf) {
      if (task.workspace?.mode === 'review-copy') { await fs.access(task.workspace.path); return task.workspace; }
      const sourceTask = this.company.store.require('tasks', task.reviewOf);
      const destination = path.join(this.dataDir, 'reviews', task.id);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const missing = await fs.access(sourceTask.workspace.path).then(() => false, error => {
        if (error.code !== 'ENOENT') throw error;
        return true;
      });
      if (missing) {
        if (sourceTask.copyDeliveryInputHash) {
          const delivery = copyDeliveryFor(sourceTask);
          assert(delivery, 'COMPOSITE_CONTENT', '缺少原任务的当前持久目录交付。');
          await checkoutCopyComposition(delivery, destination, this.dataDir, attempt.signal);
          return { path: destination, mode: 'review-copy', artifactHash: task.reviewArtifactHash };
        }
        const delivery = await verifiedGitBundle(sourceTask, this.dataDir);
        assert(delivery, 'GIT_DELIVERY_MISSING', '原工作副本不可用，且没有可验证的 Git 交付包。');
        await checkoutGitBundle(delivery, destination, this.dataDir, git);
        return { path: destination, mode: 'review-copy', artifactHash: task.reviewArtifactHash };
      }
      await copyProject(sourceTask.workspace.path, destination, { collaboration: true });
      return { path: destination, source: sourceTask.workspace.path, mode: 'review-copy', artifactHash: task.reviewArtifactHash, collaboration: sourceTask.workspace.collaboration };
    }
    const project = this.company.store.require('projects', task.projectId);
    const goal = task.goalId && this.company.store.get('goals', task.goalId);
    const source = await this.validateTaskProject(project, goal);
    if (usesComposition(goal) && ['work', 'repair'].includes(task.kind)) {
      assert(goal.deliveryMode === compositionMode(project), 'COMPOSITE_PROJECT', '当前项目模式与完整候选不匹配。');
      return goal.deliveryMode === COPY_COMPOSITION ? this.prepareCopyCompositionTask(task, attempt, goal, project, source)
        : this.prepareCompositionTask(task, attempt, goal, project, source);
    }
    if (task.workspace) { await fs.access(task.workspace.path); return syncCollaboration(this.company, project, task, task.workspace); }
    const destination = path.join(this.dataDir, 'workspaces', task.id); await fs.mkdir(path.dirname(destination), { recursive: true });
    if (project.mode === 'git') {
      const branch = `acms/${task.id}`; const head = await git(['rev-parse', 'HEAD'], source);
      await git(['worktree', 'add', '-b', branch, destination, head], source);
      return syncCollaboration(this.company, project, task, { path: destination, source, branch, baseCommit: head, mode: 'git' });
    }
    await copyProject(source, destination);
    return syncCollaboration(this.company, project, task, { path: destination, source, mode: 'copy' });
  }
  async prepareCompositionTask(task, attempt, goal, project, source) {
    const invoke = (command, args, cwd, options) => run(command, args, cwd, { ...options, signal: attempt.signal });
    const getGit = (args, cwd) => git(args, cwd, undefined, invoke);
    assert(path.relative(await fs.realpath(await getGit(['rev-parse', '--show-toplevel'], source)), source) === '',
      'COMPOSITE_PROJECT', '完整候选要求使用批准的 Git 仓库根目录。');
    const store = this.company.store;
    let base = goal.compositionBase;
    if (!base) {
      const commit = await getGit(['rev-parse', '--verify', 'HEAD^{commit}'], source);
      base = store.transaction(() => {
        const fresh = store.require('goals', goal.id);
        assertGoalOpen(fresh);
        if (fresh.compositionBase) return fresh.compositionBase;
        const compositionBase = { source, commit };
        store.put('goals', { ...fresh, compositionBase });
        return compositionBase;
      });
    }
    assert(path.relative(base.source, source) === '', 'COMPOSITE_BASE', '当前 Git 仓库与目标固定基线不一致。');
    const dependencies = orderedCompositionTasks(store, goal, (task.dependencies ?? []).map(id => store.require('tasks', id)),
      { consumer: task, includeHistorical: true });
    const inputs = await selectedGitVersions(dependencies, base.commit, this.dataDir);
    const compose = items => composeGitVersions({ dataDir: this.dataDir, source, baseCommit: base.commit, inputs: items, invoke, signal: attempt.signal });
    const input = await compose(inputs);
    const destination = path.join(this.dataDir, 'workspaces', task.id);
    const branch = `acms/${task.id}`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const workspaceParent = path.join(await fs.realpath(this.dataDir), 'workspaces');
    assert(path.relative(await fs.realpath(path.dirname(destination)), workspaceParent) === '' &&
      (await fs.lstat(path.dirname(destination))).isDirectory(), 'COMPOSITE_WORKSPACE_INCOMPLETE', '工作副本目录经过链接。');
    if (task.workspace) {
      assert(task.workspace.compositionBase === base.commit && path.relative(task.workspace.path, destination) === '',
        'COMPOSITE_BASE', '任务副本与固定 Git 基线不匹配，保留已有文件。');
      const previous = task.workspace.compositionInput ?? await compose([]);
      if (previous.version !== input.version) {
        const actual = await fs.realpath(destination);
        const expected = path.join(workspaceParent, task.id);
        assert(path.relative(actual, expected) === '' && await getGit(['symbolic-ref', '--short', 'HEAD'], destination) === branch,
          'COMPOSITE_WORKSPACE_INCOMPLETE', '任务副本无法核对，保留已有文件。');
        await updateCompositionWorkspace(previous, input, destination, this.dataDir, invoke, attempt.signal);
      }
      return syncCollaboration(this.company, project, task, { ...task.workspace, compositionInput: input });
    }
    const existing = await fs.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      const directory = path.join(workspaceParent, task.id);
      const matches = existing.isDirectory() && path.relative(await fs.realpath(destination), directory) === '' &&
        await getGit(['symbolic-ref', '--short', 'HEAD'], destination) === branch &&
        await getGit(['rev-parse', '--verify', 'HEAD'], destination) === base.commit;
      const registrations = matches && await getGit(['worktree', 'list', '--porcelain', '-z'], source);
      const registered = registrations && registrations.split('\0').some(row => row.startsWith('worktree ') && path.relative(row.slice(9), directory) === '');
      const accurate = registered && await gitWorktreeFingerprint(destination) === input.contentHash;
      assert(accurate, 'COMPOSITE_WORKSPACE_INCOMPLETE', '未登记的任务副本需要人工核对，保留已有文件。');
    } else {
      const parent = await fs.realpath(path.join(this.dataDir, 'integration'));
      const temporary = await fs.mkdtemp(path.join(parent, 'composition-input-'));
      try {
        const checkout = path.join(temporary, 'checkout');
        await checkoutComposition(input, checkout, temporary, this.dataDir, invoke, attempt.signal);
        await getGit(['worktree', 'add', '--no-checkout', '-b', branch, destination, base.commit], source);
        await getGit(['read-tree', base.commit], destination);
        for (const name of await fs.readdir(checkout)) {
          if (name.toLowerCase() === '.git') continue;
          await fs.cp(path.join(checkout, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
        }
        assert(await gitWorktreeFingerprint(destination) === input.contentHash, 'COMPOSITE_CONTENT', '任务副本未能完整接收已选依赖版本。');
      } finally { await removeTemporary(temporary, parent); }
    }
    return syncCollaboration(this.company, project, task, { path: destination, source, branch, baseCommit: base.commit,
      mode: 'git', compositionBase: base.commit, compositionInput: input });
  }
  async prepareCopyCompositionTask(task, attempt, goal, project, source) {
    const store = this.company.store;
    let base = goal.compositionBase;
    if (!base) {
      const snapshot = await captureCopySnapshot(source, this.dataDir, attempt.signal);
      base = store.transaction(() => {
        const fresh = store.require('goals', goal.id);
        assertGoalOpen(fresh);
        if (fresh.compositionBase) return fresh.compositionBase;
        const compositionBase = { source, snapshot };
        store.put('goals', { ...fresh, compositionBase });
        return compositionBase;
      });
    }
    assert(base.snapshot && path.relative(base.source, source) === '', 'COMPOSITE_BASE', '当前目录项目与目标固定基线不一致。');
    const dependencies = orderedCompositionTasks(store, goal, (task.dependencies ?? []).map(id => store.require('tasks', id)),
      { consumer: task, includeHistorical: true });
    const compose = inputs => composeCopyVersions({ dataDir: this.dataDir, base: base.snapshot, inputs, signal: attempt.signal });
    const input = await compose(selectedCopyVersions(dependencies, base.snapshot.sha256));
    const parent = path.join(this.dataDir, 'workspaces');
    await fs.mkdir(parent, { recursive: true });
    const canonicalParent = path.join(await fs.realpath(this.dataDir), 'workspaces');
    assert((await fs.lstat(parent)).isDirectory() && await fs.realpath(parent) === canonicalParent,
      'COMPOSITE_WORKSPACE_INCOMPLETE', '目录工作副本位置经过链接。');
    const destination = path.join(parent, task.id);
    if (task.workspace) {
      assert(task.workspace.compositionBase === base.snapshot.sha256 && path.relative(task.workspace.path, destination) === '' &&
        (await fs.lstat(destination)).isDirectory() && await fs.realpath(destination) === path.join(canonicalParent, task.id),
      'COMPOSITE_WORKSPACE_INCOMPLETE', '现有目录副本与固定基线不匹配，原文件已保留。');
      const previous = task.workspace.compositionInput;
      assert(previous?.baseHash === base.snapshot.sha256, 'COMPOSITE_BASE', '现有目录副本的依赖基线无法核对。');
      if (previous.version !== input.version) {
        await updateWorkspaceInput(previous, input, destination, this.dataDir, {
          load: (candidate, folder) => checkoutCopyComposition(candidate.snapshot, folder, this.dataDir, attempt.signal),
          raw: true, signal: attempt.signal,
        });
      }
      return syncCollaboration(this.company, project, task, { ...task.workspace, compositionInput: input });
    }
    await checkoutCopyComposition(input.snapshot, destination, this.dataDir, attempt.signal);
    return syncCollaboration(this.company, project, task, { path: destination, source, mode: 'copy',
      compositionBase: base.snapshot.sha256, compositionInput: input });
  }
  async prepareGoalReview(task) {
    const goal = this.company.store.require('goals', task.goalId);
    if (usesComposition(goal)) {
      const candidate = acceptedGoalComposition(this.company.store, goal);
      assert(candidate && task.deliveryHash === this.company.deliveryHash(goal.id), 'STALE_REVIEW', '最终审查的完整候选已经变化。');
      const destination = path.join(this.dataDir, 'reviews', task.id);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (goal.deliveryMode === COPY_COMPOSITION) await checkoutCopyComposition(candidate.snapshot, destination, this.dataDir);
      else await checkoutComposition(candidate, destination, this.dataDir, this.dataDir, run);
      return { path: destination, mode: 'review-copy', reviewScope: 'goal', artifactHash: task.deliveryHash, candidateVersion: candidate.version };
    }
    if (task.workspace?.mode === 'review-copy') { await fs.access(task.workspace.path); return task.workspace; }
    const destination = path.join(this.dataDir, 'reviews', task.id);
    await fs.mkdir(destination, { recursive: true });
    for (const [index, target] of (task.reviewTargets ?? []).entries()) {
      const source = this.company.store.require('tasks', target.id);
      for (const artifactId of source.artifactIds ?? []) {
        const artifact = this.company.store.require('artifacts', artifactId);
        const file = path.resolve(destination, String(index + 1), artifact.path);
        assert(inside(destination, file), 'ARTIFACT_PATH', 'Artifact escapes the review workspace');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.copyFile(artifact.blob, file);
      }
    }
    return { path: destination, mode: 'review-copy', reviewScope: 'goal', artifactHash: task.deliveryHash };
  }
  async safeFile(workspace, relative) {
    assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'ARTIFACT_PATH', 'Artifact paths must be relative to the isolated workspace');
    const root = await fs.realpath(workspace); const target = path.resolve(root, relative);
    assert(inside(root, target), 'ARTIFACT_PATH', 'Artifact escapes the workspace');
    const actual = await fs.realpath(target); assert(inside(root, actual), 'ARTIFACT_PATH', 'Artifact symlink escapes the workspace');
    const st = await fs.stat(actual); assert(st.isFile(), 'ARTIFACT_PATH', 'Artifact must be a file');
    assert(st.size <= this.company.policy().maxArtifactBytes, 'ARTIFACT_TOO_LARGE', 'Artifact exceeds the company size limit');
    return actual;
  }
  async collect(task, attempt, declared, invoke = runContained) {
    await verifyCollaboration(task.workspace);
    assert(Array.isArray(declared) && declared.length <= 100, 'INVALID_ARTIFACTS', 'At most 100 artifacts may be submitted');
    if (task.requiresArtifacts) assert(declared.length > 0, 'MISSING_ARTIFACTS', 'This task requires a concrete deliverable');
    const source = task.workspace.path;
    const project = this.company.store.require('projects', task.projectId);
    const gitDelivery = task.workspace.mode === 'git' && !project.autoMerge;
    const copyDelivery = task.workspace.mode === 'copy' && !!task.workspace.compositionInput;
    const copyDeliveryInputHash = copyDelivery ? await copyContentHash(source, attempt.signal) : null;
    const inputHash = copyDelivery ? copyDeliveryInputHash : task.checkIds.length || gitDelivery ? await inputFingerprint(source, attempt.signal).catch(error => {
      if (gitDelivery && !task.checkIds.length && error.code === 'CHECK_INPUT_LINK') return null;
      throw error;
    }) : null;
    const artifacts = [], checkResults = [];
    for (const item of declared) {
      assert(!isCollaborationPath(path.normalize(item.path ?? '')), 'ARTIFACT_PATH', '.acms 是固定输入，交付物请写入普通任务文档');
      assert(!dependencyPath(path.normalize(item.path ?? '')), 'ARTIFACT_PATH', 'Installed dependencies are workspace inputs and cannot be delivered');
      if (copyDelivery) assert((item.path ?? '').split(/[/\\]/).every(part => includedProjectInput(part)),
        'ARTIFACT_PATH', '完整目录候选只接收受控项目文件。');
      const filename = await this.safeFile(task.workspace.path, item.path); const bytes = await fs.readFile(filename);
      const hash = digest(bytes.toString('base64')); const blob = path.join(this.dataDir, 'artifacts', hash);
      await fs.mkdir(path.dirname(blob), { recursive: true });
      try { await fs.writeFile(blob, bytes, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const artifact = { id: `artifact_${attempt.id}_${artifacts.length}`, taskId: task.id, attemptId: attempt.id, path: item.path, title: item.title ?? item.path, hash, bytes: bytes.length, blob };
      if (item.archiveFormat === undefined && isProseFile(item.path)) {
        artifact.textIntegrity = await validateDeliveryText(bytes, { signal: attempt.signal });
      }
      if (item.archiveFormat !== undefined) {
        const report = item.archiveFormat === ARCHIVE_FORMAT ? await validateDeliveryArchive(bytes, { signal: attempt.signal }) : {
          format: ARCHIVE_FORMAT, passed: false, errors: [{ code: 'UNSUPPORTED_ARCHIVE_FORMAT', path: item.path }],
        };
        artifact.archiveVerification = { ...report, taskId: task.id, attemptId: attempt.id,
          taskGeneration: attempt.taskGeneration ?? deliveryGeneration(task), goalContractVersion: attempt.goalContractVersion ?? taskContractVersion(task) };
        checkResults.push({ id: `archive:${item.path}`, kind: 'delivery-archive', passed: report.passed,
          artifactId: artifact.id, artifactHash: hash, archiveSha256: report.archiveSha256 ?? null,
          manifestSha256: report.manifestSha256 ?? null, errors: report.errors,
          reason: report.passed ? '交付归档与清单的原始字节一致' : `交付归档校验失败：${JSON.stringify(report.errors).slice(0, 6000)}` });
      }
      artifacts.push(artifact);
    }
    const guard = () => assert(digest(this.company.store.require('projects', task.projectId).preparation ?? null) === digest(project.preparation ?? null),
      'PREPARATION_CHANGED', 'Owner preparation configuration changed');
    const evidence = task.checkIds.length ? this.company.store.list('verifications').filter(v => v.kind === 'checks' && v.taskId === task.id).flatMap(v => v.checks) : [];
    for (const checkId of task.checkIds) {
      const check = (task.checksSnapshot ?? project.checks).find(c => c.id === checkId); assert(check, 'UNKNOWN_CHECK', `Configured check ${checkId} is missing from the task contract`);
      const identity = await checkIdentity(check, source, project.preparation, attempt.signal).catch(error => {
        if (!project.preparation || error.code !== 'ENOENT') throw error;
        return null;
      });
      const cached = identity?.reusable && evidence.findLast(item => item.id === check.id && item.reusable === true && item.passed &&
        item.cleanupConfirmed === true && item.inputHash === inputHash && item.inputUnchanged === true && item.checkVersion === identity.version);
      checkResults.push(cached ? { ...cached, reused: true } : await verifyInCopy({ dataDir: this.dataDir, source,
        inputHash, check, preparation: project.preparation, identity, signal: attempt.signal,
        readInputs: copyDelivery ? copyCheckInputs : undefined,
        invoke: (command, args, cwd, options) => invoke(command, args, cwd, { ...options, guard }) }));
    }
    const changeSet = await this.captureChanges(task);
    if (inputHash) guard();
    if (inputHash) {
      const fingerprint = copyDelivery ? copyContentHash : inputFingerprint;
      assert(await fingerprint(source, attempt.signal) === inputHash, 'CHECK_INPUT_CHANGED', 'Delivery inputs changed during verification');
    }
    const gitDeliveryInputHash = gitDelivery ? inputHash : null;
    return { artifacts, checks: checkResults, changeSet, gitDeliveryInputHash, copyDeliveryInputHash,
      hash: digest({ artifacts: artifacts.map(a => ({ path: a.path, hash: a.hash,
        ...(a.archiveVerification ? { archiveFormat: a.archiveVerification.format, archivePassed: a.archiveVerification.passed } : {}) })),
      changeSet, ...(gitDeliveryInputHash ? { gitDeliveryInputHash } : {}), ...(copyDeliveryInputHash ? { copyDeliveryInputHash } : {}) }) };
  }
  prepareEnvironment(task, spec, invoke, signal) {
    return prepareDependencies(this.dataDir, task.workspace.path, spec, invoke, signal);
  }
  async reviewEvidence(task, signal, { checkReviewCopy = true } = {}) {
    const targets = task.reviewOf ? [task.reviewOf] : (task.reviewTargets ?? []).map(target => target.id);
    const store = this.company.store;
    const rows = store.list('verifications');
    const evidence = {};
    const goal = task.reviewScope === 'goal' && store.require('goals', task.goalId);
    const composition = goal && acceptedGoalComposition(store, goal);
    if (composition && this.company.deliveryHash(goal.id) === task.deliveryHash) {
      evidence.composition = { version: composition.version, contentHash: composition.contentHash,
        ...(composition.baseHash ? { baseHash: composition.baseHash } : { baseCommit: composition.baseCommit }),
        checks: composition.checks.map(({ id, checkVersion, environment, code, inputHash, log }) => ({ id, checkVersion, environment, code, inputHash, log })) };
    }
    for (const id of targets) {
      const source = store.require('tasks', id);
      const row = rows.findLast(v => v.kind === 'checks' && v.taskId === id && v.artifactHash === source.artifactHash &&
        v.taskGeneration === deliveryGeneration(source) && v.goalContractVersion === taskContractVersion(source));
      if (!row?.checks?.some(check => check.checkVersion) || !source.workspace) continue;
      const cwd = source.workspace.path;
      const fingerprint = source.copyDeliveryInputHash ? copyContentHash : inputFingerprint;
      const inputHash = await fingerprint(cwd, signal).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!inputHash) continue;
      if (task.reviewOf && checkReviewCopy && await fingerprint(task.workspace.path, signal) !== inputHash) continue;
      const project = store.require('projects', source.projectId);
      const checks = [];
      for (const item of row.checks) {
        const check = project.checks.find(check => check.id === item.id);
        if (!check || item.reusable !== true || !item.passed || item.cleanupConfirmed !== true ||
            item.inputHash !== inputHash || item.inputUnchanged !== true) continue;
        const identity = await checkIdentity(check, cwd, project.preparation, signal).catch(error => {
          signal?.throwIfAborted();
          return null;
        });
        if (!identity?.reusable || identity.version !== item.checkVersion) continue;
        const { stdout, stderr, preparation, ...summary } = item;
        checks.push(summary);
      }
      if (checks.length) evidence[id] = { artifactHash: row.artifactHash, inputHash, checks };
    }
    return evidence;
  }
  async captureChanges(task, invoke = run) {
    if (task.workspace.mode !== 'git') return null;
    const cwd = task.workspace.path;
    const maxOutput = 4 * 1024 * 1024;
    // A delivery needs both sides of a rename, including the deleted path.
    const tracked = await git(['diff', '--name-only', '--no-renames', '-z', task.workspace.baseCommit ?? 'HEAD', '--', '.', excludeDependencies], cwd, { maxOutput }, invoke);
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', excludeDependencies], cwd, { maxOutput }, invoke);
    assert(tracked.length < maxOutput && untracked.length < maxOutput, 'CHANGE_LIMIT', 'Git change names exceed the delivery limit');
    const root = await fs.realpath(cwd);
    const changed = new Set((tracked + '\0' + untracked).split('\0').filter(n => n && !isCollaborationPath(n) && !dependencyPath(n)));
    const files = [];
    let baseLeaves;
    const readBaseLeaves = async () => {
      if (!baseLeaves) {
        const tree = await git(['ls-tree', '-r', '--full-tree', '-z', task.workspace.baseCommit ?? 'HEAD'], cwd, { maxOutput }, invoke);
        assert(tree.length < maxOutput, 'CHANGE_LIMIT', 'Git baseline names exceed the delivery limit');
        baseLeaves = new Set(tree.split('\0').map(row => /^100(?:644|755) blob [a-f0-9]+\t(.*)$/s.exec(row)?.[1]).filter(Boolean));
      }
      return baseLeaves;
    };
    if (process.platform === 'win32' && task.workspace.compositionBase) {
      // The parent retains its index when selected inputs are applied. Git can
      // hide a case-only rename whose bytes still match that older index name.
      for (const name of await readBaseLeaves()) {
        if (isCollaborationPath(name) || dependencyPath(name)) continue;
        const actual = await fs.realpath(path.join(root, name)).catch(error => {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
          throw error;
        });
        if (!actual) continue;
        const spelling = path.relative(root, actual).split(path.sep).join('/');
        if (spelling !== name && spelling.toLowerCase() === name.toLowerCase()) {
          changed.add(name);
          changed.add(spelling);
        }
      }
    }
    assert(changed.size <= 1000, 'CHANGE_LIMIT', 'A single reviewed submission may change at most 1000 files');
    const names = [...changed].sort();
    for (const name of names) {
      try {
        const filename = await this.safeFile(cwd, name);
        const spelling = path.relative(root, filename).split(path.sep).join('/');
        // Windows lookup can find the new spelling for an old Git path.
        // Keep both exact Git paths when a case-only rename is reported.
        if (process.platform === 'win32' && spelling !== name && spelling.toLowerCase() === name.toLowerCase()) {
          files.push({ path: name, deleted: true });
        } else files.push({ path: name, hash: digest((await fs.readFile(filename)).toString('base64')) });
      } catch (error) {
        if (error.code === 'ENOENT') { files.push({ path: name, deleted: true }); continue; }
        if (['ENOTDIR', 'ARTIFACT_PATH'].includes(error.code) && await describesReplacedGitLeaf(root, name)) {
          if ((await readBaseLeaves()).has(name)) { files.push({ path: name, deleted: true }); continue; }
        }
        throw error;
      }
    }
    return files;
  }
  async unchanged(task, artifactIds, invoke = run) {
    try { await fs.access(task.workspace.path); } catch (error) {
      if (error.code !== 'ENOENT') return false;
      if (task.copyDeliveryInputHash) return !!(await verifiedCopyDelivery(task, this.dataDir));
      return !!(await verifiedGitBundle(task, this.dataDir));
    }
    try { await verifyCollaboration(task.workspace); } catch { return false; }
    for (const artifactId of artifactIds) {
      const a = this.company.store.require('artifacts', artifactId);
      try { const bytes = await fs.readFile(await this.safeFile(task.workspace.path, a.path)); if (digest(bytes.toString('base64')) !== a.hash) return false; } catch { return false; }
    }
    if (task.changeSet && digest(await this.captureChanges(task, invoke)) !== digest(task.changeSet)) return false;
    if (task.gitDeliveryInputHash && await inputFingerprint(task.workspace.path) !== task.gitDeliveryInputHash) return false;
    if (task.copyDeliveryInputHash && await copyContentHash(task.workspace.path) !== task.copyDeliveryInputHash) return false;
    return true;
  }
  async integrationTarget(root, invoke) {
    const ref = await invoke('git', ['symbolic-ref', '-q', 'HEAD'], root);
    assert(!ref.timedOut && [0, 1].includes(ref.code), 'GIT_ERROR', ref.stderr || 'Unable to read target ref');
    const targetRef = ref.code === 0 ? ref.stdout.trim() : 'HEAD';
    const targetHead = await git(['rev-parse', '--verify', 'HEAD'], root, undefined, invoke);
    const targetStatus = await git(['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--', '.', ':(exclude).acms'], root, undefined, invoke);
    return { targetRef, targetHead, targetStatus };
  }
  assertIntegrationTarget(record, executable) {
    // Run immediately before handing the final command to the supervisor.
    // Optional locks and fsmonitor are disabled for this read-only guard.
    const invoke = args => {
      const result = spawnSync(executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
        cwd: record.targetRoot, encoding: 'utf8', windowsHide: true, timeout: 2000,
      });
      assert(!result.error && [0, ...(args[0] === 'symbolic-ref' ? [1] : [])].includes(result.status),
        'GIT_ERROR', result.error?.message || result.stderr || 'Unable to verify the final target');
      return result.stdout.trim();
    };
    const status = invoke(['status', '--porcelain', '--', '.', ':(exclude).acms']);
    const head = invoke(['rev-parse', '--verify', 'HEAD']);
    const ref = invoke(['symbolic-ref', '-q', 'HEAD']) || 'HEAD';
    assert(ref === record.targetRef && head === record.targetHead && !status, 'TARGET_CHANGED', 'Source changed before the final Git command', { actualHead: head });
  }
  async integrate(task, isCurrent, execution) {
    const project = this.company.store.require('projects', task.projectId);
    const goal = task.goalId && this.company.store.get('goals', task.goalId);
    if (usesComposition(goal)) assert(goal.deliveryMode === compositionMode(project), 'COMPOSITE_PROJECT', '当前项目模式与完整候选不匹配。');
    if (!project.autoMerge) {
      const available = { status: 'available', path: task.workspace.path, branch: task.workspace.branch };
      if (goal?.deliveryMode === COPY_COMPOSITION) {
        assert(task.copyDeliveryInputHash && task.workspace.mode === 'copy' && task.workspace.compositionBase === goal.compositionBase?.snapshot?.sha256,
          'COMPOSITE_BASE', '目录交付缺少固定工作副本或已验收的内容指纹。');
        assert(await this.unchanged(task, task.artifactIds), 'ARTIFACT_CHANGED', '目录交付内容已改变。');
        const snapshot = await captureCopySnapshot(task.workspace.path, this.dataDir, execution.signal);
        assert(snapshot.sha256 === task.copyDeliveryInputHash, 'ARTIFACT_CHANGED', '保存持久版本期间，目录交付内容已改变。');
        return { ...available, delivery: { ...snapshot, baseHash: task.workspace.compositionBase,
          generation: task.generation, artifactHash: task.artifactHash } };
      }
      if (task.workspace.mode !== 'git') return available;
      const getGit = (args, cwd, options) => git(args, cwd, options, execution.run);
      const source = await this.validateProject(project, execution.run);
      assert(await this.unchanged(task, task.artifactIds, execution.run), 'ARTIFACT_CHANGED', 'Git 交付内容已改变。');
      const artifacts = task.artifactIds.map(id => this.company.store.require('artifacts', id));
      const delivery = await publishGitDelivery({ dataDir: this.dataDir, task, source, artifacts, executionId: execution.id,
        git: getGit, safeFile: filename => this.safeFile(task.workspace.path, filename) });
      assert(await this.unchanged(task, task.artifactIds, execution.run), 'ARTIFACT_CHANGED', '生成交付版本期间，Git 工作副本已改变。');
      return { ...available, delivery };
    }
    assert(task.workspace.mode === 'git', 'INTEGRATION_REQUIRED', 'Automatic integration requires a Git project');
    const invoke = execution.run;
    const getGit = (args, cwd) => git(args, cwd, undefined, invoke);
    const targetRoot = await this.validateProject(project, invoke);
    assert(await fs.realpath(await getGit(['rev-parse', '--show-toplevel'], targetRoot)) === targetRoot,
      'PROJECT_PATH_DENIED', 'Automatic integration requires the approved Git repository root');
    assert(await this.unchanged(task, task.artifactIds, invoke), 'ARTIFACT_CHANGED', 'Artifact changed after review');
    const { targetHead, targetRef, targetStatus } = await this.integrationTarget(targetRoot, invoke);
    execution.checkpoint({ targetRoot, targetHead, targetRef });
    const withEvidence = (error, facts = {}) => Object.assign(error, { integrationEvidence: { code: error.code ?? null, targetHead, ...facts } });
    if (targetStatus) throw withEvidence(new AcmsError('TARGET_DIRTY', 'Source project has uncommitted changes; integration is blocked'), { statusHash: digest(targetStatus) });
    await getGit(['add', '--all', '--', '.', ':(exclude).acms', excludeDependencies], task.workspace.path);
    const changes = await getGit(['diff', '--cached', '--name-only'], task.workspace.path);
    if (changes) await getGit(['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', 'commit', '-m', `ACMS: ${task.title.replace(/[\r\n]/g, ' ')}`], task.workspace.path);
    const commit = await getGit(['rev-parse', 'HEAD'], task.workspace.path);
    const candidate = path.join(this.dataDir, 'integration', execution.id);
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await getGit(['worktree', 'add', '--detach', candidate, targetHead], targetRoot);
    try {
      const result = await invoke('git', ['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', 'merge', '--no-edit', '--no-ff', '-m', 'ACMS integration ' + execution.id, commit], candidate);
      assert(result.code === 0 && !result.timedOut, 'MERGE_CONFLICT', 'Integration conflict in isolated candidate; source was not changed', { output: result.stderr || result.stdout, candidate });
      const integratedCommit = await getGit(['rev-parse', 'HEAD'], candidate);
      execution.checkpoint({ phase: 'checking', commit, candidate, integratedCommit });
      const checks = [];
      const inputHash = project.checks.length ? await inputFingerprint(candidate) : null;
      for (const check of project.checks) {
        checks.push(await verifyInCopy({ dataDir: path.dirname(candidate), source: candidate,
          inputHash, check, preparation: project.preparation, invoke }));
      }
      assert(checks.every(c => c.passed), 'INTEGRATION_CHECK_FAILED', 'Candidate integration failed checks; source was not changed', { checks, commit, candidate });
      assert(await getGit(['rev-parse', 'HEAD'], candidate) === integratedCommit &&
        (await getGit(['diff', '--name-only', 'HEAD'], candidate)) === '', 'CHECK_MODIFIED_CODE', 'Acceptance checks modified the integration candidate');
      const actualRoot = await this.validateProject(this.company.store.require('projects', task.projectId), invoke);
      const actual = await this.integrationTarget(targetRoot, invoke);
      assert(actualRoot === targetRoot && !actual.targetStatus && actual.targetHead === targetHead && actual.targetRef === targetRef,
        'TARGET_CHANGED', 'Source changed while validating integration; merge was not applied', { actualHead: actual.targetHead });
      assert(isCurrent(), 'STALE_INTEGRATION', 'Integration was stopped or replaced');
      if (integratedCommit !== targetHead) await execution.apply(checks, targetRoot, integratedCommit);
      return { status: 'merged', commit, integratedCommit, targetRef, checks, candidate };
    } catch (error) {
      throw withEvidence(error, { commit, actualHead: error.details?.actualHead ?? null,
        checks: error.details?.checks?.filter(c => !c.passed).map(c => ({ id: c.id, code: c.code })) ?? [] });
    }
  }
  async recheckGoalComposition(goal, task, execution) {
    const store = this.company.store;
    const project = store.require('projects', task.projectId);
    assert(goal.deliveryMode === compositionMode(project), 'COMPOSITE_PROJECT', '当前项目模式与完整候选不匹配。');
    const source = await this.validateTaskProject(project, goal, execution.run);
    const current = store.require('goals', goal.id);
    const work = store.list('tasks').filter(item => item.goalId === goal.id && item.kind === 'work' &&
      !item.contractObsolete && !item.legacyBatch && !item.workflowSnapshot && item.status !== 'deleted');
    assert(work.every(item => taskSettledForGoal(item, current)), 'COMPOSITE_NO_DELIVERY', '请先完成当前工作任务。');
    const copy = goal.deliveryMode === COPY_COMPOSITION;
    const base = current.compositionBase;
    const baseCommit = base?.commit;
    assert((copy ? base?.snapshot : baseCommit) && base.source && path.relative(base.source, source) === '',
      'COMPOSITE_BASE', '当前项目与目标固定基线不一致。');
    assert(project.checks.length, 'COMPOSITE_CHECK_REQUIRED', '请由所有者添加至少一项用于完整候选的联合检查。');
    const delivered = deliveredWork(store, current);
    const ordered = orderedCompositionTasks(store, current, delivered, { includeHistorical: true });
    const versions = copy ? selectedCopyVersions(ordered, base.snapshot.sha256) : await selectedGitVersions(ordered, baseCommit, this.dataDir);
    const historical = new Set(current.supersededTaskIds ?? []);
    const inputs = [];
    const compose = items => copy ? composeCopyVersions({ dataDir: this.dataDir, base: base.snapshot, inputs: items, signal: execution.signal })
      : composeGitVersions({ dataDir: this.dataDir, source, baseCommit, inputs: items, invoke: execution.run });
    for (const version of versions) {
      if (historical.has(version.taskId)) continue;
      const inherited = version.baseline?.inputs ?? [];
      if (inherited.some(row => historical.has(row.taskId))) {
        // A replacement can retain bytes from its approved historical draft.
        // Compare it to its current dependencies so the retired task is not a
        // separate selected output and retained bytes belong to replacement.
        const active = new Set(inherited.filter(row => !historical.has(row.taskId)).map(row => row.taskId));
        version.mergeBase = await compose(inputs.filter(item => active.has(item.taskId)));
      }
      inputs.push(version);
    }
    assert(inputs.length, 'COMPOSITE_NO_DELIVERY', '没有当前目标可组合的工作任务交付。');
    const candidate = await compose(inputs);
    const parent = await fs.realpath(path.join(this.dataDir, 'integration'));
    const temporary = await fs.mkdtemp(path.join(parent, 'composition-check-'));
    let retain = false;
    try {
      const checkout = path.join(temporary, 'checkout');
      if (copy) await checkoutCopyComposition(candidate.snapshot, checkout, this.dataDir, execution.signal);
      else await checkoutComposition(candidate, checkout, temporary, this.dataDir, execution.run);
      const inputHash = copy ? candidate.contentHash : await inputFingerprint(checkout);
      const evidence = store.list('integrations').filter(item => item.goalId === goal.id && item.composition?.version === candidate.version)
        .flatMap(item => item.composition.checks ?? []);
      const checks = [];
      for (const check of project.checks) {
        const identity = await checkIdentity(check, checkout, project.preparation).catch(error => {
          if (!project.preparation || error.code !== 'ENOENT') throw error;
          return null;
        });
        const cached = identity?.reusable && evidence.findLast(row => row.id === check.id && row.reusable && row.passed &&
          row.cleanupConfirmed === true && row.inputUnchanged === true && row.inputHash === inputHash && row.checkVersion === identity.version);
        checks.push(cached ? { ...cached, reused: true } : await verifyInCopy({ dataDir: temporary, source: checkout, inputHash, check,
          preparation: project.preparation, identity, invoke: execution.run, readInputs: copy ? copyCheckInputs : undefined,
          signal: copy ? execution.signal : undefined }));
      }
      const composition = { ...candidate, checkContract: compositionCheckContract(project), ledgerHash: goalDeliveryHash(current, delivered),
        passed: checks.every(check => check.passed), checks };
      execution.checkpoint({ phase: 'checking', composition });
      if (!composition.passed) {
        const failed = checks.filter(check => !check.passed).map(check => check.id);
        throw Object.assign(new AcmsError('COMPOSITE_CHECK_FAILED', '完整候选联合检查未通过，请核对检查 ' + failed.join('、') + '。'),
          { integrationEvidence: { code: 'COMPOSITE_CHECK_FAILED', version: candidate.version, checks: failed } });
      }
      return { composition };
    } catch (error) {
      retain = !!error.cleanupUncertain;
      throw error;
    } finally { if (!retain) await removeTemporary(temporary, parent); }
  }
  runIntegrationCommand(command, args, cwd, options) {
    return runContained(command, args, cwd, options);
  }
  runDeliveryCheck(command, args, cwd, options) {
    return runContained(command, args, cwd, options);
  }
  async inspectIntegration(record, invoke) {
    const { targetRoot, targetHead, targetRef, integratedCommit, commit, checks, candidate } = record;
    if (record.candidateMergeId) assert(path.relative(await fs.realpath(targetRoot), targetRoot) === '',
      'TARGET_CHANGED', '无法核对已确认的项目目录，请恢复原目录后重新核对。');
    const observed = await invoke('git', record.ownerReservation ? ['rev-parse', '--verify', '--quiet', targetRef] : ['rev-parse', '--verify', targetRef], targetRoot);
    if (record.ownerReservation && observed.code === 1 && !observed.timedOut) return { status: 'target-changed', actualHead: null, targetRef };
    assert(observed.code === 0 && !observed.timedOut, 'GIT_ERROR', observed.stderr || 'Unable to verify the integration target');
    const actualHead = observed.stdout.trim();
    const ancestry = await invoke('git', ['merge-base', '--is-ancestor', integratedCommit, actualHead], targetRoot);
    assert(!ancestry.timedOut && [0, 1].includes(ancestry.code), 'GIT_ERROR', ancestry.stderr || 'Unable to verify the candidate commit');
    const reflog = ancestry.code === 0 ? '' : await git(['reflog', 'show', '--format=%H', '-n', '1000', targetRef], targetRoot, undefined, invoke);
    if (ancestry.code === 0 || reflog.split(/\r?\n/).includes(integratedCommit)) {
      return { status: 'merged', proof: ancestry.code === 0 ? 'target-history' : 'target-reflog', actualHead, targetRef, commit, integratedCommit, checks, candidate };
    }
    if (record.ownerReservation) return { status: actualHead === targetHead ? 'unchanged' : 'target-changed', actualHead, targetRef };
    const actual = await this.integrationTarget(targetRoot, invoke);
    return { status: actual.targetRef === targetRef && actual.targetHead === targetHead && !actual.targetStatus ? 'unchanged' : 'unknown', actualHead, targetRef };
  }
}
