import { goalCostBudgetView, goalCostCurrency, goalCostRoute, validGoalCostMicros } from './goal-cost-budget.js';
import { modelPolicyFingerprint } from './model-selection.js';
import { assert, digest } from './util.js';

const basis = value => typeof value === 'string' && value.trim() && value.length <= 1000 ? value.trim() : null;

export function costPlanBalance(budget) {
  if (!budget) return null;
  const { currency, limitMicros, settledMicros, reportedAttempts, reservedMicros, reservedAttempts,
    awaitingReceiptAttempts, availableMicros, breach } = goalCostBudgetView(budget);
  return { currency, limitMicros, settledMicros, reportedAttempts, reservedMicros, reservedAttempts,
    awaitingReceiptAttempts, availableMicros, breach: !!breach };
}

export function costPlanIntent(ordered, output) {
  const nodes = ordered.map(node => ({ key: node.key,
    importance: ['required', 'optional'].includes(node.importance) ? node.importance : null, modelBasis: basis(node.modelBasis) }));
  return { nodes, acceptanceBasis: basis(output.costPlan?.acceptanceBasis), reworkBasis: basis(output.costPlan?.reworkBasis) };
}

function costContext(company, goal, tasks) {
  const project = company.store.require('projects', goal.projectId);
  const review = { finalReview: goal.templateSnapshot?.finalReview === true, checks: project.checks ?? [] };
  const assignments = tasks.map(task => task.assignee ? company.store.get('agents', task.assignee) : null);
  const { allowedProviders, allowedModels } = company.policy();
  const policy = { allowedProviders, allowedModels };
  const preferences = company.store.get('modelPreferences', 'model');
  const version = digest({ review, assignments: assignments.map(agent => agent && [agent.id, agent.revision]),
    policy: modelPolicyFingerprint(policy), preferences: preferences?.revision ?? null });
  return { review, assignments, policy, preferences, version };
}

function normalizeEstimate(value, withRoute = false) {
  if (!validGoalCostMicros(value?.micros) || !basis(value.basis)) return null;
  const route = withRoute ? goalCostRoute({ status: 'selected', chosen: value.route }) : null;
  if (withRoute && (!route || route.provider.length > 200 || route.model.length > 4096 ||
    (route.llmProvider?.length ?? 0) > 200 || (route.reasoningEffort?.length ?? 0) > 80)) return null;
  return { micros: value.micros, basis: basis(value.basis), ...(route ? { route } : {}) };
}

function normalizeQuote(quote, executorId, keys) {
  if (typeof executorId !== 'string' || !executorId || executorId.length > 200 ||
      typeof quote?.quoteId !== 'string' || !quote.quoteId || quote.quoteId.length > 200 ||
      quote.currency !== goalCostCurrency || !Array.isArray(quote.tasks) || quote.tasks.length !== keys.length) return null;
  const raw = new Map(quote.tasks.map(task => [task?.key, task]));
  if (raw.size !== keys.length) return null;
  const tasks = keys.map(key => ({ key, estimate: normalizeEstimate(raw.get(key), true) }));
  const acceptance = normalizeEstimate(quote.acceptance), rework = normalizeEstimate(quote.rework);
  if (!acceptance || !rework || tasks.some(row => !row.estimate)) return null;
  return { executorId, quoteId: quote.quoteId, currency: quote.currency, tasks, acceptance, rework };
}

function readPlanEstimate(executor, goal, task, tasks, intent, context) {
  // Use the same scope and policy inputs before and after restart. Workflow
  // status, timestamps and available balance do not describe the priced work.
  const input = {
    goal: { id: goal.id, projectId: goal.projectId, contractVersion: goal.contractVersion ?? 1,
      description: goal.description, acceptance: goal.acceptance },
    task: { id: task.id, generation: task.generation, kind: task.kind },
    tasks, intent, ...context,
  };
  try {
    return normalizeQuote(executor?.estimatePlan?.(input), executor?.id, tasks.map(node => node.key));
  } catch {
    return null; // Unavailable or invalid host estimate leaves the plan held.
  }
}

// Existing priced goals with no implemented plan can enter the gate after an
// upgrade. Keep older approvals and goals with already executed work intact.
export function installPendingCostPlans(store) {
  const goals = store.list('goalCostBudgets').map(budget => store.get('goals', budget.id)).filter(goal =>
    goal && !['succeeded', 'cancelled', 'archived', 'deleted'].includes(goal.status) &&
    !goal.planApproval?.costPlanning && !goal.planApproval?.approvedPlanId);
  if (!goals.length) return;
  store.transaction(() => {
    const tasks = store.list('tasks');
    const implementedGoals = new Set(store.list('attempts').filter(row =>
      !row.preflightOnly && ['work', 'repair'].includes(row.kind)).map(row => row.goalId));
    const acceptedPlans = new Set(store.list('plans').filter(plan => plan.acceptedAt).map(plan => plan.taskId));
    const pricedAttempts = store.list('goalCostAttempts');
    for (const listed of goals) {
      const goal = store.require('goals', listed.id);
      if (goal.revision !== listed.revision || implementedGoals.has(goal.id)) continue;
      const roots = tasks.filter(task => task.goalId === goal.id && task.kind === 'plan' && !task.parentId &&
        (!goal.planApproval?.taskId || goal.planApproval.taskId === task.id));
      if (roots.length !== 1 || acceptedPlans.has(roots[0].id) ||
          ['succeeded', 'cancelled', 'archived', 'deleted'].includes(roots[0].status) ||
          pricedAttempts.some(row => row.goalId === goal.id && row.taskId !== roots[0].id)) continue;
      store.put('goals', { ...goal, planApproval: { ...goal.planApproval, taskId: roots[0].id, costPlanning: true } });
    }
  });
}

export function costPlanHasUnscopedWork(store, goalId) {
  return store.list('tasks').some(task => task.goalId === goalId && ['work', 'repair'].includes(task.kind) &&
    !['cancelled', 'deleted', 'archived'].includes(task.status));
}

export function assessCostPlan(engine, goal, task, proposalTasks, intent) {
  const { company, store, adapter } = engine;
  const submitted = costPlanBalance(store.require('goalCostBudgets', goal.id));
  const context = costContext(company, goal, proposalTasks);
  const byKey = new Map(intent.nodes.map(node => [node.key, node]));
  const requiredKeys = intent.nodes.filter(node => node.importance === 'required').map(node => node.key);
  const base = { intent, submitted, contextVersion: context.version, requiredKeys,
    estimate: null, estimateFingerprint: null, minimumMicros: null, fullMicros: null, selectedKeys: [], selectedMicros: null };
  if (!requiredKeys.length || intent.nodes.some(node => !node.importance || !node.modelBasis) || !intent.acceptanceBasis || !intent.reworkBasis) {
    return { ...base, status: 'incomplete', reason: '请退回规划，补充必做和可选分类、选模依据、验收及返工预留依据。' };
  }
  if (proposalTasks.some(node => byKey.get(node.key).importance === 'required' &&
      node.dependencies.some(key => byKey.get(key)?.importance !== 'required'))) {
    return { ...base, status: 'incomplete', reason: '必做任务依赖可选任务。请退回规划并补齐最低交付的前置任务。' };
  }
  const estimate = readPlanEstimate(adapter.taskCost, goal, task, proposalTasks, intent, context);
  if (!estimate) return { ...base, status: 'incomplete', reason: '宿主还没有覆盖本计划的可信估算。请核对执行器报价能力后退回重新规划。' };
  const reserved = BigInt(estimate.acceptance.micros) + BigInt(estimate.rework.micros);
  const taskAmounts = new Map(estimate.tasks.map(row => [row.key, BigInt(row.estimate.micros)]));
  const minimum = requiredKeys.reduce((sum, key) => sum + taskAmounts.get(key), reserved);
  const full = [...taskAmounts.values()].reduce((sum, amount) => sum + amount, reserved);
  const available = BigInt(submitted.availableMicros);
  const fitsFull = !submitted.breach && full <= available;
  const fitsMinimum = !submitted.breach && minimum <= available;
  return { ...base, estimate, estimateFingerprint: digest(estimate), minimumMicros: minimum.toString(), fullMicros: full.toString(),
    selectedKeys: fitsFull ? proposalTasks.map(node => node.key) : requiredKeys,
    selectedMicros: (fitsFull ? full : minimum).toString(), status: fitsMinimum ? 'fits' : 'shortfall',
    reason: fitsFull ? null : fitsMinimum ? '可选任务已延期，以保留验收和返工额度。' :
      submitted.breach ? '执行器的真实费用超出承诺。请核对费用回执。' : '当前可派发余额不足以覆盖最低交付。可追加金额、退回缩小范围，或结束目标。' };
}

export function recheckCostPlan(company, goal, plan, reprice) {
  const cost = plan.costPlan;
  assert(cost?.estimate && cost.selectedKeys.length && cost.selectedMicros !== null,
    'COST_PLAN_ESTIMATE_REQUIRED', '请退回计划，补齐可核对的宿主估算后再派工。');
  const context = costContext(company, goal, plan.proposalTasks);
  assert(context.version === cost.contextVersion,
    'COST_PLAN_ESTIMATE_STALE', '验收检查、模型策略或执行分派已变化，请退回计划重新估算。');
  assert(!costPlanHasUnscopedWork(company.store, goal.id), 'COST_PLAN_UNSCOPED_WORK',
    '此目标还有未纳入提案的旧任务，请先移除这些未派发任务。');
  if (reprice) {
    const current = reprice.executor?.id === cost.estimate.executorId ?
      readPlanEstimate(reprice.executor, goal, reprice.task, plan.proposalTasks, cost.intent, context) : null;
    assert(current && digest(current) === cost.estimateFingerprint,
      'COST_PLAN_ESTIMATE_STALE', '受信宿主估算已变化或无法核对。请退回此提案重新估算。');
  }
  const balance = costPlanBalance(company.store.require('goalCostBudgets', goal.id));
  assert(!balance.breach && BigInt(balance.availableMicros) >= BigInt(cost.selectedMicros),
    'COST_PLAN_LIMIT', '当前余额无法覆盖此计划版本。请追加金额、退回调整范围，或结束目标。');
  const selected = new Set(cost.selectedKeys);
  return { balance, tasks: plan.proposalTasks.filter(node => selected.has(node.key)) };
}
