import { randomUUID } from 'node:crypto';
import { assert, id, now, parseResult, digest, SYSTEM, OWNER, TERMINAL } from '../core/util.js';
import { promptFor } from './prompt.js';
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
  async recover() {
    for (const previous of this.store.list('attempts').filter(a => ACTIVE.has(a.status) || a.cleanupPending)) {
      const fact = await this.adapter.reconcile?.(previous) ?? { status: 'unknown' };
      if (previous.status === 'completed' && ['completed', 'stopped'].includes(fact.status)) {
        this.store.transaction(() => { this.store.put('attempts', { ...previous, cleanupPending: false, recovery: { status: 'cleanup-confirmed' } }); this.company.releaseTemporaryAgent(previous.agentId); });
        continue;
      }
      if (fact.status === 'completed') {
        try {
          this.store.transaction(() => { this.store.put('attempts', { ...previous, recoveredFinishedAt: fact.finishedAt }); });
          await this.accept(previous, fact.result, new AbortController().signal);
          this.store.transaction(() => { this.store.put('attempts', { ...this.store.require('attempts', previous.id), cleanupPending: false }); this.company.releaseTemporaryAgent(previous.agentId); this.store.event('attempt.result.recovered', previous.id, { taskId: previous.taskId }, SYSTEM); });
          continue;
        } catch (e) { fact.status = 'unknown'; fact.reason = `Recovered result needs inspection: ${e.message}`; delete fact.result; }
      }
      this.store.transaction(() => {
        const task = this.store.require('tasks', previous.taskId);
        this.store.put('attempts', { ...previous, status: fact.status === 'stopped' ? 'interrupted' : 'reconciling', cleanupPending: false, recovery: fact });
        this.store.put('tasks', { ...task, status: fact.status === 'stopped' ? (task.stopRequested ?? 'ready') : 'reconciling', stopRequested: fact.status === 'stopped' ? null : task.stopRequested });
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
      const ready = this.store.list('tasks').filter(t => t.status === 'ready' && !t.stopRequested && (!t.retryAt || t.retryAt <= Date.now())).sort((a, b) => (['plan', 'review'].includes(b.kind) - ['plan', 'review'].includes(a.kind)) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      for (const task of ready) {
        if (free <= 0) break;
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
    let activation; const timeout = setTimeout(() => controller.abort(new Error('Execution timeout')), this.company.policy().turnTimeoutMs);
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
      activation = await this.adapter.start({ task, attempt, agent: this.store.require('agents', attempt.agentId), prompt: promptFor(this.company, task, attempt), signal: controller.signal, onAccepted: () => this.conversations?.accepted(attempt) });
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
      const raw = await activation.result; controller.signal.throwIfAborted();
      const output = parseResult(raw); this.conversations?.finished(attempt, output); await this.accept(attempt, output, controller.signal);
    } catch (error) {
      if (this.store.ownsLease(this.owner, this.epoch)) this.fail(attempt, error.cleanupUncertain ? error : controller.signal.aborted ? controller.signal.reason : error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
      // The slot is not released until the provider confirms process cleanup.
      try {
        await activation?.dispose?.();
        if (this.store.ownsLease(this.owner, this.epoch)) this.store.transaction(() => {
          const saved = this.store.require('attempts', attempt.id); this.store.put('attempts', { ...saved, cleanupPending: false });
          this.company.releaseTemporaryAgent(saved.agentId);
        });
      } catch (e) {
        this.lastError = `Cleanup: ${e.message}`;
        this.store.transaction(() => {
          const saved = this.store.require('attempts', attempt.id); this.store.put('attempts', { ...saved, status: 'reconciling', cleanupPending: true, cleanupError: e.message });
          const task = this.store.require('tasks', attempt.taskId); this.store.put('tasks', { ...task, status: 'reconciling' });
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
    assert(['blocked', 'planned', 'decomposed', 'reviewed', 'completed', 'managed'].includes(output.outcome), 'INVALID_RESULT', 'Execution returned an unknown outcome');
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
      assert(output.outcome === 'blocked' || (task.kind === 'plan' ? ['planned', 'decomposed'].includes(output.outcome) : task.kind === 'review' ? output.outcome === 'reviewed' : ['completed', 'decomposed'].includes(output.outcome)), 'INVALID_RESULT', 'Management actions must accompany a valid outcome for this task');
      assert(attempt.role === 'manager', 'FORBIDDEN', 'Only a manager can submit management actions');
      this.company.runActions({ kind: 'agent', id: attempt.agentId, goalId: task.goalId, grants: attempt.grants }, { taskId: task.id, generation: task.generation, batchId: output.actionBatchId ?? 'default', actions: output.actions });
      task = this.store.require('tasks', task.id);
    }
    if (output.outcome === 'blocked') {
      this.finishAttempt(attempt, 'completed', output.summary ?? output.reason);
      if (typeof output.reversibleDefault === 'string') this.store.transaction(() => {
        const saved = this.store.require('attempts', attempt.id); this.store.put('attempts', { ...saved, handoff: output.reversibleDefault.slice(0, 16000) });
      });
      if (output.kind === 'technical' && task.attempts < this.company.policy().maxAttempts) {
        this.store.transaction(() => { this.store.put('tasks', { ...task, status: 'ready', feedback: output.reason, retryAt: Date.now() + 1000 * task.attempts }); this.store.event('task.retry.scheduled', task.id, {}, SYSTEM); });
      } else if (output.kind === 'technical' && !task.repairOf && task.kind !== 'review') this.scheduleRepair(task, output.reason);
      else this.block(task, output.kind ?? 'human', output.reason, output.question ?? '需要补充哪些信息才能继续？');
      return;
    }
    if (task.kind === 'plan' || output.outcome === 'decomposed') { this.acceptPlan(task, attempt, output); return; }
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
  acceptPlan(task, attempt, output) {
    assert(['planned', 'decomposed'].includes(output.outcome), 'INVALID_PLAN', 'Planner must return a structured plan');
    const nodes = output.tasks; assert(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= 30, 'INVALID_PLAN', 'Plan must contain 1–30 tasks');
    const keys = new Set(nodes.map(n => n.key)); assert(keys.size === nodes.length && nodes.every(n => typeof n.key === 'string'), 'INVALID_PLAN', 'Plan keys must be unique');
    const ordered = []; const visiting = new Set(); const visited = new Set();
    const visit = key => { assert(!visiting.has(key), 'DEPENDENCY_CYCLE', 'Plan contains a cycle'); if (visited.has(key)) return; visiting.add(key); const node = nodes.find(n => n.key === key); assert(node, 'INVALID_PLAN', 'Unknown dependency'); for (const d of node.dependencies ?? []) visit(d); visiting.delete(key); visited.add(key); ordered.push(node); }; keys.forEach(visit);
    this.store.transaction(() => {
      const map = new Map();
      for (const node of ordered) {
        const child = this.company.createTask({ title: node.title, description: node.description, acceptance: node.acceptance, longLived: node.longLived === true, priority: node.priority ?? 50, goalId: task.goalId, kind: 'work', parentId: task.id, workflowSnapshot: task.workflowSnapshot, dependencies: (node.dependencies ?? []).map(k => map.get(k)) }, SYSTEM);
        map.set(node.key, child.id);
      }
      this.finishAttempt(attempt, 'completed', output.summary);
      if (task.kind === 'plan') this.store.put('tasks', { ...task, status: 'succeeded', summary: output.summary ?? '' });
      else this.store.put('tasks', { ...task, status: 'blocked', dependencies: [...task.dependencies, ...map.values()], blocker: { kind: 'children', resolutionTaskIds: [...map.values()] } });
      const goal = this.store.require('goals', task.goalId); this.store.put('goals', { ...goal, status: 'active' });
      this.store.event('plan.accepted', task.id, { tasks: [...map.values()] }, SYSTEM);
    });
  }
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
  scheduleRepair(task, reason) {
    this.store.transaction(() => {
      if ((task.repairs ?? 0) >= this.company.policy().maxReworks) { this.block(task, 'repair_limit', reason, '自动修复已达到上限，需要补充方向。'); return; }
      const repair = this.company.createTask({ goalId: task.goalId, kind: 'repair', title: `解阻：${task.title}`, description: `诊断并解决以下技术阻塞。输出可应用的修复文件或修复说明，原任务会自动读取交付物后继续。\n问题：${reason}\n原任务：${task.description}`, acceptance: '给出可验证的故障原因和具体修复交付物，并通过独立审查。', parentId: task.id, checkIds: [], workflowSnapshot: task.workflowSnapshot }, SYSTEM);
      this.store.put('tasks', { ...repair, repairOf: task.id });
      this.store.put('tasks', { ...task, status: 'blocked', stageIndex: 0, attempts: 0, repairs: (task.repairs ?? 0) + 1, dependencies: [...task.dependencies, repair.id], blocker: { kind: 'technical', reason, resolutionTaskIds: [repair.id] } });
      this.store.event('repair.queued', repair.id, { taskId: task.id, reason }, SYSTEM);
    });
  }
  async acceptReview(review, attempt, output) {
    assert(output.outcome === 'reviewed' && ['approve', 'changes_requested'].includes(output.decision), 'INVALID_REVIEW', 'Reviewer must return a decision');
    let source = this.store.require('tasks', review.reviewOf);
    assert(source.status === 'reviewing' && source.artifactHash === review.reviewArtifactHash, 'STALE_REVIEW', 'Review targets an obsolete artifact version');
    assert(attempt.agentId !== source.lastAuthorId, 'SELF_REVIEW', 'Author cannot approve their own work');
    const unchanged = await this.workspaces.unchanged(source, source.artifactIds);
    assert(unchanged, 'ARTIFACT_CHANGED', 'Reviewed files changed after checks');
    this.store.transaction(() => {
      source = this.store.require('tasks', source.id); assert(source.status === 'reviewing' && !source.stopRequested, 'STALE_REVIEW', 'Source task was paused during review');
      this.finishAttempt(attempt, 'completed', output.summary);
      this.store.put('tasks', { ...review, status: 'succeeded', summary: output.summary ?? '' });
      this.store.put('verifications', { id: id('verification'), taskId: source.id, attemptId: attempt.id, artifactHash: source.artifactHash, kind: 'review', reviewerId: attempt.agentId, passed: output.decision === 'approve', summary: output.summary, findings: output.findings ?? [] });
      if (output.decision === 'approve') this.nextStage(source);
      else {
        const reworks = source.reworks + 1; const exhausted = reworks > Math.min(source.workflowSnapshot.maxReworks, this.company.policy().maxReworks);
        this.store.put('tasks', { ...source, status: exhausted ? 'blocked' : 'ready', stageIndex: 0, reworks, feedback: [output.summary, ...(output.findings ?? [])].filter(Boolean).join('\n'), ...(exhausted ? { blocker: { kind: 'review_limit', reason: '审查返工次数已达到上限' } } : {}) });
        if (exhausted) this.block(this.store.require('tasks', source.id), 'review_limit', '连续返工未通过审查', '请调整范围或提供方向后继续。');
      }
      this.store.event('review.decided', review.id, { taskId: source.id, decision: output.decision }, SYSTEM);
    });
  }
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
      const elapsedMs = Math.max(0, (current.recoveredFinishedAt ? Date.parse(current.recoveredFinishedAt) : Date.now()) - Date.parse(current.startedAt));
      const saved = this.store.put('attempts', { ...current, status, cleanupPending: true, summary: summary ?? '', finishedAt: now(), elapsedMs });
      const goal = this.store.require('goals', current.goalId); this.store.put('goals', { ...goal, runtimeMs: goal.runtimeMs + elapsedMs });
      this.store.event('attempt.finished', current.id, { taskId: current.taskId, status }, SYSTEM); return saved;
    });
  }
  block(task, kind, reason, question) {
    return this.store.transaction(() => {
      task = this.store.require('tasks', task.id); this.store.put('tasks', { ...task, status: 'blocked', blocker: { kind, reason } });
      if (!this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending')) this.store.put('interactions', { id: id('interaction'), taskId: task.id, goalId: task.goalId, taskGeneration: task.generation, kind, reason, question, status: 'pending' });
      this.store.event('task.blocked', task.id, { kind, reason }, SYSTEM);
    });
  }
  fail(attempt, error, aborted) {
    this.store.transaction(() => {
      const task = this.store.require('tasks', attempt.taskId); const stopped = task.stopRequested;
      this.finishAttempt(attempt, aborted ? 'interrupted' : 'failed', error.message);
      if (task.activeAttemptId !== attempt.id) return;
      if (error.cleanupUncertain) {
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
      const retry = !stopped && !this.closing && task.attempts < this.company.policy().maxAttempts;
      this.store.put('tasks', { ...task, status: stopped ?? (this.closing ? 'paused' : retry ? 'ready' : 'failed'), resumeOnStart: this.closing && !stopped, stopRequested: null, feedback: `${error.code ?? 'EXECUTION_FAILED'}: ${error.message}`, retryAt: retry ? Date.now() + 1000 * task.attempts : null });
      this.store.event('attempt.failed', attempt.id, { taskId: task.id, code: error.code, message: error.message, retry }, SYSTEM);
      if (!retry && !stopped && !this.closing && !task.repairOf && task.kind === 'work') this.scheduleRepair(this.store.require('tasks', task.id), error.message);
      else if (!retry && !stopped && !this.closing) this.block(this.store.require('tasks', task.id), 'execution', error.message, '自动重试已用完，请补充执行条件后恢复此分支。');
    });
  }
  async stop() {
    this.closing = true; clearInterval(this.timer); this.store.events.off('event', this.listener);
    for (const entry of this.live.values()) entry.controller.abort(new Error('ACMS is stopping'));
    await Promise.allSettled([...this.live.values()].map(e => e.promise)); await this.integration;
    await this.adapter.close?.(); this.store.releaseLease(this.owner);
  }
}
