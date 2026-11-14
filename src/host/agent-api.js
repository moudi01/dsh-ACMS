import { contractVersion, deliveryGeneration, taskContractVersion } from '../core/goal-contract.js';
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AcmsError, asBusyError, assert, digest, now } from "../core/util.js";
import { assertCredentialActive, findCredentialByToken, goalAllowed, GOAL_CONTROL_COMMANDS, projectAllowed, stableActor } from "../core/agent-identity.js";
import { sanitizePreferences } from "../core/model-selection.js";
import { goalControlView } from "../core/goal-control.js";

export const API_VERSION = "1.0";
export const CONTRACT_VERSION = 1;
export const BASE_PATH = "/api/acms/agent/v1";
export const MAX_BODY = 262144;
export const MAX_PAGE = 200;
export const MAX_WAIT = 20000;

const EXTERNAL_KEY = { type: "external-key" };
const REQUEST_SCHEMAS = {
  GoalSubmitRequest: {
    type: "object", required: ["title", "description", "acceptance", "projectId"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      description: { type: "string", minLength: 1, maxLength: 20000 },
      acceptance: { type: "string", minLength: 1, maxLength: 20000 },
      projectId: { type: "string", minLength: 1, maxLength: 200 },
      constraints: { type: "array", maxItems: 20, items: { type: "object", required: ["key", "text"], properties: { key: { type: "string", minLength: 1, maxLength: 64 }, text: { type: "string", minLength: 1, maxLength: 2000 } } } },
      priority: { type: "integer", minimum: 0, maximum: 100 },
      requestId: EXTERNAL_KEY,
    },
  },
  ProjectSubmitRequest: {
    type: "object", required: ["name", "repoRoot"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      repoRoot: { type: "string", minLength: 1, maxLength: 4096 },
      mode: { enum: ["git", "copy"] },
      requestId: EXTERNAL_KEY,
    },
  },
  InteractionAnswerRequest: {
    type: "object", required: ["answer"],
    properties: {
      answer: { type: "string", minLength: 1, maxLength: 20000 },
      expectedRevision: { type: "integer", minimum: 1 },
      additionalRuntimeMs: { type: "integer", minimum: 0, maximum: 2147483647 },
      requestId: EXTERNAL_KEY,
    },
  },
  TaskControlRequest: {
    type: "object",
    properties: {
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      requestId: EXTERNAL_KEY,
    },
  },
  GoalControlRequest: {
    type: "object",
    required: ["expectedRevision"],
    properties: {
      expectedRevision: { type: "integer", minimum: 1 },
      afterCurrent: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      requestId: EXTERNAL_KEY,
    },
  },
};
const OPERATIONS = ["GET /discover", "GET /status", "GET /projects", "GET /projects/{id}", "GET /goals", "GET /goals/{id}", "GET /tasks", "GET /tasks/{id}", "GET /artifacts/{id}", "GET /reviews", "GET /blockers", "GET /events", "POST /goals", "POST /projects", "POST /interactions/{id}/answer", "POST /tasks/{id}/pause", "POST /tasks/{id}/resume", ...GOAL_CONTROL_COMMANDS.map(command => "POST /goals/{id}/" + command.slice(5))];

function validateExternalKey(value, label = "Idempotency key") {
  assert(typeof value === "string", "INVALID_REQUEST", label + " must be a string");
  assert(value.length >= 8 && value.length <= 200, "INVALID_REQUEST", label + " must contain 8 to 200 characters");
  for (const character of value) assert(character >= "!" && character <= "~", "INVALID_REQUEST", label + " must contain visible ASCII characters only");
  return value;
}

function validateSchema(schema, value, pointer) {
  if (schema.type === "boolean") {
    assert(typeof value === "boolean", "INVALID_REQUEST", pointer + " must be a boolean");
    return value;
  }
  if (schema.type === "external-key") return validateExternalKey(value, pointer);
  if (schema.enum) { assert(schema.enum.includes(value), "INVALID_REQUEST", pointer + " has an unsupported value"); return value; }
  if (schema.type === "object") {
    assert(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_REQUEST", pointer + " must be an object");
    for (const key of schema.required ?? []) assert(Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined, "INVALID_REQUEST", pointer + " is missing " + key);
    const allowed = Object.keys(schema.properties ?? {});
    for (const key of Object.keys(value)) assert(allowed.includes(key), "INVALID_REQUEST", pointer + " contains an unknown field " + key);
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(value, key)) validateSchema(schema.properties[key], value[key], pointer + "." + key);
    return value;
  }
  if (schema.type === "array") {
    assert(Array.isArray(value), "INVALID_REQUEST", pointer + " must be an array");
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, "INVALID_REQUEST", pointer + " must contain at least " + schema.minItems + " items");
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, "INVALID_REQUEST", pointer + " must contain at most " + schema.maxItems + " items");
    if (schema.uniqueItems) assert(new Set(value.map(item => JSON.stringify(item))).size === value.length, "INVALID_REQUEST", pointer + " must contain unique items");
    for (let index = 0; index < value.length; index += 1) validateSchema(schema.items, value[index], pointer + "[" + index + "]");
    return value;
  }
  if (schema.type === "string") {
    assert(typeof value === "string", "INVALID_REQUEST", pointer + " must be a string");
    if (schema.minLength !== undefined) assert(value.length >= schema.minLength, "INVALID_REQUEST", pointer + " must contain at least " + schema.minLength + " characters");
    if (schema.maxLength !== undefined) assert(value.length <= schema.maxLength, "INVALID_REQUEST", pointer + " must contain at most " + schema.maxLength + " characters");
    return value;
  }
  if (schema.type === "integer") {
    assert(Number.isSafeInteger(value), "INVALID_REQUEST", pointer + " must be an integer");
    if (schema.minimum !== undefined) assert(value >= schema.minimum, "INVALID_REQUEST", pointer + " must be at least " + schema.minimum);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, "INVALID_REQUEST", pointer + " must be at most " + schema.maximum);
    return value;
  }
  assert(false, "INVALID_REQUEST", "Unsupported schema for " + pointer);
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let finished = false;
    const fail = error => { if (finished) return; finished = true; request.resume(); reject(error); };
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { fail(new AcmsError("BODY_LIMIT", "Request exceeds 256 KiB")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { if (finished) return; finished = true; resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", error => fail(error instanceof AcmsError ? error : new AcmsError("INVALID_REQUEST", "Request body could not be read")));
    request.on("aborted", () => fail(new AcmsError("INVALID_REQUEST", "Request body could not be read")));
  });
}

async function readWriteBody(request, schemaName) {
  const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  assert(contentType === "application/json", "CONTENT_TYPE", "JSON content type is required");
  const raw = await readRawBody(request);
  let body;
  try { body = JSON.parse(raw); } catch { throw new AcmsError("INVALID_REQUEST", "Request body is not valid JSON"); }
  validateSchema(REQUEST_SCHEMAS[schemaName], body, "body");
  return body;
}

function resolveIdempotency(request, body) {
  const headerValues = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (String(request.rawHeaders[index]).toLowerCase() === "idempotency-key") headerValues.push(request.rawHeaders[index + 1]);
  assert(headerValues.length <= 1, "INVALID_REQUEST", "Duplicate Idempotency-Key headers are not allowed");
  const header = headerValues[0];
  if (header !== undefined) validateExternalKey(header, "Idempotency-Key");
  const bodyKey = body.requestId;
  if (bodyKey !== undefined) validateExternalKey(bodyKey, "requestId");
  if (header !== undefined && bodyKey !== undefined) assert(header === bodyKey, "IDEMPOTENCY_KEY_MISMATCH", "Idempotency-Key header and body requestId must match exactly");
  const key = header ?? bodyKey;
  assert(key !== undefined, "IDEMPOTENCY_REQUIRED", "A stable idempotency key is required");
  return key;
}

export function internalRequestId(credentialId, externalKey) {
  return "ext:" + createHash("sha256").update(credentialId + "\u0000" + externalKey).digest("hex").slice(0, 32);
}

function bearerToken(request) {
  const header = request.headers.authorization;
  assert(typeof header === "string" && header.startsWith("Bearer "), "UNAUTHORIZED", "A valid bearer credential is required");
  return header.slice(7).trim();
}

function isLoopback(address) { return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"; }

function parseCursor(value) {
  if (value === null || value === "") return 0;
  const text = String(value).trim();
  assert(/^[0-9]+$/.test(text), "CURSOR_INVALID", "Event cursor must be a non-negative integer");
  const number = Number(text);
  assert(Number.isSafeInteger(number), "CURSOR_INVALID", "Event cursor must be a non-negative integer");
  return number;
}

function parseIntegerParam(value, fallback, minimum, maximum, label) {
  if (value === null || value === "") return fallback;
  const text = String(value).trim();
  assert(/^[0-9]+$/.test(text), "INVALID_REQUEST", label + " must be an integer");
  const number = Number(text);
  assert(Number.isSafeInteger(number) && number >= minimum && number <= maximum, "INVALID_REQUEST", label + " must be between " + minimum + " and " + maximum);
  return number;
}

export const ERROR_STATUS = {
  INVALID_REQUEST: 400, INVALID_INPUT: 400, CONTENT_TYPE: 400, BODY_LIMIT: 400,
  IDEMPOTENCY_REQUIRED: 400, IDEMPOTENCY_KEY_MISMATCH: 400, CURSOR_INVALID: 400, CURSOR_AHEAD: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403, SCOPE_DENIED: 403, OWNER_REQUIRED: 403,
  NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, REVISION_CONFLICT: 409, ACTIVE_LIMIT: 409, TASK_ACTIVE: 409, TASK_CLOSED: 409, WAITING_INPUT: 409, INVALID_TRANSITION: 409, INTERACTION_STALE: 409, GOAL_BUDGET_EXHAUSTED: 409, GOAL_PAUSED: 409, GOAL_CLOSED: 409, ALREADY_ANSWERED: 409, AGENT_RETIRED: 409, ENTITY_DELETED: 409, DELETE_BLOCKED: 409, PROJECT_IN_USE: 409,
  ENGINE_BUSY: 503, SHUTTING_DOWN: 503, LEASE_LOST: 503,
  ARTIFACT_MISSING: 410, ARTIFACT_CORRUPT: 409, ARTIFACT_TOO_LARGE: 413,
};

function assertCredentialCommand(credential, command) {
  assert((credential.scope?.commands ?? []).includes(command), "FORBIDDEN", "This credential is not allowed to " + command);
}

function resolveGoal(company, credential, goalIdParam, command) {
  assertCredentialCommand(credential, command);
  const scope = credential.scope ?? {};
  let goalId = goalIdParam;
  if (!goalId) {
    if ((scope.goalIds ?? []).length === 1 && scope.allGoals !== true) goalId = scope.goalIds[0];
    else throw new AcmsError("INVALID_REQUEST", "goalId is required for this credential");
  }
  const goal = company.store.get("goals", goalId);
  assert(goal && goal.status !== "deleted" && goalAllowed(credential, goal, { write: false }), "SCOPE_DENIED", "Requested goal is outside this credential scope");
  return goal;
}

function goalView(goal) {
  return { id: goal.id, title: goal.title, description: goal.description, acceptance: goal.acceptance, projectId: goal.projectId, status: goal.status, contractVersion: contractVersion(goal),
    completedContractVersion: goal.completedContractVersion ?? (goal.status === 'succeeded' ? contractVersion(goal) : null), executionControl: goal.executionControl ?? null,
    contractChange: goal.contractChange ?? null, supersededTaskIds: goal.supersededTaskIds ?? [], templateId: goal.templateId ?? 'base', templateVersion: goal.templateSnapshot?.version ?? null, constraints: goal.constraints ?? [], source: goal.source ?? null, priority: Number.isInteger(goal.priority) ? goal.priority : 50, createdAt: goal.createdAt, updatedAt: goal.updatedAt, revision: goal.revision };
}
function projectView(project) {
  return { id: project.id, name: project.name, repoRoot: project.repoRoot, mode: project.mode, checks: project.checks ?? [], autoMerge: project.autoMerge === true, status: project.status, source: project.source ?? null, createdAt: project.createdAt, updatedAt: project.updatedAt };
}
function taskView(task) {
  return { id: task.id, goalId: task.goalId, projectId: task.projectId, title: task.title, description: task.description, acceptance: task.acceptance, kind: task.kind, status: task.status, goalContractVersion: taskContractVersion(task),
    deliveryGeneration: deliveryGeneration(task), reviewedContractVersion: task.kind === 'review' ? task.reviewedContractVersion ?? 1 : null,
    reviewedTaskGeneration: task.reviewedTaskGeneration ?? null, deliveryHash: task.deliveryHash ?? null,
    agentId: task.agentId, parentId: task.parentId ?? null, dependencies: [...(task.dependencies ?? [])], reviewScope: task.reviewScope ?? null, passed: task.passed ?? null, attemptCount: task.attempts ?? 0, blocker: task.blocker ?? null, lastAnswer: task.lastAnswer ?? null, artifactHash: task.artifactHash ?? null, reviewOf: task.reviewOf ?? null, feedback: task.feedback ?? null, requiresArtifacts: task.requiresArtifacts !== false, createdAt: task.createdAt, updatedAt: task.updatedAt };
}
function attemptView(attempt) {
  return { id: attempt.id, taskId: attempt.taskId, agentId: attempt.agentId, status: attempt.status, goalContractVersion: taskContractVersion(attempt), model: attempt.model ?? null, provider: attempt.provider ?? null, llmProvider: attempt.llmProvider ?? null, selection: attempt.selection ?? null, startedAt: attempt.startedAt ?? null, finishedAt: attempt.finishedAt ?? null, summary: attempt.summary ?? null };
}
function artifactView(artifact) {
  return { id: artifact.id, taskId: artifact.taskId, path: artifact.path, title: artifact.title, hash: artifact.hash, bytes: artifact.bytes ?? null, createdAt: artifact.createdAt,
    ...(artifact.archiveVerification ? { archiveVerification: artifact.archiveVerification } : {}) };
}
function verificationView(item) {
  return { id: item.id, taskId: item.taskId, kind: item.kind, goalContractVersion: taskContractVersion(item), taskGeneration: item.taskGeneration ?? null, passed: item.passed === true, summary: item.summary ?? null, artifactHash: item.artifactHash ?? null, createdAt: item.createdAt };
}
function interactionView(item) {
  return { id: item.id, taskId: item.taskId, kind: item.kind, question: item.question, status: item.status, generation: item.taskGeneration ?? null, expectedRevision: item.revision, createdAt: item.createdAt };
}
function modelPreferencesView(store) { return sanitizePreferences(store.get("modelPreferences", "model")); }

function statusValue(company, goal) {
  const store = company.store;
  const tasks = store.list("tasks").filter(task => task.goalId === goal.id && task.status !== "deleted");
  const taskIds = new Set(tasks.map(task => task.id));
  const attempts = store.list("attempts").filter(item => taskIds.has(item.taskId));
  const artifacts = store.list("artifacts").filter(item => taskIds.has(item.taskId)).map(artifactView);
  const verifications = store.list("verifications").filter(item => taskIds.has(item.taskId) || item.kind === 'goal-review' && item.taskId === goal.id).map(verificationView);
  const interactions = store.list("interactions").filter(item => taskIds.has(item.taskId) && item.status === "pending").map(interactionView);
  return { goal: { ...goalView(goal), deliveryHash: company.deliveryHash(goal.id), controlSummary: goalControlView(goal, tasks, attempts) },
    tasks: tasks.map(taskView), attempts: attempts.map(attemptView), artifacts, verifications, interactions, cursor: store.cursor(), modelPreferences: modelPreferencesView(store) };
}

function goalDetail(company, goal) {
  const value = statusValue(company, goal);
  return { goal: value.goal, tasks: value.tasks, blockers: value.interactions, cursor: value.cursor };
}

function taskDetail(company, goal, task) {
  const store = company.store;
  const attempts = store.list("attempts").filter(item => item.taskId === task.id).map(attemptView);
  const artifacts = store.list("artifacts").filter(item => item.taskId === task.id).map(artifactView);
  const attemptIds = new Set(attempts.map(item => item.id));
  const verifications = store.list("verifications").filter(item => item.taskId === task.id || (task.kind === "review" && attemptIds.has(item.attemptId))).map(item => task.kind === "review" ? { ...verificationView(item), reviewTaskId: task.id } : verificationView(item));
  const reviews = store.list("tasks").filter(item => item.reviewOf === task.id && item.status !== "deleted").map(taskView);
  const blockers = store.list("interactions").filter(item => item.taskId === task.id && item.status === "pending").map(interactionView);
  return { goalId: goal.id, task: taskView(task), attempts, artifacts, verifications, reviews, blockers };
}

function reviewsValue(company, goal) {
  const store = company.store;
  const tasks = store.list("tasks").filter(task => task.goalId === goal.id && task.kind === "review" && task.status !== "deleted");
  const taskIds = new Set(tasks.map(task => task.id));
  const attemptTasks = new Map(store.list("attempts").filter(item => taskIds.has(item.taskId)).map(item => [item.id, item.taskId]));
  const verifications = store.list("verifications").filter(item => taskIds.has(item.taskId) || attemptTasks.has(item.attemptId)).map(item => ({ ...verificationView(item), reviewTaskId: taskIds.has(item.taskId) ? item.taskId : attemptTasks.get(item.attemptId) ?? null }));
  return { goalId: goal.id, reviews: tasks.map(taskView), verifications, cursor: store.cursor() };
}

function blockersValue(company, goal) {
  const store = company.store;
  const taskIds = new Set(store.list("tasks").filter(task => task.goalId === goal.id).map(task => task.id));
  const interactions = store.list("interactions").filter(item => taskIds.has(item.taskId) && item.status === "pending").map(interactionView);
  return { goalId: goal.id, blockers: interactions, count: interactions.length, cursor: store.cursor() };
}

async function waitForEvent(store, after, timeoutMs, request) {
  if (store.cursor() > after || request.destroyed) return;
  await new Promise(resolve => {
    let timer = null; let finished = false;
    const done = () => { if (finished) return; finished = true; if (timer) clearTimeout(timer); store.events.off("event", done); request.off("close", done); resolve(); };
    store.events.on("event", done); request.on("close", done); timer = setTimeout(done, timeoutMs);
  });
}

async function readEvents(runtime, credential, url, request, revalidate) {
  const company = runtime.company;
  assertCredentialCommand(credential, "events.read");
  const after = parseCursor(url.searchParams.get("after"));
  const limit = parseIntegerParam(url.searchParams.get("limit"), 100, 1, MAX_PAGE, "limit");
  const wait = parseIntegerParam(url.searchParams.get("wait"), 0, 0, MAX_WAIT, "wait");
  const goalParam = url.searchParams.get("goalId") || null;
  const resolveEventScope = current => {
    assertCredentialCommand(current, "events.read");
    const scope = current.scope ?? {};
    if (goalParam) return new Set([resolveGoal(company, current, goalParam, "events.read").id]);
    assert(scope.allGoals === true, "INVALID_REQUEST", "goalId is required for this credential");
    return new Set(company.store.list("goals").filter(goal => (scope.projectIds ?? []).includes(goal.projectId)).map(goal => goal.id));
  };
  let goalIds = resolveEventScope(credential);
  const latest = company.store.cursor();
  assert(after <= latest, "CURSOR_AHEAD", "Event cursor is ahead of this host", { after, latestCursor: latest });
  if (wait > 0) await waitForEvent(company.store, after, wait, request);
  // Revalidate the live credential and its current scope after the wait and
  // before reading event data: a request authenticated before a revoke, expiry
  // or scope narrowing must not return success or data.
  const current = revalidate ? revalidate() : credential;
  goalIds = resolveEventScope(current);
  const latestAfterWait = company.store.cursor();
  assert(after <= latestAfterWait, "CURSOR_AHEAD", "Event cursor is ahead of this host", { after, latestCursor: latestAfterWait });
  const page = company.store.pageScoped({ after, limit, goalIds });
  return { value: { entries: page.entries, nextCursor: page.nextCursor, latestCursor: page.latestCursor, hasMore: page.hasMore } };
}

async function submitGoalRequest(runtime, credential, request, context) {
  const company = runtime.company;
  assertCredentialCommand(credential, "goal.submit");
  const body = await readWriteBody(request, "GoalSubmitRequest");
  const key = resolveIdempotency(request, body);
  context.requestId = key;
  const args = { ...body }; delete args.requestId;
  const outcome = company.command(stableActor(credential), internalRequestId(credential.id, key), "goal.submit", args, { meta: true, externalKey: key, transport: "http-loopback" });
  if (!outcome.replayed) runtime.engine?.kick?.();
  return { value: { ...outcome.value, cursor: company.store.cursor() }, replayed: outcome.replayed, requestId: key };
}

async function createProjectRequest(runtime, credential, request, context) {
  const company = runtime.company;
  assertCredentialCommand(credential, "project.create");
  const body = await readWriteBody(request, "ProjectSubmitRequest");
  const key = resolveIdempotency(request, body);
  context.requestId = key;
  const args = { ...body }; delete args.requestId;
  if (runtime.workspaces?.validateProject) await runtime.workspaces.validateProject({ ...args, mode: args.mode ?? "git", checks: [], autoMerge: false });
  const outcome = company.command(stableActor(credential), internalRequestId(credential.id, key), "project.create", args, { meta: true, externalKey: key, transport: "http-loopback" });
  if (!outcome.replayed) runtime.engine?.kick?.();
  if (runtime.workspaces?.publishProject && outcome.value?.projectId) { try { await runtime.workspaces.publishProject(company.store.require("projects", outcome.value.projectId)); } catch { } }
  return { value: outcome.value, replayed: outcome.replayed, requestId: key };
}

async function answerRequest(runtime, credential, request, context, interactionId) {
  const company = runtime.company;
  assertCredentialCommand(credential, "interaction.answer");
  const body = await readWriteBody(request, "InteractionAnswerRequest");
  const key = resolveIdempotency(request, body);
  context.requestId = key;
  const args = { ...body, id: interactionId }; delete args.requestId;
  const outcome = company.command(stableActor(credential), internalRequestId(credential.id, key), "interaction.answer", args, { meta: true, externalKey: key, transport: "http-loopback" });
  if (!outcome.replayed) runtime.engine?.kick?.();
  return { value: outcome.value, replayed: outcome.replayed, requestId: key };
}

async function controlRequest(runtime, credential, request, context, targetId, command) {
  const company = runtime.company;
  assertCredentialCommand(credential, command);
  const goalControl = GOAL_CONTROL_COMMANDS.includes(command);
  const body = await readWriteBody(request, goalControl ? "GoalControlRequest" : "TaskControlRequest");
  const key = resolveIdempotency(request, body);
  context.requestId = key;
  const args = { ...body, id: targetId }; delete args.requestId;
  const outcome = company.command(stableActor(credential), internalRequestId(credential.id, key), command, args, { meta: true, externalKey: key, transport: "http-loopback" });
  if ((goalControl || command === "task.resume") && !outcome.replayed) runtime.engine?.kick?.();
  return { value: goalControl ? goalView(outcome.value) : outcome.value, replayed: outcome.replayed, requestId: key };
}

function authenticate(company, request) {
  const header = request.headers.authorization;
  assert(typeof header === "string" && header.startsWith("Bearer "), "UNAUTHORIZED", "A valid bearer credential is required");
  const credential = findCredentialByToken(company.store, header.slice(7).trim());
  assertCredentialActive(credential);
  const lastUsed = Date.parse(credential.lastUsedAt ?? "") || 0;
  if (Date.now() - lastUsed > 30000) { try { company.store.transaction(() => company.store.touch("agentCredentials", credential.id, { lastUsedAt: now() })); } catch { } }
  return credential;
}

async function dispatch(runtime, state, request, context) {
  const company = runtime.company;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  assert(url.pathname === BASE_PATH || url.pathname.startsWith(BASE_PATH + "/"), "NOT_FOUND", "Unknown agent API path");
  const credential = authenticate(company, request);
  context.credential = credential;
  const method = request.method ?? "GET";
  const rest = url.pathname.slice(BASE_PATH.length).replace(/^\/+/, "");
  const parts = rest === "" ? [] : rest.split("/").map(segment => { try { return decodeURIComponent(segment); } catch { throw new AcmsError("INVALID_REQUEST", "Malformed path segment"); } });
  const goalParam = () => url.searchParams.get("goalId") || null;
  const read = (handler, command = "status.read") => {
    assert(method === "GET", "METHOD_NOT_ALLOWED", "GET required for this endpoint");
    if (command !== null) assertCredentialCommand(credential, command);
    return { value: handler() };
  };
  if (parts.length === 1 && parts[0] === "discover") return read(() => ({ apiVersion: API_VERSION, contractVersion: CONTRACT_VERSION, operations: OPERATIONS, limits: { bodyBytes: MAX_BODY, pageSize: MAX_PAGE, longPollMs: MAX_WAIT }, instanceId: state.instanceId }), null);
  if (parts.length === 1 && parts[0] === "status") return read(() => statusValue(company, resolveGoal(company, credential, goalParam(), "status.read")));
  if (parts.length === 1 && parts[0] === "projects") {
    if (method === "POST") return createProjectRequest(runtime, credential, request, context);
    return read(() => ({ projects: company.store.list("projects").filter(project => project.status !== "deleted" && projectAllowed(credential, project)).map(projectView) }));
  }
  if (parts.length === 2 && parts[0] === "projects") {
    return read(() => {
      const project = company.store.get("projects", parts[1]);
      assert(project && project.status !== "deleted", "NOT_FOUND", "Project not found");
      assert(projectAllowed(credential, project), "SCOPE_DENIED", "Requested project is outside this credential scope");
      return { project: projectView(project) };
    });
  }
  if (parts.length === 1 && parts[0] === "goals") {
    if (method === "POST") return submitGoalRequest(runtime, credential, request, context);
    return read(() => ({ goals: company.store.list("goals").filter(goal => goal.status !== "deleted" && goalAllowed(credential, goal, { write: false })).map(goalView) }));
  }
  if (parts.length === 2 && parts[0] === "goals") return read(() => goalDetail(company, resolveGoal(company, credential, parts[1], "status.read")));
  if (parts.length === 3 && parts[0] === "goals" && GOAL_CONTROL_COMMANDS.includes("goal." + parts[2])) {
    assert(method === "POST", "METHOD_NOT_ALLOWED", "POST required for this endpoint");
    return controlRequest(runtime, credential, request, context, parts[1], "goal." + parts[2]);
  }
  if (parts.length === 1 && parts[0] === "tasks") {
    return read(() => {
      const goal = resolveGoal(company, credential, goalParam(), "status.read");
      const status = url.searchParams.get("status") || null;
      let tasks = company.store.list("tasks").filter(task => task.goalId === goal.id && task.status !== "deleted");
      if (status) tasks = tasks.filter(task => task.status === status);
      return { goalId: goal.id, tasks: tasks.slice(0, MAX_PAGE).map(taskView), truncated: tasks.length > MAX_PAGE };
    });
  }
  if (parts.length === 2 && parts[0] === "tasks") {
    return read(() => {
      assertCredentialCommand(credential, "status.read");
      const task = company.store.get("tasks", parts[1]);
      assert(task && task.status !== "deleted", "NOT_FOUND", "Task not found");
      const goal = company.store.get("goals", task.goalId);
      assert(goal && goalAllowed(credential, goal, { write: false }), "SCOPE_DENIED", "Requested task is outside this credential scope");
      return taskDetail(company, goal, task);
    });
  }
  if (parts.length === 3 && parts[0] === "tasks" && (parts[2] === "pause" || parts[2] === "resume")) {
    assert(method === "POST", "METHOD_NOT_ALLOWED", "POST required for this endpoint");
    return controlRequest(runtime, credential, request, context, parts[1], parts[2] === "pause" ? "task.pause" : "task.resume");
  }
  if (parts.length === 3 && parts[0] === "interactions" && parts[2] === "answer") {
    assert(method === "POST", "METHOD_NOT_ALLOWED", "POST required for this endpoint");
    return answerRequest(runtime, credential, request, context, parts[1]);
  }
  if (parts.length === 2 && parts[0] === "artifacts") {
    assert(method === "GET", "METHOD_NOT_ALLOWED", "GET required for this endpoint");
    assertCredentialCommand(credential, "status.read");
    const artifact = company.store.get("artifacts", parts[1]);
    assert(artifact, "NOT_FOUND", "Artifact not found");
    const task = company.store.get("tasks", artifact.taskId);
    assert(task && task.status !== "deleted", "NOT_FOUND", "Artifact task not found");
    const goal = company.store.get("goals", task.goalId);
    assert(goal && goalAllowed(credential, goal, { write: false }), "SCOPE_DENIED", "Requested artifact is outside this credential scope");
    const limit = company.policy().maxArtifactBytes;
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, "ARTIFACT_CORRUPT", "Artifact record has an invalid byte count");
    assert(artifact.bytes <= limit, "ARTIFACT_TOO_LARGE", "Artifact exceeds the company size limit");
    let stat;
    try { stat = await fs.stat(artifact.blob); } catch { throw new AcmsError("ARTIFACT_MISSING", "Artifact blob is missing"); }
    assert(stat.isFile() && stat.size === artifact.bytes, "ARTIFACT_CORRUPT", "Artifact byte count does not match its record");
    let bytes;
    try { bytes = await fs.readFile(artifact.blob); } catch { throw new AcmsError("ARTIFACT_MISSING", "Artifact blob is missing"); }
    assert(bytes.length === artifact.bytes, "ARTIFACT_CORRUPT", "Artifact byte count does not match its record");
    if (artifact.hash) assert(digest(bytes.toString("base64")) === artifact.hash, "ARTIFACT_CORRUPT", "Artifact content does not match its recorded digest");
    return { value: { artifact: artifactView(artifact), goalId: goal.id, taskId: task.id, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), encoding: "base64", content: bytes.toString("base64") } };
  }
  if (parts.length === 1 && parts[0] === "reviews") return read(() => reviewsValue(company, resolveGoal(company, credential, goalParam(), "status.read")));
  if (parts.length === 1 && parts[0] === "blockers") return read(() => blockersValue(company, resolveGoal(company, credential, goalParam(), "status.read")));
  if (parts.length === 1 && parts[0] === "events") {
    assert(method === "GET", "METHOD_NOT_ALLOWED", "GET required for this endpoint");
    return readEvents(runtime, credential, url, request, () => authenticate(company, request));
  }
  throw new AcmsError("NOT_FOUND", "Unknown agent API path");
}

function discoveryPayload(state) {
  return { contractVersion: CONTRACT_VERSION, apiVersion: API_VERSION, baseUrl: state.baseUrl, instanceId: state.instanceId, pid: process.pid, startedAt: state.startedAt, transport: "http-loopback", auth: "bearer" };
}
async function writeDiscovery(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.unlink(temporary); } catch { }
    throw error;
  }
}
async function removeDiscovery(file, instanceId) {
  try { const parsed = JSON.parse(await fs.readFile(file, "utf8")); if (parsed.instanceId === instanceId) await fs.unlink(file); } catch { }
}
function writePayload(response, status, payload, requestId) {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-acms-api-version": API_VERSION, "x-acms-request-id": requestId });
  response.end(JSON.stringify(payload));
}
function sendFailure(state, response, requestId, error) {
  const busy = asBusyError(error);
  if (busy) error = busy;
  const known = error instanceof AcmsError;
  const code = known ? error.code : "INTERNAL";
  const status = known ? (ERROR_STATUS[code] ?? 400) : 500;
  const message = known ? String(error.message ?? "Request failed").slice(0, 2000) : "Unexpected internal error";
  const details = known ? error.details ?? {} : {};
  const retryable = status === 503 || (known && error.details?.retryable === true);
  writePayload(response, status, { ok: false, apiVersion: API_VERSION, requestId, error: { code, message, details, retryable } }, requestId);
}

function sendSuccess(state, response, requestId, outcome) {
  const value = outcome?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) { sendFailure(state, response, requestId, new AcmsError("INTERNAL", "Unexpected internal error")); return; }
  writePayload(response, 200, { ok: true, apiVersion: API_VERSION, requestId, instanceId: state.instanceId, replayed: outcome.replayed === true, value }, requestId);
}
async function handleRequest(runtime, state, request, response) {
  const context = { requestId: "req_" + randomUUID(), credential: null };
  try {
    assert(!state.closing, "SHUTTING_DOWN", "ACMS agent API is shutting down");
    assert(isLoopback(request.socket.remoteAddress), "FORBIDDEN", "The agent API only accepts loopback clients");
    const outcome = await dispatch(runtime, state, request, context);
    sendSuccess(state, response, outcome?.requestId ?? context.requestId, outcome ?? { value: {} });
  } catch (error) {
    const busy = asBusyError(error);
    if (busy) error = busy;
    if (!(error instanceof AcmsError)) console.error("ACMS agent API internal error", error?.message);
    sendFailure(state, response, context.requestId, error);
  }
}

export function createAgentApi(runtime, options = {}) {
  const dataDir = options.dataDir ?? runtime.dataDir ?? null;
  const discoveryFile = options.discoveryFile ?? (dataDir ? path.join(dataDir, "agent-api.json") : null);
  const state = { instanceId: options.instanceId ?? randomUUID(), startedAt: now(), baseUrl: null, port: 0, closing: false, closed: false };
  const server = http.createServer((request, response) => { handleRequest(runtime, state, request, response); });
  server.keepAliveTimeout = 5000;
  async function start() {
    try {
      await new Promise((resolve, reject) => {
        const onListening = () => { server.off("error", onError); resolve(); };
        const onError = error => { server.off("listening", onListening); reject(error); };
        server.once("error", onError); server.once("listening", onListening); server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      state.port = address.port; state.baseUrl = "http://127.0.0.1:" + address.port + BASE_PATH;
      if (discoveryFile) await writeDiscovery(discoveryFile, discoveryPayload(state));
      return { baseUrl: state.baseUrl, instanceId: state.instanceId, port: state.port, discoveryFile };
    } catch (error) {
      // Release a listener that may already be bound before publishing failed.
      await close();
      throw error;
    }
  }
  async function close() {
    if (state.closed) return;
    state.closed = true; state.closing = true;
    await new Promise(resolve => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; resolve(); };
      server.close(done); server.closeIdleConnections?.();
      const timer = setTimeout(() => { server.closeAllConnections?.(); done(); }, 2000);
      timer.unref?.();
    });
    if (discoveryFile) await removeDiscovery(discoveryFile, state.instanceId);
  }
  return {
    get baseUrl() { return state.baseUrl; }, get port() { return state.port; }, get instanceId() { return state.instanceId; },
    get discoveryFile() { return discoveryFile; }, get server() { return server; }, get closing() { return state.closing; },
    start, close,
  };
}
