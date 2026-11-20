import { goalCostRoute, markGoalCostCleanup, reserveGoalCost, settleGoalCost, validGoalCostBound } from '../core/goal-cost-budget.js';
import { assessOptionalDispatch, optionalCostEvidence } from '../core/cost-optional.js';
import { OPTIONAL_COST_WAIT } from '../core/task-actions.js';
import { goalStopped } from '../core/goal-control.js';
import { matchesGoalContract } from '../core/goal-contract.js';
import { assert, now, SYSTEM } from '../core/util.js';

// Only a registered host adapter can provide this contract. A quote performs
// no process launch or billable work. start must enforce the exact route and
// cap, honor assertCurrent immediately before each billable side effect, and
// be idempotent for authorizationId. Both activation.dispose and reconcile
// attest cleanup with that ID. readReceipt is a bounded local read independent
// of the task and its business result, and attests the final charge.
function taskCostExecutor(adapter) {
  const executor = adapter.taskCost;
  return typeof executor?.id === 'string' && typeof executor.quote === 'function' &&
    typeof executor.start === 'function' && typeof executor.readReceipt === 'function' &&
    typeof executor.reconcile === 'function' ? executor : null;
}

export function admitTaskCost(engine, input) {
  const { store, adapter } = engine;
  const budget = store.get('goalCostBudgets', input.attempt.goalId);
  if (!budget) return {};
  const executor = taskCostExecutor(adapter);
  const route = goalCostRoute(input.routeSelection);
  let quote;
  if (executor && route) {
    try { quote = executor.quote({ ...input, route }); }
    catch { /* No current authoritative quote means no dispatch. */ }
  }
  const bound = quote ? { ...quote, executorId: executor.id } : null;
  if (input.task.origin?.kind === 'manager-plan' && validGoalCostBound(bound, route)) {
    const goal = store.require('goals', input.attempt.goalId);
    const denied = assessOptionalDispatch(engine.company, goal, budget, input.task, bound, executor);
    if (denied) return { denied: { ...denied, attemptId: input.attempt.id, quotedAt: now() } };
  }
  const result = reserveGoalCost(store, input.attempt, bound, route);
  return { ...result, executor };
}

export function assertTaskCostCurrent(engine, executor, authorization) {
  const row = engine.store.get('goalCostAttempts', authorization.id);
  const budget = engine.store.require('goalCostBudgets', authorization.goalId);
  assert(taskCostExecutor(engine.adapter) === executor && row?.status === 'reserved' &&
    row.authorizationId === authorization.authorizationId && !budget.breach,
  'COST_AUTHORIZATION_STALE', '本次金额预留已失效，执行停止于下一次费用调用前。');
}

export function matchesTaskCostAuthorization(authorization, fact) {
  return fact?.authorizationId === authorization.authorizationId;
}

export async function reconcileTaskCost(engine, attempt, authorization) {
  const executor = taskCostExecutor(engine.adapter);
  if (executor?.id !== authorization.executorId) return { status: 'unknown', reason: '原金额执行器未能核对同一预留。' };
  const fact = await executor.reconcile(authorization, attempt);
  return matchesTaskCostAuthorization(authorization, fact) ? fact : { status: 'unknown', reason: '结束回执未匹配本次金额预留。' };
}

function finishUnlaunchedTask(engine, attempt, status, reason) {
  const { store } = engine;
  const saved = engine.finishAttempt(attempt, status, reason);
  const finished = store.put('attempts', { ...saved, preflightOnly: true, cleanupPending: false });
  store.event('attempt.cleanup.confirmed', saved.id, { taskId: saved.taskId, noLaunch: true }, SYSTEM);
  return finished;
}

export function holdTaskCost(engine, attempt, task, denied) {
  const { store } = engine;
  finishUnlaunchedTask(engine, attempt, 'failed', denied.reason);
  store.put('tasks', { ...task, status: 'blocked',
    attempts: Math.max(0, task.attempts - (attempt.preparingHost ? 0 : 1)), retryAt: null,
    blocker: task.blocker && task.blocker.kind !== 'cost-budget' ? task.blocker : { kind: 'cost-budget', reason: denied.reason },
    costBudgetHold: denied });
  store.event('task.cost_budget.blocked', task.id, { code: denied.code,
    ...(denied.code === OPTIONAL_COST_WAIT ? { costBasis: optionalCostEvidence(denied) } : {}) }, SYSTEM, { goalId: task.goalId });
  engine.updateGoal(task.goalId);
}

export function interruptUnlaunchedTaskCost(engine, attempt, authorization, error) {
  const { store } = engine;
  engine.fenced();
  const saved = finishUnlaunchedTask(engine, attempt, 'interrupted', error.message);
  markGoalCostCleanup(store, saved.id);
  settleGoalCost(store, saved.id, { final: true, receiptId: 'host-no-dispatch', attemptId: saved.id,
    authorizationId: authorization.authorizationId, currency: authorization.currency, amountMicros: '0' }, 'host-no-dispatch');
  const task = store.require('tasks', attempt.taskId);
  if (task.activeAttemptId === attempt.id && task.generation === attempt.taskGeneration &&
      (task.stopRequested || ['running', 'reconciling'].includes(task.status))) {
    const status = task.stopRequested ?? (engine.closing ? 'paused' : 'ready');
    store.put('tasks', { ...task, status, attempts: Math.max(0, task.attempts - 1), stopRequested: null,
      resumeOnStart: engine.closing && !task.stopRequested, retryAt: null });
  }
  engine.company.releaseTemporaryAgent(attempt.agentId);
  store.event('task.cost_budget.launch_withdrawn', task.id, { attemptId: attempt.id }, SYSTEM, { goalId: task.goalId });
}

export function releaseTaskCostWaits(engine) {
  const { store } = engine;
  const budgets = new Map(store.list('goalCostBudgets').map(row => [row.id, row]));
  if (!budgets.size) return;
  // Durable optional holds are repriced on a bounded cadence. No duplicate
  // attempts or audit records are emitted while the hold remains applicable.
  const refreshOptional = Date.now() >= (engine.nextOptionalCostCheck ?? 0);
  if (refreshOptional) engine.nextOptionalCostCheck = Date.now() + 1000;
  const pending = new Set(store.list('interactions').filter(item => item.status === 'pending').map(item => item.taskId));
  for (const task of store.list('tasks')) {
    const budget = budgets.get(task.goalId);
    const hold = task.costBudgetHold;
    if (!budget || budget.breach || task.status !== 'blocked' || task.stopRequested || task.blocker?.kind !== 'cost-budget' ||
      task.environmentBlock || task.goalPauseId || task.contractObsolete || pending.has(task.id) ||
      task.dependencies.some(id => store.get('tasks', id)?.status !== 'succeeded')) continue;
    const goal = store.require('goals', task.goalId);
    if (goalStopped(goal) || !matchesGoalContract(goal, task)) continue;
    if (hold?.code === OPTIONAL_COST_WAIT) {
      if (!refreshOptional || goal.contractChange?.status === 'pending') continue;
      const executor = taskCostExecutor(engine.adapter);
      const sameBoundSource = executor?.id === hold.bound?.executorId && store.get('agents', task.agentId)?.revision === hold.agentRevision;
      const next = sameBoundSource && assessOptionalDispatch(engine.company, goal, budget, task, hold.bound, executor);
      if (next) {
        if (hold.reasonCode !== next.reasonCode) store.put('tasks', { ...task,
          costBudgetHold: { ...next, attemptId: hold.attemptId, quotedAt: hold.quotedAt },
          blocker: { ...task.blocker, reason: next.reason } });
        continue;
      }
    } else if (hold?.code !== 'COST_LIMIT_REACHED' || hold.releaseVersion === budget.releaseVersion) continue;
    store.put('tasks', { ...task, status: 'ready', blocker: null, costBudgetHold: null });
    store.event('task.cost_budget.released', task.id, {}, SYSTEM, { goalId: task.goalId });
  }
}

export function settleAvailableTaskCosts(engine, attemptId) {
  const executor = taskCostExecutor(engine.adapter);
  if (!executor) return;
  const { store } = engine;
  let rows;
  if (attemptId) rows = [store.get('goalCostAttempts', attemptId)];
  else {
    const limit = 32;
    const page = store.awaitingGoalCostReceipts(engine.costReceiptCursor ?? 0, limit);
    engine.costReceiptCursor = page.length < limit ? 0 : page.at(-1).cursor;
    rows = page.map(item => item.row);
  }
  for (const row of rows) {
    if (row?.status !== 'awaiting-receipt' || row.executorId !== executor.id) continue;
    let fact;
    try { fact = executor.readReceipt(row); }
    catch { continue; } // Delayed, unavailable, or invalid proof keeps its reservation.
    if (!fact) continue;
    store.transaction(() => { engine.fenced(); settleGoalCost(store, row.id, fact); });
  }
}
