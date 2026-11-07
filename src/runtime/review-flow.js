import { assert, id } from "../core/util.js";
import { canCoordinate, createCoordination, feedbackHashOf, findManager, holdSourceForCoordination, reviewCoordinationKey } from "../core/coordination.js";

export async function acceptReviewFlow(engine, review, attempt, output) {
  const { company, store, workspaces } = engine;
  assert(output.outcome === "reviewed" && ["approve", "changes_requested"].includes(output.decision), "INVALID_REVIEW", "Reviewer must return a decision");
  let source = store.require("tasks", review.reviewOf);
  assert(source.status === "reviewing" && source.artifactHash === review.reviewArtifactHash, "STALE_REVIEW", "Review targets an obsolete artifact version");
  assert(attempt.agentId !== source.lastAuthorId, "SELF_REVIEW", "Author cannot approve their own work");
  const unchanged = await workspaces.unchanged(source, source.artifactIds);
  assert(unchanged, "ARTIFACT_CHANGED", "Reviewed files changed after checks");
  store.transaction(() => {
    source = store.require("tasks", source.id);
    assert(source.status === "reviewing" && !source.stopRequested, "STALE_REVIEW", "Source task was paused during review");
    engine.finishAttempt(attempt, "completed", output.summary);
    store.put("tasks", { ...review, status: "succeeded", summary: output.summary ?? "" });
    store.put("verifications", { id: id("verification"), taskId: source.id, attemptId: attempt.id, artifactHash: source.artifactHash, kind: "review", reviewerId: attempt.agentId, passed: output.decision === "approve", summary: output.summary, findings: output.findings ?? [] });
    const agentActor = { kind: "agent", id: attempt.agentId, goalId: source.goalId };
    store.event("review.decided", review.id, { taskId: source.id, decision: output.decision, artifactHash: source.artifactHash }, agentActor, { goalId: source.goalId });
    if (output.decision === "approve") { engine.nextStage(store.require("tasks", source.id)); return; }
    const reworks = source.reworks + 1;
    const maxReworks = Math.min(source.workflowSnapshot?.maxReworks ?? 0, company.policy().maxReworks);
    const feedback = [output.summary, ...(output.findings ?? [])].filter(Boolean).join("\n");
    const held = store.put("tasks", { ...source, reworks, feedback, status: "blocked", stageIndex: 0, blocker: { kind: "coordination", reason: "审查要求返工" }, reviewLimitExceeded: reworks > maxReworks });
    const reviewDecision = { kind: "review-decision", by: attempt.agentId, basis: output.summary ?? "" };
    // Enforce the rework ceiling *before* opening another coordination round.
    // Beyond the ceiling the user must decide, so no automatic release path can
    // keep the coordinator rework loop alive.
    if (reworks > maxReworks) {
      engine.block(held, "reworks", "审查返工次数已达上限", `审查返工次数已达上限（${reworks}/${maxReworks}）。请回复追加的返工额度或调整范围/分派，然后恢复任务。`);
      store.event("review.rework.limit", source.id, { reviewTaskId: review.id, reworks, maxReworks, reviewLimitExceeded: true, decision: reviewDecision }, agentActor, { goalId: source.goalId });
      return;
    }
    const manager = findManager(company, source.goalId);
    if (!canCoordinate(company, manager)) {
      const reason = manager ? "当前负责人没有创建协调任务所需的授权" : "没有当前目标或全局的可分配负责人来协调审查返工";
      engine.block(held, "assignment", reason, "请创建或恢复当前目标（或全局）负责人，并确认其拥有 task.create 与 task.retry 授权，然后恢复此任务。");
      store.event("review.rework.blocked", source.id, { reviewTaskId: review.id, reworks, managerId: manager?.id ?? null, reason, decision: reviewDecision }, agentActor, { goalId: source.goalId });
      return;
    }
    const grants = company.effectiveGrants({ id: manager.id, grants: manager.grants });
    const commands = grants.join(", ");
    const coordination = createCoordination(company, held, { manager, key: reviewCoordinationKey(review.id), feedbackHash: feedbackHashOf(output), reviewTaskId: review.id, reviewRound: reworks, title: "协调返工：" + source.title, reason: "审查未通过：" + (output.summary ?? ""), description: ["审查任务：" + review.id, "源任务：" + source.id, "审查摘要：" + (output.summary ?? ""), "审查发现：" + ((output.findings ?? []).join("；") || "无"), "返工次数：" + reworks + "（上限 " + maxReworks + "）", "当前分派：" + (source.agentId ?? "无"), "当前依赖：" + ((source.dependencies ?? []).join(", ") || "无"), "负责人可用命令：" + commands].join("\n").slice(0, 15000) });
    holdSourceForCoordination(store, held, coordination);
    store.event("review.rework.requested", source.id, { reviewTaskId: review.id, reworks, coordinationTaskId: coordination.id, reviewLimitExceeded: reworks > maxReworks, decision: reviewDecision }, agentActor, { goalId: source.goalId });
  });
}
