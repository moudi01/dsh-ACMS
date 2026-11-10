import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runContained } from './host-command.js';
import { AcmsError, assert, digest } from '../core/util.js';
import { publishCollaboration, syncCollaboration, verifyCollaboration, isCollaborationPath } from './collaboration.js';
import { deliveryGeneration, taskContractVersion } from '../core/goal-contract.js';
import { checkIdentity, copyProject, inputFingerprint, prepareDependencies, verifyInCopy } from './project-environment.js';

export function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
const dependencyPath = filename => filename.split(/[/\\]/).some(part => part.toLowerCase() === 'node_modules');
const excludeDependencies = ':(exclude,glob,icase)**/node_modules/**';
export async function run(command, args, cwd, { signal, timeout = 120000, maxOutput = 100000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command === 'node' ? process.execPath : command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-maxOutput); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-maxOutput); });
    child.once('error', e => { cleanup(); reject(e); });
    child.once('close', async (code, termination) => { cleanup(); await terminating; resolve({ code, signal: termination, timedOut, stdout, stderr }); });
    if (signal?.aborted) terminate();
  });
}
async function git(args, cwd, options, invoke = run) { const r = await invoke('git', args, cwd, options); assert(r.code === 0 && !r.timedOut, 'GIT_ERROR', r.stderr || r.stdout || 'Git operation failed', { args }); return r.stdout.trim(); }
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
  async prepare(task, attempt) {
    // A goal-level review has no single author workspace: materialize the
    // immutable artifact blobs of every delivered task into a fresh copy.
    if (task.reviewScope === 'goal') return this.prepareGoalReview(task);
    if (task.reviewOf) {
      if (task.workspace?.mode === 'review-copy') { await fs.access(task.workspace.path); return task.workspace; }
      const sourceTask = this.company.store.require('tasks', task.reviewOf);
      const destination = path.join(this.dataDir, 'reviews', task.id);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyProject(sourceTask.workspace.path, destination, { collaboration: true });
      return { path: destination, source: sourceTask.workspace.path, mode: 'review-copy', artifactHash: task.reviewArtifactHash, collaboration: sourceTask.workspace.collaboration };
    }
    const project = this.company.store.require('projects', task.projectId); const source = await this.validateProject(project);
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
  async prepareGoalReview(task) {
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
    const inputHash = task.checkIds.length ? await inputFingerprint(source, attempt.signal) : null;
    const artifacts = [];
    for (const item of declared) {
      assert(!isCollaborationPath(path.normalize(item.path ?? '')), 'ARTIFACT_PATH', '.acms 是固定输入，交付物请写入普通任务文档');
      assert(!dependencyPath(path.normalize(item.path ?? '')), 'ARTIFACT_PATH', 'Installed dependencies are workspace inputs and cannot be delivered');
      const filename = await this.safeFile(task.workspace.path, item.path); const bytes = await fs.readFile(filename);
      const hash = digest(bytes.toString('base64')); const blob = path.join(this.dataDir, 'artifacts', hash);
      await fs.mkdir(path.dirname(blob), { recursive: true });
      try { await fs.writeFile(blob, bytes, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      artifacts.push({ id: `artifact_${attempt.id}_${artifacts.length}`, taskId: task.id, attemptId: attempt.id, path: item.path, title: item.title ?? item.path, hash, bytes: bytes.length, blob });
    }
    const project = this.company.store.require('projects', task.projectId); const checkResults = [];
    const guard = () => assert(digest(this.company.store.require('projects', task.projectId).preparation ?? null) === digest(project.preparation ?? null),
      'PREPARATION_CHANGED', 'Owner preparation configuration changed');
    const evidence = task.checkIds.length ? this.company.store.list('verifications').filter(v => v.kind === 'checks' && v.taskId === task.id).flatMap(v => v.checks) : [];
    for (const checkId of task.checkIds) {
      const check = (task.checksSnapshot ?? project.checks).find(c => c.id === checkId); assert(check, 'UNKNOWN_CHECK', `Configured check ${checkId} is missing from the task contract`);
      const identity = await checkIdentity(check, source, project.preparation).catch(error => {
        if (!project.preparation || error.code !== 'ENOENT') throw error;
        return null;
      });
      const cached = project.preparation?.network !== 'allow' && evidence.findLast(item => item.id === check.id && item.passed && item.cleanupConfirmed === true &&
        item.inputHash === inputHash && item.inputUnchanged === true && item.checkVersion === identity?.version);
      checkResults.push(cached ? { ...cached, reused: true } : await verifyInCopy({ dataDir: this.dataDir, source,
        inputHash, check, preparation: project.preparation, identity, signal: attempt.signal,
        invoke: (command, args, cwd, options) => invoke(command, args, cwd, { ...options, guard }) }));
    }
    const changeSet = await this.captureChanges(task);
    if (inputHash) guard();
    if (inputHash) assert(await inputFingerprint(source, attempt.signal) === inputHash, 'CHECK_INPUT_CHANGED', 'Delivery inputs changed during verification');
    return { artifacts, checks: checkResults, changeSet, hash: digest({ artifacts: artifacts.map(a => ({ path: a.path, hash: a.hash })), changeSet }) };
  }
  prepareEnvironment(task, spec, invoke, signal) {
    return prepareDependencies(this.dataDir, task.workspace.path, spec, invoke, signal);
  }
  async reviewEvidence(task, signal, { checkReviewCopy = true } = {}) {
    const targets = task.reviewOf ? [task.reviewOf] : (task.reviewTargets ?? []).map(target => target.id);
    const store = this.company.store;
    const rows = store.list('verifications');
    const evidence = {};
    for (const id of targets) {
      const source = store.require('tasks', id);
      const row = rows.findLast(v => v.kind === 'checks' && v.taskId === id && v.artifactHash === source.artifactHash &&
        v.taskGeneration === deliveryGeneration(source) && v.goalContractVersion === taskContractVersion(source));
      if (!row?.checks?.some(check => check.checkVersion) || !source.workspace) continue;
      const cwd = source.workspace.path;
      const inputHash = await inputFingerprint(cwd, signal);
      if (task.reviewOf && checkReviewCopy && await inputFingerprint(task.workspace.path, signal) !== inputHash) continue;
      const project = store.require('projects', source.projectId);
      const checks = [];
      for (const item of row.checks) {
        const check = project.checks.find(check => check.id === item.id);
        if (!check || !item.passed || item.cleanupConfirmed !== true || item.inputHash !== inputHash || item.inputUnchanged !== true) continue;
        const identity = await checkIdentity(check, cwd, project.preparation).catch(() => null);
        if (identity?.version !== item.checkVersion) continue;
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
    const tracked = await git(['diff', '--name-only', '-z', task.workspace.baseCommit ?? 'HEAD', '--', '.', excludeDependencies], cwd, undefined, invoke);
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', excludeDependencies], cwd, undefined, invoke);
    const names = [...new Set((tracked + '\0' + untracked).split('\0').filter(n => n && !isCollaborationPath(n) && !dependencyPath(n)))].sort();
    assert(names.length <= 1000, 'CHANGE_LIMIT', 'A single reviewed submission may change at most 1000 files');
    const files = [];
    for (const name of names) {
      try { const filename = await this.safeFile(cwd, name); files.push({ path: name, hash: digest((await fs.readFile(filename)).toString('base64')) }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; files.push({ path: name, deleted: true }); }
    }
    return files;
  }
  async unchanged(task, artifactIds, invoke = run) {
    try { await verifyCollaboration(task.workspace); } catch { return false; }
    for (const artifactId of artifactIds) {
      const a = this.company.store.require('artifacts', artifactId);
      try { const bytes = await fs.readFile(await this.safeFile(task.workspace.path, a.path)); if (digest(bytes.toString('base64')) !== a.hash) return false; } catch { return false; }
    }
    if (task.changeSet && digest(await this.captureChanges(task, invoke)) !== digest(task.changeSet)) return false;
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
    if (!project.autoMerge) return { status: 'available', path: task.workspace.path, branch: task.workspace.branch };
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
  runIntegrationCommand(command, args, cwd, options) {
    return runContained(command, args, cwd, options);
  }
  runDeliveryCheck(command, args, cwd, options) {
    return runContained(command, args, cwd, options);
  }
  async inspectIntegration(record, invoke) {
    const { targetRoot, targetHead, targetRef, integratedCommit, commit, checks, candidate } = record;
    const observed = await invoke('git', ['rev-parse', '--verify', targetRef], targetRoot);
    assert(observed.code === 0 && !observed.timedOut, 'GIT_ERROR', observed.stderr || 'Unable to verify the integration target');
    const actualHead = observed.stdout.trim();
    const ancestry = await invoke('git', ['merge-base', '--is-ancestor', integratedCommit, actualHead], targetRoot);
    assert(!ancestry.timedOut && [0, 1].includes(ancestry.code), 'GIT_ERROR', ancestry.stderr || 'Unable to verify the candidate commit');
    const reflog = ancestry.code === 0 ? '' : await git(['reflog', 'show', '--format=%H', '-n', '1000', targetRef], targetRoot, undefined, invoke);
    if (ancestry.code === 0 || reflog.split(/\r?\n/).includes(integratedCommit)) {
      return { status: 'merged', proof: ancestry.code === 0 ? 'target-history' : 'target-reflog', actualHead, targetRef, commit, integratedCommit, checks, candidate };
    }
    const actual = await this.integrationTarget(targetRoot, invoke);
    return { status: actual.targetRef === targetRef && actual.targetHead === targetHead && !actual.targetStatus ? 'unchanged' : 'unknown', actualHead, targetRef };
  }
}
