import { assert, digest, integer, now, SYSTEM, text } from "./util.js";
import { reworkDetails } from "./rework.js";
import { completeGoalContract, matchesGoalContract, taskContractVersion } from "./goal-contract.js";
import { coordinationAuthority, releaseCoordinatedSource, releaseTimeBox } from "./coordination.js";
import { assertGoalOpen } from './goal-control.js';
import { restartForChange } from './entity-management.js';
import { normalizeRequirements } from './model-selection.js';
import { approvalPlanId, PLAN_APPROVAL_REQUIRED, isApprovalPlanner, isCostPlanner } from './plan-approval.js';
import { assessCostPlan, costPlanHasUnscopedWork, costPlanIntent, recheckCostPlan } from './plan-cost-budget.js';

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

function managerForPlan(company, task, attempt) {
  const manager = company.store.require('agents', attempt.agentId);
  assert(attempt.role === 'manager' && manager.role === 'manager' && manager.status === 'available',
    'FORBIDDEN', '该计划的负责人已不可用，请核对分派或退回重新规划。');
  assert(!manager.goalId || manager.goalId === task.goalId, 'SCOPE_DENIED', 'Manager does not belong to the task goal');
  assert(company.effectiveGrants({ id: manager.id, grants: attempt.grants }).includes('task.create'), 'FORBIDDEN', 'Manager lacks task.create');
  return { kind: 'agent', id: manager.id, goalId: task.goalId, grants: attempt.grants };
}

function planAssignee(store, task, node) {
  const assignee = node.assignee ?? null;
  assert(assignee === null || typeof assignee === 'string', 'INVALID_PLAN', 'Plan assignee must be an agent id or null');
  if (assignee !== null) {
    const candidate = store.get('agents', assignee);
    assert(candidate && candidate.goalId === task.goalId && candidate.status === 'available', 'INVALID_PLAN', '计划分派对象必须是同目标可分配的执行人员');
  }
  return assignee;
}

function materializePlan(company, task, ordered, actor, rationale) {
  const mapped = new Map(), records = [];
  for (const node of ordered) {
    const assignee = planAssignee(company.store, task, node);
    const dependencies = (node.dependencies ?? []).map(key => mapped.get(key));
    const assignment = assignee === null ? 'scheduler-default' : 'manager';
    const child = company.createTask({ title: node.title, description: node.description, acceptance: node.acceptance,
      longLived: node.longLived === true, priority: node.priority ?? 50, requirements: node.requirements,
      goalId: task.goalId, kind: 'work', parentId: task.id, dependencies, ...(assignee === null ? {} : { agentId: assignee }),
      origin: { kind: 'manager-plan', decidedBy: actor.id, createdBy: actor.id, planTaskId: task.id, planKey: node.key,
        assignment, assigneeAgentId: assignee, basis: rationale.slice(0, 300) } }, actor, { trustedOrigin: true });
    mapped.set(node.key, child.id);
    records.push({ key: node.key, taskId: child.id, dependencies, assigneeAgentId: child.agentId ?? null, assignment });
  }
  return { mapped, records };
}

function acceptedPlanEvent(store, task, plan, actor, summary) {
  store.event('plan.accepted', task.id, { planTaskId: task.id, managerAgentId: actor.id, rationale: plan.rationale,
    rationaleSource: plan.rationaleSource, scope: plan.scope,
    tasks: plan.nodes.map(row => ({ key: row.key, taskId: row.taskId, assignment: row.assignment, assignedBy: row.assignment === 'manager' ? actor.id : 'scheduler' })),
    decision: { kind: 'manager-decision', by: actor.id, basis: plan.rationale || summary || '' },
  }, actor, { goalId: task.goalId });
}

function proposalFingerprint(plan) {
  const { taskId, generation, goalContractVersion, goalAcceptance, managerId, rationale, rationaleSource, scope, summary, proposalTasks } = plan;
  return digest({ taskId, generation, goalContractVersion, goalAcceptance, managerId, rationale, rationaleSource, scope, summary, proposalTasks,
    ...(plan.costPlan ? { costPlan: plan.costPlan } : {}) });
}

function releaseProposal(company, goal, task, plan, manager, decision = null) {
  const { store } = company;
  const cost = isCostPlanner(goal, task) ? recheckCostPlan(company, goal, plan) : null;
  // This marker and every assignment are written inside the same transaction.
  store.put('goals', { ...goal, planApproval: { ...goal.planApproval, approvedPlanId: plan.id } });
  const { records } = materializePlan(company, task, orderNodes(cost?.tasks ?? plan.proposalTasks), manager, plan.rationale);
  const fields = { approvalStatus: 'approved', nodes: records, acceptedAt: decision?.at ?? now(),
    ...(decision ? { ownerDecision: decision } : {}),
    ...(cost ? { costRelease: { kind: decision ? 'owner' : 'automatic', balance: cost.balance } } : {}) };
  store.put('tasks', { ...task, status: 'succeeded', blocker: null });
  acceptedPlanEvent(store, task, { ...plan, ...fields }, manager, plan.summary);
  return fields;
}

function proposePlan(engine, task, attempt, ordered, facts, manager, output) {
  const { store } = engine;
  const current = store.require('tasks', task.id);
  const goal = store.require('goals', task.goalId);
  assertGoalOpen(goal);
  assert(goal.planApproval.taskId === current.id && !goal.planApproval.approvedPlanId && current.generation === task.generation &&
    current.activeAttemptId === attempt.id && !current.stopRequested && !current.contractObsolete && matchesGoalContract(goal, current, attempt),
  'STALE_PLAN_APPROVAL', '此规划已过期，请等待当前目标的规划结果。');
  const proposalTasks = ordered.map(node => {
    text(node.key, 'plan task key', 200);
    const assignee = planAssignee(store, current, node);
    return { key: node.key, title: text(node.title, 'title', 300), description: text(node.description ?? node.title, 'description'),
      ...(node.acceptance === undefined ? {} : { acceptance: node.acceptance === null ? null : text(node.acceptance, 'acceptance') }),
      dependencies: [...new Set(node.dependencies ?? [])], assignee, longLived: node.longLived === true,
      priority: integer(node.priority ?? 50, 'priority', 0, 100), requirements: normalizeRequirements(node.requirements) };
  });
  const draft = { ...facts, goalAcceptance: goal.acceptance, scope: facts.scope ?? { minimumOutcome: goal.acceptance, nonGoals: [] },
    rationale: text(facts.rationale, '计划依据或取舍', 4000), nodes: [], proposalTasks, approvalStatus: 'pending', proposedAt: now() };
  const intent = isCostPlanner(goal, current) ? costPlanIntent(ordered, output) : null;
  const previous = store.get('plans', draft.id);
  if (previous) {
    const same = proposalFingerprint(draft) === proposalFingerprint({ ...previous, costPlan: null }) &&
      digest(intent) === digest(previous.costPlan?.intent ?? null);
    assert(same, 'PLAN_CONFLICT', '同一规划代次已有不同提案，请从审批中退回重新规划。');
    return previous;
  }
  if (intent) draft.costPlan = assessCostPlan(engine, goal, current, proposalTasks, intent);
  const fingerprint = proposalFingerprint(draft);
  engine.finishAttempt(attempt, 'completed', draft.summary);
  const saved = store.put('plans', { ...draft, fingerprint });
  const unscopedWork = !!draft.costPlan && costPlanHasUnscopedWork(store, goal.id);
  const blockerReason = unscopedWork ? '请先移除未纳入此提案的旧任务。' :
    draft.costPlan?.status !== 'fits' ? draft.costPlan?.reason : null;
  const waiting = store.put('tasks', { ...current, status: 'blocked', summary: draft.summary,
    blocker: { kind: 'plan-approval', planId: saved.id, reason: blockerReason ?? PLAN_APPROVAL_REQUIRED } });
  store.event('plan.approval.proposed', task.id, { planId: saved.id, generation: saved.generation,
    goalContractVersion: saved.goalContractVersion, fingerprint, taskCount: proposalTasks.length,
    ...(draft.costPlan ? { costStatus: draft.costPlan.status, minimumMicros: draft.costPlan.minimumMicros } : {}),
    decision: { kind: 'manager-proposal', by: manager.id, basis: saved.rationale || saved.summary } }, manager, { goalId: task.goalId });
  if (draft.costPlan?.status === 'fits' && !goal.planApproval.project && !goal.planApproval.template &&
      !unscopedWork) {
    const fields = releaseProposal(engine.company, goal, waiting, saved, manager);
    const released = store.put('plans', { ...saved, ...fields });
    engine.updateGoal(goal.id);
    return released;
  }
  return saved;
}

export function decidePlanApproval(company, args, actor) {
  assert(actor.kind === 'owner', 'OWNER_REQUIRED', '只有所有者可以决定计划审批。');
  const { store } = company;
  const action = args.action;
  assert(['approve', 'reject', 'revise'].includes(action), 'INVALID_INPUT', '请选择批准、拒绝或退回修改。');
  const reason = text(args.reason, '审批理由', 2000);
  const plan = store.require('plans', args.planId);
  assert(plan.approvalStatus && plan.fingerprint === args.fingerprint && plan.generation === args.generation &&
    plan.goalContractVersion === args.goalContractVersion && proposalFingerprint(plan) === plan.fingerprint,
  'STALE_PLAN_APPROVAL', '提案或版本已变化，请刷新后决定。');
  const historical = [plan.ownerDecision, plan.revisionRequest].find(decision => decision?.action === action);
  if (historical) {
    assert(historical.reason === reason, 'CONFLICT', '此版本已记录该决定及其理由。');
    return plan;
  }
  const goal = store.require('goals', plan.goalId);
  const task = store.require('tasks', plan.taskId);
  const attempt = store.require('attempts', plan.attemptId);
  assertGoalOpen(goal);
  // Entity restore clears live attempt pointers. The retained blocker and the
  // completed, cleaned attempt still identify exactly this proposal generation.
  assert(!['deleted', 'archived', 'succeeded'].includes(goal.status) && goal.contractChange?.status !== 'pending' &&
    store.require('projects', goal.projectId).status !== 'deleted' && isApprovalPlanner(goal, task) && !goal.planApproval.approvedPlanId &&
    task.generation === plan.generation && (!task.activeAttemptId || task.activeAttemptId === attempt.id) &&
    task.blocker?.kind === 'plan-approval' && task.blocker.planId === plan.id &&
    attempt.taskId === task.id && attempt.goalId === goal.id && attempt.taskGeneration === task.generation &&
    attempt.agentId === plan.managerId && matchesGoalContract(goal, task, attempt),
  'STALE_PLAN_APPROVAL', '当前目标、规划合同或规划任务已变化，请刷新提案。');
  assert(attempt.status === 'completed' && attempt.resultAccepted && !attempt.cleanupPending && !attempt.cleanupUncertain && !task.stopRequested,
    'PLAN_CLEANUP_PENDING', '请先等待规划执行和进程清理完成。');
  assert(task.status === 'blocked', 'STALE_PLAN_APPROVAL', '请先恢复规划任务，或查看目标的执行状态。');
  const reopening = action === 'revise' && plan.approvalStatus === 'rejected';
  assert(plan.approvalStatus === 'pending' || reopening, 'STALE_PLAN_APPROVAL', '此提案已作决定，请查看当前版本。');
  const decision = { kind: 'owner-decision', by: actor.id, action, reason, at: now(), fingerprint: plan.fingerprint,
    generation: plan.generation, goalContractVersion: plan.goalContractVersion };
  let fields;
  if (action === 'approve') {
    const manager = managerForPlan(company, task, attempt);
    fields = releaseProposal(company, goal, task, plan, manager, decision);
  } else if (action === 'revise') {
    const revised = restartForChange(company, task, { direct: true });
    store.put('tasks', { ...revised, status: 'ready', activeAttemptId: null, blocker: null, feedback: reason, summary: '' });
    fields = reopening ? { revisionRequest: decision } : { approvalStatus: 'returned', ownerDecision: decision };
  } else fields = { approvalStatus: 'rejected', ownerDecision: decision };
  const saved = store.put('plans', { ...plan, ...fields });
  company.refreshGoal(goal.id, actor);
  store.event('plan.approval.decided', task.id, { planId: plan.id, decision }, actor, { goalId: goal.id });
  return saved;
}

export function acceptPlanFlow(engine, task, attempt, output) {
  const { company, store } = engine;
  assert(["planned", "decomposed"].includes(output.outcome), "INVALID_PLAN", "Planner must return a structured plan");
  const ordered = orderNodes(output.tasks);
  const gated = isApprovalPlanner(store.require('goals', task.goalId), task);
  if (attempt.role !== "manager") { assert(task.kind !== "coordination" && !gated, "FORBIDDEN", "Only a manager can submit this plan"); return legacyDecompose(engine, task, attempt, output); }
  const manager = store.require("agents", attempt.agentId);
  assert(manager.role === "manager", "FORBIDDEN", "Only a manager can submit a manager plan");
  const grants = company.effectiveGrants({ id: manager.id, grants: attempt.grants });
  assert(grants.includes("task.create"), "FORBIDDEN", "Manager lacks task.create");
  if (task.kind === "coordination") coordinationAuthority(company, attempt, task);
  const rationale = typeof output.rationale === "string" && output.rationale.trim() ? output.rationale.trim().slice(0, 4000) : (typeof output.summary === "string" ? output.summary.slice(0, 4000) : "");
  const rationaleSource = typeof output.rationale === "string" && output.rationale.trim() ? "explicit" : (rationale ? "summary" : "none");
  const planId = approvalPlanId(task);
  const coordination = task.kind === "coordination";
  const scope = output.minimumOutcome === undefined && output.nonGoals === undefined ? null : {
    minimumOutcome: text(output.minimumOutcome, "minimumOutcome", 4000),
    nonGoals: output.nonGoals,
  };
  if (scope) {
    assert(Array.isArray(scope.nonGoals) && scope.nonGoals.length <= 30, "INVALID_PLAN", "nonGoals must list work excluded from this plan");
    scope.nonGoals = scope.nonGoals.map(item => text(item, "nonGoals item", 500));
    if (ordered.length > 1 || coordination) text(output.rationale, "reason for additional tasks", 4000);
  }
  assert(output.resume === undefined || (coordination && output.resume === "work"), "INVALID_PLAN", "Only coordination may request author revision");
  const rework = coordination ? reworkDetails(output.rework) : null;
  const fingerprint = digest({ nodes: output.tasks, rationale, summary: output.summary ?? "", coordination,
    ...(scope ? { scope } : {}), ...(rework ? { rework } : {}), ...(output.resume ? { resume: output.resume } : {}),
    ...(task.origin?.kind === "goal-contract" ? { contractAssessment: output.contractAssessment ?? null } : {}) });
  return store.transaction(() => {
    // A plan is a manager decision: re-read the actor at acceptance time so a
    // retired, reassigned or out-of-goal manager cannot land work through a stale attempt.
    const actor = managerForPlan(company, task, attempt);
    if (task.kind === "coordination") coordinationAuthority(company, attempt, task);
    const facts = { id: planId, goalId: task.goalId, taskId: task.id, generation: task.generation, goalContractVersion: taskContractVersion(task),
      attemptId: attempt.id, managerId: manager.id, coordinationOf: coordination ? task.coordinationOf : null, rationale, rationaleSource, scope, rework };
    if (gated) return proposePlan(engine, task, attempt, ordered, { ...facts,
      summary: typeof output.summary === 'string' ? output.summary.slice(0, 4000) : '' }, actor, output);
    const previous = store.get("plans", planId);
    if (previous) {
      assert(previous.fingerprint === fingerprint, "PLAN_CONFLICT", "同一计划任务代次已接受不同计划，未覆盖既有映射");
      engine.finishAttempt(attempt, "completed", output.summary);
      return previous;
    }
    if (coordination) {
      const goal = store.require("goals", task.goalId);
      if (goal.status === "succeeded") store.put("goals", { ...goal, status: "active" });
    }
    const { mapped, records } = materializePlan(company, task, ordered, actor, rationale);
    engine.finishAttempt(attempt, "completed", output.summary);
    const plan = store.put("plans", { ...facts, fingerprint, nodes: records, acceptedAt: now() });
    if (coordination) {
      const reworkTasks = records.map(r => r.taskId);
      const source = store.get("tasks", task.coordinationOf);
      const contractAssessment = completeGoalContract(company, task, output, actor, mapped);
      const decision = { kind: "manager-decision", by: manager.id, basis: rationale || output.summary || "",
        sourceTaskId: task.coordinationOf, rework: rework ?? source?.reworkDetails ?? null, resume: output.resume ?? "checkpoint", ...(contractAssessment ? { contractAssessment } : {}) };
      const saved = store.put("tasks", { ...store.require("tasks", task.id), status: "succeeded", summary: output.summary ?? "", decision });
      store.event("coordination.decided", task.id, { sourceTaskId: task.coordinationOf, planId, tasks: reworkTasks, decision }, actor, { goalId: task.goalId });
      releaseCoordinatedSource(engine, saved, { reworkTasks, reviseDeliverable: output.resume === "work" });
      if (contractAssessment) company.refreshGoal(task.goalId);
      if (task.origin?.kind === "timebox") { releaseTimeBox(store, saved, actor); company.refreshGoal(task.goalId); }
    } else {
      if (task.kind === "plan") store.put("tasks", { ...store.require("tasks", task.id), status: "succeeded", summary: output.summary ?? "" });
      else store.put("tasks", { ...store.require("tasks", task.id), status: "blocked", dependencies: [...task.dependencies, ...mapped.values()], blocker: { kind: "children", resolutionTaskIds: [...mapped.values()] } });
      const goal = store.require("goals", task.goalId); store.put("goals", { ...goal, status: "active" });
      acceptedPlanEvent(store, task, plan, actor, output.summary);
    }
    return plan;
  });
}
