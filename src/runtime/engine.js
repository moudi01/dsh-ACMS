import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assert, id, now, parseResult, digest, SYSTEM, OWNER, TERMINAL } from '../core/util.js';
import { promptFor } from './prompt.js';
import { selectionBlocked } from '../core/model-selection.js';
import { acceptPlanFlow } from '../core/plan-ledger.js';
import { acceptReviewFlow } from './review-flow.js';
import { completeCoordination, coordinationAuthority, coordinateBlocker, coordinateExecutionLimit, findManager, canCoordinate, scheduleRepairFlow, timeBoxCoordinationKey, CAPACITY_LIMIT_CODES } from '../core/coordination.js';
import { executeIntegration, interruptIntegration, recoverIntegrations, refreshIntegrationReceipts } from './integration.js';
import { contractVersion, matchesGoalContract } from '../core/goal-contract.js';
import { executionOccupancy } from '../core/execution-capacity.js';
import { migrateLegacyForEngine } from '../core/legacy.js';
import { blockerRoute, ignoresBlocker } from '../core/blocker-policy.js';
import { goalRuntimeLimit, goalRuntimeSpent, goalTimeBoxLimit } from '../core/runtime-budget.js';
import { classifyEnvironment, environmentFailure } from './preflight.js';
import { holdEnvironment, inspectEnvironment, refreshEnvironmentGates } from './environment-gate.js';
import { assertGoalOpen, goalStopped, releaseGoalPauses } from '../core/goal-control.js';
import { readCommandCleanup } from './host-command.js';

const ACTIVE = new Set(['preparing', 'running', 'cancelling', 'reconciling']);
const checkReceipt = (engine, commandId) => path.join(engine.workspaces.dataDir, 'check-receipts', commandId + '.json');
export class Engine {
  constructor(company, adapter, workspaces, options = {}) {
    this.company = company; this.store = company.store; this.adapter = adapter; this.workspaces = workspaces;
    this.owner = randomUUID(); this.epoch = 0; this.live = new Map(); this.closing = false; this.ticking = false;
    this.intervalMs = options.intervalMs ?? 1000; this.integration = Promise.resolve(); this.queuedIntegrations = new Set(); this.lastError = null;
  }
  async start() {
    this.closing = false;
    this.nextEnvironmentCheck = 0;
    this.epoch = this.store.acquireLease(this.owner);
    try {
      // Exclusive migration: the lease is held and the scheduler is not running
      // yet. Unconfirmed legacy processes block startup instead of being
      // silently released.
      this.legacyMigration = await migrateLegacyForEngine({ store: this.store, adapter: this.adapter, dataDir: this.workspaces.dataDir });
      this.conversations?.recover(); await this.recover(); await recoverIntegrations(this);
    } catch (e) { this.store.releaseLease(this.owner); throw e; }
    this.listener = event => {
      interruptIntegration(this);
      if (['goal.paused', 'goal.cancelled'].includes(event.type)) {
        for (const entry of this.live.values()) {
          const task = this.store.get('tasks', entry.taskId);
          if (task?.goalId === event.goalId && task.stopRequested && !entry.controller.signal.aborted) {
            entry.controller.abort(new Error(task.stopRequested));
          }
        }
      }
      this.kick();
    };
    this.store.events.on('event', this.listener);
    this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.kick();
  }
  kick() { if (this.closing || this.scheduled) return; this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.tick().catch(e => { this.lastError = String(e.message); }); }); }
  fenced() { assert(this.store.ownsLease(this.owner, this.epoch), 'LEASE_LOST', 'Scheduler no longer owns the company lease'); }
  async recover(taskId) {
    for (const pending of this.store.list('attempts').filter(a => (!taskId || a.taskId === taskId) && !a.legacyBatch && !this.live.has(a.id) && (ACTIVE.has(a.status) || a.cleanupPending))) {
      const legacyTask = this.store.get('tasks', pending.taskId);
      // Stage-model tasks are backed up and isolated; never reconcile, accept or
      // re-dispatch them under the atomic task model.
      if (legacyTask?.legacyBatch || legacyTask?.workflowSnapshot) continue;
      let fact;
      try {
        const check = pending.hostCheck;
        const cleanup = check ? await readCommandCleanup(checkReceipt(this, check.id)) : null;
        if (check && cleanup) await this.clearHostCheck(pending.id, check.id);
        fact = check && !cleanup
          ? { status: 'unknown', reason: `宿主检查 ${check.checkId} 的进程树清理尚未确认`, actions: ['refresh-receipt', 'inspect-execution'] }
          : pending.deferredReplayAt ? { status: 'unknown', reason: '结果入库中断，原执行回执无法证明入库检查已清理' } :
          await this.adapter.reconcile?.(pending) ?? { status: 'unknown', reason: '执行器未提供恢复回执' };
      }
      catch (error) { fact = { status: 'unknown', reason: `恢复查询失败：${error.message}`, actions: ['refresh-receipt', 'inspect-execution'] }; }
      this.fenced();
      // A stop or edit may have discarded the parked result during receipt I/O.
      const previous = this.store.require('attempts', pending.id);
      if ((previous.resultDeferred || previous.provider?.startsWith('paired:')) && ['completed', 'stopped'].includes(fact.status) && fact.cleanupConfirmed !== true) {
        fact = { status: 'unknown', reason: '执行回执未确认进程树清理', actions: ['refresh-receipt', 'inspect-execution'] };
      }
      if (previous.cleanupUncertain && fact.cleanupConfirmed !== true) {
        fact.status = 'unknown'; fact.reason = previous.cleanupError || 'Prior process tree cleanup is still unconfirmed'; delete fact.result;
      }
      const currentTask = this.store.require('tasks', previous.taskId);
      const ownsTask = currentTask.activeAttemptId === previous.id && currentTask.generation === previous.taskGeneration;
      const clean = ['completed', 'stopped'].includes(fact.status) && fact.cleanupConfirmed === true;
      if (previous.resultDeferred && ownsTask && clean &&
          (!currentTask.stopRequested || currentTask.stopRequested === 'paused')) {
        this.store.transaction(() => {
          this.store.put('attempts', { ...previous, status: 'completed', resultAccepted: false,
            cleanupPending: false, cleanupUncertain: false, recovery: { status: 'cleanup-confirmed', reason: fact.reason } });
          if (currentTask.status === 'reconciling' || currentTask.stopRequested === 'paused') {
            // Retain the pause owner. Only releaseGoalPauses can lift a goal-owned hold.
            this.store.put('tasks', { ...currentTask, status: 'paused', stopRequested: null, recoveryRequested: false, resumeOnStart: false });
          }
          this.store.event('attempt.recovery', previous.id, { taskId: previous.taskId, fact }, SYSTEM);
        });
        continue;
      }
      const accepted = previous.resultAccepted ?? (previous.status === 'completed' && !previous.resultDeferred);
      if (currentTask.activeAttemptId === previous.id && currentTask.stopRequested
        && clean) {
        // A stop intent survives host loss. A clean completed receipt also
        // proves termination, but must not apply a result the owner has stopped.
        this.store.transaction(() => {
          this.finishAttempt(previous, accepted ? 'completed' : 'interrupted', previous.summary);
          this.store.put('attempts', { ...this.store.require('attempts', previous.id), cleanupPending: false, cleanupUncertain: false,
            recovery: { status: 'stopped', reason: `已确认进程树清理，状态已更新为 ${currentTask.stopRequested}。${fact.reason ?? ''}`, actions: [] } });
          this.store.put('tasks', { ...currentTask, status: currentTask.stopRequested, stopRequested: null, recoveryRequested: false, resumeOnStart: false });
          this.company.releaseTemporaryAgent(previous.agentId);
          this.store.event('attempt.stop.recovered', previous.id, { taskId: previous.taskId, status: currentTask.stopRequested }, SYSTEM);
        });
        continue;
      }
      if (accepted && ['completed', 'stopped'].includes(fact.status)) {
        this.store.transaction(() => {
          this.store.put('attempts', { ...previous, status: 'completed', cleanupPending: false, cleanupUncertain: false, recovery: { status: 'cleanup-confirmed', reason: fact.reason } });
          const task = this.store.require('tasks', previous.taskId);
          if (task.activeAttemptId === previous.id && task.generation === previous.taskGeneration && task.status === 'reconciling' && previous.acceptedTaskStatus) this.store.put('tasks', { ...task, status: previous.acceptedTaskStatus });
          this.company.releaseTemporaryAgent(previous.agentId);
        });
        continue;
      }
      let hostCleanupFailure;
      if (fact.status === 'completed') {
        const controller = new AbortController();
        try {
          this.store.transaction(() => { this.store.put('attempts', { ...previous, recoveredFinishedAt: fact.finishedAt }); });
          const promise = this.accept(previous, fact.result, controller.signal);
          this.live.set(previous.id, { taskId: previous.taskId, controller, promise });
          await promise;
          this.store.transaction(() => { this.fenced(); this.store.put('attempts', { ...this.store.require('attempts', previous.id), cleanupPending: false, cleanupUncertain: false, recovery: { status: 'completed', reason: fact.reason } }); this.company.releaseTemporaryAgent(previous.agentId); this.store.event('attempt.result.recovered', previous.id, { taskId: previous.taskId }, SYSTEM); });
          continue;
        } catch (e) {
          if (e.cleanupUncertain) hostCleanupFailure = e;
          const stopped = controller.signal.aborted && clean && !hostCleanupFailure && !this.store.require('attempts', previous.id).hostCheck;
          fact = stopped ? { status: 'stopped', cleanupConfirmed: true, reason: e.message } :
            { status: 'unknown', reason: `Recovered result needs inspection: ${e.message}` };
        } finally { this.live.delete(previous.id); }
      }
      this.store.transaction(() => {
        this.fenced();
        const latest = this.store.require('attempts', previous.id);
        const task = this.store.require('tasks', previous.taskId);
        this.store.put('attempts', { ...latest, resultAccepted: accepted, acceptedTaskStatus: previous.acceptedTaskStatus ?? (accepted && task.status !== 'reconciling' ? task.status : null), status: fact.status === 'stopped' ? 'interrupted' : 'reconciling', cleanupPending: fact.status !== 'stopped', cleanupUncertain: fact.status === 'stopped' ? false : latest.cleanupUncertain, recovery: fact,
          ...(hostCleanupFailure ? { cleanupUncertain: true, cleanupError: hostCleanupFailure.message, cleanupDetails: hostCleanupFailure.cleanup ?? null } : {}) });
        if (task.activeAttemptId === previous.id && task.generation === previous.taskGeneration) this.store.put('tasks', { ...task, status: fact.status === 'stopped' ? (task.stopRequested ?? 'ready') : 'reconciling', stopRequested: fact.status === 'stopped' ? null : task.stopRequested });
        this.store.event('attempt.recovery', previous.id, { taskId: task.id, fact }, SYSTEM);
      });
    }
    this.store.transaction(() => {
      for (const task of this.store.list('tasks')) if (task.resumeOnStart && task.status === 'paused' &&
          this.store.get('goals', task.goalId)?.status !== 'cancelled' &&
          !this.store.list('attempts').some(a => a.taskId === task.id && (ACTIVE.has(a.status) || a.cleanupPending))) {
        this.store.put('tasks', { ...task, status: 'ready', resumeOnStart: false });
        this.store.event('task.host.resumed', task.id, {}, SYSTEM);
      }
    });
  }
  async tick() {
    if (this.ticking || this.closing) return; this.ticking = true;
    try {
      interruptIntegration(this);
      this.fenced(); this.store.heartbeat(this.owner);
      // A request made during final cleanup must survive until the live
      // activation settles; recover() deliberately excludes live attempts.
      for (const task of this.store.list('tasks').filter(t => t.recoveryRequested && this.activeIntegration?.taskId !== t.id && ![...this.live.values()].some(entry => entry.taskId === t.id))) {
        this.store.transaction(() => this.store.put('tasks', { ...task, recoveryRequested: false }));
        await this.recover(task.id);
        await recoverIntegrations(this, task.id);
      }
      await refreshIntegrationReceipts(this);
      const spent = new Map(this.store.list('goals').map(g => [g.id, goalRuntimeSpent(g, this.store.list('attempts'))]));
      for (const [attemptId, entry] of this.live) {
        const task = this.store.require('tasks', entry.taskId);
        if ((spent.get(task.goalId) ?? 0) >= goalRuntimeLimit(this.store.require('goals', task.goalId), this.company.policy()) && !entry.controller.signal.aborted) entry.controller.abort(Object.assign(new Error('Goal runtime budget exhausted'), { code: 'GOAL_RUNTIME_BUDGET' }));
        if (task.stopRequested && !entry.controller.signal.aborted) entry.controller.abort(new Error(task.stopRequested));
        if (this.adapter.progress) {
          const attempt = this.store.require('attempts', attemptId); const progress = await this.adapter.progress(attempt);
          if (progress && digest(progress) !== digest(attempt.progress ?? null)) this.store.transaction(() => {
            this.store.put('attempts', { ...this.store.require('attempts', attemptId), progress }); this.store.event('attempt.progress', attemptId, { taskId: task.id }, SYSTEM);
          });
        }
      }
      if (this.company.policy().paused) return;
      this.store.transaction(() => {
        releaseGoalPauses(this.company);
        for (const goal of this.store.list('goals').filter(g => g.contractChange?.status === 'pending' && !g.contractChange.coordinationTaskId)) {
          this.company.ensureGoalContractCoordination(goal);
        }
      });
      this.refreshReadiness();
      if (this.store.list('tasks').some(task => task.environmentBlock)) {
        await refreshEnvironmentGates(this);
        if (this.company.policy().paused || this.closing) return;
      }
      const p = this.company.policy();
      // Efficiency time box (issue #7): notify the manager once per box without
      // creating a budget interaction. Hard-cap handling stays below.
      for (const goal of this.store.list('goals')) {
        if (goalStopped(goal) || ['succeeded', 'archived', 'deleted'].includes(goal.status)) continue;
        const hardLimit = goalRuntimeLimit(goal, p);
        const used = spent.get(goal.id) ?? goal.runtimeMs ?? 0;
        if (used >= hardLimit) continue;
        const boxLimit = goalTimeBoxLimit(goal, p);
        if (!boxLimit || used < boxLimit) continue;
        this.ensureTimeBoxWarning(goal, used, hardLimit, boxLimit, p);
      }
      const { attempts: active, integrations: occupiedIntegrations, used } = executionOccupancy(this.store, this.adapter, this.live);
      let free = p.maxConcurrent - used; if (free <= 0) return;
      let integrationQueued = occupiedIntegrations > 0 || this.queuedIntegrations.size > 0;
      if (!integrationQueued) {
        const waiting = this.store.list('tasks').find(t => {
          if (t.status !== 'integrating' || ignoresBlocker(t) || active.some(a => a.taskId === t.id)) return false;
          const goal = this.store.require('goals', t.goalId);
          return !goalStopped(goal) && matchesGoalContract(goal, t) && goal.contractChange?.status !== 'pending';
        });
        if (waiting) { this.queueIntegration(waiting.id); integrationQueued = true; free--; }
      }
      let ordinary = active.filter(a => ['work', 'repair'].includes(a.kind)).length;
      const busyAgents = new Set(active.map(a => a.agentId));
      const ready = this.store.list('tasks').filter(t => t.status === 'ready' && !t.environmentBlock && !t.stopRequested && !t.legacyBatch && !t.workflowSnapshot && (!t.retryAt || t.retryAt <= Date.now())).sort((a, b) => (['plan', 'review', 'coordination'].includes(b.kind) - ['plan', 'review', 'coordination'].includes(a.kind)) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      for (const task of ready) {
        if (free <= 0) break;
        if (active.some(a => a.taskId === task.id)) continue;
        const parent = task.parentId ? this.store.get('tasks', task.parentId) : null;
        const coordination = task.kind === 'coordination' ? task : parent?.kind === 'coordination' ? parent : null;
        const source = coordination?.coordinationOf ? this.store.get('tasks', coordination.coordinationOf) : null;
        if (source && (source.stopRequested || ['paused', 'cancelled', 'deleted', 'archived', 'reconciling'].includes(source.status) ||
          active.some(a => a.taskId === source.id))) continue;
        const goal = this.store.require('goals', task.goalId);
        if (goalStopped(goal) || !matchesGoalContract(goal, task) || task.contractObsolete ||
          (goal.contractChange?.status === 'pending' && task.kind !== 'coordination')) continue;
        if (task.reviewScope === 'goal' && task.deliveryHash !== this.company.deliveryHash(goal.id)) {
          this.store.transaction(() => {
            this.company.controlTask({ id: task.id, reason: '目标交付版本已变化' }, 'cancelled', SYSTEM);
            this.updateGoal(goal.id);
          });
          continue;
        }
        if ((spent.get(goal.id) ?? goal.runtimeMs) >= goalRuntimeLimit(goal, p)) { this.block(task, 'budget', '目标累计执行时间额度已用完', '请在回复中填写给此目标追加的分钟数；单次执行时限与目标累计额度分别计算。'); continue; }
        // While the time-box decision is open, only control work (coordination,
        // review) may proceed; ordinary work waits for the manager's wrap-up.
        const boxLimit = goalTimeBoxLimit(goal, p);
        if (boxLimit && !goal.timeBox?.releasedAt && ['work', 'repair', 'plan'].includes(task.kind) && (spent.get(goal.id) ?? goal.runtimeMs ?? 0) >= boxLimit) continue;
        if (task.integrationPending) {
          this.store.transaction(() => {
            this.store.put('tasks', { ...task, status: 'integrating' });
            this.store.event('task.integration.resumed', task.id, { artifactHash: task.artifactHash }, SYSTEM);
          });
          if (!integrationQueued) { this.queueIntegration(task.id); integrationQueued = true; free--; }
          continue;
        }
        if (['work', 'repair'].includes(task.kind) && ordinary >= Math.max(1, p.maxConcurrent - p.controlSlots)) continue;
        let claimed = task;
        // An owner rework gate may exist without a manager. The owner answers
        // the blocker first; the next tick assigns whichever manager is now
        // available, or asks again without touching the delivered task.
        if (!claimed.agentId) {
          const manager = claimed.kind === 'coordination' ? findManager(this.company, claimed.goalId) : null;
          // Binding a coordinator is a dispatch decision: it must hold the
          // permissions the coordination result will be accepted against.
          if (!manager || !canCoordinate(this.company, manager)) { this.block(claimed, 'assignment', '没有具备协调授权的负责人（需要 task.create 与 task.retry）', '请恢复或创建负责人并确认其拥有 task.create 与 task.retry 授权，然后恢复此待办。'); continue; }
          claimed = this.store.put('tasks', { ...claimed, agentId: manager.id });
        }
        if (busyAgents.has(claimed.agentId)) continue;
        const agent = this.store.require('agents', claimed.agentId);
        if (claimed.kind === 'coordination' && (!canCoordinate(this.company, agent) || agent.role !== 'manager' || (agent.goalId && agent.goalId !== claimed.goalId))) {
          this.block(claimed, 'assignment', '当前负责人无法协调此目标', '请重新分配具备协调授权的目标负责人。');
          continue;
        }
        if (agent.status !== 'available') { this.block(claimed, 'assignment', '执行人员已释放或删除，需要重新分配', '请编辑任务，为其选择可分配的执行人员。'); continue; }
        const attempt = this.claim(claimed, agent);
        if (!attempt) continue;
        free--; busyAgents.add(agent.id); if (['work', 'repair'].includes(claimed.kind)) ordinary++;
        const controller = new AbortController(); const entry = { taskId: task.id, controller, promise: null };
        this.live.set(attempt.id, entry);
        entry.promise = this.execute(attempt, controller).catch(e => { this.lastError = String(e.message); }).finally(() => { this.live.delete(attempt.id); this.kick(); });
      }
    } finally { this.ticking = false; }
  }
  timeBoxCheckpoint(goal) {
    const tasks = this.store.list('tasks').filter(task => task.goalId === goal.id && task.status !== 'deleted');
    const taskIds = new Set(tasks.map(task => task.id));
    return {
      at: now(), goalRuntimeMs: goal.runtimeMs ?? 0,
      tasks: tasks.map(task => ({ id: task.id, title: task.title, kind: task.kind, status: task.status })),
      artifacts: this.store.list('artifacts').filter(artifact => taskIds.has(artifact.taskId)).length,
      attempts: this.store.list('attempts').filter(attempt => attempt.goalId === goal.id).length,
    };
  }
  ensureTimeBoxWarning(goal, used, hardLimit, boxLimit, policy) {
    return this.store.transaction(() => {
    const key = timeBoxCoordinationKey(goal.id, boxLimit);
    const existing = this.store.list('tasks').find(task => task.kind === 'coordination' && task.coordinationKey === key && task.status !== 'deleted');
    if (existing) {
      if (goal.timeBox?.key === key && (goal.timeBox.coordinationTaskId === existing.id || goal.timeBox.releasedAt)) return existing;
      this.store.put('goals', { ...this.store.require('goals', goal.id), timeBox: { ...(goal.timeBox ?? {}), key, boxMs: boxLimit, warnedAt: existing.createdAt ?? now(), coordinationTaskId: existing.id, releasedAt: null } });
      return existing;
    }
    if (goal.timeBox?.key === key && goal.timeBox.capacityBlocked) {
      const usedSlots = this.store.list('tasks').filter(task => task.goalId === goal.id && task.status !== 'deleted').length;
      if (usedSlots >= this.company.policy().maxTasksPerGoal) {
        // The warning may have fired while every task was running, leaving no
        // task to attach the owner question to. Retry the entry as soon as a
        // task becomes attachable (e.g. after a failed attempt goes back to ready).
        this.ensureCapacityOwnerEntry(this.store.require('goals', goal.id), {
          key, used, hardLimit, boxLimit, checkpoint: this.timeBoxCheckpoint(goal),
          message: goal.timeBox.capacityMessage ?? '时间盒收尾任务创建失败',
        });
        return null;
      }
    }
    const manager = findManager(this.company, goal.id);
    const usable = manager && canCoordinate(this.company, manager);
    const checkpoint = this.timeBoxCheckpoint(goal);
    const question = '时间盒到点，但没有具备协调授权的负责人来安排收尾；请恢复负责人（需 task.create 与 task.retry）后回复。';
    let task;
    try {
      task = this.company.createTask({
        goalId: goal.id, kind: 'coordination', title: `时间盒收尾：${goal.title}`,
        description: [
          '目标执行已到达效率时间盒（不等于成本硬上限）。请保存检查点并决定收尾：缩小范围、调整分派、停止新增非必要工作或安排剩余工作。',
          `已用执行时间：${used} ms；效率时间盒：${boxLimit} ms；成本硬上限：${hardLimit} ms；收尾预留：${policy.timeBoxReserveMs ?? 0} ms。`,
          '不要自动追加预算，也不要绕过硬上限、暂停、清理占位或权限边界。',
          `检查点：${checkpoint.tasks.length} 个任务，${checkpoint.artifacts} 份产物，${checkpoint.attempts} 次执行。`,
        ].join('\n'),
        acceptance: '负责人给出收尾决定并保留检查点；不自动新增预算交互。',
        agentId: usable ? manager.id : null, priority: 90,
        origin: { kind: 'timebox', decidedBy: null, createdBy: 'scheduler', basis: '时间盒到点' },
        coordinationKey: key, coordinationOf: null,
      }, SYSTEM);
    } catch (error) {
      if (!CAPACITY_LIMIT_CODES.has(error.code)) throw error;
      // A full goal must not abort the whole tick: keep a recoverable owner entry
      // and let other goals keep scheduling.
      this.store.put('goals', { ...this.store.require('goals', goal.id), timeBox: { key, boxMs: boxLimit, warnedAt: now(), coordinationTaskId: null, releasedAt: null, capacityBlocked: true, capacityMessage: error.message, checkpoint } });
      this.ensureCapacityOwnerEntry(this.store.require('goals', goal.id), { key, used, hardLimit, boxLimit, checkpoint, message: error.message });
      return null;
    }
    if (!usable) {
      this.store.put('tasks', { ...task, status: 'blocked', blocker: { kind: 'assignment', reason: '时间盒到点但没有可用负责人', question } });
      this.store.put('interactions', { id: id('interaction'), taskId: task.id, goalId: goal.id, taskGeneration: task.generation, kind: 'assignment', reason: '时间盒到点但没有可用负责人', question, status: 'pending' });
    }
    this.store.put('goals', { ...this.store.require('goals', goal.id), timeBox: { key, boxMs: boxLimit, warnedAt: now(), coordinationTaskId: task.id, releasedAt: null, checkpoint } });
    this.store.event('goal.timebox.warning', goal.id, { coordinationTaskId: task.id, key, usedMs: used, hardLimitMs: hardLimit, boxLimitMs: boxLimit, reserveMs: policy.timeBoxReserveMs ?? 0, checkpoint }, SYSTEM, { goalId: goal.id });
    return task;
    });
  }
  ensureCapacityOwnerEntry(goal, context) {
    const interactions = this.store.list('interactions');
    if (interactions.some(item => item.goalId === goal.id && item.kind === 'capacity' && item.status === 'pending')) return true;
    const attachable = this.store.list('tasks').filter(task => task.goalId === goal.id && !['succeeded', 'cancelled', 'archived', 'deleted', 'running', 'preparing', 'integrating', 'reconciling', 'stopping'].includes(task.status));
    const target = attachable.find(task => task.status === 'ready') ?? attachable[0];
    if (!target) return false;
    const timeBox = goal.timeBox ?? {};
    const changed = timeBox.capacityBlocked !== true || timeBox.capacityBlockedTaskId !== target.id || timeBox.capacityMessage !== context.message;
    // Preserve any existing owner question: replace or duplicate it only when it
    // is a capacity question, and never re-emit events for an unchanged entry.
    const existingPending = interactions.find(item => item.taskId === target.id && item.status === 'pending');
    if (!existingPending) this.block(target, 'capacity', '时间盒到点，但目标已达任务上限：' + context.message, '请提高“每个目标任务上限”或缩小范围后恢复此分支。');
    if (!changed) return true;
    const current = this.store.require('goals', goal.id);
    this.store.put('goals', { ...current, timeBox: { ...(current.timeBox ?? {}), capacityBlocked: true, capacityMessage: context.message, capacityBlockedTaskId: target.id } });
    this.store.event('goal.timebox.blocked', goal.id, { key: context.key, usedMs: context.used, hardLimitMs: context.hardLimit, boxLimitMs: context.boxLimit, reason: 'capacity', message: context.message, checkpoint: context.checkpoint, taskId: target.id, ...(existingPending ? { existingInteractionId: existingPending.id } : {}) }, SYSTEM, { goalId: goal.id });
    return true;
  }
  refreshReadiness() {
    this.store.transaction(() => {
      const pending = new Set(this.store.list('interactions').filter(i => i.status === 'pending').map(i => i.taskId));
      for (const listed of this.store.list('tasks')) {
        const task = this.store.require('tasks', listed.id);
        if (!['ready', 'blocked'].includes(task.status) || task.environmentBlock || ignoresBlocker(task) || pending.has(task.id) ||
            goalStopped(this.store.require('goals', task.goalId))) continue;
        if (task.blocker && !task.blocker.resolutionTaskIds) continue;
        const dependencies = task.dependencies.map(id => ({ id, status: this.store.get('tasks', id)?.status ?? 'missing' }));
        const failed = dependencies.filter(dep => ['failed', 'missing'].includes(dep.status));
        if (failed.length) {
          const resolution = (task.blocker?.resolutionTaskIds ?? []).map(id => this.store.get('tasks', id));
          const coordination = resolution.find(t => t?.kind === 'coordination');
          if (coordination && !failed.some(dep => dep.id === coordination.id) && coordination.origin?.blockerKind !== 'dependency') continue;
          // A planned repair can leave the original dependency failed while it runs.
          // Reassess that dependency once the repair finishes or cannot continue.
          if (task.blocker?.kind === 'coordination' &&
            resolution.every(t => t?.kind === 'work' && (t.status === 'succeeded' || !TERMINAL.has(t.status))) &&
            resolution.some(t => !TERMINAL.has(t.status))) continue;
          // A failed coordination itself needs owner attention rather than another handoff.
          const reason = '依赖无法继续：' + failed.map(dep => dep.id + ' (' + dep.status + ')').join(', ');
          if (coordination && failed.some(dep => dep.id === coordination.id)) this.blockForOwner(task, 'dependency', reason, '请核对协调任务或调整依赖。');
          else this.block(task, 'dependency', reason, '请核对失败依赖或调整任务范围。', failed);
          continue;
        }
        const ready = dependencies.every(dep => dep.status === 'succeeded');
        const next = ready ? 'ready' : 'blocked';
        if (next !== task.status) {
          this.store.put('tasks', { ...task, status: next, ...(ready ? { blocker: null } : {}) });
          this.store.event('task.readiness', task.id, { status: next }, SYSTEM);
        }
      }
    });
  }
  claim(task, agent) {
    return this.store.transaction(() => {
      this.fenced(); const current = this.store.require('tasks', task.id); assert(current.status === 'ready', 'CLAIM_CONFLICT', 'Task is no longer ready');
      const goal = this.store.require('goals', current.goalId);
      assertGoalOpen(goal);
      assert(matchesGoalContract(goal, current) && !current.contractObsolete, 'STALE_RESULT', 'Task belongs to an obsolete goal contract');
      const deferred = current.activeAttemptId && this.store.get('deferredResults', current.activeAttemptId);
      if (deferred && deferred.generation === current.generation) {
        const previous = this.store.get('attempts', deferred.id);
        if (deferred.taskId !== current.id || !previous?.resultDeferred || previous.cleanupPending || previous.cleanupUncertain || previous.taskId !== current.id ||
            previous.taskGeneration !== current.generation) return null;
        // Older schedulers stored a verified stopped receipt as an interruption.
        const recoveredStop = previous.status === 'interrupted' && previous.recovery?.status === 'stopped' && previous.recovery.cleanupConfirmed === true;
        if (previous.status !== 'completed' && !recoveredStop) return null;
        this.store.put('tasks', { ...current, status: 'running' });
        return this.store.put('attempts', { ...previous, status: 'running', deferredReplayAt: now() });
      }
      const attemptId = id('attempt'); const contextKey = `acms:${task.goalId}:${task.id}:role-${agent.role}:${agent.id}:g${task.generation}`;
      const notificationIds = this.store.list('notifications').filter(n => n.agentId === agent.id && n.status === 'pending').slice(0, 100).map(n => n.id);
      const conversationMessageIds = this.conversations?.messagesFor(task, agent.id).map(m => m.id) ?? [];
      const attempt = this.store.put('attempts', { id: attemptId, taskId: task.id, goalId: task.goalId, agentId: agent.id, kind: task.kind, provider: agent.provider, model: agent.model, role: agent.role, status: 'preparing', contextKey, startedAt: now(), epoch: this.epoch, taskGeneration: task.generation, goalContractVersion: contractVersion(goal), blockerFeedbackHash: task.blockerEvidence ? task.feedbackHash : null, grants: agent.grants, notificationIds, conversationMessageIds });
      this.store.put('tasks', { ...current, status: 'running', attempts: current.attempts + 1, activeAttemptId: attemptId });
      this.store.event('attempt.claimed', attemptId, { taskId: task.id, kind: task.kind, contextKey }, SYSTEM); return attempt;
    });
  }
  async execute(attempt, controller) {
    let activation, cleanupFailure, recoveryFailure, preparingWorkspace = false, deliveredResult = false, preflight;
    const timeout = setTimeout(() => controller.abort(new Error('Execution timeout')), this.company.policy().turnTimeoutMs);
    try {
      let task = this.currentAttemptTask(attempt);
      if (attempt.deferredReplayAt) {
        await this.accept(attempt, this.store.require('deferredResults', attempt.id).output, controller.signal);
        return;
      }
      const agent = this.store.require('agents', attempt.agentId);
      preflight = await inspectEnvironment(this, task, agent);
      controller.signal.throwIfAborted();
      task = this.currentAttemptTask(attempt);
      this.adapter.assertTaskRouteCurrent?.(agent, preflight.selection);
      if (preflight.failures.length) {
        this.acceptEnvironment(attempt, task, preflight, false);
        return;
      }
      preparingWorkspace = true;
      const workspace = await this.workspaces.prepare(task, attempt);
      preparingWorkspace = false;
      this.store.transaction(() => {
        this.fenced(); task = this.store.require('tasks', task.id);
        assert(task.activeAttemptId === attempt.id, 'STALE_RESULT', 'Workspace belongs to an obsolete attempt');
        // Keep the prepared directory even when an edit/stop arrived during I/O.
        // The next turn reuses it and refreshes its collaboration contract.
        task = this.store.put('tasks', { ...task, workspace });
        attempt = this.store.put('attempts', { ...this.store.require('attempts', attempt.id), workspace });
      });
      controller.signal.throwIfAborted();
      task = this.currentAttemptTask(attempt);
      let modelContext;
      if (agent.role === 'manager') { try { modelContext = await this.adapter.modelContext?.(task.requirements); } catch (e) { this.lastError = '无法读取模型候选：' + e.message; } }
      controller.signal.throwIfAborted();
      task = this.currentAttemptTask(attempt);
      preflight = await inspectEnvironment(this, task, agent);
      controller.signal.throwIfAborted();
      task = this.currentAttemptTask(attempt);
      this.adapter.assertTaskRouteCurrent?.(agent, preflight.selection);
      if (preflight.failures.length) {
        this.acceptEnvironment(attempt, task, preflight, false);
        return;
      }
      assertGoalOpen(this.store.require('goals', task.goalId));
      this.store.transaction(() => {
        attempt = this.store.put('attempts', { ...attempt, status: 'running', environment: preflight.report });
        this.store.event('attempt.starting', attempt.id, { taskId: task.id }, SYSTEM);
      });
      controller.signal.throwIfAborted();
      const assertCurrent = () => {
        const current = this.currentAttemptTask(attempt);
        assertGoalOpen(this.store.require('goals', current.goalId));
        return current;
      };
      task = assertCurrent();
      activation = await this.adapter.start({ task, attempt, agent, routeSelection: preflight.selection,
        prompt: promptFor(this.company, task, attempt, { modelContext }), signal: controller.signal,
        assertCurrent, onAccepted: () => this.conversations?.accepted(attempt) });
      this.store.transaction(() => {
        this.fenced();
        for (const notificationId of attempt.notificationIds ?? []) {
          const notification = this.store.require('notifications', notificationId);
          this.store.put('notifications', { ...notification, status: 'delivered', deliveredAt: now(), attemptId: attempt.id });
        }
        if (attempt.notificationIds?.length) this.store.event('notifications.delivered', attempt.id, { notificationIds: attempt.notificationIds, agentId: attempt.agentId }, SYSTEM);
      });
      this.store.transaction(() => { this.fenced(); this.store.put('attempts', { ...this.store.require('attempts', attempt.id), childId: activation.childId, parentId: activation.parentId, provider: activation.provider ?? attempt.provider, model: activation.model ?? attempt.model, reasoningEffort: activation.reasoningEffort ?? null }); });
      if (activation.accepted !== false) this.conversations?.accepted(attempt);
      const raw = await activation.result; deliveredResult = true; controller.signal.throwIfAborted();
      const output = parseResult(raw); this.conversations?.finished(attempt, output); await this.accept(attempt, output, controller.signal);
    } catch (error) {
      if (error.cleanupUncertain) cleanupFailure = error;
      const discardResult = deliveredResult && controller.signal.aborted &&
        (this.closing || this.store.get('tasks', attempt.taskId)?.stopRequested);
      if (deliveredResult && !discardResult && activation?.provider?.startsWith('paired:')) recoveryFailure = Object.assign(new Error(`结果已返回，但尚未可靠入库：${error.message}`, { cause: error }), { code: 'RESULT_RECONCILIATION_REQUIRED', recoveryRequired: true });
      // Adapter bookkeeping can fail after the receipt is committed but before
      // activation.result resolves. Only a clean stopped receipt permits retry;
      // otherwise retain the slot, including when progress cannot be inspected.
      const saved = this.store.get('attempts', attempt.id);
      if (!discardResult && !attempt.deferredReplayAt && !cleanupFailure && !recoveryFailure && saved?.execution && saved.provider?.startsWith('paired:')) {
        let fact;
        try { fact = await this.adapter.reconcile?.(saved); } catch {}
        if (fact?.status !== 'stopped' || fact.cleanupConfirmed !== true) {
          recoveryFailure = Object.assign(new Error(`执行结果尚需核对：${error.message}; ${fact?.reason ?? '无法读取可靠结束回执'}`, { cause: error }), { code: 'RESULT_RECONCILIATION_REQUIRED', recoveryRequired: true });
        }
      }
      const failure = cleanupFailure ?? recoveryFailure ?? (controller.signal.aborted ? controller.signal.reason : error);
      let observed = preflight;
      const classified = !controller.signal.aborted && !cleanupFailure && !recoveryFailure && classifyEnvironment(failure, preparingWorkspace ? 'workspace' : null);
      if (observed && (['package', 'esbuild'].includes(classified?.code) || preparingWorkspace)) {
        try {
          const current = this.currentAttemptTask(attempt);
          observed = await inspectEnvironment(this, current, this.store.require('agents', attempt.agentId),
            classified ? { failures: [classified] } : null, preflight.route);
        } catch { /* Preserve the original error and the last observed facts. */ }
      }
      if (this.store.ownsLease(this.owner, this.epoch)) this.fail(attempt, controller.signal.aborted && !cleanupFailure && !recoveryFailure ? controller.signal.reason : failure,
        controller.signal.aborted, observed, preparingWorkspace);
    } finally {
      clearTimeout(timeout);
      // The slot is not released until the provider confirms process cleanup.
      try {
        await activation?.dispose?.();
        if (cleanupFailure) throw cleanupFailure;
        if (this.store.ownsLease(this.owner, this.epoch)) this.store.transaction(() => {
          const saved = this.store.require('attempts', attempt.id);
          if (recoveryFailure) {
            this.store.put('attempts', { ...saved, status: 'reconciling', cleanupPending: true, recovery: { status: 'unknown', reason: recoveryFailure.message, actions: ['refresh-receipt', 'inspect-execution'] } });
            return;
          }
          this.store.put('attempts', { ...saved, cleanupPending: false });
          const task = this.store.require('tasks', saved.taskId);
          // Stop may arrive after acceptance while dispose is still pending.
          // Once cleanup succeeds there is no active attempt left for recover().
          if (task.activeAttemptId === saved.id && task.stopRequested) {
            this.store.put('tasks', { ...task, status: task.stopRequested, stopRequested: null, recoveryRequested: false, resumeOnStart: false });
            this.store.event('task.stop.completed', task.id, { status: task.stopRequested, attemptId: saved.id }, SYSTEM);
          }
          this.company.releaseTemporaryAgent(saved.agentId);
        });
      } catch (e) {
        this.lastError = `Cleanup: ${e.message}`;
        if (this.store.ownsLease(this.owner, this.epoch)) this.store.transaction(() => {
          const saved = this.store.require('attempts', attempt.id), task = this.store.require('tasks', attempt.taskId);
          this.store.put('attempts', { ...saved, acceptedTaskStatus: saved.acceptedTaskStatus ?? (saved.resultAccepted ? task.status : null), status: 'reconciling', cleanupPending: true, cleanupUncertain: true, cleanupError: e.message, cleanupDetails: e.cleanup ?? saved.cleanupDetails ?? null });
          this.store.put('tasks', { ...task, status: 'reconciling' });
          this.store.event('attempt.cleanup.failed', attempt.id, { taskId: task.id }, SYSTEM);
        });
      }
      try { await this.workspaces.publishProject?.(this.store.require('projects', this.store.require('tasks', attempt.taskId).projectId)); }
      catch (e) { this.lastError = `协作文档更新失败：${e.message}`; }
    }
  }
  currentAttemptTask(attempt, applyingResult = false) {
    this.fenced();
    const task = this.store.require('tasks', attempt.taskId);
    const goal = this.store.require('goals', task.goalId);
    assert(task.activeAttemptId === attempt.id && task.generation === attempt.taskGeneration && !task.stopRequested &&
      !task.contractObsolete && ['running', 'reconciling'].includes(task.status) && matchesGoalContract(goal, task, attempt),
    'STALE_RESULT', 'Result belongs to an obsolete attempt or contract');
    if (applyingResult || goal.status === 'cancelled') assertGoalOpen(goal);
    return task;
  }
  async accept(attempt, output, signal) {
    try { return await this.acceptOutput(attempt, output, signal); }
    catch (error) {
      if (error.code !== 'GOAL_PAUSED') throw error;
      signal.throwIfAborted();
      const parked = this.store.transaction(() => {
        const task = this.currentAttemptTask(attempt);
        const control = this.store.require('goals', task.goalId).executionControl;
        if (control?.state !== 'paused') return false;
        const saved = this.finishAttempt(attempt, 'completed', output.summary, true);
        this.store.put('deferredResults', { id: attempt.id, taskId: task.id, generation: task.generation, output });
        this.store.put('attempts', { ...saved, resultAccepted: false, resultDeferred: true, acceptedTaskStatus: 'paused' });
        this.store.put('tasks', { ...task, status: 'paused', goalPauseId: control.id });
        this.store.event('attempt.result.deferred', attempt.id, { taskId: task.id, controlId: control.id }, SYSTEM);
        return true;
      });
      if (!parked) return this.accept(attempt, output, signal);
    }
  }
  async clearHostCheck(attemptId, commandId) {
    this.store.transaction(() => {
      this.fenced();
      const current = this.store.require('attempts', attemptId);
      if (current.hostCheck?.id === commandId) this.store.put('attempts', { ...current, hostCheck: null });
    });
    await unlink(checkReceipt(this, commandId)).catch(() => {});
  }
  async runHostCheck(attempt, command, args, cwd, { checkId, signal, ...options }) {
    const commandId = id('command');
    const cleanupReceipt = checkReceipt(this, commandId);
    await mkdir(path.dirname(cleanupReceipt), { recursive: true });
    const stop = () => {
      const task = this.store.require('tasks', attempt.taskId);
      if (task.stopRequested) this.live.get(attempt.id)?.controller.abort(new Error(task.stopRequested));
    };
    const beforeStart = () => {
      signal.throwIfAborted();
      this.currentAttemptTask(attempt, true);
    };
    this.store.transaction(() => {
      beforeStart();
      const saved = this.store.require('attempts', attempt.id);
      assert(!saved.hostCheck, 'CLEANUP_PENDING', 'Previous host check cleanup must be confirmed');
      this.store.put('attempts', { ...saved, hostCheck: { id: commandId, checkId, startedAt: now() } });
    });
    this.store.events.on('event', stop);
    let cleanupUnknown = false;
    try {
      stop();
      return await this.workspaces.runDeliveryCheck(command, args, cwd, { ...options, signal, cleanupReceipt, beforeStart });
    } catch (error) {
      cleanupUnknown = !!error.cleanupUncertain;
      throw error;
    } finally {
      this.store.events.off('event', stop);
      if (!cleanupUnknown && this.store.ownsLease(this.owner, this.epoch)) await this.clearHostCheck(attempt.id, commandId);
    }
  }
  async acceptOutput(attempt, output, signal) {
    let task = this.currentAttemptTask(attempt, true);
    if (this.refreshCoordinationAttempt(task, attempt)) return;
    const technical = output.outcome === 'blocked' && ['technical', 'environment'].includes(output.kind);
    const review = task.kind === 'review' && output.outcome === 'reviewed';
    const reviewEnvironment = review && output.rework?.category === 'environment';
    const diagnostic = technical ? output.reason : review && (!output.rework || reviewEnvironment) ?
      [output.summary, ...(Array.isArray(output.findings) ? output.findings : []), output.rework?.evidence].join('\n') : null;
    const failure = classifyEnvironment({ message: diagnostic }) ??
      (reviewEnvironment || (technical && output.kind === 'environment') ? environmentFailure('review', review ? '独立审查' : '任务执行') : null);
    if (failure) {
      await this.acceptRuntimeEnvironment(attempt, task, [failure], signal);
      return;
    }
    if (task.kind === 'coordination' && output.outcome !== 'blocked') {
      const source = task.coordinationOf ? this.store.get('tasks', task.coordinationOf) : null;
      assert(!source || (!source.stopRequested && !['cancelled', 'deleted', 'archived', 'reconciling'].includes(source.status)),
        'STALE_RESULT', 'Coordination source was stopped or is awaiting reconciliation');
      coordinationAuthority(this.company, attempt, task);
    }
    assert(['blocked', 'planned', 'decomposed', 'reviewed', 'completed', 'managed', 'coordinated'].includes(output.outcome), 'INVALID_RESULT', 'Execution returned an unknown outcome');
    if (output.outcome === 'managed') {
      assert(attempt.role === 'manager' && task.kind !== 'review', 'FORBIDDEN', 'Only an assigned manager can continue management');
      const turns = task.managementGeneration === task.generation ? task.managementTurns ?? 0 : 0;
      assert(turns < 4, 'MANAGEMENT_LIMIT', '管理动作续轮已达上限，请汇总交付或请求具体协助');
      this.store.transaction(() => {
        const batch = this.company.runActions({ kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants }, { taskId: task.id, generation: task.generation, batchId: output.actionBatchId, actions: output.actions, rationale: output.summary });
        this.finishAttempt(attempt, 'completed', output.summary);
        task = this.store.require('tasks', task.id);
        this.store.put('tasks', { ...task, status: 'ready', attempts: 0, retryAt: null, managementGeneration: task.generation, managementTurns: turns + 1 });
        this.store.event('management.continued', task.id, { batchId: batch.batchId, turn: turns + 1 }, SYSTEM);
      });
      return;
    }
    if (task.kind === 'coordination' && ['coordinated', 'planned', 'decomposed'].includes(output.outcome)) {
      this.store.transaction(() => {
        if (output.actions !== undefined) this.company.runActions(
          { kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants },
          { taskId: task.id, generation: task.generation, batchId: output.actionBatchId ?? 'default', actions: output.actions, rationale: output.summary }
        );
        if (output.outcome === 'coordinated') completeCoordination(this, task, attempt, output);
        else this.acceptPlan(task, attempt, output);
      });
      return;
    }
    if (output.actions !== undefined) {
      assert(output.outcome === 'blocked' || (task.kind === 'plan' ? ['planned', 'decomposed'].includes(output.outcome) : task.kind === 'review' ? output.outcome === 'reviewed' : task.kind === 'coordination' ? ['coordinated', 'planned'].includes(output.outcome) : ['completed', 'decomposed'].includes(output.outcome)), 'INVALID_RESULT', 'Management actions must accompany a valid outcome for this task');
      assert(attempt.role === 'manager', 'FORBIDDEN', 'Only a manager can submit management actions');
      this.company.runActions({ kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants }, { taskId: task.id, generation: task.generation, batchId: output.actionBatchId ?? 'default', actions: output.actions, rationale: output.summary });
      task = this.currentAttemptTask(attempt, true);
    }
    if (output.outcome === 'blocked') {
      // The accepted marker, handoff and business effects are one durable unit.
      // A crash must never leave a completed attempt with a running task and no
      // pending question (or lose the scheduled retry/repair branch).
      this.store.transaction(() => {
        // This branch also accepts a verified completed receipt after recovery.
        // Its blocker is safe to apply once the receipt has established cleanup.
        if (task.status === 'reconciling') task = this.store.put('tasks', { ...task, status: 'running' });
        this.finishAttempt(attempt, 'completed', output.summary ?? output.reason);
        if (typeof output.reversibleDefault === 'string') {
          const saved = this.store.require('attempts', attempt.id); this.store.put('attempts', { ...saved, handoff: output.reversibleDefault.slice(0, 16000) });
        }
        if (output.kind === 'technical' && task.attempts < this.company.policy().maxAttempts) {
          this.store.put('tasks', { ...task, status: 'ready', feedback: output.reason, retryAt: Date.now() + 1000 * task.attempts }); this.store.event('task.retry.scheduled', task.id, {}, SYSTEM);
        } else if (output.kind === 'technical' && task.kind === 'work') this.scheduleRepair(task, output.reason);
        else this.block(task, output.kind ?? 'human', output.reason, output.question ?? '需要补充哪些信息才能继续？');
      });
      return;
    }
    assert(output.outcome !== 'coordinated', 'INVALID_RESULT', 'Only a coordination task can be coordinated');
    if (task.kind === 'plan' || task.kind === 'coordination' || output.outcome === 'decomposed') { this.acceptPlan(task, attempt, output); return; }
    if (task.kind === 'review') { await this.acceptReview(task, attempt, output); return; }
    assert(output.outcome === 'completed', 'INVALID_RESULT', 'Execution did not submit a completed result');
    const collected = await this.workspaces.collect(task, { ...attempt, signal }, output.artifacts ?? [],
      (command, args, cwd, options) => this.runHostCheck(attempt, command, args, cwd, options));
    signal.throwIfAborted(); this.fenced();
    const environmentFailures = collected.checks.filter(c => !c.passed && !c.timedOut)
      .map(c => classifyEnvironment({ message: (c.stderr ?? '') + '\n' + (c.stdout ?? '') })).filter(Boolean);
    if (environmentFailures.length) {
      await this.acceptRuntimeEnvironment(attempt, task, environmentFailures, signal);
      return;
    }
    const checksPassed = collected.checks.every(c => c.passed);
    this.store.transaction(() => {
      task = this.currentAttemptTask(attempt, true);
      for (const artifact of collected.artifacts) this.store.put('artifacts', artifact);
      this.store.put('verifications', { id: id('verification'), taskId: task.id, attemptId: attempt.id, artifactHash: collected.hash, goalContractVersion: attempt.goalContractVersion ?? 1, taskGeneration: attempt.taskGeneration, kind: 'checks', passed: checksPassed, checks: collected.checks });
    });
    assert(checksPassed, 'CHECK_FAILED', `Configured acceptance checks failed: ${collected.checks.filter(c => !c.passed).map(c => `${c.id}: ${c.stderr || c.stdout || c.code}`).join('\n').slice(0, 6000)}`, { checks: collected.checks });
    this.store.transaction(() => {
      task = this.currentAttemptTask(attempt, true);
      task = this.store.put('tasks', { ...task, deliveryGeneration: attempt.taskGeneration, artifactIds: collected.artifacts.map(a => a.id), artifactHash: collected.hash, changeSet: collected.changeSet, summary: output.summary ?? '', status: 'integrating', integrationPending: true, lastAuthorId: attempt.agentId });
      this.finishAttempt(attempt, 'completed', output.summary);
    });
  }
  acceptPlan(task, attempt, output) { return acceptPlanFlow(this, task, attempt, output); }
  acceptEnvironment(attempt, task, { failures, report }, executed) {
    this.store.transaction(() => {
      task = this.currentAttemptTask(attempt, true);
      if (task.status === 'reconciling') task = this.store.put('tasks', { ...task, status: 'running' });
      if (!executed) task = this.store.put('tasks', { ...task, attempts: Math.max(0, task.attempts - 1) });
      this.store.put('attempts', { ...this.store.require('attempts', attempt.id), environment: report, preflightOnly: !executed });
      const finished = this.finishAttempt(attempt, executed ? 'completed' : 'failed', failures.map(f => f.reason).join('；'));
      if (!executed) this.store.put('attempts', { ...finished, cleanupPending: false });
      holdEnvironment(this, task, failures, report);
    });
  }
  async acceptRuntimeEnvironment(attempt, task, failures, signal) {
    const previous = this.store.get('attempts', attempt.id)?.environment;
    const observed = await inspectEnvironment(this, task, this.store.require('agents', attempt.agentId), { failures },
      previous ? { report: { ...previous.runtime } } : undefined);
    signal.throwIfAborted();
    this.acceptEnvironment(attempt, task, { report: observed.report,
      failures: [...new Map([...failures, ...observed.failures].map(f => [f.fingerprint, f])).values()] }, true);
  }
  scheduleRepair(task, reason, evidence) { return scheduleRepairFlow(this, task, reason, evidence); }
  async acceptReview(review, attempt, output) { return acceptReviewFlow(this, review, attempt, output); }
  queueIntegration(taskId) {
    if (this.queuedIntegrations.has(taskId)) return;
    this.queuedIntegrations.add(taskId);
    this.integration = this.integration.then(() => executeIntegration(this, taskId))
      .catch(error => { this.lastError = error.message; })
      .finally(() => { this.queuedIntegrations.delete(taskId); this.kick(); });
  }
  updateGoal(goalId) {
    return this.company.refreshGoal(goalId);
  }
  finishAttempt(attempt, status, summary, keepDeferred = false) {
    return this.store.transaction(() => {
      const current = this.store.require('attempts', attempt.id); if (!ACTIVE.has(current.status)) return current;
      const elapsedMs = current.deferredReplayAt ? (current.elapsedMs ?? 0) + Math.max(0, Date.now() - Date.parse(current.deferredReplayAt)) :
        Math.max(current.elapsedMs ?? 0, (current.recoveredFinishedAt ? Date.parse(current.recoveredFinishedAt) : Date.now()) - Date.parse(current.startedAt));
      if (current.resultDeferred && !keepDeferred) this.store.remove('deferredResults', current.id);
      const saved = this.store.put('attempts', { ...current, status, resultAccepted: status === 'completed', cleanupPending: true,
        resultDeferred: keepDeferred && current.resultDeferred === true, deferredReplayAt: null, summary: summary ?? '', finishedAt: now(), elapsedMs });
      const goal = this.store.require('goals', current.goalId); this.store.put('goals', { ...goal, runtimeMs: goal.runtimeMs + elapsedMs - (current.elapsedMs ?? 0) });
      this.store.event('attempt.finished', current.id, { taskId: current.taskId, status }, SYSTEM); return saved;
    });
  }
  block(task, kind, reason, question, evidence) {
    return this.store.transaction(() => {
      const current = this.store.require('tasks', task.id);
      if (task.generation !== current.generation || ignoresBlocker(current)) return current;
      task = current;
      if (blockerRoute(task, kind) === 'manager') return this.coordinateBlocker(task, { kind, reason, question, evidence });
      return this.blockForOwner(task, kind, reason, question);
    });
  }
  coordinateBlocker(task, options) { return coordinateBlocker(this, task, options); }
  blockForOwner(task, kind, reason, question) {
    const current = this.store.require('tasks', task.id);
    if (task.generation !== current.generation || ignoresBlocker(current)) return current;
    task = current;
    if (this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending')) return task;
    // A coordination decision may adjust a paused task, but it must never turn the
    // owner pause into work. Owner-facing blocks keep the pause status untouched.
    const paused = task.status === 'paused';
    this.store.put('tasks', { ...task, status: paused ? 'paused' : 'blocked', integrationPending: task.integrationPending || task.status === 'integrating', blocker: { kind, reason } });
    this.store.put('interactions', { id: id('interaction'), taskId: task.id, goalId: task.goalId, taskGeneration: task.generation, kind, reason, question, status: 'pending' });
    this.store.event('task.blocked', task.id, { kind, reason, route: 'owner' }, SYSTEM);
    return this.store.require('tasks', task.id);
  }
  refreshCoordinationAttempt(task, attempt) {
    if (!attempt.blockerFeedbackHash || attempt.blockerFeedbackHash === task.feedbackHash) return false;
    this.store.transaction(() => {
      this.finishAttempt(attempt, 'interrupted', '协调期间收到更新的阻塞证据');
      if ((task.evidenceRestarts ?? 0) >= 1) {
        this.blockForOwner(task, 'execution', '协调期间阻塞证据持续变化', '请核对当前阻塞事实后恢复协调。');
      } else {
        this.store.put('tasks', { ...task, status: 'ready', attempts: 0, retryAt: null, evidenceRestarts: (task.evidenceRestarts ?? 0) + 1 });
        this.store.event('coordination.evidence.refreshed', task.id, { feedbackHash: task.feedbackHash }, SYSTEM, { goalId: task.goalId });
      }
    });
    return true;
  }
  fail(attempt, error, aborted, observed, preparingWorkspace = false) {
    this.store.transaction(() => {
      const task = this.store.require('tasks', attempt.taskId); const stopped = task.stopRequested;
      if (!ACTIVE.has(this.store.require('attempts', attempt.id).status)) return;
      const failure = !aborted && !error.cleanupUncertain && !error.recoveryRequired && classifyEnvironment(error, preparingWorkspace ? 'workspace' : null);
      const staleRoute = error.code === 'ROUTE_PREFLIGHT_STALE';
      const keepDeferred = !!attempt.deferredReplayAt && (stopped === 'paused' || this.closing);
      this.finishAttempt(attempt, keepDeferred ? 'completed' : aborted || staleRoute ? 'interrupted' : 'failed', failure ? failure.reason : error.message, keepDeferred);
      if (task.activeAttemptId !== attempt.id || (!stopped && (task.generation !== attempt.taskGeneration || ignoresBlocker(task)))) return;
      if (error.cleanupUncertain || error.recoveryRequired) {
        // A closed runner does not prove that its model/tool descendants stopped.
        // dispose retains cleanupPending; reconciliation must precede any retry.
        this.store.put('tasks', { ...task, status: 'reconciling', resumeOnStart: false, feedback: `${error.code}: ${error.message}`, retryAt: null });
        this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, message: error.message, retry: false }, SYSTEM);
        return;
      }
      if (!stopped && !this.closing && error.code !== 'GOAL_RUNTIME_BUDGET' && this.refreshCoordinationAttempt(task, attempt)) return;
      if (error.code === 'GOAL_RUNTIME_BUDGET' && !stopped && !this.closing) {
        this.block(task, 'budget', '目标累计执行时间额度已用完', '请在回复中填写给此目标追加的分钟数；单次执行时限与目标累计额度分别计算。');
        return;
      }
      if (!stopped && !this.closing && goalStopped(this.store.require('goals', task.goalId))) {
        const beforeDispatch = error.code === 'GOAL_PAUSED';
        const retry = beforeDispatch || task.attempts < this.company.policy().maxAttempts;
        this.store.put('tasks', { ...task, status: retry ? 'ready' : 'failed', feedback: failure?.reason ?? error.message,
          attempts: beforeDispatch ? Math.max(0, task.attempts - 1) : task.attempts,
          retryAt: retry && !beforeDispatch ? Date.now() + 1000 * task.attempts : null });
        this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, retry }, SYSTEM);
        return;
      }
      if (error.code === 'OWNER_STEER' && !stopped && !this.closing) {
        this.store.put('tasks', { ...task, status: 'ready', resumeOnStart: false, stopRequested: null, retryAt: null, attempts: Math.max(0, task.attempts - 1) });
        this.store.event('attempt.owner.steered', attempt.id, { taskId: task.id }, OWNER);
        return;
      }
      if (staleRoute && !stopped && !this.closing) {
        this.store.put('attempts', { ...this.store.require('attempts', attempt.id), preflightOnly: true, cleanupPending: false });
        for (const notificationId of attempt.notificationIds ?? []) {
          const notification = this.store.get('notifications', notificationId);
          if (notification?.attemptId === attempt.id && notification.status === 'delivered') {
            this.store.put('notifications', { ...notification, status: 'pending', attemptId: null, deliveredAt: null });
          }
        }
        this.store.put('tasks', { ...task, status: 'ready', retryAt: null, attempts: Math.max(0, task.attempts - 1) });
        this.store.event('attempt.route.recheck', attempt.id, { taskId: task.id }, SYSTEM);
        return;
      }
      if (selectionBlocked(error) && !stopped && !this.closing) {
        const selection = error.details.selection;
        this.store.put('attempts', { ...this.store.require('attempts', attempt.id), selection });
        const evidence = {
          code: selection.blocked?.code ?? 'NO_ELIGIBLE_CANDIDATE',
          policyFingerprint: selection.policyFingerprint ?? null,
          candidates: (selection.considered ?? []).map(({ candidateId, exclusion }) => ({ candidateId, exclusion }))
            .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
        };
        this.block(task, 'model-selection', '没有可用执行候选：' + error.message,
          '请在模型偏好或执行人员绑定中调整候选后恢复任务。选择阻塞代码：' + evidence.code, evidence);
        return;
      }
      if (failure && observed && !stopped && !this.closing) {
        if (preparingWorkspace && observed.failures.length) {
          this.store.put('attempts', { ...this.store.require('attempts', attempt.id), preflightOnly: true, cleanupPending: false, environment: observed.report });
          const saved = this.store.put('tasks', { ...task, attempts: Math.max(0, task.attempts - 1) });
          holdEnvironment(this, saved, observed.failures, observed.report);
        } else {
          holdEnvironment(this, task, [failure, ...observed.failures.filter(f => f.fingerprint !== failure.fingerprint)], observed.report);
        }
        return;
      }
      const retry = !stopped && !this.closing && task.attempts < this.company.policy().maxAttempts;
      this.store.put('tasks', { ...task, status: stopped ?? (this.closing ? 'paused' : retry ? 'ready' : 'failed'), resumeOnStart: this.closing && !stopped, stopRequested: null, feedback: `${error.code ?? 'EXECUTION_FAILED'}: ${error.message}`, retryAt: retry ? Date.now() + 1000 * task.attempts : null });
      this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, message: error.message, retry }, SYSTEM);
      if (!retry && !stopped && !this.closing && !task.repairOf && task.kind === 'work') this.scheduleRepair(this.store.require('tasks', task.id), error.message, { code: error.code ?? null });
      else if (!retry && !stopped && !this.closing && task.kind === 'repair') this.coordinateFailure(this.store.require('tasks', task.id), error.message, { code: error.code ?? null });
      else if (!retry && !stopped && !this.closing) this.block(this.store.require('tasks', task.id), 'execution', error.message, '自动重试已用完，请补充执行条件后恢复此分支。', { code: error.code ?? null });
    });
  }
  coordinateFailure(task, reason, evidence) { return coordinateExecutionLimit(this, task, reason, evidence); }
  async stop() {
    this.closing = true;
    interruptIntegration(this);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.listener) { this.store.events.off('event', this.listener); this.listener = null; }
    for (const entry of this.live.values()) entry.controller.abort(new Error('ACMS is stopping'));
    await Promise.allSettled([...this.live.values()].map(e => e.promise)); await this.integration;
    try { await this.adapter.close?.(); } finally { this.store.releaseLease(this.owner); }
  }
}
