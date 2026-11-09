import { reworkDetails } from "./rework.js";
import { completeGoalContract } from "./goal-contract.js";
import { assert, digest, now, SYSTEM } from "./util.js";
import { blockerCoordinationKey, ignoresBlocker } from "./blocker-policy.js";

export const CAPACITY_LIMIT_CODES = new Set(["TASK_LIMIT", "AGENT_LIMIT"]);

// Capacity limits are owner boundaries, not scheduler errors. If a coordination
// task cannot be created, the caller must keep the attempt's terminal state and
// ask the owner directly instead of rolling the failure transaction back.
function capacityBlock(engine, task, kind, reason, question, context) {
  return engine.blockForOwner(task, kind, reason, context + "；目标任务数已达到上限，请缩小范围或提高“每个目标任务上限”后恢复此分支。" + (question ? " 原问题：" + question : ""));
}

export function reviewCoordinationKey(reviewId) { return "review:" + reviewId; }
export function timeBoxCoordinationKey(goalId, boxMs) { return `timebox:${goalId}:${boxMs}`; }

/**
 * Manager finished the time-box wrap-up decision. Ordinary dispatch may resume
 * for this goal; the hard runtime cap is untouched. Missing/no-op for any other
 * coordination keeps the helper safe to call unconditionally.
 */
export function releaseTimeBox(store, coordination, actor = SYSTEM) {
  const goal = coordination?.goalId ? store.get("goals", coordination.goalId) : null;
  if (!goal?.timeBox || goal.timeBox.releasedAt) return goal;
  if (goal.timeBox.coordinationTaskId && goal.timeBox.coordinationTaskId !== coordination.id) return goal;
  if (goal.timeBox.key && coordination.coordinationKey && goal.timeBox.key !== coordination.coordinationKey) return goal;
  const saved = store.put("goals", { ...goal, timeBox: { ...goal.timeBox, releasedAt: now(), releasedBy: actor?.id ?? actor?.kind ?? "system" } });
  store.event("goal.timebox.released", goal.id, { coordinationTaskId: coordination.id, releasedBy: actor?.id ?? null }, actor ?? SYSTEM, { goalId: goal.id });
  return saved;
}
export function executorCoordinationKey(taskId, generation, reasonCode) { return "executor:" + taskId + ":g" + generation + ":" + reasonCode; }
export function feedbackHashOf(output) { return digest({ summary: output?.summary ?? "", findings: Array.isArray(output?.findings) ? output.findings : [], ...(output?.rework ? { rework: output.rework } : {}) }); }

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
  assert(task.agentId === agent.id && agent.status === "available", "FORBIDDEN", "Coordinator is no longer available");
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
  if (ignoresBlocker(current) || current.status === "paused") return current;
  const dependencies = [...new Set([...(current.dependencies ?? []), coordination.id])];
  const blocker = { kind: "coordination", reason: "等待负责人协调：" + (coordination.title ?? coordination.id), resolutionTaskIds: [coordination.id] };
  return store.put("tasks", { ...current, status: "blocked", integrationPending: current.integrationPending || current.status === "integrating", dependencies, blocker });
}

export function releaseSource(store, coordination, options = {}) {
  const source = store.get("tasks", coordination.coordinationOf);
  if (!source || ignoresBlocker(source)) return source;
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
  // Older records lack the checkpoint flag. Only infer it from an integration
  // handoff for this generation; a contract edit explicitly clears the flag.
  const legacyIntegration = coordination.origin?.blockerKind === "integration" &&
    !!coordination.coordinationKey?.startsWith(executorCoordinationKey(source.id, source.generation, "")) &&
    !!source.artifactHash;
  const integrationPending = !options.reviseDeliverable && (source.integrationPending ?? legacyIntegration);
  if (reworkTasks.length) {
    const dependencies = [...new Set([...(source.dependencies ?? []), ...reworkTasks])];
    return store.put("tasks", { ...source, status: paused ? "paused" : "blocked", integrationPending, dependencies, blocker: { kind: "coordination", reason: "负责人已拆分返工任务，等待其完成", resolutionTaskIds: reworkTasks } });
  }
  const ready = source.dependencies.every(id => store.get("tasks", id)?.status === "succeeded");
  return store.put("tasks", { ...source, status: paused ? "paused" : ready ? "ready" : "blocked", integrationPending, blocker: null, attempts: 0, retryAt: null });
}

export function releaseCoordinatedSource(engine, coordination, options = {}) {
  const before = engine.store.get("tasks", coordination.coordinationOf);
  const released = releaseSource(engine.store, coordination, options);
  if (released && released.revision !== before?.revision) {
    engine.store.event("coordination.applied", coordination.id, {
      sourceTaskId: released.id, status: released.status, dependencies: released.dependencies,
      next: released.integrationPending ? "integration" : "execution", blocker: released.blocker,
    }, SYSTEM, { goalId: released.goalId });
  }
  if (released && released.status === "blocked" && released.blocker?.kind === "reworks" && !engine.store.list("interactions").some(i => i.taskId === released.id && i.status === "pending")) {
    engine.block(released, "reworks", released.blocker.reason, "审查返工次数已达上限。请回复追加的返工额度或调整范围后恢复任务。");
    return engine.store.require("tasks", released.id);
  }
  return released;
}

export function scheduleRepairFlow(engine, task, reason, evidence) {
  const { company, store } = engine;
  return store.transaction(() => {
    const current = store.require("tasks", task.id);
    if (task.generation !== current.generation || ignoresBlocker(current) || current.status === "paused") return current;
    task = current;
    // A coordination task is the bounded management entry point. If it cannot
    // complete, stop automation instead of repairing or coordinating it again.
    if (task.kind === "coordination") return engine.block(task, "technical", reason, "协调任务自身无法完成；已停止自动修复与协调递归，请负责人或 owner 直接处理该分支后恢复。");
    if ((task.repairs ?? 0) >= company.policy().maxReworks) {
      return coordinateBlocker(engine, task, { kind: "repair_limit", reason, evidence,
        key: executorCoordinationKey(task.id, task.generation, "repair-limit") });
    }
    const repair = company.createTask({ goalId: task.goalId, kind: "repair", title: "解阻：" + task.title, description: "诊断并解决以下技术阻塞。输出可应用的修复文件或修复说明，原任务会自动读取交付物后继续。\n问题：" + reason + "\n原任务：" + task.description, acceptance: "给出可验证的故障原因和具体修复交付物；交付成果可由用户按需添加审查。", parentId: task.id, checkIds: [], origin: { kind: "scheduler", decidedBy: null, createdBy: "scheduler", basis: "自动解阻" } }, SYSTEM);
    store.put("tasks", { ...repair, repairOf: task.id });
    store.put("tasks", { ...task, status: "blocked", attempts: 0, repairs: (task.repairs ?? 0) + 1, dependencies: [...task.dependencies, repair.id], blocker: { kind: "technical", reason, resolutionTaskIds: [repair.id] } });
    store.event("repair.queued", repair.id, { taskId: task.id, reason }, SYSTEM);
    return repair;
  });
}

export function coordinateExecutionLimit(engine, task, reason, evidence) {
  return coordinateBlocker(engine, task, { kind: "execution_limit", reason, evidence,
    key: executorCoordinationKey(task.id, task.generation, "execution-limit") });
}

// Keep one live handoff per source generation. At most two handoffs may be
// dispatched for that generation, and each completed fact is handled once.
export function coordinateBlocker(engine, task, { kind, reason, question = "", evidence = null, key }) {
  const { company, store } = engine;
  return store.transaction(() => {
    const current = store.require("tasks", task.id);
    if (task.generation !== current.generation || ignoresBlocker(current)) return current;
    if (current.kind === "coordination" || current.status === "paused") return engine.blockForOwner(current, kind, reason, question);
    if (store.list("interactions").some(i => i.taskId === current.id && i.status === "pending")) return current;
    const prefix = executorCoordinationKey(current.id, current.generation, "");
    const baseKey = key ?? blockerCoordinationKey(current, kind);
    const fact = { kind, reason, evidence };
    const hash = digest(fact);
    const prior = store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === current.id &&
      t.coordinationKey?.startsWith(prefix));
    const open = prior.find(t => ["ready", "running", "blocked", "paused"].includes(t.status));
    const description = [
      "自动阻塞接管。请在现有授权内确定最小恢复动作；保留原任务和有效证据。",
      "阻塞：" + kind + "，" + reason,
      "事实：" + JSON.stringify(evidence),
      "原任务：" + current.description,
    ].join("\n").slice(0, 15000);
    if (open) {
      if (open.feedbackHash !== hash) {
        store.put("tasks", { ...open, description, feedbackHash: hash, blockerEvidence: fact,
          origin: { ...open.origin, blockerKind: kind, basis: reason } });
        store.event("blocker.coordinated", current.id, { blockerKind: kind, route: "manager", coordinationTaskId: open.id, reason, evidence, reused: true, updated: true }, SYSTEM, { goalId: current.goalId });
      }
      if (current.blocker?.resolutionTaskIds?.includes(open.id) && current.status === "blocked") return current;
      return holdSourceForCoordination(store, current, open);
    }
    const legacyHash = key ? digest({ reason }) : digest({ kind, reason });
    if (prior.length >= 2 || prior.some(t => t.feedbackHash === hash ||
        (t.coordinationKey === baseKey && t.feedbackHash === legacyHash) || t.status !== "succeeded")) {
      return engine.blockForOwner(current, kind, reason, "此异常已由负责人处理过，或自动协调额度已用完；请核对条件后再恢复。" + (question ? " 原问题：" + question : ""));
    }
    const manager = findManager(company, current.goalId);
    if (!canCoordinate(company, manager)) {
      return engine.blockForOwner(current, "assignment", "没有具备协调授权的负责人来处理该阻塞：" + reason, "请确认当前目标负责人拥有 task.create 与 task.retry 授权后恢复任务。");
    }
    let coordination;
    try {
      coordination = createCoordination(company, current, {
        manager, key: prior.some(t => t.coordinationKey === baseKey) ? baseKey + ":2" : baseKey,
        feedbackHash: hash, reason, blockerKind: kind, title: "协调解阻：" + current.title, description,
      });
    } catch (error) {
      if (!CAPACITY_LIMIT_CODES.has(error.code)) throw error;
      return capacityBlock(engine, current, kind, reason, question, "自动阻塞接管无法创建负责人协调任务");
    }
    coordination = store.put("tasks", { ...coordination, blockerEvidence: fact });
    store.event("blocker.coordinated", current.id, { blockerKind: kind, route: "manager", coordinationTaskId: coordination.id, reason, evidence }, SYSTEM, { goalId: current.goalId });
    return holdSourceForCoordination(store, current, coordination);
  });
}

export function completeCoordination(engine, task, attempt, output) {
  const { company, store } = engine;
  return store.transaction(() => {
    const current = store.require("tasks", task.id);
    coordinationAuthority(company, attempt, current);
    const source = current.coordinationOf ? store.get("tasks", current.coordinationOf) : null;
    assert(output.resume === undefined || output.resume === "work", "INVALID_RESULT", "Omit resume to keep the current checkpoint, or use work to revise the deliverable");
    const rework = reworkDetails(output.rework) ?? source?.reworkDetails ?? null;
    const actor = { kind: "agent", id: attempt.agentId, goalId: task.goalId, grants: attempt.grants };
    const contractAssessment = completeGoalContract(company, current, output, actor);
    const decision = { kind: "manager-decision", by: attempt.agentId, basis: output.summary ?? "",
      sourceTaskId: current.coordinationOf ?? null, rework, resume: output.resume ?? "checkpoint", ...(contractAssessment ? { contractAssessment } : {}) };
    engine.finishAttempt(attempt, "completed", output.summary);
    const saved = store.put("tasks", { ...current, status: "succeeded", summary: output.summary ?? "", decision });
    store.event("coordination.decided", task.id, { sourceTaskId: task.coordinationOf ?? null, decision }, actor, { goalId: task.goalId });
    if (source) releaseCoordinatedSource(engine, saved, { reviseDeliverable: output.resume === "work" });
    if (contractAssessment) company.refreshGoal(task.goalId);
    if (current.origin?.kind === "timebox") {
      releaseTimeBox(store, saved, actor);
      // The last ordinary task may have finished while this coordination was
      // still open; release is the only remaining event, so recompute delivery.
      company.refreshGoal(task.goalId);
    }
    return saved;
  });
}
