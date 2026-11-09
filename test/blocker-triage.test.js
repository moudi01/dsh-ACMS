import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultSimulation } from "../src/adapters/simulated.js";
import { fixture, until } from "./helpers.js";
import { selectRoute, selectionError } from "../src/core/model-selection.js";
import { blockerCoordinationKey, blockerRoute } from "../src/core/blocker-policy.js";

function claimCoordination(f, coordination, agentId = "manager") {
  const attempt = { id: randomUUID(), taskId: coordination.id, goalId: coordination.goalId, agentId, role: "manager", kind: "coordination", taskGeneration: coordination.generation, blockerFeedbackHash: coordination.feedbackHash, grants: f.store.require("agents", agentId).grants, status: "running", startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", attempt); f.store.put("tasks", { ...f.store.require("tasks", coordination.id), status: "running", activeAttemptId: attempt.id }); });
  return attempt;
}

test("blocker policy keeps owner gates and manager-recoverable blockers apart", () => {
  const work = { kind: "work" }; const review = { kind: "review" }; const repair = { kind: "repair" }; const coordination = { kind: "coordination" };
  for (const kind of ["model-selection", "integration"]) assert.equal(blockerRoute(work, kind), "manager");
  for (const kind of ["technical", "execution"]) {
    assert.equal(blockerRoute(review, kind), "manager");
    assert.equal(blockerRoute(repair, kind), "manager");
  }
  for (const kind of ["human", "budget", "reworks", "assignment", "permission", "repair_limit", "execution_limit", "unknown"]) assert.equal(blockerRoute(work, kind), "owner");
  assert.equal(blockerRoute(coordination, "technical"), "owner");
  assert.equal(blockerRoute(work, undefined), "owner");
  assert.equal(blockerCoordinationKey({ id: "task_1", generation: 2 }, "integration"), "executor:task_1:g2:blocker:integration");
});

test("a review environment blocker becomes one manager coordination task", async t => {
  const f = await fixture(t);
  const review = f.task({ title: "Review environment blocker" });
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", review.id), kind: "review" }));
  f.engine.block(f.store.require("tasks", review.id), "technical", "reviewer sandbox failed", "retry review");
  const blocked = f.store.require("tasks", review.id);
  assert.equal(blocked.blocker.kind, "coordination");
  const coordinations = f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === review.id);
  assert.equal(coordinations.length, 1);
  assert.equal(coordinations[0].agentId, "manager");
  assert.equal(coordinations[0].origin.blockerKind, "technical");
  assert.equal(f.store.list("interactions").filter(item => item.taskId === review.id && item.status === "pending").length, 0);

  const attempt = claimCoordination(f, coordinations[0]);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  await f.engine.accept(attempt, { outcome: "coordinated", summary: "Retry the review in the same workspace" }, { throwIfAborted() {} });
  const released = f.store.require("tasks", review.id);
  assert.equal(released.status, "ready");
  assert.equal(released.blocker, null);
  assert.equal(released.workspace ?? null, blocked.workspace ?? null);

  // The same blocker after the manager decision goes to the owner instead of looping.
  f.engine.block(f.store.require("tasks", review.id), "technical", "reviewer sandbox failed", "retry review");
  const second = f.store.require("tasks", review.id);
  assert.equal(second.blocker.kind, "technical");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === review.id).length, 1);
  const questions = f.store.list("interactions").filter(item => item.taskId === review.id && item.status === "pending");
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /已由负责人处理过/);
});

test("integration blockers reach the manager, human and budget gates stay with the owner", async t => {
  const f = await fixture(t);
  const integration = f.task({ title: "Integration blocker" });
  f.engine.block(integration, "integration", "merge conflict in candidate", "resolve integration");
  assert.equal(f.store.require("tasks", integration.id).blocker.kind, "coordination");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === integration.id).length, 1);

  const human = f.task({ title: "Human blocker" });
  f.engine.block(human, "human", "Missing owner credentials", "Please provide credentials");
  assert.equal(f.store.require("tasks", human.id).blocker.kind, "human");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === human.id).length, 0);
  const humanQuestion = f.store.list("interactions").find(item => item.taskId === human.id && item.status === "pending");
  assert.equal(humanQuestion.kind, "human");

  const budget = f.task({ title: "Budget blocker" });
  f.engine.block(budget, "budget", "Goal runtime exhausted", "Add more time");
  assert.equal(f.store.require("tasks", budget.id).blocker.kind, "budget");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === budget.id).length, 0);
});

test("a retired manager turns a recoverable blocker into an owner assignment question", async t => {
  const f = await fixture(t);
  f.store.transaction(() => f.store.put("agents", { ...f.store.require("agents", "manager"), status: "retired" }));
  const task = f.task({ title: "No manager available" });
  f.engine.block(task, "model-selection", "no candidate", "adjust model");
  const saved = f.store.require("tasks", task.id);
  assert.equal(saved.blocker.kind, "assignment");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === task.id).length, 0);
  const question = f.store.list("interactions").find(item => item.taskId === task.id && item.status === "pending");
  assert.equal(question.kind, "assignment");
  assert.match(question.question, /负责人/);
});

test("owner pause is never converted into a manager coordination", async t => {
  const f = await fixture(t);
  const task = f.task({ title: "Paused blocker" });
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), status: "paused" }));
  f.engine.block(f.store.require("tasks", task.id), "integration", "merge conflict", "resolve integration");
  const saved = f.store.require("tasks", task.id);
  assert.equal(saved.status, "paused");
  assert.equal(saved.blocker.kind, "integration");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination" && item.coordinationOf === task.id).length, 0);
  assert.equal(f.store.list("interactions").filter(item => item.taskId === task.id && item.status === "pending").length, 1);
});

test("goal task limit falls back to an owner blocker instead of leaving a running attempt", async t => {
  const f = await fixture(t);
  f.store.transaction(() => f.store.put("policy", { ...f.company.policy(), maxTasksPerGoal: 1 }));
  f.adapter.start = async () => { throw selectionError(selectRoute({ candidates: [], policy: {} })); };
  const task = f.task({ title: "Selection blocker at the task limit" });
  await f.start();
  const blocked = await until(() => { const saved = f.store.require("tasks", task.id); return saved.status === "blocked" ? saved : null; });
  assert.equal(blocked.blocker.kind, "model-selection");
  const attempt = await until(() => {
    const saved = f.store.list("attempts").find(item => item.taskId === task.id);
    return saved && saved.status === "failed" && saved.cleanupPending === false ? saved : null;
  });
  assert.equal(attempt.resultAccepted, false);
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination").length, 0);
  const questions = f.store.list("interactions").filter(item => item.taskId === task.id && item.status === "pending");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].kind, "model-selection");
  assert.match(questions[0].question, /每个目标任务上限/);
  await until(() => f.engine.live.size === 0);
  assert.equal(f.store.list("attempts").filter(item => item.taskId === task.id && item.status === "running").length, 0);
});

test("execution-limit coordination falls back to an owner blocker at the goal task limit", async t => {
  const f = await fixture(t);
  f.store.transaction(() => f.store.put("policy", { ...f.company.policy(), maxTasksPerGoal: 1 }));
  const task = f.task({ title: "Execution limit at the task limit" });
  const saved = f.engine.coordinateFailure(f.store.require("tasks", task.id), "Synthetic execution failure");
  assert.equal(saved.blocker.kind, "execution_limit");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination").length, 0);
  const questions = f.store.list("interactions").filter(item => item.taskId === task.id && item.status === "pending");
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /每个目标任务上限/);
});

test("repair-limit coordination falls back to an owner blocker at the goal task limit", async t => {
  const f = await fixture(t);
  f.store.transaction(() => f.store.put("policy", { ...f.company.policy(), maxTasksPerGoal: 1 }));
  const task = f.task({ title: "Repair limit at the task limit" });
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), repairs: f.company.policy().maxReworks }));
  const saved = f.engine.scheduleRepair(f.store.require("tasks", task.id), "Synthetic technical failure");
  assert.equal(saved.blocker.kind, "repair_limit");
  assert.equal(f.store.list("tasks").filter(item => item.kind === "coordination").length, 0);
  const questions = f.store.list("interactions").filter(item => item.taskId === task.id && item.status === "pending");
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /每个目标任务上限/);
});


test("planning service exhaustion coordinates and resumes the same plan", async t => {
  let planningCalls = 0;
  const f = await fixture(t, async ({ task }) => {
    if (task.kind === "coordination") return { outcome: "coordinated", summary: "Retry after the provider is available" };
    if (task.kind === "plan" && ++planningCalls === 1) throw Object.assign(new Error("HTTP 500"), { code: "SERVICE_UNAVAILABLE" });
    return defaultSimulation({ task });
  });
  f.command("policy.update", { patch: { maxAttempts: 1 } });
  const goal = f.command("goal.create", { title: "Service recovery", description: "Deliver the agreed file", acceptance: "File exists", projectId: f.project.id, templateId: "base" });
  const plan = f.store.list("tasks").find(task => task.goalId === goal.id && task.kind === "plan");
  await f.start();
  await until(() => f.store.require("goals", goal.id).status === "succeeded");
  const attempts = f.store.list("attempts").filter(attempt => attempt.taskId === plan.id);
  assert.deepEqual(attempts.map(attempt => attempt.status), ["failed", "completed"]);
  assert.equal(attempts[0].contextKey, attempts[1].contextKey);
  assert.equal(attempts[0].workspace.path, attempts[1].workspace.path);
  assert.equal(f.store.list("tasks").filter(task => task.coordinationOf === plan.id).length, 1);
  assert.equal(f.store.list("interactions").length, 0);
});

test("only failed dependencies need coordination and the manager can repair the original graph", async t => {
  let downstream;
  const f = await fixture(t, async input => {
    if (input.task.kind === "coordination") return {
      outcome: "coordinated", summary: "Remove the failed optional dependency",
      actions: [{ command: "task.dependencies", args: { id: downstream.id, dependencies: [] } }],
    };
    return defaultSimulation(input);
  });
  const upstream = f.task({ title: "Failed upstream" });
  downstream = f.task({ title: "Continue the existing downstream", dependencies: [upstream.id] });
  f.engine.refreshReadiness();
  assert.equal(f.store.list("tasks").filter(task => task.kind === "coordination").length, 0);
  f.store.transaction(() => f.store.put("tasks", { ...upstream, status: "failed" }));
  f.engine.refreshReadiness();
  f.engine.refreshReadiness();
  assert.equal(f.store.list("tasks").filter(task => task.coordinationOf === downstream.id).length, 1);
  await f.start();
  await until(() => f.store.require("tasks", downstream.id).status === "succeeded");
  assert.equal(f.store.require("tasks", upstream.id).status, "failed");
  assert.equal(f.store.list("interactions").length, 0);
});

test("same facts are idempotent, changed facts refresh an active handoff, and retries are bounded", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const source = f.task();
  const report = (kind, reason, evidence) => f.engine.block(source, kind, reason, "Resolve", evidence);
  const handoffs = () => f.store.list("tasks").filter(task => task.coordinationOf === source.id);

  report("model-selection", "no eligible model", { code: "NO_MODEL" });
  const first = handoffs()[0];
  report("model-selection", "no eligible model", { code: "NO_MODEL" });
  assert.equal(handoffs()[0].revision, first.revision);
  const obsolete = claimCoordination(f, first);
  report("integration", "conflict", { targetHead: "a" });
  assert.equal(handoffs().length, 1);
  assert.equal(handoffs()[0].id, first.id);
  assert.match(handoffs()[0].description, /conflict/);
  await f.engine.accept(obsolete, { outcome: "coordinated", summary: "Obsolete decision" }, { throwIfAborted() {} });
  assert.equal(f.store.require("attempts", obsolete.id).status, "interrupted");
  assert.equal(f.store.require("tasks", source.id).status, "blocked");

  const accept = task => f.engine.accept(claimCoordination(f, task), { outcome: "coordinated", summary: "Reviewed latest evidence" }, { throwIfAborted() {} });
  await accept(handoffs()[0]);
  report("integration", "conflict", { targetHead: "b" });
  assert.equal(handoffs().length, 2);
  await accept(handoffs()[1]);
  report("integration", "conflict", { targetHead: "c" });
  assert.equal(handoffs().length, 2);
  assert.equal(f.store.list("interactions").filter(i => i.status === "pending").length, 1);
});

test("late blocker reports cannot change a stopped, obsolete or uncertain task", async t => {
  const f = await fixture(t);
  for (const [status, patch] of [
    ["cancelled", {}], ["deleted", {}], ["succeeded", {}], ["stopping", { stopRequested: "cancelled" }],
    ["reconciling", {}], ["ready", { generation: 2 }],
  ]) {
    const task = f.task();
    const stopped = f.store.transaction(() => f.store.put("tasks", { ...task, status, ...patch }));
    f.engine.block(task, "integration", "late failure", "Resolve");
    assert.deepEqual(f.store.require("tasks", task.id), stopped);
  }
  assert.equal(f.store.list("interactions").length, 0);
  assert.equal(f.store.list("tasks").filter(task => task.kind === "coordination").length, 0);
});

test("manager retry cannot override an owner pause", async t => {
  const f = await fixture(t);
  const task = f.task();
  f.command("task.pause", { id: task.id });
  const manager = f.store.require("agents", "manager");
  assert.throws(() => f.command("task.retry", { id: task.id }, { kind: "agent", id: manager.id, goalId: task.goalId, grants: manager.grants }), { code: "OWNER_REQUIRED" });
  assert.equal(f.store.require("tasks", task.id).status, "paused");
});
