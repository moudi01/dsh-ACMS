import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assert, digest } from '../core/util.js';
import { publishCollaboration, syncCollaboration, verifyCollaboration, isCollaborationPath } from './collaboration.js';

export function inside(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
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
async function git(args, cwd, options) { const r = await run('git', args, cwd, options); assert(r.code === 0, 'GIT_ERROR', r.stderr || r.stdout || 'Git operation failed', { args }); return r.stdout.trim(); }
export class WorkspaceManager {
  constructor(dataDir, company) { this.dataDir = dataDir; this.company = company; }
  async publishProject(project) { await this.validateProject(project); return publishCollaboration(this.company, project); }
  async validateProject(project) {
    const root = await fs.realpath(project.repoRoot); const stat = await fs.stat(root); assert(stat.isDirectory(), 'PROJECT_PATH', 'Project root must be a directory');
    const permitted = this.company.policy().allowedProjectRoots;
    if (permitted.length) {
      let allowed = false; for (const entry of permitted) { try { if (inside(await fs.realpath(entry), root)) allowed = true; } catch {} }
      assert(allowed, 'PROJECT_PATH_DENIED', 'Project lies outside the owner-approved roots');
    }
    assert(!inside(root, this.dataDir), 'RECURSIVE_WORKSPACE', 'ACMS data must be stored outside the source project');
    if (project.mode === 'git') await git(['rev-parse', '--show-toplevel'], root);
    return root;
  }
  async prepare(task, attempt) {
    if (task.reviewOf) {
      if (task.workspace?.mode === 'review-copy') { await fs.access(task.workspace.path); return task.workspace; }
      const sourceTask = this.company.store.require('tasks', task.reviewOf);
      const destination = path.join(this.dataDir, 'reviews', task.id);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(sourceTask.workspace.path, destination, { recursive: true, force: false, errorOnExist: true, filter: async item => !['.git', 'node_modules', '.codex', '.env', 'auth.json', 'credentials.json'].includes(path.basename(item)) && !(await fs.lstat(item)).isSymbolicLink() });
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
    const ignore = new Set(['.git', 'node_modules', '.acms', '.codex', '.aws', '.ssh', 'auth.json', 'credentials.json']);
    await fs.cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false, filter: async item => {
      const name = path.basename(item); if (ignore.has(name) || name.startsWith('.env')) return false;
      return !(await fs.lstat(item)).isSymbolicLink();
    } });
    return syncCollaboration(this.company, project, task, { path: destination, source, mode: 'copy' });
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
  async collect(task, attempt, declared) {
    await verifyCollaboration(task.workspace);
    assert(Array.isArray(declared) && declared.length <= 100, 'INVALID_ARTIFACTS', 'At most 100 artifacts may be submitted');
    if (task.requiresArtifacts) assert(declared.length > 0, 'MISSING_ARTIFACTS', 'This task requires a concrete deliverable');
    const artifacts = [];
    for (const item of declared) {
      assert(!isCollaborationPath(path.normalize(item.path ?? '')), 'ARTIFACT_PATH', '.acms 是固定输入，交付物请写入普通任务文档');
      const filename = await this.safeFile(task.workspace.path, item.path); const bytes = await fs.readFile(filename);
      const hash = digest(bytes.toString('base64')); const blob = path.join(this.dataDir, 'artifacts', hash);
      await fs.mkdir(path.dirname(blob), { recursive: true });
      try { await fs.writeFile(blob, bytes, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      artifacts.push({ id: `artifact_${attempt.id}_${artifacts.length}`, taskId: task.id, attemptId: attempt.id, path: item.path, title: item.title ?? item.path, hash, bytes: bytes.length, blob });
    }
    const project = this.company.store.require('projects', task.projectId); const checkResults = [];
    for (const checkId of task.checkIds) {
      const check = (task.checksSnapshot ?? project.checks).find(c => c.id === checkId); assert(check, 'UNKNOWN_CHECK', `Configured check ${checkId} is missing from the task contract`);
      const result = await run(check.command, check.args, task.workspace.path, { timeout: check.timeoutMs ?? 120000, signal: attempt.signal });
      checkResults.push({ id: check.id, command: check.command, args: check.args, passed: result.code === 0 && !result.timedOut, ...result });
    }
    const changeSet = await this.captureChanges(task);
    return { artifacts, checks: checkResults, changeSet, hash: digest({ artifacts: artifacts.map(a => ({ path: a.path, hash: a.hash })), changeSet }) };
  }
  async captureChanges(task) {
    if (task.workspace.mode !== 'git') return null;
    const cwd = task.workspace.path;
    const tracked = await git(['diff', '--name-only', '-z', task.workspace.baseCommit ?? 'HEAD', '--'], cwd);
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    const names = [...new Set((tracked + '\0' + untracked).split('\0').filter(n => n && !isCollaborationPath(n)))].sort();
    assert(names.length <= 1000, 'CHANGE_LIMIT', 'A single reviewed submission may change at most 1000 files');
    const files = [];
    for (const name of names) {
      try { const filename = await this.safeFile(cwd, name); files.push({ path: name, hash: digest((await fs.readFile(filename)).toString('base64')) }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; files.push({ path: name, deleted: true }); }
    }
    return files;
  }
  async unchanged(task, artifactIds) {
    try { await verifyCollaboration(task.workspace); } catch { return false; }
    for (const artifactId of artifactIds) {
      const a = this.company.store.require('artifacts', artifactId);
      try { const bytes = await fs.readFile(await this.safeFile(task.workspace.path, a.path)); if (digest(bytes.toString('base64')) !== a.hash) return false; } catch { return false; }
    }
    if (task.changeSet && digest(await this.captureChanges(task)) !== digest(task.changeSet)) return false;
    return true;
  }
  async integrate(task) {
    const project = this.company.store.require('projects', task.projectId);
    if (!project.autoMerge) return { status: 'available', path: task.workspace.path, branch: task.workspace.branch };
    assert(task.workspace.mode === 'git', 'INTEGRATION_REQUIRED', 'Automatic integration requires a Git project');
    assert(await this.unchanged(task, task.artifactIds), 'ARTIFACT_CHANGED', 'Artifact changed after review');
    assert((await git(['status', '--porcelain', '--', '.', ':(exclude).acms'], project.repoRoot)) === '', 'TARGET_DIRTY', 'Source project has uncommitted changes; integration is blocked');
    await git(['add', '--all', '--', '.', ':(exclude).acms'], task.workspace.path);
    const changes = await git(['diff', '--cached', '--name-only'], task.workspace.path);
    if (changes) await git(['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', 'commit', '-m', `ACMS: ${task.title.replace(/[\r\n]/g, ' ')}`], task.workspace.path);
    const commit = await git(['rev-parse', 'HEAD'], task.workspace.path);
    const targetHead = await git(['rev-parse', 'HEAD'], project.repoRoot);
    const candidate = path.join(this.dataDir, 'integration', `${task.id}-${randomUUID()}`);
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await git(['worktree', 'add', '--detach', candidate, targetHead], project.repoRoot);
    const result = await run('git', ['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', 'merge', '--no-edit', '--no-ff', commit], candidate);
    assert(result.code === 0, 'MERGE_CONFLICT', 'Integration conflict in isolated candidate; source was not changed', { output: result.stderr || result.stdout, candidate });
    const checks = [];
    for (const check of project.checks) { const r = await run(check.command, check.args, candidate, { timeout: check.timeoutMs ?? 120000 }); checks.push({ id: check.id, passed: r.code === 0 && !r.timedOut, ...r }); }
    assert(checks.every(c => c.passed), 'INTEGRATION_CHECK_FAILED', 'Candidate integration failed checks; source was not changed', { checks, commit, candidate });
    assert((await git(['diff', '--name-only', 'HEAD'], candidate)) === '', 'CHECK_MODIFIED_CODE', 'Acceptance checks modified tracked files in the integration candidate');
    assert((await git(['status', '--porcelain', '--', '.', ':(exclude).acms'], project.repoRoot)) === '' && (await git(['rev-parse', 'HEAD'], project.repoRoot)) === targetHead, 'TARGET_CHANGED', 'Source changed while validating integration; merge was not applied');
    const integratedCommit = await git(['rev-parse', 'HEAD'], candidate);
    await git(['merge', '--ff-only', integratedCommit], project.repoRoot);
    return { status: 'merged', commit, integratedCommit, checks, candidate };
  }
}
