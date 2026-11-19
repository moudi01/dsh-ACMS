import { lstatSync } from 'node:fs';
import path from 'node:path';
import { assert } from './util.js';

export const WORKTREE_RESTORE_HOLD = '.acms-worktrees-restoring';

export function worktreeRestorePending(directory) {
  try { return !!lstatSync(path.join(directory, WORKTREE_RESTORE_HOLD), { throwIfNoEntry: false }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function assertWorktreeRestoreReady(directory) {
  assert(!worktreeRestorePending(directory), 'RESTORE_WORKTREES_PENDING',
    '恢复目录的 Git 工作副本仍待核验。请查看该目录的 REBUILD.md 后续接恢复。');
}
