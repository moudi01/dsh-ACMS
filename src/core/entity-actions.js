export const isLiveAttempt = a => ['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending;
export function entityTasks(kind, entity, data) {
  return data.tasks.filter(t => kind === 'project' ? t.projectId === entity.id : kind === 'goal' ? t.goalId === entity.id : t.agentId === entity.id);
}
export function entityDeletionReason(kind, entity, data) {
  if (entity.status === 'deleted') return '已在回收站中。';
  const tasks = entityTasks(kind, entity, data).filter(t => t.status !== 'deleted');
  const ids = new Set(tasks.map(t => t.id));
  if (tasks.some(t => ['running', 'preparing', 'integrating', 'stopping', 'reconciling'].includes(t.status)) || data.attempts.some(a => (kind === 'agent' ? a.agentId === entity.id : ids.has(a.taskId)) && isLiveAttempt(a))) return '请先暂停关联任务，等待执行和资源清理完成后再删除。';
  if (kind === 'agent' && tasks.some(t => !['succeeded', 'cancelled', 'archived'].includes(t.status))) return '此角色仍有未完成任务，请先将任务转交给其他角色。';
  if (kind === 'agent' && entity.role === 'manager' && !data.agents.some(a => a.id !== entity.id && a.role === 'manager' && a.status === 'available')) return '请先保留或创建另一位可分配的管理角色，用于后续目标规划。';
  return '';
}
