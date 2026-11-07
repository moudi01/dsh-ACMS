import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const outDir = path.join(root, "docs", "iteration-2-autonomy-sources");
const read = file => { try { return readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const normalize = value => value.replace(/\r\n/g, "\n");
const digest = value => createHash("sha256").update(value).digest("hex");
const beforeClient = read("lib/client.js");
const runs = [
  { file: "static-check.log", command: "node scripts/check.mjs" },
  { file: "full-test.log", command: "npm test" },
  { file: "autonomy-test.log", command: "node --test --test-concurrency=1 test/autonomy.test.js" },
  { file: "targeted-test.log", command: "node --test --test-concurrency=1 test/recovery-boundaries.test.js test/domain.test.js test/task-management.test.js test/engine.test.js test/action-batch.test.js" },
  { file: "build.log", command: "npm run build" },
  { file: "structure.log", command: "npm run test:structure" },
  { file: "external-onboarding.log", command: "node scripts/external-onboarding-ui-test.mjs" }
];
const results = [];
for (const run of runs) {
  let stdout = ""; let stderr = ""; let exitCode = 0;
  try { stdout = execSync(run.command, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { exitCode = error.status ?? 1; stdout = error.stdout?.toString?.() ?? ""; stderr = error.stderr?.toString?.() ?? ""; }
  writeFileSync(path.join(outDir, run.file), "$ " + run.command + "\n\n" + stdout + stderr + "\n");
  const tests = /tests (\d+)/.exec(stdout); const pass = /pass (\d+)/.exec(stdout); const fail = /fail (\d+)/.exec(stdout);
  results.push({ file: run.file, command: run.command, exitCode, tests: tests ? Number(tests[1]) : null, pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null });
  console.log(run.file, exitCode, tests ? tests[1] : "");
}
const afterClient = read("lib/client.js");
const headClient = execSync("git show HEAD:lib/client.js", { encoding: "utf8" });
const clientMatchesHead = digest(normalize(headClient)) === digest(normalize(afterClient));
if (!clientMatchesHead) { console.log("lib/client.js differs from HEAD (UI change); keeping the built bundle"); }
else { execSync("git checkout -- lib/client.js", { stdio: "ignore" }); console.log("restored line endings in lib/client.js"); }
const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const validation = {
  format: "acms.iteration-2.autonomy.validation.v1",
  generatedAt: new Date().toISOString(),
  head, node: process.version, platform: process.platform + " " + process.arch,
  commands: results,
  buildRestored: clientMatchesHead,
  manualEvidence: [
    { file: "coordination-regressions-red.log", note: "Five new boundary tests executed after temporarily restoring the three source files from ae05874; expected 0 pass / 5 fail." },
    { file: "coordination-regressions-green.log", note: "The same five boundary tests executed against the fixed working tree; 5 pass / 0 fail." },
    { file: "manager-authority-red.log", note: "This round three manager-authority cases executed after temporarily restoring src/core/coordination.js, src/core/domain.js and src/core/plan-ledger.js from ae2672b; expected 0 pass / 3 fail." },
    { file: "manager-authority-green.log", note: "The same three manager-authority cases executed against the fixed working tree; 3 pass / 0 fail." },
    { file: "coordination-third-round-red.log", note: "This round three defects executed after restoring the four source files from HEAD; expected 0 pass / 3 fail." },
    { file: "coordination-third-round-green.log", note: "The same three cases executed against the fixed working tree; 3 pass / 0 fail." }
  ],
  modelEvidence: "SimulatedAdapter only; no real model invocation",
  notes: [
    "full-test.log is produced by npm test with node --test-concurrency=1 from package.json.",
    "build.log is produced by npm run build; lib/client.js line-ending-only change is restored only when normalized content is identical.",
    "No database, credential, deployment or PR action is performed by this script.",
    "The red/green boundary logs are generated manually from the fixed test file; each red log temporarily restores the three source files from the named base commit (ae05874 for the earlier five cases, ae2672b for this round three cases) and then restores the fixed versions.",
    "Boundary evidence was regenerated after the four independent-review defects were fixed and again after this round two P1 defects were fixed."
  ]
};
writeFileSync(path.join(outDir, "validation.json"), JSON.stringify(validation, null, 2) + "\n");
console.log("validation written");
