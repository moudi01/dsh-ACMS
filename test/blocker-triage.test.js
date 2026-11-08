import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { blockerCoordinationKey, blockerRoute } from "../src/core/blocker-policy.js";

function claimCoordination(f, coordination, agentId = "manager") {
  const attempt = { id: randomUUID(), taskId: coordination.id, goalId: coordination.goalId, agentId, role: "manager", kind: "coordination", taskGeneration: coordination.generation, grants: f.store.require("agents", agentId).grants, status: "running", startedAt: new Date().toISOString() };
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
  f.engine.block(f.store.require("tasks", review.id), "technical", "reviewer sandbox failed again", "retry review");
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
