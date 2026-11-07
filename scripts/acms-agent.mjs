#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const USAGE = [
  "Usage: node scripts/acms-agent.mjs <command> [options]",
  "",
  "Commands:",
  "  discover                                  Read the versioned discovery document",
  "  status --goal <goalId>                    Goal, tasks, attempts, artifacts and blockers",
  "  goals                                     Goals inside the credential scope",
  "  projects                                  Projects inside the credential scope",
  "  tasks --goal <goalId> [--status <status>]  Tasks of one goal",
  "  reviews --goal <goalId>                   Review tasks and verifications",
  "  blockers --goal <goalId>                  Pending interactions",
  "  events --goal <goalId> [--after <seq>] [--limit <n>] [--wait <ms>]",
  "  submit --project <id> --title <s> --description <s> --acceptance <s> [--constraint key=text]",
  "  answer --interaction <id> --answer <s> [--expected-revision <n>]",
  "  pause --task <id> [--reason <s>]",
  "  resume --task <id> [--reason <s>]",
  "",
  "Options:",
  "  --url <baseUrl>        Direct base URL (overrides ACMS_AGENT_URL and the discovery file)",
  "  --discovery <file>     Discovery file path (default: <dataDir>/agent-api.json)",
  "  --token <token>        Bearer credential (prefer ACMS_AGENT_TOKEN or a token file)",
  "  --token-file <file>    Token file (default: <discovery dir>/agent-token)",
  "  --request-id <key>     Stable idempotency key for a write",
  "  --json                 Print the full response envelope",
].join("\n");

class CliError extends Error { constructor(code, message) { super(message); this.code = code; } }

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { options._.push(item); continue; }
    const key = item.slice(2); const next = argv[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (next !== undefined && !next.startsWith("--")) index += 1;
    if (options[key] === undefined) options[key] = value;
    else options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
  }
  return options;
}
function asArray(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function dataDir() { return path.resolve(process.env.ACMS_DATA_DIR ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "acms")); }
function discoveryPath(options) { return path.resolve(options.discovery ?? process.env.ACMS_AGENT_DISCOVERY ?? path.join(dataDir(), "agent-api.json")); }

async function resolveBase(options) {
  if (options.url) return String(options.url);
  if (process.env.ACMS_AGENT_URL) return process.env.ACMS_AGENT_URL;
  const file = discoveryPath(options);
  let raw;
  try { raw = await readFile(file, "utf8"); } catch { throw new CliError("DISCOVERY_MISSING", "No discovery file at " + file); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new CliError("DISCOVERY_INVALID", "Discovery file is not valid JSON"); }
  if (!parsed.baseUrl) throw new CliError("DISCOVERY_INVALID", "Discovery file does not contain baseUrl");
  return parsed.baseUrl;
}
async function resolveToken(options) {
  if (options.token) return String(options.token);
  if (process.env.ACMS_AGENT_TOKEN) return process.env.ACMS_AGENT_TOKEN;
  const file = path.resolve(options["token-file"] ?? process.env.ACMS_AGENT_TOKEN_FILE ?? path.join(path.dirname(discoveryPath(options)), "agent-token"));
  try { return (await readFile(file, "utf8")).trim(); } catch { throw new CliError("TOKEN_MISSING", "No token file at " + file); }
}

async function request(base, token, method, pathname, options = {}) {
  const url = new URL(String(base).replace(/\/+$/, "") + pathname);
  for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  const headers = { authorization: "Bearer " + token };
  if (options.key) headers["idempotency-key"] = String(options.key);
  let payload;
  if (options.body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(options.body); }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try { response = await fetch(url, { method, headers, body: payload }); }
    catch (error) { lastError = new CliError("CONNECTION", "Cannot reach the ACMS agent host at " + url.origin + " (" + error.message + ")"); await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1))); continue; }
    let parsed;
    try { parsed = await response.json(); } catch { throw new CliError("PROTOCOL", "The host returned a non-JSON response"); }
    const retryable = response.status === 503 ? parsed.error?.retryable !== false : parsed.error?.retryable === true;
    if (retryable && attempt < 2) { lastError = new CliError(parsed.error?.code ?? "UNAVAILABLE", parsed.error?.message ?? "Host is busy"); await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1))); continue; }
    if (parsed.ok !== true) throw new CliError(parsed.error?.code ?? "HTTP_" + response.status, parsed.error?.message ?? "Request failed");
    return parsed;
  }
  throw lastError ?? new CliError("UNAVAILABLE", "The ACMS agent host did not respond");
}
function print(value, asJson) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function requestKey(options) { return options["request-id"] ? String(options["request-id"]) : randomUUID(); }
function goalIdOf(options) { return options.goal ?? options._[1]; }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (!command || options.help) { process.stdout.write(USAGE + "\n"); return; }
  const base = await resolveBase(options);
  const token = await resolveToken(options);
  const execute = async (method, pathname, extra) => {
    const payload = await request(base, token, method, pathname, extra);
    if (options.json) print(payload, true); else print(payload.value, false);
    return payload;
  };
  if (command === "discover") return execute("GET", "/discover");
  if (command === "status") return execute("GET", "/status", { query: { goalId: goalIdOf(options) } });
  if (command === "goals") return execute("GET", "/goals");
  if (command === "projects") return execute("GET", "/projects");
  if (command === "tasks") return execute("GET", "/tasks", { query: { goalId: goalIdOf(options), status: options.status } });
  if (command === "reviews") return execute("GET", "/reviews", { query: { goalId: goalIdOf(options) } });
  if (command === "blockers") return execute("GET", "/blockers", { query: { goalId: goalIdOf(options) } });
  if (command === "events") return execute("GET", "/events", { query: { goalId: goalIdOf(options), after: options.after, limit: options.limit, wait: options.wait } });
  if (command === "submit") {
    const body = { title: options.title, description: options.description, acceptance: options.acceptance, projectId: options.project };
    const constraints = asArray(options.constraint).map(item => {
      const value = String(item); const index = value.indexOf("=");
      if (index < 1) throw new CliError("USAGE", "constraint must use key=text");
      return { key: value.slice(0, index), text: value.slice(index + 1) };
    });
    if (constraints.length) body.constraints = constraints;
    if (options.priority !== undefined) body.priority = Number(options.priority);
    return execute("POST", "/goals", { key: requestKey(options), body });
  }
  if (command === "answer") {
    const body = { answer: options.answer };
    if (options["expected-revision"] !== undefined) body.expectedRevision = Number(options["expected-revision"]);
    return execute("POST", "/interactions/" + encodeURIComponent(String(options.interaction)) + "/answer", { key: requestKey(options), body });
  }
  if (command === "pause" || command === "resume") return execute("POST", "/tasks/" + encodeURIComponent(String(options.task)) + "/" + command, { key: requestKey(options), body: options.reason ? { reason: String(options.reason) } : {} });
  throw new CliError("USAGE", "Unknown command " + command);
}

main().then(() => process.exit(0)).catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code ?? "ERROR", message: error.message } }) + "\n");
  process.exit(1);
});
