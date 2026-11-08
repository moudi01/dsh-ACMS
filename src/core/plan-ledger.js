import { assert, digest, now, SYSTEM } from "./util.js";
import { coordinationAuthority, releaseCoordinatedSource, releaseTimeBox } from "./coordination.js";

function orderNodes(nodes) {
  assert(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= 30, "INVALID_PLAN", "Plan must contain 1-30 tasks");
  const keys = new Set();
  for (const node of nodes) {
    assert(node && typeof node === "object" && typeof node.key === "string" && node.key.length > 0, "INVALID_PLAN", "Each plan node needs a unique key");
    assert(!keys.has(node.key), "INVALID_PLAN", "Plan keys must be unique");
    assert(node.dependencies === undefined || Array.isArray(node.dependencies), "INVALID_PLAN", "Plan dependencies must be an array");
    for (const dep of node.dependencies ?? []) assert(typeof dep === "string", "INVALID_PLAN", "Plan dependency ids must be strings");
    keys.add(node.key);
  }
  const ordered = []; const visiting = new Set(); const visited = new Set();
  const visit = key => {
    assert(keys.has(key), "INVALID_PLAN", "Unknown dependency in plan: " + key);
    assert(!visiting.has(key), "DEPENDENCY_CYCLE", "Plan contains a cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    const node = nodes.find(n => n.key === key);
    for (const dep of node.dependencies ?? []) visit(dep);
    visiting.delete(key); visited.add(key); ordered.push(node);
  };
  keys.forEach(visit);
  return ordered;
}

function legacyDecompose(engine, task, attempt, output) {
  const { company, store } = engine;
  const ordered = orderNodes(output.tasks);
  store.transaction(() => {
    const mapped = new Map();
    for (const node of ordered) {
      const child = company.createTask({ title: node.title, description: node.description, acceptance: node.acceptance, longLived: node.longLived === true, priority: node.priority ?? 50, requirements: node.requirements, goalId: task.goalId, kind: "work", parentId: task.id, dependencies: (node.dependencies ?? []).map(k => mapped.get(k)), origin: { kind: "executor-decomposition", decidedBy: attempt.agentId, createdBy: "scheduler" } }, SYSTEM);
      mapped.set(node.key, child.id);
    }
    engine.finishAttempt(attempt, "completed", output.summary);
    if (task.kind === "plan") store.put("tasks", { ...task, status: "succeeded", summary: output.summary ?? "" });
    else store.put("tasks", { ...task, status: "blocked", dependencies: [...task.dependencies, ...mapped.values()], blocker: { kind: "children", resolutionTaskIds: [...mapped.values()] } });
    const goal = store.require("goals", task.goalId); store.put("goals", { ...goal, status: "active" });
    store.event("plan.accepted", task.id, { tasks: [...mapped.values()] }, SYSTEM, { goalId: task.goalId });
  });
}

export function acceptPlanFlow(engine, task, attempt, output) {
  const { company, store } = engine;
  assert(["planned", "decomposed"].includes(output.outcome), "INVALID_PLAN", "Planner must return a structured plan");
  const ordered = orderNodes(output.tasks);
  if (attempt.role !== "manager") { assert(task.kind !== "coordination", "FORBIDDEN", "Only a manager can decide coordination rework"); return legacyDecompose(engine, task, attempt, output); }
  const manager = store.require("agents", attempt.agentId);
  assert(manager.role === "manager", "FORBIDDEN", "Only a manager can submit a manager plan");
  const grants = company.effectiveGrants({ id: manager.id, grants: attempt.grants });
  assert(grants.includes("task.create"), "FORBIDDEN", "Manager lacks task.create");
  if (task.kind === "coordination") coordinationAuthority(company, attempt, task);
  const rationale = typeof output.rationale === "string" && output.rationale.trim() ? output.rationale.trim().slice(0, 4000) : (typeof output.summary === "string" ? output.summary.slice(0, 4000) : "");
  const rationaleSource = typeof output.rationale === "string" && output.rationale.trim() ? "explicit" : (rationale ? "summary" : "none");
  const planId = task.id + ":g" + task.generation;
  const coordination = task.kind === "coordination";
  const fingerprint = digest({ nodes: output.tasks, rationale, summary: output.summary ?? "", coordination });
  return store.transaction(() => {
    // A plan is a manager decision: re-read the actor at acceptance time so a
    // retired, reassigned or out-of-goal manager cannot land work through a stale attempt.
    const currentManager = store.require("agents", attempt.agentId);
    assert(currentManager.role === "manager", "FORBIDDEN", "Only a manager can submit a manager plan");
    assert(currentManager.status === "available", "FORBIDDEN", "Manager is no longer available to submit a plan");
    assert(!currentManager.goalId || currentManager.goalId === task.goalId, "SCOPE_DENIED", "Manager does not belong to the task goal");
    const currentGrants = company.effectiveGrants({ id: currentManager.id, grants: attempt.grants });
    assert(currentGrants.includes("task.create"), "FORBIDDEN", "Manager lacks task.create");
    if (task.kind === "coordination") coordinationAuthority(company, attempt, task);
    const previous = store.get("plans", planId);
    if (previous) {
      assert(previous.fingerprint === fingerprint, "PLAN_CONFLICT", "同一计划任务代次已接受不同计划，未覆盖既有映射");
      engine.finishAttempt(attempt, "completed", output.summary);
      return previous;
    }
    const actor = { kind: "agent", id: manager.id, goalId: task.goalId, grants: attempt.grants };
    const mapped = new Map(); const records = [];
    for (const node of ordered) {
      const assignee = node.assignee ?? null;
      assert(assignee === null || typeof assignee === "string", "INVALID_PLAN", "Plan assignee must be an agent id or null");
      if (assignee !== null) {
        const candidate = store.get("agents", assignee);
        assert(candidate && candidate.goalId === task.goalId && candidate.status === "available", "INVALID_PLAN", "计划分派对象必须是同目标可分配的执行人员");
      }
      const dependencies = (node.dependencies ?? []).map(k => mapped.get(k));
      const child = company.createTask({ title: node.title, description: node.description, acceptance: node.acceptance, longLived: node.longLived === true, priority: node.priority ?? 50, requirements: node.requirements, goalId: task.goalId, kind: "work", parentId: task.id, dependencies, ...(assignee === null ? {} : { agentId: assignee }), origin: { kind: "manager-plan", decidedBy: manager.id, createdBy: manager.id, planTaskId: task.id, planKey: node.key, assignment: assignee === null ? "scheduler-default" : "manager", assigneeAgentId: assignee, basis: rationale.slice(0, 300) } }, actor, { trustedOrigin: true });
      mapped.set(node.key, child.id);
      records.push({ key: node.key, taskId: child.id, dependencies, assigneeAgentId: child.agentId ?? null, assignment: assignee === null ? "scheduler-default" : "manager" });
    }
    engine.finishAttempt(attempt, "completed", output.summary);
    const plan = store.put("plans", { id: planId, goalId: task.goalId, taskId: task.id, generation: task.generation, attemptId: attempt.id, managerId: manager.id, coordinationOf: coordination ? task.coordinationOf : null, rationale, rationaleSource, fingerprint, nodes: records, acceptedAt: now() });
    if (coordination) {
      const reworkTasks = records.map(r => r.taskId);
      const saved = store.put("tasks", { ...store.require("tasks", task.id), status: "succeeded", summary: output.summary ?? "", decision: { kind: "manager-decision", by: manager.id, basis: rationale || output.summary || "", sourceTaskId: task.coordinationOf } });
      releaseCoordinatedSource(engine, saved, { reworkTasks });
      if (task.origin?.kind === "timebox") { releaseTimeBox(store, saved, actor); company.refreshGoal(task.goalId); }
      store.event("coordination.decided", task.id, { sourceTaskId: task.coordinationOf, planId, tasks: reworkTasks, decision: { kind: "manager-decision", by: manager.id, basis: rationale || output.summary || "" } }, actor, { goalId: task.goalId });
    } else {
      if (task.kind === "plan") store.put("tasks", { ...store.require("tasks", task.id), status: "succeeded", summary: output.summary ?? "" });
      else store.put("tasks", { ...store.require("tasks", task.id), status: "blocked", dependencies: [...task.dependencies, ...mapped.values()], blocker: { kind: "children", resolutionTaskIds: [...mapped.values()] } });
      const goal = store.require("goals", task.goalId); store.put("goals", { ...goal, status: "active" });
      store.event("plan.accepted", task.id, { planTaskId: task.id, managerAgentId: manager.id, rationale, rationaleSource, tasks: records.map(r => ({ key: r.key, taskId: r.taskId, assignment: r.assignment, assignedBy: r.assignment === "manager" ? manager.id : "scheduler" })), decision: { kind: "manager-decision", by: manager.id, basis: rationale || output.summary || "" } }, actor, { goalId: task.goalId });
    }
    return plan;
  });
}
