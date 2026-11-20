import { promises as fs, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assert, digest, id, now, OWNER, text } from '../core/util.js';
import { candidateMergeActive, candidateMergeMatches, candidateMergePolicy, candidateMergeSelection, verifyCandidateConfirmation } from '../core/candidate-confirmation.js';
import { checkoutComposition } from './git-composition.js';
import { removeTemporary } from './git-delivery.js';
import { run } from './workspaces.js';

const maximumDiff = 4 * 1024 * 1024;
const gitList = ['worktree', 'list', '--porcelain', '-z'];
const samePath = (a, b) => path.relative(a, b) === '';
const verifiedRef = ref => ['show-ref', '--verify', '--hash', '--', ref];
const targetRef = value => {
  const ref = text(value, 'targetRef', 1024);
  assert(ref.startsWith('refs/heads/'), 'INVALID_INPUT', '请输入完整本地分支名，例如 refs/heads/main。');
  return ref;
};

export function candidateGitEnvironment() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
}

function gitInvoker(invoke, signal, dates) {
  const env = candidateGitEnvironment();
  return (command, args, cwd, options) => invoke(command, args, cwd, {
    ...options, signal, env: { ...env, ...options?.env, ...dates, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  });
}

async function git(invoke, args, cwd, options) {
  const result = await invoke('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], cwd, options);
  assert(result.code === 0 && !result.timedOut, 'GIT_ERROR', result.stderr || 'Git 无法核对候选或目标分支。');
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

function worktrees(output) {
  assert(output.length < maximumDiff && output.endsWith('\0\0'), 'GIT_ERROR', '无法完整读取 Git 工作副本列表。');
  return output.slice(0, -2).split('\0\0').map(entry => Object.fromEntries(entry.split('\0').map(field => {
    const index = field.indexOf(' ');
    return index < 0 ? [field, ''] : [field.slice(0, index), field.slice(index + 1)];
  })));
}

function assertReservation(list, ref, expected) {
  const occupied = list.filter(entry => entry.branch === ref);
  if (!expected) {
    assert(!occupied.length, 'TARGET_BRANCH_CHECKED_OUT', `目标分支已在 ${occupied[0]?.worktree ?? ''} 检出。请选择未检出的本地分支，或先在该目录切换分支。`);
    return;
  }
  assert(occupied.length === 1 && samePath(occupied[0].worktree, expected.path) && occupied[0].locked === expected.reason,
    'TARGET_BRANCH_CHECKED_OUT', '无法验证目标分支仅由 ACMS 临时占用，请恢复原有登记后重新核对。');
}

async function inspectTarget(workspaces, project, goal, selection, ref, invoke, reservation) {
  const root = await workspaces.validateProject(project, invoke);
  const repository = await fs.realpath(await git(invoke, ['rev-parse', '--show-toplevel'], root));
  assert(samePath(repository, root) && samePath(goal.compositionBase.source, root),
    'PROJECT_PATH_DENIED', '目标必须是该候选批准的项目 Git 根目录。');
  await git(invoke, ['check-ref-format', ref], root);
  const targetHead = await git(invoke, verifiedRef(ref), root);
  const symref = await git(invoke, ['for-each-ref', '--format=%(refname) %(symref)', '--', ref], root);
  assert(symref.split(/\r?\n/).find(line => line.split(' ')[0] === ref)?.trim() === ref,
    'TARGET_REF_UNSUPPORTED', '请选择存在的直接本地分支。');
  assertReservation(worktrees(await git(invoke, gitList, root, { maxOutput: maximumDiff })), ref, reservation);
  const tree = await git(invoke, ['rev-parse', '--verify', targetHead + '^{tree}'], root);
  const base = await git(invoke, ['rev-parse', '--verify', selection.baseCommit + '^{tree}'], root);
  assert(tree === base || tree === selection.tree, 'TARGET_BASE_CHANGED',
    '目标分支的文件树已不同于候选基线。请基于该分支生成并联合核验新候选。');
  return { targetRoot: root, targetRef: ref, targetHead, targetTree: tree };
}

export function assertCandidateReservation(record, executable) {
  const { targetRoot, targetRef, targetHead, targetTree, targetCandidateTree, integratedCommit, ownerReservation } = record;
  const check = args => {
    const result = spawnSync(executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd: targetRoot, env: candidateGitEnvironment(), windowsHide: true, encoding: 'utf8', maxBuffer: maximumDiff, timeout: 5000,
    });
    assert(!result.error && result.status === 0, 'GIT_ERROR', result.error?.message || result.stderr || '无法核对已确认的 Git 分支。');
    return args.includes('-z') ? result.stdout : result.stdout.trim();
  };
  assert(samePath(realpathSync(targetRoot), targetRoot) && samePath(realpathSync(ownerReservation.path), ownerReservation.path),
    'TARGET_CHANGED', '项目目录或分支预留路径已变化。');
  assertReservation(worktrees(check(gitList)), targetRef, ownerReservation);
  assert(check(verifiedRef(targetRef)) === targetHead && check(['rev-parse', '--verify', targetHead + '^{tree}']) === targetTree &&
    check(['rev-parse', '--verify', integratedCommit + '^{tree}']) === targetCandidateTree &&
    check(['rev-list', '--parents', '-n', '1', integratedCommit]) === `${integratedCommit} ${targetHead}`,
  'TARGET_CHANGED', '最终更新前无法核对已确认的目标及候选树。');
}

export async function releaseCandidateReservation(workspaces, record, invoke) {
  const { ownerReservation: reservation, targetRoot } = record;
  const parent = path.join(await fs.realpath(workspaces.dataDir), 'integration');
  assert(/^integration_[\da-f-]+$/i.test(record.id) && samePath(reservation.path, path.join(parent, record.id)) &&
    reservation.reason === `acms-owner-${record.id}` &&
    samePath(await fs.realpath(targetRoot), targetRoot) && samePath(await fs.realpath(parent), parent),
  'TARGET_CHANGED', '无法核对 ACMS 目标分支预留的路径。');
  const entry = worktrees(await git(invoke, gitList, targetRoot, { maxOutput: maximumDiff }))
    .find(row => samePath(row.worktree, reservation.path));
  const info = await fs.lstat(reservation.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!entry && !info) return;
  assert(entry?.locked === reservation.reason && (!entry.branch || entry.branch === record.targetRef) && (!info ||
    (info.isDirectory() && !info.isSymbolicLink() && samePath(await fs.realpath(reservation.path), reservation.path))),
  'TARGET_CHANGED', 'ACMS 临时预留不再匹配，请核对登记并保留工作副本内容。');
  if (info) {
    const files = await fs.readdir(reservation.path, { withFileTypes: true });
    assert(files.every(file => file.name === '.git' && file.isFile()), 'TARGET_CHANGED', 'ACMS 临时预留中出现文件，请保留该目录并核对来源。');
  }
  await git(invoke, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', '--force', '--', reservation.path], targetRoot);
}

function matchesTarget(current, expected) {
  return current.targetRef === expected.targetRef && current.targetHead === expected.targetHead && current.targetTree === expected.targetTree &&
    path.relative(current.targetRoot, expected.targetRoot) === '';
}

async function scratch(workspaces, prefix) {
  const root = await fs.realpath(workspaces.dataDir);
  const parent = path.join(root, 'integration');
  await fs.mkdir(parent, { recursive: true });
  assert((await fs.lstat(parent)).isDirectory() && await fs.realpath(parent) === parent, 'PROJECT_PATH_DENIED', '集成临时目录经过链接。');
  return { parent, directory: await fs.mkdtemp(path.join(parent, prefix)) };
}

async function loadTrees(goal, dataDir, target, directory, invoke, signal) {
  const checkout = path.join(directory, 'checkout');
  await checkoutComposition(goal.composition, checkout, directory, dataDir, invoke, signal);
  await git(invoke, ['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--', target.targetRoot, target.targetHead], checkout);
  assert(await git(invoke, ['rev-parse', '--verify', target.targetHead + '^{tree}'], checkout) === target.targetTree,
    'TARGET_CHANGED', '目标分支在核对期间变化，请重新预览。');
  return checkout;
}

async function changes(goal, target, checkout, invoke) {
  const changed = await git(invoke, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z',
    target.targetHead, goal.composition.bundle.commit, '--'], checkout, { maxOutput: maximumDiff });
  assert(changed.length < maximumDiff && (!changed || changed.endsWith('\0')), 'CHANGE_LIMIT', '候选路径清单超过可核对范围。');
  const parts = changed ? changed.slice(0, -1).split('\0') : [];
  assert(parts.length % 2 === 0, 'GIT_PATH_OUTPUT', '无法核对候选变更清单。');
  const items = [];
  for (let index = 0; index < Math.min(parts.length, 200); index += 2) items.push({ change: parts[index], path: parts[index + 1] });
  return { total: parts.length / 2, items };
}

export async function previewCandidateMerge(company, workspaces, input, signal) {
  const ref = targetRef(input.targetRef);
  const goal = company.store.require('goals', input.goalId);
  const project = company.store.require('projects', goal.projectId);
  const selection = candidateMergeSelection(company, goal);
  assert(selection, 'CANDIDATE_NOT_READY', '请先验收完整 Git 候选并完成模板要求的最终审查。');
  assert(selection.version === input.version && selection.deliveryHash === input.deliveryHash,
    'STALE_CANDIDATE_CONFIRMATION', '已验收候选发生变化，请刷新目标。');
  assert(!candidateMergeActive(goal.candidateMerge), 'CONFLICT', '已有确认请求正在执行或待核对。');
  const invoke = gitInvoker(run, signal);
  const policy = candidateMergePolicy(company, project);
  const target = await inspectTarget(workspaces, project, goal, selection, ref, invoke);
  const taskId = goal.composition.inputs[0]?.taskId;
  assert(taskId, 'CANDIDATE_NOT_READY', '候选缺少已选任务。');
  const { parent, directory } = await scratch(workspaces, 'owner-preview-');
  try {
    const checkout = await loadTrees(goal, workspaces.dataDir, target, directory, invoke, signal);
    const summary = await changes(goal, target, checkout, invoke);
    assert(matchesTarget(await inspectTarget(workspaces, project, goal, selection, ref, invoke), target),
      'TARGET_CHANGED', '目标分支在预览期间变化，请重新预览。');
    signal?.throwIfAborted();
    return company.store.transaction(() => {
      const current = company.store.require('goals', goal.id);
      assert(candidateMergeMatches(company, current, { selection, policy }) && !candidateMergeActive(current.candidateMerge),
        'STALE_CANDIDATE_CONFIRMATION', '候选、项目授权或确认状态在预览期间变化，请重新预览。');
      const checks = goal.composition.checks.map(({ id, checkVersion, inputHash, environment, code, log }) =>
        ({ id, checkVersion, inputHash, environment, code, logHash: log?.hash ?? null }));
      const request = { id: id('candidate_preview'), status: 'previewed', previewedAt: now(), selection, policy, taskId, ...target, summary, checks };
      company.store.put('goals', { ...current, candidateMerge: request });
      company.store.event('goal.candidate_merge.previewed', goal.id, { previewId: request.id, selection, targetRef: ref,
        targetHead: target.targetHead }, OWNER, { goalId: goal.id });
      return request;
    });
  } finally { await removeTemporary(directory, parent); }
}

export async function checkCandidateMergeConfirmation(company, workspaces, args, signal) {
  const { goal, request } = verifyCandidateConfirmation(company, args);
  if (request.status !== 'previewed') return;
  const project = company.store.require('projects', goal.projectId);
  const target = await inspectTarget(workspaces, project, goal, request.selection, request.targetRef, gitInvoker(run, signal));
  assert(matchesTarget(target, request), 'TARGET_CHANGED', '目标 HEAD 已变化，请重新预览和确认。');
}

export async function applyConfirmedCandidate(company, workspaces, goal, request, execution) {
  const project = company.store.require('projects', goal.projectId);
  const { selection } = request;
  const invoke = gitInvoker(execution.run, execution.signal, { GIT_AUTHOR_DATE: request.confirmedAt, GIT_COMMITTER_DATE: request.confirmedAt });
  const verifyTarget = async reservation => {
    const target = await inspectTarget(workspaces, project, goal, selection, request.targetRef, invoke, reservation);
    assert(matchesTarget(target, request), 'TARGET_CHANGED', '目标 HEAD 已变化，请重新预览和确认。');
    return target;
  };
  const target = await verifyTarget();
  const { parent, directory } = await scratch(workspaces, execution.id + '-owner-');
  let retain = false;
  try {
    const checkout = await loadTrees(goal, workspaces.dataDir, target, directory, invoke, execution.signal);
    if (target.targetTree === selection.tree) {
      await verifyTarget();
      return { status: 'merged', actualHead: target.targetHead, integratedCommit: target.targetHead, targetRef: target.targetRef, proof: 'target-tree' };
    }
    const commit = await git(invoke, ['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', '-c', 'commit.gpgSign=false',
      'commit-tree', selection.tree, '-p', target.targetHead, '-m', `ACMS owner confirmation ${request.id}`], checkout);
    const ref = 'refs/heads/acms-confirmed';
    await git(invoke, ['update-ref', ref, commit], checkout);
    await verifyTarget();
    // Import objects only after the owner has confirmed. Fetch writes neither
    // a destination ref nor FETCH_HEAD. The final merge owns branch mutation.
    await git(invoke, ['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--', checkout, ref], target.targetRoot);
    const hooks = path.join(directory, 'hooks');
    await fs.mkdir(hooks);
    const ownerReservation = { path: path.join(parent, execution.id), reason: `acms-owner-${execution.id}` };
    execution.checkpoint({ ...target, integratedCommit: commit, commit: goal.composition.bundle.commit, targetCandidateTree: selection.tree,
      phase: 'checking', ownerReservation });
    await git(invoke, ['-c', 'core.hooksPath=' + hooks, 'worktree', 'add', '--no-checkout', '--no-guess-remote', '--lock', '--reason', ownerReservation.reason,
      '--', ownerReservation.path, request.targetRef.slice('refs/heads/'.length)], target.targetRoot);
    await verifyTarget(ownerReservation);
    await execution.apply(goal.composition.checks, target.targetRoot, commit, { hooks, targetRef: request.targetRef, targetHead: request.targetHead,
      message: `ACMS owner confirmation ${request.id}`, env: candidateGitEnvironment() });
  } catch (error) { retain = !!error.cleanupUncertain; throw error; }
  finally { if (!retain) await removeTemporary(directory, parent); }
}
