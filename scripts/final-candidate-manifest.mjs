import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const baseline = "178987ad4337a499f925d4377de44a3b5f11d550";
const manifestPath = "docs/iteration-2-final-files.json";
const sumsPath = "docs/iteration-2-final-SHA256SUMS";
const excludedPrefixes = ["node_modules/", "test-results/", ".acms/"];
const excludedExact = new Set([manifestPath, sumsPath]);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const head = process.env.MEASURED_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const branch = process.env.MEASURED_BRANCH || execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
const rows = execFileSync("git", ["diff", "--name-status", baseline + ".." + head], { encoding: "utf8" }).split(NL).map(line => line.endsWith(CR) ? line.slice(0, -1) : line).filter(Boolean).map(line => line.split(TAB));
const files = [];
for (const row of rows) {
  const status = row[0][0];
  const path = status === "R" ? row[2] : row[1];
  if (status === "D") continue;
  if (excludedExact.has(path) || excludedPrefixes.some(prefix => path.startsWith(prefix))) continue;
  const bytes = execFileSync("git", ["show", head + ":" + path], { maxBuffer: 67108864 });
  files.push({ path, status, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
files.sort((left, right) => left.path.localeCompare(right.path));
const treeInput = files.map(file => file.path + NUL + file.sha256 + NL).join("");
const sourceTreeHash = createHash("sha256").update(treeInput).digest("hex");
const manifest = { format: "acms.iteration-2.final-files.v2", generatedAt: new Date().toISOString(), measuredCommit: head, baseCommit: baseline, branch, hashSource: "git blob bytes at measuredCommit (canonical LF for text, exact bytes for binary)", counts: { total: files.length, added: files.filter(file => file.status === "A").length, modified: files.filter(file => file.status !== "A").length }, sourceTreeHash, excluded: [manifestPath, sumsPath, "node_modules/", "test-results/", ".acms/"], files };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + NL);
writeFileSync(sumsPath, files.map(file => file.sha256 + "  " + file.path).join(NL) + NL);
console.log(JSON.stringify({ measuredCommit: head, total: files.length, added: manifest.counts.added, modified: manifest.counts.modified, sourceTreeHash }, null, 2));
