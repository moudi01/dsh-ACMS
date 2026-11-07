#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { options._.push(item); continue; }
    const key = item.slice(2); const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}
function dataDir() { return path.resolve(process.env.ACMS_DATA_DIR ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "acms")); }
function discoveryPath(options) { return path.resolve(options.discovery ?? process.env.ACMS_AGENT_DISCOVERY ?? path.join(dataDir(), "agent-api.json")); }
async function resolveBase(options) {
  if (options.url) return String(options.url);
  if (process.env.ACMS_AGENT_URL) return process.env.ACMS_AGENT_URL;
  const parsed = JSON.parse(await readFile(discoveryPath(options), "utf8"));
  if (!parsed.baseUrl) throw new Error("Discovery file does not contain baseUrl");
  return parsed.baseUrl;
}
async function resolveToken(options) {
  if (options.token) return String(options.token);
  if (process.env.ACMS_AGENT_TOKEN) return process.env.ACMS_AGENT_TOKEN;
  const file = path.resolve(options["token-file"] ?? process.env.ACMS_AGENT_TOKEN_FILE ?? path.join(path.dirname(discoveryPath(options)), "agent-token"));
  return (await readFile(file, "utf8")).trim();
}
async function call(base, token, method, pathname, options = {}) {
  const url = new URL(String(base).replace(/\/+$/, "") + pathname);
  for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  const headers = { authorization: "Bearer " + token };
  if (options.key) headers["idempotency-key"] = String(options.key);
  let payload;
  if (options.body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(options.body); }
  const response = await fetch(url, { method, headers, body: payload });
  const parsed = await response.json();
  if (parsed.ok !== true) { const error = new Error(parsed.error?.message ?? "Request failed"); error.code = parsed.error?.code ?? "HTTP_" + response.status; throw error; }
  return parsed.value;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = await resolveBase(options);
  const token = await resolveToken(options);
  const summary = { ok: false, steps: [] };
  const discover = await call(base, token, "GET", "/discover");
  summary.apiVersion = discover.apiVersion;
  summary.instanceId = discover.instanceId;
  summary.steps.push("discover");
  const projects = await call(base, token, "GET", "/projects");
  if (!projects.projects.length) throw new Error("The credential has no project in scope");
  const projectId = options.project ? String(options.project) : projects.projects[0].id;
  summary.projectId = projectId;
  summary.steps.push("projects");
  const submitted = await call(base, token, "POST", "/goals", {
    key: options["request-id"] ? String(options["request-id"]) : "flow-" + randomUUID(),
    body: { title: options.title ? String(options.title) : "Example agent goal", description: "Created by the documented agent API example flow", acceptance: "Status, events, pause and resume work", projectId },
  });
  summary.goalId = submitted.goalId; summary.planTaskId = submitted.planTaskId; summary.steps.push("submit");
  let status = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await call(base, token, "GET", "/status", { query: { goalId: summary.goalId } });
    if (status.tasks.length > 0) break;
    await sleep(100);
  }
  summary.taskCount = status.tasks.length; summary.steps.push("status");
  const blockers = await call(base, token, "GET", "/blockers", { query: { goalId: summary.goalId } });
  summary.blockers = blockers.count;
  if (blockers.count > 0) {
    const interaction = blockers.blockers[0];
    await call(base, token, "POST", "/interactions/" + encodeURIComponent(interaction.id) + "/answer", { key: "flow-answer-" + randomUUID(), body: { answer: "continue", expectedRevision: interaction.expectedRevision } });
    summary.answered = interaction.id; summary.steps.push("answer");
  }
  const events = await call(base, token, "GET", "/events", { query: { goalId: summary.goalId, after: 0 } });
  summary.events = events.entries.length;
  summary.cursor = events.nextCursor;
  summary.userAgentEvents = events.entries.filter(entry => entry.actor.kind === "user-agent").length;
  summary.steps.push("events");
  const controllable = status.tasks.find(task => ["ready", "blocked", "paused"].includes(task.status));
  if (controllable) {
    await call(base, token, "POST", "/tasks/" + encodeURIComponent(controllable.id) + "/pause", { key: "flow-pause-" + randomUUID(), body: { reason: "example flow" } });
    summary.paused = true; summary.steps.push("pause");
    await call(base, token, "POST", "/tasks/" + encodeURIComponent(controllable.id) + "/resume", { key: "flow-resume-" + randomUUID(), body: {} });
    summary.resumed = true; summary.steps.push("resume");
    summary.taskId = controllable.id;
  } else { summary.paused = false; summary.resumed = false; }
  const finalStatus = await call(base, token, "GET", "/status", { query: { goalId: summary.goalId } });
  summary.finalCursor = finalStatus.cursor;
  summary.ok = true;
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().then(() => process.exit(0)).catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code ?? "ERROR", message: error.message } }) + "\n");
  process.exit(1);
});
