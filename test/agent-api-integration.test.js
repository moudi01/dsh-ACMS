// Real HTTP + temporary SQLite + the real review state machine; the adapter is simulated.
// This file exercises integration wiring only and is NOT real-model execution evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, until } from "./helpers.js";
import { defaultSimulation } from "../src/adapters/simulated.js";
import { createAgentApi } from "../src/host/agent-api.js";

async function apiOver(f, t) {
  const api = createAgentApi({ dataDir: f.dataDir, company: f.company, store: f.store, adapter: f.adapter, engine: f.engine, workspaces: f.workspaces });
  await api.start();
  t.after(() => api.close());
  return api;
}

async function get(api, pathname, token) {
  const response = await fetch(api.baseUrl + pathname, { headers: { authorization: "Bearer " + token } });
  return { status: response.status, body: await response.json() };
}

function reader(f) {
  return f.command("agentCredential.create", { name: "Integration reader", projectIds: [f.project.id], goalIds: [f.goal.id] });
}

test("GET /status returns persisted model preferences identical to the UI snapshot", async t => {
  const f = await fixture(t);
  const api = await apiOver(f, t);
  const token = reader(f).token;
  const empty = await get(api, "/status?goalId=" + encodeURIComponent(f.goal.id), token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.value.modelPreferences, f.company.snapshot().modelPreferences);
  assert.deepEqual(empty.body.value.modelPreferences.order, []);
  f.command("model.preferences.set", { order: [
    { id: "pref_first", model: "deepseek-flash", provider: "spawn", llmProvider: "deepseek", reasoningEffort: "high", label: "First" },
    { id: "pref_second", model: "deepseek-pro", provider: "spawn", llmProvider: "deepseek" }
  ] });
  const saved = await get(api, "/status?goalId=" + encodeURIComponent(f.goal.id), token);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.value.modelPreferences, f.company.snapshot().modelPreferences);
  assert.deepEqual(saved.body.value.modelPreferences.order.map(item => item.id), ["pref_first", "pref_second"]);
  assert.equal(saved.body.value.modelPreferences.revision, 1);
  f.command("model.preferences.clear", {});
  const cleared = await get(api, "/status?goalId=" + encodeURIComponent(f.goal.id), token);
  assert.deepEqual(cleared.body.value.modelPreferences, f.company.snapshot().modelPreferences);
  assert.deepEqual(cleared.body.value.modelPreferences.order, []);
  assert.equal(cleared.body.value.modelPreferences.revision, 2);
  assert.equal(f.adapter.calls.length, 0);
});

test("GET /status exposes the same current contract and historical evidence as the UI snapshot", async t => {
  const f = await fixture(t);
  const api = await apiOver(f, t);
  const token = reader(f).token;
  const task = f.task();
  await f.start();
  await until(() => f.store.require("goals", task.goalId).status === "succeeded");
  f.command("company.pause", { afterCurrent: true });
  f.command("goal.edit", { id: task.goalId, patch: { acceptance: "Revised acceptance" } });
  const response = await get(api, "/status?goalId=" + encodeURIComponent(task.goalId), token);
  assert.equal(response.status, 200);
  const { goal, tasks, verifications } = response.body.value;
  const snapshot = f.company.snapshot().goals.find(row => row.id === task.goalId);
  for (const field of ["status", "contractVersion", "completedContractVersion", "contractChange", "deliveryHash"]) {
    assert.deepEqual(goal[field], snapshot[field]);
  }
  assert.equal(goal.status, "active");
  assert.equal(goal.contractVersion, 2);
  assert.equal(goal.completedContractVersion, 1);
  assert.equal(tasks.find(row => row.id === task.id).goalContractVersion, 1);
  assert.equal(verifications.find(row => row.taskId === task.id).goalContractVersion, 1);
});

test("GET /reviews returns real approve and changes-requested conclusions", async t => {
  let reviews = 0;
  const handler = async input => {
    if (input.task.kind !== "review") return defaultSimulation(input);
    reviews += 1;
    if (reviews === 1) return { outcome: "reviewed", decision: "changes_requested", summary: "Add explanation", findings: ["Missing context"] };
    return { outcome: "reviewed", decision: "approve", summary: "Approved after rework" };
  };
  const f = await fixture(t, handler);
  const api = await apiOver(f, t);
  const token = reader(f).token;
  const task = f.task();
  await f.start();
  await until(() => f.store.require("tasks", task.id).status === "succeeded", 15000);
  f.command("review.request", { id: task.id });
  await until(() => f.store.list("verifications").some(v => v.kind === "review" && v.passed === false), 15000);
  f.command("review.request", { id: task.id });
  await until(() => f.store.list("verifications").some(v => v.kind === "review" && v.passed === true), 15000);
  const response = await get(api, "/reviews?goalId=" + encodeURIComponent(f.goal.id), token);
  assert.equal(response.status, 200);
  const value = response.body.value;
  assert.ok(value.reviews.length >= 2);
  assert.ok(value.verifications.length >= 2);
  const rejected = value.verifications.find(item => item.passed === false);
  assert.ok(rejected, "changes_requested conclusion is missing");
  assert.equal(rejected.summary, "Add explanation");
  assert.equal(rejected.taskId, task.id);
  assert.ok(rejected.reviewTaskId);
  assert.ok(value.reviews.some(item => item.id === rejected.reviewTaskId));
  const approved = value.verifications.find(item => item.passed === true && item.summary === "Approved after rework");
  assert.ok(approved, "approve conclusion is missing");
  assert.equal(approved.taskId, task.id);
  assert.ok(approved.reviewTaskId);
  assert.ok(value.reviews.some(item => item.id === approved.reviewTaskId));
  assert.notEqual(rejected.reviewTaskId, approved.reviewTaskId);
  for (const item of value.verifications) assert.ok(value.reviews.some(review => review.id === item.reviewTaskId));
  const reviewDetail = await get(api, "/tasks/" + approved.reviewTaskId, token);
  assert.equal(reviewDetail.status, 200);
  const reviewVerification = reviewDetail.body.value.verifications.find(item => item.id === approved.id);
  assert.ok(reviewVerification, "review task detail is missing its verification");
  assert.equal(reviewVerification.passed, true);
  assert.equal(reviewVerification.reviewTaskId, approved.reviewTaskId);
});
