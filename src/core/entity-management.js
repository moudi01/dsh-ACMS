import { assert, id, now, digest, TERMINAL } from './util.js';

const collections = { project: 'projects', goal: 'goals', agent: 'agents' };
import { entityTasks, entityDeletionReason, isLiveAttempt } from './entity-actions.js';

export function deleteEntity(company, kind, args, actor) {
  company.owner(actor); const { store } = company; const collection = collections[kind];
  const entity = store.require(collection, args.id);
  const data = Object.fromEntries(['tasks', 'attempts', 'agents', 'goals'].map(c => [c, store.list(c)]));
  const reason = entityDeletionReason(kind, entity, data); assert(!reason, 'DELETE_BLOCKED', reason);
  const batchId = id('deletion');
  const remove = (c, item, revision) => store.put(c, { ...item, status: 'deleted', deletion: { batchId, kind, rootId: entity.id, previousStatus: item.status ?? null, at: now() } }, revision);
  remove(collection, entity, args.expectedRevision);
  if (kind === 'project') for (const goal of data.goals.filter(g => g.projectId === entity.id && g.status !== 'deleted')) remove('goals', goal);
  if (kind !== 'agent') for (const task of entityTasks(kind, entity, data).filter(t => t.status !== 'deleted')) {
    remove('tasks', task); company.invalidateInteractions(task.id, '关联项目或目标已移入回收站');
  }
  store.event(`${kind}.deleted`, entity.id, { batchId }, actor);
  return store.require(collection, entity.id);
}

export function restoreEntity(company, kind, args, actor) {
  company.owner(actor); const { store } = company; const collection = collections[kind];
  const entity = store.require(collection, args.id);
  assert(entity.status === 'deleted' && entity.deletion?.rootId === entity.id && entity.deletion?.kind === kind, 'RESTORE_BLOCKED', '请恢复对应的项目、目标或角色删除批次');
  if (kind === 'goal') assert(store.require('projects', entity.projectId).status !== 'deleted', 'RESTORE_BLOCKED', '请先恢复所属项目');
  const batch = entity.deletion.batchId;
  for (const c of [collection, ...(kind === 'project' ? ['goals', 'tasks'] : kind === 'goal' ? ['tasks'] : [])]) for (const item of store.list(c).filter(x => x.status === 'deleted' && x.deletion?.batchId === batch)) {
    const previous = item.deletion.previousStatus;
    const status = c === 'tasks' ? (['succeeded', 'cancelled', 'archived'].includes(previous) ? previous : 'paused') : previous;
    store.put(c, { ...item, status, deletion: null, ...(c === 'tasks' ? { stopRequested: null, activeAttemptId: null, resumeOnStart: false } : {}) }, c === collection && item.id === entity.id ? args.expectedRevision : undefined);
  }
  store.event(`${kind}.restored`, entity.id, { batchId: batch }, actor);
  return store.require(collection, entity.id);
}

export function recordChange(company, kind, before, after, fields, actor) {
  const changes = fields.filter(k => digest(before[k] ?? null) !== digest(after[k] ?? null)).map(field => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
  if (!changes.length) return;
  const { store } = company;
  const tasks = kind === 'task' ? [after] : entityTasks(kind, after, { tasks: store.list('tasks') });
  const recipients = new Map();
  if (kind === 'agent') recipients.set(after.id, []);
  for (const task of tasks.filter(t => t.status !== 'deleted')) for (const agentId of new Set([task.agentId, ...(kind === 'task' ? [before.agentId] : [])].filter(Boolean))) {
    const ids = recipients.get(agentId) ?? []; ids.push(task.id); recipients.set(agentId, ids);
  }
  if (!recipients.size && kind !== 'agent') {
    const manager = store.list('agents').find(a => a.role === 'manager' && a.status === 'available');
    if (manager) recipients.set(manager.id, []);
  }
  const change = store.put('changes', { id: id('change'), entityKind: kind, entityId: after.id, title: after.title ?? after.name, changes, actor: actor.id, entityRevision: after.revision, at: now() });
  for (const [agentId, taskIds] of recipients) store.put('notifications', { id: id('notification'), changeId: change.id, agentId, taskIds, status: 'pending', entityKind: kind, entityId: after.id, title: change.title, changes });
  store.event(`${kind}.change.notified`, after.id, { changeId: change.id, agentIds: [...recipients.keys()] }, actor);
  return change;
}

export function restartForChange(company, task, { direct = false } = {}) {
  const { store } = company;
  assert(!['integrating', 'reconciling', 'stopping', 'deleted'].includes(task.status), 'TASK_ACTIVE', '正在集成、停止或核对执行，请等待完成后再编辑。');
  if (task.kind === 'review') return task;
  const attempts = store.list('attempts').filter(a => a.taskId === task.id && isLiveAttempt(a));
  assert(!attempts.some(a => a.cleanupPending && !['preparing', 'running'].includes(a.status)), 'TASK_ACTIVE', '执行资源正在清理，请稍候再编辑。');
  const active = attempts.length > 0;
  for (const review of store.list('tasks').filter(r => r.reviewOf === task.id && !TERMINAL.has(r.status))) company.controlTask({ id: review.id }, 'cancelled', { kind: 'system', id: 'scheduler' });
  const held = ['paused', 'blocked'].includes(task.status);
  const status = active ? 'stopping' : held ? task.status : !direct && TERMINAL.has(task.status) ? task.status : 'ready';
  const saved = store.put('tasks', { ...task, status, stopRequested: active ? 'ready' : null, generation: task.generation + 1, integrationPending: false, attempts: 0, reworks: 0, retryAt: null, resumeOnStart: false, contractChangedAt: now() });
  // A retained owner question remains valid for a global contract change.
  for (const interaction of store.list('interactions').filter(i => i.taskId === task.id && i.status === 'pending')) store.put('interactions', { ...interaction, taskGeneration: saved.generation });
  return saved;
}
