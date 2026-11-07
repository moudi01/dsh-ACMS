import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTokenSetupBlock, readTokenAcl, runTokenSetup } from "../scripts/onboarding-doc.mjs";

async function removeFixture(home) {
  const tokenFile = path.join(home, ".dsh", "acms", "agent-token");
  if (existsSync(tokenFile)) spawnSync("icacls", [tokenFile, "/reset"], { encoding: "utf8", windowsHide: true });
  await rm(home, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
}
const DELIVERY_DOCS = ["docs/external-agent-onboarding.md", "docs/agent-api.md", "docs/iteration-2-autonomy.md"];

test("iteration-2 delivery docs contain no Unicode replacement characters", async () => {
  for (const file of DELIVERY_DOCS) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("\uFFFD"), false, file + " contains U+FFFD replacement characters");
  }
});

test("published token setup still guards the ACL step", () => {
  const block = extractTokenSetupBlock();
  assert.ok(block.includes("icacls $tokenFile /inheritance:r /grant:r \"*${me}:(R,W)\""), "the documented icacls grant must use the current SID");
  assert.ok(block.includes("if ($LASTEXITCODE -ne 0)"), "the documented block must fail on an icacls error");
  assert.ok(block.includes("AreAccessRulesProtected"), "the documented block must verify the protected DACL");
  assert.equal(block.includes("\"$env:USERNAME:(R,W)\""), false, "the broken USERNAME expansion must not return");
});

test("the published token setup writes the token and restricts the file ACL", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "acms-onboarding-doc-"));
  const token = "acms_ag_" + "z".repeat(48);
  try {
    const run = runTokenSetup({ home, token });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const tokenFile = path.join(home, ".dsh", "acms", "agent-token");
    const bytes = await readFile(tokenFile);
    assert.deepEqual(bytes, Buffer.from(token, "utf8"));
    const acl = readTokenAcl(tokenFile);
    const rules = [].concat(acl.rules || []);
    assert.equal(acl.protected, true);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].sid, acl.currentUser);
    assert.equal(rules[0].inherited, false);
    assert.match(rules[0].rights, /Read/);
    assert.match(rules[0].rights, /Write|Modify/);
  } finally {
    await removeFixture(home);
  }
});


test("the ACL helper tolerates a foreign PSModulePath inherited from the host", async () => {
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = path.join(os.tmpdir(), "acms-foreign-powershell-modules");
  const home = await mkdtemp(path.join(os.tmpdir(), "acms-onboarding-modulepath-"));
  try {
    const token = "acms_ag_" + "y".repeat(48);
    const run = runTokenSetup({ home, token });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const acl = readTokenAcl(path.join(home, ".dsh", "acms", "agent-token"));
    assert.equal(acl.protected, true);
    assert.equal([].concat(acl.rules || []).length, 1);
  } finally {
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
    await removeFixture(home);
  }
});

test("the onboarding guide, API contract, and issue form describe the same goal scope", async () => {
  const guide = await readFile("docs/external-agent-onboarding.md", "utf8");
  const api = await readFile("docs/agent-api.md", "utf8");
  const access = await readFile("src/client/access.jsx", "utf8");
  assert.match(guide, /指定后[^。]*以及[^。]*自己提交的目标/);
  assert.equal(guide.includes("指定后只能访问该目标"), false);
  assert.match(access, /指定后[^"<]*以及[^"<]*本凭据提交的目标/);
  assert.equal(access.includes("指定后仅限该目标"), false);
  assert.match(api, /目标由该凭据提交/);
});

import { mkdir, writeFile } from "node:fs/promises";

test("the published token setup removes explicit foreign ACEs on an existing token file", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "acms-onboarding-foreign-"));
  const tokenFile = path.join(home, ".dsh", "acms", "agent-token");
  try {
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "stale", "utf8");
    const grant = spawnSync("icacls", [tokenFile, "/grant", "*S-1-1-0:(R)"], { encoding: "utf8", windowsHide: true });
    assert.equal(grant.status, 0, grant.stderr || grant.stdout);
    const before = readTokenAcl(tokenFile);
    const beforeRules = [].concat(before.rules || []);
    assert.ok(beforeRules.some((rule) => rule.sid !== before.currentUser), "fixture must contain an explicit foreign ACE");
    const token = "acms_ag_" + "x".repeat(48);
    const run = runTokenSetup({ home, token });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const after = readTokenAcl(tokenFile);
    const afterRules = [].concat(after.rules || []);
    assert.equal(after.protected, true);
    assert.equal(afterRules.length, 1);
    assert.equal(afterRules[0].sid, after.currentUser);
    assert.equal(afterRules[0].inherited, false);
  } finally {
    await removeFixture(home);
  }
});
