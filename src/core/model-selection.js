import { createHash } from "node:crypto";
import { assert, digest, id } from "./util.js";
export const SELECTOR_VERSION = "1";
export const MAX_PREFERENCES = 20;
export const MAX_CANDIDATES = 50;
export function modelPolicyFingerprint(policy = {}) {
  return "sha256:" + digest({ allowedProviders: policy.allowedProviders ?? [], allowedModels: policy.allowedModels ?? [] });
}
export const FALLBACK_REASONS = Object.freeze(["unauthorized_provider", "unauthorized_model", "provider_unavailable", "health_unavailable", "capability_mismatch", "capability_unknown", "route_mismatch", "preference_model_absent", "explicit_binding_absent"]);
export const BLOCKED_CODES = Object.freeze(["EXPLICIT_BINDING_UNAVAILABLE", "NO_AUTHORIZED_PROVIDER", "NO_ELIGIBLE_CANDIDATE", "CAPABILITY_UNKNOWN"]);
const REQUIREMENT_MODES = Object.freeze({ continuity: ["required", "preferred", "none"], runningMessages: ["required", "optional", "none"], tools: ["required", "optional", "none"], sandbox: ["required", "optional", "none"], verified: ["required", "optional", "none"] });
const REQUIREMENT_KEYS = Object.freeze(["continuity", "inheritsParentContext", "runningMessages", "tools", "sandbox", "verified", "isolation", "model", "provider", "llmProvider", "reasoningEffort"]);
const BINDING_FIELDS = Object.freeze(["model", "provider", "llmProvider", "reasoningEffort"]);
export function emptyRequirements() {
  return { continuity: "none", inheritsParentContext: null, runningMessages: "none", tools: "none", sandbox: "none", verified: "none", isolation: null, model: null, provider: null, llmProvider: null, reasoningEffort: null };
}
function optionalString(value, label, max) {
  if (value == null || value === "") return null;
  assert(typeof value === "string" && value.length <= max, "INVALID_INPUT", label + " must be a string of at most " + max + " characters");
  return value;
}
export function normalizeRequirements(raw = {}) {
  assert(raw && typeof raw === "object" && !Array.isArray(raw), "INVALID_INPUT", "Task requirements must be an object");
  for (const key of Object.keys(raw)) assert(REQUIREMENT_KEYS.includes(key), "INVALID_INPUT", "Unknown task requirement " + key);
  const requirements = { ...emptyRequirements(), ...raw };
  for (const [key, modes] of Object.entries(REQUIREMENT_MODES)) assert(modes.includes(requirements[key]), "INVALID_INPUT", key + " must be one of " + modes.join(", "));
  assert([true, false, null].includes(requirements.inheritsParentContext), "INVALID_INPUT", "inheritsParentContext must be true, false or null");
  assert(requirements.isolation == null || requirements.isolation === "independent-review", "INVALID_INPUT", "isolation must be independent-review or null");
  for (const key of ["model", "provider", "llmProvider"]) requirements[key] = optionalString(requirements[key], "requirements." + key, 200);
  requirements.reasoningEffort = optionalString(requirements.reasoningEffort, "requirements.reasoningEffort", 80);
  return requirements;
}
function preferenceId(value) {
  if (value == null || value === "") return id("pref");
  assert(typeof value === "string" && /^pref_[A-Za-z0-9_-]{1,62}$/.test(value), "INVALID_INPUT", "Preference id must start with pref_ and use visible characters");
  return value;
}
export function normalizePreferenceOrder(order) {
  assert(Array.isArray(order), "INVALID_INPUT", "order must be an array");
  assert(order.length <= MAX_PREFERENCES, "INVALID_INPUT", "At most " + MAX_PREFERENCES + " model preferences are allowed");
  const seen = new Set(); const ids = new Set();
  return order.map((entry, index) => {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), "INVALID_INPUT", "order[" + index + "] must be an object");
    for (const key of Object.keys(entry)) assert(["id", "model", "provider", "llmProvider", "reasoningEffort", "label"].includes(key), "INVALID_INPUT", "Unknown preference field " + key);
    assert(typeof entry.model === "string" && entry.model.trim().length > 0 && entry.model.length <= 200, "INVALID_INPUT", "order[" + index + "].model must be a nonempty string, at most 200 characters");
    const normalized = { id: preferenceId(entry.id), model: entry.model.trim(), provider: optionalString(entry.provider, "order[" + index + "].provider", 200), llmProvider: optionalString(entry.llmProvider, "order[" + index + "].llmProvider", 200), reasoningEffort: optionalString(entry.reasoningEffort, "order[" + index + "].reasoningEffort", 80), label: optionalString(entry.label, "order[" + index + "].label", 80) };
    const key = [normalized.model, normalized.provider ?? "", normalized.llmProvider ?? "", normalized.reasoningEffort ?? ""].join(String.fromCharCode(0));
    assert(!seen.has(key), "INVALID_INPUT", "Duplicate model preference at order[" + index + "]");
    assert(!ids.has(normalized.id), "INVALID_INPUT", "Duplicate preference id " + normalized.id);
    seen.add(key); ids.add(normalized.id); return normalized;
  });
}
export function sanitizePreferences(saved) {
  if (!saved) return { id: "model", order: [], revision: 0, updatedAt: null, updatedBy: null };
  return { id: "model", order: saved.order ?? [], revision: saved.revision ?? 0, updatedAt: saved.updatedAt ?? null, updatedBy: saved.updatedBy ?? null };
}
export function candidateId(provider, llmProvider, model) {
  return "cand_" + createHash("sha256").update(JSON.stringify([provider, llmProvider || "", model])).digest("hex").slice(0, 16);
}
export function bindingFromAgent(agent = {}) {
  return { model: agent.model || null, provider: agent.provider && agent.provider !== "auto" ? agent.provider : null, llmProvider: agent.llmProvider || null, reasoningEffort: agent.reasoningEffort || null };
}
export function bindingActive(binding = {}) { return BINDING_FIELDS.some(key => binding[key] != null && binding[key] !== ""); }
function inferredContinuity(persistent) { return persistent === true ? "supported" : persistent === false ? "unsupported" : "unknown"; }
function capabilityFields(route, origin) {
  const known = origin === "internal";
  return {
    continuity: route.continuity ?? inferredContinuity(route.persistent),
    runningMessages: route.runningMessages ?? (known ? "supported" : "unknown"),
    tools: route.tools ?? (known ? "supported" : "unknown"),
    sandbox: route.sandbox ?? (known ? "supported" : "unknown"),
    capabilitySource: route.capabilitySource ?? (known ? "runtime" : "config"),
    inheritsParentContext: route.inheritsParentContext === true || route.inheritsParentContext === false ? route.inheritsParentContext : null
  };
}
export function makeCandidate(model, route, providerMeta, stableRank, policy = {}) {
  const origin = route.origin ?? providerMeta?.origin ?? "internal";
  const persistent = route.persistent ?? (origin === "internal" ? false : null);
  const health = route.health ?? { status: "untested", reason: "尚未执行实际连通性检测" };
  const capabilities = capabilityFields({ ...route, persistent }, origin);
  const allowedProviders = policy.allowedProviders ?? [];
  const allowedModels = policy.allowedModels ?? [];
  return {
    candidateId: candidateId(route.provider, route.llmProvider, model),
    model, provider: route.provider, providerDisplayName: route.displayName ?? providerMeta?.displayName ?? route.provider,
    llmProvider: route.llmProvider ?? "", origin, persistent, ...capabilities,
    reasoning: route.reasoning ?? null, reasoningEffort: route.reasoning?.effective ?? null, health, probeSupported: route.probeSupported ?? null, probeReason: route.probeReason ?? null,
    providerAuthorized: !!providerMeta && (!allowedProviders.length || allowedProviders.includes(route.provider)),
    modelAuthorized: !allowedModels.length || allowedModels.includes(model),
    authorized: !!providerMeta && (!allowedProviders.length || allowedProviders.includes(route.provider)) && (!allowedModels.length || allowedModels.includes(model)),
    cost: null, stableRank, preferenceRank: null, eligible: false, exclusion: null
  };
}
export function buildCandidates({ providers = [], catalog = { models: [] }, policy = {} }) {
  const byName = new Map(providers.map(p => [p.name, p]));
  const flat = [];
  for (const entry of catalog.models ?? []) for (const route of entry.routes ?? []) flat.push({ model: entry.id, route });
  const def = catalog.defaultSelection ?? null;
  const isDefault = item => def && item.model === def.model && item.route.provider === def.provider && (item.route.llmProvider ?? "") === (def.llmProvider ?? "");
  const ordered = [...flat.filter(isDefault), ...flat.filter(item => !isDefault(item))];
  return ordered.map((item, rank) => makeCandidate(item.model, item.route, byName.get(item.route.provider), rank, policy));
}
function preferredScore(candidate, requirements) {
  return requirements.continuity === "preferred" && candidate.continuity === "supported" ? 1 : 0;
}
export function rankWithin(list, requirements) {
  return list.slice().sort((a, b) => preferredScore(b, requirements) - preferredScore(a, requirements) || a.stableRank - b.stableRank || a.candidateId.localeCompare(b.candidateId));
}
function requirementExclusion(candidate, requirements, ignoreHealth) {
  if (!ignoreHealth && candidate.health?.status === "unavailable") return "health_unavailable";
  if (requirements.verified === "required" && candidate.health?.status !== "available") return candidate.health?.status === "unavailable" ? "health_unavailable" : "capability_unknown";
  if (requirements.continuity === "required" && candidate.continuity !== "supported") return candidate.continuity === "unknown" ? "capability_unknown" : "capability_mismatch";
  if (requirements.inheritsParentContext !== null && candidate.inheritsParentContext !== requirements.inheritsParentContext) return candidate.inheritsParentContext === null ? "capability_unknown" : "capability_mismatch";
  for (const key of ["runningMessages", "tools", "sandbox"]) {
    if (requirements[key] !== "required") continue;
    if (candidate[key] === "supported") continue;
    return candidate[key] === "unknown" || candidate[key] == null ? "capability_unknown" : "capability_mismatch";
  }
  return null;
}
function routeExclusion(candidate, requirements, binding, mode) {
  if (!candidate.authorized) return null;
  if (mode === "explicit") for (const key of ["model", "provider", "llmProvider"]) if (binding[key] != null && binding[key] !== "" && candidate[key] !== binding[key]) return "route_mismatch";
  for (const key of ["model", "provider", "llmProvider"]) {
    const required = requirements[key];
    if (required != null && required !== "" && candidate[key] !== required) return "route_mismatch";
  }
  const wantedEffort = (mode === "explicit" ? binding.reasoningEffort : null) ?? requirements.reasoningEffort;
  if (wantedEffort) {
    if (candidate.reasoning?.effective === wantedEffort) return null;
    const known = candidate.reasoning?.selectable === true || candidate.reasoning?.effective != null;
    if (known) {
      const selectable = candidate.reasoning?.selectable === true && (candidate.reasoning.efforts ?? []).some(effort => effort.id === wantedEffort);
      return selectable ? null : "route_mismatch";
    }
    // Internal runtimes expose model details before activation, so start() resolves and
    // validates the requested depth. External runtimes cannot be inspected before launch,
    // so an undeclared depth must not satisfy an explicit constraint.
    return candidate.origin === "internal" ? null : "capability_unknown";
  }
  return null;
}
function evaluate(candidate, requirements, binding, mode, ignoreHealth) {
  if (!candidate.providerAuthorized) return "unauthorized_provider";
  if (!candidate.modelAuthorized) return "unauthorized_model";
  const route = routeExclusion(candidate, requirements, binding, mode); if (route) return route;
  return requirementExclusion(candidate, requirements, ignoreHealth);
}
function entryMatches(candidate, entry) {
  if (candidate.model !== entry.model) return false;
  for (const key of ["provider", "llmProvider", "reasoningEffort"]) if (entry[key] != null && entry[key] !== "" && candidate[key] !== entry[key]) return false;
  return true;
}
function selectedEffort(candidate, binding, mode, requirements) {
  const wanted = (mode === "explicit" ? binding.reasoningEffort : null) ?? requirements.reasoningEffort;
  if (wanted) return wanted;
  return candidate.reasoning?.effective ?? null;
}
const DETAILS = {
  unauthorized_provider: "provider is not in the authorized provider policy",
  unauthorized_model: "model is not in the authorized model policy",
  provider_unavailable: "provider is registered but has no routable model",
  health_unavailable: "the last connectivity check failed",
  capability_mismatch: "a required capability is explicitly unsupported",
  capability_unknown: "a required capability is unknown or undeclared",
  route_mismatch: "the route does not match the explicit binding or task requirement",
  preference_model_absent: "the preferred model is not offered by any authorized provider",
  explicit_binding_absent: "no authorized route matches the explicit binding"
};
function fallbackOf(candidate, reason) {
  return { candidateId: candidate.candidateId, model: candidate.model, provider: candidate.provider, reason, detail: DETAILS[reason] ?? reason };
}
function syntheticFallback(entry, reason) {
  return { candidateId: candidateId(entry.provider ?? "", entry.llmProvider ?? "", entry.model), model: entry.model, provider: entry.provider ?? null, reason, detail: DETAILS[reason] ?? reason };
}
function blockedCode(candidates, exclusions) {
  if (!candidates.length || candidates.every(candidate => !candidate.authorized)) return "NO_AUTHORIZED_PROVIDER";
  const authorized = candidates.filter(candidate => candidate.authorized);
  if (authorized.length && authorized.every(candidate => exclusions.get(candidate.candidateId) === "capability_unknown")) return "CAPABILITY_UNKNOWN";
  return "NO_ELIGIBLE_CANDIDATE";
}
export function selectRoute({ candidates = [], preferences = { order: [], revision: 0 }, requirements, binding = {}, policy = {}, ignoreHealth = false } = {}) {
  const normalizedRequirements = normalizeRequirements(requirements ?? {});
  const order = Array.isArray(preferences.order) ? preferences.order : [];
  const mode = bindingActive(binding) ? "explicit" : "auto";
  const exclusions = new Map();
  const considered = candidates.map(candidate => {
    const exclusion = evaluate(candidate, normalizedRequirements, binding, mode, ignoreHealth);
    exclusions.set(candidate.candidateId, exclusion);
    return { ...candidate, eligible: exclusion === null, exclusion };
  });
  const eligible = considered.filter(candidate => candidate.eligible);
  const fallbacks = considered.filter(candidate => !candidate.eligible).map(candidate => fallbackOf(candidate, candidate.exclusion));
  let chosen = null; let preferenceIndex = null; let bindingDescriptor = null; let blocked = null;
  if (mode === "explicit") {
    if (eligible.length) {
      chosen = rankWithin(eligible, normalizedRequirements)[0];
      bindingDescriptor = { mode: "explicit", source: "agent-binding", preferenceId: null };
    } else {
      blocked = { code: "EXPLICIT_BINDING_UNAVAILABLE", message: "The explicit model binding has no authorized, capable and available route" };
      if (!considered.some(candidate => entryMatches(candidate, binding))) fallbacks.push(syntheticFallback({ ...binding, provider: binding.provider ?? "", llmProvider: binding.llmProvider ?? "" }, "explicit_binding_absent"));
    }
  } else {
    for (let index = 0; index < order.length && !chosen; index++) {
      const entry = order[index];
      const matches = eligible.filter(candidate => entryMatches(candidate, entry));
      if (matches.length) {
        chosen = rankWithin(matches, normalizedRequirements)[0];
        preferenceIndex = index;
        bindingDescriptor = { mode: "preference", source: "user-preference", preferenceId: entry.id };
      }
    }
    if (!chosen && eligible.length) {
      chosen = rankWithin(eligible, normalizedRequirements)[0];
      bindingDescriptor = { mode: "default", source: "stable-default", preferenceId: null };
    }
    if (!chosen) {
      const code = blockedCode(considered, exclusions);
      blocked = { code, message: code === "CAPABILITY_UNKNOWN" ? "All authorized candidates have unknown required capabilities" : code === "NO_AUTHORIZED_PROVIDER" ? "No authorized provider is registered" : "No authorized candidate satisfies the task requirements and availability" };
    }
    const scanned = preferenceIndex == null ? order.length : preferenceIndex;
    const allowedProviders = policy.allowedProviders ?? [];
    const allowedModels = policy.allowedModels ?? [];
    for (let index = 0; index < scanned; index++) {
      const entry = order[index];
      if (considered.some(candidate => entryMatches(candidate, entry))) continue;
      let reason = "route_mismatch";
      if (allowedModels.length && !allowedModels.includes(entry.model)) reason = "unauthorized_model";
      else if (entry.provider && allowedProviders.length && !allowedProviders.includes(entry.provider)) reason = "unauthorized_provider";
      else if (!candidates.some(candidate => candidate.model === entry.model)) reason = "preference_model_absent";
      fallbacks.push(syntheticFallback(entry, reason));
    }
  }
  const limitedFallbacks = fallbacks.slice(0, MAX_CANDIDATES);
  return {
    selectorVersion: SELECTOR_VERSION,
    status: chosen ? "selected" : "blocked",
    binding: bindingDescriptor ?? { mode, source: mode === "explicit" ? "agent-binding" : "stable-default", preferenceId: null },
    chosen: chosen ? { candidateId: chosen.candidateId, model: chosen.model, provider: chosen.provider, llmProvider: chosen.llmProvider, reasoningEffort: selectedEffort(chosen, binding, mode, normalizedRequirements), origin: chosen.origin, persistent: chosen.persistent } : null,
    preferenceIndex,
    considered: considered.slice(0, MAX_CANDIDATES),
    fallbacks: limitedFallbacks,
    truncated: { considered: considered.length > MAX_CANDIDATES, fallbacks: fallbacks.length > MAX_CANDIDATES },
    blocked,
    policyFingerprint: modelPolicyFingerprint(policy),
    preferencesRevision: preferences.revision ?? 0,
    taskRequirements: normalizedRequirements,
    decidedAt: new Date().toISOString()
  };
}
export function selectionError(selection) {
  const blocked = selection?.blocked ?? { code: "NO_ELIGIBLE_CANDIDATE", message: "No eligible model route is available" };
  const legacy = { NO_AUTHORIZED_PROVIDER: "NO_PROVIDER", EXPLICIT_BINDING_UNAVAILABLE: "MODEL_UNAVAILABLE", CAPABILITY_UNKNOWN: "NO_ELIGIBLE_CANDIDATE", NO_ELIGIBLE_CANDIDATE: "NO_ELIGIBLE_CANDIDATE" }[blocked.code] ?? "NO_ELIGIBLE_CANDIDATE";
  const error = new Error(blocked.message);
  error.name = "AcmsError"; error.code = legacy; error.details = { selection };
  return error;
}
export function selectionBlocked(error) {
  return !!error?.details?.selection?.blocked && ["NO_PROVIDER", "MODEL_UNAVAILABLE", "MODEL_DENIED", "NO_ELIGIBLE_CANDIDATE", "EXPLICIT_BINDING_UNAVAILABLE", "CAPABILITY_UNKNOWN"].includes(error.code);
}
