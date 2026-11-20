import { acceptedGoalComposition, finalGoalComposition, GIT_COMPOSITION } from './composite-delivery.js';
import { assert, digest, now, text } from './util.js';

export const candidateMergeActive = request => ['queued', 'preparing', 'applying', 'reconciling'].includes(request?.status);

export function candidateMergeSelection(company, goal, allowDraining = false) {
  if (goal?.deliveryMode !== GIT_COMPOSITION) return null;
  const candidate = acceptedGoalComposition(company.store, goal);
  const readyGoal = allowDraining && goal.executionControl?.mode === 'after-current' ? { ...goal, executionControl: null } : goal;
  const final = finalGoalComposition(company, readyGoal, candidate, company.deliveryHash(goal.id));
  if (!final || !candidate.bundle?.sha256) return null;
  return { ...final, tree: candidate.tree, contentHash: candidate.contentHash, baseCommit: candidate.baseCommit,
    bundleSha256: candidate.bundle.sha256,
    checkEvidence: digest(candidate.checks.map(check => [check.id, check.checkVersion, check.inputHash, check.environment, check.code, check.log?.hash ?? null])) };
}

export function candidateMergePolicy(company, project, targetMode) {
  return digest({ project: project?.id, root: project?.repoRoot, mode: project?.mode, autoMerge: project?.autoMerge,
    status: project?.status ?? null, allowedRoots: company.policy().allowedProjectRoots,
    ...(targetMode === 'bare' ? { deliveryRepository: project?.deliveryRepository ?? null } : {}) });
}

export function candidateMergeMatches(company, goal, request, allowDraining = false) {
  return !!request && request.policy === candidateMergePolicy(company, company.store.get('projects', goal.projectId), request.targetMode) &&
    digest(candidateMergeSelection(company, goal, allowDraining)) === digest(request.selection);
}

export function verifyCandidateConfirmation(company, args) {
  const goal = company.store.require('goals', args.id);
  const request = goal.candidateMerge;
  assert(request && request.id === args.previewId && request.targetRef === args.targetRef &&
    request.basisRef === args.basisRef && request.basisHead === args.basisHead &&
    (request.targetMode ?? 'new') === (args.targetMode ?? 'new') && (request.targetMode !== 'bare' || request.targetRoot === args.targetRoot) &&
    request.selection.version === args.version && request.selection.deliveryHash === args.deliveryHash,
  'STALE_CANDIDATE_CONFIRMATION', '预览或确认的候选与分支不匹配，请重新预览。');
  if (request.status === 'previewed') assert(candidateMergeMatches(company, goal, request), 'STALE_CANDIDATE_CONFIRMATION',
    '当前候选、审查结论或项目授权已变化，请重新预览。');
  return { goal, request };
}

export function decideCandidateMerge(company, args, actor, decision) {
  company.owner(actor);
  if (decision === 'confirm') {
    const { goal, request } = verifyCandidateConfirmation(company, args);
    if (candidateMergeActive(request) || request.status === 'applied') return request;
    assert(request.status === 'previewed', 'STALE_CANDIDATE_CONFIRMATION', '此预览已关闭，请重新预览并确认。');
    return recordDecision(company, goal, { ...request, status: 'queued', confirmedBy: actor.id, confirmedAt: now() }, actor, 'confirmed');
  }
  const goal = company.store.require('goals', args.id);
  const request = goal.candidateMerge;
  assert(request && request.id === args.previewId, 'STALE_CANDIDATE_CONFIRMATION', '此预览已变化，请刷新。');
  if (decision === 'reject') {
    if (request.status === 'rejected') return request;
    assert(request.status === 'previewed', 'CONFLICT', '已确认的请求请使用撤回确认。');
    return recordDecision(company, goal, { ...request, status: 'rejected',
      reason: args.reason === undefined ? null : text(args.reason, '拒绝原因', 1000) }, actor, 'rejected');
  }
  if (decision === 'reconcile') {
    assert(request.status === 'reconciling', 'INVALID_TRANSITION', '只有待核对的合入可请求重新核对。');
    if (request.recoveryRequested) return request;
    return recordDecision(company, goal, { ...request, recoveryRequested: true }, actor, 'recheck_requested');
  }
  if (!candidateMergeActive(request) || request.stopRequested) return request;
  const next = request.status === 'queued' ? { ...request, status: 'cancelled' } : { ...request, stopRequested: true };
  return recordDecision(company, goal, next, actor, 'withdrawn');
}

function recordDecision(company, goal, request, actor, decision) {
  company.store.put('goals', { ...goal, candidateMerge: request });
  company.store.event('goal.candidate_merge.' + decision, goal.id, {
    previewId: request.id, version: request.selection.version, targetRef: request.targetRef, basisRef: request.basisRef, basisHead: request.basisHead,
    ...(request.targetMode === 'bare' ? { targetMode: 'bare', targetRoot: request.targetRoot } : {}),
  }, actor, { goalId: goal.id });
  return request;
}
