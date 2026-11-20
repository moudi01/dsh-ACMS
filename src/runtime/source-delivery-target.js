import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { assert, digest } from '../core/util.js';

const samePath = (left, right) => path.relative(left, right) === '';
const failure = '无法核对项目 Git 目录。请恢复已授权的 Git 元数据，或选择已授权裸交付仓库。';
export const sourceGitPathArgs = ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'];

export function sourceGitPaths(output) {
  const paths = output.trimEnd().split(/\r?\n/);
  assert(paths.length === 2 && paths.every(directory => path.isAbsolute(directory)), 'TARGET_CHANGED', failure);
  const [gitDir, commonDir] = paths.map(directory => realpathSync(directory));
  return { gitDir, commonDir };
}

function metadataFile(filename, allowDirectory = false) {
  const stat = lstatSync(filename, { bigint: true, throwIfNoEntry: false });
  assert(stat && !stat.isSymbolicLink() && stat.ino !== 0n && samePath(realpathSync(filename), filename) &&
    ((allowDirectory && stat.isDirectory()) || (stat.isFile() && stat.size <= 65536n)), 'TARGET_CHANGED', failure);
  return { identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, content: stat.isFile() ? digest(readFileSync(filename).toString('base64')) : null };
}

export function sourceDeliveryTargetIdentity(root, { gitDir, commonDir }) {
  const directories = [root, gitDir, commonDir];
  const identity = directories.map(directory => {
    const stat = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    assert(stat?.isDirectory() && !stat.isSymbolicLink() && stat.ino !== 0n && samePath(directory, realpathSync(directory)), 'TARGET_CHANGED', failure);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  });
  return digest({ identity, gitDir, commonDir, marker: metadataFile(path.join(root, '.git'), true),
    commonPointer: samePath(gitDir, commonDir) ? null : metadataFile(path.join(gitDir, 'commondir')) });
}

export function assertSourceDeliveryTarget(root, expected, paths) {
  assert(sourceDeliveryTargetIdentity(root, paths) === expected, 'TARGET_CHANGED', '项目 Git 目录身份已变化，请恢复原仓库并重新预览。');
}

export function assertSourceReferencePolicy(hooks) {
  assert(path.isAbsolute(hooks) && !lstatSync(path.join(hooks, 'reference-transaction'), { throwIfNoEntry: false }),
    'TARGET_REF_UNSUPPORTED', '项目设置了 Git 引用事务策略。请用该仓库原有流程，或选择已授权的独立裸交付仓库。');
}
