import { chromium, expect } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { startPreview } from "./preview-server.mjs";
import { OWNER } from "../src/core/util.js";
import { extractTokenSetupBlock, readTokenAcl, runTokenSetup } from "./onboarding-doc.mjs";
const CLI = "scripts/acms-agent.mjs";
const screenshot = "test-results/ui/external-access-issued.png";
const receiptFile = "docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json";
const server = await startPreview({ agentApi: true });
const owner = (name, args = {}) => server.company.command(OWNER, randomUUID(), name, args);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, colorScheme: "light" });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const snapshot = server.company.snapshot();
const project = snapshot.projects[0]; const goal = snapshot.goals[0];
const otherProjectGoal = owner("goal.create", { title: "外部接入越权对照目标", description: "用于验证凭据不能读取范围外目标。", acceptance: "仅作负向测试。", projectId: project.id, plan: false });
owner("company.pause", {});
const pauseTask = owner("task.create", { goalId: goal.id, title: "外部接入暂停验证任务", description: "由本测试创建，用于验证凭据的暂停与恢复命令。", acceptance: "暂停后可恢复。" });
let localProbeCalls = 0; const originalProbe = server.adapter.probeModel; server.adapter.probeModel = async input => { localProbeCalls += 1; return originalProbe(input); };
await mkdir("test-results/ui", { recursive: true });
let browserClosedAt = null;
try {
  await page.goto(server.url);
  await page.getByRole("button", { name: "外部接入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "外部接入", exact: true })).toBeVisible();
  await page.getByLabel("凭据名称").fill("外部接入验收代理");
  await page.getByLabel("项目范围").selectOption(project.id);
  await page.getByLabel("目标范围（可选）").selectOption(goal.id);
  const goalScopeHintId = await page.getByLabel("目标范围（可选）").getAttribute("aria-describedby");
  const goalScopeHint = goalScopeHintId ? ((await page.locator("#" + goalScopeHintId).textContent()) ?? "").trim() : "";
  await page.getByRole("checkbox", { name: /暂停任务/ }).check();
  await page.getByRole("checkbox", { name: /恢复任务/ }).check();
  await page.getByRole("button", { name: "签发凭据" }).click();
  await expect(page.getByTestId("credential-issued")).toBeVisible();
  const token = (await page.getByTestId("credential-token").textContent()).trim();
  const goalScopeIssued = ((await page.getByTestId("credential-issued").locator("dl dd").nth(2).textContent()) ?? "").trim();
  if (!/^acms_ag_.{40,}$/.test(token)) throw new Error("issued token has an unexpected shape");
  const afterIssue = server.company.snapshot();
  const credential = afterIssue.agentCredentials.find(item => item.status === "active" && item.name === "外部接入验收代理");
  if (!credential) throw new Error("credential was not visible in the redacted snapshot");
  if (JSON.stringify(afterIssue.agentCredentials).includes(token)) throw new Error("plaintext token leaked into snapshot");
  await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close(); browserClosedAt = new Date().toISOString();
  const tokenFile = path.join(server.dataDir, "agent-token");
  const tokenSetup = runTokenSetup({ block: extractTokenSetupBlock(), dataDir: server.dataDir, token });
  if (tokenSetup.status !== 0) throw new Error("the documented token setup failed: " + (tokenSetup.stderr || tokenSetup.stdout));
  const tokenBytes = await readFile(tokenFile);
  const tokenAcl = readTokenAcl(tokenFile);
  const tokenAclRules = [].concat(tokenAcl.rules || []);
  const cliArgs = ["--discovery", server.discoveryFile];
  const runCli = async args => {
    const env = { ...process.env };
    delete env.ACMS_AGENT_TOKEN; delete env.ACMS_AGENT_TOKEN_FILE; delete env.ACMS_AGENT_DISCOVERY; delete env.ACMS_DATA_DIR;
    try { const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env }); return { exitCode: 0, stdout: stdout.trim() }; }
    catch (error) { return { exitCode: error.status ?? 1, stdout: (error.stdout ?? "").toString().trim(), stderr: (error.stderr ?? "").toString().trim() }; }
  };
  const invoke = async (command, extra = []) => { const result = await runCli([command, ...extra, "--json", ...cliArgs]); const parsed = result.exitCode === 0 ? JSON.parse(result.stdout) : null; return { ...result, parsed }; };
  const evidence = [];
  const record = async (name, pending) => { const result = await pending; evidence.push({ name, exitCode: result.exitCode, command: "acms-agent " + name, ...(result.parsed ? { ok: result.parsed.ok, value: result.parsed.value } : { stderr: result.stderr }) }); return result; };
  const beforeRead = server.company.snapshot();
  const discover = await record("discover", invoke("discover"));
  const projects = await record("projects", invoke("projects"));
  const status = await record("status", invoke("status", ["--goal", goal.id]));
  const tasks = await record("tasks", invoke("tasks", ["--goal", goal.id]));
  const reviews = await record("reviews", invoke("reviews", ["--goal", goal.id]));
  const blockers = await record("blockers", invoke("blockers", ["--goal", goal.id]));
  const events = await record("events", invoke("events", ["--goal", goal.id, "--after", "0", "--limit", "50"]));
  const afterRead = server.company.snapshot();
  const firstSubmit = await record("submit", invoke("submit", ["--project", project.id, "--title", "外部代理提交的目标", "--description", "由公开文档中的 CLI 在关闭工作台后提交。", "--acceptance", "目标与规划任务可查询。", "--request-id", "onboarding-submit-1", "--json"]));
  const submittedGoalId = firstSubmit.parsed?.value?.goalId;
  const replay = await record("submit-replay", invoke("submit", ["--project", project.id, "--title", "外部代理提交的目标", "--description", "由公开文档中的 CLI 在关闭工作台后提交。", "--acceptance", "目标与规划任务可查询。", "--request-id", "onboarding-submit-1", "--json"]));
  const paused = await record("pause", invoke("pause", ["--task", pauseTask.id, "--reason", "外部接入暂停验证"]));
  const pausedList = await record("tasks-paused", invoke("tasks", ["--goal", goal.id, "--status", "paused"]));
  const resumed = await record("resume", invoke("resume", ["--task", pauseTask.id]));
  const http = async (pathname, init = {}) => { const response = await fetch(server.agent.baseUrl + pathname, init); let body = null; try { body = await response.json(); } catch { } return { status: response.status, code: body?.error?.code ?? null, body }; };
  const noToken = await http("/discover");
  const crossGoal = await http("/status?goalId=" + encodeURIComponent(otherProjectGoal.id), { headers: { authorization: "Bearer " + token } });
  const forgedOwner = await http("/goals", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "Idempotency-Key": "onboarding-forged-owner" }, body: JSON.stringify({ title: "伪造 owner 不应成功", description: "negative", acceptance: "negative", projectId: project.id, actor: "owner" }) });
  const currentCredential = server.company.store.require("agentCredentials", credential.id);
  owner("agentCredential.revoke", { credentialId: currentCredential.id, expectedRevision: currentCredential.revision });
  const revoked = await http("/status?goalId=" + encodeURIComponent(goal.id), { headers: { authorization: "Bearer " + token } });
  const storedCredentials = JSON.stringify(server.company.store.list("agentCredentials"));
  const checks = {
    tokenShape: /^acms_ag_.{40,}$/.test(token),
    tokenReturnedOnceAndRedacted: !JSON.stringify(afterIssue.agentCredentials).includes(token) && storedCredentials.includes("tokenHash") && !storedCredentials.includes(token),
    tokenSetupExitZero: tokenSetup.status === 0,
    tokenFileMatchesIssued: tokenBytes.equals(Buffer.from(token, "utf8")),
    tokenAclProtected: tokenAcl.protected === true,
    tokenAclOwnerOnly: tokenAclRules.length === 1 && tokenAclRules[0].sid === tokenAcl.currentUser,
    tokenAclNoInherited: tokenAclRules.every(rule => rule.inherited === false),
    tokenAclReadWrite: /Read/.test(tokenAclRules[0]?.rights || "") && /Write|Modify/.test(tokenAclRules[0]?.rights || ""),
    discover: discover.parsed?.value?.contractVersion === 1,
    projectsRead: projects.parsed?.ok === true,
    statusRead: status.parsed?.ok === true,
    tasksRead: tasks.parsed?.ok === true,
    reviewsRead: reviews.parsed?.ok === true,
    blockersRead: blockers.parsed?.ok === true,
    eventsRead: events.parsed?.ok === true,
    readOnlyDidNotCreateTasks: afterRead.tasks.length === beforeRead.tasks.length,
    noModelCheck: localProbeCalls === 0,
    submit: typeof submittedGoalId === "string" && submittedGoalId.startsWith("goal_"),
    submitReplay: replay.parsed?.replayed === true && replay.parsed?.value?.goalId === submittedGoalId,
    pause: paused.parsed?.ok === true && (pausedList.parsed?.value?.tasks ?? []).some(task => task.id === pauseTask.id && task.status === "paused"),
    resume: resumed.parsed?.ok === true,
    noTokenDenied: noToken.status === 401,
    crossGoalDenied: crossGoal.status === 403 && crossGoal.code === "SCOPE_DENIED",
    forgedOwnerDenied: forgedOwner.status === 400 && forgedOwner.code === "INVALID_REQUEST",
    revokedDenied: revoked.status === 401,
    goalScopeHintAccurate: goalScopeHint.includes("本凭据提交的目标") && !goalScopeHint.includes("仅限该目标"),
    goalScopeIssuedShowsUnion: goalScopeIssued.includes("本凭据提交的目标")
  };
  const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  if (failed.length) throw new Error("onboarding assertions failed: " + failed.join(", "));
  const receipt = {
    format: "acms.iteration-2.external-onboarding.receipt.v1",
    generatedAt: new Date().toISOString(),
    mode: "trusted-host preview harness: real client bundle, real host routes, real user-agent API and CLI; simulated engine/provider",
    environment: { node: process.version, platform: process.platform + " " + process.arch },
    candidate: { headAtRun: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTreeAtRun: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length + " changed paths at run time; frozen source/tests/docs hashes are in docs/iteration-2-final-files.json", finalManifest: "docs/iteration-2-final-files.json" },
    workbench: { uiUrl: server.url, browserClosedAt, credentialIssuedBeforeClose: true },
    credential: { id: credential.id, name: credential.name, tokenPrefix: credential.tokenPrefix, scope: credential.scope, tokenReturnedOnce: true },
    goalScope: { hint: goalScopeHint, issued: goalScopeIssued },
    tokenSetup: { source: "docs/external-agent-onboarding.md section 3, executed verbatim", exitCode: tokenSetup.status, stdout: tokenSetup.stdout, acl: tokenAcl },
    cli: evidence,
    http: { noToken, crossGoal: { status: crossGoal.status, code: crossGoal.code }, forgedOwner: { status: forgedOwner.status, code: forgedOwner.code }, revoked: { status: revoked.status, code: revoked.code } },
    checks,
    realModelCalls: 0,
    modelCheckRequests: localProbeCalls,
    screenshot,
    limitations: [
      "This receipt is not production deployment evidence. It uses the isolated preview harness and a simulated provider.",
      "The browser page was closed before the CLI calls; the host preview process (the analogue of the DSH plugin process) stayed alive so the loopback agent API remained reachable.",
      "The token file ACL assertions execute the published PowerShell block and read the DACL back; they do not run against the production host.",
      "The final release acceptance still needs the same steps executed against the upgraded real ACMS host with a real owner and the real provider policy."
    ]
  };
  await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
  await writeFile("test-results/ui/external-onboarding-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, checks, screenshot, receipt: receiptFile, credential: credential.tokenPrefix }, null, 2));
} finally {
  await browser.close().catch(() => { });
  await server.close().catch(() => { });
  await rm(server.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => { });
}
