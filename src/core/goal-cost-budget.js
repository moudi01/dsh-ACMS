import { assert, digest, now, SYSTEM } from './util.js';

const maximumMicros = BigInt(Number.MAX_SAFE_INTEGER);
export const goalCostCurrency = 'USD';
const microsPattern = /^(0|[1-9]\d{0,15})$/;
const shortId = value => typeof value === 'string' && !!value.trim() && value.length <= 200;
const validMicros = value => typeof value === 'string' && microsPattern.test(value) && BigInt(value) <= maximumMicros;

export function parseGoalCostUsd(value) {
  const match = typeof value === 'string' && /^(\d{1,10})(?:\.(\d{1,6}))?$/.exec(value.trim());
  assert(match, 'INVALID_INPUT', '请输入美元金额，最多六位小数。');
  const micros = BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  assert(micros <= maximumMicros, 'INVALID_INPUT', '金额超出可核算范围。');
  return micros;
}

export function createGoalCostBudget(store, goalId, amount, actor) {
  const limitMicros = parseGoalCostUsd(amount).toString();
  const result = store.put('goalCostBudgets', { id: goalId, currency: goalCostCurrency, limitMicros,
    settledMicros: '0', settledAttempts: 0, reportedAttempts: 0, reservedMicros: '0', reservedAttempts: 0, awaitingReceiptAttempts: 0, releaseVersion: 0, breach: null });
  store.event('goal.cost_budget.enabled', goalId, { limitMicros, currency: goalCostCurrency }, actor);
  return result;
}

export function extendGoalCostBudget(store, goalId, amount, actor) {
  const current = store.get('goalCostBudgets', goalId);
  assert(current, 'COST_BUDGET_DISABLED', '金额上限仅可在新建目标时启用。');
  assert(!current.breach, 'COST_CONTRACT_BREACH', '请先核对执行器报告的费用上界违规。');
  const additional = parseGoalCostUsd(amount), limit = BigInt(current.limitMicros) + additional;
  assert(additional > 0n && limit <= maximumMicros, 'INVALID_INPUT', '请填写可核算的正数追加金额。');
  const result = store.put('goalCostBudgets', { ...current, limitMicros: limit.toString(), releaseVersion: current.releaseVersion + 1 });
  store.event('goal.cost_budget.extended', goalId, { additionalMicros: additional.toString(), limitMicros: result.limitMicros,
    currency: goalCostCurrency }, actor);
  return result;
}

export function goalCostBudgetView(budget) {
  const available = BigInt(budget.limitMicros) - BigInt(budget.settledMicros) - BigInt(budget.reservedMicros);
  return { ...budget, availableMicros: (budget.breach || available < 0n ? 0n : available).toString() };
}

export function goalCostRoute(selection) {
  if (selection?.status !== 'selected' || !selection.chosen) return null;
  const { provider, llmProvider, model, reasoningEffort } = selection.chosen;
  if (typeof provider !== 'string' || !provider || provider === 'auto' || typeof model !== 'string' || !model ||
      (llmProvider != null && typeof llmProvider !== 'string') || (reasoningEffort != null && typeof reasoningEffort !== 'string')) return null;
  return { provider, llmProvider: llmProvider || null, model, reasoningEffort: reasoningEffort || null };
}

function denied(budget, code, reason) {
  return { denied: { code, reason, releaseVersion: budget.releaseVersion } };
}

export function reserveGoalCost(store, attempt, bound, route) {
  const budget = store.get('goalCostBudgets', attempt.goalId);
  if (!budget) return {};
  if (budget.breach) return denied(budget, 'COST_CONTRACT_BREACH', '已报告费用超过执行器承诺的上界，请核对执行器回执。');
  if (!bound || !route || !shortId(bound.executorId) || !shortId(bound.quoteId) ||
      bound.currency !== goalCostCurrency || !validMicros(bound.upperMicros) || digest(bound.route ?? null) !== digest(route)) {
    return denied(budget, 'COST_BOUND_UNKNOWN', '当前选定的执行路由没有可信的美元费用上界。请核对该路由的执行器支持后重试。');
  }
  const auth = { attemptId: attempt.id, taskId: attempt.taskId, goalId: attempt.goalId,
    taskGeneration: attempt.taskGeneration, goalContractVersion: attempt.goalContractVersion,
    contextKey: attempt.contextKey, executorId: bound.executorId, quoteId: bound.quoteId,
    currency: bound.currency, upperMicros: bound.upperMicros, route };
  const authorizationId = digest(auth);
  const prior = store.get('goalCostAttempts', attempt.id);
  if (prior) {
    assert(prior.authorizationId === authorizationId && prior.status === 'reserved',
      'COST_AUTHORIZATION_STALE', '原预留的执行版本或费用上界已变化。');
    return { authorization: prior };
  }
  if (BigInt(bound.upperMicros) > BigInt(goalCostBudgetView(budget).availableMicros)) {
    return denied(budget, 'COST_LIMIT_REACHED', '目标剩余金额不足以预留本次执行的费用上界。可等待未结算费用，或由所有者明确追加。');
  }
  const row = store.put('goalCostAttempts', { ...auth, id: attempt.id, authorizationId, status: 'reserved' });
  store.put('goalCostBudgets', { ...budget, reservedMicros: (BigInt(budget.reservedMicros) + BigInt(row.upperMicros)).toString(),
    reservedAttempts: budget.reservedAttempts + 1 });
  store.event('goal.cost_budget.reserved', attempt.goalId, { attemptId: attempt.id, upperMicros: row.upperMicros,
    currency: row.currency, authorizationId }, SYSTEM);
  return { authorization: row };
}

export function markGoalCostCleanup(store, attemptId) {
  const row = store.get('goalCostAttempts', attemptId);
  if (row?.status !== 'reserved') return;
  const budget = store.require('goalCostBudgets', row.goalId);
  store.put('goalCostAttempts', { ...row, status: 'awaiting-receipt', cleanupConfirmedAt: now() });
  store.put('goalCostBudgets', { ...budget, awaitingReceiptAttempts: budget.awaitingReceiptAttempts + 1 });
  store.event('goal.cost_budget.awaiting_receipt', row.goalId, { attemptId }, SYSTEM);
}

export function settleGoalCost(store, attemptId, fact, source = 'executor') {
  const row = store.get('goalCostAttempts', attemptId);
  if (row?.status !== 'awaiting-receipt' || fact?.final !== true || !shortId(fact.receiptId) ||
      fact.attemptId !== row.id || fact.authorizationId !== row.authorizationId || fact.currency !== row.currency ||
      !validMicros(fact.amountMicros)) return false;
  const budget = store.require('goalCostBudgets', row.goalId);
  const upper = BigInt(row.upperMicros), amount = BigInt(fact.amountMicros);
  const breach = budget.breach ?? (amount > upper ? { attemptId, upperMicros: row.upperMicros, amountMicros: fact.amountMicros } : null);
  store.put('goalCostAttempts', { ...row, status: 'settled', receiptId: fact.receiptId, amountMicros: fact.amountMicros, source, settledAt: now() });
  store.put('goalCostBudgets', { ...budget, breach, settledMicros: (BigInt(budget.settledMicros) + amount).toString(),
    settledAttempts: budget.settledAttempts + 1, reportedAttempts: budget.reportedAttempts + (source === 'executor' ? 1 : 0),
    reservedMicros: (BigInt(budget.reservedMicros) - upper).toString(), reservedAttempts: budget.reservedAttempts - 1,
    awaitingReceiptAttempts: budget.awaitingReceiptAttempts - 1, releaseVersion: budget.releaseVersion + (upper > amount ? 1 : 0) });
  store.event('goal.cost_budget.settled', row.goalId, { attemptId, currency: row.currency, amountMicros: fact.amountMicros,
    receiptId: fact.receiptId, source }, SYSTEM);
  if (breach && !budget.breach) store.event('goal.cost_budget.breached', row.goalId, breach, SYSTEM);
  return true;
}
