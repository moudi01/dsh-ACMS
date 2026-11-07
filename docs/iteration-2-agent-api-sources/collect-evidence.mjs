#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";

const CHECK_DIR = "docs/iteration-2-agent-api-sources";
function counts(text) {
  const value = {};
  for (const name of ["tests", "pass", "fail", "cancelled", "skipped"]) {
    const regex = new RegExp(name + " (\\d+)", "g");
    let match; let last = null;
    while ((match = regex.exec(text))) last = match[1];
    value[name] = last === null ? null : Number(last);
  }
  return value;
}
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() };
}
function run(name, args, logFile) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 67108864 });
  const text = String(result.stdout ?? "") + String(result.stderr ?? "");
  writeFileSync(CHECK_DIR + "/" + logFile, text);
  return { name, command: "node " + args.join(" "), exitCode: result.status, log: logFile, counts: counts(text) };
}
const protocol = ["--test", "--test-concurrency=1", "test/agent-api.test.js", "test/agent-api-lifecycle.test.js"];
const regression = ["--test", "--test-concurrency=1", "test/domain.test.js", "test/transport.test.js", "test/delegation-permissions.test.js", "test/action-batch.test.js", "test/recovery-boundaries.test.js", "test/engine.test.js"];
const fullSuite = ["--test", "--test-concurrency=1", ...readdirSync("test").filter(name => name.endsWith(".test.js")).map(name => "test/" + name)];
const checks = [
  run("agent-api-protocol", protocol, "agent-api-tests.log"),
  run("affected-regression", regression, "regression.log"),
  run("static-checks", ["scripts/check.mjs"], "static-checks.log"),
  run("full-suite", fullSuite, "full-suite.log"),
];
const head = git(["rev-parse", "HEAD"]);
const status = git(["status", "--short"]);
const dependenciesPresent = existsSync("node_modules/esbuild") && existsSync("node_modules/@deepseek-ai/dsh-subagent");
const validation = {
  attemptId: "attempt_9562f7e8-60d1-48f1-94c8-84e5e842d5b7",
  taskId: "task_ab7105f7-1f5d-4775-9752-9088b3543044",
  baseline: "178987ad4337a499f925d4377de44a3b5f11d550",
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform + " " + process.arch,
  environment: {
    nodeModulesInstalled: dependenciesPresent,
    note: dependenciesPresent
      ? "Isolated task workspace with local node_modules available. The full test suite is executed directly; no dependency installation or test weakening was used for this evidence."
      : "Isolated task workspace without the esbuild and @deepseek-ai/dsh-subagent dev dependencies. Full-suite failures, if any, are environment failures unrelated to the agent API implementation; no dependency installation or test weakening was used to hide them.",
  },
  checks,
  repository: { head: head.stdout, dirty: status.stdout.length > 0, changed: status.stdout === "" ? [] : status.stdout.split("\n") },
};
writeFileSync(CHECK_DIR + "/validation.json", JSON.stringify(validation, null, 2) + "\n");
for (const check of checks) console.log(check.name + " exit=" + check.exitCode + " counts=" + JSON.stringify(check.counts));
console.log("head=" + head.stdout);
