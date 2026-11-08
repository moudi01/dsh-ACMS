import { assert, digest, SYSTEM } from "./util.js";
import { blockerCoordinationKey } from "./blocker-policy.js";

const CAPACITY_LIMIT_CODES = new Set(["TASK_LIMIT", "AGENT_LIMIT"]);

// Capacity limits are owner boundaries, not scheduler errors. If a coordination
// task cannot be created, the caller must keep the attempt's terminal state and
// ask the owner directly instead of rolling the failure transaction back.
function capacityBlock(engine, task, kind, reason, question, context) {
  return engine.blockForOwner(task, kind, reason, context + "；目标任务数已达到上限，请缩小范围或提高“每个目标任务上限”后恢复此分支。" + (question ? " 原问题：" + question : ""));
}

export function reviewCoordinationKey(reviewId) { return "review:" + reviewId; }
export function executorCoordinationKey(taskId, generation, reasonCode) { return "executor:" + taskId + ":g" + generation + ":" + reasonCode; }
export function feedbackHashOf(output) { return digest({ summary: output?.summary ?? "", findings: Array.isArray(output?.findings) ? output.findings : [] }); }

function managerInScope(manager, goalId) {
  return !!manager && manager.role === "manager" && manager.status === "available" && (!manager.goalId || manager.goalId === goalId);
}

export function findManager(company, goalId) {
  const store = company.store;
  const plan = store.list("tasks").filter(t => t.goalId === goalId && (t.kind === "plan" || t.kind === "coordination") && t.agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const bound = plan ? store.get("agents", plan.agentId) : null;
  if (managerInScope(bound, goalId)) return bound;
  // A goal-scoped manager is preferred over the shared global manager. Managers
  // belonging only to another goal are never eligible for this goal.
  const scoped = store.list("agents").find(a => managerInScope(a, goalId) && a.goalId === goalId);
  if (scoped) return scoped;
  return store.list("agents").find(a => managerInScope(a, goalId) && !a.goalId) ?? null;
}

export function canCoordinate(company, manager) {
  if (!manager) return false;
  const grants = company.effectiveGrants({ id: manager.id, grants: manager.grants });
  return grants.includes("task.create") && grants.includes("task.retry");
}

// A coordination result is a manager decision. The role and the *current*
// effective permissions are checked at acceptance time so a revoked or
// reassigned actor cannot keep releasing work through a stale attempt.
export function coordinationAuthority(company, attempt, task) {
  const store = company.store;
  const agent = store.require("agents", attempt.agentId);
  assert(attempt.role === "manager" && agent.role === "manager", "FORBIDDEN", "Only a current manager can submit a coordination decision");
  assert(agent.status === "available", "FORBIDDEN", "Coordinator is no longer available");
  assert(!agent.goalId || agent.goalId === task.goalId, "SCOPE_DENIED", "Coordinator does not belong to the task goal");
  const grants = company.effectiveGrants({ id: agent.id, grants: attempt.grants });
  assert(grants.includes("task.retry"), "FORBIDDEN", "Coordinator no longer has the task.retry grant required to release the source task");
  return { agent, grants };
}

export function createCoordination(company, source, options = {}) {
  const store = company.store;
  assert(store.inTransaction, "TRANSACTION_REQUIRED", "Coordination must be created inside a transaction");
  const key = options.key;
  assert(typeof key === "string" && key.length >= 8 && key.length <= 200, "INVALID_COORDINATION_KEY", "coordinationKey must be a stable 8-200 character identifier");
  const hash = options.feedbackHash ?? null;
  const existing = store.list("tasks").find(t => t.kind === "coordination" && t.coordinationKey === key && t.status !== "deleted");
  if (existing) { assert(!hash || existing.feedbackHash === hash, "COORDINATION_CONFLICT", "协调任务幂等键已用于不同的反馈内容"); return existing; }
  assert(source.kind !== "coordination", "COORDINATION_RECURSION", "A coordination task cannot create another coordination task");
  const manager = options.manager ?? findManager(company, source.goalId);
  assert(managerInScope(manager, source.goalId), "MANAGER_REQUIRED", "需要当前目标或全局的可分配负责人来协调返工与解阻");
  const description = options.description ?? ("反馈需要负责人协调。源任务：" + source.id + "；返工/修复次数：" + (source.reworks ?? 0) + "；反馈：" + (source.feedback ?? options.reason ?? ""));
  const task = company.createTask({
    goalId: source.goalId, kind: "coordination", title: options.title ?? ("协调返工：" + source.title), description,
    acceptance: options.acceptance ?? "负责人独立核查反馈，在现有授权内决定返工、解阻、依赖与分派调整，并给出可追溯的协调结果。",
    parentId: options.parentId ?? source.id, agentId: manager.id, priority: options.priority ?? 80,
    origin: { kind: "scheduler", decidedBy: null, createdBy: "scheduler", basis: options.reason ?? "执行或审查反馈需要负责人协调", ...(options.blockerKind ? { blockerKind: options.blockerKind } : {}) },
    coordinationOf: source.id, coordinationKey: key, reviewTaskId: options.reviewTaskId ?? null,
    reviewRound: options.reviewRound ?? null, feedbackHash: hash
  }, SYSTEM);
  store.event("coordination.created", task.id, { sourceTaskId: source.id, coordinationKey: key, reviewTaskId: options.reviewTaskId ?? null, reviewRound: options.reviewRound ?? null, feedbackHash: hash, reason: options.reason ?? null, blockerKind: options.blockerKind ?? null, decision: { kind: "scheduler-action", by: "scheduler", basis: "反馈到达时由调度器创建协调入口；协调决定必须由负责人提交" } }, SYSTEM, { goalId: source.goalId });
  return task;
}

export function holdSourceForCoordination(store, source, coordination) {
  const current = store.require("tasks", source.id);
  if (["succeeded", "cancelled", "archived", "deleted"].includes(current.status)) return current;
  const dependencies = [...new Set([...(current.dependencies ?? []), coordination.id])];
  const blocker = { kind: "coordination", reason: "等待负责人协调：" + (coordination.title ?? coordination.id), resolutionTaskIds: [coordination.id] };
  return store.put("tasks", { ...current, status: "blocked", dependencies, blocker });
}

export function releaseSource(store, coordination, options = {}) {
  const source = store.get("tasks", coordination.coordinationOf);
  if (!source || ["succeeded", "cancelled", "archived", "deleted"].includes(source.status)) return source;
  if (source.blocker?.kind !== "coordination") return source;
  const ids = source.blocker.resolutionTaskIds ?? [];
  if (!ids.includes(coordination.id)) return source;
  // An owner pause is a hard gate: coordination may record the manager decision
  // and adjust dependencies, but it must never turn a paused source into work.
  const paused = source.status === "paused";
  if (source.reviewLimitExceeded && !options.allowLimitExceeded) {
    return store.put("tasks", { ...source, status: paused ? "paused" : "blocked", blocker: { kind: "reworks", reason: "审查返工次数已达上限，等待用户决定是否追加额度或调整范围" } });
  }
  const reworkTasks = options.reworkTasks ?? [];
  if (reworkTasks.length) {
    const dependencies = [...new Set([...(source.dependencies ?? []), ...reworkTasks])];
    return store.put("tasks", { ...source, status: paused ? "paused" : "blocked", dependencies, blocker: { kind: "coordination", reason: "负责人已拆分返工任务，等待其完成", resolutionTaskIds: reworkTasks } });
  }
  return store.put("tasks", { ...source, status: paused ? "paused" : "ready", blocker: null });
}

export function releaseCoordinatedSource(engine, coordination, options = {}) {
  const released = releaseSource(engine.store, coordination, options);
  if (released && released.status === "blocked" && released.blocker?.kind === "reworks" && !engine.store.list("interactions").some(i => i.taskId === released.id && i.status === "pending")) {
    engine.block(released, "reworks", released.blocker.reason, "审查返工次数已达上限。请回复追加的返工额度或调整范围后恢复任务。");
    return engine.store.require("tasks", released.id);
  }
  return released;
}

export function scheduleRepairFlow(engine, task, reason) {
  const { company, store } = engine;
  return store.transaction(() => {
    // A coordination task is the bounded management entry point. If it cannot
    // complete, stop automation instead of repairing or coordinating it again.
    if (task.kind === "coordination") return engine.block(task, "technical", reason, "协调任务自身无法完成；已停止自动修复与协调递归，请负责人或 owner 直接处理该分支后恢复。");
    if ((task.repairs ?? 0) >= company.policy().maxReworks) {
      const key = executorCoordinationKey(task.id, task.generation, "repair-limit");
      const previous = store.list("tasks").find(t => t.kind === "coordination" && t.coordinationKey === key && t.status !== "deleted");
      if (previous?.status === "succeeded") return engine.block(task, "repair_limit", reason, "自动修复与协调均已结束，请确认追加额度、调整范围或分派后再恢复此分支。");
      const manager = findManager(company, task.goalId);
      if (!canCoordinate(company, manager)) return engine.block(task, "assignment", "没有具备协调授权的负责人来处理修复上限", "请创建或恢复当前目标（或全局）负责人，并确认其拥有 task.create 与 task.retry 授权后恢复此任务。");
      const coordination = (() => {
        try { return createCoordination(company, task, { manager, key, feedbackHash: digest({ reason }), reason, title: "协调解阻：" + task.title, description: "自动修复达到上限，需要负责人决定返工范围、分派或依赖。\n问题：" + reason + "\n原任务：" + task.description }); }
        catch (error) {
          if (!CAPACITY_LIMIT_CODES.has(error.code)) throw error;
          return null;
        }
      })();
      if (!coordination) return capacityBlock(engine, task, "repair_limit", reason, "", "自动修复达到上限，但无法创建负责人协调任务");
      store.event("repair.limit", task.id, { reason, coordinationTaskId: coordination.id }, SYSTEM, { goalId: task.goalId });
      return holdSourceForCoordination(store, task, coordination);
    }
    const repair = company.createTask({ goalId: task.goalId, kind: "repair", title: "解阻：" + task.title, description: "诊断并解决以下技术阻塞。输出可应用的修复文件或修复说明，原任务会自动读取交付物后继续。\n问题：" + reason + "\n原任务：" + task.description, acceptance: "给出可验证的故障原因和具体修复交付物；交付成果可由用户按需添加审查。", parentId: task.id, checkIds: [], origin: { kind: "scheduler", decidedBy: null, createdBy: "scheduler", basis: "自动解阻" } }, SYSTEM);
    store.put("tasks", { ...repair, repairOf: task.id });
    store.put("tasks", { ...task, status: "blocked", attempts: 0, repairs: (task.repairs ?? 0) + 1, dependencies: [...task.dependencies, repair.id], blocker: { kind: "technical", reason, resolutionTaskIds: [repair.id] } });
    store.event("repair.queued", repair.id, { taskId: task.id, reason }, SYSTEM);
    return repair;
  });
}

export function coordinateExecutionLimit(engine, task, reason) {
  const { company, store } = engine;
  return store.transaction(() => {
    const key = executorCoordinationKey(task.id, task.generation, "execution-limit");
    const previous = store.list("tasks").find(t => t.kind === "coordination" && t.coordinationKey === key && t.status !== "deleted");
    if (previous?.status === "succeeded") return engine.block(task, "execution_limit", reason, "自动重试与协调均已结束，请确认调整范围或分派后再恢复此分支。");
    const manager = findManager(company, task.goalId);
    if (!canCoordinate(company, manager)) return engine.block(task, "assignment", "没有具备协调授权的负责人来处理执行上限", "请创建或恢复当前目标（或全局）负责人，并确认其拥有 task.create 与 task.retry 授权后恢复此任务。");
    const coordination = (() => {
      try { return createCoordination(company, task, { manager, key, feedbackHash: digest({ reason }), reason, title: "协调失败处理：" + task.title, description: "任务自动重试已用完，需要负责人决定返工范围、分派或依赖。\n原因：" + reason + "\n原任务：" + task.description }); }
      catch (error) {
        if (!CAPACITY_LIMIT_CODES.has(error.code)) throw error;
        return null;
      }
    })();
    if (!coordination) return capacityBlock(engine, task, "execution_limit", reason, "", "自动重试已用完，但无法创建负责人协调任务");
    store.event("execution.limit", task.id, { reason, coordinationTaskId: coordination.id }, SYSTEM, { goalId: task.goalId });
    return holdSourceForCoordination(store, task, coordination);
  });
}

/**
 * Route a recoverable blocker to the goal manager instead of asking the owner.
 * One coordination entry per (task generation, blocker kind); a repeated blocker
 * reuses the open entry, and a recurrence after the manager already decided is
 * handed back to the owner rather than looping automation.
 */
export function coordinateBlocker(engine, task, { kind, reason, question = '' }) {
  const { company, store } = engine;
  return store.transaction(() => {
    const current = store.require('tasks', task.id);
    // Pause, stop, terminal state and coordination tasks keep the previous owner path.
    if (current.kind === 'coordination' || current.stopRequested || ['paused', 'cancelled', 'archived', 'succeeded', 'deleted'].includes(current.status)) {
      return engine.blockForOwner(current, kind, reason, question);
    }
    const key = blockerCoordinationKey(current, kind);
    const coordinations = store.list('tasks').filter(t => t.kind === 'coordination' && t.coordinationOf === current.id && t.status !== 'deleted');
    const open = coordinations.find(t => !['succeeded', 'cancelled'].includes(t.status));
    if (open) {
      store.event('blocker.coordinated', current.id, { blockerKind: kind, route: 'manager', coordinationTaskId: open.id, reason, reused: true }, SYSTEM, { goalId: current.goalId });
      return holdSourceForCoordination(store, current, open);
    }
    if (coordinations.some(t => t.coordinationKey === key && t.status === 'succeeded')) {
      return engine.blockForOwner(current, kind, reason, '本代任务的同类阻塞已由负责人处理过，自动接管已停止；请确认范围、分派或权限后恢复此分支。' + (question ? ' 原问题：' + question : ''));
    }
    const manager = findManager(company, current.goalId);
    if (!canCoordinate(company, manager)) {
      return engine.blockForOwner(current, 'assignment', '没有具备协调授权的负责人来处理该阻塞：' + reason, '请创建或恢复当前目标（或全局）负责人，并确认其拥有 task.create 与 task.retry 授权后恢复此任务。' + (question ? ' 原问题：' + question : ''));
    }
    const coordination = (() => {
      try {
        return createCoordination(company, current, {
          manager, key, feedbackHash: digest({ kind, reason }), reason, blockerKind: kind,
          title: '协调解阻：' + current.title,
          description: '自动阻塞接管（' + kind + '）：负责人需在现有授权内决定重试、换分派、缩小范围或调整依赖；只有新增权限、必须由用户提供的材料、重大范围变化或真实总预算不足才升级给用户。\n阻塞原因：' + reason + '\n原任务：' + current.description
        });
      } catch (error) {
        if (!CAPACITY_LIMIT_CODES.has(error.code)) throw error;
        return null;
      }
    })();
    if (!coordination) return capacityBlock(engine, current, kind, reason, question, '自动阻塞接管无法创建负责人协调任务');
    store.event('blocker.coordinated', current.id, { blockerKind: kind, route: 'manager', coordinationTaskId: coordination.id, reason }, SYSTEM, { goalId: current.goalId });
    return holdSourceForCoordination(store, current, coordination);
  });
}

export function completeCoordination(engine, task, attempt, output) {
  const { company, store } = engine;
  return store.transaction(() => {
    const current = store.require("tasks", task.id);
    coordinationAuthority(company, attempt, current);
    const source = current.coordinationOf ? store.get("tasks", current.coordinationOf) : null;
    engine.finishAttempt(attempt, "completed", output.summary);
    const saved = store.put("tasks", { ...current, status: "succeeded", summary: output.summary ?? "", decision: { kind: "manager-decision", by: attempt.agentId, basis: output.summary ?? "", sourceTaskId: current.coordinationOf ?? null } });
    if (source) releaseCoordinatedSource(engine, saved);
    const actor = { kind: "agent", id: attempt.agentId, goalId: task.goalId, grants: attempt.grants };
    store.event("coordination.decided", task.id, { sourceTaskId: task.coordinationOf ?? null, decision: { kind: "manager-decision", by: attempt.agentId, basis: output.summary ?? "" } }, actor, { goalId: task.goalId });
    return saved;
  });
}
