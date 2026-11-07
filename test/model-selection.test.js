import test from "node:test";
import assert from "node:assert/strict";
import { DshAdapter } from "../src/adapters/dsh.js";
import { Store } from "../src/core/store.js";
import { buildCandidates, makeCandidate, selectRoute, selectionError } from "../src/core/model-selection.js";
import { fixture, until } from "./helpers.js";
const providerList = [{ name: "spawn", origin: "internal", inheritsParentContext: false }, { name: "fork", origin: "internal", inheritsParentContext: true }, { name: "paired:x", origin: "external" }];
function route(name, extra = {}) { const external = name.startsWith("paired"); return { provider: name, llmProvider: external ? "" : "deepseek", origin: external ? "external" : "internal", persistent: external ? true : false, inheritsParentContext: external ? null : name === "fork", health: { status: "untested" }, reasoning: { effective: null, selectable: false, efforts: [] }, ...extra }; }
function candidate(model, name, rank, extra = {}) { return makeCandidate(model, route(name, extra), providerList.find(p => p.name === name), rank, extra.policy ?? {}); }
const prefs = (...entries) => ({ revision: entries.length, order: entries.map((entry, index) => ({ id: `pref_${index}`, model: entry.model, provider: entry.provider ?? null, llmProvider: entry.llmProvider ?? null, reasoningEffort: entry.reasoningEffort ?? null })) });
test("preference order, later entry and stable default", () => {
  const candidates = [candidate("m1", "spawn", 0), candidate("m2", "spawn", 1), candidate("m3", "fork", 2)];
  let result = selectRoute({ candidates, preferences: prefs({ model: "m3" }, { model: "m2" }), policy: {} });
  assert.equal(result.chosen.model, "m3"); assert.equal(result.binding.mode, "preference"); assert.equal(result.preferenceIndex, 0);
  result = selectRoute({ candidates, preferences: prefs({ model: "absent" }, { model: "m2" }), policy: {} });
  assert.equal(result.chosen.model, "m2"); assert.equal(result.preferenceIndex, 1);
  assert(result.fallbacks.some(f => f.reason === "preference_model_absent" && f.model === "absent"));
  result = selectRoute({ candidates, preferences: prefs(), policy: {} });
  assert.equal(result.chosen.model, "m1"); assert.equal(result.binding.mode, "default"); assert.equal(result.preferenceIndex, null);
});
test("same model keeps distinct entrance semantics", () => {
  const candidates = [candidate("m1", "spawn", 0), candidate("m1", "fork", 1), candidate("m1", "paired:x", 2)];
  let result = selectRoute({ candidates, preferences: prefs({ model: "m1", provider: "fork" }), policy: {} });
  assert.equal(result.chosen.provider, "fork");
  result = selectRoute({ candidates, preferences: prefs({ model: "m1", llmProvider: "missing" }), policy: {} });
  assert.equal(result.chosen.provider, "spawn"); assert(result.fallbacks.some(f => f.reason === "route_mismatch"));
  assert.equal(new Set(candidates.map(c => c.candidateId)).size, 3);
});
test("authorization is not widened by preferences", () => {
  const allowed = candidate("m1", "spawn", 0);
  const restrictedModel = makeCandidate("m2", route("spawn"), providerList[0], 1, { allowedModels: ["m1"] });
  const restrictedProvider = makeCandidate("m3", route("fork"), providerList[1], 2, { allowedProviders: ["spawn"] });
  let result = selectRoute({ candidates: [allowed, restrictedModel, restrictedProvider], preferences: prefs({ model: "m2" }, { model: "m3" }), policy: { allowedModels: ["m1"], allowedProviders: ["spawn"] } });
  assert.equal(result.chosen.model, "m1"); assert.equal(result.binding.mode, "default");
  assert(result.fallbacks.some(f => f.reason === "unauthorized_model" && f.model === "m2"));
  assert(result.fallbacks.some(f => f.reason === "unauthorized_provider" && f.model === "m3"));
});
test("explicit binding wins and never silently falls back", () => {
  const candidates = [candidate("m1", "spawn", 0), candidate("m2", "fork", 1)];
  let result = selectRoute({ candidates, preferences: prefs({ model: "m2" }), binding: { model: "m1" }, policy: {} });
  assert.equal(result.chosen.model, "m1"); assert.equal(result.binding.mode, "explicit"); assert.equal(result.preferenceIndex, null);
  result = selectRoute({ candidates, preferences: prefs({ model: "m2" }), binding: { model: "missing" }, policy: {} });
  assert.equal(result.status, "blocked"); assert.equal(result.blocked.code, "EXPLICIT_BINDING_UNAVAILABLE"); assert.equal(result.chosen, null);
  assert(result.fallbacks.some(f => f.reason === "explicit_binding_absent"));
  const error = selectionError(result);
  assert.equal(error.code, "MODEL_UNAVAILABLE"); assert.equal(error.details.selection.blocked.code, "EXPLICIT_BINDING_UNAVAILABLE");
});
test("required capabilities reject unknown while optional unknown stays eligible", () => {
  const internal = candidate("m1", "spawn", 0);
  const external = candidate("m2", "paired:x", 1, { persistent: true });
  let result = selectRoute({ candidates: [internal, external], requirements: { tools: "required" }, policy: {} });
  assert.equal(result.chosen.model, "m1");
  assert(result.fallbacks.some(f => f.reason === "capability_unknown" && f.model === "m2"));
  result = selectRoute({ candidates: [internal, external], requirements: { tools: "optional" }, policy: {} });
  assert.equal(result.status, "selected");
  result = selectRoute({ candidates: [internal], requirements: { inheritsParentContext: true }, policy: {} });
  assert.equal(result.status, "blocked"); assert(result.fallbacks.some(f => f.reason === "capability_mismatch"));
});
test("continuity preferred sorts soft matches but explicit preference still wins", () => {
  const spawn = candidate("b", "spawn", 0);
  const external = candidate("a", "paired:x", 2, { persistent: true });
  let result = selectRoute({ candidates: [spawn, external], requirements: { continuity: "preferred" }, policy: {} });
  assert.equal(result.chosen.model, "a");
  result = selectRoute({ candidates: [spawn, external], requirements: { continuity: "preferred" }, preferences: prefs({ model: "b" }), policy: {} });
  assert.equal(result.chosen.model, "b");
});
test("no eligible candidates block instead of guessing", () => {
  const unhealthy = candidate("m1", "spawn", 0, { health: { status: "unavailable" } });
  let result = selectRoute({ candidates: [unhealthy], policy: {} });
  assert.equal(result.status, "blocked"); assert.equal(result.blocked.code, "NO_ELIGIBLE_CANDIDATE");
  assert.equal(selectionError(result).code, "NO_ELIGIBLE_CANDIDATE");
  const unknownOnly = candidate("m1", "paired:x", 0, { persistent: null });
  result = selectRoute({ candidates: [unknownOnly], requirements: { tools: "required" }, policy: {} });
  assert.equal(result.blocked.code, "CAPABILITY_UNKNOWN");
});
test("buildCandidates keeps undeclared continuity unknown", () => {
  const catalog = { models: [{ id: "g1", routes: [{ provider: "paired:x", llmProvider: "", origin: "external", persistent: null, inheritsParentContext: null, health: { status: "untested" } }] }], defaultSelection: { model: "g1", provider: "paired:x", llmProvider: "" } };
  const built = buildCandidates({ providers: providerList, catalog, policy: {} });
  assert.equal(built[0].continuity, "unknown");
  assert.equal(built[0].inheritsParentContext, null);
  assert.equal(built[0].capabilitySource, "config");
  assert.equal(built[0].cost, null);
});
function adapterFixture(policy = { allowedProviders: [], allowedModels: [] }) {
  const store = new Store(":memory:");
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) },
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }, { id: "secondary", name: "Secondary" }],
      listModels: async provider => [{ id: "deepseek-flash", provider, name: "Flash" }, { id: "deepseek-reasoner", provider, name: "Reasoner" }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: null } }),
      stream: async function* () { throw new Error("selection must not run a model stream"); }
    }
  };
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: { id: "parent" }, dispose: async () => {} }) }, subagents: { providers: new Map([["spawn", { name: "spawn", prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true }, config: {} }], ["fork", { name: "fork", prepareContinuable() {}, inheritsParentContext: true, capabilities: { agentOptions: true, depthLimit: true }, config: {} }]]), startActivation: async () => ({ childId: "child", result: Promise.resolve({ stopReason: "completed", structured: { outcome: "completed", summary: "Fixture" } }), dispose: async () => {} }) } };
  const company = { policy: () => policy, store };
  const adapter = new DshAdapter(ctx, company, ".");
  return { adapter, services, store, company };
}
function setPreferences(store, order) { store.transaction(() => store.put("modelPreferences", { id: "model", order, updatedBy: { kind: "owner", id: "owner" } })); }
test("adapter applies preference, persists the selection and reports it", async t => {
  const { adapter, store } = adapterFixture(); t.after(() => store.close());
  setPreferences(store, [{ id: "pref_1", model: "deepseek-reasoner", provider: "spawn", llmProvider: null, reasoningEffort: null }]);
  const chosen = await adapter.choose({ provider: "auto", model: "" });
  assert.equal(chosen.name, "spawn"); assert.equal(chosen.model, "deepseek-reasoner");
  const attempt = store.transaction(() => store.put("attempts", { id: "a1", taskId: "t1", goalId: "g1", agentId: "ag1", kind: "work", status: "preparing", contextKey: "ctx", startedAt: new Date().toISOString(), taskGeneration: 1 }));
  const activation = await adapter.start({ task: { workspace: { path: "." }, requirements: {} }, attempt, agent: { provider: "auto", model: "" }, prompt: "work", signal: new AbortController().signal });
  await activation.result; await activation.dispose();
  const saved = store.get("attempts", "a1");
  assert.equal(saved.selection.status, "selected");
  assert.equal(saved.selection.binding.mode, "preference");
  assert.equal(saved.selection.chosen.model, "deepseek-reasoner");
  assert.equal(saved.model, "deepseek-reasoner");
  assert(store.page(0, 50).entries.some(e => e.type === "attempt.route.selected"));
});
test("viewing preferences and selecting routes never probes a model", async t => {
  const { adapter, services, store } = adapterFixture(); t.after(() => store.close());
  setPreferences(store, [{ id: "p", model: "deepseek-reasoner", provider: null, llmProvider: null, reasoningEffort: null }]);
  let streams = 0; let details = 0;
  services.llm.stream = async function* () { streams++; throw new Error("no stream"); };
  services.llm.resolveModelInfo = async () => { details++; return { reasoning: { efforts: [], defaultEffort: null } }; };
  const context = await adapter.modelContext();
  assert.equal(context.selectionVersion, "1");
  assert.equal(context.preferences.order.length, 1);
  assert(context.candidates.length > 0);
  await adapter.choose({ provider: "auto", model: "" });
  assert.equal(streams, 0); assert.equal(details, 0);
});
test("adapter explicit binding beats preference and a missing binding does not fall back", async t => {
  const { adapter, store } = adapterFixture(); t.after(() => store.close());
  setPreferences(store, [{ id: "p", model: "deepseek-reasoner" }]);
  const chosen = await adapter.choose({ provider: "spawn", model: "deepseek-flash" });
  assert.equal(chosen.model, "deepseek-flash");
  await assert.rejects(adapter.choose({ provider: "spawn", model: "missing" }), error => {
    assert.equal(error.code, "MODEL_UNAVAILABLE");
    assert.equal(error.details.selection.blocked.code, "EXPLICIT_BINDING_UNAVAILABLE");
    assert.equal(error.details.selection.chosen, null);
    return true;
  });
});
test("adapter policy still filters a preferred model", async t => {
  const { adapter, store } = adapterFixture({ allowedProviders: [], allowedModels: ["deepseek-flash"] }); t.after(() => store.close());
  setPreferences(store, [{ id: "p", model: "deepseek-reasoner" }]);
  const chosen = await adapter.choose({ provider: "auto", model: "" });
  assert.equal(chosen.model, "deepseek-flash");
  const selection = await adapter.select({ provider: "auto", model: "" });
  assert(selection.fallbacks.some(f => f.reason === "unauthorized_model" && f.model === "deepseek-reasoner"));
});
test("adapter applies continuity preference without overriding explicit user preference", async t => {
  const { adapter, store } = adapterFixture(); t.after(() => store.close());
  adapter.paired = { list: () => [{ id: "paired:x", name: "X", model: "gpt-x", persistent: true, reasoningEffort: null, probeSupported: false }] };
  const external = await adapter.choose({ provider: "auto", model: "" }, { requirements: { continuity: "preferred" } });
  assert.equal(external.name, "paired:x"); assert.equal(external.model, "gpt-x");
  setPreferences(store, [{ id: "p", model: "deepseek-flash", provider: "spawn" }]);
  const preferred = await adapter.choose({ provider: "auto", model: "" }, { requirements: { continuity: "preferred" } });
  assert.equal(preferred.model, "deepseek-flash");
});
test("adapter blocks when the only authorized route has unknown required capability", async t => {
  const { adapter, store } = adapterFixture({ allowedProviders: ["paired:x"], allowedModels: ["gpt-x"] }); t.after(() => store.close());
  adapter.paired = { list: () => [{ id: "paired:x", name: "X", model: "gpt-x", persistent: null, reasoningEffort: null, probeSupported: false }] };
  const selection = await adapter.select({ provider: "auto", model: "" }, { requirements: { continuity: "required" } });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.blocked.code, "CAPABILITY_UNKNOWN");
  await assert.rejects(adapter.choose({ provider: "auto", model: "" }, { requirements: { continuity: "required" } }), { code: "NO_ELIGIBLE_CANDIDATE" });
});
test("adapter exposes modelContext candidates and preferences consistently", async t => {
  const { adapter, store } = adapterFixture(); t.after(() => store.close());
  adapter.paired = { list: () => [{ id: "paired:x", name: "X", model: "gpt-x", persistent: true, reasoningEffort: "high", probeSupported: false }] };
  setPreferences(store, [{ id: "pref_ctx", model: "gpt-x", provider: "paired:x" }]);
  const context = await adapter.modelContext({ continuity: "preferred" });
  assert.equal(context.preferences.revision, 1);
  assert.equal(context.preferences.order[0].id, "pref_ctx");
  assert(context.candidates.some(c => c.model === "gpt-x" && c.provider === "paired:x" && c.continuity === "supported"));
  assert.deepEqual(context.policy, { allowedProviders: [], allowedModels: [] });
  const chosen = await adapter.choose({ provider: "auto", model: "" });
  assert.equal(chosen.name, "paired:x"); assert.equal(chosen.model, "gpt-x");
});
test("engine blocks a task without retry when no model candidate is eligible", async t => {
  const f = await fixture(t);
  const unhealthy = candidate("m1", "spawn", 0, { health: { status: "unavailable" } });
  const error = selectionError(selectRoute({ candidates: [unhealthy], policy: {} }));
  f.adapter.start = async () => { throw error; };
  const task = f.task();
  await f.start();
  const blocked = await until(() => { const saved = f.store.get("tasks", task.id); return saved?.status === "blocked" ? saved : null; });
  assert.equal(blocked.blocker.kind, "model-selection");
  const interaction = f.store.list("interactions").find(i => i.taskId === task.id && i.status === "pending");
  assert.equal(interaction.kind, "model-selection");
  const attempts = f.store.list("attempts").filter(a => a.taskId === task.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].selection.blocked.code, "NO_ELIGIBLE_CANDIDATE");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.store.list("attempts").filter(a => a.taskId === task.id).length, 1);
});

test("required reasoning depth is reported and unknown external depth fails closed", () => {
  const internal = candidate("m2", "spawn", 0, { reasoning: { effective: "low", selectable: true, efforts: [{ id: "low" }, { id: "max" }], source: "test" } });
  const external = makeCandidate("gpt-x", route("paired:x", { reasoning: { effective: null, selectable: false, efforts: [], source: "config" } }), providerList[2], 1, {});
  let result = selectRoute({ candidates: [internal, external], binding: { model: "m2", reasoningEffort: "max" }, policy: {} });
  assert.equal(result.status, "selected");
  assert.equal(result.chosen.reasoningEffort, "max");
  result = selectRoute({ candidates: [internal, external], binding: { model: "gpt-x", provider: "paired:x", reasoningEffort: "max" }, policy: {} });
  assert.equal(result.status, "blocked");
  assert.equal(result.chosen, null);
  assert.equal(result.blocked.code, "EXPLICIT_BINDING_UNAVAILABLE");
  assert(result.fallbacks.some(f => f.reason === "capability_unknown" && f.model === "gpt-x" && f.provider === "paired:x"));
});
test("internal depth is resolved before activation instead of being trusted", () => {
  const unknownInternal = candidate("m4", "spawn", 0, { reasoning: { effective: null, selectable: false, efforts: [], source: "test" } });
  const result = selectRoute({ candidates: [unknownInternal], binding: { model: "m4", reasoningEffort: "max" }, policy: {} });
  assert.equal(result.status, "selected");
  assert.equal(result.chosen.reasoningEffort, "max");
});
