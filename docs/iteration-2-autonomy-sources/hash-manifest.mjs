import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const baseline = "178987ad4337a499f925d4377de44a3b5f11d550";
const evidenceDir = "docs/iteration-2-autonomy-sources";
const changed = execSync("git diff --name-only " + baseline + "..HEAD", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const evidence = readdirSync(evidenceDir).map(name => path.posix.join(evidenceDir, name));
const excluded = new Set([path.posix.join(evidenceDir, "SHA256SUMS"), path.posix.join(evidenceDir, "files.json")]);
const files = [...new Set([...changed, ...evidence])].filter(file => !excluded.has(file) && existsSync(file) && !statSync(file).isDirectory()).sort();
const entries = files.map(file => {
  const bytes = readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const manifest = { format: "acms.iteration-2.autonomy.files.v1", baseline, headAtHashing: head, generatedAt: new Date().toISOString(), files: entries };
writeFileSync(path.join(evidenceDir, "files.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(path.join(evidenceDir, "SHA256SUMS"), entries.map(entry => entry.sha256 + "  " + entry.path).join("\n") + "\n");
console.log("files", entries.length, "head", head);
