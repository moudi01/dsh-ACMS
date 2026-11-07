# 外部智能体首次接入（owner 操作指南）

本文对应 ACMS 外部智能体接口 v1（见 [agent-api.md](agent-api.md)）。目标：普通 owner 按公开步骤签发一个有明确范围的凭据，交给外部用户代理；关闭工作台页面后，代理仍可通过本机回环接口提交目标、查询进展、回复交互、读取增量事件以及暂停/恢复任务。

## 1. 前提

- 已安装并启动包含本候选版本的 ACMS 插件。宿主进程运行期间，`<dataDir>/agent-api.json` 会发布接口地址；默认 `dataDir` 为 `%USERPROFILE%\\.dsh\\acms`，也可由 `ACMS_DATA_DIR` 指定。
- 工作台是否需要打开不影响插件进程；关闭浏览器页面不关闭宿主插件，也不删除发现文件。
- owner 必须通过 ACMS 面板的 owner 会话完成签发。不要直接改数据库、复制模型认证或把 token 写进仓库/日志。

## 2. 在面板签发凭据

1. 打开 ACMS 面板，在左侧导航点击 **外部接入**（`src/client/access.jsx`）。
2. 填写：
   - **凭据名称**：例如“外部用户代理”。
   - **项目范围**：必选，决定凭据只能访问哪个项目。
   - **目标范围（可选）**：留空时，凭据只能访问自己提交的目标；指定后，可访问该目标以及自己提交的目标。
   - **允许命令**：默认 `goal.submit`、`status.read`、`events.read`、`interaction.answer`；需要暂停/恢复时勾选 `task.pause`、`task.resume`；`project.create` 与 `projectCreate` 必须同时选择。
   - **有效期（可选）**：留空为长期有效；过期后所有请求返回 401。
3. 点击 **签发凭据**。页面只显示一次明文令牌（以 `acms_ag_` 开头），刷新或关闭后无法再次读取。立即复制。
4. 列表只显示脱敏前缀、范围、状态和有效期；需要停用时点击 **撤销凭据**。

## 3. 交给外部用户代理

把令牌保存为仅当前 Windows 用户可读的文件（默认路径就是 CLI 的默认 token 文件，不需要额外传参）：

```powershell
$dir = if ($env:ACMS_DATA_DIR) { $env:ACMS_DATA_DIR } else { Join-Path $env:USERPROFILE ".dsh\acms" }
New-Item -ItemType Directory -Force $dir | Out-Null
$token = $env:ACMS_AGENT_TOKEN
if (-not $token) {
  $secure = Read-Host "粘贴 acms_ag_ 令牌" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
$tokenFile = Join-Path $dir "agent-token"
[IO.File]::WriteAllText($tokenFile, $token.Trim(), (New-Object System.Text.UTF8Encoding($false)))
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $tokenFile /inheritance:r /grant:r "*${me}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls 失败：退出码 $LASTEXITCODE" }
$acl = Get-Acl -LiteralPath $tokenFile
if (-not $acl.AreAccessRulesProtected) { throw "token 文件仍继承父目录权限" }
# Some hosts (including GitHub Windows runners) create the file with explicit
# default-DACL ACEs for other identities. /inheritance:r only removes inherited
# ACEs, so rebuild the DACL and keep only the current user before verifying.
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  if ($rule.IsInherited) { continue }
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sid -ne $me) { [void]$acl.RemoveAccessRuleSpecific($rule) }
}
Set-Acl -LiteralPath $tokenFile -AclObject $acl -ErrorAction Stop
$acl = Get-Acl -LiteralPath $tokenFile
if (@($acl.Access).Count -ne 1) { throw "token file must have exactly one ACE" }$other = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $me })
if ($other.Count -gt 0) { throw "token 文件仍允许其他身份访问" }
Remove-Variable -Name token,secure,ptr -ErrorAction SilentlyContinue
"token 已写入 $tokenFile；ACL：仅当前用户可读写"
```

脚本会写入令牌、关闭权限继承、只授予当前 Windows 用户读写，并立即用 `Get-Acl` 复核；任一步失败都会抛出错误并以非零退出码结束，不会静默保留宽松权限。

> 兼容性（Windows PowerShell 5.1）：如果该窗口从 DSH/其他 PowerShell 继承了 PSModulePath，`Get-Acl` 可能无法自动加载 `Microsoft.PowerShell.Security`（报“重复 TypeData”或“无法加载模块”）。请在普通 PowerShell 5.1 窗口执行；或在同一窗口先 `Remove-Item Env:PSModulePath` 后重跑整个代码块。代码块在 icacls 或 ACL 复核失败时抛错，不会静默降级。
>
> 清理测试夹具时，token 文件 DACL 只授予读写且关闭继承；删除前先 `icacls <tokenFile> /reset` 恢复继承，或由测试辅助 `scripts/onboarding-doc.mjs` 的 `childEnvironment` 与测试的 `removeFixture` 处理。测试子进程不继承 PSModulePath，仅影响子进程，不修改宿主环境。

无人值守环境可先设置 `ACMS_AGENT_TOKEN` 再运行同一段脚本（只在该进程环境中出现，不要写入脚本或仓库）。不要把令牌写入仓库、issue、聊天日志或截图。外部代理只需要 token 文件和发现文件，不需要 owner 会话，也不能伪造 owner。

## 4. 关闭工作台后连接和使用

关闭浏览器中的工作台页面（不是停止宿主插件）。确认发现文件存在：

```powershell
Test-Path (Join-Path $env:USERPROFILE ".dsh\\acms\\agent-api.json")
```

在仓库目录执行（所有命令使用默认发现文件和 token 文件）：

```powershell
node scripts/acms-agent.mjs discover
node scripts/acms-agent.mjs projects
node scripts/acms-agent.mjs status --goal goal_...
node scripts/acms-agent.mjs tasks --goal goal_...
node scripts/acms-agent.mjs reviews --goal goal_...
node scripts/acms-agent.mjs blockers --goal goal_...
node scripts/acms-agent.mjs events --goal goal_... --after 0 --wait 5000
node scripts/acms-agent.mjs submit --project project_... --title "外部提交的目标" --description "..." --acceptance "..."
node scripts/acms-agent.mjs pause --task task_... --reason "外部暂停" --request-id pause-2026-11-07
node scripts/acms-agent.mjs resume --task task_... --request-id resume-2026-11-07
```

写命令默认自动生成幂等键；网络重试时通过 `--request-id` 复用同一个键。`status`/`events` 等只读请求不会启动模型；凭据范围外返回 403，缺失/过期/撤销令牌返回 401。

## 5. 撤销与验证

1. 在 **外部接入** 列表点击 **撤销凭据**，或用 owner 命令 `agentCredential.revoke`。
2. 用同一 token 再请求一次，应返回 401。
3. 撤销后不删除历史事件；审计事件仍有 `agentCredential.revoked`。

## 6. 本候选的实际证据与边界

- 受信宿主模拟端到端证据：`docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json`。它使用真实客户端 bundle、真实宿主路由、真实 user-agent API 和 `scripts/acms-agent.mjs`，但使用隔离预览宿主与模拟执行器；不是生产部署或真实模型证据。
- 截图：`test-results/ui/external-access-issued.png`（工作树内的测试产物，不提交源码）。
- 复现脚本：`scripts/external-onboarding-ui-test.mjs`。
- 该证据覆盖：面板签发、明文只显示一次、快照/数据库不出现明文、关闭浏览器后 CLI 连接、只读查询、幂等提交、暂停/恢复、无 token/跨目标/伪造 owner/撤销后拒绝。
- 最终候选复验（本工作副本）：`node scripts/external-onboarding-ui-test.mjs` 27/27 通过；`node --test test/external-onboarding-doc.test.js` 5/5 通过（含子进程 PSModulePath 兼容回归、ACL 夹具清理与目标范围并集文案）。仍为隔离预览宿主加模拟执行器，真实 DSH 宿主与真实模型验收未发生。
- **发布验收仍需在升级后的真实 ACMS 宿主上重做同一流程**，由 owner 签发真实凭据并记录请求、响应、撤销和失败路径；本候选的模拟证据不能替代升级后真实宿主证据，也不能替代独立审查。
- UI 构建权限限制记录在 GitHub #13；本候选不把 #5 的旧宿主模拟 receipt 当作本版本证据。

## 7. 常见错误

| 错误 | 处理 |
| --- | --- |
| `DISCOVERY_MISSING` | 确认宿主插件已启动、`agent-api.json` 存在；不要静默换接口。 |
| `TOKEN_MISSING` | 确认 token 文件路径；或显式传 `--token-file`。 |
| 401 `UNAUTHORIZED` | 令牌缺失、过期或已撤销；重新签发。若同时设置了 `ACMS_AGENT_TOKEN`/`ACMS_AGENT_TOKEN_FILE`，CLI 会优先使用环境变量而不是 token 文件。 |
| 403 `SCOPE_DENIED` | 请求的项目/目标不在凭据范围内。 |
| 403 `FORBIDDEN` | 命令未包含在凭据 `commands` 中。 |
| 409 `IDEMPOTENCY_CONFLICT` | 同一幂等键用于不同参数；复用原参数或换新键。 |
| 503 `ENGINE_BUSY` | SQLite 写锁短暂竞争；用同一幂等键退避重试。 |
