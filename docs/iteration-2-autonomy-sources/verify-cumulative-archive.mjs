import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readZip } from "./zip-util.mjs";
const evidenceDir = "docs/iteration-2-autonomy-sources";
const zipPath = process.argv[2] ?? path.join("test-results", "iteration-2-cumulative-final.zip");
const sha256 = data => createHash("sha256").update(data).digest("hex");
const archive = readFileSync(zipPath);
const zip = readZip(archive);
const manifestBytes = zip.get(path.posix.join(evidenceDir, "files.json"));
const sumsBytes = zip.get(path.posix.join(evidenceDir, "SHA256SUMS"));
if (!manifestBytes || !sumsBytes) throw new Error("archive lacks files.json or SHA256SUMS");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const mismatched = [];
for (const entry of manifest.files) { const data = zip.get(entry.path); if (!data) { mismatched.push({ path: entry.path, reason: "missing" }); continue; } if (data.length !== entry.bytes) mismatched.push({ path: entry.path, reason: "size", expected: entry.bytes, actual: data.length }); else if (sha256(data) !== entry.sha256) mismatched.push({ path: entry.path, reason: "sha256", expected: entry.sha256, actual: sha256(data) }); }
const lines = sumsBytes.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
const checksumFailed = [];
for (const line of lines) { const match = /^([0-9a-f]{64})  (.+)$/.exec(line); const data = match ? zip.get(match[2]) : null; if (!match || !data || sha256(data) !== match[1]) checksumFailed.push(line); }
const expected = new Set([...manifest.files.map(entry => entry.path), path.posix.join(evidenceDir, "files.json"), path.posix.join(evidenceDir, "SHA256SUMS")]);
const extra = [...zip.keys()].filter(name => !expected.has(name));
const missing = manifest.files.map(entry => entry.path).filter(name => !zip.has(name));
const passed = mismatched.length === 0 && checksumFailed.length === 0 && extra.length === 0 && missing.length === 0 && lines.length === manifest.files.length;
console.log(JSON.stringify({ passed, archive: { path: zipPath.split(path.sep).join("/"), bytes: archive.length, sha256: sha256(archive) }, files: manifest.files.length, matched: manifest.files.length - mismatched.length, checksumLines: lines.length, checksumFailed, mismatched, extra, missing }, null, 2));
if (!passed) process.exit(1);
