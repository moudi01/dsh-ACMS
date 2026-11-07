import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, until } from "./helpers.js";
import { defaultSimulation } from "../src/adapters/simulated.js";
import { createCoordination, executorCoordinationKey } from "../src/core/coordination.js";

function contractOf(input) { return JSON.parse(input.prompt.split("CONTRACT:\n")[1]); }

async function seedManagerAttempt(f, task, agentId = "manager") {
  const attempt = { id: randomUUID(), taskId: task.id, goalId: task.goalId, agentId, role: "manager", kind: task.kind, taskGeneration: task.generation, grants: f.store.require("agents", agentId).grants, status: "running", startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", attempt); f.store.put("tasks", { ...task, status: "running", activeAttemptId: attempt.id }); });
  return attempt;
}

test("manager plan is attributed to the manager and records real task ids", async t => {
  const f = await fixture(t, async input => {
    if (input.task.kind === "plan" && !input.task.coordinationOf) return { outcome: "planned", rationale: "先交付源码，再独立审查；两步有产物依赖。", summary: "两阶段计划", tasks: [
      { key: "build", title: "Build deliverable", description: "Produce the file", acceptance: "File exists", dependencies: [] },
      { key: "verify", title: "Second deliverable", description: "Use the first file", acceptance: "Second file exists", dependencies: ["build"] }
    ] };
    return defaultSimulation(input);
  });
  const goal = f.command("goal.create", { title: "Autonomous plan", description: "Manager decides the split", acceptance: "Two reviewed files", projectId: f.project.id });
  await f.start();
  await until(() => f.store.require("goals", goal.id).status === "succeeded", 12000);
  const planTask = f.store.list("tasks").find(t => t.goalId === goal.id && t.kind === "plan");
  const plans = f.store.list("plans").filter(p => p.goalId === goal.id);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].taskId, planTask.id);
  assert.equal(plans[0].managerId, "manager");
  assert.equal(plans[0].rationaleSource, "explicit");
  assert.match(plans[0].rationale, /产物依赖/);
  const children = f.store.list("tasks").filter(t => t.kind === "work" && t.goalId === goal.id);
  assert.equal(plans[0].nodes.length, 2);
  for (const node of plans[0].nodes) assert(children.some(c => c.id === node.taskId));
  const verify = f.store.require("tasks", plans[0].nodes[1].taskId);
  assert.deepEqual(verify.dependencies, [plans[0].nodes[0].taskId]);
  assert.equal(verify.origin.kind, "manager-plan");
  assert.equal(verify.origin.createdBy, "manager");
  assert.equal(verify.origin.planKey, "verify");
  const events = f.store.page(0, 1000).entries;
  const createdManager = events.filter(e => e.type === "task.created" && e.actor === "manager");
  assert.equal(createdManager.length, 2);
  const accepted = events.find(e => e.type === "plan.accepted");
  assert.equal(accepted.actor, "manager");
  assert.equal(accepted.decision.kind, "manager-decision");
  assert.equal(accepted.tasks.length, 2);
  const planCreated = events.find(e => e.type === "task.created" && e.entityId === planTask.id);
  assert.equal(planCreated.actor, "scheduler");
  const snapshot = f.company.snapshot();
  assert.equal(snapshot.plans.length, 1);
});

test("plan replay is idempotent and conflicting replay is rejected", async t => {
  const f = await fixture(t);
  const task = f.task({ agentId: "manager" });
  const attempt = await seedManagerAttempt(f, task);
  const output = { outcome: "planned", rationale: "Single node", summary: "Plan", tasks: [{ key: "only", title: "Only child", description: "d", acceptance: "a", dependencies: [] }] };
  const first = f.engine.acceptPlan(task, attempt, output);
  const tasksBefore = f.store.list("tasks").length;
  const second = f.engine.acceptPlan(f.store.require("tasks", task.id), f.store.require("attempts", attempt.id), structuredClone(output));
  assert.equal(second.id, first.id);
  assert.equal(f.store.list("tasks").length, tasksBefore);
  assert.equal(f.store.list("plans").length, 1);
  const changed = structuredClone(output); changed.rationale = "Different rationale";
  assert.throws(() => f.engine.acceptPlan(f.store.require("tasks", task.id), f.store.require("attempts", attempt.id), changed), { code: "PLAN_CONFLICT" });
});

test("review feedback wakes the manager and rework resumes only after coordination", async t => {
  let reviews = 0; let coordinationContract = null;
  const f = await fixture(t, async input => {
    if (input.task.kind === "review") { reviews++; return reviews === 1 ? { outcome: "reviewed", decision: "changes_requested", summary: "Add explanation", findings: ["Missing context"] } : { outcome: "reviewed", decision: "approve", summary: "Now complete", findings: [] }; }
    if (input.task.kind === "coordination") { coordinationContract = contractOf(input); return { outcome: "coordinated", summary: "保留原分派并恢复返工" }; }
    return defaultSimulation(input);
  });
  const task = f.task();
  await f.start();
  await until(() => f.store.require("tasks", task.id).status === "succeeded", 12000);
  assert.equal(reviews, 2);
  const coordinations = f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === task.id);
  assert.equal(coordinations.length, 1);
  assert.equal(coordinations[0].status, "succeeded");
  assert.match(coordinations[0].coordinationKey, /^review:/);
  assert.equal(coordinations[0].reviewRound, 1);
  assert.equal(coordinations[0].feedbackHash.length, 64);
  assert(coordinationContract.coordination);
  assert.equal(coordinationContract.coordination.sourceTaskId, task.id);
  assert.deepEqual(coordinationContract.goalConstraints, []);
  assert.equal(coordinationContract.rework.reworks, 1);
  assert(Array.isArray(coordinationContract.goalTasks));
  const attempts = f.store.list("attempts");
  const work = attempts.filter(a => a.kind === "work");
  const review = attempts.filter(a => a.kind === "review");
  const coordination = attempts.filter(a => a.kind === "coordination");
  assert.equal(work.length, 2);
  assert.equal(review.length, 2);
  assert.equal(coordination.length, 1);
  assert.notEqual(work[0].contextKey, review[0].contextKey);
  assert.notEqual(review[0].contextKey, coordination[0].contextKey);
  assert.equal(f.store.require("tasks", review[0].taskId).requirements.isolation, "independent-review");
  assert(f.adapter.maxActive <= f.company.policy().maxConcurrent);
  const decided = f.store.page(0, 1000).entries.filter(e => e.type === "coordination.decided");
  assert.equal(decided.length, 1);
  assert.equal(decided[0].actor, "manager");
  assert.equal(decided[0].decision.kind, "manager-decision");
  const queued = f.store.page(0, 1000).entries.find(e => e.type === "coordination.created");
  assert.equal(queued.decision.kind, "scheduler-action");
});

test("two review rejections in one generation create two coordination tasks", async t => {
  let reviews = 0;
  const f = await fixture(t, async input => {
    if (input.task.kind === "review") { reviews++; return reviews <= 2 ? { outcome: "reviewed", decision: "changes_requested", summary: "Reject " + reviews, findings: ["Finding " + reviews] } : { outcome: "reviewed", decision: "approve", summary: "Accepted", findings: [] }; }
    if (input.task.kind === "coordination") return { outcome: "coordinated", summary: "恢复返工" };
    return defaultSimulation(input);
  });
  const task = f.task();
  await f.start();
  await until(() => f.store.require("tasks", task.id).status === "succeeded", 15000);
  const coordinations = f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === task.id);
  assert.equal(coordinations.length, 2);
  assert.notEqual(coordinations[0].coordinationKey, coordinations[1].coordinationKey);
  assert.deepEqual(coordinations.map(c => c.reviewRound), [1, 2]);
  assert.equal(f.store.require("tasks", task.id).reworks, 2);
  assert.equal(reviews, 3);
});

test("coordination keys deduplicate replay and reject changed feedback", async t => {
  const f = await fixture(t);
  const source = f.task({ title: "Rework target" });
  const key = "review:review-fixture-0001";
  let first;
  f.store.transaction(() => { first = createCoordination(f.company, source, { key, feedbackHash: "a".repeat(64), reviewTaskId: "review_fixture", reviewRound: 1 }); });
  let again;
  f.store.transaction(() => { again = createCoordination(f.company, source, { key, feedbackHash: "a".repeat(64), reviewTaskId: "review_fixture", reviewRound: 1 }); });
  assert.equal(again.id, first.id);
  assert.equal(f.store.list("tasks").filter(t => t.coordinationKey === key).length, 1);
  assert.throws(() => f.store.transaction(() => createCoordination(f.company, source, { key, feedbackHash: "b".repeat(64) })), { code: "COORDINATION_CONFLICT" });
});

test("manager plan rejects cross-goal assignees and lacks-of-grant escalations", async t => {
  const f = await fixture(t);
  const other = f.command("goal.create", { title: "Other goal", description: "Other", acceptance: "Other", projectId: f.project.id, plan: false });
  const foreign = f.command("agent.save", { name: "Foreign worker", role: "worker" }, { kind: "agent", id: "manager", goalId: other.id });
  const task = f.task({ agentId: "manager" });
  const attempt = await seedManagerAttempt(f, task);
  const output = { outcome: "planned", summary: "Cross goal", tasks: [{ key: "x", title: "X", description: "d", acceptance: "a", dependencies: [], assignee: foreign.id }] };
  assert.throws(() => f.engine.acceptPlan(task, attempt, output), { code: "INVALID_PLAN" });
  const restricted = f.command("agent.save", { name: "Restricted manager", role: "manager", grants: ["agent.save"] });
  const task2 = f.task({ title: "Restricted task" });
  const attempt2 = await seedManagerAttempt(f, task2, restricted.id);
  const output2 = { outcome: "planned", summary: "No grant", tasks: [{ key: "y", title: "Y", description: "d", acceptance: "a", dependencies: [] }] };
  assert.throws(() => f.engine.acceptPlan(task2, attempt2, output2), { code: "FORBIDDEN" });
  assert.equal(f.store.list("tasks").filter(t => t.goalId === task.goalId).length, 2);
});

test("managed coordination batch adjusts staffing and records the manager decision", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const source = f.task({ title: "Needs coordination" });
  let coordination;
  f.store.transaction(() => { coordination = createCoordination(f.company, source, { key: executorCoordinationKey(source.id, source.generation, "repair-limit"), feedbackHash: "c".repeat(64), reason: "fixture" }); });
  const actor = { kind: "agent", id: "manager", goalId: f.goal.id, grants: f.store.require("agents", "manager").grants };
  const firstAttempt = { id: randomUUID(), taskId: coordination.id, goalId: f.goal.id, agentId: "manager", role: "manager", kind: "coordination", taskGeneration: coordination.generation, grants: actor.grants, status: "running", startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", firstAttempt); f.store.put("tasks", { ...f.store.require("tasks", coordination.id), status: "running", activeAttemptId: firstAttempt.id }); });
  await f.engine.accept(firstAttempt, { outcome: "managed", actionBatchId: "coordination-staffing-v1", summary: "增加执行人员", actions: [{ command: "agent.save", args: { name: "Coordination worker", role: "worker", grants: [], temporary: true } }] }, { throwIfAborted() {} });
  assert.equal(f.store.list("actionBatches").length, 1);
  assert(f.store.list("agents").some(a => a.name === "Coordination worker"));
  const afterBatch = f.store.require("tasks", coordination.id);
  assert.equal(afterBatch.status, "ready");
  assert.equal(afterBatch.managementTurns, 1);
  const secondAttempt = { ...firstAttempt, id: randomUUID(), startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", secondAttempt); f.store.put("tasks", { ...f.store.require("tasks", coordination.id), status: "running", activeAttemptId: secondAttempt.id }); });
  await f.engine.accept(secondAttempt, { outcome: "coordinated", summary: "保留原分派并恢复返工" }, { throwIfAborted() {} });
  const saved = f.store.require("tasks", coordination.id);
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.decision.kind, "manager-decision");
  assert.equal(f.store.require("tasks", source.id).status, "ready");
  const batches = f.store.list("actionBatches");
  assert.equal(batches[0].actorId, "manager");
});

test("repair limit opens manager coordination instead of a direct user question", async t => {
  const f = await fixture(t);
  const task = f.task();
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), repairs: f.company.policy().maxReworks }));
  f.engine.scheduleRepair(f.store.require("tasks", task.id), "Synthetic technical failure");
  const source = f.store.require("tasks", task.id);
  assert.equal(source.status, "blocked");
  assert.equal(source.blocker.kind, "coordination");
  const coordinations = f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === task.id);
  assert.equal(coordinations.length, 1);
  assert.match(coordinations[0].coordinationKey, /^executor:/);
  assert.equal(f.store.list("interactions").length, 0);
});

test("replayed repair-limit feedback blocks instead of auto-releasing the source", async t => {
  const f = await fixture(t);
  const task = f.task();
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), repairs: f.company.policy().maxReworks }));
  f.engine.scheduleRepair(f.store.require("tasks", task.id), "Synthetic technical failure");
  const coordination = f.store.list("tasks").find(t => t.kind === "coordination" && t.coordinationOf === task.id);
  assert(coordination);
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", coordination.id), status: "succeeded" }));
  f.engine.scheduleRepair(f.store.require("tasks", task.id), "Synthetic technical failure");
  assert.equal(f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === task.id).length, 1);
  assert.equal(f.store.require("tasks", task.id).status, "blocked");
  assert.equal(f.store.list("interactions").filter(i => i.taskId === task.id && i.status === "pending").length, 1);
});

async function repairCoordination(f, task) {
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), repairs: f.company.policy().maxReworks }));
  f.engine.scheduleRepair(f.store.require("tasks", task.id), "Synthetic technical failure");
  const coordination = f.store.list("tasks").find(t => t.kind === "coordination" && t.coordinationOf === task.id);
  assert(coordination, "coordination was not created");
  return coordination;
}

function claimCoordination(f, coordination, agentId = "manager", role = "manager") {
  const attempt = { id: randomUUID(), taskId: coordination.id, goalId: coordination.goalId, agentId, role, kind: "coordination", taskGeneration: coordination.generation, grants: f.store.require("agents", agentId).grants, status: "running", startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", attempt); f.store.put("tasks", { ...f.store.require("tasks", coordination.id), status: "running", activeAttemptId: attempt.id }); });
  return attempt;
}

test("coordination keeps an owner pause on direct release and re-split", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const direct = f.task({ title: "Paused direct coordination" });
  const c1 = await repairCoordination(f, direct);
  f.command("task.pause", { id: direct.id });
  assert.equal(f.store.require("tasks", direct.id).status, "paused");
  await f.engine.accept(claimCoordination(f, c1), { outcome: "coordinated", summary: "保留原分派并恢复" }, { throwIfAborted() {} });
  const released = f.store.require("tasks", direct.id);
  assert.equal(released.status, "paused");
  assert.equal(released.blocker, null);

  const split = f.task({ title: "Paused re-split coordination" });
  const c2 = await repairCoordination(f, split);
  f.command("task.pause", { id: split.id });
  await f.engine.accept(claimCoordination(f, c2), { outcome: "planned", rationale: "拆分返工任务", summary: "拆分", tasks: [{ key: "fix", title: "Fix paused branch", description: "Fix", acceptance: "Fixed", dependencies: [] }] }, { throwIfAborted() {} });
  const splitSource = f.store.require("tasks", split.id);
  assert.equal(splitSource.status, "paused");
  assert.equal(splitSource.blocker.kind, "coordination");
  const rework = f.store.list("tasks").find(t => t.parentId === c2.id && t.kind === "work");
  assert(rework);
  assert(splitSource.dependencies.includes(rework.id));
});

test("coordinated result re-checks manager role and current grants", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const task = f.task({ title: "Revoked manager coordination" });
  const coordination = await repairCoordination(f, task);
  const attempt = claimCoordination(f, coordination);
  f.command("agent.save", { id: "manager", grants: [] });
  await assert.rejects(f.engine.accept(attempt, { outcome: "coordinated", summary: "仍要释放源任务" }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  assert.equal(f.store.require("tasks", task.id).status, "blocked");
  assert.equal(f.store.require("tasks", coordination.id).status, "running");

  f.command("agent.save", { id: "manager", grants: ["task.create", "task.edit", "task.dependencies", "agent.save", "workflow.publish", "task.retry"] });
  const worker = f.command("agent.save", { name: "Zero grant worker", role: "worker", grants: [] });
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", coordination.id), agentId: worker.id, status: "ready", activeAttemptId: null }));
  const workerAttempt = claimCoordination(f, f.store.require("tasks", coordination.id), worker.id, "worker");
  await assert.rejects(f.engine.accept(workerAttempt, { outcome: "coordinated", summary: "worker decision" }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  await assert.rejects(f.engine.accept(workerAttempt, { outcome: "planned", rationale: "worker plan", summary: "worker split", tasks: [{ key: "x", title: "X", description: "d", acceptance: "a", dependencies: [] }] }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  assert.equal(f.store.require("tasks", task.id).status, "blocked");
});

test("coordination fallback ignores managers dedicated to another goal", async t => {
  const f = await fixture(t, async input => {
    if (input.task.kind === "review") return { outcome: "reviewed", decision: "changes_requested", summary: "需要返工", findings: ["跨目标检查"] };
    return defaultSimulation(input);
  });
  const otherGoal = f.command("goal.create", { title: "Other goal", description: "Other", acceptance: "Other", projectId: f.project.id, plan: false });
  const otherManager = f.command("agent.save", { name: "Other goal manager", role: "manager" }, { kind: "agent", id: "manager", goalId: otherGoal.id });
  f.command("agent.save", { id: "manager", status: "retired" });

  const repairTarget = f.task({ title: "No qualified manager repair" });
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", repairTarget.id), repairs: f.company.policy().maxReworks }));
  f.engine.scheduleRepair(f.store.require("tasks", repairTarget.id), "Synthetic technical failure");
  const source = f.store.require("tasks", repairTarget.id);
  assert.equal(source.status, "blocked");
  assert.equal(source.blocker.kind, "assignment");
  assert.equal(f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === repairTarget.id).length, 0);
  assert(f.store.list("interactions").some(i => i.taskId === repairTarget.id && i.status === "pending"));
  assert.equal(f.store.list("tasks").some(t => t.agentId === otherManager.id), false);

  const reviewTarget = f.task({ title: "No qualified manager review" });
  await f.start();
  await until(() => { const current = f.store.require("tasks", reviewTarget.id); return current.status === "blocked" && current.reworks === 1; }, 15000);
  const reviewed = f.store.require("tasks", reviewTarget.id);
  assert.equal(reviewed.blocker.kind, "assignment");
  assert.equal(f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === reviewTarget.id).length, 0);
  assert(f.store.list("interactions").some(i => i.taskId === reviewTarget.id && i.status === "pending"));
});

test("review rework ceiling blocks for the user instead of opening another coordination", async t => {
  let reviews = 0;
  const f = await fixture(t, async input => {
    if (input.task.kind === "review") { reviews++; return { outcome: "reviewed", decision: "changes_requested", summary: "Reject " + reviews, findings: ["Finding " + reviews] }; }
    if (input.task.kind === "coordination") return { outcome: "coordinated", summary: "再次返工" };
    return defaultSimulation(input);
  });
  const task = f.task({ title: "Rework ceiling" });
  await f.start();
  await until(() => { const current = f.store.require("tasks", task.id); return current.status === "blocked" && current.reviewLimitExceeded === true; }, 15000);
  const source = f.store.require("tasks", task.id);
  assert.equal(source.reworks, 3);
  assert.equal(source.blocker.kind, "reworks");
  assert.equal(reviews, 3);
  assert.equal(f.store.list("tasks").filter(t => t.kind === "coordination" && t.coordinationOf === task.id).length, 2);
  assert(f.store.list("interactions").some(i => i.taskId === task.id && i.status === "pending"));
});

test("coordination result cannot release a source already beyond the rework ceiling", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const task = f.task({ title: "Ceiling already exceeded" });
  const coordination = await repairCoordination(f, task);
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", task.id), reviewLimitExceeded: true }));
  await f.engine.accept(claimCoordination(f, coordination), { outcome: "coordinated", summary: "释放源任务" }, { throwIfAborted() {} });
  const source = f.store.require("tasks", task.id);
  assert.equal(source.status, "blocked");
  assert.equal(source.blocker.kind, "reworks");
  assert(f.store.list("interactions").some(i => i.taskId === task.id && i.status === "pending"));
});
test("coordinated and re-split decisions reject a manager retired during execution", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const direct = f.task({ title: "Retired manager direct release" });
  const directCoordination = await repairCoordination(f, direct);
  const directAttempt = claimCoordination(f, directCoordination);
  f.command("agent.save", { id: "manager", status: "retired" });
  await assert.rejects(f.engine.accept(directAttempt, { outcome: "coordinated", summary: "release" }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  assert.equal(f.store.require("tasks", direct.id).status, "blocked");
  assert.equal(f.store.require("tasks", directCoordination.id).status, "running");
  f.command("agent.save", { id: "manager", status: "available" });
  await f.engine.accept(directAttempt, { outcome: "coordinated", summary: "release" }, { throwIfAborted() {} });
  assert.equal(f.store.require("tasks", direct.id).status, "ready");
  const split = f.task({ title: "Retired manager re-split" });
  const splitCoordination = await repairCoordination(f, split);
  const splitAttempt = claimCoordination(f, splitCoordination);
  f.command("agent.save", { id: "manager", status: "retired" });
  await assert.rejects(f.engine.accept(splitAttempt, { outcome: "planned", rationale: "split", summary: "split", tasks: [{ key: "rework", title: "Rework", description: "Fix", acceptance: "Pass", dependencies: [] }] }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  assert.equal(f.store.require("tasks", split.id).status, "blocked");
  assert.equal(f.store.list("tasks").filter(item => item.parentId === splitCoordination.id).length, 0);
});

test("initial planning never picks a manager dedicated to another goal", async t => {
  const f = await fixture(t);
  const scoped = f.command("agent.save", { name: "Goal A manager", role: "manager" }, { kind: "agent", id: "manager", goalId: f.goal.id });
  assert.equal(scoped.goalId, f.goal.id);
  f.command("agent.save", { id: "manager", status: "retired" });
  assert.throws(() => f.command("goal.create", { title: "Goal B", description: "B", acceptance: "B", projectId: f.project.id }), { code: "MANAGER_REQUIRED" });
  assert.equal(f.store.list("goals").length, 1);
  assert.equal(f.store.list("tasks").filter(item => item.kind === "plan").length, 0);
});

test("plan acceptance re-checks the manager goal scope and current status", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const foreignGoal = f.command("goal.create", { title: "Foreign goal", description: "F", acceptance: "F", projectId: f.project.id, plan: false });
  const foreignManager = f.command("agent.save", { name: "Foreign manager", role: "manager" }, { kind: "agent", id: "manager", goalId: foreignGoal.id });
  const planned = f.command("goal.create", { title: "Planned goal", description: "P", acceptance: "P", projectId: f.project.id });
  const planTask = f.store.list("tasks").find(item => item.goalId === planned.id && item.kind === "plan");
  assert.equal(planTask.agentId, "manager");
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", planTask.id), agentId: foreignManager.id }));
  const outOfScope = await seedManagerAttempt(f, f.store.require("tasks", planTask.id), foreignManager.id);
  await assert.rejects(f.engine.accept(outOfScope, { outcome: "planned", rationale: "out of scope", summary: "out of scope", tasks: [{ key: "x", title: "X", description: "X", acceptance: "X", dependencies: [] }] }, { throwIfAborted() {} }), { code: "SCOPE_DENIED" });
  assert.equal(f.store.require("tasks", planTask.id).status, "running");
  assert.equal(f.store.list("plans").length, 0);
  assert.equal(f.store.list("tasks").filter(item => item.goalId === planned.id && item.kind === "work").length, 0);
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", planTask.id), agentId: "manager" }));
  const attempt = await seedManagerAttempt(f, f.store.require("tasks", planTask.id));
  f.command("agent.save", { id: "manager", status: "retired" });
  await assert.rejects(f.engine.accept(attempt, { outcome: "planned", rationale: "retired", summary: "retired", tasks: [{ key: "a", title: "A", description: "A", acceptance: "A", dependencies: [] }] }, { throwIfAborted() {} }), { code: "FORBIDDEN" });
  f.command("agent.save", { id: "manager", status: "available" });
  await f.engine.accept(attempt, { outcome: "planned", rationale: "valid", summary: "valid", tasks: [{ key: "a", title: "A", description: "A", acceptance: "A", dependencies: [] }] }, { throwIfAborted() {} });
  const plan = f.store.list("plans").find(item => item.taskId === planTask.id);
  assert(plan);
  assert.equal(f.store.list("tasks").filter(item => item.goalId === planned.id && item.kind === "work").length, 1);
});

test("managed batch rejects a manager scoped to another goal after manual reassignment", async t => {
  const f = await fixture(t);
  const other = f.command("goal.create", { title: "Other goal", description: "Other", acceptance: "Other", projectId: f.project.id, plan: false });
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const manager = f.command("agent.save", { name: "Goal A manager", role: "manager" }, { kind: "agent", id: "manager", goalId: f.goal.id });
  assert.equal(f.store.require("agents", manager.id).goalId, f.goal.id);
  const task = f.command("task.create", { goalId: other.id, title: "Foreign task", description: "Foreign", acceptance: "Foreign" });
  f.command("task.edit", { id: task.id, patch: { agentId: manager.id } });
  const assigned = f.store.require("tasks", task.id);
  const attempt = { id: randomUUID(), taskId: assigned.id, goalId: other.id, agentId: manager.id, role: "manager", kind: assigned.kind, taskGeneration: assigned.generation, grants: manager.grants, status: "running", startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put("attempts", attempt); f.store.put("tasks", { ...f.store.require("tasks", task.id), status: "running", activeAttemptId: attempt.id }); });
  await assert.rejects(f.engine.accept(attempt, { outcome: "managed", actionBatchId: "cross-goal-batch-v1", summary: "hijack", actions: [{ command: "task.edit", args: { id: task.id, patch: { title: "hijacked" } } }] }, { throwIfAborted() {} }), { code: "SCOPE_DENIED" });
  assert.equal(f.store.require("tasks", task.id).title, "Foreign task");
  assert.equal(f.store.list("actionBatches").length, 0);
});
test("manager contract decision log pages past a burst of ordinary events", async t => {
  const f = await fixture(t);
  const task = f.task({ agentId: "manager" });
  const attempt = await seedManagerAttempt(f, task);
  f.store.transaction(() => {
    for (let index = 0; index < 150; index += 1) f.store.event("noise.event", task.id, { index }, { kind: "system", id: "scheduler" });
    f.store.event("coordination.decided", task.id, { sourceTaskId: null, decision: { kind: "manager-decision", by: "manager", basis: "latest-window-decision" } }, { kind: "agent", id: "manager" });
  });
  const { promptFor } = await import("../src/runtime/prompt.js");
  const prompt = promptFor(f.company, f.store.require("tasks", task.id), f.store.require("attempts", attempt.id));
  const contract = JSON.parse(prompt.split("CONTRACT:\n")[1]);
  assert.equal(contract.decisionLog.at(-1).type, "coordination.decided");
  assert.equal(contract.decisionLog.at(-1).decision.basis, "latest-window-decision");
});
test("a failed coordination blocks without repair or nested coordination", async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const source = f.task({ title: "Source needing coordination" });
  let coordination;
  f.store.transaction(() => { coordination = createCoordination(f.company, source, { key: executorCoordinationKey(source.id, source.generation, "repair-limit"), feedbackHash: "d".repeat(64), reason: "fixture" }); });
  const attempt = claimCoordination(f, coordination);
  f.store.transaction(() => f.store.put("tasks", { ...f.store.require("tasks", coordination.id), attempts: f.company.policy().maxAttempts }));
  await f.engine.accept(attempt, { outcome: "blocked", kind: "technical", reason: "coordinator cannot finish" }, { throwIfAborted() {} });
  const saved = f.store.require("tasks", coordination.id);
  assert.equal(saved.status, "blocked");
  assert.equal(saved.blocker.kind, "technical");
  assert.equal(f.store.list("tasks").filter(t => t.kind === "coordination").length, 1);
  assert.equal(f.store.list("tasks").filter(t => t.repairOf === coordination.id).length, 0);
  assert.equal(f.store.list("interactions").filter(i => i.taskId === coordination.id && i.status === "pending").length, 1);
  assert.throws(() => f.store.transaction(() => createCoordination(f.company, saved, { key: "nested-coordination-key", feedbackHash: "e".repeat(64), reason: "nested" })), { code: "COORDINATION_RECURSION" });
});
