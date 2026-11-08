import { assert, id } from "../core/util.js";
import { canCoordinate, createCoordination, feedbackHashOf, findManager, reviewCoordinationKey } from "../core/coordination.js";

// A review only judges the delivered outcome. It never advances or reopens the
// reviewed task: approval is evidence, rejection opens a manager-led rework
// entry point. This keeps the task state machine free of a "waiting for review"
// state and makes reviews optional.
export async function acceptReviewFlow(engine, review, attempt, output) {
  const { company, store } = engine;
  assert(output.outcome === "reviewed" && ["approve", "changes_requested"].includes(output.decision), "INVALID_REVIEW", "Reviewer must return a decision");
  if (review.reviewScope === "goal") return acceptGoalReview(engine, review, attempt, output);
  return acceptTaskReview(engine, review, attempt, output, company, store);
}

async function acceptTaskReview(engine, review, attempt, output, company, store) {
  const { workspaces } = engine;
  let source = store.require("tasks", review.reviewOf);
  assert(source.status === "succeeded", "STALE_REVIEW", "Only a delivered task can be reviewed");
  assert(source.artifactHash === review.reviewArtifactHash, "STALE_REVIEW", "Review targets an obsolete deliverable version");
  assert(attempt.agentId !== source.lastAuthorId, "SELF_REVIEW", "Author cannot approve their own work");
  const unchanged = await workspaces.unchanged(source, source.artifactIds);
  assert(unchanged, "ARTIFACT_CHANGED", "Reviewed files changed after delivery");

  store.transaction(() => {
    source = store.require("tasks", source.id);
    assert(source.status === "succeeded" && source.artifactHash === review.reviewArtifactHash, "STALE_REVIEW", "Deliverable changed during review");
    engine.finishAttempt(attempt, "completed", output.summary);
    store.put("tasks", { ...review, status: "succeeded", passed: output.decision === "approve", summary: output.summary ?? "" });
    store.put("verifications", { id: id("verification"), taskId: source.id, goalId: source.goalId, attemptId: attempt.id, artifactHash: source.artifactHash, kind: "review", reviewerId: attempt.agentId, passed: output.decision === "approve", summary: output.summary, findings: output.findings ?? [] });
    const actor = { kind: "agent", id: attempt.agentId, goalId: source.goalId };
    store.event("review.decided", review.id, { taskId: source.id, scope: "task", decision: output.decision, artifactHash: source.artifactHash }, actor, { goalId: source.goalId });
    if (output.decision === "approve") return;
    requestRework(engine, source, review, attempt, output);
  });
}

function acceptGoalReview(engine, review, attempt, output) {
  const { company, store } = engine;
  const goal = store.require("goals", review.goalId);
  for (const target of review.reviewTargets ?? []) {
    const current = store.require("tasks", target.id);
    assert(current.status === "succeeded" && current.artifactHash === target.artifactHash, "STALE_REVIEW", "Goal deliverable changed after the final review was requested");
  }
  store.transaction(() => {
    engine.finishAttempt(attempt, "completed", output.summary);
    store.put("tasks", { ...review, status: "succeeded", passed: output.decision === "approve", summary: output.summary ?? "" });
    store.put("verifications", { id: id("verification"), taskId: goal.id, goalId: goal.id, attemptId: attempt.id, artifactHash: review.deliveryHash, kind: "goal-review", reviewerId: attempt.agentId, passed: output.decision === "approve", summary: output.summary, findings: output.findings ?? [] });
    const actor = { kind: "agent", id: attempt.agentId, goalId: goal.id };
    store.event("review.decided", review.id, { goalId: goal.id, scope: "goal", decision: output.decision, deliveryHash: review.deliveryHash }, actor, { goalId: goal.id });
    if (output.decision !== "approve") {
      // The reviewed goal stays delivered; rework is a manager decision.
      requestRework(engine, review, review, attempt, output);
      const current = store.require("goals", goal.id);
      if (current.status === "succeeded") store.put("goals", { ...current, status: "active" });
      store.event("goal.reopened", goal.id, { reason: "最终审查未通过", reviewTaskId: review.id }, actor);
    }
    company.refreshGoal(goal.id);
  });
}

function requestRework(engine, source, review, attempt, output) {
  const { company, store } = engine;
  const current = store.require("tasks", source.id);
  const reworks = (current.reworks ?? 0) + 1;
  const maxReworks = company.policy().maxReworks;
  const feedback = [output.summary, ...(output.findings ?? [])].filter(Boolean).join("\n");
  const updated = store.put("tasks", { ...current, reworks, feedback, reviewLimitExceeded: reworks > maxReworks });
  // Rework is new work: a delivered goal returns to active before any
  // coordination/rework task is created under it.
  const goal = store.require("goals", source.goalId);
  if (goal.status === "succeeded") store.put("goals", { ...goal, status: "active" });
  const manager = findManager(company, source.goalId);
  const actor = { kind: "agent", id: attempt.agentId, goalId: source.goalId };
  if (!manager || !canCoordinate(company, manager)) {
    if (!store.list("interactions").some(i => i.taskId === source.id && i.status === "pending")) {
      store.put("interactions", { id: id("interaction"), taskId: source.id, goalId: source.goalId, taskGeneration: source.generation, kind: "assignment", reason: "审查未通过，但没有可用的负责人调度返工", question: "请创建或恢复目标负责人（需 task.create 与 task.retry），或直接决定返工范围后恢复。", status: "pending" });
    }
    store.event("review.rework.blocked", source.id, { reviewTaskId: review.id, reworks, maxReworks, reason: "no-manager" }, actor, { goalId: source.goalId });
    return;
  }
  const coordination = createCoordination(company, updated, {
    manager, key: reviewCoordinationKey(review.id), feedbackHash: feedbackHashOf(output),
    reviewTaskId: review.id, reviewRound: reworks,
    title: "协调返工：" + (source.title ?? "已交付成果"),
    reason: "审查未通过：" + (output.summary ?? ""),
    description: [
      "审查任务：" + review.id,
      "被审成果：" + source.id + (source.title ? "（" + source.title + "）" : ""),
      "审查摘要：" + (output.summary ?? ""),
      "审查发现：" + ((output.findings ?? []).join("；") || "无"),
      "返工次数：" + reworks + "（上限 " + maxReworks + "）",
      "要求：在现有授权内决定返工范围；不需要返工时说明依据。审查不重开被审任务。",
    ].join("\n").slice(0, 15000),
  });
  store.event("review.rework.requested", source.id, { reviewTaskId: review.id, reworks, maxReworks, coordinationTaskId: coordination.id }, actor, { goalId: source.goalId });
}
