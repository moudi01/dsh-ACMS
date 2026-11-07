import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readZip, writeZip } from "./zip-util.mjs";
const root = process.cwd();
const baseline = "178987ad4337a499f925d4377de44a3b5f11d550";
const evidenceDir = "docs/iteration-2-autonomy-sources";
const zipPath = path.join("test-results", "iteration-2-cumulative-final.zip");
const reportPath = path.join(evidenceDir, "cumulative-archive-verification.json");
const excludes = new Set([path.posix.join(evidenceDir, "files.json"), path.posix.join(evidenceDir, "SHA256SUMS"), path.posix.join(evidenceDir, "cumulative-archive-verification.json"), path.posix.join(evidenceDir, "archive-build.log"), path.posix.join(evidenceDir, "archive-verify.log")]);
const list = command => execFileSync("git", command, { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const changed = list(["diff", "--name-only", baseline, "--"]);
const untracked = list(["ls-files", "--others", "--exclude-standard"]);
const evidence = readdirSync(evidenceDir).filter(name => statSync(path.join(evidenceDir, name)).isFile()).map(name => path.posix.join(evidenceDir, name));
const files = [...new Set([...changed, ...untracked, ...evidence])].filter(file => !excludes.has(file) && existsSync(file) && statSync(file).isFile() && !file.startsWith("test-results/") && !file.startsWith("node_modules/") && !file.startsWith(".acms/") && !file.endsWith(".zip")).sort();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const stage = mkdtempSync(path.join(os.tmpdir(), "acms-archive-"));
const sha256 = data => createHash("sha256").update(data).digest("hex");
const entries = [];
for (const file of files) { const data = readFileSync(file); const target = path.join(stage, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, data); entries.push({ path: file, bytes: data.length, sha256: sha256(data) }); }
const manifest = { format: "acms.iteration-2.cumulative.files.v1", baseline, headAtHashing: head, generatedAt: new Date().toISOString(), manifestExcludes: [...excludes], files: entries };
const filesJson = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
const sums = Buffer.from(entries.map(entry => entry.sha256 + "  " + entry.path).join("\n") + "\n", "utf8");
writeFileSync(path.join(stage, evidenceDir, "files.json"), filesJson);
writeFileSync(path.join(stage, evidenceDir, "SHA256SUMS"), sums);
writeFileSync(path.join(evidenceDir, "files.json"), filesJson);
writeFileSync(path.join(evidenceDir, "SHA256SUMS"), sums);
const zipEntries = [...entries.map(entry => ({ name: entry.path, data: readFileSync(path.join(stage, entry.path)) })), { name: path.posix.join(evidenceDir, "files.json"), data: filesJson }, { name: path.posix.join(evidenceDir, "SHA256SUMS"), data: sums }];
const archive = writeZip(zipEntries.sort((left, right) => left.name.localeCompare(right.name)));
mkdirSync(path.dirname(zipPath), { recursive: true });
writeFileSync(zipPath, archive);
const parsed = readZip(readFileSync(zipPath));
const embeddedFiles = parsed.get(path.posix.join(evidenceDir, "files.json"));
const embeddedSums = parsed.get(path.posix.join(evidenceDir, "SHA256SUMS"));
if (!embeddedFiles || !embeddedSums) throw new Error("archive is missing its own manifest files");
const readManifest = JSON.parse(embeddedFiles.toString("utf8"));
const mismatched = [];
for (const entry of readManifest.files) { const data = parsed.get(entry.path); if (!data) { mismatched.push({ path: entry.path, reason: "missing" }); continue; } if (data.length !== entry.bytes) { mismatched.push({ path: entry.path, reason: "size", expected: entry.bytes, actual: data.length }); continue; } if (sha256(data) !== entry.sha256) { mismatched.push({ path: entry.path, reason: "sha256", expected: entry.sha256, actual: sha256(data) }); } }
const checksumLines = embeddedSums.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map(line => { const match = /^([0-9a-f]{64})  (.+)$/.exec(line); if (!match) return { path: line, reason: "format" }; const data = parsed.get(match[2]); return { path: match[2], hash: match[1], ok: !!data && sha256(data) === match[1] }; });
const expected = new Set([...readManifest.files.map(entry => entry.path), path.posix.join(evidenceDir, "files.json"), path.posix.join(evidenceDir, "SHA256SUMS")]);
const extra = [...parsed.keys()].filter(name => !expected.has(name));
const missing = [...readManifest.files.map(entry => entry.path)].filter(name => !parsed.has(name));
const checksumFailed = checksumLines.filter(line => !line.ok);
const passed = mismatched.length === 0 && checksumFailed.length === 0 && extra.length === 0 && missing.length === 0 && checksumLines.length === readManifest.files.length;
const report = {
  format: "acms.iteration-2.cumulative-archive.verification.v1",
  generatedAt: new Date().toISOString(), baseline, headAtBuild: head,
  archive: { path: zipPath.split(path.sep).join("/"), bytes: archive.length, sha256: sha256(archive) },
  embeddedManifest: { path: path.posix.join(evidenceDir, "files.json"), bytes: embeddedFiles.length, sha256: sha256(embeddedFiles), files: readManifest.files.length },
  embeddedChecksums: { path: path.posix.join(evidenceDir, "SHA256SUMS"), bytes: embeddedSums.length, sha256: sha256(embeddedSums), lines: checksumLines.length },
  verification: { checked: readManifest.files.length, matched: readManifest.files.length - mismatched.length, mismatched, checksumLines: checksumLines.length, checksumMatched: checksumLines.length - checksumFailed.length, checksumFailed, extraEntries: extra, missingEntries: missing, passed },
  notes: [
    "files.json and SHA256SUMS are generated from the staged bytes and then stored in the same archive; the reader inflates every entry and recomputes SHA-256 from the bytes inside the ZIP.",
    "The manifest intentionally excludes files.json and SHA256SUMS themselves because a file cannot contain its own hash.",
    "This script does not touch ACMS data, credentials or the source project outside the workspace."
  ]
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
rmSync(stage, { recursive: true, force: true });
console.log(JSON.stringify({ passed, files: readManifest.files.length, archive: report.archive, verification: report.verification }, null, 2));
if (!passed) process.exit(1);
