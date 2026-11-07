import { assert, digest } from './util.js';

// References are data, never expressions: only an earlier action's returned ID.
function resolve(value, results) {
  if (typeof value === 'string' && value.startsWith('$actions[')) {
    const match = /^\$actions\[(\d+)\]\.id$/.exec(value);
    assert(match && Number(match[1]) < results.length, 'INVALID_ACTION_REFERENCE', '引用只能是已完成动作的 $actions[序号].id');
    const result = results[Number(match[1])];
    assert(typeof result?.id === 'string', 'INVALID_ACTION_REFERENCE', '被引用动作没有返回 ID');
    return result.id;
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, results)]));
  return value;
}

export function runActionBatch(company, actor, { taskId, generation, batchId, actions }) {
  const { store } = company;
  assert(actor?.kind === 'agent', 'FORBIDDEN', 'Management batches require an assigned agent');
  const manager = store.require('agents', actor.id);
  assert(manager.role === 'manager', 'FORBIDDEN', 'Only a manager can submit management actions');
  const task = store.require('tasks', taskId);
  // The caller-supplied actor.goalId is derived from the task goal, so it cannot
  // prove that the manager belongs to that goal. Re-read the persisted manager and
  // reject a goal-scoped manager acting on another goal's task, for example after a
  // manual task.edit reassignment. A global manager (no goalId) stays eligible.
  assert(!manager.goalId || manager.goalId === task.goalId, 'SCOPE_DENIED', 'Manager may only act within its assigned goal');
  assert(task.agentId === actor.id && task.goalId === actor.goalId && task.generation === generation && task.status === 'running' && !task.stopRequested, 'STALE_RESULT', 'Management batch belongs to an obsolete assignment');
  assert(typeof batchId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(batchId), 'INVALID_BATCH_ID', 'actionBatchId must be a stable 1–80 character identifier');
  assert(Array.isArray(actions) && actions.length > 0 && actions.length <= 10, 'INVALID_ACTIONS', 'Management batches contain 1–10 actions');
  const id = `batch_${digest({ taskId, generation, batchId })}`;
  const fingerprint = digest({ actorId: actor.id, actions });
  return store.transaction(() => {
    const previous = store.get('actionBatches', id);
    if (previous) assert(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Action batch ID reused with different input');
    const results = [];
    for (const [index, action] of actions.entries()) {
      assert(action && typeof action.command === 'string' && action.args && typeof action.args === 'object' && !Array.isArray(action.args), 'INVALID_ACTIONS', 'Each action needs command and args');
      const args = resolve(action.args, results);
      // Recheck current AND captured grants even when serving a cached batch.
      company.authorize(actor, action.command, args);
      results.push(previous ? previous.results[index] : company.command(actor, `${id}:${index}`, action.command, args));
    }
    if (previous) return previous;
    const saved = store.put('actionBatches', { id, taskId, generation, batchId, actorId: actor.id, fingerprint, results });
    store.event('management.batch.committed', taskId, { batchId, actionCount: actions.length, resultIds: results.map(r => r.id) }, actor);
    return saved;
  });
}
