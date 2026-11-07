#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";

const files = [
  "src/core/store.js",
  "src/core/util.js",
  "src/core/agent-identity.js",
  "src/core/external-access.js",
  "src/core/domain.js",
  "src/host/agent-api.js",
  "src/host/index.js",
  "src/host/http.js",
  "src/runtime/engine.js",
  "scripts/acms-agent.mjs",
  "examples/agent-api/flow.mjs",
  "test/agent-api.test.js",
  "test/agent-api-lifecycle.test.js",
  "docs/agent-api.md",
  "docs/iteration-2-agent-api-sources/hash-manifest.mjs",
  "docs/iteration-2-agent-api-sources/collect-evidence.mjs",
  "docs/iteration-2-agent-api-sources/write-delivery.mjs",
  "package.json",
];

const entries = files.map(file => {
  const bytes = readFileSync(file);
  return { path: file, originalPath: file, bytes: statSync(file).size, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync("docs/iteration-2-agent-api-sources/files.json", JSON.stringify({ generatedAt: new Date().toISOString(), files: entries }, null, 2) + "\n");
writeFileSync("docs/iteration-2-agent-api-sources/SHA256SUMS", entries.map(entry => entry.sha256 + "  " + entry.originalPath).join("\n") + "\n");
for (const entry of entries) process.stdout.write(entry.sha256 + "  " + entry.originalPath + "  (" + entry.bytes + " bytes)\n");
