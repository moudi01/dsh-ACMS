export const visibleTask = task => task.status !== 'deleted';
export const ENVIRONMENT_RECOVERED_REASON = '环境重新预检通过';
export function taskSettledForGoal(task) {
  if (['succeeded', 'archived'].includes(task.status)) return true;
  if (task.status !== 'cancelled' || task.kind !== 'coordination' || task.origin?.blockerKind !== 'environment') return false;
  // The first preflight version recorded only the scheduler cancellation reason.
  return (!!task.environmentResolution && task.environmentResolution.sourceTaskId === task.coordinationOf) ||
    (task.cancelledBy === 'scheduler' && task.cancelReason === ENVIRONMENT_RECOVERED_REASON);
}
export function goalSummary(goal, tasks) {
  const children = tasks.filter(t => t.goalId === goal.id && visibleTask(t) && t.kind !== 'review');
  return { total: children.length, done: children.filter(taskSettledForGoal).length, status: children.length ? goal.status : 'empty' };
}
export function taskAncestors(task, tasks) {
  const result = []; const seen = new Set([task.id]); let id = task.parentId;
  while (id && !seen.has(id)) { seen.add(id); const parent = tasks.find(t => t.id === id && visibleTask(t)); if (!parent) break; result.unshift(parent); id = parent.parentId; }
  return result;
}
