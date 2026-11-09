import { reworkDetails } from "../core/rework.js";
import { contractVersion, deliveryGeneration, matchesTaskReview, taskContractVersion } from "../core/goal-contract.js";
import { assert, id, SYSTEM } from "../core/util.js";
import { canCoordinate, createCoordination, feedbackHashOf, findManager, reviewCoordinationKey } from "../core/coordination.js";

// A review only judges the delivered outcome. It never advances or reopens the
// reviewed task: approval is evidence, rejection opens a manager-led rework
// entry point. This keeps the task state machine free of a "waiting for review"
// state and makes reviews optional.
export async function acceptReviewFlow(engine, review, attempt, output) {
  const { store } = engine;
  assert(output.outcome === "reviewed" && ["approve", "changes_requested"].includes(output.decision), "INVALID_REVIEW", "Reviewer must return a decision");
  if (output.decision === "changes_requested") {
    // A recovered legacy receipt may contain only the summary and findings.
    const rework = reworkDetails(output.rework) ?? {
      category: "product-defect", evidence: [output.summary, ...(output.findings ?? [])].filter(Boolean).join("\n"),
      scope: "核对审查发现并由负责人确认修复范围", affectedEntrypoints: [], source: "legacy-review",
    };
    output = { ...output, rework };
  }
  if (review.reviewScope === "goal") return acceptGoalReview(engine, review, attempt, output);
  return acceptTaskReview(engine, review, attempt, output, store);
}

async function acceptTaskReview(engine, review, attempt, output, store) {
  const { workspaces } = engine;
  let source = store.require("tasks", review.reviewOf);
  assert(source.status === "succeeded", "STALE_REVIEW", "Only a delivered task can be reviewed");
  assert(matchesTaskReview(review, source), "STALE_REVIEW", "Review targets an obsolete deliverable version");
  assert(attempt.agentId !== source.lastAuthorId, "SELF_REVIEW", "Author cannot approve their own work");
  const unchanged = await workspaces.unchanged(source, source.artifactIds);
  assert(unchanged, "ARTIFACT_CHANGED", "Reviewed files changed after delivery");

  store.transaction(() => {
    const currentReview = engine.currentAttemptTask(attempt);
    source = store.require("tasks", source.id);
    assert(source.status === "succeeded" && matchesTaskReview(review, source), "STALE_REVIEW", "Deliverable changed during review");
    engine.finishAttempt(attempt, "completed", output.summary);
    store.put("tasks", { ...currentReview, status: "succeeded", passed: output.decision === "approve", summary: output.summary ?? "" });
    store.put("verifications", { id: id("verification"), taskId: source.id, goalId: source.goalId, attemptId: attempt.id, artifactHash: source.artifactHash,
      goalContractVersion: taskContractVersion(source), taskGeneration: deliveryGeneration(source),
      kind: "review", reviewerId: attempt.agentId, passed: output.decision === "approve", summary: output.summary, findings: output.findings ?? [], ...(output.rework ? { rework: output.rework } : {}) });
    const actor = { kind: "agent", id: attempt.agentId, goalId: source.goalId };
    store.event("review.decided", review.id, { taskId: source.id, scope: "task", decision: output.decision, artifactHash: source.artifactHash }, actor, { goalId: source.goalId });
    if (output.decision === "approve" || store.require("goals", source.goalId).supersededTaskIds?.includes(source.id)) return;
    requestRework(engine, source, review, attempt, output, { feedbackHash: feedbackHashOf(output) });
  });
}

function acceptGoalReview(engine, review, attempt, output) {
  const { company, store } = engine;
  const goal = store.require("goals", review.goalId);
  assert(goal.contractChange?.status !== 'pending' && review.deliveryHash === company.deliveryHash(goal.id),
    "STALE_REVIEW", "Goal contract or delivery changed after the final review was requested");
  for (const target of review.reviewTargets ?? []) {
    const current = store.require("tasks", target.id);
    assert(current.status === "succeeded" && current.artifactHash === target.artifactHash &&
      deliveryGeneration(current) === (target.deliveryGeneration ?? 1) && taskContractVersion(current) === (target.goalContractVersion ?? 1),
    "STALE_REVIEW", "Goal deliverable changed after the final review was requested");
    // Checked again at acceptance time, not only when the review was created:
    // a reviewer must not have authored any reviewed deliverable.
    assert(current.lastAuthorId !== attempt.agentId, "SELF_REVIEW", "Author cannot approve their own work");
  }
  store.transaction(() => {
    engine.currentAttemptTask(attempt);
    engine.finishAttempt(attempt, "completed", output.summary);
    store.put("tasks", { ...review, status: "succeeded", passed: output.decision === "approve", summary: output.summary ?? "" });
    store.put("verifications", { id: id("verification"), taskId: goal.id, goalId: goal.id, attemptId: attempt.id, artifactHash: review.deliveryHash,
      goalContractVersion: contractVersion(goal), kind: "goal-review", reviewerId: attempt.agentId, passed: output.decision === "approve", summary: output.summary, findings: output.findings ?? [], ...(output.rework ? { rework: output.rework } : {}) });
    const actor = { kind: "agent", id: attempt.agentId, goalId: goal.id };
    store.event("review.decided", review.id, { goalId: goal.id, scope: "goal", decision: output.decision, deliveryHash: review.deliveryHash }, actor, { goalId: goal.id });
    if (output.decision !== "approve") {
      // The reviewed outcome stays delivered; rework is a manager decision.
      // The counter lives on the goal so every new final review continues the
      // same rework chain instead of resetting to 1.
      const current = store.require("goals", goal.id);
      const rounds = (current.reworks ?? 0) + 1;
      store.put("goals", { ...current, reworks: rounds, status: "active" });
      store.event("goal.reopened", goal.id, { reason: "最终审查未通过", reviewTaskId: review.id, reworks: rounds }, actor);
      requestRework(engine, review, review, attempt, output, { round: rounds, feedbackHash: feedbackHashOf(output) });
    }
    company.refreshGoal(goal.id);
  });
}

function requestRework(engine, source, review, attempt, output, options = {}) {
  const { company, store } = engine;
  const current = store.require("tasks", source.id);
  const reworks = options.round ?? (current.reworks ?? 0) + 1;
  const maxReworks = company.policy().maxReworks;
  const exceeded = reworks > maxReworks;
  const feedback = [output.summary, ...(output.findings ?? [])].filter(Boolean).join("\n");
  store.put("tasks", { ...current, reworks, feedback, reworkDetails: output.rework, reviewLimitExceeded: exceeded });
  // Rework is new work: a delivered goal returns to active before any
  // coordination/gate task is created under it.
  const goal = store.require("goals", source.goalId);
  if (goal.status === "succeeded") store.put("goals", { ...goal, status: "active" });
  const actor = { kind: "agent", id: attempt.agentId, goalId: source.goalId };
  const feedbackHash = options.feedbackHash ?? feedbackHashOf(output);
  const manager = findManager(company, source.goalId);

  // The ceiling stops automatic rework and hands the decision to the owner.
  if (exceeded) {
    const gate = createOwnerGate(engine, source, review, {
      kind: "reworks", reworks, maxReworks, feedback, feedbackHash,
      reason: "审查返工次数已达上限",
      question: `审查返工次数已达上限（${reworks}/${maxReworks}）。请回复是否追加返工额度、调整范围，或恢复负责人后继续；决定前不会自动再开审查或返工。`,
    });
    store.event("review.rework.limit", source.id, { reviewTaskId: review.id, gateTaskId: gate.id, reworks, maxReworks }, actor, { goalId: source.goalId });
    return;
  }

  if (!manager || !canCoordinate(company, manager)) {
    const gate = createOwnerGate(engine, source, review, {
      kind: "assignment", reworks, maxReworks, feedback, feedbackHash,
      reason: "审查未通过，但没有可用的负责人调度返工",
      question: "请创建或恢复目标负责人（需 task.create 与 task.retry 授权），然后回复此待办并恢复。被审成果保持已交付。",
    });
    store.event("review.rework.blocked", source.id, { reviewTaskId: review.id, gateTaskId: gate.id, reworks, maxReworks, reason: "no-manager" }, actor, { goalId: source.goalId });
    return;
  }

  const coordination = createCoordination(company, store.require("tasks", source.id), {
    manager, key: reviewCoordinationKey(review.id), feedbackHash,
    reviewTaskId: review.id, reviewRound: reworks,
    title: "协调返工：" + (source.title ?? "已交付成果"),
    reason: "审查未通过：" + (output.summary ?? ""),
    description: [
      "审查任务：" + review.id,
      "被审成果：" + source.id + (source.title ? "（" + source.title + "）" : ""),
      "审查摘要：" + (output.summary ?? ""),
      "审查发现：" + ((output.findings ?? []).join("；") || "无"),
      "返工分类与范围：" + JSON.stringify(output.rework),
      "返工次数：" + reworks + "（上限 " + maxReworks + "）",
      "要求：在现有授权内决定返工范围；不需要返工时说明依据。审查不重开被审任务。",
    ].join("\n").slice(0, 15000),
  });
  store.event("review.rework.requested", source.id, { reviewTaskId: review.id, reworks, maxReworks, coordinationTaskId: coordination.id, rework: output.rework }, actor, { goalId: source.goalId });
}

// When no manager can decide (or the rework ceiling is hit), create a real
// blocked coordination task that the owner can answer. It carries no agent
// until a manager exists; the scheduler assigns one on a later tick, so the
// delivered task stays delivered and the pending decision is recoverable.
function createOwnerGate(engine, source, review, { kind, reworks, maxReworks, feedback, feedbackHash, reason, question }) {
  const { company, store } = engine;
  const gate = company.createTask({
    goalId: source.goalId, kind: "coordination", title: "待决定：审查返工（" + (source.title ?? review.title ?? source.id) + "）",
    description: [
      "审查任务：" + review.id,
      "被审成果：" + source.id + (source.title ? "（" + source.title + "）" : ""),
      "背景：" + reason,
      "审查摘要：" + (feedback || "无"),
      "返工次数：" + reworks + "（上限 " + maxReworks + "）",
      "被审成果保持已交付；此待办只决定返工范围与是否继续，不重开被审任务。",
    ].join("\n").slice(0, 15000),
    acceptance: "所有者或负责人在现有授权内决定返工范围、额度或分派；决定后由负责人执行，不伪造审查通过。",
    parentId: source.id, agentId: null,
    coordinationOf: source.id, coordinationKey: reviewCoordinationKey(review.id), reviewTaskId: review.id, reviewRound: reworks, feedbackHash,
    origin: { kind: "owner-rework-gate", decidedBy: null, createdBy: "scheduler", basis: reason },
  }, SYSTEM);
  store.put("tasks", { ...gate, status: "blocked", blocker: { kind, reason, question } });
  store.put("interactions", { id: id("interaction"), taskId: gate.id, goalId: source.goalId, taskGeneration: gate.generation, kind, reason, question, status: "pending" });
  store.event("review.rework.gate", gate.id, { sourceTaskId: source.id, reviewTaskId: review.id, reworks, maxReworks, kind }, SYSTEM, { goalId: source.goalId });
  return gate;
}
