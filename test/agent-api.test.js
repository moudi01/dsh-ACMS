// Test fixtures use temporary SQLite and a stub adapter; they are NOT real model execution evidence.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/core/store.js";
import { Company } from "../src/core/domain.js";
import { createAgentApi } from "../src/host/agent-api.js";
import { createRoutes } from "../src/host/http.js";
import { OWNER } from "../src/core/util.js";

async function apiFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acms-agent-api-"));
  const source = path.join(root, "source"); const dataDir = path.join(root, "data");
  await mkdir(source); await writeFile(path.join(source, "README.md"), "# agent API fixture\n");
  const store = new Store(path.join(dataDir, "company.db")); const company = new Company(store);
  const calls = { choose: 0, modelDetails: 0, probeModel: 0, modelCatalog: 0, kick: 0 };
  const adapter = {
    choose() { calls.choose += 1; return {}; },
    modelDetails() { calls.modelDetails += 1; return {}; },
    probeModel() { calls.probeModel += 1; return {}; },
    modelCatalog() { calls.modelCatalog += 1; return { models: [], defaultSelection: null, warnings: [] }; },
    providers() { return []; },
  };
  const engine = { closing: false, kick() { calls.kick += 1; } };
  const workspaces = { async validateProject(project) { return project; }, async publishProject() { } };
  const runtime = { dataDir, company, store, adapter, engine, workspaces };
  const api = createAgentApi(runtime);
  await api.start();
  const owner = (name, args) => company.command(OWNER, randomUUID(), name, args);
  const project = owner("project.save", { name: "Agent project", repoRoot: source, mode: "copy", checks: [] });
  const goal = owner("goal.create", { title: "Owner goal", description: "Owner goal", acceptance: "Fixture", projectId: project.id, plan: false });
  const otherProject = owner("project.save", { name: "Other project", repoRoot: source, mode: "copy", checks: [] });
  const otherGoal = owner("goal.create", { title: "Other goal", description: "Other goal", acceptance: "Fixture", projectId: otherProject.id, plan: false });
  const created = [];
  const credential = (args = {}) => { const value = owner("agentCredential.create", { name: "Agent " + (created.length + 1), projectIds: [project.id], ...args }); created.push(value); return value; };
  async function call(pathname, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.token) headers.authorization = "Bearer " + options.token;
    if (options.key) headers["idempotency-key"] = options.key;
    let body;
    if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body); }
    const response = await fetch(api.baseUrl + pathname, { method: options.method ?? "GET", headers, body });
    const payload = await response.json();
    return { status: response.status, body: payload, headers: response.headers };
  }
  let closed = false;
  async function close() { if (closed) return; closed = true; try { await api.close(); } catch { } try { store.close(); } catch { } await rm(root, { recursive: true, force: true }); }
  t.after(close);
  return { root, source, dataDir, store, company, adapter, engine, calls, api, runtime, owner, project, goal, otherProject, otherGoal, credential, created, call, close };
}

function rawRequest(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: options.method ?? "GET", headers: options.headers ?? {} }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: response.headers }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function blockTask(f, task) {
  f.store.transaction(() => {
    const current = f.store.require("tasks", task.id);
    f.store.put("tasks", { ...current, status: "blocked", blocker: { kind: "question", reason: "Need a decision" } });
    return f.store.put("interactions", { id: "interaction_" + randomUUID(), taskId: task.id, kind: "question", question: "Which option should be used?", status: "pending", taskGeneration: current.generation });
  });
  return f.store.list("interactions").find(item => item.taskId === task.id && item.status === "pending");
}

const CONTROL_COMMANDS = ["goal.submit", "status.read", "events.read", "interaction.answer", "task.pause", "task.resume"];

test("serves a versioned discovery contract and scoped read endpoints without model calls", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id] });
  const discover = await f.call("/discover", { token: c.token });
  assert.equal(discover.status, 200);
  assert.equal(discover.body.apiVersion, "1.0");
  assert.equal(discover.body.value.contractVersion, 1);
  assert.equal(discover.headers.get("x-acms-api-version"), "1.0");
  assert.ok(discover.headers.get("x-acms-request-id"));
  assert.equal(discover.headers.get("cache-control"), "no-store");
  assert.equal((await f.call("/discover")).status, 401);
  const projects = await f.call("/projects", { token: c.token });
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.value.projects.map(item => item.id), [f.project.id]);
  const goals = await f.call("/goals", { token: c.token });
  assert.deepEqual(goals.body.value.goals.map(item => item.id), [f.goal.id]);
  const status = await f.call("/status?goalId=" + f.goal.id, { token: c.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.value.goal.id, f.goal.id);
  assert.deepEqual(status.body.value.modelPreferences, { id: "model", order: [], revision: 0, updatedAt: null, updatedBy: null });
  assert.equal((await f.call("/tasks?goalId=" + f.goal.id, { token: c.token })).status, 200);
  assert.equal((await f.call("/reviews?goalId=" + f.goal.id, { token: c.token })).status, 200);
  const blockers = await f.call("/blockers?goalId=" + f.goal.id, { token: c.token });
  assert.equal(blockers.body.value.count, 0);
  const events = await f.call("/events?goalId=" + f.goal.id, { token: c.token });
  assert.equal(events.status, 200);
  assert.ok(events.body.value.entries.length > 0);
  const lastSeq = Math.max(...events.body.value.entries.map(entry => entry.seq));
  assert.ok(events.body.value.nextCursor >= lastSeq);
  assert.equal(events.body.value.entries[0].actor.kind, "owner");
  assert.equal(f.calls.choose, 0); assert.equal(f.calls.modelDetails, 0); assert.equal(f.calls.probeModel, 0); assert.equal(f.calls.modelCatalog, 0); assert.equal(f.calls.kick, 0);
});

test("rejects missing, invalid, expired, and forged identities without business effects", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id] });
  assert.equal((await f.call("/status?goalId=" + f.goal.id)).status, 401);
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: "acms_ag_invalid" })).status, 401);
  const expires = new Date(Date.now() + 60000).toISOString();
  const expiring = f.credential({ goalIds: [f.goal.id], expiresAt: expires });
  const goalsBefore = f.store.list("goals").length;
  const eventsBefore = f.store.cursor();
  const forgedActor = await f.call("/goals", { method: "POST", token: c.token, key: "forge-key-0001", body: { title: "x", description: "y", acceptance: "z", projectId: f.project.id, actor: { kind: "owner", id: "owner" } } });
  assert.equal(forgedActor.status, 400);
  assert.equal(forgedActor.body.error.code, "INVALID_REQUEST");
  const forgedGrant = await f.call("/goals", { method: "POST", token: c.token, key: "forge-key-0002", body: { title: "x", description: "y", acceptance: "z", projectId: f.project.id, grants: ["task.create"] } });
  assert.equal(forgedGrant.status, 400);
  assert.equal(f.store.list("goals").length, goalsBefore);
  f.store.transaction(() => { const current = f.store.require("agentCredentials", expiring.credential.id); f.store.put("agentCredentials", { ...current, expiresAt: new Date(Date.now() - 1000).toISOString() }); });
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: expiring.token })).status, 401);
  assert.equal(f.store.list("goals").length, goalsBefore);
  assert.ok(f.store.cursor() >= eventsBefore);
});

test("denies cross goal and project access with stable error codes", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const crossGoal = await f.call("/status?goalId=" + f.otherGoal.id, { token: c.token });
  assert.equal(crossGoal.status, 403);
  assert.equal(crossGoal.body.error.code, "SCOPE_DENIED");
  const crossProject = await f.call("/projects/" + f.otherProject.id, { token: c.token });
  assert.equal(crossProject.status, 403);
  assert.equal(crossProject.body.error.code, "SCOPE_DENIED");
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Readable", description: "visible", acceptance: "visible" });
  const otherTask = f.owner("task.create", { goalId: f.otherGoal.id, title: "Hidden", description: "hidden", acceptance: "hidden" });
  assert.equal((await f.call("/tasks/" + task.id, { token: c.token })).status, 200);
  const hidden = await f.call("/tasks/" + otherTask.id, { token: c.token });
  assert.equal(hidden.status, 403);
  assert.equal(hidden.body.error.code, "SCOPE_DENIED");
  assert.equal((await f.call("/tasks/task_missing", { token: c.token })).status, 404);
  const write = await f.call("/tasks/" + otherTask.id + "/pause", { method: "POST", token: c.token, key: "scope-write-001", body: {} });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, "SCOPE_DENIED");
});

test("validates credential scope and redacts secrets in the snapshot", async t => {
  const f = await apiFixture(t);
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [] }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: ["project_missing"] }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [f.project.id], goalIds: [f.otherGoal.id] }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [f.project.id], goalIds: ["goal_missing"] }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [f.project.id], allGoals: true }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [f.project.id], projectCreate: true }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.create", { name: "Bad", projectIds: [f.project.id], commands: ["task.create"] }), { code: "INVALID_INPUT" });
  const monitor = f.owner("agentCredential.create", { name: "Monitor", projectIds: [f.project.id], allGoals: true, commands: ["status.read", "events.read"] });
  assert.equal(monitor.credential.scope.allGoals, true);
  const snapshot = f.company.snapshot();
  assert.ok(snapshot.agentCredentials.length >= 1);
  assert.ok(snapshot.agentCredentials.every(item => item.tokenHash === undefined));
  assert.ok(snapshot.agentCredentials.some(item => item.id === monitor.credential.id));
  const agent = { kind: "agent", id: "manager", goalId: f.goal.id };
  assert.throws(() => f.company.command(agent, randomUUID(), "agentCredential.create", { name: "Nope", projectIds: [f.project.id] }), { code: "FORBIDDEN" });
  const monitorStatus = await f.call("/status?goalId=" + f.goal.id, { token: monitor.token });
  assert.equal(monitorStatus.status, 200);
  const monitorWrite = await f.call("/goals", { method: "POST", token: monitor.token, key: "monitor-write-01", body: { title: "x", description: "y", acceptance: "z", projectId: f.project.id } });
  assert.equal(monitorWrite.status, 403);
});

test("updates scope in place and revokes credentials", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [] });
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: c.token })).status, 403);
  const added = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: c.credential.revision, goalIds: [f.goal.id] });
  assert.equal(added.credential.revision, c.credential.revision + 1);
  assert.equal(added.credential.tokenPrefix, c.credential.tokenPrefix);
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: c.token })).status, 200);
  assert.throws(() => f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: c.credential.revision, goalIds: [] }), { code: "REVISION_CONFLICT" });
  assert.throws(() => f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: added.credential.revision, goalIds: ["goal_missing"] }), { code: "INVALID_INPUT" });
  assert.throws(() => f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: added.credential.revision, allGoals: true }), { code: "INVALID_INPUT" });
  const revoked = f.owner("agentCredential.revoke", { credentialId: c.credential.id, expectedRevision: added.credential.revision });
  assert.equal(revoked.credential.status, "revoked");
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: c.token })).status, 401);
  assert.throws(() => f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revoked.credential.revision, goalIds: [] }), { code: "INVALID_TRANSITION" });
});

test("submits goals idempotently across header and body keys", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const goalsBefore = f.store.list("goals").length;
  const body = { title: "External goal", description: "Submitted by agent", acceptance: "Done", projectId: f.project.id, constraints: [{ key: "scope", text: "Fixture only" }], priority: 3 };
  const first = await f.call("/goals", { method: "POST", token: c.token, key: "submit-key-0001", body });
  assert.equal(first.status, 200);
  assert.equal(first.body.value.goalId.startsWith("goal_"), true);
  assert.ok(first.body.value.planTaskId);
  assert.equal(first.body.replayed, false);
  const retry = await f.call("/goals", { method: "POST", token: c.token, body: { ...body, requestId: "submit-key-0001" } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.value.goalId, first.body.value.goalId);
  assert.equal(f.store.list("goals").length, goalsBefore + 1);
  const goal = f.store.require("goals", first.body.value.goalId);
  assert.equal(goal.source.requestId, "submit-key-0001");
  assert.equal(goal.source.kind, "user-agent");
  assert.deepEqual(goal.constraints, [{ key: "scope", text: "Fixture only" }]);
  assert.equal(goal.priority, 3);
  const events = f.store.pageScoped({ after: 0, goalIds: [goal.id] }).entries;
  assert.ok(events.some(entry => entry.type === "goal.submitted" && entry.actor.kind === "user-agent" && entry.onBehalfOf?.id === "owner" && entry.decision?.kind === "user-constraint"));
  assert.ok(events.every(entry => entry.actor.id !== "owner"));
  const mismatch = await f.call("/goals", { method: "POST", token: c.token, key: "submit-key-0002", body: { ...body, requestId: "submit-key-0003" } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "IDEMPOTENCY_KEY_MISMATCH");
  const missing = await f.call("/goals", { method: "POST", token: c.token, body });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "IDEMPOTENCY_REQUIRED");
  for (const key of ["abcdefgh", "a".repeat(200)]) {
    const valid = await f.call("/goals", { method: "POST", token: c.token, key, body: { ...body, title: "Length " + key.length } });
    assert.equal(valid.status, 200);
  }
  for (const key of ["abcdefg", "a".repeat(201)]) {
    const invalid = await f.call("/goals", { method: "POST", token: c.token, key, body: { ...body, title: "Invalid header key" } });
    assert.equal(invalid.status, 400);
  }
  for (const key of ["abcdefg", "a".repeat(201), "abcdefg ", "abcdefg中", "abcdefg\n", "abcdefg\t"]) {
    const invalid = await f.call("/goals", { method: "POST", token: c.token, body: { ...body, title: "Invalid body key", requestId: key } });
    assert.equal(invalid.status, 400);
  }
  const duplicate = await rawRequest(f.api.baseUrl, "/goals", { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json", "idempotency-key": ["dup-key-0001", "dup-key-0002"] }, body: JSON.stringify({ ...body, title: "Duplicate header" }) });
  assert.equal(duplicate.status, 400);
});

test("keeps idempotency namespaces per credential and rejects key reuse conflicts", async t => {
  const f = await apiFixture(t);
  const a = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const b = f.credential({ commands: CONTROL_COMMANDS });
  const body = { title: "Shared key", description: "shared", acceptance: "shared", projectId: f.project.id };
  const first = await f.call("/goals", { method: "POST", token: a.token, key: "shared-key-0001", body });
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  const second = await f.call("/goals", { method: "POST", token: b.token, key: "shared-key-0001", body });
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, false);
  assert.notEqual(first.body.value.goalId, second.body.value.goalId);
  const conflict = await f.call("/goals", { method: "POST", token: a.token, key: "shared-key-0001", body: { ...body, title: "Changed" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Pause me", description: "x", acceptance: "x" });
  const operation = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: a.token, key: "shared-key-0001", body: {} });
  assert.equal(operation.status, 409);
  assert.equal(operation.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("revalidates current authorization before replay and never returns stale results", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Pause me", description: "x", acceptance: "x" });
  const key = "auth-change-key-01";
  const paused = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.replayed, false);
  assert.equal(f.store.require("tasks", task.id).status, "paused");
  let revision = c.credential.revision;
  revision = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revision, projectIds: [f.project.id] }).credential.revision;
  const replay = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  revision = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revision, commands: ["goal.submit", "status.read", "events.read", "interaction.answer", "task.resume"] }).credential.revision;
  const forbidden = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");
  revision = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revision, commands: CONTROL_COMMANDS }).credential.revision;
  const replayAgain = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(replayAgain.status, 200);
  assert.equal(replayAgain.body.replayed, true);
  revision = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revision, goalIds: [] }).credential.revision;
  const denied = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "SCOPE_DENIED");
  const restored = f.owner("agentCredential.updateScope", { credentialId: c.credential.id, expectedRevision: revision, goalIds: [f.goal.id] });
  revision = restored.credential.revision;
  const replayFinal = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(replayFinal.status, 200);
  assert.equal(replayFinal.body.replayed, true);
  f.owner("agentCredential.revoke", { credentialId: c.credential.id, expectedRevision: revision });
  const revoked = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key, body: {} });
  assert.equal(revoked.status, 401);
  assert.equal(f.store.page(0, 1000).entries.filter(entry => entry.type === "task.paused.requested" && entry.entityId === task.id).length, 1);
});

test("requires synchronous precheck for external writes and rolls back rejected checks", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const external = { kind: "user-agent", id: c.credential.id, onBehalfOf: { kind: "user", id: "owner" } };
  assert.throws(() => f.store.command(external, "direct-key-0001", "goal.submit", {}, () => ({ ok: true })), { code: "PRECHECK_REQUIRED" });
  assert.throws(() => f.store.command(external, "direct-key-0002", "goal.submit", {}, () => ({ ok: true }), { precheck: () => Promise.resolve() }), { code: "ASYNC_TRANSACTION" });
  const cursorBefore = f.store.cursor();
  assert.throws(() => f.store.command(external, "direct-key-0003", "goal.submit", {}, () => ({ ok: true }), { precheck: () => { throw new Error("denied"); } }));
  assert.equal(f.store.cursor(), cursorBefore);
  assert.equal(f.store.db.prepare("SELECT id FROM commands WHERE id=?").get("direct-key-0003"), undefined);
  const value = f.store.command(external, "direct-key-0003", "goal.submit", {}, () => ({ ok: true, id: "goal_manual" }), { precheck: () => { } });
  assert.equal(value.ok, true);
  const ownerProject = f.company.command(OWNER, randomUUID(), "project.save", { name: "Owner project", repoRoot: f.source, mode: "copy", checks: [] });
  assert.ok(ownerProject.id);
});

test("serializes concurrent retries with a single business effect", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const body = { title: "Concurrent", description: "concurrent", acceptance: "concurrent", projectId: f.project.id };
  const goalsBefore = f.store.list("goals").length;
  const [a, b] = await Promise.all([f.call("/goals", { method: "POST", token: c.token, key: "concurrent-key-01", body }), f.call("/goals", { method: "POST", token: c.token, key: "concurrent-key-01", body })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal([a, b].filter(item => item.body.replayed === true).length, 1);
  assert.equal(f.store.list("goals").length, goalsBefore + 1);
  assert.equal(a.body.value.goalId, b.body.value.goalId);
});

test("keeps cursor semantics for incremental event reads", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id] });
  f.owner("task.create", { goalId: f.goal.id, title: "Event task", description: "x", acceptance: "x" });
  f.owner("task.create", { goalId: f.otherGoal.id, title: "Other event task", description: "x", acceptance: "x" });
  const start = (await f.call("/events?goalId=" + f.goal.id + "&after=0", { token: c.token })).body.value;
  const emptyPage = await f.call("/events?goalId=" + f.goal.id + "&after=" + start.nextCursor, { token: c.token });
  assert.equal(emptyPage.status, 200);
  assert.deepEqual(emptyPage.body.value.entries, []);
  assert.equal(emptyPage.body.value.nextCursor, start.nextCursor);
  const ahead = await f.call("/events?goalId=" + f.goal.id + "&after=" + (f.store.cursor() + 10), { token: c.token });
  assert.equal(ahead.status, 400);
  assert.equal(ahead.body.error.code, "CURSOR_AHEAD");
  const invalid = await f.call("/events?goalId=" + f.goal.id + "&after=abc", { token: c.token });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "CURSOR_INVALID");
  const negative = await f.call("/events?goalId=" + f.goal.id + "&after=-1", { token: c.token });
  assert.equal(negative.status, 400);
  const cursor = f.store.cursor();
  const pending = f.call("/events?goalId=" + f.goal.id + "&after=" + cursor + "&wait=2000", { token: c.token });
  setTimeout(() => f.owner("task.create", { goalId: f.goal.id, title: "Late event", description: "x", acceptance: "x" }), 50);
  const waited = await pending;
  assert.ok(waited.body.value.entries.length > 0);
  const limited = await f.call("/events?goalId=" + f.goal.id + "&after=0&limit=1", { token: c.token });
  assert.equal(limited.body.value.entries.length, 1);
  assert.ok(limited.body.value.hasMore === true || limited.body.value.nextCursor <= limited.body.value.latestCursor);
});

test("restores idempotency records and cursor after a host restart", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const body = { title: "Restart goal", description: "restart", acceptance: "restart", projectId: f.project.id };
  const first = await f.call("/goals", { method: "POST", token: c.token, key: "restart-key-0001", body });
  assert.equal(first.status, 200);
  const goalsBefore = f.store.list("goals").length;
  const cursorBefore = f.store.cursor();
  await f.api.close();
  f.store.close();
  const store = new Store(path.join(f.dataDir, "company.db"));
  const company = new Company(store);
  const api = createAgentApi({ dataDir: f.dataDir, company, store, engine: { kick() { } }, adapter: {}, workspaces: {} });
  await api.start();
  try {
    const response = await fetch(api.baseUrl + "/goals", { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json", "idempotency-key": "restart-key-0001" }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.replayed, true);
    assert.equal(payload.value.goalId, first.body.value.goalId);
    assert.equal(store.list("goals").length, goalsBefore);
    assert.ok(store.cursor() >= cursorBefore);
    const events = await fetch(api.baseUrl + "/events?goalId=" + first.body.value.goalId + "&after=0", { headers: { authorization: "Bearer " + c.token } }).then(item => item.json());
    assert.ok(events.value.entries.length > 0);
    const auth = await fetch(api.baseUrl + "/status?goalId=" + first.body.value.goalId, { headers: { authorization: "Bearer " + c.token } });
    assert.equal(auth.status, 200);
  } finally { await api.close(); store.close(); }
});

test("creates projects only with explicit project.create authorization", async t => {
  const f = await apiFixture(t);
  const readOnly = f.credential();
  const denied = await f.call("/projects", { method: "POST", token: readOnly.token, key: "project-key-0001", body: { name: "Nope", repoRoot: f.source } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  const creator = f.credential({ projectCreate: true, commands: ["status.read", "events.read", "project.create", "goal.submit"] });
  const created = await f.call("/projects", { method: "POST", token: creator.token, key: "project-key-0002", body: { name: "Agent project", repoRoot: f.source, mode: "copy" } });
  assert.equal(created.status, 200);
  const projectId = created.body.value.projectId;
  const project = f.store.require("projects", projectId);
  assert.equal(project.autoMerge, false);
  assert.deepEqual(project.checks, []);
  assert.equal(project.source.principalId, creator.credential.id);
  const replay = await f.call("/projects", { method: "POST", token: creator.token, body: { name: "Agent project", repoRoot: f.source, mode: "copy", requestId: "project-key-0002" } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.value.projectId, projectId);
  const forbiddenField = await f.call("/projects", { method: "POST", token: creator.token, key: "project-key-0003", body: { name: "Bad", repoRoot: f.source, autoMerge: true } });
  assert.equal(forbiddenField.status, 400);
  const selfGoal = await f.call("/goals", { method: "POST", token: creator.token, key: "project-goal-0001", body: { title: "Self goal", description: "x", acceptance: "x", projectId } });
  assert.equal(selfGoal.status, 200);
  const otherCred = f.credential({ projectCreate: true, commands: ["status.read", "events.read", "project.create", "goal.submit"] });
  const otherGoal = await f.call("/goals", { method: "POST", token: otherCred.token, key: "project-goal-0002", body: { title: "Other", description: "x", acceptance: "x", projectId } });
  assert.equal(otherGoal.status, 403);
  assert.equal(otherGoal.body.error.code, "SCOPE_DENIED");
});

test("answers pending interactions without crossing budget boundaries", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Blocked task", description: "x", acceptance: "x" });
  const interaction = blockTask(f, task);
  const blockers = await f.call("/blockers?goalId=" + f.goal.id, { token: c.token });
  assert.equal(blockers.body.value.count, 1);
  assert.equal(blockers.body.value.blockers[0].id, interaction.id);
  const budget = await f.call("/interactions/" + interaction.id + "/answer", { method: "POST", token: c.token, key: "answer-budget-01", body: { answer: "more", additionalRuntimeMs: 1000 } });
  assert.equal(budget.status, 403);
  assert.equal(budget.body.error.code, "OWNER_REQUIRED");
  const answered = await f.call("/interactions/" + interaction.id + "/answer", { method: "POST", token: c.token, key: "answer-key-0001", body: { answer: "Use option A", expectedRevision: interaction.revision } });
  assert.equal(answered.status, 200);
  assert.equal(f.store.require("interactions", interaction.id).status, "answered");
  assert.equal(f.store.require("tasks", task.id).status, "ready");
  const replay = await f.call("/interactions/" + interaction.id + "/answer", { method: "POST", token: c.token, body: { answer: "Use option A", expectedRevision: interaction.revision, requestId: "answer-key-0001" } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const again = await f.call("/interactions/" + interaction.id + "/answer", { method: "POST", token: c.token, key: "answer-key-0002", body: { answer: "Again", expectedRevision: interaction.revision } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "ALREADY_ANSWERED");
});

test("goal controls require explicit scope and revision, replay once, and audit the external actor", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: ["status.read", "goal.pause", "goal.resume", "goal.cancel"] });
  const ungranted = f.credential({ goalIds: [f.goal.id] });
  const sameProject = f.owner("goal.create", { title: "Other goal in same project", description: "Fixture", acceptance: "Fixture", projectId: f.project.id, plan: false });
  const post = (goal, action, token, key, body) => f.call("/goals/" + goal.id + "/" + action, { method: "POST", token, key, body });
  const data = { expectedRevision: f.goal.revision, afterCurrent: true, reason: "Checkpoint" };
  assert.equal((await post(f.goal, "pause", ungranted.token, "missing-grant-01", data)).body.error.code, "FORBIDDEN");
  assert.equal((await post(sameProject, "pause", c.token, "outside-scope-01", data)).body.error.code, "SCOPE_DENIED");
  assert.equal((await post(f.goal, "pause", c.token, "stale-revision-01", { ...data, expectedRevision: f.goal.revision + 1 })).body.error.code, "CONFLICT");
  assert.equal((await post(f.goal, "pause", c.token, "missing-revision-01", {})).status, 400);
  const paused = await post(f.goal, "pause", c.token, "goal-pause-0001", data);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.value.executionControl.mode, "after-current");
  const replay = await post(f.goal, "pause", c.token, "goal-pause-0001", data);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.value, paused.body.value);
  const audit = f.store.pageScoped({ goalIds: [f.goal.id] }).entries.filter(e => e.type === "goal.paused");
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].actor, { kind: "user-agent", id: c.credential.id });
  const resumed = await post(f.goal, "resume", c.token, "goal-resume-0001", { expectedRevision: paused.body.value.revision });
  assert.equal(resumed.body.value.executionControl, null);
  const cancelled = await post(f.goal, "cancel", c.token, "goal-cancel-0001", { expectedRevision: resumed.body.value.revision });
  assert.equal(cancelled.body.value.status, "cancelled");
  assert.equal((await post(f.goal, "resume", c.token, "goal-resume-0002", { expectedRevision: cancelled.body.value.revision })).status, 409);
  assert.equal(f.store.require("goals", sameProject.id).executionControl, undefined);
  assert.equal(f.calls.probeModel, 0);
});

test("pauses and resumes tasks within authorization", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Controlled", description: "x", acceptance: "x" });
  const paused = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, key: "pause-key-0001", body: { reason: "hold" } });
  assert.equal(paused.status, 200);
  assert.equal(f.store.require("tasks", task.id).status, "paused");
  const audit = f.store.page(0, 1000).entries.find(entry => entry.type === "task.paused.requested" && entry.entityId === task.id);
  assert.equal(audit.reason, "hold");
  const resumed = await f.call("/tasks/" + task.id + "/resume", { method: "POST", token: c.token, key: "resume-key-0001", body: {} });
  assert.equal(resumed.status, 200);
  assert.equal(f.store.require("tasks", task.id).status, "ready");
  const replay = await f.call("/tasks/" + task.id + "/pause", { method: "POST", token: c.token, body: { reason: "hold", requestId: "pause-key-0001" } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const blocked = f.owner("task.create", { goalId: f.goal.id, title: "Waiting", description: "x", acceptance: "x" });
  blockTask(f, blocked);
  const waiting = await f.call("/tasks/" + blocked.id + "/resume", { method: "POST", token: c.token, key: "resume-key-0002", body: {} });
  assert.equal(waiting.status, 409);
  assert.equal(waiting.body.error.code, "WAITING_INPUT");
  const closed = f.owner("task.create", { goalId: f.goal.id, title: "Done", description: "x", acceptance: "x" });
  f.store.transaction(() => { const current = f.store.require("tasks", closed.id); f.store.put("tasks", { ...current, status: "succeeded" }); });
  const closedResponse = await f.call("/tasks/" + closed.id + "/pause", { method: "POST", token: c.token, key: "pause-key-0002", body: {} });
  assert.equal(closedResponse.status, 409);
  assert.equal(closedResponse.body.error.code, "TASK_CLOSED");
});

test("ordinary management commands do not trigger implicit model diagnostics", async t => {
  const f = await apiFixture(t);
  const routes = createRoutes(f.runtime);
  const command = routes.find(route => route.path.endsWith("/command"));
  const response = await command.fetch(new Request("http://dsh/api/acms/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), name: "agent.save", args: { name: "Worker", role: "worker", reasoningEffort: "high" } }) }));
  assert.equal(response.status, 200);
  assert.equal(f.calls.modelDetails, 0);
  assert.equal(f.calls.probeModel, 0);
  assert.equal(f.calls.modelCatalog, 0);
  assert.equal(f.calls.choose, 0);
});

test("returns stable error envelopes for malformed requests", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const contentType = await rawRequest(f.api.baseUrl, "/goals", { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "text/plain", "idempotency-key": "error-key-0001" }, body: "not json" });
  assert.equal(contentType.status, 400);
  assert.equal(contentType.body.error.code, "CONTENT_TYPE");
  const malformed = await rawRequest(f.api.baseUrl, "/goals", { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json", "idempotency-key": "error-key-0004" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_REQUEST");
  const missingField = await f.call("/goals", { method: "POST", token: c.token, key: "error-key-0002", body: { title: "x" } });
  assert.equal(missingField.status, 400);
  assert.equal(missingField.body.error.code, "INVALID_REQUEST");
  const method = await f.call("/discover", { method: "POST", token: c.token });
  assert.equal(method.status, 405);
  const unknown = await f.call("/nope", { token: c.token });
  assert.equal(unknown.status, 404);
  const tooLarge = await rawRequest(f.api.baseUrl, "/goals", { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json", "idempotency-key": "error-key-0003" }, body: JSON.stringify({ title: "x".repeat(300000), description: "x", acceptance: "x", projectId: f.project.id }) });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.body.error.code, "BODY_LIMIT");
});

function runChild(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd: process.cwd() });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("CLI discovers, submits with a stable key, and replays", async t => {
  const f = await apiFixture(t);
  const c = f.credential();
  const discover = await runChild(["scripts/acms-agent.mjs", "discover", "--url", f.api.baseUrl, "--token", c.token]);
  assert.equal(discover.code, 0, discover.stderr);
  assert.equal(JSON.parse(discover.stdout).apiVersion, "1.0");
  const submitArgs = ["scripts/acms-agent.mjs", "submit", "--url", f.api.baseUrl, "--token", c.token, "--project", f.project.id, "--title", "CLI goal", "--description", "cli", "--acceptance", "cli", "--request-id", "cli-key-0001"];
  const first = await runChild(submitArgs);
  assert.equal(first.code, 0, first.stderr);
  const goalId = JSON.parse(first.stdout).goalId;
  const replay = await runChild([...submitArgs, "--json"]);
  assert.equal(replay.code, 0, replay.stderr);
  const payload = JSON.parse(replay.stdout);
  assert.equal(payload.replayed, true);
  assert.equal(payload.value.goalId, goalId);
  const status = await runChild(["scripts/acms-agent.mjs", "status", "--url", f.api.baseUrl, "--token", c.token, "--goal", goalId]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).goal.id, goalId);
  const blocked = await runChild(["scripts/acms-agent.mjs", "discover", "--url", f.api.baseUrl, "--token", "wrong"]);
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stderr).error.code, "UNAUTHORIZED");
});

test("example flow completes submit, status, events, pause and resume", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ commands: CONTROL_COMMANDS });
  const result = await runChild(["examples/agent-api/flow.mjs", "--url", f.api.baseUrl, "--token", c.token, "--project", f.project.id]);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.apiVersion, "1.0");
  assert.ok(summary.goalId.startsWith("goal_"));
  assert.ok(summary.events > 0);
  assert.equal(summary.paused, true);
  assert.equal(summary.resumed, true);
  assert.ok(summary.userAgentEvents > 0);
});

test("writes an atomic discovery document without secrets and removes it on close", async t => {
  const f = await apiFixture(t);
  const document = JSON.parse(readFileSync(f.api.discoveryFile, "utf8"));
  assert.equal(document.contractVersion, 1);
  assert.equal(document.apiVersion, "1.0");
  assert.equal(document.transport, "http-loopback");
  assert.equal(document.auth, "bearer");
  assert.equal(document.baseUrl, f.api.baseUrl);
  assert.equal(document.pid, process.pid);
  assert.equal(typeof document.instanceId, "string");
  const token = f.credential().token;
  assert.equal(JSON.stringify(document).includes(token), false);
  assert.equal(JSON.stringify(document).includes("acms_ag_"), false);
  await f.api.close();
  assert.equal(existsSync(f.api.discoveryFile), false);
});

test("enforces status.read and events.read on every scoped read endpoint", async t => {
  const f = await apiFixture(t);
  const task = f.owner("task.create", { goalId: f.goal.id, title: "Readable", description: "x", acceptance: "x" });
  const submitOnly = f.credential({ goalIds: [f.goal.id], commands: ["goal.submit"] });
  const reads = [
    "/status?goalId=" + f.goal.id,
    "/projects",
    "/projects/" + f.project.id,
    "/goals",
    "/goals/" + f.goal.id,
    "/tasks?goalId=" + f.goal.id,
    "/tasks/" + task.id,
    "/reviews?goalId=" + f.goal.id,
    "/blockers?goalId=" + f.goal.id,
    "/events?goalId=" + f.goal.id,
  ];
  for (const pathname of reads) {
    const denied = await f.call(pathname, { token: submitOnly.token });
    assert.equal(denied.status, 403, pathname);
    assert.equal(denied.body.ok, false, pathname);
    assert.equal(denied.body.error.code, "FORBIDDEN", pathname);
  }
  assert.equal((await f.call("/discover", { token: submitOnly.token })).status, 200);
  const eventsOnly = f.credential({ goalIds: [f.goal.id], commands: ["events.read"] });
  assert.equal((await f.call("/projects", { token: eventsOnly.token })).status, 403);
  assert.equal((await f.call("/events?goalId=" + f.goal.id, { token: eventsOnly.token })).status, 200);
  assert.equal(f.calls.choose, 0); assert.equal(f.calls.modelDetails, 0); assert.equal(f.calls.probeModel, 0); assert.equal(f.calls.modelCatalog, 0); assert.equal(f.calls.kick, 0);
});

test("returns credential plaintext once and persists only a redacted replay record", async t => {
  const f = await apiFixture(t);
  const requestId = "credential-create-0001";
  const args = { name: "One shot", projectIds: [f.project.id], goalIds: [f.goal.id] };
  const first = f.company.command(OWNER, requestId, "agentCredential.create", args);
  assert.ok(first.token.startsWith("acms_ag_"));
  assert.equal(first.credential.tokenHash, undefined);
  assert.equal(first.credential.status, "active");
  const row = f.store.db.prepare("SELECT result FROM commands WHERE id=?").get(requestId);
  assert.ok(row, "the command record must exist");
  assert.equal(row.result.includes(first.token), false);
  assert.deepEqual(JSON.parse(row.result), { credential: first.credential, tokenOmitted: true });
  assert.equal(JSON.stringify(f.store.list("agentCredentials")).includes(first.token), false);
  const replay = f.company.command(OWNER, requestId, "agentCredential.create", args);
  assert.equal(replay.token, undefined);
  assert.equal(replay.tokenOmitted, true);
  assert.equal(replay.credential.id, first.credential.id);
  assert.equal(f.store.list("agentCredentials").length, 1);
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: first.token })).status, 200);
});

test("revalidates credential state and scope when a long poll completes", async t => {
  const f = await apiFixture(t);
  async function waitForLongPoll() {
    for (let index = 0; index < 200; index += 1) {
      if (f.store.events.listenerCount("event") > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("the long poll did not start within the deadline");
  }

  const revoked = f.credential({ goalIds: [f.goal.id] });
  let pending = f.call("/events?goalId=" + f.goal.id + "&after=" + f.store.cursor() + "&wait=3000", { token: revoked.token });
  await waitForLongPoll();
  f.owner("agentCredential.revoke", { credentialId: revoked.credential.id, expectedRevision: revoked.credential.revision });
  f.owner("task.create", { goalId: f.goal.id, title: "Wake revoked", description: "x", acceptance: "x" });
  let response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");

  const narrowed = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  pending = f.call("/events?goalId=" + f.goal.id + "&after=" + f.store.cursor() + "&wait=3000", { token: narrowed.token });
  await waitForLongPoll();
  f.owner("agentCredential.updateScope", { credentialId: narrowed.credential.id, expectedRevision: narrowed.credential.revision, goalIds: [] });
  f.owner("task.create", { goalId: f.goal.id, title: "Wake narrowed", description: "x", acceptance: "x" });
  response = await pending;
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "SCOPE_DENIED");

  const commandRemoved = f.credential({ goalIds: [f.goal.id], commands: ["status.read", "events.read"] });
  pending = f.call("/events?goalId=" + f.goal.id + "&after=" + f.store.cursor() + "&wait=3000", { token: commandRemoved.token });
  await waitForLongPoll();
  f.owner("agentCredential.updateScope", { credentialId: commandRemoved.credential.id, expectedRevision: commandRemoved.credential.revision, commands: ["status.read"] });
  f.owner("task.create", { goalId: f.goal.id, title: "Wake command", description: "x", acceptance: "x" });
  response = await pending;
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");

  const expiring = f.credential({ goalIds: [f.goal.id], expiresAt: new Date(Date.now() + 600000).toISOString() });
  pending = f.call("/events?goalId=" + f.goal.id + "&after=" + f.store.cursor() + "&wait=3000", { token: expiring.token });
  await waitForLongPoll();
  f.store.transaction(() => {
    const current = f.store.require("agentCredentials", expiring.credential.id);
    f.store.put("agentCredentials", { ...current, expiresAt: new Date(Date.now() - 1000).toISOString() });
  });
  f.owner("task.create", { goalId: f.goal.id, title: "Wake expired", description: "x", acceptance: "x" });
  response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "UNAUTHORIZED");
});

test("maps database write-lock contention to a retryable 503 and a single business effect", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id] });
  const lock = new DatabaseSync(path.join(f.dataDir, "company.db"));
  const key = "busy-key-" + randomUUID();
  const body = { title: "Busy goal", description: "Blocked by a second writer", acceptance: "Lock resolves", projectId: f.project.id };
  const before = f.store.list("goals").length;
  try {
    f.store.db.exec("PRAGMA busy_timeout=250");
    lock.exec("BEGIN IMMEDIATE");
    const blocked = await f.call("/goals", { method: "POST", token: c.token, key, body });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, "ENGINE_BUSY");
    assert.equal(blocked.body.error.retryable, true);
    assert.match(blocked.body.error.message, /busy/i);
    assert.equal(f.store.list("goals").length, before);
    assert.equal(f.calls.kick, 0);
    lock.exec("ROLLBACK");
    const retried = await f.call("/goals", { method: "POST", token: c.token, key, body });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.replayed, false);
    assert.equal(f.store.list("goals").length, before + 1);
    assert.equal(f.store.list("goals").filter(goal => goal.title === "Busy goal").length, 1);
    assert.equal(f.calls.kick, 1);
    const replay = await f.call("/goals", { method: "POST", token: c.token, key, body });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.value.goalId, retried.body.value.goalId);
    assert.equal(f.store.list("goals").filter(goal => goal.title === "Busy goal").length, 1);
    const audit = f.store.pageScoped({ after: 0, goalIds: [retried.body.value.goalId] }).entries;
    assert.equal(audit.filter(entry => entry.type === "goal.submitted").length, 1);
    assert.equal(audit.filter(entry => entry.type === "goal.submitted")[0].actor.kind, "user-agent");
  } finally {
    try { lock.close(); } catch { }
    try { f.store.db.exec("PRAGMA busy_timeout=5000"); } catch { }
  }
});

test("CLI retries a retryable 503 busy response with the same idempotency key", async t => {
  const seen = []; const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      seen.push(request.headers["idempotency-key"]); bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (seen.length === 1) { response.statusCode = 503; response.end(JSON.stringify({ ok: false, error: { code: "ENGINE_BUSY", message: "The ACMS database is busy", retryable: true } })); }
      else { response.statusCode = 200; response.end(JSON.stringify({ ok: true, value: { goalId: "goal_retry" } })); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = "http://127.0.0.1:" + server.address().port + "/api/acms/agent/v1";
  const result = await runChild(["scripts/acms-agent.mjs", "submit", "--url", url, "--token", "acms_ag_fixture", "--project", "project_fixture", "--title", "Retry", "--description", "retry", "--acceptance", "retry", "--request-id", "cli-retry-0001"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen, ["cli-retry-0001", "cli-retry-0001"]);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(result.stdout).goalId, "goal_retry");
});


test("goal scope is the union of configured goals and goals the credential submitted", async t => {
  const f = await apiFixture(t);
  const c = f.credential({ goalIds: [f.goal.id], commands: CONTROL_COMMANDS });
  const created = await f.call("/goals", { method: "POST", token: c.token, key: "union-scope-key-01", body: { title: "Union scope goal", description: "submitted by the scoped credential", acceptance: "readable by the same credential", projectId: f.project.id } });
  assert.equal(created.status, 200);
  const goalId = created.body.value.goalId;
  assert.equal((await f.call("/status?goalId=" + f.goal.id, { token: c.token })).status, 200);
  assert.equal((await f.call("/status?goalId=" + goalId, { token: c.token })).status, 200);
  const goals = await f.call("/goals", { token: c.token });
  assert.deepEqual(goals.body.value.goals.map(item => item.id).sort(), [f.goal.id, goalId].sort());
  const denied = await f.call("/status?goalId=" + f.otherGoal.id, { token: c.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "SCOPE_DENIED");
});
