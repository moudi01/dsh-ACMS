import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assert, clone } from "./util.js";

export const TOKEN_MARKER = "acms_ag_";
export const EXTERNAL_COMMANDS = ["goal.submit", "status.read", "events.read", "interaction.answer", "task.pause", "task.resume", "project.create"];
export const READ_COMMANDS = ["status.read", "events.read"];
export const WRITE_COMMANDS = ["goal.submit", "interaction.answer", "task.pause", "task.resume", "project.create"];
export const DEFAULT_COMMANDS = ["goal.submit", "status.read", "events.read", "interaction.answer"];
export const GOVERNED_COMMANDS = ["task.pause", "task.resume", "project.create"];

export function hashToken(token) { return "sha256:" + createHash("sha256").update(String(token)).digest("hex"); }
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8"); const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
export function newCredentialToken() {
  const token = TOKEN_MARKER + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token), tokenPrefix: token.slice(0, TOKEN_MARKER.length + 6) };
}
export function credentialView(credential) {
  if (!credential) return null;
  return { id: credential.id, name: credential.name, kind: credential.kind, onBehalfOf: clone(credential.onBehalfOf), scope: clone(credential.scope), tokenPrefix: credential.tokenPrefix, status: credential.status, createdAt: credential.createdAt, createdBy: credential.createdBy, lastUsedAt: credential.lastUsedAt ?? null, expiresAt: credential.expiresAt ?? null, revision: credential.revision };
}
export function stableActor(credential) { return { kind: "user-agent", id: credential.id, onBehalfOf: clone(credential.onBehalfOf) }; }
export function sameIdentity(actor, credential) {
  return actor?.kind === "user-agent" && actor.id === credential?.id && actor.onBehalfOf?.kind === credential?.onBehalfOf?.kind && actor.onBehalfOf?.id === credential?.onBehalfOf?.id;
}
export function findCredentialByToken(store, token) {
  if (typeof token !== "string" || token.length < 12 || token.length > 200) return null;
  const hash = hashToken(token); let found = null;
  for (const credential of store.list("agentCredentials")) if (safeEqual(credential.tokenHash ?? "", hash)) found = credential;
  return found;
}
export function assertCredentialActive(credential) {
  assert(credential && credential.status === "active", "UNAUTHORIZED", "A valid bearer credential is required");
  if (credential.expiresAt) { const expires = Date.parse(credential.expiresAt); assert(Number.isFinite(expires) && expires > Date.now(), "UNAUTHORIZED", "A valid bearer credential is required"); }
  return credential;
}
export function validateExternalKey(value, label = "Idempotency key") {
  assert(typeof value === "string", "INVALID_REQUEST", label + " must be a string");
  assert(value.length >= 8 && value.length <= 200, "INVALID_REQUEST", label + " must contain 8 to 200 characters");
  for (const character of value) assert(character >= "!" && character <= "~", "INVALID_REQUEST", label + " must contain visible ASCII characters only");
  return value;
}
export function validateScope(store, input, actorKind) {
  assert(input && typeof input === "object" && !Array.isArray(input), "INVALID_INPUT", "scope must be an object");
  const projectIds = input.projectIds;
  assert(Array.isArray(projectIds) && projectIds.length >= 1 && projectIds.length <= 100, "INVALID_INPUT", "projectIds must contain between 1 and 100 projects");
  assert(projectIds.every(item => typeof item === "string" && item.length > 0 && item.length <= 200), "INVALID_INPUT", "projectIds must be project ID strings");
  assert(new Set(projectIds).size === projectIds.length, "INVALID_INPUT", "projectIds must not contain duplicates");
  for (const projectId of projectIds) { const project = store.get("projects", projectId); assert(project && project.status !== "deleted", "INVALID_INPUT", "Unknown or deleted project in projectIds"); }
  const goalIds = input.goalIds ?? [];
  assert(Array.isArray(goalIds) && goalIds.length <= 1000, "INVALID_INPUT", "goalIds must be an array of at most 1000 goals");
  assert(goalIds.every(item => typeof item === "string" && item.length > 0 && item.length <= 200), "INVALID_INPUT", "goalIds must be goal ID strings");
  assert(new Set(goalIds).size === goalIds.length, "INVALID_INPUT", "goalIds must not contain duplicates");
  for (const goalId of goalIds) {
    const goal = store.get("goals", goalId);
    assert(goal && goal.status !== "deleted", "INVALID_INPUT", "Unknown or deleted goal in goalIds");
    assert(projectIds.includes(goal.projectId), "INVALID_INPUT", "goalIds must belong to a project in projectIds");
  }
  const commands = input.commands ?? DEFAULT_COMMANDS;
  assert(Array.isArray(commands) && commands.length >= 1 && commands.length <= 20, "INVALID_INPUT", "commands must contain between 1 and 20 entries");
  assert(new Set(commands).size === commands.length, "INVALID_INPUT", "commands must not contain duplicates");
  for (const command of commands) assert(EXTERNAL_COMMANDS.includes(command), "INVALID_INPUT", "Unsupported external command " + command);
  const allGoals = input.allGoals === true;
  const projectCreate = input.projectCreate === true;
  if (allGoals) assert(commands.every(command => READ_COMMANDS.includes(command)), "INVALID_INPUT", "allGoals is only allowed for read-only credentials");
  if (projectCreate) {
    assert(actorKind === "owner" || actorKind === "system", "OWNER_REQUIRED", "Only the owner may grant projectCreate");
    assert(commands.includes("project.create"), "INVALID_INPUT", "projectCreate requires the project.create command");
  }
  assert(!commands.includes("project.create") || projectCreate, "INVALID_INPUT", "project.create requires projectCreate=true");
  return { projectIds: [...projectIds], goalIds: [...goalIds], allGoals, projectCreate, commands: [...commands] };
}
export function goalAllowed(credential, goal, options = {}) {
  if (!credential || !goal) return false;
  const scope = credential.scope ?? {};
  if ((scope.goalIds ?? []).includes(goal.id)) return true;
  if (goal.source?.principalId === credential.id) return true;
  if (options.write !== true && scope.allGoals === true && (scope.projectIds ?? []).includes(goal.projectId)) return true;
  return false;
}
export function projectAllowed(credential, project) {
  if (!credential || !project) return false;
  const scope = credential.scope ?? {};
  if ((scope.projectIds ?? []).includes(project.id)) return true;
  if (project.source?.principalId === credential.id) return true;
  return false;
}
export function normalizeExpiry(value) {
  if (value === undefined || value === null) return null;
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now(), "INVALID_INPUT", "expiresAt must be a future ISO 8601 timestamp");
  return new Date(Date.parse(value)).toISOString();
}
export function summarizeScope(scope) {
  return { projectIds: [...(scope?.projectIds ?? [])], goalIds: [...(scope?.goalIds ?? [])], allGoals: scope?.allGoals === true, projectCreate: scope?.projectCreate === true, commands: [...(scope?.commands ?? [])] };
}
