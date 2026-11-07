import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ONBOARDING_DOC = "docs/external-agent-onboarding.md";
const POWERSHELL_FENCE = "```powershell";

export function extractTokenSetupBlock(document = readFileSync(ONBOARDING_DOC, "utf8")) {
  const section = document.indexOf("## 3.");
  if (section < 0) throw new Error("onboarding guide has no section 3");
  const open = document.indexOf(POWERSHELL_FENCE, section);
  const close = document.indexOf("```", open + POWERSHELL_FENCE.length);
  if (open < 0 || close < 0) throw new Error("onboarding guide section 3 has no PowerShell block");
  const block = document.slice(open + POWERSHELL_FENCE.length, close).trim();
  if (!block.includes("agent-token")) throw new Error("documented block does not write the agent token file");
  return block + "\n";
}

export function runTokenSetup({ block = extractTokenSetupBlock(), dataDir, token, home, timeout = 120000 } = {}) {
  const env = childEnvironment({ ACMS_AGENT_TOKEN: String(token) });
  delete env.ACMS_DATA_DIR;
  delete env.ACMS_AGENT_TOKEN_FILE;
  delete env.ACMS_AGENT_DISCOVERY;
  if (dataDir) env.ACMS_DATA_DIR = path.resolve(dataDir);
  if (home) env.USERPROFILE = path.resolve(home);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", block], { encoding: "utf8", timeout, env, windowsHide: true });
  return { status: result.status, signal: result.signal, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

export function readTokenAcl(tokenFile) {
  const script = [
    "$acl = Get-Acl -LiteralPath $env:ACMS_ACL_FILE",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() } })",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentUser = $me; rules = $rules } | ConvertTo-Json -Depth 6 -Compress"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", env: childEnvironment({ ACMS_ACL_FILE: path.resolve(tokenFile) }), windowsHide: true });
  if (result.status !== 0) throw new Error("Get-Acl failed: " + (result.stderr || result.stdout || "").trim());
  return JSON.parse(result.stdout);
}


export function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  return env;
}