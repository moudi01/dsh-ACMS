import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { readCommandCleanup } from '../src/runtime/host-command.js';

const call = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => path.relative(left, right) === '';
const gitPath = value => value.split(path.sep).join('/');
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'archived', 'deleted']);
const pendingIntegration = new Set(['preparing', 'checking', 'applying', 'reconciling']);
const identifier = /^[a-zA-Z0-9_-]+$/;
const oid = /^[a-f0-9]{40}([a-f0-9]{24})?$/;

function requireMatch(condition, reason) {
  if (!condition) throw new Error(reason);
}

async function stat(filename) {
  return fs.lstat(filename).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
}

async function textFile(filename) {
  const info = await stat(filename);
  requireMatch(info?.isFile() && !info.isSymbolicLink() && info.size <= 4096, 'Git 登记文件缺失或类型不受支持');
  const bytes = await fs.readFile(filename);
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  requireMatch(text && !/[\x00-\x1f]/.test(text), 'Git 登记文件内容无效');
  return { bytes, text };
}

const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
});
async function git(cwd, ...args) {
  const { stdout } = await call('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', timeout: 10000, windowsHide: true,
  });
  return stdout;
}

async function gitText(cwd, ...args) {
  return (await git(cwd, ...args)).toString('utf8').replace(/\r?\n$/, '');
}

async function references(databaseFile, root, files) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  let entities;
  try {
    entities = database.prepare("SELECT collection,id,body FROM entities WHERE collection IN ('tasks','integrations','projects')").all()
      .map(row => ({ ...row, body: JSON.parse(row.body) }));
  } finally { database.close(); }
  const projects = new Map(entities.filter(row => row.collection === 'projects').map(row => [row.id, row.body]));
  const dependencies = new Map();
  for (const { collection, id, body } of entities) {
    if (collection !== 'integrations' || !pendingIntegration.has(body.phase)) continue;
    const receipts = [body.commandId, body.inspectionCommandId].filter(Boolean);
    if (body.taskId) dependencies.set(body.taskId, [...(dependencies.get(body.taskId) ?? []), ...receipts]);
    if (body.candidate) dependencies.set(id, receipts);
  }
  const refs = [];
  for (const { collection, id, body } of entities) {
    if (collection === 'projects') continue;
    const candidate = collection === 'integrations';
    const workspace = body.workspace;
    const relative = `${candidate ? 'integration' : 'workspaces'}/${id}`;
    const hasPointer = files.has(relative + '/.git');
    const referenced = candidate ? pendingIntegration.has(body.phase) && !!body.candidate
      : workspace && (workspace.mode === 'git' || (workspace.branch && hasPointer)) &&
        (hasPointer || !terminal.has(body.status) || dependencies.has(id));
    if (!referenced) continue;
    const target = candidate ? body.candidate : workspace.path;
    const source = candidate ? body.targetRoot : workspace.source ?? projects.get(body.projectId)?.repoRoot;
    const branch = candidate ? null : 'refs/heads/acms/' + id;
    const reason = !identifier.test(id) || typeof target !== 'string' || !path.isAbsolute(target) ||
      !samePath(target, path.join(root, relative)) ? '工作副本路径与 ACMS 登记不匹配'
      : !hasPointer ? '备份缺少工作副本的 Git 指针'
      : typeof source !== 'string' || !path.isAbsolute(source) ? '缺少源 Git 仓库的绝对路径'
      : !candidate && workspace.branch !== 'acms/' + id ? '任务分支与 ACMS 登记不匹配'
      : null;
    refs.push({ relative, source, branch, reason, receipts: dependencies.get(id) ?? [] });
  }
  return refs;
}

function pointerDirectory(pointerFile) {
  requireMatch(pointerFile.text.startsWith('gitdir: '), '工作副本 Git 指针无效');
  const admin = pointerFile.text.slice(8);
  requireMatch(path.isAbsolute(admin), '相对 Git 指针需要先在源环境修复后重新备份');
  return admin;
}

async function sourceGitDirectory(source) {
  return gitText(source, 'rev-parse', '--path-format=absolute', '--git-common-dir').then(fs.realpath)
    .catch(() => { throw new Error('源 Git 仓库不可用，请恢复同一仓库后继续'); });
}

async function inspect(source, common, admin, branch) {
  const gitDir = await fs.realpath(admin).catch(() => { throw new Error('源仓库的工作副本登记缺失'); });
  requireMatch(samePath(gitDir, admin) && samePath(path.dirname(gitDir), path.join(common, 'worktrees')),
    'Git 指针超出源仓库的工作副本登记范围');
  const commonPointer = await textFile(path.join(gitDir, 'commondir'));
  requireMatch(samePath(await fs.realpath(path.resolve(gitDir, commonPointer.text)), common), 'Git 登记关联了其他仓库');
  const backlinkPath = path.join(gitDir, 'gitdir');
  const backlink = await textFile(backlinkPath);
  requireMatch(path.isAbsolute(backlink.text), '相对 Git 反向登记需要先在源环境修复后重新备份');
  requireMatch(!await stat(path.join(gitDir, 'index.lock')), 'Git 索引处于使用中，请停止原操作');
  const headFile = await textFile(path.join(gitDir, 'HEAD'));
  requireMatch(branch ? headFile.text === 'ref: ' + branch : oid.test(headFile.text),
    '实际 Git 分支或分离提交与 ACMS 登记不匹配');
  const head = await gitText(source, '--git-dir=' + gitDir, 'rev-parse', '--verify', 'HEAD^{commit}');
  requireMatch(oid.test(head), '无法核实已登记提交');
  const index = await stat(path.join(gitDir, 'index'));
  requireMatch(index?.isFile() && !index.isSymbolicLink(), 'Git 暂存索引缺失或类型不受支持');
  const stage = await git(source, '--git-dir=' + gitDir, 'ls-files', '--stage', '-z');
  return { common, gitDir, head, stage, stageHash: hash(stage), backlinkPath, backlink };
}

function relocatedAdmin(proof, destination) {
  return path.join(path.dirname(proof.gitDir), 'acms-restored-' + hash(proof.gitDir + '\0' + gitPath(destination)).slice(0, 32));
}

export function relocatedGitPointer(proof, destination) {
  if (typeof proof?.gitDir !== 'string' || !path.isAbsolute(proof.gitDir)) return null;
  return Buffer.from('gitdir: ' + gitPath(relocatedAdmin(proof, destination)) + '\n');
}

async function readGitObjects(source, registration) {
  const dir = '--git-dir=' + registration.gitDir;
  const rootTree = await gitText(source, dir, 'rev-parse', registration.head + '^{tree}');
  const objects = new Map([[registration.head, 'commit'], [rootTree, 'tree']]);
  const tree = await git(source, dir, 'ls-tree', '-r', '-t', '-z', registration.head);
  for (const line of tree.toString('utf8').split('\0').filter(Boolean)) {
    const [, type, object] = line.slice(0, line.indexOf('\t')).split(' ');
    if (type !== 'commit') objects.set(object, type); // Submodule objects live in another repository.
  }
  for (const line of registration.stage.toString('utf8').split('\0').filter(Boolean)) {
    const [mode, object] = line.slice(0, line.indexOf('\t')).split(' ');
    if (mode !== '160000') objects.set(object, 'blob');
  }
  const child = spawn('git', [dir, 'cat-file', '--batch'], {
    cwd: source, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const done = new Promise(resolve => {
    child.once('close', resolve);
    child.once('error', () => resolve(null));
  });
  const timeout = setTimeout(() => child.kill(), 30000);
  child.stdin.on('error', () => {});
  child.stdin.end([...objects.keys()].join('\n') + '\n');
  let header = '';
  let bytesLeft = 0;
  let objectId;
  let digest;
  try {
    for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        if (bytesLeft) {
          const count = Math.min(bytesLeft, chunk.length - offset);
          bytesLeft -= count;
          const dataEnd = offset + count - (bytesLeft === 0 ? 1 : 0);
          digest.update(chunk.subarray(offset, dataEnd));
          offset += count;
          requireMatch(bytesLeft !== 0 || (chunk[offset - 1] === 10 && digest.digest('hex') === objectId),
            'Git 对象内容损坏，请从源仓库备份恢复对象 ' + objectId);
          continue;
        }
        const end = chunk.indexOf(10, offset);
        header += chunk.toString('ascii', offset, end < 0 ? chunk.length : end);
        requireMatch(header.length < 200, 'Git 对象响应无效');
        if (end < 0) break;
        const [object, type, size] = header.split(' ');
        requireMatch(oid.test(object) && objects.get(object) === type && /^\d+$/.test(size) && Number.isSafeInteger(Number(size) + 1),
          'Git 提交树或暂存对象不可读，请从源仓库备份恢复对象 ' + object);
        objects.delete(object);
        objectId = object;
        digest = createHash(object.length === 64 ? 'sha256' : 'sha1').update(type + ' ' + size + '\0');
        bytesLeft = Number(size) + 1;
        header = '';
        offset = end + 1;
      }
    }
    requireMatch(await done === 0 && objects.size === 0 && bytesLeft === 0 && !header, 'Git 提交树或暂存对象读取不完整，请恢复源仓库对象');
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await done; }
}

export async function backupWorktreeEvidence(databaseFile, root, files) {
  const evidence = [];
  for (const ref of await references(databaseFile, root, files)) {
    const { relative, source, branch } = ref;
    try {
      requireMatch(!ref.reason, ref.reason);
      const original = path.join(root, relative);
      requireMatch(samePath(await fs.realpath(original), original), '原工作副本路径经过链接');
      const pointer = await textFile(path.join(original, '.git'));
      const pointerHash = hash(pointer.bytes);
      const common = await sourceGitDirectory(source);
      const { gitDir, head, stageHash, backlink } = await inspect(source, common, pointerDirectory(pointer), branch);
      requireMatch(samePath(backlink.text, path.join(original, '.git')), 'Git 登记未指向当前工作副本');
      const file = files.get(relative + '/.git');
      requireMatch(!file.sha256 || file.sha256 === pointerHash, '备份期间 Git 指针发生变化');
      evidence.push({ relative, source, branch, common, gitDir, head, pointerHash, stageHash });
    } catch (error) {
      evidence.push({ relative, reason: error.message });
    }
  }
  return evidence;
}

export async function pendingWorktreeRefs(databaseFile, root, files) {
  return references(databaseFile, root, new Map(files.map(file => [file.path, file])));
}

async function restorationPlan(ref, evidence, destination, originalRoot) {
  requireMatch(!ref.reason, ref.reason);
  requireMatch(evidence && !evidence.reason, evidence?.reason ?? '旧备份缺少 Git 暂存证据，请从原环境重新备份');
  requireMatch(evidence.source === ref.source && evidence.branch === ref.branch, '备份 Git 证据与任务登记不一致');
  const workspace = path.join(destination, ref.relative);
  const original = path.join(originalRoot, ref.relative);
  requireMatch(!await stat(original), '原工作副本仍在。请停止原宿主，把原副本移到保留位置后继续');
  requireMatch(samePath(await fs.realpath(workspace), workspace), '恢复工作副本路径经过链接');
  for (const commandId of ref.receipts) {
    requireMatch(typeof commandId === 'string' && identifier.test(commandId) &&
      await readCommandCleanup(path.join(destination, 'integration-receipts', commandId + '.json')),
    '在途 Git 命令的清理回执无法确认，请先核对原执行');
  }
  const targetPointer = path.join(workspace, '.git');
  const pointer = await textFile(targetPointer);
  const newPointer = relocatedGitPointer(evidence, destination);
  requireMatch(newPointer && (pointer.bytes.equals(newPointer) ||
    (hash(pointer.bytes) === evidence.pointerHash && samePath(pointerDirectory(pointer), evidence.gitDir))),
    '恢复工作副本的 Git 指针与备份登记不一致');
  const newAdmin = relocatedAdmin(evidence, destination);
  const common = await sourceGitDirectory(ref.source);
  const oldExists = await stat(evidence.gitDir);
  const newExists = await stat(newAdmin);
  requireMatch(!!oldExists !== !!newExists, '源 Git 登记缺失或恢复登记位置已被占用');
  const current = await inspect(ref.source, common, oldExists ? evidence.gitDir : newAdmin, ref.branch);
  for (const key of ['common', 'head', 'stageHash']) {
    requireMatch(current[key] === evidence[key], '源 Git 目录、提交或暂存内容与备份证据不一致');
  }
  const replacement = path.join(workspace, '.git');
  const alreadyLinked = samePath(current.backlink.text, replacement);
  requireMatch(samePath(current.backlink.text, path.join(original, '.git')) || (!oldExists && alreadyLinked),
    'Git 登记已被其他工作副本使用');
  return { ...current, workspace, original, replacement, source: ref.source, alreadyLinked,
    pointer, newPointer, newAdmin, oldAdmin: evidence.gitDir, targetPointer, moved: !oldExists };
}

async function replaceGitFile(filename, bytes, expected, stagedAt = filename) {
  const stage = stagedAt + '.acms-' + randomUUID();
  try {
    await fs.writeFile(stage, bytes, { flag: 'wx', flush: true });
    requireMatch((await textFile(filename)).bytes.equals(expected), 'Git 登记在恢复期间发生变化');
    await fs.rename(stage, filename);
  } finally {
    await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function recoverWorktrees(refs, evidence, destination, originalRoot, stagingDirectory) {
  const planned = [];
  const issues = [];
  const inventory = new Map((evidence ?? []).map(record => [record.relative, record]));
  for (const ref of refs) {
    try {
      const proof = inventory.get(ref.relative);
      const registration = await restorationPlan(ref, proof, destination, originalRoot);
      await readGitObjects(registration.source, registration);
      planned.push({ ref, evidence: proof });
    } catch (error) {
      issues.push({ path: ref.relative, reason: error.message });
    }
  }
  if (issues.length) return { ready: false, verified: [], issues };

  const undo = [];
  try {
    for (const { ref, evidence: proof } of planned) {
      const registration = await restorationPlan(ref, proof, destination, originalRoot);
      const { workspace, oldAdmin, newAdmin, moved, alreadyLinked, targetPointer, pointer, newPointer, backlink } = registration;
      if (!moved) {
        await fs.rename(oldAdmin, newAdmin);
        undo.push({ workspace, action: async () => {
          requireMatch(!await stat(oldAdmin), '原 Git 登记路径已被占用');
          await fs.rename(newAdmin, oldAdmin);
        } });
      }
      if (!alreadyLinked) {
        const back = path.join(newAdmin, 'gitdir');
        const destinationPointer = Buffer.from(gitPath(registration.replacement) + '\n');
        await replaceGitFile(back, destinationPointer, backlink.bytes);
        undo.push({ workspace, action: () => replaceGitFile(back, backlink.bytes, destinationPointer) });
      }
      if (!pointer.bytes.equals(newPointer)) {
        const stagedAt = path.join(stagingDirectory, 'pointer');
        await replaceGitFile(targetPointer, newPointer, pointer.bytes, stagedAt);
        undo.push({ workspace, action: () => replaceGitFile(targetPointer, pointer.bytes, newPointer, stagedAt) });
      }
    }
    for (const { ref, evidence: proof } of planned) {
      const registration = await restorationPlan(ref, proof, destination, originalRoot);
      const actual = await fs.realpath(await gitText(registration.workspace, 'rev-parse', '--show-toplevel'));
      const stage = await git(registration.workspace, 'ls-files', '--stage', '-z');
      const listed = await git(registration.source, 'worktree', 'list', '--porcelain', '-z');
      const registered = listed.toString('utf8').split('\0').filter(field => field.startsWith('worktree '));
      requireMatch(registration.moved && registration.alreadyLinked && samePath(actual, registration.workspace) && hash(stage) === proof.stageHash &&
        registered.some(field => samePath(field.slice(9), registration.workspace)), '恢复后的路径未通过 Git 工作副本核验');
    }
    return { ready: true, verified: planned.map(({ ref }) => ref.relative), issues: [] };
  } catch (error) {
    for (const { workspace, action } of undo.reverse()) {
      try { await action(); }
      catch (rollback) { issues.push({ path: workspace, reason: '回滚 Git 登记时需人工核对：' + rollback.message }); }
    }
    issues.push({ path: destination, reason: error.message });
    return { ready: false, verified: [], issues };
  }
}
