import { randomUUID } from 'node:crypto';
import { assert, id, now, parseResult, digest, SYSTEM, OWNER, TERMINAL } from '../core/util.js';
import { promptFor } from './prompt.js';
import { selectionBlocked } from '../core/model-selection.js';
import { acceptPlanFlow } from '../core/plan-ledger.js';
import { acceptReviewFlow } from './review-flow.js';
import { completeCoordination, coordinateBlocker, coordinateExecutionLimit, scheduleRepairFlow } from '../core/coordination.js';
import { blockerRoute } from '../core/blocker-policy.js';
import { goalRuntimeLimit, goalRuntimeSpent } from '../core/runtime-budget.js';

const ACTIVE = new Set(['preparing', 'running', 'cancelling', 'reconciling']);
export class Engine {
  constructor(company, adapter, workspaces, options = {}) {
    this.company = company; this.store = company.store; this.adapter = adapter; this.workspaces = workspaces;
    this.owner = randomUUID(); this.epoch = 0; this.live = new Map(); this.closing = false; this.ticking = false;
    this.intervalMs = options.intervalMs ?? 1000; this.integration = Promise.resolve(); this.lastError = null;
  }
  async start() {
    this.closing = false;
    this.epoch = this.store.acquireLease(this.owner);
    try { this.conversations?.recover(); await this.recover(); } catch (e) { this.store.releaseLease(this.owner); throw e; }
    this.listener = () => this.kick(); this.store.events.on('event', this.listener);
    this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); this.kick();
    for (const task of this.store.list('tasks')) if (task.status === 'integrating') this.queueIntegration(task.id);
  }
  kick() { if (this.closing || this.scheduled) return; this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.tick().catch(e => { this.lastError = String(e.message); }); }); }
  fenced() { assert(this.store.ownsLease(this.owner, this.epoch), 'LEASE_LOST', 'Scheduler no longer owns the company lease'); }
  async recover(taskId) {
    for (const previous of this.store.list('attempts').filter(a => (!taskId || a.taskId === taskId) && !this.live.has(a.id) && (ACTIVE.has(a.status) || a.cleanupPending))) {
      let fact;
      try { fact = await this.adapter.reconcile?.(previous) ?? { status: 'unknown', reason: '执行器未提供恢复回执' }; }
      catch (error) { fact = { status: 'unknown', reason: `恢复查询失败：${error.message}`, actions: ['refresh-receipt', 'inspect-execution'] }; }
      this.fenced();
      if (previous.provider?.startsWith('paired:') && ['completed', 'stopped'].includes(fact.status) && fact.cleanupConfirmed !== true) {
        fact = { status: 'unknown', reason: '配对回执未确认进程树清理', actions: ['refresh-receipt', 'inspect-execution'] };
      }
      if (previous.cleanupUncertain && fact.cleanupConfirmed !== true) {
        fact.status = 'unknown'; fact.reason = previous.cleanupError || 'Prior process tree cleanup is still unconfirmed'; delete fact.result;
      }
      const currentTask = this.store.require('tasks', previous.taskId);
      if (currentTask.activeAttemptId === previous.id && currentTask.generation === previous.taskGeneration && currentTask.stopRequested
        && ['completed', 'stopped'].includes(fact.status) && fact.cleanupConfirmed === true) {
        // A stop intent survives host loss. A clean completed receipt also
        // proves termination, but must not apply a result the owner has stopped.
        this.store.transaction(() => {
          const accepted = previous.resultAccepted || previous.status === 'completed';
          this.finishAttempt(previous, accepted ? 'completed' : 'interrupted', previous.summary);
          this.store.put('attempts', { ...this.store.require('attempts', previous.id), cleanupPending: false, cleanupUncertain: false,
            recovery: { status: 'stopped', reason: `已确认进程树清理，${currentTask.stopRequested === 'paused' ? '暂停' : '取消'}请求已落实。${fact.reason ?? ''}`, actions: [] } });
          this.store.put('tasks', { ...currentTask, status: currentTask.stopRequested, stopRequested: null, recoveryRequested: false, resumeOnStart: false });
          this.company.releaseTemporaryAgent(previous.agentId);
          this.store.event('attempt.stop.recovered', previous.id, { taskId: previous.taskId, status: currentTask.stopRequested }, SYSTEM);
        });
        continue;
      }
      if ((previous.status === 'completed' || previous.resultAccepted) && ['completed', 'stopped'].includes(fact.status)) {
        let restored;
        this.store.transaction(() => {
          this.store.put('attempts', { ...previous, status: 'completed', cleanupPending: false, cleanupUncertain: false, recovery: { status: 'cleanup-confirmed', reason: fact.reason } });
          const task = this.store.require('tasks', previous.taskId);
          if (task.activeAttemptId === previous.id && task.generation === previous.taskGeneration && task.status === 'reconciling' && previous.acceptedTaskStatus) restored = this.store.put('tasks', { ...task, status: previous.acceptedTaskStatus });
          this.company.releaseTemporaryAgent(previous.agentId);
        });
        if (restored?.status === 'integrating') this.queueIntegration(restored.id);
        continue;
      }
      if (fact.status === 'completed') {
        try {
          this.store.transaction(() => { this.store.put('attempts', { ...previous, recoveredFinishedAt: fact.finishedAt }); });
          await this.accept(previous, fact.result, new AbortController().signal);
          this.store.transaction(() => { this.store.put('attempts', { ...this.store.require('attempts', previous.id), cleanupPending: false, cleanupUncertain: false, recovery: { status: 'completed', reason: fact.reason } }); this.company.releaseTemporaryAgent(previous.agentId); this.store.event('attempt.result.recovered', previous.id, { taskId: previous.taskId }, SYSTEM); });
          continue;
        } catch (e) { fact.status = 'unknown'; fact.reason = `Recovered result needs inspection: ${e.message}`; delete fact.result; }
      }
      this.store.transaction(() => {
        const task = this.store.require('tasks', previous.taskId);
        const accepted = previous.resultAccepted || previous.status === 'completed';
        this.store.put('attempts', { ...previous, resultAccepted: accepted, acceptedTaskStatus: previous.acceptedTaskStatus ?? (accepted && task.status !== 'reconciling' ? task.status : null), status: fact.status === 'stopped' ? 'interrupted' : 'reconciling', cleanupPending: fact.status !== 'stopped', cleanupUncertain: fact.status === 'stopped' ? false : previous.cleanupUncertain, recovery: fact });
        if (task.activeAttemptId === previous.id && task.generation === previous.taskGeneration) this.store.put('tasks', { ...task, status: fact.status === 'stopped' ? (task.stopRequested ?? 'ready') : 'reconciling', stopRequested: fact.status === 'stopped' ? null : task.stopRequested });
        this.store.event('attempt.recovery', previous.id, { taskId: task.id, fact }, SYSTEM);
      });
    }
    this.store.transaction(() => {
      for (const task of this.store.list('tasks')) if (task.resumeOnStart && task.status === 'paused' && !this.store.list('attempts').some(a => a.taskId === task.id && (ACTIVE.has(a.status) || a.cleanupPending))) {
        this.store.put('tasks', { ...task, status: 'ready', resumeOnStart: false });
        this.store.event('task.host.resumed', task.id, {}, SYSTEM);
      }
    });
  }
  async tick() {
    if (this.ticking || this.closing) return; this.ticking = true;
    try {
      this.fenced(); this.store.heartbeat(this.owner);
      // A request made during final cleanup must survive until the live
      // activation settles; recover() deliberately excludes live attempts.
      for (const task of this.store.list('tasks').filter(t => t.recoveryRequested && ![...this.live.values()].some(entry => entry.taskId === t.id))) {
        this.store.transaction(() => this.store.put('tasks', { ...task, recoveryRequested: false }));
        await this.recover(task.id);
      }
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
      this.refreshReadiness();
      const p = this.company.policy();
      const active = this.store.list('attempts').filter(a => ACTIVE.has(a.status) || a.cleanupPending || this.live.has(a.id));
      let free = p.maxConcurrent - active.length - (this.adapter.activeProbes ?? 0) - (this.adapter.activeChats ?? 0); if (free <= 0) return;
      let ordinary = active.filter(a => ['work', 'repair'].includes(a.kind)).length;
      const busyAgents = new Set(active.map(a => a.agentId));
      const ready = this.store.list('tasks').filter(t => t.status === 'ready' && !t.stopRequested && (!t.retryAt || t.retryAt <= Date.now())).sort((a, b) => (['plan', 'review', 'coordination'].includes(b.kind) - ['plan', 'review', 'coordination'].includes(a.kind)) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      for (const task of ready) {
        if (free <= 0) break;
        if (active.some(a => a.taskId === task.id)) continue;
        const goal = this.store.require('goals', task.goalId);
        if ((spent.get(goal.id) ?? goal.runtimeMs) >= goalRuntimeLimit(goal, p)) { this.block(task, 'budget', '目标累计执行时间额度已用完', '请在回复中填写给此目标追加的分钟数；单次执行时限与目标累计额度分别计算。'); continue; }
        if (['work', 'repair'].includes(task.kind) && ordinary >= Math.max(1, p.maxConcurrent - p.controlSlots)) continue;
        if (busyAgents.has(task.agentId)) continue;
        const agent = this.store.require('agents', task.agentId); if (agent.status !== 'available') { this.block(task, 'assignment', '执行人员已释放或删除，需要重新分配', '请编辑任务，为其选择可分配的执行人员。'); continue; }
        const attempt = this.claim(task, agent);
        free--; busyAgents.add(agent.id); if (['work', 'repair'].includes(task.kind)) ordinary++;
        const controller = new AbortController(); const entry = { taskId: task.id, controller, promise: null };
        this.live.set(attempt.id, entry);
        entry.promise = this.execute(attempt, controller).catch(e => { this.lastError = String(e.message); }).finally(() => { this.live.delete(attempt.id); this.kick(); });
      }
    } finally { this.ticking = false; }
  }
  refreshReadiness() {
    this.store.transaction(() => {
      for (const task of this.store.list('tasks')) {
        if (!['ready', 'blocked'].includes(task.status)) continue;
        if (this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending')) continue;
        if (task.blocker && !task.blocker.resolutionTaskIds) continue;
        const ready = task.dependencies.every(d => { const dep = this.store.require('tasks', d); return dep.status === 'succeeded'; });
        const next = ready ? 'ready' : 'blocked';
        if (next !== task.status) { this.store.put('tasks', { ...task, status: next, ...(ready ? { blocker: null } : {}) }); this.store.event('task.readiness', task.id, { status: next }, SYSTEM); }
      }
    });
  }
  claim(task, agent) {
    return this.store.transaction(() => {
      this.fenced(); const current = this.store.require('tasks', task.id); assert(current.status === 'ready', 'CLAIM_CONFLICT', 'Task is no longer ready');
      const attemptId = id('attempt'); const contextKey = `acms:${task.goalId}:${task.id}:role-${agent.role}:${agent.id}:g${task.generation}`;
      const notificationIds = this.store.list('notifications').filter(n => n.agentId === agent.id && n.status === 'pending').slice(0, 100).map(n => n.id);
      const conversationMessageIds = this.conversations?.messagesFor(task, agent.id).map(m => m.id) ?? [];
      const attempt = this.store.put('attempts', { id: attemptId, taskId: task.id, goalId: task.goalId, agentId: agent.id, kind: task.kind, provider: agent.provider, model: agent.model, role: agent.role, status: 'preparing', contextKey, startedAt: now(), epoch: this.epoch, taskGeneration: task.generation, grants: agent.grants, notificationIds, conversationMessageIds });
      this.store.put('tasks', { ...current, status: 'running', attempts: current.attempts + 1, activeAttemptId: attemptId });
      this.store.event('attempt.claimed', attemptId, { taskId: task.id, kind: task.kind, contextKey }, SYSTEM); return attempt;
    });
  }
  async execute(attempt, controller) {
    let activation, cleanupFailure, recoveryFailure, deliveredResult = false; const timeout = setTimeout(() => controller.abort(new Error('Execution timeout')), this.company.policy().turnTimeoutMs);
    try {
      let task = this.store.require('tasks', attempt.taskId);
      const workspace = await this.workspaces.prepare(task, attempt);
      this.store.transaction(() => {
        this.fenced(); task = this.store.require('tasks', task.id);
        assert(task.activeAttemptId === attempt.id, 'STALE_RESULT', 'Workspace belongs to an obsolete attempt');
        // Keep the prepared directory even when an edit/stop arrived during I/O.
        // The next turn reuses it and refreshes its collaboration contract.
        task = this.store.put('tasks', { ...task, workspace });
        attempt = this.store.put('attempts', { ...this.store.require('attempts', attempt.id), workspace });
      });
      controller.signal.throwIfAborted();
      assert(task.generation === attempt.taskGeneration && !task.stopRequested, 'STALE_RESULT', 'Task changed during workspace preparation');
      this.store.transaction(() => {
        attempt = this.store.put('attempts', { ...attempt, status: 'running' });
        this.store.event('attempt.starting', attempt.id, { taskId: task.id }, SYSTEM);
      });
      const agent = this.store.require('agents', attempt.agentId);
      let modelContext;
      if (agent.role === 'manager') { try { modelContext = await this.adapter.modelContext?.(task.requirements); } catch (e) { this.lastError = '无法读取模型候选：' + e.message; } }
      activation = await this.adapter.start({ task, attempt, agent, prompt: promptFor(this.company, task, attempt, { modelContext }), signal: controller.signal, onAccepted: () => this.conversations?.accepted(attempt) });
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
      if (deliveredResult && activation?.provider?.startsWith('paired:')) recoveryFailure = Object.assign(new Error(`结果已返回，但尚未可靠入库：${error.message}`, { cause: error }), { code: 'RESULT_RECONCILIATION_REQUIRED', recoveryRequired: true });
      // Adapter bookkeeping can fail after the receipt is committed but before
      // activation.result resolves. Only a clean stopped receipt permits retry;
      // otherwise retain the slot, including when progress cannot be inspected.
      const saved = this.store.get('attempts', attempt.id);
      if (!cleanupFailure && !recoveryFailure && saved?.execution && saved.provider?.startsWith('paired:')) {
        let fact;
        try { fact = await this.adapter.reconcile?.(saved); } catch {}
        if (fact?.status !== 'stopped' || fact.cleanupConfirmed !== true) {
          recoveryFailure = Object.assign(new Error(`执行结果尚需核对：${error.message}; ${fact?.reason ?? '无法读取可靠结束回执'}`, { cause: error }), { code: 'RESULT_RECONCILIATION_REQUIRED', recoveryRequired: true });
        }
      }
      if (this.store.ownsLease(this.owner, this.epoch)) this.fail(attempt, cleanupFailure ?? recoveryFailure ?? (controller.signal.aborted ? controller.signal.reason : error), controller.signal.aborted);
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
          if (task.activeAttemptId === saved.id && task.generation === saved.taskGeneration && task.stopRequested) {
            this.store.put('tasks', { ...task, status: task.stopRequested, stopRequested: null, recoveryRequested: false, resumeOnStart: false });
            this.store.event('task.stop.completed', task.id, { status: task.stopRequested, attemptId: saved.id }, SYSTEM);
          }
          this.company.releaseTemporaryAgent(saved.agentId);
        });
      } catch (e) {
        this.lastError = `Cleanup: ${e.message}`;
        this.store.transaction(() => {
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
  async accept(attempt, output, signal) {
    this.fenced(); let task = this.store.require('tasks', attempt.taskId);
    assert(task.activeAttemptId === attempt.id && task.generation === attempt.taskGeneration && !task.stopRequested, 'STALE_RESULT', 'Result belongs to an obsolete attempt or contract');
    assert(['blocked', 'planned', 'decomposed', 'reviewed', 'completed', 'managed', 'coordinated'].includes(output.outcome), 'INVALID_RESULT', 'Execution returned an unknown outcome');
    if (output.outcome === 'managed') {
      assert(attempt.role === 'manager' && task.kind !== 'review', 'FORBIDDEN', 'Only an assigned manager can continue management');
      const turns = task.managementGeneration === task.generation ? task.managementTurns ?? 0 : 0;
      assert(turns < 4, 'MANAGEMENT_LIMIT', '管理动作续轮已达上限，请汇总交付或请求具体协助');
      this.store.transaction(() => {
        const batch = this.company.runActions({ kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants }, { taskId: task.id, generation: task.generation, batchId: output.actionBatchId, actions: output.actions });
        this.finishAttempt(attempt, 'completed', output.summary);
        task = this.store.require('tasks', task.id);
        this.store.put('tasks', { ...task, status: 'ready', attempts: 0, retryAt: null, managementGeneration: task.generation, managementTurns: turns + 1 });
        this.store.event('management.continued', task.id, { batchId: batch.batchId, turn: turns + 1 }, SYSTEM);
      });
      return;
    }
    if (output.actions !== undefined) {
      assert(output.outcome === 'blocked' || (task.kind === 'plan' ? ['planned', 'decomposed'].includes(output.outcome) : task.kind === 'review' ? output.outcome === 'reviewed' : task.kind === 'coordination' ? ['coordinated', 'planned'].includes(output.outcome) : ['completed', 'decomposed'].includes(output.outcome)), 'INVALID_RESULT', 'Management actions must accompany a valid outcome for this task');
      assert(attempt.role === 'manager', 'FORBIDDEN', 'Only a manager can submit management actions');
      this.company.runActions({ kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants }, { taskId: task.id, generation: task.generation, batchId: output.actionBatchId ?? 'default', actions: output.actions });
      task = this.store.require('tasks', task.id);
    }
    if (output.outcome === 'blocked') {
      // The accepted marker, handoff and business effects are one durable unit.
      // A crash must never leave a completed attempt with a running task and no
      // pending question (or lose the scheduled retry/repair branch).
      this.store.transaction(() => {
        this.finishAttempt(attempt, 'completed', output.summary ?? output.reason);
        if (typeof output.reversibleDefault === 'string') {
          const saved = this.store.require('attempts', attempt.id); this.store.put('attempts', { ...saved, handoff: output.reversibleDefault.slice(0, 16000) });
        }
        if (output.kind === 'technical' && task.attempts < this.company.policy().maxAttempts) {
          this.store.put('tasks', { ...task, status: 'ready', feedback: output.reason, retryAt: Date.now() + 1000 * task.attempts }); this.store.event('task.retry.scheduled', task.id, {}, SYSTEM);
        } else if (output.kind === 'technical' && !task.repairOf && task.kind !== 'review' && task.kind !== 'coordination') this.scheduleRepair(task, output.reason);
        else this.block(task, output.kind ?? 'human', output.reason, output.question ?? '需要补充哪些信息才能继续？');
      });
      return;
    }
    if (output.outcome === 'coordinated') { assert(task.kind === 'coordination', 'INVALID_RESULT', 'Only a coordination task can be coordinated'); completeCoordination(this, task, attempt, output); return; }
    if (task.kind === 'plan' || task.kind === 'coordination' || output.outcome === 'decomposed') { this.acceptPlan(task, attempt, output); return; }
    if (task.kind === 'review') { await this.acceptReview(task, attempt, output); return; }
    assert(output.outcome === 'completed', 'INVALID_RESULT', 'Execution did not submit a completed result');
    const collected = await this.workspaces.collect(task, { ...attempt, signal }, output.artifacts ?? []);
    signal.throwIfAborted(); this.fenced();
    const checksPassed = collected.checks.every(c => c.passed);
    this.store.transaction(() => {
      task = this.store.require('tasks', task.id); assert(task.activeAttemptId === attempt.id && !task.stopRequested, 'STALE_RESULT', 'Task was stopped while checking');
      for (const artifact of collected.artifacts) this.store.put('artifacts', artifact);
      this.store.put('verifications', { id: id('verification'), taskId: task.id, attemptId: attempt.id, artifactHash: collected.hash, kind: 'checks', passed: checksPassed, checks: collected.checks });
    });
    assert(checksPassed, 'CHECK_FAILED', `Configured acceptance checks failed: ${collected.checks.filter(c => !c.passed).map(c => `${c.id}: ${c.stderr || c.stdout || c.code}`).join('\n').slice(0, 6000)}`, { checks: collected.checks });
    this.store.transaction(() => {
      task = this.store.require('tasks', task.id);
      task = this.store.put('tasks', { ...task, artifactIds: collected.artifacts.map(a => a.id), artifactHash: collected.hash, changeSet: collected.changeSet, summary: output.summary ?? '', status: 'reviewing', lastAuthorId: attempt.agentId });
      this.finishAttempt(attempt, 'completed', output.summary);
      this.nextStage(task);
    });
  }
  acceptPlan(task, attempt, output) { return acceptPlanFlow(this, task, attempt, output); }
  nextStage(task) {
    const nextIndex = task.stageIndex + 1; const step = task.workflowSnapshot.steps[nextIndex];
    if (!step) { this.store.put('tasks', { ...task, status: 'integrating' }); this.queueIntegration(task.id); return; }
    task = this.store.put('tasks', { ...task, stageIndex: nextIndex, status: step.type === 'review' ? 'reviewing' : 'ready' });
    if (step.type === 'review') {
      const reviewer = this.store.list('agents').find(a => a.role === 'reviewer' && a.status === 'available' && a.id !== task.lastAuthorId) ?? this.company.temporaryAgent(task.goalId, 'reviewer');
      const review = this.company.createTask({ goalId: task.goalId, kind: 'review', title: `审查：${task.title}`, description: `阶段：${step.name}。独立核对交付物、检查结果和验收标准。`, acceptance: task.acceptance, parentId: task.id, reviewOf: task.id, reviewArtifactHash: task.artifactHash, agentId: reviewer.id, workflowSnapshot: task.workflowSnapshot, requiresArtifacts: false, checkIds: [] }, SYSTEM);
      this.store.event('review.queued', review.id, { taskId: task.id, reviewerId: reviewer.id, artifactHash: task.artifactHash }, SYSTEM);
    }
  }
  scheduleRepair(task, reason) { return scheduleRepairFlow(this, task, reason); }
  async acceptReview(review, attempt, output) { return acceptReviewFlow(this, review, attempt, output); }
  queueIntegration(taskId) {
    this.integration = this.integration.then(async () => {
      if (this.closing) return;
      let task = this.store.require('tasks', taskId); if (task.status !== 'integrating') return;
      try {
        const integration = await this.workspaces.integrate(task); this.fenced();
        this.store.transaction(() => {
          task = this.store.require('tasks', taskId); this.store.put('tasks', { ...task, status: 'succeeded', integration });
          this.company.releaseTemporaryAgent(task.agentId);
          this.store.event('task.succeeded', task.id, { integration }, SYSTEM); this.updateGoal(task.goalId);
        });
      } catch (e) { if (!this.closing) this.block(task, 'integration', e.message, '请解决目标工作区冲突或集成检查问题后恢复。'); }
    }).catch(e => { this.lastError = e.message; });
  }
  updateGoal(goalId) {
    return this.company.refreshGoal(goalId);
  }
  finishAttempt(attempt, status, summary) {
    return this.store.transaction(() => {
      const current = this.store.require('attempts', attempt.id); if (!ACTIVE.has(current.status)) return current;
      const elapsedMs = Math.max(current.elapsedMs ?? 0, (current.recoveredFinishedAt ? Date.parse(current.recoveredFinishedAt) : Date.now()) - Date.parse(current.startedAt));
      const saved = this.store.put('attempts', { ...current, status, resultAccepted: status === 'completed', cleanupPending: true, summary: summary ?? '', finishedAt: now(), elapsedMs });
      const goal = this.store.require('goals', current.goalId); this.store.put('goals', { ...goal, runtimeMs: goal.runtimeMs + elapsedMs - (current.elapsedMs ?? 0) });
      this.store.event('attempt.finished', current.id, { taskId: current.taskId, status }, SYSTEM); return saved;
    });
  }
  block(task, kind, reason, question) {
    return this.store.transaction(() => {
      task = this.store.require('tasks', task.id);
      if (blockerRoute(task, kind) === 'manager') return this.coordinateBlocker(task, { kind, reason, question });
      return this.blockForOwner(task, kind, reason, question);
    });
  }
  coordinateBlocker(task, options) { return coordinateBlocker(this, task, options); }
  blockForOwner(task, kind, reason, question) {
    task = this.store.require('tasks', task.id);
    // A coordination decision may adjust a paused task, but it must never turn the
    // owner pause into work. Owner-facing blocks keep the pause status untouched.
    const paused = task.status === 'paused';
    this.store.put('tasks', { ...task, status: paused ? 'paused' : 'blocked', blocker: { kind, reason } });
    if (!this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending')) this.store.put('interactions', { id: id('interaction'), taskId: task.id, goalId: task.goalId, taskGeneration: task.generation, kind, reason, question, status: 'pending' });
    this.store.event('task.blocked', task.id, { kind, reason, route: 'owner' }, SYSTEM);
    return this.store.require('tasks', task.id);
  }
  fail(attempt, error, aborted) {
    this.store.transaction(() => {
      const task = this.store.require('tasks', attempt.taskId); const stopped = task.stopRequested;
      this.finishAttempt(attempt, aborted ? 'interrupted' : 'failed', error.message);
      if (task.activeAttemptId !== attempt.id) return;
      if (error.cleanupUncertain || error.recoveryRequired) {
        // A closed runner does not prove that its model/tool descendants stopped.
        // dispose retains cleanupPending; reconciliation must precede any retry.
        this.store.put('tasks', { ...task, status: 'reconciling', resumeOnStart: false, feedback: `${error.code}: ${error.message}`, retryAt: null });
        this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, message: error.message, retry: false }, SYSTEM);
        return;
      }
      if (error.code === 'GOAL_RUNTIME_BUDGET' && !stopped && !this.closing) {
        this.block(task, 'budget', '目标累计执行时间额度已用完', '请在回复中填写给此目标追加的分钟数；单次执行时限与目标累计额度分别计算。');
        return;
      }
      if (error.code === 'OWNER_STEER' && !stopped && !this.closing) {
        this.store.put('tasks', { ...task, status: 'ready', resumeOnStart: false, stopRequested: null, retryAt: null, attempts: Math.max(0, task.attempts - 1) });
        this.store.event('attempt.owner.steered', attempt.id, { taskId: task.id }, OWNER);
        return;
      }
      if (selectionBlocked(error) && !stopped && !this.closing) {
        this.store.put('attempts', { ...this.store.require('attempts', attempt.id), selection: error.details.selection });
        this.block(task, 'model-selection', '没有可用执行候选：' + error.message, '请在模型偏好或执行人员绑定中调整候选后恢复任务。选择阻塞代码：' + (error.details.selection.blocked?.code ?? 'NO_ELIGIBLE_CANDIDATE'));
        return;
      }
      const retry = !stopped && !this.closing && task.attempts < this.company.policy().maxAttempts;
      this.store.put('tasks', { ...task, status: stopped ?? (this.closing ? 'paused' : retry ? 'ready' : 'failed'), resumeOnStart: this.closing && !stopped, stopRequested: null, feedback: `${error.code ?? 'EXECUTION_FAILED'}: ${error.message}`, retryAt: retry ? Date.now() + 1000 * task.attempts : null });
      this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, message: error.message, retry }, SYSTEM);
      if (!retry && !stopped && !this.closing && !task.repairOf && task.kind === 'work') this.scheduleRepair(this.store.require('tasks', task.id), error.message);
      else if (!retry && !stopped && !this.closing && task.kind === 'repair') this.coordinateFailure(this.store.require('tasks', task.id), error.message);
      else if (!retry && !stopped && !this.closing) this.block(this.store.require('tasks', task.id), 'execution', error.message, '自动重试已用完，请补充执行条件后恢复此分支。');
    });
  }
  coordinateFailure(task, reason) { return coordinateExecutionLimit(this, task, reason); }
  async stop() {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.listener) { this.store.events.off('event', this.listener); this.listener = null; }
    for (const entry of this.live.values()) entry.controller.abort(new Error('ACMS is stopping'));
    await Promise.allSettled([...this.live.values()].map(e => e.promise)); await this.integration;
    try { await this.adapter.close?.(); } finally { this.store.releaseLease(this.owner); }
  }
}
