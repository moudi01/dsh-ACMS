import { goalCostBudgetView, validGoalCostBound } from './goal-cost-budget.js';
import { assertGoalOpen } from './goal-control.js';
import { optionalDependentScope } from './hierarchy.js';
import { approvedCostPlan, currentCostPlanTask, isCostPlanEstimateCurrent, matchesCostPlanWork, retainsCostPlanAssignment } from './plan-cost-budget.js';
import { OPTIONAL_COST_WAIT } from './task-actions.js';
import { assert, digest, id, now, text } from './util.js';

const excluded = new Set(['cancelled', 'archived', 'deleted', 'deferred']);

export function optionalCostEvidence(hold) {
  const { route, ...bound } = hold.bound;
  return { ...hold, bound: { ...bound, routeFingerprint: digest(route) } };
}

export function assessOptionalDispatch(company, goal, budget, task, bound, executor) {
  if (task.kind !== 'work' || task.origin?.kind !== 'manager-plan' || budget.breach) return null;
  const { store } = company;
  const plan = approvedCostPlan(store, goal);
  const node = plan?.nodes.find(node => node.taskId === task.id);
  const plannedOptional = plan?.costPlan.intent.nodes.some(item => item.key === node?.key && item.importance === 'optional');
  // Retain optional identity through ordinary edits. Exact plan matching is
  // required for scope removal, while this dispatch already has a fresh cap.
  if (!node || !plannedOptional) return null;
  const planner = currentCostPlanTask(store, goal, plan);

  const tasks = store.tasksForGoal(goal.id), byId = new Map(tasks.map(item => [item.id, item]));
  const planNodes = new Map(plan.nodes.map(node => [node.taskId, node]));
  const optionalKeys = new Set(plan.costPlan.intent.nodes.filter(node => node.importance === 'optional').map(node => node.key));
  const isOptional = item => optionalKeys.has(planNodes.get(item.id)?.key);
  const critical = new Set();
  const protect = id => {
    if (critical.has(id)) return;
    critical.add(id);
    const item = byId.get(id);
    if (!item) return;
    for (const dependency of item.dependencies) protect(dependency);
    if (item.parentId && item.parentId !== plan.taskId) protect(item.parentId);
  };
  for (const item of tasks) {
    if (item.id !== plan.taskId && !excluded.has(item.status) && !item.contractObsolete && !isOptional(item)) protect(item.id);
  }
  if (critical.has(task.id)) return null; // A live task relies on this input.

  const started = new Set(), byAttempt = new Map();
  for (const row of store.goalCostAttemptRows(goal.id)) {
    if (row.source === 'host-no-dispatch') continue;
    started.add(row.taskId);
    byAttempt.set(row.id, row);
  }
  if (started.has(task.id)) return null; // Never rescope previously paid work.

  const { availableMicros } = goalCostBudgetView(budget);
  const acceptanceMicros = plan.costPlan.estimate.acceptance.micros, reworkMicros = plan.costPlan.estimate.rework.micros;
  const price = !!planner && isCostPlanEstimateCurrent(company, goal, plan, planner, executor);
  const estimates = new Map(plan.costPlan.estimate.tasks.map(entry => [entry.key, entry.estimate.micros]));
  let required = 0n;
  let known = price;
  for (const id of critical) {
    const item = byId.get(id);
    const selected = planNodes.get(id);
    if (item?.status === 'succeeded') {
      if (id !== plan.taskId && !started.has(id)) known = false;
      continue;
    }
    const active = byAttempt.get(item?.activeAttemptId);
    // A current authorized execution is already covered in the goal ledger.
    if (active && active.taskId === id && active.taskGeneration === item.generation &&
        active.goalContractVersion === plan.goalContractVersion && active.status === 'reserved' &&
        ['running', 'reconciling'].includes(item.status) && !item.stopRequested) continue;
    if (!selected || !matchesCostPlanWork(item, selected, goal, plan) || excluded.has(item.status) ||
        !['ready', 'blocked', 'paused', 'running'].includes(item.status) || started.has(id) || item.costBudgetHold ||
        !retainsCostPlanAssignment(store, item, selected) || !estimates.has(selected.key)) {
      known = false;
      continue;
    }
    required += BigInt(estimates.get(selected.key));
  }
  // A removed required record is also an unpriced gap, even after a purge.
  if (plan.nodes.some(node => !optionalKeys.has(node.key) && !critical.has(node.taskId))) known = false;
  const priceCap = BigInt(bound.upperMicros);
  // The price source does not yet attribute consumed phase costs. Protect
  // both original allowances while any optional work is awaiting dispatch.
  if (known && priceCap + required + BigInt(acceptanceMicros) + BigInt(reworkMicros) <= BigInt(availableMicros)) return null;
  return { code: OPTIONAL_COST_WAIT, reasonCode: known ? 'shortfall' : 'coverage-unknown',
    reason: known ? '可选任务等待金额余量，先为必做、验收和返工留出计划金额。' :
      '可选任务等待费用核对，当前无法确认必做、验收或返工所需金额。',
    planId: plan.id, planFingerprint: plan.fingerprint, releaseVersion: budget.releaseVersion,
    agentRevision: store.get('agents', task.agentId)?.revision ?? null,
    bound: { executorId: bound.executorId, currency: bound.currency, quoteId: bound.quoteId, upperMicros: bound.upperMicros, route: bound.route },
    balance: { availableMicros, settledMicros: budget.settledMicros, reservedMicros: budget.reservedMicros,
      requiredMicros: known ? required.toString() : null, acceptanceMicros, reworkMicros } };
}

function isUndispatched(store, task) {
  if (!task || !['ready', 'blocked'].includes(task.status) || task.environmentBlock || task.stopRequested || task.goalPauseId ||
      task.integrationPending || task.activeIntegrationId || task.attempts > 0 || task.artifactIds?.length || task.artifactHash ||
      (task.blocker && (task.blocker.kind !== 'cost-budget' || task.costBudgetHold?.code !== OPTIONAL_COST_WAIT))) return false;
  return [...store.attemptUsageRows('task', task.id)].every(({ attempt }) => attempt.preflightOnly && !attempt.cleanupPending);
}

export const optionalDeferralPending = request => ['queued', 'checking'].includes(request?.status);

export function withdrawOptionalDeferral(store, goalId, taskId = null) {
  const goal = store.get('goals', goalId);
  const request = goal?.costBudgetDeferralRequest;
  if (!optionalDeferralPending(request) || (taskId && !request.taskIds.includes(taskId))) return false;
  const seed = store.get('tasks', request.taskId);
  if (request.status === 'queued' && seed?.status === 'ready' && seed.costBudgetHold?.attemptId === request.holdAttemptId)
    store.put('tasks', { ...seed, status: 'blocked' });
  store.put('goals', { ...goal, costBudgetDeferralRequest: { ...request, status: 'not-applied',
    result: '范围、暂停或停止状态已变化，本轮未延期。', finishedAt: now() } });
  return true;
}

function confirmableScope(company, args, executor) {
  const { store } = company;
  const goal = store.require('goals', args.id);
  assertGoalOpen(goal);
  const plan = approvedCostPlan(store, goal);
  const budget = store.get('goalCostBudgets', goal.id);
  const task = store.get('tasks', args.taskId);
  const hold = task?.costBudgetHold;
  assert(plan && budget && plan.fingerprint === args.planFingerprint && task?.goalId === goal.id &&
    hold?.planId === plan.id && hold.planFingerprint === plan.fingerprint && hold.code === OPTIONAL_COST_WAIT &&
    hold.attemptId && hold.attemptId === args.holdAttemptId &&
    validGoalCostBound(hold.bound, hold.bound?.route) && executor?.id === hold.bound.executorId &&
    store.get('agents', task.agentId)?.revision === hold.agentRevision &&
    !['succeeded', 'archived', 'deleted'].includes(goal.status),
  'COST_OPTIONAL_STALE', '当前可选派工或费用来源已变化，请刷新后确认。');
  assert(budget.reservedAttempts === 0, 'COST_OPTIONAL_PENDING', '仍有费用待结算，先保留可恢复的等待。');
  const tasks = store.tasksForGoal(goal.id);
  const scope = optionalDependentScope(tasks, task.id);
  assert(Array.isArray(args.taskIds) && args.taskIds.length === scope.length && digest([...args.taskIds].sort()) === digest(scope),
    'COST_OPTIONAL_STALE', '可选后续任务已变化，请刷新延期范围。');
  const pending = new Set(store.list('interactions').filter(item => item.status === 'pending').map(item => item.taskId));
  const scopeSet = new Set(scope), selected = tasks.filter(item => scopeSet.has(item.id));
  const optionalKeys = new Set(plan.costPlan.intent.nodes.filter(node => node.importance === 'optional').map(node => node.key));
  const started = new Set([...store.goalCostAttemptRows(goal.id)].filter(row => row.source !== 'host-no-dispatch').map(row => row.taskId));
  for (const item of selected) {
    const node = plan.nodes.find(node => node.taskId === item.id);
    assert(node && optionalKeys.has(node.key) && matchesCostPlanWork(item, node, goal, plan) &&
      isUndispatched(store, item) && !started.has(item.id) && !pending.has(item.id),
    'COST_OPTIONAL_SCOPE', '延期范围包含已执行、独立阻塞或其他必需任务。请核对依赖及交付范围。');
  }
  return { goal, plan, budget, task, hold, scope, selected };
}

export function deferOptionalCostScope(company, args, actor, executor) {
  assert(actor.kind === 'owner', 'OWNER_REQUIRED', '只有所有者可确认本轮延期。');
  const { store } = company;
  const { goal, budget, task, hold, scope } = confirmableScope(company, args, executor);
  assert(!optionalDeferralPending(goal.costBudgetDeferralRequest), 'COST_OPTIONAL_PENDING', '此目标已有延期核价，请等待结果。');
  const current = assessOptionalDispatch(company, goal, budget, task, hold.bound, executor);
  assert(current?.reasonCode === 'shortfall', 'COST_OPTIONAL_STALE', '当前余量不足尚未确认，请重新核对该可选任务。');
  const request = { id: id('cost-deferral'), status: 'queued', taskId: task.id, taskIds: scope, holdAttemptId: hold.attemptId,
    generation: task.generation, planFingerprint: args.planFingerprint, by: actor.id, requestedAt: now(),
    reason: text(args.reason, '延期理由', 2000) };
  store.put('tasks', { ...task, status: 'ready' });
  return store.put('goals', { ...goal, costBudgetDeferralRequest: request });
}

export function finishOptionalDeferral(company, goal, task, attempt, executor, bound, failure) {
  const { store } = company;
  const request = goal.costBudgetDeferralRequest;
  if (!optionalDeferralPending(request) || request.id !== attempt.costDeferralRequestId) return;
  const actor = { kind: 'owner', id: request.by };
  let resolution;
  try {
    assert(!failure, 'COST_OPTIONAL_STALE', failure);
    assert(!company.policy().paused && task.activeAttemptId === attempt.id && task.generation === request.generation,
      'COST_OPTIONAL_STALE', '确认时任务或调度状态已变化，请核对后重试。');
    assert(validGoalCostBound(bound, bound?.route), 'COST_OPTIONAL_STALE', '当前实际执行上界无法核实，本轮未延期。');
    resolution = confirmableScope(company, { ...request, id: goal.id }, executor);
  } catch (error) {
    if (!['COST_OPTIONAL_STALE', 'COST_OPTIONAL_PENDING', 'COST_OPTIONAL_SCOPE', 'GOAL_CLOSED', 'GOAL_PAUSED'].includes(error.code)) throw error;
    store.put('goals', { ...goal, costBudgetDeferralRequest: { ...request, status: 'not-applied', result: error.message, finishedAt: now() } });
    return;
  }
  const { plan, budget, scope, selected } = resolution;
  const current = assessOptionalDispatch(company, goal, budget, task, bound, executor);
  if (current?.reasonCode !== 'shortfall') {
    const reason = current ? current.reason : '当前报价已有足够余量。可继续正常派发，本轮未延期。';
    store.put('goals', { ...goal, costBudgetDeferralRequest: { ...request, status: 'not-applied', result: reason, finishedAt: now() } });
    const latest = current ?? { ...task.costBudgetHold, bound, reason, reasonCode: 'affordable' };
    store.put('tasks', { ...task, costBudgetHold: { ...latest, attemptId: attempt.id, quotedAt: now() },
      blocker: { kind: 'cost-budget', reason } });
    return;
  }
  const decision = { decisionId: request.id, planId: plan.id, planFingerprint: plan.fingerprint,
    goalContractVersion: plan.goalContractVersion, by: request.by, at: now(), reason: request.reason };
  for (const item of selected) {
    store.put('tasks', { ...item, status: 'deferred', blocker: null, costBudgetHold: null,
      costBudgetDeferral: { ...decision, taskGeneration: item.generation } });
    company.releaseTemporaryAgent(item.agentId, actor);
  }
  store.put('goals', { ...goal, costBudgetDeferralRequest: { ...request, status: 'applied', finishedAt: decision.at },
    costBudgetDeferrals: [...(goal.costBudgetDeferrals ?? []), ...selected.map(item => ({
      taskId: item.id, taskGeneration: item.generation, decisionId: decision.decisionId, planId: plan.id,
      planFingerprint: plan.fingerprint, goalContractVersion: plan.goalContractVersion }))] });
  store.event('goal.cost_budget.optional_deferred', goal.id, { ...decision, taskIds: scope,
    costBasis: optionalCostEvidence({ ...current, attemptId: attempt.id, quotedAt: decision.at }) }, actor);
  return company.refreshGoal(goal.id, actor);
}
