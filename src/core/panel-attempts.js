import { assert } from './util.js';

const taskAttemptPageSize = 30;

export const attemptForOwner = ({ meteredUsage, ...attempt }) => attempt;

export function attemptForPanel(attempt) {
  const { id, revision, taskId, goalId, agentId, status, startedAt, elapsedMs, cleanupPending, cleanupUncertain,
    costDeferralRequestId, deferredReplayAt } = attempt;
  return { id, revision, taskId, goalId, agentId, status, startedAt, elapsedMs, cleanupPending, cleanupUncertain,
    costDeferralRequestId, deferredReplayAt };
}

export function taskAttemptHistory(store, params) {
  const taskId = params.get('taskId');
  const rawBefore = params.get('before');
  const refreshIds = params.getAll('refresh');
  const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
  assert(typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 200 &&
    (rawBefore === null || /^\d+$/.test(rawBefore)) && Number.isSafeInteger(before) && before >= 1 &&
    (!refreshIds.length || (rawBefore === null && refreshIds.length <= 32 && refreshIds.every(id => id.length > 0 && id.length <= 200))),
  'INVALID_INPUT', '请选择任务并使用有效的历史游标。');
  return store.readSnapshot(() => {
    const task = store.get('tasks', taskId);
    assert(task && task.status !== 'deleted' && (!task.goalId || store.get('goals', task.goalId)?.status !== 'deleted') &&
      (!task.projectId || store.get('projects', task.projectId)?.status !== 'deleted'), 'NOT_FOUND', '当前任务不可查看。');
    const page = store.attemptUsagePage('task', taskId, before, taskAttemptPageSize);
    return { taskId, cursor: store.cursor(),
      attempts: page.slice(0, taskAttemptPageSize).map(({ attempt, cursor }) => ({ ...attemptForOwner(attempt), historyPosition: cursor })),
      nextBefore: page.length > taskAttemptPageSize ? page[taskAttemptPageSize - 1].cursor : null,
      ...(rawBefore === null ? { activeAttempts: store.taskPanelActiveAttempts(taskId).map(attemptForOwner),
        verifications: store.taskPanelVerifications(taskId),
        ...(refreshIds.length ? { refreshedAttempts: store.taskPanelAttemptUpdates(taskId, [...new Set(refreshIds)]).map(attemptForOwner) } : {}) } : {}) };
  });
}
