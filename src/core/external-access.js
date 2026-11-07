import { assert, clone, id, now, text } from "./util.js";
import { assertCredentialActive, credentialView, goalAllowed, newCredentialToken, normalizeExpiry, projectAllowed, sameIdentity, summarizeScope, validateScope } from "./agent-identity.js";

export function authorizeUserAgent(company, actor, command, args) {
  const credential = assertCredentialActive(company.store.get("agentCredentials", actor.id));
  assert(sameIdentity(actor, credential), "UNAUTHORIZED", "A valid bearer credential is required");
  const scope = credential.scope ?? {};
  assert(Array.isArray(scope.commands) && scope.commands.includes(command), "FORBIDDEN", "This credential is not allowed to " + command);
  const write = command !== "status.read" && command !== "events.read";
  if (command === "goal.submit") {
    const project = company.store.get("projects", args.projectId);
    assert(project && project.status !== "deleted" && projectAllowed(credential, project), "SCOPE_DENIED", "Requested project is outside this credential scope");
    return;
  }
  if (command === "project.create") {
    assert(scope.projectCreate === true, "FORBIDDEN", "This credential is not allowed to project.create");
    return;
  }
  if (command === "interaction.answer") assert(Number(args.additionalRuntimeMs ?? 0) === 0, "OWNER_REQUIRED", "Only the owner may extend a goal runtime budget");
  const goalId = resolveCommandGoal(company, command, args, credential);
  if (!goalId) return;
  const goal = company.store.get("goals", goalId);
  assert(goal && goalAllowed(credential, goal, { write }), "SCOPE_DENIED", "Requested goal is outside this credential scope");
}

function resolveCommandGoal(company, command, args, credential) {
  const store = company.store;
  if (command === "status.read" || command === "events.read") {
    if (args.goalId) return args.goalId;
    const scope = credential.scope ?? {};
    if (scope.allGoals === true) return null;
    if ((scope.goalIds ?? []).length === 1) return scope.goalIds[0];
    assert(false, "INVALID_REQUEST", "goalId is required for this credential");
  }
  if (command === "interaction.answer") {
    const interaction = store.get("interactions", args.id);
    assert(interaction, "NOT_FOUND", "Interaction not found");
    const task = store.get("tasks", interaction.taskId);
    assert(task, "NOT_FOUND", "Task for this interaction was not found");
    return task.goalId;
  }
  const task = store.get("tasks", args.id);
  assert(task, "NOT_FOUND", "Task not found");
  return task.goalId;
}

function normalizeConstraints(value) {
  if (value === undefined || value === null) return [];
  assert(Array.isArray(value) && value.length <= 20, "INVALID_INPUT", "constraints must be an array of at most 20 items");
  return value.map(item => {
    assert(item && typeof item === "object" && !Array.isArray(item), "INVALID_INPUT", "constraints must contain objects");
    for (const field of Object.keys(item)) assert(field === "key" || field === "text", "INVALID_INPUT", "Unsupported constraint field " + field);
    return { key: text(item.key, "constraint.key", 64), text: text(item.text, "constraint.text", 2000) };
  });
}

export function submitGoal(company, args, actor, context = {}) {
  const constraints = normalizeConstraints(args.constraints);
  const priority = args.priority === undefined ? 0 : args.priority;
  assert(Number.isSafeInteger(priority) && priority >= 0 && priority <= 100, "INVALID_INPUT", "priority must be an integer between 0 and 100");
  const source = { kind: "user-agent", principalId: actor.id, onBehalfOf: clone(actor.onBehalfOf), requestId: context.externalKey ?? context.internalRequestId ?? "internal", submittedAt: now(), transport: context.transport ?? "http-loopback" };
  const goal = company.createGoalRecord({ ...args, priority }, actor, { source, constraints });
  const planTask = company.store.list("tasks").find(task => task.goalId === goal.id && task.kind === "plan") ?? null;
  company.store.event("goal.submitted", goal.id, { priority, constraints, planTaskId: planTask?.id ?? null, decision: { kind: "user-constraint", by: actor.id, basis: "external user-agent goal submission" } }, actor, { goalId: goal.id });
  return { goalId: goal.id, planTaskId: planTask?.id ?? null, cursor: company.store.cursor() };
}

export function createExternalProject(company, args, actor) {
  const credential = assertCredentialActive(company.store.get("agentCredentials", actor.id));
  assert(credential.scope?.projectCreate === true && (credential.scope?.commands ?? []).includes("project.create"), "FORBIDDEN", "This credential is not allowed to project.create");
  for (const field of ["id", "autoMerge", "checks"]) assert(args[field] === undefined, "INVALID_INPUT", "Field " + field + " is not allowed when creating a project through the agent API");
  const project = company.saveProjectRecord({ name: args.name, repoRoot: args.repoRoot, mode: args.mode ?? "git", autoMerge: false, checks: [] }, actor, { source: { kind: "user-agent", principalId: actor.id, onBehalfOf: clone(actor.onBehalfOf) } });
  return { projectId: project.id };
}

export function createCredentialRecord(company, args, actor) {
  company.owner(actor);
  assert(args && typeof args === "object" && !Array.isArray(args), "INVALID_INPUT", "Credential payload must be an object");
  for (const field of Object.keys(args)) assert(["name", "projectIds", "goalIds", "allGoals", "projectCreate", "commands", "expiresAt"].includes(field), "INVALID_INPUT", "Unknown credential field " + field);
  const name = text(args.name, "name", 200);
  const scope = validateScope(company.store, { projectIds: args.projectIds, goalIds: args.goalIds, allGoals: args.allGoals, projectCreate: args.projectCreate, commands: args.commands }, actor.kind);
  const expiresAt = normalizeExpiry(args.expiresAt);
  const generated = newCredentialToken();
  const credential = company.store.put("agentCredentials", { id: id("cred"), name, kind: "user-agent", onBehalfOf: { kind: "user", id: "owner" }, scope, tokenHash: generated.tokenHash, tokenPrefix: generated.tokenPrefix, status: "active", createdAt: now(), createdBy: actor.id, lastUsedAt: null, expiresAt });
  company.store.event("agentCredential.created", credential.id, { name, scope, tokenPrefix: generated.tokenPrefix }, actor);
  return { credential: credentialView(credential), token: generated.token };
}

export function updateCredentialScope(company, args, actor) {
  company.owner(actor);
  assert(args && typeof args === "object" && !Array.isArray(args), "INVALID_INPUT", "Scope update payload must be an object");
  for (const field of Object.keys(args)) assert(["credentialId", "expectedRevision", "projectIds", "goalIds", "allGoals", "projectCreate", "commands"].includes(field), "INVALID_INPUT", "Unknown scope field " + field);
  const credential = company.store.require("agentCredentials", args.credentialId);
  assert(credential.status === "active", "INVALID_TRANSITION", "A revoked credential cannot change scope");
  assert(Number.isSafeInteger(args.expectedRevision), "INVALID_INPUT", "expectedRevision is required");
  assert(credential.revision === args.expectedRevision, "REVISION_CONFLICT", "Credential changed; refresh and retry", { expectedRevision: args.expectedRevision, revision: credential.revision });
  const provided = ["projectIds", "goalIds", "allGoals", "projectCreate", "commands"].filter(field => args[field] !== undefined);
  assert(provided.length > 0, "INVALID_INPUT", "At least one scope field is required");
  const scope = validateScope(company.store, { projectIds: args.projectIds ?? credential.scope.projectIds, goalIds: args.goalIds ?? credential.scope.goalIds, allGoals: args.allGoals ?? credential.scope.allGoals, projectCreate: args.projectCreate ?? credential.scope.projectCreate, commands: args.commands ?? credential.scope.commands }, actor.kind);
  const before = summarizeScope(credential.scope);
  const saved = company.store.put("agentCredentials", { ...credential, scope }, args.expectedRevision);
  company.store.event("agentCredential.scope.changed", saved.id, { before, after: summarizeScope(scope), decision: { kind: "user-decision", by: actor.id, basis: "owner scope update" } }, actor);
  return { credential: credentialView(saved) };
}

export function revokeCredential(company, args, actor) {
  company.owner(actor);
  const credential = company.store.require("agentCredentials", args.credentialId);
  assert(credential.status === "active", "INVALID_TRANSITION", "Credential is already revoked");
  if (args.expectedRevision !== undefined) assert(credential.revision === args.expectedRevision, "REVISION_CONFLICT", "Credential changed; refresh and retry");
  const saved = company.store.put("agentCredentials", { ...credential, status: "revoked", revokedAt: now() }, args.expectedRevision);
  company.store.event("agentCredential.revoked", saved.id, { tokenPrefix: saved.tokenPrefix }, actor);
  return { credential: credentialView(saved) };
}

export function assertUserAgentAnswer(company, args, actor) {
  assert(Number(args.additionalRuntimeMs ?? 0) === 0, "OWNER_REQUIRED", "Only the owner may extend a goal runtime budget");
  const interaction = company.store.get("interactions", args.id);
  assert(interaction, "NOT_FOUND", "Interaction not found");
  assert(company.store.get("tasks", interaction.taskId), "NOT_FOUND", "Task for this interaction was not found");
}

export function credentialSnapshot(credential) { return credentialView(credential); }
