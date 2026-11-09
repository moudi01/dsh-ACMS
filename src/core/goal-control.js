import { assert, id, now, TERMINAL, text } from './util.js';

const ACTIVE = new Set(['preparing', 'running', 'cancelling', 'reconciling']);
export const goalStopped = goal => !!goal?.executionControl || goal?.status === 'cancelled';

export function assertGoalOpen(goal) {
  assert(!goalStopped(goal), goal?.status === 'cancelled' ? 'GOAL_CLOSED' : 'GOAL_PAUSED',
    goal?.status === 'cancelled' ? '目标已取消。请创建新目标安排后续工作。' : '目标已暂停，请先恢复目标。');
}

export function discardDeferredResult(store, attemptId) {
  if (!attemptId || !store.get('deferredResults', attemptId)) return;
  store.remove('deferredResults', attemptId);
  const attempt = store.require('attempts', attemptId);
  store.put('attempts', { ...attempt, resultDeferred: false });
}

export function goalControlView(goal, tasks, attempts) {
  const control = goal.executionControl;
  if (!control) return null;
  const pending = new Set(attempts.filter(a => a.goalId === goal.id && (ACTIVE.has(a.status) || a.cleanupPending)).map(a => a.taskId));
  const active = tasks.filter(t => t.goalId === goal.id && (pending.has(t.id) || t.activeIntegrationId || t.stopRequested));
  const awaitingCleanup = active.filter(t => t.status === 'reconciling').length;
  const phase = awaitingCleanup ? 'reconciling' : active.length ?
    (control.state === 'paused' && control.mode === 'after-current' ? 'draining' : 'stopping') : control.state;
  return { ...control, phase, active: active.length, awaitingCleanup };
}

export function releaseGoalPauses(company, goalId) {
  const { store } = company;
  const held = store.list('tasks').filter(task => (!goalId || task.goalId === goalId) && task.goalPauseId &&
    task.status === 'paused' && !task.stopRequested && !task.activeIntegrationId && !goalStopped(store.get('goals', task.goalId)));
  if (!held.length) return;
  const pending = new Set(store.list('attempts').filter(a => ACTIVE.has(a.status) || a.cleanupPending).map(a => a.taskId));
  const questions = new Set(store.list('interactions').filter(i => i.status === 'pending').map(i => i.taskId));
  for (const task of held) {
    if (pending.has(task.id)) continue;
    const blocked = task.blocker || questions.has(task.id) || task.dependencies.some(dep => store.get('tasks', dep)?.status !== 'succeeded');
    store.put('tasks', { ...task, status: blocked ? 'blocked' : 'ready', goalPauseId: null, resumeOnStart: false });
  }
}

export function controlGoal(company, args, actor, action) {
  const { store } = company;
  assert(actor.kind !== 'agent', 'FORBIDDEN', '执行角色不能控制目标。');
  const goal = store.require('goals', args.id);
  assert(args.expectedRevision === undefined || args.expectedRevision === goal.revision, 'CONFLICT', '目标已变化，请刷新后重试。');
  assert(!goal.legacyBatch && !['deleted', 'archived'].includes(goal.status), 'GOAL_CLOSED', '该目标已关闭。');
  const previous = goal.executionControl;
  assert(args.afterCurrent === undefined || (action === 'pause' && typeof args.afterCurrent === 'boolean'), 'INVALID_INPUT', '只有暂停目标支持 afterCurrent 布尔参数。');
  if (action === 'resume') {
    assert(previous?.state === 'paused' && goal.status !== 'cancelled', 'INVALID_TRANSITION', '只能恢复已暂停的目标。已取消目标的后续工作须创建新目标。');
    const saved = store.put('goals', { ...goal, executionControl: null });
    releaseGoalPauses(company, goal.id);
    store.event('goal.resumed', goal.id, { controlId: previous.id }, actor, { goalId: goal.id });
    return company.refreshGoal(saved.id, actor);
  }
  const cancelled = action === 'cancel';
  if (goal.status === 'cancelled' && cancelled) return goal;
  assert(goal.status !== 'cancelled', 'GOAL_CLOSED', '目标已取消。');
  const mode = !cancelled && args.afterCurrent === true ? 'after-current' : 'immediate';
  if (previous?.state === 'paused' && !cancelled && (previous.mode === mode || previous.mode === 'immediate')) return goal;
  const control = { id: id('goal_control'), state: cancelled ? 'cancelled' : 'paused', mode,
    requestedAt: now(), requestedBy: { kind: actor.kind, id: actor.id }, reason: args.reason === undefined ? null : text(args.reason, 'reason', 2000) };
  const saved = store.put('goals', { ...goal, status: cancelled ? 'cancelled' : goal.status, executionControl: control });
  if (mode === 'immediate') {
    for (const task of store.list('tasks')) {
      if (task.goalId !== goal.id || TERMINAL.has(task.status)) continue;
      if (!cancelled && (task.stopRequested || !(['running', 'reviewing'].includes(task.status) ||
          (task.status === 'integrating' && task.activeIntegrationId)))) continue;
      company.controlTask({ id: task.id, reason: control.reason ?? (cancelled ? '目标已取消' : '目标已暂停') },
        control.state, actor, { cascade: false, goalPauseId: cancelled ? null : control.id });
    }
  }
  store.event(cancelled ? 'goal.cancelled' : 'goal.paused', goal.id, control, actor, { goalId: goal.id });
  return saved;
}
