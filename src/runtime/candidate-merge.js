import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assert, digest, id, now, OWNER, text } from '../core/util.js';
import { candidateMergeActive, candidateMergeMatches, candidateMergePolicy, candidateMergeSelection, verifyCandidateConfirmation } from '../core/candidate-confirmation.js';
import { checkoutComposition } from './git-composition.js';
import { removeTemporary } from './git-delivery.js';
import { assertOwnerTargetIndex, ownerTargetIndexArgs, ownerTargetIndexLimit, ownerTargetSparseArgs, run } from './workspaces.js';

const maximumDiff = 4 * 1024 * 1024;
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

async function inspectTarget(workspaces, project, goal, selection, ref, invoke) {
  const root = await workspaces.validateProject(project, invoke);
  const repository = await fs.realpath(await git(invoke, ['rev-parse', '--show-toplevel'], root));
  assert(path.relative(repository, root) === '' && path.relative(goal.compositionBase.source, root) === '',
    'PROJECT_PATH_DENIED', '目标必须是该候选批准的项目 Git 根目录。');
  await git(invoke, ['check-ref-format', ref], root);
  const target = await workspaces.integrationTarget(root, invoke);
  assert(target.targetRef === ref, 'TARGET_BRANCH_NOT_CHECKED_OUT',
    `项目目录当前检出 ${target.targetRef}。请在项目目录切换到 ${ref}，再预览确认。`);
  assert(!target.targetStatus, 'TARGET_DIRTY', '目标工作副本有未提交文件，请保留或提交改动后重新预览。');
  assertOwnerTargetIndex(await git(invoke, ownerTargetSparseArgs, root),
    await git(invoke, ownerTargetIndexArgs, root, { maxOutput: ownerTargetIndexLimit }));
  const tree = await git(invoke, ['rev-parse', '--verify', target.targetHead + '^{tree}'], root);
  const base = await git(invoke, ['rev-parse', '--verify', selection.baseCommit + '^{tree}'], root);
  assert(tree === base || tree === selection.tree, 'TARGET_BASE_CHANGED',
    '目标分支的文件树已不同于候选基线。请基于该分支生成并联合核验新候选。');
  return { targetRoot: root, targetRef: ref, targetHead: target.targetHead, targetTree: tree };
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
  const verifyTarget = async () => {
    const target = await inspectTarget(workspaces, project, goal, selection, request.targetRef, invoke);
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
    execution.checkpoint({ ...target, integratedCommit: commit, commit: goal.composition.bundle.commit, targetCandidateTree: selection.tree,
      phase: 'checking' });
    await verifyTarget();
    await execution.apply(goal.composition.checks, target.targetRoot, commit, { hooks, env: candidateGitEnvironment() });
  } catch (error) { retain = !!error.cleanupUncertain; throw error; }
  finally { if (!retain) await removeTemporary(directory, parent); }
}
