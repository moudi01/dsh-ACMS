import { acceptedGoalComposition, finalGoalComposition, GIT_COMPOSITION } from './composite-delivery.js';
import { assert, digest, now, text } from './util.js';

export const candidateMergeActive = request => ['queued', 'preparing', 'applying', 'reconciling'].includes(request?.status);
export const requiresDeliveryApproval = goal => !!goal?.deliveryApproval;
export const returnedDeliveryVersion = (goal, version) => !!goal?.deliveryApproval?.returnedVersions?.includes(version);

function approvalSubject(request) {
  const { id: previewId, policy: authorization, selection, targetRef, targetRoot, targetIdentity, targetGitPaths, basisRef, basisHead, basisTree } = request;
  return { previewId, authorization, selection, targetRef, targetRoot, targetIdentity: targetIdentity ?? null,
    ...(targetGitPaths ? { targetGitPaths } : {}),
    targetMode: request.targetMode ?? 'new', basisRef, basisHead, basisTree };
}

export function deliveryApprovalFingerprint(request) { return digest(approvalSubject(request)); }

export function assertDeliveryVersionNotReturned(goal, selection) {
  assert(!returnedDeliveryVersion(goal, selection.version), 'DELIVERY_REVISION_REQUIRED',
    '此候选已退回修改。请修订交付任务并完成新版本的联合检查和所需最终审查。');
}

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
    digest(candidateMergeSelection(company, goal, allowDraining)) === digest(request.selection) &&
    (!requiresDeliveryApproval(goal) || (!returnedDeliveryVersion(goal, request.selection.version) &&
      (!candidateMergeActive(request) || approvedDelivery(company, goal, request))));
}

function approvedDelivery(company, goal, request) {
  const approval = company.store.get('deliveryApprovals', request.id);
  return approval?.action === 'approve' && approval.goalId === goal.id && approval.by?.kind === 'owner' &&
    !!approval.subject && digest(approval.subject) === approval.fingerprint &&
    approval.fingerprint === deliveryApprovalFingerprint(request) && approval.fingerprint === request.approvalFingerprint &&
    request.confirmedBy === approval.by.id && request.confirmedAt === approval.at;
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
  const goal = company.store.require('goals', args.id);
  if (requiresDeliveryApproval(goal) && ['approve', 'reject', 'revise', 'confirm'].includes(decision)) {
    assert(decision !== 'confirm', 'DELIVERY_APPROVAL_REQUIRED', '此目标需要所有者对预览版本填写理由并批准交付。');
    return decideDeliveryApproval(company, goal, args, actor, decision);
  }
  assert(!['approve', 'revise'].includes(decision), 'DELIVERY_APPROVAL_REQUIRED', '此目标使用原有候选确认流程。');
  if (decision === 'confirm') {
    const { goal, request } = verifyCandidateConfirmation(company, args);
    if (candidateMergeActive(request) || request.status === 'applied') return request;
    assert(request.status === 'previewed', 'STALE_CANDIDATE_CONFIRMATION', '此预览已关闭，请重新预览并确认。');
    return recordDecision(company, goal, { ...request, status: 'queued', confirmedBy: actor.id, confirmedAt: now() }, actor, 'confirmed');
  }
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

function decideDeliveryApproval(company, goal, args, actor, action) {
  assert(actor.kind === 'owner', 'OWNER_REQUIRED', '只有所有者可以批准、拒绝或退回交付。');
  const { store } = company;
  const reason = text(args.reason, '交付审批理由', 1000);
  const previous = typeof args.previewId === 'string' && store.get('deliveryApprovals', args.previewId);
  if (previous) {
    assert(previous.goalId === goal.id && previous.fingerprint === args.approvalFingerprint,
      'STALE_CANDIDATE_CONFIRMATION', '当前交付预览与决定不匹配，请刷新。');
    assert(previous.action === action && previous.reason === reason, 'CONFLICT', '该预览已经记录交付决定及其理由。');
    return goal.candidateMerge?.id === args.previewId ? goal.candidateMerge : previous;
  }
  const { request } = verifyCandidateConfirmation(company, args);
  assert(request.status === 'previewed' && request.approvalFingerprint === args.approvalFingerprint && request.targetIdentity &&
    request.approvalFingerprint === deliveryApprovalFingerprint(request),
  'STALE_CANDIDATE_CONFIRMATION', '交付审批预览已关闭或变化，请重新预览。');
  assertDeliveryVersionNotReturned(goal, request.selection);
  const at = now();
  const subject = approvalSubject(request);
  const approval = { id: request.id, goalId: goal.id, fingerprint: request.approvalFingerprint, subject,
    action, by: { kind: actor.kind, id: actor.id }, reason, at };
  const returned = action === 'revise';
  const nextGoal = returned ? { ...goal, deliveryApproval: { ...goal.deliveryApproval,
    returnedVersions: [...(goal.deliveryApproval.returnedVersions ?? []), request.selection.version], latestReturnId: request.id } }
    : action === 'approve' && goal.deliveryApproval.latestReturnId ? { ...goal,
      deliveryApproval: { ...goal.deliveryApproval, latestReturnId: null } } : goal;
  const next = action === 'approve' ? { ...request, status: 'queued', confirmedBy: actor.id, confirmedAt: at }
    : { ...request, status: returned ? 'returned' : 'rejected', reason };
  store.put('deliveryApprovals', approval);
  store.event('goal.delivery_approval.decided', goal.id, { ...subject, fingerprint: approval.fingerprint,
    decision: { kind: 'owner-decision', action, by: actor.id, reason, at } }, actor, { goalId: goal.id });
  return recordDecision(company, nextGoal, next, actor, action === 'approve' ? 'confirmed' : next.status);
}

function recordDecision(company, goal, request, actor, decision) {
  company.store.put('goals', { ...goal, candidateMerge: request });
  company.store.event('goal.candidate_merge.' + decision, goal.id, {
    previewId: request.id, version: request.selection.version, targetRef: request.targetRef, basisRef: request.basisRef, basisHead: request.basisHead,
    ...(request.targetMode === 'bare' ? { targetMode: 'bare', targetRoot: request.targetRoot } : {}),
  }, actor, { goalId: goal.id });
  return request;
}
