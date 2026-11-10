// Stopping does not mean the old execution has been observed to stop. Keep
// receipt refresh available for persisted stop intents without a live host.
export const integrationPending = record => ['preparing', 'checking', 'applying', 'reconciling'].includes(record.phase);

export function goalTaskCount(tasks, goalId) {
  return tasks.filter(task => task.goalId === goalId && task.status !== 'deleted').length;
}

export function goalContractCapacityMessage(used, limit) {
  return `目标任务名额已满（已用 ${used} 项，上限 ${limit} 项）。请在「公司设置 → 编辑边界」调高「每个目标任务上限」，为合同确认留出一个名额。`;
}

export function canReconcileTask(task, attempts) {
  return task.status === 'reconciling' || (task.status === 'stopping' && (!!task.activeIntegrationId || attempts.some(a => a.taskId === task.id
    && (['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending))));
}

export function taskDeletionReason(task, tasks, attempts) {
  if (task.kind === 'review') return '审查任务随对应的执行任务一起删除。';
  const ids = new Set([task.id, ...tasks.filter(t => t.reviewOf === task.id && t.status !== 'deleted').map(t => t.id)]);
  if (tasks.some(t => ids.has(t.id) && ['running', 'preparing', 'integrating', 'stopping', 'reconciling'].includes(t.status)) || attempts.some(a => ids.has(a.taskId) && (['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending))) return '请先暂停任务，并等待执行和审查资源释放后再删除。';
  const dependents = tasks.filter(t => t.status !== 'deleted' && !ids.has(t.id) && (t.dependencies.some(id => ids.has(id)) || ids.has(t.parentId)));
  if (dependents.length) return `仍有关联任务：${dependents.map(t => t.title).slice(0, 3).join('、')}。请先解除依赖或删除子任务。`;
  return '';
}

export function taskPurgeReason(task, tasks, attempts) {
  if (task.status !== 'deleted' || task.deletion?.batchId !== task.id) return '只能彻底删除回收站中的执行任务。';
  const ids = new Set(tasks.filter(t => t.deletion?.batchId === task.id).map(t => t.id));
  if (attempts.some(a => ids.has(a.taskId) && (['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending))) return '执行资源尚未释放，请等待清理完成。';
  const related = tasks.filter(t => !ids.has(t.id) && (t.dependencies.some(id => ids.has(id)) || ids.has(t.parentId) || ids.has(t.reviewOf)));
  if (related.length) return `请先解除关联或彻底删除关联任务：${related.map(t => t.title).slice(0, 3).join('、')}`;
  return '';
}
