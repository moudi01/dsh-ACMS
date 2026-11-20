import { assert, now } from './util.js';

export const PLAN_APPROVAL_REQUIRED = '此目标的根计划等待所有者批准。';
export const approvalPlanId = task => `${task.id}:g${task.generation}`;
export const isApprovalPlanner = (goal, task) => task?.kind === 'plan' && goal?.planApproval?.taskId === task.id;
export const awaitsPlanApproval = goal => !!goal?.planApproval && !goal.planApproval.approvedPlanId;
export const isCostPlanner = (goal, task) => isApprovalPlanner(goal, task) && goal.planApproval.costPlanning === true;
export const planBlocksWork = (goal, kind) => awaitsPlanApproval(goal) && ['work', 'repair'].includes(kind);

export function planBlocksDispatch(goal, task) {
  return planBlocksWork(goal, task.kind) || (isApprovalPlanner(goal, task) &&
    (!!goal.planApproval.approvedPlanId || task.blocker?.kind === 'plan-approval'));
}

export function assertPlanAllowsWork(goal, kind) {
  assert(!planBlocksWork(goal, kind), 'PLAN_APPROVAL_REQUIRED', PLAN_APPROVAL_REQUIRED);
}

export function supersedePendingPlan(store, task, actor, reason) {
  const plan = store.get('plans', approvalPlanId(task));
  if (plan?.approvalStatus !== 'pending') return;
  store.put('plans', { ...plan, approvalStatus: 'superseded', supersededAt: now(), supersededReason: reason });
  store.event('plan.approval.superseded', task.id, { planId: plan.id, generation: plan.generation, reason }, actor, { goalId: task.goalId });
}
