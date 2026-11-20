import { lstatSync, linkSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AcmsError, assert } from '../core/util.js';
import { inside, run } from './workspaces.js';

const samePath = (a, b) => path.relative(a, b) === '';
const busy = '裸交付仓库已有工作副本或 Git 占用。请选择独立裸仓库，或等原 Git 操作完成后重新预览。';
export const bareHooksArgs = ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'];
export const barePolicyArgs = ['config', '--get-regexp', '^(receive|transfer)\\.(hiderefs|procreceiverefs)$'];

function entry(filename) {
  try { return lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }

function directoryIdentity(root) {
  const stat = entry(root);
  assert(stat?.isDirectory() && !stat.isSymbolicLink() && stat.ino !== 0n && samePath(realpathSync(root), root),
    'BARE_TARGET_CHANGED', '无法核对裸交付仓库的目录身份。请恢复原目录后重新核对。');
  return identity(stat);
}

export function assertBareTargetIdentity(root, expected) {
  assert(directoryIdentity(root) === expected, 'BARE_TARGET_CHANGED', '裸交付仓库的目录已被替换。请恢复原目录后重新核对。');
}

export function assertBareMetadataPaths(root, ref) {
  const folders = ['objects', 'objects/pack', 'refs', 'logs'];
  if (ref) {
    const parts = ref.split('/');
    for (let length = 2; length < parts.length; length++) {
      const prefix = parts.slice(0, length).join('/');
      folders.push(prefix, 'logs/' + prefix);
    }
  }
  for (const relative of folders) {
    const filename = path.join(root, relative);
    const stat = entry(filename);
    assert(!stat || (stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync(filename), filename)),
      'BARE_TARGET_CHANGED', '裸交付仓库的引用或对象目录经过链接，请使用独立的 Git 元数据目录。');
  }
}

export function assertBareRepositoryPolicy(hooks, policyStatus) {
  const hooksWithPolicy = ['reference-transaction', 'pre-receive', 'update', 'proc-receive', 'push-to-checkout'];
  assert(policyStatus === 1 && path.isAbsolute(hooks) && !hooksWithPolicy.some(name => entry(path.join(hooks, name))),
    'BARE_TARGET_REQUIRED', '裸交付仓库配置了引用或推送策略。请沿该仓库原有流程操作，或另选专用交付仓库。');
}

export async function inspectBareDeliveryTarget(workspaces, directory, invoke = run) {
  assert(typeof directory === 'string' && path.isAbsolute(directory) && !path.parse(directory).root.startsWith('\\\\'),
    'BARE_TARGET_REQUIRED', '请在项目设置中授权一个本机裸 Git 交付仓库。');
  const root = await workspaces.validateProject({ repoRoot: directory, mode: 'copy' }, invoke);
  assert(!inside(realpathSync(workspaces.dataDir), root), 'PROJECT_PATH_DENIED', '裸交付仓库必须位于 ACMS 数据目录之外。');
  const targetIdentity = directoryIdentity(root);
  const options = { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) };
  const result = await invoke('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--is-bare-repository', '--show-ref-format'], root, options);
  const [gitDir, bare, format] = result.stdout.trim().split(/\r?\n/);
  assert(result.code === 0 && !result.timedOut && gitDir && bare === 'true' && format === 'files' && samePath(realpathSync(gitDir), root),
    'BARE_TARGET_REQUIRED', '请选择独立的裸 Git 交付仓库（files 引用格式）。');
  assertBareTargetIdentity(root, targetIdentity);
  assertBareMetadataPaths(root);
  assert(!['worktrees', 'index', 'index.lock'].some(name => entry(path.join(root, name))), 'BARE_TARGET_BUSY', busy);
  const hooks = await invoke('git', bareHooksArgs, root, options);
  const policy = await invoke('git', barePolicyArgs, root, options);
  assert(hooks.code === 0 && !hooks.timedOut && !policy.timedOut, 'GIT_ERROR', '无法核对裸交付仓库的引用策略。');
  assertBareRepositoryPolicy(hooks.stdout.trim(), policy.code);
  return { targetRoot: root, targetIdentity };
}

export function bareFenceRef(id) {
  assert(/^integration_[a-f0-9-]+$/.test(id), 'BARE_TARGET_CHANGED', '无法核对 Git 执行记录。');
  // Git accepts all-letter names ending in _HEAD as root refs. Unlike normal
  // refs, these aren't advertised to clones or moved into packed-refs.
  const name = id.slice('integration_'.length).replaceAll('-', '').replace(/[a-f0-9]/g, letter =>
    String.fromCharCode(65 + Number.parseInt(letter, 16)));
  return `ACMS_FENCE_${name}_HEAD`;
}

function filesFor(record) {
  const { targetRoot, targetIdentity, integratedCommit } = record;
  assertBareTargetIdentity(targetRoot, targetIdentity);
  assert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(integratedCommit), 'BARE_TARGET_CHANGED', '无法核对 Git 交付提交。');
  const ref = bareFenceRef(record.id);
  return { proof: path.join(targetRoot, ref), stage: path.join(targetRoot, `.${ref}.pending`), content: integratedCommit + '\n',
    index: path.join(targetRoot, 'index'), indexLock: path.join(targetRoot, 'index.lock'), worktrees: path.join(targetRoot, 'worktrees') };
}

function ownedFile(filename, content) {
  const stat = entry(filename);
  return stat?.isFile() && !stat.isSymbolicLink() && stat.size === BigInt(content.length) && readFileSync(filename, 'utf8') === content ? stat : null;
}

function sameFile(stat, filename) {
  const other = entry(filename);
  return !!other?.isFile() && !other.isSymbolicLink() && identity(stat) === identity(other);
}

export function acquireBareDeliveryFence(record) {
  const { stage, proof, index, indexLock, worktrees, content } = filesFor(record);
  try {
    writeFileSync(stage, content, { flag: 'wx', flush: true });
    linkSync(stage, proof);
    // These names are actually acquired by Git when creating a linked
    // worktree or modifying the bare repository's default index.
    linkSync(stage, worktrees);
    linkSync(stage, indexLock);
    assert(!entry(index), 'BARE_TARGET_BUSY', busy);
    assertBareDeliveryFence(record);
  } catch (error) {
    if (error.code === 'EEXIST') throw new AcmsError('BARE_TARGET_BUSY', busy);
    if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(error.code)) {
      throw new AcmsError('BARE_TARGET_BUSY', '无法在裸仓库原卷上创建排他占用。请选择支持硬链接且允许写入的本地裸仓库。');
    }
    throw error;
  }
}

export function assertBareDeliveryFence(record) {
  const { proof, index, indexLock, worktrees, content } = filesFor(record);
  const stat = ownedFile(proof, content);
  assert(stat && sameFile(stat, worktrees) && sameFile(stat, indexLock) && !entry(index),
    'BARE_TARGET_CHANGED', '无法核对本次裸仓库占用。请恢复原仓库或核对未结束的 Git 操作。');
}

export function releaseBareDeliveryFence(record) {
  const { stage, proof, indexLock, worktrees, content } = filesFor(record);
  const stat = ownedFile(stage, content) ?? ownedFile(proof, content);
  if (stat) {
    for (const filename of [indexLock, worktrees, proof, stage]) if (sameFile(stat, filename)) unlinkSync(filename);
    return;
  }
  const pending = entry(stage);
  // A crash while writing the private stage can leave an incomplete file,
  // but no shared name can have been linked to it before the write finished.
  if (pending?.isFile() && !pending.isSymbolicLink() && pending.nlink === 1n && pending.size < BigInt(content.length) &&
      content.startsWith(readFileSync(stage, 'utf8'))) unlinkSync(stage);
}
