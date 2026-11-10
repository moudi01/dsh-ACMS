import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { digest, packageName } from '../core/util.js';
import { windowsDirectoryAccess } from './owned-process.js';

const guidance = {
  preparation: ['项目依赖准备失败', '请核对锁文件、离线缓存或准备命令，修正后由所有者请求重试。'],
  package: ['缺少 Node 依赖', '请通过已批准的依赖准备流程在任务工作副本中提供此包。'],
  program: ['执行程序不可用', '请核对执行程序或配对入口，修正路径后重新预检。'],
  directory: ['目录不可用', '请核对所列目录及当前宿主身份的访问权限。'],
  tools: ['缺少任务必需的工具', '请核对当前执行角色的文件或命令工具挂载，或选择具备相应工具的已批准执行入口。'],
  authorization: ['任务必需的工具未获授权', '请核对当前执行入口的工具审批策略，或使用已有授权的入口。'],
  esbuild: ['esbuild 受执行环境权限限制', '请在受信宿主检查 esbuild 可执行文件及工作副本父目录的访问权限。'],
  acl: ['Windows ACL 检查受执行环境权限限制', '请用受信宿主执行 ACL 检查，或选择已验证能执行该检查的入口。'],
  cleanup: ['临时文件清理遭权限拒绝', '请核对临时目录中文件的删除权限及占用进程。'],
  authentication: ['执行入口认证失败', '请通过运行时的正式登录入口确认认证，再手动检测模型。'],
  sandbox: ['执行环境拒绝访问', '请核对执行入口的沙箱策略和工作副本的访问边界。'],
  protocol: ['执行器协议响应无效', '请核对配对执行器与 ACMS 的协议版本和启动参数。'],
  review: ['审查未取得环境证据', '请核对审查入口或使用受信宿主完成环境检查。'],
};

export function environmentFailure(code, subject, observable = false) {
  const [label, recovery] = guidance[code];
  return { code, subject, observable, fingerprint: digest(['acms-environment-v1', code, subject]),
    reason: label + '（' + subject + '）', recovery };
}

// Match only known environment diagnostics. Ordinary assertions and transient
// network failures keep their existing result and bounded retry paths.
export function classifyEnvironment(error, stage) {
  if (error?.environmentFailure) return error.environmentFailure;
  if (error?.code === 'PAIRED_PROTOCOL') return environmentFailure('protocol', 'ACMS runner');
  const message = String(error?.message ?? '').slice(0, 20000);
  if (/\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b/i.test(message)) return null;
  const missing = message.match(/(?:Cannot find (?:module|package)|MODULE_NOT_FOUND[: ]+)\s*['"]([^'"]+)['"]/i)?.[1] ??
    message.match(/^npm (?:ERR!|error) missing: ([^ ]+?)@[^ ]+/im)?.[1];
  if (missing && packageName.test(missing) && !/^(?:sk-|gh[pousr]_|github_pat_|acms_ag_)/i.test(missing)) return environmentFailure('package', missing, true);
  if (/\bSeSecurityPrivilege\b|Get-Acl.*(?:privilege|特权)/i.test(message)) return environmentFailure('acl', 'SeSecurityPrivilege');
  if (/\b(?:EPERM|EACCES)\b.{0,100}\b(?:unlink|rmdir)\b/i.test(message)) {
    return environmentFailure('cleanup', /\bunlink\b/i.test(message) ? 'unlink' : 'rmdir');
  }
  if (/esbuild|Cannot read directory "\.\.[^"]*"/i.test(message) && /EPERM|EACCES|access is denied|permission denied|拒绝访问/i.test(message)) {
    return environmentFailure('esbuild', /\bspawn\b/i.test(message) ? 'esbuild spawn' : 'esbuild directory');
  }
  if (/^(?:PAIRED_RUNNER_ERROR|PAIRED_RUN_FAILED|PROVIDER_FAILED)$/.test(error?.code ?? '') &&
      /\b(?:HTTP\s+401|invalid api key|unauthenticated|login required|not logged in)\b/i.test(message)) {
    return environmentFailure('authentication', 'runtime login');
  }
  if (stage === 'workspace' && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'PROJECT_PATH', 'PROJECT_PATH_DENIED'].includes(error?.code)) {
    return environmentFailure('directory', '工作副本准备');
  }
  if (/sandbox.{0,80}(?:denied|EPERM|EACCES|拒绝)|(?:EPERM|EACCES).{0,80}sandbox/i.test(message)) {
    return environmentFailure('sandbox', 'runtime sandbox');
  }
  return null;
}

export async function fileIdentity(filename, executable = false) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return null;
    await fs.access(filename, executable ? constants.X_OK : constants.R_OK);
    return [stat.size, stat.mtimeMs];
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}

export async function programIdentity(command, cwd) {
  if (command === 'node') return [process.version, await fileIdentity(process.execPath, true)];
  const suffix = process.platform === 'win32' && !path.extname(command) ? '.exe' : '';
  const locations = /[/\\]/.test(command) ? [path.resolve(cwd, command)] :
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir.replace(/^"|"$/g, ''), command));
  // Windows spawn with shell:false searches the current working directory too.
  if (process.platform === 'win32' && !/[/\\]/.test(command)) locations.unshift(path.resolve(cwd, command));
  for (const location of locations) {
    const identity = await fileIdentity(location + suffix, true);
    if (identity) return identity;
  }
  return null;
}

async function directoryStatus(entries) {
  const states = await Promise.all(entries.map(async ({ path: directory }) => {
    try { return (await fs.stat(directory)).isDirectory() ? 'present' : 'missing'; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'missing';
      if (['EACCES', 'EPERM'].includes(error.code)) return 'denied';
      return 'unknown';
    }
  }));
  const present = entries.filter((_, index) => states[index] === 'present');
  if (!present.length) return states;
  let access;
  if (process.platform === 'win32') {
    try {
      const codes = await windowsDirectoryAccess(present);
      access = codes.map(code => code === 0 ? 'available' : [5, 1314].includes(code) ? 'denied' : 'unknown');
    } catch { access = []; }
  } else {
    access = await Promise.all(present.map(async ({ path: directory, write }) => {
      try { await fs.access(directory, constants.R_OK | constants.X_OK | (write ? constants.W_OK : 0)); return 'available'; }
      catch (error) { return ['EACCES', 'EPERM'].includes(error.code) ? 'denied' : 'unknown'; }
    }));
  }
  return states.map(state => state === 'present' ? access.shift() ?? 'unknown' : state);
}

async function hasPackage(cwd, name) {
  const require = createRequire(path.join(cwd, 'package.json'));
  // Resolve without importing the package. Package exports can hide the
  // manifest or entry point, so inspect Node's search directories as well.
  try { require.resolve(name); return true; } catch {}
  for (const directory of require.resolve.paths(name) ?? []) {
    if (await fileIdentity(path.join(directory, name, 'package.json'))) return true;
  }
  return false;
}

export async function inspectHost(workspaces, task, previous) {
  const project = workspaces.company.store.require('projects', task.projectId);
  const cwd = task.workspace?.path;
  const entries = [];
  if (task.reviewScope !== 'goal' && (!task.reviewOf || !cwd)) {
    const source = task.reviewOf ? workspaces.company.store.get('tasks', task.reviewOf)?.workspace?.path : project.repoRoot;
    if (source) entries.push({ subject: task.reviewOf ? '被审工作副本' : '项目源目录', path: source, write: false });
  }
  if (!cwd && project.mode === 'git' && !task.reviewOf && task.reviewScope !== 'goal') {
    const gitDir = path.join(project.repoRoot, '.git');
    if (await fs.stat(gitDir).then(stat => stat.isDirectory(), error => ['EACCES', 'EPERM'].includes(error.code))) {
      entries.push({ subject: 'Git 工作树元数据目录', path: gitDir, write: true });
    }
  }
  if (cwd) entries.push({ subject: '任务工作副本', path: cwd, write: task.kind !== 'review' });
  else {
    // WorkspaceManager creates workspaces/reviews under an existing data root.
    const parent = path.join(workspaces.dataDir, task.kind === 'review' ? 'reviews' : 'workspaces');
    const exists = await fs.stat(parent).then(() => true, error => !['ENOENT', 'ENOTDIR'].includes(error.code));
    entries.push({ subject: exists ? '工作副本父目录' : 'ACMS 数据目录', path: exists ? parent : workspaces.dataDir, write: true });
  }
  if (cwd && previous?.failures?.some(failure => failure.code === 'esbuild' && failure.subject === 'esbuild directory')) {
    let parent = path.dirname(cwd);
    for (let depth = 1; depth <= 12; depth++) {
      entries.push({ subject: 'esbuild 上级目录 ' + depth, path: parent, write: false });
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  const states = await directoryStatus(entries);
  const directories = entries.map(({ subject }, index) => ({ subject, status: states[index] }));
  const allowedRoots = workspaces.company.policy().allowedProjectRoots ?? [];
  if (!task.reviewOf && task.reviewScope !== 'goal' && allowedRoots.length && directories[0]?.status === 'available') {
    const source = await fs.realpath(project.repoRoot).catch(() => null);
    const roots = await Promise.all(allowedRoots.map(root => fs.realpath(root).catch(() => null)));
    const allowed = source && roots.some(root => {
      if (!root) return false;
      const relative = path.relative(root, source);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
    if (source) directories.push({ subject: '项目目录授权范围', status: allowed ? 'available' : 'denied' });
  }
  const checks = (task.checksSnapshot ?? project.checks).filter(check => task.checkIds?.includes(check.id));
  const programs = await Promise.all(checks.map(async check => {
    // Relative programs belong to the prepared copy, not the source project.
    const identity = cwd || !/[/\\]/.test(check.command) || path.isAbsolute(check.command) ?
      await programIdentity(check.command, cwd ?? project.repoRoot) : undefined;
    return { subject: '验收检查 ' + (packageName.test(check.id) ? check.id : '#' + (checks.indexOf(check) + 1)),
      status: identity === undefined ? 'unknown' : identity ? 'available' : 'missing', version: identity ? digest(identity) : null };
  }));
  if (project.mode === 'git' && !task.reviewOf && task.reviewScope !== 'goal') {
    const identity = await programIdentity('git', project.repoRoot);
    programs.push({ subject: 'Git', status: identity ? 'available' : 'missing', version: identity ? digest(identity) : null });
  }
  const required = [...new Set(checks.flatMap(check => check.requiredPackages ?? []))];
  const learned = previous?.failures?.filter(failure => failure.code === 'package').map(failure => failure.subject) ?? [];
  const packages = await Promise.all([...new Set([...required, ...learned])].filter(name => packageName.test(name)).sort().map(async subject => ({
    subject, status: cwd ? await hasPackage(cwd, subject) ? 'available' : 'missing' : 'unknown',
  })));
  const failures = [
    ...directories.filter(item => ['missing', 'denied'].includes(item.status)).map(item => environmentFailure('directory', item.subject, true)),
    ...programs.filter(item => item.status === 'missing').map(item => environmentFailure('program', item.subject, true)),
    ...packages.filter(item => item.status === 'missing').map(item => environmentFailure('package', item.subject, true)),
  ];
  return { directories, programs, packages, failures, preparationVersion: digest(project.preparation ?? null) };
}
