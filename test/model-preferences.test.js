import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { Company } from "../src/core/domain.js";
import { OWNER, SYSTEM } from "../src/core/util.js";
import { normalizePreferenceOrder } from "../src/core/model-selection.js";
import { fixture } from "./helpers.js";
async function open(root) { const store = new Store(path.join(root, "company.db")); return { store, company: new Company(store) }; }
const dir = () => mkdtemp(path.join(tmpdir(), "acms-prefs-"));
test("owner sets, reorders, reads and clears persistent preferences", async t => {
  const root = await dir(); const { store, company } = await open(root); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  assert.deepEqual(company.snapshot().modelPreferences, { id: "model", order: [], revision: 0, updatedAt: null, updatedBy: null });
  const first = [{ id: "pref_a", model: "deepseek-flash", provider: "spawn", llmProvider: "deepseek", reasoningEffort: null, label: "首选" }, { id: "pref_b", model: "deepseek-reasoner", provider: null, llmProvider: "secondary", reasoningEffort: "max", label: "备选" }];
  const saved = company.command(OWNER, randomUUID(), "model.preferences.set", { order: first });
  assert.deepEqual(saved.order, first); assert.equal(saved.revision, 1); assert.equal(saved.updatedBy.kind, "owner");
  const reordered = company.command(OWNER, randomUUID(), "model.preferences.set", { order: [first[1], first[0]], expectedRevision: saved.revision });
  assert.deepEqual(reordered.order.map(x => x.id), ["pref_b", "pref_a"]); assert.equal(reordered.revision, 2);
  const snapshot = company.snapshot();
  assert.deepEqual(snapshot.modelPreferences.order.map(x => x.id), ["pref_b", "pref_a"]);
  const cleared = company.command(OWNER, randomUUID(), "model.preferences.clear", { expectedRevision: reordered.revision });
  assert.deepEqual(cleared.order, []); assert.equal(cleared.revision, 3);
  const changed = store.page(0, 20).entries.filter(e => e.type === "model.preferences.changed");
  assert.equal(changed.length, 3);
  assert.deepEqual(changed[0].before.order, []); assert.equal(changed[0].after.order.length, 2);
  assert.equal(changed[2].cleared, true);
  assert.equal(company.snapshot().modelPreferences.revision, 3);
});
test("preferences survive a restart without a schema migration", async t => {
  const root = await dir(); const first = await open(root);
  const order = [{ id: "pref_keep", model: "deepseek-reasoner", provider: "fork", llmProvider: "secondary", reasoningEffort: "low", label: "保留" }];
  first.company.command(OWNER, randomUUID(), "model.preferences.set", { order });
  first.store.close();
  const second = await open(root); t.after(async () => { second.store.close(); await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  assert.deepEqual(second.company.snapshot().modelPreferences.order, order);
  assert.equal(second.company.snapshot().modelPreferences.revision, 1);
});
test("set and clear are idempotent per request and reject conflicting reuse", async t => {
  const root = await dir(); const { store, company } = await open(root); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  const requestId = randomUUID(); const args = { order: [{ id: "pref_once", model: "deepseek-flash" }] };
  const first = company.command(OWNER, requestId, "model.preferences.set", args);
  const replay = company.command(OWNER, requestId, "model.preferences.set", args);
  assert.equal(replay.revision, first.revision);
  assert.throws(() => company.command(OWNER, requestId, "model.preferences.set", { order: [] }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => company.command(OWNER, randomUUID(), "model.preferences.set", { order: [], expectedRevision: 0 }), { code: "CONFLICT" });
});
test("preference validation rejects duplicates, overflow, unknown fields and unknown ids", () => {
  assert.throws(() => normalizePreferenceOrder([{ id: "pref_x", model: "m" }, { id: "pref_y", model: "m" }]), { code: "INVALID_INPUT" });
  assert.throws(() => normalizePreferenceOrder(Array.from({ length: 21 }, (_, i) => ({ id: `pref_${i}`, model: `m${i}` }))), { code: "INVALID_INPUT" });
  assert.throws(() => normalizePreferenceOrder([{ id: "bad", model: "m" }]), { code: "INVALID_INPUT" });
  assert.throws(() => normalizePreferenceOrder([{ id: "pref_ok", model: "m", extra: 1 }]), { code: "INVALID_INPUT" });
  assert.throws(() => normalizePreferenceOrder([{ id: "pref_empty", model: "  " }]), { code: "INVALID_INPUT" });
});
test("only owner or system can change preferences; agents stay read-only", async t => {
  const root = await dir(); const { store, company } = await open(root); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  const worker = company.command(OWNER, randomUUID(), "agent.save", { name: "Worker", role: "worker", provider: "auto", model: "" });
  assert.throws(() => company.command({ kind: "agent", id: worker.id }, randomUUID(), "model.preferences.set", { order: [{ model: "m" }] }), { code: "FORBIDDEN" });
  const saved = company.command(SYSTEM, randomUUID(), "model.preferences.set", { order: [{ model: "m" }] });
  assert.equal(saved.order.length, 1);
  assert.throws(() => company.command(OWNER, randomUUID(), "model.preferences.set", { order: [{ model: "m" }], expectedRevision: 0 }), { code: "CONFLICT" });
});
test("task requirements are validated, stored and default to no hard requirement", async t => {
  const f = await fixture(t);
  const task = f.task({ requirements: { continuity: "preferred", tools: "required", inheritsParentContext: null } });
  assert.equal(task.requirements.continuity, "preferred");
  assert.equal(task.requirements.tools, "required");
  assert.equal(task.requirements.verified, "none");
  assert.throws(() => f.task({ requirements: { unknown: true } }), { code: "INVALID_INPUT" });
  assert.throws(() => f.task({ requirements: { continuity: "must" } }), { code: "INVALID_INPUT" });
  assert.throws(() => f.task({ requirements: { tools: "preferred" } }), { code: "INVALID_INPUT" });
});
test("author and review attempts keep separate context keys", async t => {
  const f = await fixture(t); f.command("company.pause", {});
  await f.start();
  const reviewer = f.command("agent.save", { name: "Reviewer", role: "reviewer", provider: "auto", model: "" });
  const work = f.task();
  const review = f.company.command(SYSTEM, randomUUID(), "task.create", { goalId: f.goal.id, kind: "review", title: "Review fixture", agentId: reviewer.id, reviewOf: work.id, requiresArtifacts: false });
  const authorAttempt = f.engine.claim(work, f.company.store.require("agents", work.agentId));
  const reviewAttempt = f.engine.claim(review, f.company.store.require("agents", reviewer.id));
  assert.notEqual(authorAttempt.contextKey, reviewAttempt.contextKey);
  assert.match(authorAttempt.contextKey, /role-worker/);
  assert.match(reviewAttempt.contextKey, /role-reviewer/);
  assert.equal(review.requirements.isolation, "independent-review");
});
