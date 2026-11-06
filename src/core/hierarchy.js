export const visibleTask = task => task.status !== 'deleted';
export function goalSummary(goal, tasks) {
  const children = tasks.filter(t => t.goalId === goal.id && visibleTask(t) && t.kind !== 'review');
  return { total: children.length, done: children.filter(t => ['succeeded', 'archived'].includes(t.status)).length, status: children.length ? goal.status : 'empty' };
}
export function taskAncestors(task, tasks) {
  const result = []; const seen = new Set([task.id]); let id = task.parentId;
  while (id && !seen.has(id)) { seen.add(id); const parent = tasks.find(t => t.id === id && visibleTask(t)); if (!parent) break; result.unshift(parent); id = parent.parentId; }
  return result;
}
