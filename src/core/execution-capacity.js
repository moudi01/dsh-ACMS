import { isLiveAttempt } from './entity-actions.js';
import { integrationPending } from './task-actions.js';

// Phases are deliberately small and stable: the host snapshot and the panel
// must describe the same occupancy in the same terms.
export const CAPACITY_LABELS = {
  running: '运行中', stopping: '正在停止', cleanupPending: '待清理核对',
  integrating: 'Git 集成', chat: '独立对话', probe: '模型检测',
};
export const CAPACITY_PHASES = Object.keys(CAPACITY_LABELS);

function liveParts(store, live) {
  const attempts = store?.list('attempts').filter(a => !a.legacyBatch && (isLiveAttempt(a) || live?.has(a.id))) ?? [];
  const integrations = store?.list('integrations').filter(integrationPending) ?? [];
  return { attempts, integrations };
}

function attemptPhase(attempt, task) {
  if (attempt.cleanupPending || attempt.cleanupUncertain || attempt.status === 'reconciling') return 'cleanupPending';
  if (attempt.status === 'cancelling' || task?.stopRequested || task?.status === 'stopping') return 'stopping';
  return 'running';
}

function integrationPhase(record, task) {
  if (record.phase === 'reconciling' || record.cleanupPending || record.cleanupUncertain) return 'cleanupPending';
  return task?.stopRequested ? 'stopping' : 'integrating';
}

// Occupancy is the scheduler's single source of truth: task attempts, pending
// Git integrations, owner chats and model probes each consume one slot. The
// same live activity is counted once even if it appears in several views.
export function executionOccupancy(store, adapter, live) {
  const { attempts, integrations } = liveParts(store, live);
  return {
    attempts,
    integrations: integrations.length,
    used: attempts.length + integrations.length + (adapter?.activeChats ?? 0) + (adapter?.activeProbes ?? 0),
  };
}

// Full breakdown used by the company overview and the model-check entry point.
// `used` is computed from the same parts as executionOccupancy so the panel and
// dispatch decisions cannot drift apart.
export function executionCapacity(store, adapter, live, policy) {
  const { attempts, integrations } = liveParts(store, live);
  const tasks = new Map((store?.list('tasks') ?? []).map(task => [task.id, task]));
  const entries = [];
  for (const attempt of attempts) {
    const task = tasks.get(attempt.taskId);
    entries.push({ kind: 'attempt', phase: attemptPhase(attempt, task), id: attempt.id, taskId: attempt.taskId,
      goalId: attempt.goalId ?? task?.goalId ?? null, agentId: attempt.agentId ?? null, status: attempt.status });
  }
  for (const record of integrations) {
    const task = tasks.get(record.taskId);
    entries.push({ kind: 'integration', phase: integrationPhase(record, task), id: record.id, taskId: record.taskId,
      goalId: record.goalId ?? task?.goalId ?? null, agentId: task?.agentId ?? null, status: record.phase });
  }
  const chatCount = Math.max(0, adapter?.activeChats ?? 0);
  const chatDetails = [...(adapter?.activeChatDetails?.values?.() ?? [])].slice(0, chatCount);
  for (const detail of chatDetails) {
    entries.push({ kind: 'chat', phase: detail.phase ?? 'chat', conversationId: detail.conversationId ?? null,
      agentId: detail.agentId ?? null, taskId: detail.taskId ?? null, messageId: detail.messageId ?? null });
  }
  for (let index = chatDetails.length; index < chatCount; index += 1) {
    entries.push({ kind: 'chat', phase: 'chat', conversationId: null, agentId: null, taskId: null, messageId: null });
  }
  const probeCount = Math.max(0, adapter?.activeProbes ?? 0);
  for (let index = 0; index < probeCount; index += 1) entries.push({ kind: 'probe', phase: 'probe' });

  const limit = Number.isInteger(policy?.maxConcurrent) ? policy.maxConcurrent : null;
  const reserve = Number.isInteger(policy?.controlSlots) ? policy.controlSlots : 0;
  const count = kind => entries.filter(entry => entry.kind === kind).length;
  const phase = name => entries.filter(entry => entry.phase === name).length;
  return {
    used: entries.length,
    limit,
    reserve,
    free: limit == null ? null : Math.max(0, limit - entries.length),
    ordinaryLimit: limit == null ? null : Math.max(1, limit - reserve),
    entries,
    counts: { attempt: count('attempt'), integration: count('integration'), chat: count('chat'), probe: count('probe') },
    phases: Object.fromEntries(CAPACITY_PHASES.map(name => [name, phase(name)])),
  };
}

// Human-readable blocking reason shared by the host rejection path and the
// model-check entry point. Empty string means the probe may start.
export function capacityBlockReason(capacity) {
  if (!capacity || !Number.isInteger(capacity.limit) || capacity.used < capacity.limit) return '';
  const parts = [
    capacity.counts?.attempt ? `任务 ${capacity.counts.attempt}` : '',
    capacity.counts?.integration ? `集成 ${capacity.counts.integration}` : '',
    capacity.counts?.chat ? `独立对话 ${capacity.counts.chat}` : '',
    capacity.counts?.probe ? `模型检测 ${capacity.counts.probe}` : '',
  ].filter(Boolean);
  return `执行资源已满（${capacity.used}/${capacity.limit}）${parts.length ? `：${parts.join('、')}` : ''}`;
}
