import { assert, id, now, text, integer, clone, OWNER, SYSTEM, TERMINAL, digest, packageName } from './util.js';
import { canReconcileTask, goalContractCapacityMessage, goalTaskCount, taskDeletionReason, taskPurgeReason } from './task-actions.js';
import { contractVersion, taskContractVersion, deliveryGeneration, deliveredWork, goalDeliveryHash, matchesGoalContract, matchesTaskReview } from './goal-contract.js';
import { canCoordinate, findManager } from './coordination.js';
import { executionOccupancy } from './execution-capacity.js';
import { goalSummary, taskSettledForGoal } from './hierarchy.js';
import { runActionBatch } from './action-batch.js';
import { authorizeUserAgent, assertUserAgentAnswer, createCredentialRecord, createExternalProject, credentialSnapshot, revokeCredential, submitGoal, updateCredentialScope } from "./external-access.js";
import { deleteEntity, restoreEntity, recordChange, restartForChange } from './entity-management.js';
import { goalRuntimeLimit, goalRuntimeSpent } from './runtime-budget.js';
import { normalizePreferenceOrder, normalizeRequirements, sanitizePreferences } from './model-selection.js';
import { assertGoalOpen, controlGoal, discardDeferredResult, goalControlView, goalStopped } from './goal-control.js';
import { normalizePreparation } from './project-preparation.js';

const PHASE_IDS = new Set(['plan', 'execute', 'final-review']);
const BASE_TEMPLATE = { id: 'base', name: '基础模板', version: 1, phases: [{ id: 'plan', name: '拆分' }, { id: 'execute', name: '执行' }, { id: 'final-review', name: '最终审查' }], finalReview: true, published: true };
const GRANTS = { manager: ['task.create', 'task.edit', 'task.dependencies', 'agent.save', 'task.retry'], worker: [], reviewer: [] };
export class Company {
  constructor(store) {
    this.store = store;
    if (!store.get('policy', 'company')) store.transaction(() => {
      store.put('policy', { id: 'company', name: 'ACMS', maxConcurrent: 4, controlSlots: 1, maxTasksPerGoal: 80, maxTemporaryAgents: 24, maxAttempts: 3, maxReworks: 2, turnTimeoutMs: 1200000, maxGoalRuntimeMs: 14400000, goalTimeBoxMs: 0, timeBoxReserveMs: 0, paused: false, allowedProviders: [], allowedModels: [], allowedProjectRoots: [], maxArtifactBytes: 16777216 });
      for (const role of ['manager', 'reviewer']) store.put('agents', { id: role, name: role === 'manager' ? '项目负责人' : '质量审查员', role, provider: 'auto', model: '', temporary: false, status: 'available', grants: GRANTS[role], description: role === 'manager' ? '规划、协调、解决阻塞，在已授权目标内组织工作。' : '独立检查交付物及证据，不代替作者实现任务。' });
      store.event('company.created', 'company', {}, OWNER);
    });
    this.ensureTemplates();
  }
  ensureTemplates() {
    if (!this.store.get('templates', BASE_TEMPLATE.id)) this.store.put('templates', { ...BASE_TEMPLATE });
  }
  policy() {
    const policy = this.store.require('policy', 'company');
    // Old installations predate the time-box fields; normalize on read so the
    // settings form and submissions always see a complete 0-defaulted policy.
    return { ...policy, goalTimeBoxMs: policy.goalTimeBoxMs ?? 0, timeBoxReserveMs: policy.timeBoxReserveMs ?? 0 };
  }
  runActions(actor, batch) { return runActionBatch(this, actor, batch); }
  effectiveGrants(actor) {
    const current = this.store.require('agents', actor.id).grants;
    return actor.grants ? current.filter(g => actor.grants.includes(g)) : current;
  }
  authorize(actor, command, args) {
    assert(actor && ["owner", "agent", "system", "user-agent"].includes(actor.kind), "UNAUTHORIZED", "A trusted caller identity is required");
    if (actor.kind === "owner" || actor.kind === "system") return;
    if (actor.kind === "user-agent") return authorizeUserAgent(this, actor, command, args);
    const agent = this.store.require('agents', actor.id);
    assert(agent.status === 'available' && this.effectiveGrants(actor).includes(command), 'FORBIDDEN', `Agent is not allowed to ${command}`);
    if (actor.goalId) assertGoalOpen(this.store.get('goals', actor.goalId));
    // A caller-supplied goal must never hide the actual target task's scope.
    const goals = [args.goalId, args.id ? this.store.get('tasks', args.id)?.goalId : null].filter(Boolean);
    for (const goalId of goals) assert(goalId === actor.goalId, 'SCOPE_DENIED', 'Agent may only change its assigned goal');
  }
  command(actor, requestId, name, args = {}, options = {}) {
    assert(actor && ["owner", "agent", "system", "user-agent"].includes(actor.kind), "UNAUTHORIZED", "A trusted caller identity is required");
    const external = actor.kind === "user-agent";
    const extra = external ? { precheck: () => this.authorize(actor, name, args) } : {};
    if (options.meta === true) extra.meta = true;
    // A credential token is returned exactly once; only the redacted view is persisted for replay.
    if (name === "agentCredential.create") extra.persistResult = value => ({ credential: value?.credential ?? null, tokenOmitted: true });
    if (!external) this.authorize(actor, name, args);
    return this.store.command(actor, requestId, name, args, () => {
      const methods = {
        'project.save': () => this.saveProject(args, actor),
        'project.delete': () => deleteEntity(this, 'project', args, actor),
        'project.restore': () => restoreEntity(this, 'project', args, actor),
        'goal.edit': () => this.editGoal(args, actor),
        'goal.pause': () => controlGoal(this, args, actor, 'pause'),
        'goal.resume': () => controlGoal(this, args, actor, 'resume'),
        'goal.cancel': () => controlGoal(this, args, actor, 'cancel'),
        'goal.delete': () => deleteEntity(this, 'goal', args, actor),
        'goal.restore': () => restoreEntity(this, 'goal', args, actor),
        'agent.delete': () => deleteEntity(this, 'agent', args, actor),
        'agent.restore': () => restoreEntity(this, 'agent', args, actor),
        'goal.create': () => this.createGoal(args, actor),
        'goal.createWithProject': () => this.createGoal({ ...args.goal, projectId: this.saveProject(args.project, actor).id }, actor),
        'goal.propose': () => this.store.put('proposals', { id: id('proposal'), title: text(args.title, 'title'), description: args.description ?? '', status: 'proposed' }),
        'task.create': () => this.createTask(args, actor),
        'task.edit': () => this.editTask(args, actor),
        'task.dependencies': () => this.dependencies(args, actor),
        'task.pause': () => this.controlTask(args, 'paused', actor),
        'task.cancel': () => this.controlTask(args, 'cancelled', actor),
        'task.delete': () => this.deleteTask(args, actor),
        'task.restore': () => this.restoreTask(args, actor),
        'task.purge': () => this.purgeTask(args, actor),
        'task.resume': () => this.resumeTask(args, actor),
        'task.retry': () => this.resumeTask(args, actor, true),
        'agent.save': () => this.saveAgent(args, actor),
        'workflow.publish': () => this.publishWorkflow(args, actor),
        'review.request': () => this.reviewRequest(args, actor),
        'policy.update': () => this.updatePolicy(args, actor),
        'company.pause': () => this.setPaused(true, actor, args.afterCurrent === true),
        'company.resume': () => this.setPaused(false, actor),
        'interaction.answer': () => this.answer(args, actor),
        'model.preferences.set': () => this.setModelPreferences(args, actor),
        'model.preferences.clear': () => this.clearModelPreferences(args, actor),
        "goal.submit": () => submitGoal(this, args, actor, { internalRequestId: requestId, externalKey: options.externalKey, transport: options.transport }),
        "project.create": () => createExternalProject(this, args, actor),
        "agentCredential.create": () => createCredentialRecord(this, args, actor),
        "agentCredential.updateScope": () => updateCredentialScope(this, args, actor),
        "agentCredential.revoke": () => revokeCredential(this, args, actor),
        'task.reconcile': () => this.reconcile(args, actor),
      };
      assert(methods[name], 'UNKNOWN_COMMAND', `Unknown command ${name}`);
      const result = methods[name]();
      if (name.startsWith('task.')) {
        const goalId = result?.goalId ?? args.goalId;
        if (goalId) this.refreshGoal(goalId, actor);
      }
      return result;
    }, extra);
  }
  owner(actor) { assert(actor.kind === 'owner' || actor.kind === 'system', 'OWNER_REQUIRED', 'Only the owner may change this boundary'); }
  updatePolicy(args, actor) {
    this.owner(actor); const p = this.policy();
    const allowed = ['maxConcurrent', 'controlSlots', 'maxTasksPerGoal', 'maxTemporaryAgents', 'maxAttempts', 'maxReworks', 'turnTimeoutMs', 'maxGoalRuntimeMs', 'goalTimeBoxMs', 'timeBoxReserveMs', 'maxArtifactBytes', 'allowedProviders', 'allowedModels', 'allowedProjectRoots'];
    const patch = {}; for (const k of Object.keys(args.patch ?? {})) { assert(allowed.includes(k), 'INVALID_INPUT', `Unknown policy field ${k}`); patch[k] = args.patch[k]; }
    const next = { ...p, ...patch };
    integer(next.maxConcurrent, 'maxConcurrent', 1, 32); integer(next.controlSlots, 'controlSlots', 0, next.maxConcurrent);
    for (const k of ['maxTasksPerGoal', 'maxTemporaryAgents', 'maxAttempts', 'maxReworks']) integer(next[k], k, 1, 1000);
    for (const k of ['turnTimeoutMs', 'maxGoalRuntimeMs', 'maxArtifactBytes']) integer(next[k], k, 1000, 2147483647);
    for (const k of ['goalTimeBoxMs', 'timeBoxReserveMs']) integer(next[k] ?? 0, k, 0, 2147483647);
    for (const k of ['allowedProviders', 'allowedModels', 'allowedProjectRoots']) assert(Array.isArray(next[k]) && next[k].every(x => typeof x === 'string' && x.length > 0), 'INVALID_INPUT', `${k} must be strings`);
    assert(next.maxConcurrent >= executionOccupancy(this.store).used, 'ACTIVE_LIMIT', 'Pause active work before reducing the limit below current usage');
    const result = this.store.put('policy', next, args.expectedRevision);
    this.store.event('policy.changed', p.id, { before: p, after: result }, actor); return result;
  }
  setPaused(paused, actor, afterCurrent = false) {
    this.owner(actor); const p = this.store.put('policy', { ...this.policy(), paused, pauseMode: paused ? afterCurrent ? 'after-current' : 'immediate' : null });
    if (paused && !afterCurrent) for (const task of this.store.list('tasks')) if (['running', 'reviewing', 'integrating'].includes(task.status)) this.controlTask({ id: task.id }, 'paused', actor);
    this.store.event(paused ? 'company.paused' : 'company.resumed', p.id, {}, actor); return p;
  }
  saveProject(args, actor) { this.owner(actor); return this.saveProjectRecord(args, actor); }
  saveProjectRecord(args, actor, extra = {}) {
    const previous = args.id ? this.store.get("projects", args.id) : null;
    assert(previous?.status !== 'deleted', 'ENTITY_DELETED', '请先恢复项目');
    if (previous && ['repoRoot', 'mode'].some(k => args[k] !== undefined && args[k] !== previous[k])) assert(!this.store.list('tasks').some(t => t.projectId === previous.id), 'PROJECT_IN_USE', '已有任务的项目保留原工作目录与副本方式；请为新目录另建项目。');
    const checks = args.checks ?? previous?.checks ?? [];
    assert(Array.isArray(checks) && checks.length <= 20, 'INVALID_INPUT', 'At most 20 checks are allowed');
    for (const c of checks) {
      text(c.id, 'check.id', 100); text(c.command, 'check.command', 4096);
      assert(Array.isArray(c.args) && c.args.every(v => typeof v === 'string'), 'INVALID_INPUT', 'Check arguments must be an array');
      assert(c.inputs === undefined || (Array.isArray(c.inputs) && c.inputs.length <= 40 &&
        c.inputs.every(file => typeof file === 'string' && file.trim() && file.length <= 4096 && !file.includes('\0'))),
      'INVALID_INPUT', 'Check inputs must be an array of file paths');
      assert(c.requiredPackages === undefined || (Array.isArray(c.requiredPackages) && c.requiredPackages.length <= 20 &&
        c.requiredPackages.every(value => typeof value === 'string' && packageName.test(value))), 'INVALID_INPUT', 'requiredPackages must contain valid Node package names');
    }
    const preparation = args.preparation === undefined ? previous?.preparation ?? null : normalizePreparation(args.preparation);
    const project = this.store.put("projects", { ...previous, id: previous?.id ?? id("project"), name: text(args.name ?? previous?.name, "name", 200), repoRoot: text(args.repoRoot ?? previous?.repoRoot, "repoRoot", 4096), mode: args.mode ?? previous?.mode ?? "git", checks, preparation, autoMerge: args.autoMerge ?? previous?.autoMerge ?? false, ...(extra.source ? { source: extra.source } : {}) }, args.expectedRevision);
    assert(['git', 'copy'].includes(project.mode), 'INVALID_INPUT', 'Project mode must be git or copy');
    if (previous) recordChange(this, 'project', previous, project, ['name', 'repoRoot', 'mode', 'checks', 'preparation', 'autoMerge'], actor);
    this.store.event('project.saved', project.id, { created: !previous }, actor); return project;
  }
  editGoal(args, actor) {
    this.owner(actor); const previous = this.store.require('goals', args.id);
    assert(previous.status !== 'deleted', 'ENTITY_DELETED', '请先恢复目标');
    const patch = { ...args.patch }; assert(Object.keys(patch).every(k => ['title', 'description', 'acceptance', 'priority'].includes(k)), 'INVALID_INPUT', '只能编辑目标标题、说明、验收标准和优先级');
    for (const [k, v] of Object.entries(patch)) patch[k] = k === 'priority' ? integer(v, 'priority', 0, 100) : text(v, k, k === 'title' ? 300 : 20000);
    const changed = Object.keys(patch).filter(key => patch[key] !== previous[key]);
    assert(args.expectedRevision === undefined || args.expectedRevision === previous.revision, 'CONFLICT', '记录已变化，请刷新后重试', { collection: 'goals', id: previous.id });
    if (!changed.length) return previous;
    const substantive = changed.some(key => !['title', 'priority'].includes(key));
    if (substantive) {
      assertGoalOpen(previous);
      assert(!previous.legacyBatch && !['archived', 'cancelled'].includes(previous.status), 'GOAL_CLOSED', '此目标无法更新合同');
      const used = goalTaskCount(this.store.list('tasks'), previous.id);
      const limit = this.policy().maxTasksPerGoal;
      assert(used < limit, 'TASK_LIMIT', `合同变更未保存。${goalContractCapacityMessage(used, limit)}`, { used, limit });
    }
    const version = contractVersion(previous);
    let goal = this.store.put('goals', {
      ...previous, ...patch,
      ...(substantive ? {
        status: 'active', contractVersion: version + 1,
        completedContractVersion: previous.completedContractVersion ?? (previous.status === 'succeeded' ? version : null),
        completedDeliveryHash: previous.completedDeliveryHash ?? (previous.status === 'succeeded' ? goalDeliveryHash(previous, deliveredWork(this.store, previous)) : null),
        contractChange: { fromVersion: version, status: 'pending', coordinationTaskId: null,
          previous: { description: previous.description, acceptance: previous.acceptance } },
      } : {}),
    }, args.expectedRevision);
    if (substantive) {
      const tasks = this.store.list('tasks').filter(task => task.goalId === goal.id && !task.legacyBatch && !task.workflowSnapshot &&
        (!TERMINAL.has(task.status) || (task.status === 'failed' && task.kind !== 'review')));
      for (const task of tasks) {
        const obsolete = task.kind === 'review' || task.origin?.kind === 'goal-contract' || task.reviewTaskId;
        if (obsolete) {
          const current = this.store.require('tasks', task.id);
          if (!TERMINAL.has(current.status)) this.controlTask({ id: current.id, reason: '目标合同已更新' }, 'cancelled', SYSTEM);
          this.store.put('tasks', { ...this.store.require('tasks', task.id), contractObsolete: true });
          continue;
        }
        const current = this.store.require('tasks', task.id);
        const restarted = restartForChange(this, current);
        this.store.put('tasks', { ...restarted, goalContractVersion: version + 1,
          ...(current.kind === 'plan' ? { description: goal.description, acceptance: goal.acceptance } :
            (current.usesGoalAcceptance ?? current.acceptance === previous.acceptance) ? { acceptance: goal.acceptance } : {}),
        });
      }
      goal = this.ensureGoalContractCoordination(goal);
      this.store.event('goal.contract.changed', goal.id, { fromVersion: version, contractVersion: version + 1,
        coordinationTaskId: goal.contractChange.coordinationTaskId, fields: changed }, actor);
    }
    recordChange(this, 'goal', previous, goal, substantive ? [...changed, 'contractVersion'] : changed, actor);
    return goal;
  }
  ensureGoalContractCoordination(goal) {
    if (goalStopped(goal) || goal.contractChange?.status !== 'pending' || goal.contractChange.coordinationTaskId || ['deleted', 'archived'].includes(goal.status)) return goal;
    if (goalTaskCount(this.store.list('tasks'), goal.id) >= this.policy().maxTasksPerGoal) return goal;
    const manager = findManager(this, goal.id);
    const task = this.createTask({
      goalId: goal.id, kind: 'coordination', title: `确认目标合同 v${contractVersion(goal)}`,
      description: '核对旧交付和依赖是否适用于新的目标要求。沿用有依据的成果，为受影响的范围安排必要后续工作。',
      acceptance: '逐项记录旧交付可沿用或需补做的依据，保留历史证据与用户审查配置。',
      agentId: canCoordinate(this, manager) ? manager.id : null, priority: 100,
      origin: { kind: 'goal-contract', createdBy: 'scheduler', basis: '目标要求或验收发生变化' },
      coordinationKey: `goal-contract:${goal.id}:${contractVersion(goal)}`,
    }, SYSTEM);
    return this.store.put('goals', { ...goal, contractChange: { ...goal.contractChange, coordinationTaskId: task.id } });
  }
  createGoal(args, actor) { this.owner(actor); return this.createGoalRecord(args, actor); }
  createGoalRecord(args, actor, options = {}) {
    assert(this.store.require("projects", args.projectId).status !== "deleted", "ENTITY_DELETED", "请先恢复项目");
    const template = this.store.require('templates', args.templateId ?? args.workflowId ?? 'base');
    const constraints = options.constraints ?? [];
    const goal = this.store.put("goals", { id: id("goal"), title: text(args.title, "title", 300), description: text(args.description, "description"), acceptance: text(args.acceptance, "acceptance"), projectId: args.projectId, templateId: template.id, templateSnapshot: clone(template), status: args.plan === false ? "active" : "planning", contractVersion: 1, runtimeMs: 0, priority: integer(args.priority ?? 50, "priority", 0, 100), ...(options.source ? { source: options.source } : {}), ...(constraints.length ? { constraints } : {}) });
    if (args.plan !== false) { const manager = this.store.list('agents').find(a => a.role === 'manager' && a.status === 'available' && !a.goalId); assert(manager, 'MANAGER_REQUIRED', '请先创建可分配的管理角色'); this.createTask({ goalId: goal.id, title: `规划：${goal.title}`, description: goal.description, kind: 'plan', agentId: manager.id, acceptance: goal.acceptance, requiresArtifacts: false }, SYSTEM); }
    this.store.event('goal.created', goal.id, {}, actor); return goal;
  }
  createTask(args, actor = SYSTEM, options = {}) {
    const goal = this.store.require('goals', args.goalId);
    assertGoalOpen(goal);
    assert(!goal.legacyBatch, 'LEGACY_GOAL', '该目标已按旧阶段制数据归档，请恢复或新建目标后再派工');
    const kind = args.kind ?? 'work';
    // A review may still be requested after delivery; it is evidence, not a
    // reopened work item, so it does not resurrect a closed goal.
    const reviewRecovery = kind === 'coordination' && args.coordinationOf && this.store.get('tasks', args.coordinationOf);
    const evidenceTask = kind === 'review' || (goal.status === 'succeeded' && reviewRecovery?.kind === 'review' && reviewRecovery.goalId === goal.id);
    assert(!['succeeded', 'cancelled', 'archived', 'deleted'].includes(goal.status) ||
      (actor.kind === 'system' && evidenceTask), 'GOAL_CLOSED', 'Goal is closed');
    assert(this.store.require('projects', goal.projectId).status !== 'deleted', 'ENTITY_DELETED', '请先恢复项目');
    const p = this.policy();
    assert(goalTaskCount(this.store.list('tasks'), goal.id) < p.maxTasksPerGoal, 'TASK_LIMIT', 'Goal task limit reached');
    assert(['work', 'plan', 'repair', 'review', 'coordination'].includes(kind), 'INVALID_INPUT', 'Invalid task kind');
    assert(actor.kind === 'system' || kind === 'work', 'SYSTEM_TASK', 'Internal task kinds are created by the engine');
    if (actor.kind !== 'system' && !options.trustedOrigin) for (const key of ['workflowSnapshot', 'stageIndex', 'reviewOf', 'reviewArtifactHash', 'reviewedTaskGeneration', 'reviewedContractVersion', 'reviewScope', 'reviewTargets', 'deliveryHash', 'requestedBy', 'origin', 'coordinationOf', 'coordinationKey', 'reviewTaskId', 'reviewRound', 'feedbackHash']) assert(args[key] === undefined, 'SYSTEM_FIELD', `Internal task field cannot be supplied: ${key}`);
    integer(args.priority ?? 50, 'priority', 0, 100);
    const deps = [...new Set(args.dependencies ?? [])];
    for (const dep of deps) assert(this.store.require('tasks', dep).goalId === goal.id && this.store.require('tasks', dep).status !== 'deleted', 'SCOPE_DENIED', 'Dependencies must belong to the same goal and not be deleted');
    if (args.parentId) assert(this.store.require('tasks', args.parentId).goalId === goal.id && this.store.require('tasks', args.parentId).status !== 'deleted', 'SCOPE_DENIED', 'Parent must belong to the same goal and not be deleted');
    let agentId = args.agentId;
    if (!agentId && ['work', 'repair'].includes(kind)) agentId = this.temporaryAgent(goal.id).id;
    if (agentId) assert(this.store.require('agents', agentId).status === 'available', 'AGENT_RETIRED', '请为任务选择可分配的执行人员');
    const task = this.store.put('tasks', {
      id: id('task'), goalId: goal.id, projectId: goal.projectId, title: text(args.title, 'title', 300), description: text(args.description ?? args.title, 'description'),
      acceptance: text(args.acceptance ?? goal.acceptance, 'acceptance'), kind, agentId, dependencies: deps, parentId: args.parentId ?? null,
      reviewOf: args.reviewOf ?? null, reviewArtifactHash: args.reviewArtifactHash ?? null, status: deps.length ? 'blocked' : 'ready',
      reviewScope: args.reviewScope ?? null, reviewTargets: args.reviewTargets ?? null, deliveryHash: args.deliveryHash ?? null, requestedBy: args.requestedBy ?? null,
      goalContractVersion: contractVersion(goal), usesGoalAcceptance: args.acceptance === undefined,
      ...(kind === 'review' ? { reviewedTaskGeneration: args.reviewedTaskGeneration ?? null,
        reviewedContractVersion: args.reviewedContractVersion ?? contractVersion(goal) } : {}),
      generation: 1, attempts: 0, reworks: 0, priority: args.priority ?? 50,
      longLived: args.longLived ?? false, requiresArtifacts: ['work', 'repair'].includes(kind),
      requirements: kind === 'review' ? { ...normalizeRequirements(args.requirements), isolation: 'independent-review' } : normalizeRequirements(args.requirements),
      origin: args.origin ?? null, coordinationOf: args.coordinationOf ?? null, coordinationKey: args.coordinationKey ?? null, reviewTaskId: args.reviewTaskId ?? null, reviewRound: args.reviewRound ?? null, feedbackHash: args.feedbackHash ?? null,
      artifactIds: [], stopRequested: null, checksSnapshot: kind === 'work' ? clone(this.store.require('projects', goal.projectId).checks) : [],
      checkIds: kind === 'work' ? this.store.require('projects', goal.projectId).checks.map(c => c.id) : [],
    });
    this.store.event('task.created', task.id, { goalId: goal.id, kind, title: task.title, ...(task.origin ? { origin: task.origin } : {}), ...(task.coordinationKey ? { coordinationKey: task.coordinationKey } : {}) }, actor); return task;
  }
  temporaryAgent(goalId, role = 'worker') {
    const p = this.policy(); assert(this.store.list('agents').filter(a => a.temporary && a.status === 'available').length < p.maxTemporaryAgents, 'AGENT_LIMIT', 'Temporary agent limit reached');
    return this.store.put('agents', { id: id('agent'), name: role === 'reviewer' ? '临时审查员' : '任务执行员', role, provider: 'auto', model: '', goalId, temporary: true, status: 'available', grants: GRANTS[role] ?? [], description: '' });
  }
  invalidateInteractions(taskId, reason) {
    for (const interaction of this.store.list('interactions')) if (interaction.taskId === taskId && interaction.status === 'pending') this.store.put('interactions', { ...interaction, status: 'cancelled', reason });
  }
  releaseTemporaryAgent(agentId, actor = SYSTEM) {
    const agent = this.store.get('agents', agentId); if (!agent?.temporary || agent.status !== 'available') return;
    const held = this.store.list('tasks').some(t => t.agentId === agentId && (t.longLived || !['succeeded', 'cancelled', 'archived'].includes(t.status)));
    const active = this.store.list('attempts').some(a => a.agentId === agentId && (['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending));
    if (held || active) return;
    this.store.put('agents', { ...agent, status: 'retired' }); this.store.event('agent.released', agent.id, { reason: '没有待执行任务或活动执行' }, actor);
  }
  refreshGoal(goalId, actor = SYSTEM) {
    const goal = this.store.require('goals', goalId);
    if (goalStopped(goal) || ['archived', 'deleted'].includes(goal.status) || goal.legacyBatch) return goal;
    const tasks = this.store.list('tasks').filter(t => t.goalId === goalId && t.kind !== 'review' && t.status !== 'deleted' && !t.legacyBatch && !t.workflowSnapshot && !t.contractObsolete);
    const complete = tasks.some(t => t.kind === 'work') && tasks.every(taskSettledForGoal);
    let status;
    if (goal.contractChange?.status === 'pending') status = 'active';
    else if (!tasks.length) status = 'empty';
    else if (!complete) status = tasks.some(t => t.kind === 'plan' && !TERMINAL.has(t.status)) ? 'planning' : 'active';
    else {
      const template = goal.templateSnapshot ?? this.store.get('templates', goal.templateId ?? 'base');
      if (!template?.finalReview) status = 'succeeded';
      else {
        const deliveryHash = this.deliveryHash(goalId);
        const review = this.latestGoalReview(goalId);
        if (!review || review.deliveryHash !== deliveryHash) {
          if (!review || TERMINAL.has(review.status)) this.createGoalReview(goal, deliveryHash);
          status = 'active';
        } else status = review.status === 'succeeded' && review.passed === true ? 'succeeded' : 'active';
      }
    }
    if (status === goal.status) return goal;
    const completed = status === 'succeeded' ? { completedContractVersion: contractVersion(goal), completedDeliveryHash: this.deliveryHash(goalId) } : {};
    const saved = this.store.put('goals', { ...goal, status, ...completed });
    const delivered = status === 'succeeded' ? deliveredWork(this.store, goal) : [];
    const reviewCandidate = status === 'succeeded' ? this.latestGoalReview(goalId) : null;
    // Only a passed review bound to this exact delivery is evidence for the
    // completion event; an older/cancelled review must not be relabelled.
    const finalReview = reviewCandidate && reviewCandidate.status === 'succeeded' && reviewCandidate.passed === true &&
      reviewCandidate.deliveryHash === saved.completedDeliveryHash ? reviewCandidate : null;
    this.store.event(status === 'succeeded' ? 'goal.succeeded' : 'goal.status.changed', goalId, {
      from: goal.status, status,
      ...(status === 'succeeded' ? {
        contractVersion: saved.completedContractVersion, deliveryHash: saved.completedDeliveryHash,
        delivery: delivered.map(task => ({
          id: task.id, title: task.title, artifactHash: task.artifactHash ?? null,
          artifactIds: task.artifactIds ?? [], generation: deliveryGeneration(task), contractVersion: taskContractVersion(task),
        })),
        ...(finalReview ? { review: { taskId: finalReview.id, passed: finalReview.passed === true, deliveryHash: finalReview.deliveryHash ?? null } } : {}),
      } : {}),
    }, actor);
    return saved;
  }
  deliveryHash(goalId) {
    const goal = this.store.require('goals', goalId);
    return goalDeliveryHash(goal, deliveredWork(this.store, goal));
  }
  latestGoalReview(goalId) {
    const goal = this.store.require('goals', goalId);
    return this.store.list('tasks').filter(t => t.goalId === goalId && t.kind === 'review' && t.reviewScope === 'goal' &&
      t.status !== 'deleted' && taskContractVersion(t) === contractVersion(goal)).at(-1) ?? null;
  }
  reviewerFor(goalId, excluded = []) {
    const skip = new Set((Array.isArray(excluded) ? excluded : [excluded]).filter(Boolean));
    return this.store.list('agents').find(a => a.role === 'reviewer' && a.status === 'available' && !skip.has(a.id)) ?? this.temporaryAgent(goalId, 'reviewer');
  }
  createGoalReview(goal, deliveryHash) {
    const targets = deliveredWork(this.store, goal);
    // A reviewer must not have authored any reviewed deliverable.
    const reviewer = this.reviewerFor(goal.id, targets.map(t => t.lastAuthorId));
    const review = this.createTask({
      goalId: goal.id, kind: 'review', title: `最终审查：${goal.title}`,
      description: '按目标模板对目标整体交付成果做一次最终审查。只核对交付物、自动检查结果和验收标准，不评价工作过程。',
      acceptance: goal.acceptance, agentId: reviewer.id, requiresArtifacts: false,
      reviewScope: 'goal', deliveryHash,
      reviewTargets: targets.map(t => ({ id: t.id, title: t.title, artifactHash: t.artifactHash, artifactIds: t.artifactIds ?? [], deliveryGeneration: deliveryGeneration(t), goalContractVersion: taskContractVersion(t) })),
      origin: { kind: 'template', decidedBy: null, createdBy: 'scheduler', basis: '目标模板最终审查' },
    }, SYSTEM);
    this.store.event('review.queued', review.id, { goalId: goal.id, scope: 'goal', reviewerId: reviewer.id, deliveryHash, targets: targets.map(t => t.id) }, SYSTEM);
    return review;
  }
  reviewRequest(args, actor) {
    this.owner(actor);
    if (args.scope === 'goal' || args.goalId) {
      const goalId = args.goalId ?? args.id;
      const goal = this.store.require('goals', goalId);
      assertGoalOpen(goal);
      assert(!goal.legacyBatch, 'LEGACY_TASK', '旧目标已备份隔离，不能添加审查');
      assert(goal.status !== 'deleted', 'ENTITY_DELETED', '目标已删除');
      assert(goal.contractChange?.status !== 'pending', 'CONTRACT_PENDING', '请先确认当前目标合同');
      const deliveryHash = this.deliveryHash(goal.id);
      const active = this.store.list('tasks').find(task => task.kind === 'review' && task.reviewScope === 'goal' && task.goalId === goal.id && task.deliveryHash === deliveryHash && task.status !== 'deleted' && !TERMINAL.has(task.status));
      if (active) {
        this.store.event('review.request.reused', active.id, { goalId: goal.id, deliveryHash, requestedBy: actor.id ?? actor.kind }, actor, { goalId: goal.id });
        return active;
      }
      const targets = deliveredWork(this.store, goal);
      assert(targets.length > 0, 'NO_DELIVERABLE', '目标还没有已交付成果，不能发起最终审查');
      const review = this.createGoalReview(goal, deliveryHash);
      this.store.event('review.requested', review.id, { goalId: goal.id, scope: 'goal', deliveryHash, reviewerId: review.agentId }, actor, { goalId: goal.id });
      return review;
    }
    const source = this.store.require('tasks', args.id);
    assertGoalOpen(this.store.require('goals', source.goalId));
    assert(source.kind !== 'review', 'INVALID_INPUT', '审查任务不能再添加审查');
    assert(!source.legacyBatch, 'LEGACY_TASK', '旧任务已备份隔离，不能添加审查');
    assert(source.status === 'succeeded', 'TASK_NOT_DELIVERED', '只能对已交付（已完成）的任务添加审查');
    const active = this.store.list('tasks').find(task => task.kind === 'review' && task.reviewOf === source.id && matchesTaskReview(task, source) && task.status !== 'deleted' && !TERMINAL.has(task.status));
    if (active) {
      this.store.event('review.request.reused', active.id, { sourceTaskId: source.id, artifactHash: source.artifactHash, requestedBy: actor.id ?? actor.kind }, actor, { goalId: source.goalId });
      return active;
    }
    const reviewer = this.reviewerFor(source.goalId, source.lastAuthorId);    const review = this.createTask({
      goalId: source.goalId, kind: 'review', title: `审查：${source.title}`,
      description: '审查已交付成果。只核对交付物、自动检查结果和验收标准，不评价工作过程。',
      acceptance: source.acceptance, parentId: source.id, reviewOf: source.id,
      reviewArtifactHash: source.artifactHash, reviewedTaskGeneration: deliveryGeneration(source), reviewedContractVersion: taskContractVersion(source), agentId: reviewer.id, requiresArtifacts: false,
      reviewScope: 'task', origin: { kind: 'owner-review-request', decidedBy: null, createdBy: actor.kind, basis: '用户添加审查' },
    }, SYSTEM, { trustedOrigin: true });
    this.store.event('review.requested', review.id, { sourceTaskId: source.id, artifactHash: source.artifactHash, reviewerId: reviewer.id }, actor, { goalId: source.goalId });
    return review;
  }
  editTask(args, actor) {
    const task = this.store.require('tasks', args.id); assert(task.kind !== 'review', 'SYSTEM_TASK', '审查任务使用执行任务的固定验收合同，请编辑对应执行任务');
    assertGoalOpen(this.store.require('goals', task.goalId));
    if (TERMINAL.has(task.status)) this.owner(actor);
    const patch = args.patch ?? {}; const allowed = ['title', 'description', 'acceptance', 'priority', 'agentId', 'longLived', 'requirements'];
    assert(Object.keys(patch).every(k => allowed.includes(k)), 'INVALID_INPUT', 'Task state cannot be set directly');
    if (patch.agentId !== undefined) { text(patch.agentId, 'agentId'); assert(this.store.require('agents', patch.agentId).status === 'available', 'AGENT_RETIRED', '请为任务选择可分配的执行人员'); }
    if (patch.priority !== undefined) integer(patch.priority, 'priority', 0, 100);
    if (patch.requirements !== undefined) patch.requirements = normalizeRequirements(patch.requirements);
    for (const k of ['title', 'description', 'acceptance']) if (patch[k] !== undefined) text(patch[k], k);
    assert(args.expectedRevision === undefined || args.expectedRevision === task.revision, 'CONFLICT', '记录已变化，请刷新后重试');
    if (!Object.keys(patch).some(k => patch[k] !== task[k])) return task;
    assert(actor.kind !== 'agent' || !this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending'),
      'WAITING_INPUT', '请先处理待回复的问题');
    let saved = restartForChange(this, task, { direct: true });
    saved = this.store.put('tasks', { ...saved, ...patch, goalContractVersion: contractVersion(this.store.require('goals', task.goalId)),
      ...(patch.acceptance !== undefined ? { usesGoalAcceptance: false } : {}), ...(task.status === 'blocked' ? { status: 'ready', blocker: null } : {}) });
    this.invalidateInteractions(task.id, '任务约定已更新，旧问题失效');
    recordChange(this, 'task', task, saved, Object.keys(patch), actor);
    if (patch.agentId && patch.agentId !== task.agentId) this.releaseTemporaryAgent(task.agentId, actor);
    this.store.event('task.changed', task.id, { fields: Object.keys(patch) }, actor); return saved;
  }
  dependencies(args, actor) {
    const task = this.store.require('tasks', args.id); assert(['ready', 'blocked', 'paused'].includes(task.status), 'TASK_ACTIVE', 'Dependencies cannot change during execution');
    assert(Array.isArray(args.dependencies), 'INVALID_INPUT', 'dependencies must be an array');
    const deps = [...new Set(args.dependencies)]; const visit = (dep, seen = new Set()) => {
      assert(dep !== task.id, 'DEPENDENCY_CYCLE', 'Task dependencies contain a cycle'); if (seen.has(dep)) return; seen.add(dep);
      const other = this.store.require('tasks', dep); assert(other.goalId === task.goalId && other.status !== 'deleted', 'SCOPE_DENIED', 'Dependencies must belong to the same goal and not be deleted');
      for (const next of other.dependencies) visit(next, seen);
    }; deps.forEach(d => visit(d));
    const saved = this.store.put('tasks', { ...task, dependencies: deps }, args.expectedRevision);
    this.store.event('task.dependencies', task.id, { dependencies: deps }, actor); return saved;
  }
  controlTask(args, target, actor, { cascade = true, goalPauseId = null } = {}) {
    const task = this.store.require('tasks', args.id); assert(!TERMINAL.has(task.status), 'TASK_CLOSED', 'Task is already closed');
    if (task.stopRequested === 'cancelled' && target === 'paused') return task;
    const pending = this.store.list('attempts').filter(a => a.taskId === task.id && (['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending));
    const active = pending.length > 0 || !!task.activeIntegrationId;
    const reconciling = task.status === 'reconciling' || pending.some(a => a.status === 'reconciling' || a.cleanupUncertain);
    const cancellation = target === 'cancelled' ? { cancelledAt: now(), cancelledBy: actor?.kind === 'owner' ? 'owner' : actor?.id ?? 'system', cancelReason: typeof args.reason === 'string' ? args.reason : null } : {};
    const saved = this.store.put('tasks', { ...task, status: active ? (reconciling ? 'reconciling' : 'stopping') : target, resumeStatus: task.status,
      stopRequested: active ? target : null, recoveryRequested: active, goalPauseId, ...cancellation }, args.expectedRevision);
    if (target === 'cancelled') discardDeferredResult(this.store, task.activeAttemptId);
    if (target === 'cancelled') this.invalidateInteractions(task.id, '任务已取消');
    if (cascade) for (const child of this.store.list('tasks')) if (child.reviewOf === task.id && !TERMINAL.has(child.status)) this.controlTask({ id: child.id }, target, actor);
    this.store.event(`task.${target}.requested`, task.id, args.reason ? { reason: args.reason } : {}, actor);
    if (target === 'cancelled') this.releaseTemporaryAgent(task.agentId, actor);
    return saved;
  }
  deleteTask(args, actor) {
    this.owner(actor); const task = this.store.require('tasks', args.id);
    assert(task.status !== 'deleted', 'TASK_DELETED', '任务已经在回收站中');
    const tasks = this.store.list('tasks'); const reason = taskDeletionReason(task, tasks, this.store.list('attempts'));
    assert(!reason, 'DELETE_BLOCKED', reason);
    const group = tasks.filter(t => t.id === task.id || (t.reviewOf === task.id && t.status !== 'deleted'));
    for (const item of group) {
      this.store.put('tasks', { ...item, status: 'deleted', deletion: { batchId: task.id, previousStatus: item.status, at: new Date().toISOString() }, stopRequested: null }, item.id === task.id ? args.expectedRevision : undefined);
      for (const interaction of this.store.list('interactions').filter(i => i.taskId === item.id && i.status === 'pending')) this.store.put('interactions', { ...interaction, status: 'cancelled', reason: '关联任务已删除' });
    }
    this.store.event('task.deleted', task.id, { taskIds: group.map(t => t.id) }, actor);
    return this.store.require('tasks', task.id);
  }
  purgeTask(args, actor) {
    this.owner(actor); const task = this.store.require('tasks', args.id);
    assert(args.confirmTitle === task.title, 'CONFIRM_PURGE', '请输入任务标题确认彻底删除');
    const tasks = this.store.list('tasks'); const reason = taskPurgeReason(task, tasks, this.store.list('attempts'));
    assert(!reason, 'PURGE_BLOCKED', reason);
    const ids = new Set(tasks.filter(t => t.deletion?.batchId === task.id).map(t => t.id));
    this.store.remove('tasks', task.id, args.expectedRevision);
    for (const id of ids) if (id !== task.id) this.store.remove('tasks', id);
    for (const collection of ['attempts', 'integrations', 'artifacts', 'verifications', 'interactions', 'actionBatches', 'plans', 'deferredResults']) for (const item of this.store.list(collection)) if (ids.has(item.taskId)) this.store.remove(collection, item.id);
    // Audit IDs remain, but cached task bodies must not be returned after a purge.
    for (const row of this.store.db.prepare('SELECT id,result FROM commands').all()) {
      const value = JSON.parse(row.result);
      if (value && (ids.has(value.id) || ids.has(value.taskId))) this.store.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify({ id: value.id, purged: true }), row.id);
    }
    this.store.event('task.purged', task.id, { taskIds: [...ids] }, actor);
    for (const agentId of new Set(tasks.filter(t => ids.has(t.id)).map(t => t.agentId))) this.releaseTemporaryAgent(agentId, actor);
    return { id: task.id, goalId: task.goalId, purged: true };
  }
  restoreTask(args, actor) {
    this.owner(actor); const task = this.store.require('tasks', args.id);
    assert(task.status === 'deleted' && task.deletion?.batchId === task.id, 'INVALID_TRANSITION', '请从回收站恢复对应的执行任务');
    assert(this.store.require('goals', task.goalId).status !== 'deleted' && this.store.require('projects', task.projectId).status !== 'deleted', 'RESTORE_BLOCKED', '请先恢复所属项目和目标');
    const group = this.store.list('tasks').filter(t => t.status === 'deleted' && t.deletion?.batchId === task.id);
    const ids = new Set(group.map(t => t.id));
    for (const item of group) for (const related of [...item.dependencies, ...(item.parentId ? [item.parentId] : [])]) assert(ids.has(related) || this.store.require('tasks', related).status !== 'deleted', 'RESTORE_BLOCKED', '请先恢复此任务的前置任务或父任务');
    for (const item of group) {
      const old = item.deletion.previousStatus;
      discardDeferredResult(this.store, item.activeAttemptId);
      this.store.put('tasks', { ...item, status: ['succeeded', 'cancelled', 'archived'].includes(old) ? old : 'paused', deletion: null, stopRequested: null, activeAttemptId: null, goalPauseId: null }, item.id === task.id ? args.expectedRevision : undefined);
    }
    this.store.event('task.restored', task.id, { taskIds: group.map(t => t.id) }, actor); return this.store.require('tasks', task.id);
  }
  resumeTask(args, actor, retry = false) {
    const task = this.store.require('tasks', args.id);
    assertGoalOpen(this.store.require('goals', task.goalId));
    assert(!task.contractObsolete && matchesGoalContract(this.store.require('goals', task.goalId), task),
      'STALE_RESULT', '任务属于旧目标合同，请在当前合同下安排后续工作');
    assert(actor.kind !== 'agent' || task.status !== 'paused', 'OWNER_REQUIRED', '仅用户可恢复主动暂停的任务');
    assert(['paused', 'blocked', ...(retry ? ['failed'] : [])].includes(task.status), 'INVALID_TRANSITION', 'Task cannot resume in its current state');
    assert(!this.store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending'), 'WAITING_INPUT', 'Answer the pending interaction first');
    if (task.environmentBlock) {
      const saved = this.store.put('tasks', { ...task, status: 'ready', stopRequested: null }, args.expectedRevision);
      this.store.event('task.environment.recheck.requested', task.id, {}, actor);
      return saved;
    }
    const integrationPending = task.integrationPending ?? (task.resumeStatus === 'integrating' || (task.blocker?.kind === 'integration' && !!task.artifactHash));
    for (const review of this.store.list('tasks')) if (!integrationPending && review.reviewOf === task.id && !TERMINAL.has(review.status)) this.controlTask({ id: review.id }, 'cancelled', actor);
    const saved = this.store.put('tasks', { ...task, status: 'ready', integrationPending, stopRequested: null, ...(retry ? { attempts: 0 } : {}) }, args.expectedRevision);
    this.store.event('task.resumed', task.id, {}, actor); return saved;
  }
  saveAgent(args, actor) {
    const previous = args.id ? this.store.require('agents', args.id) : null; const role = args.role ?? previous?.role ?? 'worker';
    assert(previous?.status !== 'deleted', 'ENTITY_DELETED', '请先恢复角色');
    assert(['manager', 'worker', 'reviewer'].includes(role), 'INVALID_INPUT', 'Unsupported role');
    const p = this.policy(); const provider = args.provider ?? previous?.provider ?? 'auto'; const model = args.model ?? previous?.model ?? '';
    const llmProvider = args.llmProvider ?? previous?.llmProvider ?? '';
    assert(typeof llmProvider === 'string' && llmProvider.length <= 200, 'INVALID_INPUT', 'Invalid model route');
    const reasoningEffort = args.reasoningEffort ?? previous?.reasoningEffort ?? '';
    assert(typeof reasoningEffort === 'string' && reasoningEffort.length <= 80, 'INVALID_INPUT', 'Invalid reasoning effort');
    assert(provider === 'auto' || !p.allowedProviders.length || p.allowedProviders.includes(provider), 'PROVIDER_DENIED', 'Provider exceeds company policy');
    assert(!model || !p.allowedModels.length || p.allowedModels.includes(model), 'MODEL_DENIED', 'Model exceeds company policy');
    const effective = actor.kind === 'agent' ? this.effectiveGrants(actor) : null;
    const grants = args.grants ?? (previous?.role === role ? previous.grants : effective ? GRANTS[role].filter(g => effective.includes(g)) : GRANTS[role]);
    assert(Array.isArray(grants) && grants.every(g => (GRANTS[role] ?? []).includes(g)), 'GRANT_DENIED', 'Grant exceeds role ceiling');
    if (actor.kind === 'agent') {
      assert(!previous || previous.id !== actor.id, 'SELF_MODIFICATION', 'Manager cannot change its own grants');
      assert(grants.every(g => effective.includes(g)) && (!previous || previous.grants.every(g => effective.includes(g))), 'GRANT_DENIED', '不能授予或修改超出当前有效授权的角色权限');
      assert(!previous?.goalId || previous.goalId === actor.goalId, 'SCOPE_DENIED', '不能修改其他目标的执行人员');
    }
    assert(['available', 'retired'].includes(args.status ?? previous?.status ?? 'available'), 'INVALID_INPUT', 'Unsupported agent status');
    if ((args.temporary ?? previous?.temporary) && (args.status ?? previous?.status ?? 'available') !== 'retired' && (!previous?.temporary || previous.status === 'retired')) assert(this.store.list('agents').filter(a => a.temporary && a.status === 'available').length < p.maxTemporaryAgents, 'AGENT_LIMIT', 'Temporary agent limit reached');
    const saved = this.store.put('agents', { ...previous, id: previous?.id ?? id('agent'), name: text(args.name ?? previous?.name, 'name', 200), description: args.description ?? previous?.description ?? '', role, provider, model, llmProvider, reasoningEffort, grants, temporary: args.temporary ?? previous?.temporary ?? false, status: args.status ?? previous?.status ?? 'available' }, args.expectedRevision);
    if (actor.kind === 'agent' && !previous) this.store.put('agents', { ...saved, goalId: actor.goalId });
    if (previous) recordChange(this, 'agent', previous, saved, ['name', 'description', 'role', 'provider', 'model', 'reasoningEffort', 'temporary'], actor);
    this.store.event('agent.saved', saved.id, { created: !previous }, actor); return this.store.require('agents', saved.id);
  }
  publishWorkflow(args, actor) {
    // A template describes how a whole goal is implemented. It is an owner
    // boundary: the person who chooses the review policy must not have it
    // silently changed by the manager agent.
    this.owner(actor);
    const previous = args.id ? this.store.get('templates', args.id) : null;
    const phases = args.phases ?? previous?.phases;
    assert(Array.isArray(phases) && phases.length >= 1 && phases.length <= 6, 'INVALID_INPUT', 'Template needs 1–6 phases');
    assert(phases.every(p => p && PHASE_IDS.has(p.id)), 'INVALID_INPUT', 'Phase must be plan, execute or final-review');
    assert(new Set(phases.map(p => p.id)).size === phases.length, 'INVALID_INPUT', 'Phase IDs must be unique');
    assert(phases.some(p => p.id === 'execute'), 'INVALID_INPUT', 'Template must contain an execute phase');
    const normalized = phases.map(p => ({ id: p.id, name: text(p.name ?? p.id, 'phase.name', 100) }));
    const next = { id: previous?.id ?? id('template'), name: text(args.name ?? previous?.name, 'name', 200), phases: clone(normalized), version: (previous?.version ?? 0) + 1, finalReview: normalized.some(p => p.id === 'final-review'), published: true };
    if (previous) this.store.put('templateHistory', { ...previous, id: `${previous.id}:${previous.version}` });
    const saved = this.store.put('templates', next, args.expectedRevision);
    this.store.event('template.published', saved.id, { version: saved.version, phases: saved.phases, finalReview: saved.finalReview, reason: args.reason ?? '' }, actor);
    return saved;
  }
  answer(args, actor) {
    if (actor.kind === "user-agent") assertUserAgentAnswer(this, args, actor); else this.owner(actor);
    const interaction = this.store.require("interactions", args.id); assert(interaction.status === "pending", "ALREADY_ANSWERED", "Interaction already answered");
    const task = this.store.require('tasks', interaction.taskId);
    assert(['blocked', 'paused'].includes(task.status) && !task.stopRequested && (interaction.taskGeneration ?? task.generation) === task.generation, 'INTERACTION_STALE', '此问题已失效，不能通过历史回复重新启动任务');
    const additionalRuntimeMs = integer(args.additionalRuntimeMs ?? 0, 'additionalRuntimeMs', 0, 2147483647);
    assert(interaction.kind === 'budget' || additionalRuntimeMs === 0, 'INVALID_INPUT', '只有目标时间额度问题可以追加执行额度');
    if (interaction.kind === 'budget') {
      const goal = this.store.require('goals', task.goalId), policy = this.policy();
      const used = goalRuntimeSpent(goal, this.store.list('attempts')), limit = goalRuntimeLimit(goal, policy);
      assert(additionalRuntimeMs > 0 || used < limit, 'GOAL_BUDGET_EXHAUSTED', '目标累计执行额度仍已用完。请填写追加额度，或先增加公司目标基础额度；修改单次执行时限或仅回复“继续”不能解除此阻塞。');
      if (additionalRuntimeMs) {
        const nextLimit = integer(Math.max(used, limit) + additionalRuntimeMs, 'goalRuntimeLimit', 1000, 2147483647);
        this.store.put('goals', { ...goal, runtimeExtraMs: nextLimit - policy.maxGoalRuntimeMs, timeBox: null });
        this.store.event('goal.runtime.extended', goal.id, { interactionId: interaction.id, additionalRuntimeMs, previousLimitMs: limit, nextLimitMs: nextLimit, usedMs: used }, actor);
      }
    }
    const saved = this.store.put('interactions', { ...interaction, status: 'answered', answer: text(args.answer, 'answer'), ...(additionalRuntimeMs ? { additionalRuntimeMs } : {}) }, args.expectedRevision);
    this.store.put('tasks', { ...task, status: task.status === 'paused' ? 'paused' : 'ready', lastAnswer: saved.answer, integrationPending: task.integrationPending ?? (interaction.kind === 'integration' && !!task.artifactHash), blocker: null, attempts: 0, retryAt: null });
    if (interaction.kind === 'budget') this.releaseBudgetWaits(task.goalId, saved.id, actor);
    this.store.event('interaction.answered', interaction.id, { taskId: task.id }, actor); return saved;
  }
  releaseBudgetWaits(goalId, interactionId, actor) {
    for (const task of this.store.list('tasks')) {
      if (task.goalId !== goalId || task.blocker?.kind !== 'budget' || !['blocked', 'paused'].includes(task.status) || task.stopRequested) continue;
      const pending = this.store.list('interactions').filter(i => i.taskId === task.id && i.status === 'pending');
      if (pending.some(i => i.kind !== 'budget' || (i.taskGeneration ?? task.generation) !== task.generation)) continue;
      for (const wait of pending) this.store.put('interactions', { ...wait, status: 'cancelled', reason: '目标累计执行额度已恢复，额度等待自动解除', resolvedBy: interactionId });
      const ready = task.dependencies.every(id => { const dependency = this.store.require('tasks', id); return dependency.status === 'succeeded'; });
      this.store.put('tasks', { ...task, status: task.status === 'paused' ? 'paused' : ready ? 'ready' : 'blocked', blocker: null, attempts: 0, retryAt: null });
      this.store.event('task.budget.released', task.id, { interactionId }, actor);
    }
  }
  reconcile(args, actor) {
    this.owner(actor);
    const task = this.store.require('tasks', args.id); assert(canReconcileTask(task, this.store.list('attempts')), 'INVALID_TRANSITION', 'Task is not awaiting reconciliation');
    // An operator checkbox cannot certify process ownership or recover a result.
    // Ask the engine for another read; it alone applies a matching clean receipt.
    const result = this.store.put('tasks', { ...task, recoveryRequested: true });
    this.store.event('task.recovery.requested', task.id, {}, actor); return result;
  }
  setModelPreferences(args, actor) {
    this.owner(actor);
    const previous = this.store.get("modelPreferences", "model");
    const order = normalizePreferenceOrder(args.order);
    const saved = this.store.put("modelPreferences", { id: "model", order, updatedBy: { kind: actor.kind, id: actor.id } }, args.expectedRevision);
    this.store.event("model.preferences.changed", "model", { before: sanitizePreferences(previous), after: sanitizePreferences(saved) }, actor);
    return sanitizePreferences(saved);
  }
  clearModelPreferences(args, actor) {
    this.owner(actor);
    const previous = this.store.get("modelPreferences", "model");
    const saved = this.store.put("modelPreferences", { id: "model", order: [], updatedBy: { kind: actor.kind, id: actor.id } }, args.expectedRevision);
    this.store.event("model.preferences.changed", "model", { before: sanitizePreferences(previous), after: sanitizePreferences(saved), cleared: true }, actor);
    return sanitizePreferences(saved);
  }
  snapshot() {
    const collections = ["projects", "goals", "tasks", "agents", "templates", "templateHistory", "workflows", "workflowHistory", "attempts", "artifacts", "verifications", "interactions", "proposals", "changes", "notifications", "plans", "actionBatches", "agentCredentials"];
    const data = Object.fromEntries(collections.map(c => [c, this.store.list(c)]));
    data.entityTrash = ['project', 'goal', 'agent'].flatMap(kind => data[`${kind}s`].filter(e => e.status === 'deleted' && e.deletion?.rootId === e.id).map(e => ({ ...e, entityKind: kind })));
    for (const c of ['projects', 'goals', 'agents']) data[c] = data[c].filter(e => e.status !== 'deleted');
    const deleted = new Set(data.tasks.filter(t => t.status === 'deleted').map(t => t.id));
    data.trash = data.tasks.filter(t => t.status === 'deleted' && t.deletion?.batchId === t.id).map(t => ({ ...t, purgeReason: taskPurgeReason(t, data.tasks, data.attempts) }));
    data.tasks = data.tasks.filter(t => !deleted.has(t.id));
    for (const c of ['attempts', 'artifacts', 'verifications', 'interactions']) data[c] = data[c].filter(item => !deleted.has(item.taskId));
    // Presentation-only activity projection for issue #17. Parents inherit the
    // newest effective descendant activity; unknown history falls back to the
    // record's own creation time instead of inventing a new timestamp.
    const activity = this.store.activity();
    const latest = (...values) => values.filter(Boolean).reduce((max, value) => (!max || String(value) > String(max) ? value : max), null);
    const ownActivity = entity => latest(activity.get(entity.id), entity.createdAt);
    // A branch's newest descendant activity belongs to its ancestors too, with
    // cycle protection for malformed parent/review links.
    const children = new Map();
    for (const task of data.tasks) { const parent = task.reviewOf || task.parentId || null; if (parent) children.set(parent, [...(children.get(parent) ?? []), task]); }
    const memo = new Map();
    const effectiveTaskActivity = (task, stack = new Set()) => {
      if (memo.has(task.id)) return memo.get(task.id);
      if (stack.has(task.id)) return ownActivity(task);
      stack.add(task.id);
      let value = ownActivity(task);
      for (const child of children.get(task.id) ?? []) value = latest(value, effectiveTaskActivity(child, stack));
      stack.delete(task.id); memo.set(task.id, value); return value;
    };
    data.tasks = data.tasks.map(task => ({ ...task, activityAt: effectiveTaskActivity(task) }));
    // Review state is bound to the current delivery: historical reviews for an
    // older artifact/delivery must never override the current version, and a
    // later edit (e.g. cancelling an old review) must not reorder it.
    const reviewTasks = data.tasks.filter(task => task.kind === 'review');
    const byCreationDesc = (a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0) || (b.revision ?? 0) - (a.revision ?? 0) || String(b.id).localeCompare(String(a.id));
    const representative = reviews => reviews.slice().sort(byCreationDesc)[0] ?? null;
    const deliveryHashes = new Map(data.goals.map(goal => [goal.id, this.deliveryHash(goal.id)]));
    const reviewSummary = review => review ? ({ id: review.id, status: review.status, passed: review.passed ?? null, reviewScope: review.reviewScope ?? null, createdAt: review.createdAt, updatedAt: review.updatedAt, cancelledAt: review.cancelledAt ?? null, cancelledBy: review.cancelledBy ?? null, cancelReason: review.cancelReason ?? null, deliveryHash: review.deliveryHash ?? null, artifactHash: review.reviewArtifactHash ?? null, goalContractVersion: taskContractVersion(review), reviewedContractVersion: review.reviewedContractVersion ?? 1 }) : null;
    data.tasks = data.tasks.map(task => {
      const current = reviewTasks.filter(review => review.reviewOf === task.id && matchesTaskReview(review, task));
      return { ...task, reviewSummary: reviewSummary(representative(current)) };
    });
    const goalActivity = new Map(data.goals.map(goal => [goal.id, data.tasks.filter(task => task.goalId === goal.id).reduce((max, task) => latest(max, task.activityAt), ownActivity(goal))]));
    data.goals = data.goals.map(g => {
      const reviews = reviewTasks.filter(review => review.reviewScope === 'goal' && review.goalId === g.id);
      const current = reviews.filter(review => review.deliveryHash === deliveryHashes.get(g.id));
      return { ...g, contractVersion: contractVersion(g), completedContractVersion: g.completedContractVersion ?? (g.status === 'succeeded' ? contractVersion(g) : null),
        controlSummary: goalControlView(g, data.tasks, data.attempts),
        deliveryHash: deliveryHashes.get(g.id), taskSummary: goalSummary(g, data.tasks), activityAt: latest(ownActivity(g), goalActivity.get(g.id)), reviewSummary: reviewSummary(representative(current)), reviewHistory: reviews.slice().sort(byCreationDesc).slice(0, 12).map(reviewSummary) };
    });
    data.projects = data.projects.map(p => ({ ...p, activityAt: latest(ownActivity(p), ...data.goals.filter(g => g.projectId === p.id).map(g => g.activityAt)) }));
    data.modelPreferences = sanitizePreferences(this.store.get("modelPreferences", "model"));
    data.agentCredentials = data.agentCredentials.map(credentialSnapshot);
    return { ...data, policy: this.policy(), cursor: this.store.cursor() };
    return { ...data, policy: this.policy(), cursor: this.store.cursor(), agentCredentials: data.agentCredentials.map(credentialSnapshot) };
  }
}
