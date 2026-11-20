import { promises as fs, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assert, digest, id, now, OWNER, text } from '../core/util.js';
import { candidateMergeActive, candidateMergeMatches, candidateMergePolicy, candidateMergeSelection, verifyCandidateConfirmation } from '../core/candidate-confirmation.js';
import { checkoutComposition } from './git-composition.js';
import { removeTemporary } from './git-delivery.js';
import { run } from './workspaces.js';
import { assertBareDeliveryFence, assertBareMetadataPaths, assertBareRepositoryPolicy, bareFenceRef, bareHooksArgs, barePolicyArgs,
  inspectBareDeliveryTarget } from './bare-delivery-target.js';

const maximumDiff = 4 * 1024 * 1024;
const gitList = ['worktree', 'list', '--porcelain', '-z'];
const samePath = (a, b) => path.relative(a, b) === '';
const verifiedRef = ref => ['show-ref', '--verify', '--hash', '--', ref];
const bareTransactionHook = `#!/bin/sh
cat >/dev/null
test "$1" = prepared || exit 0
git symbolic-ref --quiet "$ACMS_BARE_TARGET_REF" >/dev/null 2>&1
test "$?" = 1 && exit 0
echo "The confirmed target is no longer a direct branch." >&2
exit 1
`;
const basisRef = value => {
  const ref = text(value, 'basisRef', 1024);
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

function assertNewTarget(list, ref, status) {
  assert(status === 1 && !list.some(entry => entry.branch === ref), 'TARGET_BRANCH_EXISTS',
    '预览分支已存在或已被工作副本占用，请重新预览以分配新的交付分支。');
}

async function inspectBasis(workspaces, project, goal, selection, ref, invoke, targetMode) {
  const source = await workspaces.validateProject(project, invoke);
  const repository = await fs.realpath(await git(invoke, ['rev-parse', '--show-toplevel'], source));
  assert(samePath(repository, source) && samePath(goal.compositionBase.source, source),
    'PROJECT_PATH_DENIED', '目标必须是该候选批准的项目 Git 根目录。');
  const target = targetMode === 'bare'
    ? await inspectBareDeliveryTarget(workspaces, project.deliveryRepository?.targetRoot, invoke) : { targetRoot: source };
  if (targetMode === 'bare') assert(target.targetIdentity === project.deliveryRepository?.targetIdentity,
    'BARE_TARGET_CHANGED', '裸交付仓库目录已变化。请恢复原仓库，或在项目设置中重新授权。');
  const root = target.targetRoot;
  await git(invoke, ['check-ref-format', ref], root);
  if (targetMode === 'bare') assertBareMetadataPaths(root, ref);
  const head = await git(invoke, verifiedRef(ref), root);
  const symref = await git(invoke, ['for-each-ref', '--format=%(refname) %(symref)', '--', ref], root);
  assert(symref.split(/\r?\n/).find(line => line.split(' ')[0] === ref)?.trim() === ref,
    'TARGET_REF_UNSUPPORTED', '请选择存在的直接本地分支。');
  const tree = await git(invoke, ['rev-parse', '--verify', head + '^{tree}'], root);
  const base = await git(invoke, ['rev-parse', '--verify', selection.baseCommit + '^{tree}'], source);
  assert(tree === base || tree === selection.tree, 'TARGET_BASE_CHANGED',
    '所选基准分支的文件树已不同于候选基线。请基于该分支生成并联合核验新候选。');
  return { ...target, basisRef: ref, basisHead: head, basisTree: tree, ...(targetMode === 'bare' ? { targetMode } : {}) };
}

export function assertCandidateBranchWrite(record, executable) {
  const { targetRoot, targetRef, basisRef, basisHead, basisTree, targetCandidateTree, integratedCommit } = record;
  const invoke = (args, optional = false) => {
    const result = spawnSync(executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd: targetRoot, env: candidateGitEnvironment(), windowsHide: true, encoding: 'utf8', maxBuffer: maximumDiff, timeout: 5000,
    });
    assert(!result.error && (result.status === 0 || (optional && result.status === 1)), 'GIT_ERROR',
      result.error?.message || result.stderr || '无法核对已确认的 Git 分支。');
    return result;
  };
  const check = args => invoke(args).stdout.trim();
  assert(samePath(realpathSync(targetRoot), targetRoot), 'TARGET_CHANGED', '项目目录已经变化。');
  if (record.targetMode === 'bare') {
    assertBareDeliveryFence(record);
    assertBareMetadataPaths(targetRoot, targetRef);
    assertBareRepositoryPolicy(check(bareHooksArgs), invoke(barePolicyArgs, true).status);
    assert(check(['rev-parse', '--is-bare-repository']) === 'true' && targetRef === basisRef,
      'BARE_TARGET_CHANGED', '无法核对裸交付仓库与目标分支。');
    assert(check(['rev-parse', '--verify', bareFenceRef(record.id)]) === integratedCommit, 'BARE_TARGET_CHANGED', '无法核对 Git 引用事务的仓库凭据。');
  } else assertNewTarget(worktrees(invoke(gitList).stdout), targetRef, invoke(['rev-parse', '--verify', '--quiet', targetRef], true).status);
  assert(check(verifiedRef(basisRef)) === basisHead && check(['rev-parse', '--verify', basisHead + '^{tree}']) === basisTree &&
    check(['rev-parse', '--verify', integratedCommit + '^{tree}']) === targetCandidateTree &&
    check(['rev-list', '--parents', '-n', '1', integratedCommit]) === `${integratedCommit} ${basisHead}`,
  'TARGET_CHANGED', '最终创建前无法核对已确认的基准及候选树。');
}

async function verifyNewBranch(basis, ref, invoke) {
  const status = await invoke('git', ['rev-parse', '--verify', '--quiet', ref], basis.targetRoot);
  assert(!status.timedOut && [0, 1].includes(status.code), 'GIT_ERROR', '无法核对交付分支是否存在。');
  assertNewTarget(worktrees(await git(invoke, gitList, basis.targetRoot, { maxOutput: maximumDiff })), ref, status.code);
}

function matchesTarget(current, expected) {
  return current.basisRef === expected.basisRef && current.basisHead === expected.basisHead && current.basisTree === expected.basisTree &&
    current.targetIdentity === expected.targetIdentity && path.relative(current.targetRoot, expected.targetRoot) === '';
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
  await git(invoke, ['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--', target.targetRoot, target.basisHead], checkout);
  assert(await git(invoke, ['rev-parse', '--verify', target.basisHead + '^{tree}'], checkout) === target.basisTree,
    'TARGET_CHANGED', '基准分支在核对期间变化，请重新预览。');
  return checkout;
}

async function changes(goal, target, checkout, invoke) {
  const changed = await git(invoke, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z',
    target.basisHead, goal.composition.bundle.commit, '--'], checkout, { maxOutput: maximumDiff });
  assert(changed.length < maximumDiff && (!changed || changed.endsWith('\0')), 'CHANGE_LIMIT', '候选路径清单超过可核对范围。');
  const parts = changed ? changed.slice(0, -1).split('\0') : [];
  assert(parts.length % 2 === 0, 'GIT_PATH_OUTPUT', '无法核对候选变更清单。');
  const items = [];
  for (let index = 0; index < Math.min(parts.length, 200); index += 2) items.push({ change: parts[index], path: parts[index + 1] });
  return { total: parts.length / 2, items };
}

export async function previewCandidateMerge(company, workspaces, input, signal) {
  const ref = basisRef(input.basisRef);
  const targetMode = input.targetMode ?? 'new';
  assert(['new', 'bare'].includes(targetMode), 'INVALID_INPUT', '请选择支持的候选交付方式。');
  const goal = company.store.require('goals', input.goalId);
  const project = company.store.require('projects', goal.projectId);
  const selection = candidateMergeSelection(company, goal);
  assert(selection, 'CANDIDATE_NOT_READY', '请先验收完整 Git 候选并完成模板要求的最终审查。');
  assert(selection.version === input.version && selection.deliveryHash === input.deliveryHash,
    'STALE_CANDIDATE_CONFIRMATION', '已验收候选发生变化，请刷新目标。');
  assert(!candidateMergeActive(goal.candidateMerge), 'CONFLICT', '已有确认请求正在执行或待核对。');
  const invoke = gitInvoker(run, signal);
  const policy = candidateMergePolicy(company, project, targetMode);
  const target = await inspectBasis(workspaces, project, goal, selection, ref, invoke, targetMode);
  const previewId = id('candidate_preview');
  const targetRef = targetMode === 'bare' ? ref : 'refs/heads/acms-deliveries/' + previewId.slice('candidate_preview_'.length);
  const taskId = goal.composition.inputs[0]?.taskId;
  assert(taskId, 'CANDIDATE_NOT_READY', '候选缺少已选任务。');
  const { parent, directory } = await scratch(workspaces, 'owner-preview-');
  try {
    const checkout = await loadTrees(goal, workspaces.dataDir, target, directory, invoke, signal);
    const summary = await changes(goal, target, checkout, invoke);
    assert(matchesTarget(await inspectBasis(workspaces, project, goal, selection, ref, invoke, targetMode), target),
      'TARGET_CHANGED', '基准分支在预览期间变化，请重新预览。');
    if (targetMode === 'new') await verifyNewBranch(target, targetRef, invoke);
    signal?.throwIfAborted();
    return company.store.transaction(() => {
      const current = company.store.require('goals', goal.id);
      assert(candidateMergeMatches(company, current, { selection, policy, targetMode }) && !candidateMergeActive(current.candidateMerge),
        'STALE_CANDIDATE_CONFIRMATION', '候选、项目授权或确认状态在预览期间变化，请重新预览。');
      const checks = goal.composition.checks.map(({ id, checkVersion, inputHash, environment, code, log }) =>
        ({ id, checkVersion, inputHash, environment, code, logHash: log?.hash ?? null }));
      const request = { id: previewId, status: 'previewed', previewedAt: now(), selection, policy, taskId, ...target, targetRef, summary, checks };
      company.store.put('goals', { ...current, candidateMerge: request });
      company.store.event('goal.candidate_merge.previewed', goal.id, { previewId: request.id, selection, targetRef,
        basisRef: ref, basisHead: target.basisHead, ...(targetMode === 'bare' ? { targetMode, targetRoot: target.targetRoot } : {}) }, OWNER, { goalId: goal.id });
      return request;
    });
  } finally { await removeTemporary(directory, parent); }
}

export async function checkCandidateMergeConfirmation(company, workspaces, args, signal) {
  const { goal, request } = verifyCandidateConfirmation(company, args);
  if (request.status !== 'previewed') return;
  const project = company.store.require('projects', goal.projectId);
  const invoke = gitInvoker(run, signal);
  const target = await inspectBasis(workspaces, project, goal, request.selection, request.basisRef, invoke, request.targetMode);
  assert(matchesTarget(target, request), 'TARGET_CHANGED', '基准 HEAD 已变化，请重新预览和确认。');
  if (request.targetMode !== 'bare') await verifyNewBranch(target, request.targetRef, invoke);
}

export async function applyConfirmedCandidate(company, workspaces, goal, request, execution) {
  const project = company.store.require('projects', goal.projectId);
  const { selection } = request;
  const invoke = gitInvoker(execution.run, execution.signal, { GIT_AUTHOR_DATE: request.confirmedAt, GIT_COMMITTER_DATE: request.confirmedAt });
  const verifyTarget = async () => {
    const target = await inspectBasis(workspaces, project, goal, selection, request.basisRef, invoke, request.targetMode);
    assert(matchesTarget(target, request), 'TARGET_CHANGED', '基准 HEAD 已变化，请重新预览和确认。');
    if (request.targetMode !== 'bare') await verifyNewBranch(target, request.targetRef, invoke);
    return target;
  };
  const target = await verifyTarget();
  const { parent, directory } = await scratch(workspaces, execution.id + '-owner-');
  let retain = false;
  try {
    const checkout = await loadTrees(goal, workspaces.dataDir, target, directory, invoke, execution.signal);
    if (request.targetMode === 'bare' && target.basisTree === selection.tree) {
      await verifyTarget();
      execution.checkpoint({ ...target, targetRef: request.targetRef });
      return { status: 'merged', proof: 'target-tree', targetRef: request.targetRef, integratedCommit: target.basisHead, actualHead: target.basisHead };
    }
    const commit = await git(invoke, ['-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost', '-c', 'commit.gpgSign=false',
      'commit-tree', selection.tree, '-p', target.basisHead, '-m', `ACMS owner confirmation ${request.id}`], checkout);
    const ref = 'refs/heads/acms-confirmed';
    await git(invoke, ['update-ref', ref, commit], checkout);
    await verifyTarget();
    // Import objects without a destination ref or FETCH_HEAD. The separate
    // ref transaction verifies the basis and creates only the preview's ref.
    await git(invoke, ['fetch', '--no-tags', '--no-auto-maintenance', '--no-write-fetch-head', '--', checkout, ref], target.targetRoot);
    const hooks = path.join(directory, 'hooks');
    await fs.mkdir(hooks);
    if (request.targetMode === 'bare') await fs.writeFile(path.join(hooks, 'reference-transaction'), bareTransactionHook, { mode: 0o700 });
    execution.checkpoint({ ...target, targetRef: request.targetRef, integratedCommit: commit, commit: goal.composition.bundle.commit,
      targetCandidateTree: selection.tree, phase: 'checking', ...(request.targetMode === 'bare' ? { bareFence: true } : {}) });
    if (request.targetMode === 'bare') execution.acquireBareFence();
    await execution.apply(goal.composition.checks, target.targetRoot, commit, { hooks, targetRef: request.targetRef, basisRef: target.basisRef, basisHead: target.basisHead,
      message: `ACMS owner confirmation ${request.id}`, env: { ...candidateGitEnvironment(),
        ...(request.targetMode === 'bare' ? { ACMS_BARE_TARGET_REF: request.targetRef } : {}) }, targetMode: request.targetMode });
  } catch (error) { retain = !!error.cleanupUncertain; throw error; }
  finally { if (!retain) await removeTemporary(directory, parent); }
}
