import { contractVersion, matchesGoalContract } from './goal-contract.js';
import { costPlanBalance, isCostPlanEstimateCurrent } from './plan-cost-budget.js';
import { assert, now } from './util.js';

const closed = new Set(['cancelled', 'archived', 'deleted']);
const inProgress = new Set(['running', 'reconciling', 'integrating']);
const waiting = new Set(['ready', 'blocked', 'paused', 'running']);

function matchesPlannedTask(task, node, goal, plan) {
  return task && !closed.has(task.status) && task.kind === 'work' && task.generation === 1 &&
    task.parentId === plan.taskId && task.origin?.kind === 'manager-plan' && task.origin.planKey === node.key &&
    task.origin.planTaskId === plan.taskId && task.agentId === node.assigneeAgentId &&
    task.dependencies.length === node.dependencies.length && node.dependencies.every((id, index) => task.dependencies[index] === id) &&
    !task.contractObsolete && matchesGoalContract(goal, task) && !goal.supersededTaskIds?.includes(task.id);
}

function retainsAssignment(store, task, node) {
  const agent = store.get('agents', task.agentId);
  // Materialization owns the default worker at revision 1. Explicit assignees
  // are versioned by the original pricing context instead.
  return agent?.status === 'available' && (node.assignment !== 'scheduler-default' || agent.revision === 1);
}

function phaseForecast(estimate, current, finished, mayHaveBegun) {
  const plannedMicros = estimate?.micros ?? null;
  if (finished) return { state: 'finished', plannedMicros, remainingMicros: '0' };
  if (!current) return { state: 'unknown', plannedMicros, remainingMicros: null };
  if (plannedMicros === '0') return { state: 'no-reserve', plannedMicros, remainingMicros: '0' };
  if (mayHaveBegun) return { state: 'unknown', plannedMicros, remainingMicros: null };
  return { state: 'unused', plannedMicros, remainingMicros: plannedMicros };
}

function forecast(company, goal, budget, executor) {
  const { store } = company;
  const ledger = costPlanBalance(budget);
  const booked = BigInt(ledger.settledMicros) + BigInt(ledger.reservedMicros);
  const result = { goalId: goal.id, enabled: true, asOf: now(), ledger: { ...ledger, revision: budget.revision },
    plan: null, coverage: { selected: 0, unstarted: 0, reserved: 0, delivered: 0, unknown: 0, outsidePlan: 0 },
    unstartedMicros: null, acceptance: null, rework: null, coveredMicros: booked.toString(),
    status: 'unknown', completionBasis: null, completionMicros: null, headroomMicros: null, reasons: [] };
  if (closed.has(goal.status)) return { ...result, status: 'closed' };

  const reasons = new Set();
  if (ledger.breach) reasons.add('cost-contract-breach');
  if (ledger.awaitingReceiptAttempts > 0) reasons.add('awaiting-cost-receipt');
  const plan = goal.planApproval?.approvedPlanId && store.get('plans', goal.planApproval.approvedPlanId);
  const cost = plan?.costPlan;
  if (plan?.goalId !== goal.id || plan.approvalStatus !== 'approved' || !plan.acceptedAt || !cost?.estimate) {
    return { ...result, reasons: ['no-approved-estimate', ...reasons] };
  }
  const { coverage } = result;
  const planner = store.get('tasks', plan.taskId);
  const project = store.get('projects', goal.projectId);
  const contractCurrent = plan.taskId === goal.planApproval.taskId && plan.goalContractVersion === contractVersion(goal) &&
    goal.contractChange?.status !== 'pending' && planner?.goalId === goal.id && planner.kind === 'plan' &&
    planner.generation === plan.generation && planner.status === 'succeeded' && matchesGoalContract(goal, planner) &&
    !!project && project.status !== 'deleted';
  const quoteCurrent = contractCurrent && isCostPlanEstimateCurrent(company, goal, plan, planner, executor);
  result.plan = { id: plan.id, fingerprint: plan.fingerprint, executorId: cost.estimate.executorId, quoteId: cost.estimate.quoteId,
    state: !contractCurrent ? 'contract-changed' : quoteCurrent ? 'current' : 'quote-stale' };
  if (!contractCurrent) reasons.add('contract-changed');

  const allTasks = new Map(store.tasksForGoal(goal.id).map(task => [task.id, task]));
  const byTask = new Map(plan.nodes.map(node => [node.taskId, node]));
  const estimates = new Map(cost.estimate.tasks.map(row => [row.key, row.estimate]));
  const selected = new Set(cost.selectedKeys);
  coverage.selected = selected.size;
  const taskScope = plan.nodes.length === selected.size && plan.nodes.every(node => selected.has(node.key) && estimates.has(node.key));
  if (!taskScope) reasons.add('work-changed');
  const outside = [...allTasks.values()].filter(task => task.id !== plan.taskId && !byTask.has(task.id));
  coverage.outsidePlan = outside.filter(task => task.status !== 'succeeded' && !closed.has(task.status) &&
    !task.contractObsolete && !goal.supersededTaskIds?.includes(task.id)).length;
  if (coverage.outsidePlan) reasons.add('unpriced-work');

  const allocations = new Map(), byAttempt = new Map();
  let otherExecution = false;
  for (const row of store.goalCostAttemptRows(goal.id)) {
    byAttempt.set(row.id, row);
    if (row.source === 'host-no-dispatch') continue;
    if (row.taskId !== plan.taskId && !byTask.has(row.taskId)) otherExecution = true;
    if (!byTask.has(row.taskId)) continue;
    const history = allocations.get(row.taskId) ?? { count: 0, active: null };
    history.count++;
    if (row.status === 'reserved' || row.status === 'awaiting-receipt') history.active = row;
    allocations.set(row.taskId, history);
  }
  const unverifiedTasks = new Set();
  let resultMayExist = false, workMayNeedRework = false;
  for (const { attempt } of store.attemptUsageRows('goal', goal.id)) {
    const allocation = byAttempt.get(attempt.id);
    if (attempt.preflightOnly || allocation?.source === 'host-no-dispatch') continue;
    if (attempt.status !== 'preparing' && !allocation) unverifiedTasks.add(attempt.taskId);
    if (allocation?.status === 'reserved' && (attempt.cleanupUncertain || attempt.status === 'reconciling' ||
        (attempt.cleanupPending && attempt.finishedAt))) reasons.add('execution-cleanup-pending');
    if (!byTask.has(attempt.taskId)) continue;
    resultMayExist ||= attempt.resultAccepted === true || ['completed', 'reconciling'].includes(attempt.status);
    workMayNeedRework ||= ['failed', 'interrupted', 'reconciling'].includes(attempt.status);
  }
  if (unverifiedTasks.size) reasons.add('unverified-cost');

  let unstarted = 0n;
  const changedTasks = new Set();
  for (const node of plan.nodes) {
    const task = allTasks.get(node.taskId), history = allocations.get(node.taskId), claim = history?.active;
    let missing;
    if (!matchesPlannedTask(task, node, goal, plan) || node.dependencies.some(id => changedTasks.has(id)) ||
        !selected.has(node.key) || !estimates.has(node.key)) {
      missing = 'work-changed';
      changedTasks.add(node.taskId);
    } else if (unverifiedTasks.has(task.id) || (task.status === 'succeeded' && !history?.count)) missing = 'unverified-cost';
    else if (task.status === 'succeeded') coverage.delivered++;
    else if (history?.count === 1 && claim?.id === task.activeAttemptId && inProgress.has(task.status) &&
        claim.taskGeneration === task.generation && matchesGoalContract(goal, task, claim) && !task.stopRequested) {
      // The durable upper amount is already in booked. Forecasting this task a
      // second time would double count a single execution.
      coverage.reserved++;
    } else if (history?.count || !waiting.has(task.status)) {
      missing = 'retry-or-progress-unknown';
      workMayNeedRework = true;
    } else if (!quoteCurrent) missing = result.plan.state;
    else if (task.costBudgetHold || !retainsAssignment(store, task, node)) missing = 'dispatch-cost-unverified';
    else {
      coverage.unstarted++;
      unstarted += BigInt(estimates.get(node.key).micros);
    }
    if (missing) {
      coverage.unknown++;
      reasons.add(missing);
    }
  }
  const scopeChanged = !taskScope || changedTasks.size > 0;
  const finished = contractCurrent && !scopeChanged && goal.status === 'succeeded' &&
    goal.completedContractVersion === contractVersion(goal) && coverage.delivered === coverage.selected;
  // A completed scope does not depend on a current quote for future work.
  if (!finished && result.plan.state === 'quote-stale') reasons.add('quote-stale');
  if (finished && ledger.reservedAttempts > ledger.awaitingReceiptAttempts) reasons.add('execution-cleanup-pending');
  result.unstartedMicros = finished || quoteCurrent ? unstarted.toString() : null;
  const phaseScope = quoteCurrent && !scopeChanged;
  // Stage estimates cover several possible activities. Once a stage may
  // have drawn on that estimate there is no per-stage balance to subtract
  // from; known actual charges and reserved caps still stay in the ledger.
  const otherStage = otherExecution || outside.length > 0 || unverifiedTasks.size > 0;
  result.acceptance = phaseForecast(cost.estimate.acceptance, phaseScope, finished,
    otherStage || resultMayExist || coverage.delivered > 0 || goal.compositionRecheck != null);
  result.rework = phaseForecast(cost.estimate.rework, phaseScope, finished,
    otherStage || workMayNeedRework || [...byTask.keys()].some(id => allTasks.get(id)?.reworks > 0));
  if (result.acceptance.state === 'unknown' || result.rework.state === 'unknown') reasons.add('phase-remaining-unknown');

  const covered = booked + unstarted + BigInt(result.acceptance.remainingMicros ?? 0) + BigInt(result.rework.remainingMicros ?? 0);
  result.coveredMicros = covered.toString();
  result.reasons = [...reasons];
  if (!reasons.size) {
    const headroom = BigInt(ledger.limitMicros) - covered;
    result.status = headroom < 0n ? 'over-limit' : 'within-limit';
    result.completionBasis = finished ? 'settled' : 'forecast';
    result.completionMicros = covered.toString();
    result.headroomMicros = headroom.toString();
  }
  return result;
}

export function goalCostForecast(company, goalId, executor) {
  assert(typeof goalId === 'string' && goalId.length > 0 && goalId.length <= 200, 'INVALID_INPUT', '请选择目标查看完工费用估算。');
  return company.store.readSnapshot(() => {
    const goal = company.store.require('goals', goalId);
    const budget = company.store.get('goalCostBudgets', goal.id);
    return budget ? forecast(company, goal, budget, executor) : { goalId: goal.id, enabled: false };
  });
}
