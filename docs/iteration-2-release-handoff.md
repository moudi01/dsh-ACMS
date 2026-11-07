# 第二轮迭代候选发布交接

> 状态：完整候选已在本隔离工作副本形成并通过本轮回归；GitHub PR、CI、main 合入、当前 ACMS 备份升级、真实 DSH 宿主验收尚未发生。下列未执行步骤保持待验证，不构成发布完成声明。
>
> 本修订版（v8）：修复上一轮非作者审查（attempt_2222a18b）复现的两项 P2 接口集成缺陷——`/status` 的 `modelPreferences` 读取了错误键（实际保存键为单例 `model`，应与界面快照同源），`/reviews` 用审查任务 ID 关联 verification（实际审查 verification 关联源任务 ID 与审查 attempt ID）。新增真实 HTTP 路由、临时 SQLite 与真实审查状态机的集成回归，覆盖偏好保存/清除及批准/退回两种审查结论。授权判断未改。

## 1. 候选身份与版本

- 本修订版 attempt：attempt_2d0b21af-7b07-4f30-a89f-0a2bb506b498；承冻结的 v7 候选（v7 为 attempt_c350a352-92ca-49e6-8c09-eac3c555d389）。
- v6 被非作者 ACMS 审查以 P1 归因缺陷退回：把作者自查称为独立审查，并把非作者审查写成条件性要求；v6 已更正。v7 被同一非作者审查指出 P2：签发提示/结果/列表与 agent-api.md 的目标范围并集语义不一致；v7 已修复。v7 的冻结候选随后被非作者审查（attempt_2222a18b）复现两项 P2 接口集成缺陷，本版 v8 已修复并补充 API 集成回归。
- 本修订版内容提交即清单 measuredCommit；清单提交只含清单与校验和。v8 改动了 src/host/agent-api.js、新增 test/agent-api-integration.test.js、更新 test/agent-api.test.js 与 docs/agent-api.md 等文档/证据，并重建 lib/client.js；授权判断未改。

- 目标 / 任务：goal_a50f7722-7856-4f98-a303-2a8c17af36bc / task_5f526a54-6871-4fe7-9425-c43c0b3b1bde（本修订版 attempt_2d0b21af-7b07-4f30-a89f-0a2bb506b498）。
- 仓库：D:/ACMS（GitHub moudi01/dsh-ACMS），基线 main 178987ad4337a499f925d4377de44a3b5f11d550。
- 工作副本：C:/Users/Administrator/.dsh/acms/workspaces/task_5f526a54-6871-4fe7-9425-c43c0b3b1bde；分支 acms/task_5f526a54-6871-4fe7-9425-c43c0b3b1bde。
- 覆盖 #15 外部智能体接口、#16 负责人协调闭环、#5 有序模型倾向；从 10 个固定 input artifact 按 originalPath 与 SHA256 覆盖，再叠加三个实现任务的固定产物与累计交付包。
- 文件清单与哈希：docs/iteration-2-final-files.json、docs/iteration-2-final-SHA256SUMS。清单不含自身与校验和文件，避免自引用；sourceTreeHash = SHA256(按 path 排序后逐项连接 path + NUL + sha256hex + LF)。哈希取自 measuredCommit 的 git blob 字节（文本为规范 LF，二进制为原始字节），不受 Windows autocrlf 工作树换行影响；复核使用 git show <measuredCommit>:<path>，不要直接对 autocrlf 工作树文件取哈希。
- 原始检查日志：test-results/iteration-2-final-v9/（check.log、test.log、build.log、ui-test.log、usability-test.log、structure-test.log、model-preferences-ui.log、pairing-ui.log、empty-models.log、external-onboarding-ui.log、external-onboarding-doc.log、owner-check.log、union-scope-behavior.log、agent-api-integration.log 等）；v7 历史日志仍在 test-results/iteration-2-final-v7/，v6 仍在 test-results/iteration-2-final/。

## 2. 本候选相对固定产物的新增修复

| 缺陷 | 根因 | 修复 | 回归 |
| --- | --- | --- | --- |
| `/status` 偏好读取错键、`/reviews` verification 关联错 | `agent-api.js` 从 company/user 键读取偏好，实际保存键为单例 `model`；审查 verification 记录关联源任务 ID + 审查 attemptId，`/reviews` 却按审查任务 ID 过滤 | 统一用 `sanitizePreferences(store.get("modelPreferences","model"))` 返回与界面快照一致的对象；用审查 attemptId→审查任务 ID 映射并附 `reviewTaskId` | 新增真实 HTTP + SQLite + 审查状态机集成回归 2/2；空偏好、保存/清除 revision、批准/退回、审查任务详情均通过 |
| 签发提示/结果/列表把目标范围写成“仅限指定目标” | access.jsx 与首次接入指南按旧文案描述，实际 goalAllowed 为“指定目标 ∪ 本凭据提交目标”，与 agent-api.md §2 一致 | 统一 access.jsx 提示、签发结果、凭据列表、external-agent-onboarding.md 与 agent-api.md；新增 API 行为回归、文档/源码一致性回归及 2 项 UI 断言 | 317/317、27/27、5/5 通过；RED/GREEN 见 test-results/iteration-2-final-v9/ |
| 公开 ACL 步骤在继承 PSModulePath 的宿主中失败 | Windows PowerShell 5.1 从 DSH 宿主继承指向另一套 PowerShell 的模块路径，Get-Acl 无法加载 Microsoft.PowerShell.Security | scripts/onboarding-doc.mjs 为子 PowerShell 移除 PSModulePath（大小写不敏感，仅子进程），不改宿主环境 | test/external-onboarding-doc.test.js 新增伪造 PSModulePath 场景；v8 5/5 通过 |
| 审查沙箱删除 ACL 夹具 EPERM | token 文件 DACL 只授予读写且关闭继承，临时目录清理未先恢复权限 | 测试 finally 先 icacls tokenFile /reset，再 rm(..., maxRetries:25, retryDelay:100) | 同一测试 v8 5/5 通过；原失败证据保留于外部审查记录 |
| empty-models 脚本失败 | 已复核原始失败日志：脚本在配对 dialog（aria-labelledby=acms-pairing-title）仍打开时点击下层「组织管理」，Playwright 报 pointer events 被 dialog 拦截，TimeoutError。属既有测试脚本顺序缺陷，产品弹窗正确阻断背景点击 | 截图后先点击关闭配对并断言 dialog 数为 0，再进入组织管理；仅新增 2 行，未改产品代码 | 失败原文 docs/iteration-2-sources/issue-5/empty-models-known-failure.txt；差异与绿色重跑见 final-candidate-v6 |
| 完整套件偶发 EPERM rename | Windows 瞬时文件锁使 codex-runtime 原子写 index 的 rename 失败 | packages/codex-runtime/lib/store.js 对 EPERM/EBUSY/EACCES 做有界线性重试，并避免清理失败掩盖原始错误 | npm test 与 owner check 各 317/317 通过；并发 index 测试重复通过 |
| fs.rm 重试上限文档错误 | Node 24.22 按 retryDelay 乘 retry 线性递增，不是每轮固定 100ms | docs/iteration-2-issue-5.md 与 test-log.md 改为 1..25 次累计约 32.5 秒上限，并附实测 342ms / 1165ms；运行中 Node v24.22 的 internal/fs/rimraf 为 delay = retries * retryDelay | 见 environment-evidence.json 与 final-candidate-v6 |
| 作者复核被误称为独立审查 | 上一版由实现执行者 attempt_187b 在同一执行中克隆、检查并撰写报告，正式 reviewer 在其后才启动（见 D:/ACMS/test-results/iteration-2/candidate-review-attribution-evidence.json） | 删去独立审查称谓与条件句；改为作者复核记录 docs/iteration-2-final-author-verification.md，明确非作者 ACMS 审查无条件必需 | 本文件 §7 与作者复核记录 |

## 3. 检查矩阵（本机实测）

环境：Windows 10 19041 x64；Node v24.22.0；npm 11.19.1；@playwright/test 1.56.1（系统 Chrome）。所有日志来自本工作副本，未经修改。本节证据列只写文件名的日志均位于 test-results/iteration-2-final-v9/。

| 检查 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 静态 / 包契约 | npm run check | 退出 0，Syntax and package contract checks passed | test-results/iteration-2-final-v9/check.log |
| 全量单元 / 集成 | npm test | 317 tests / 317 pass / 0 fail / 0 cancelled，约 37 秒 | test.log |
| 构建 | npm run build | 退出 0，lib/client.js 222255 bytes（loader wrapper 前） | build.log |
| CI 界面 | node scripts/ui-test.mjs | 退出 0 | ui-test.log |
| CI 可用性 | node scripts/usability-test.mjs | 退出 0 | usability-test.log |
| CI 结构 | node scripts/structure-test.mjs | 退出 0 | structure-test.log |
| 模型偏好界面 | node scripts/model-preferences-ui-test.mjs | 退出 0；截图 2 张；无自动检测请求 | model-preferences-ui.log |
| 配对界面 | node scripts/pairing-ui-test.mjs | 退出 0；邀请可见、无重复、无自动探测 | pairing-ui.log |
| 空模型目录 | node scripts/empty-models-test.mjs | 退出 0；配对可用、未绑定角色禁止保存、无 pageerror / model-check | empty-models.log |
| 首次接入端到端 | node scripts/external-onboarding-ui-test.mjs | 退出 0；27/27 断言通过（含 2 项目标范围文案） | external-onboarding-ui.log 与 docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json |
| 公开文档 ACL | node --test test/external-onboarding-doc.test.js | 5/5 通过，含伪造模块路径、ACL 清理与目标范围并集文案 | external-onboarding-doc.log |
| 目标范围行为回归 | node --test --test-name-pattern="goal scope is the union" test/agent-api.test.js | 1/1 通过；指定目标与凭据提交目标的并集，范围外目标仍 403 | union-scope-behavior.log |
| 接口集成（偏好/审查） | node --test --test-concurrency=1 test/agent-api-integration.test.js | 2/2 通过；真实 HTTP 路由 + 临时 SQLite + 真实审查状态机；覆盖空偏好、保存 revision、清除 revision、批准/退回 | agent-api-integration.log |
| 第一轮 owner check | node D:/ACMS/test-results/iteration-1/owner-check.mjs | 317 tests / 317 pass / 0 fail，退出 0，约 36 秒 | owner-check.log |
| 环境复核 | 见 environment-evidence.json | rm 线性重试与 PSModulePath 红绿证据 | environment-evidence.json |
| 默认环境直接执行公开 ACL 块 | 从文档第 3 节抽取代码块并在默认模块路径执行 | 退出 0；token 内容与 ACL 正确 | final-candidate-v6/onboarding-doc-default-env.json |
| 作者复核 | 作者克隆上的清单与检查 | 非独立审查，不构成放行 | docs/iteration-2-final-author-verification.md |

> 说明：npm test 与 owner check 是两次独立执行；owner check 使用其自身的隔离副本来验证第一轮异常恢复、清理不确定占位与自有进程树清理。


## 4. PR 与 CI（待执行）

1. 从候选分支推送并创建 PR；标题与正文见 docs/iteration-2-pr-description.md。
2. 期望 CI（.github/workflows/ci.yml，windows-latest，Node 24）：npm ci；npm run check；npm test；npm run build；npm run test:ui；npm run test:usability；npm run test:structure。
3. 合入条件：CI 全绿、独立审查通过、文件清单与哈希复核一致；不得把本地检查当作 CI 通过。
4. 记录 PR URL、CI run id、结论与审查记录；未发生前保持 pending。

## 5. 发布前现场清理、备份、升级与恢复（待执行）

1. 现场清理：确认没有 active attempt 或 streaming conversation（deploy-live.mjs 会拒绝），按第一轮 owned-process 机制结束遗留自有进程树；清理不确定时保留占位，不自动重试。
2. 备份：暂停写入后复制 dataDir（默认 %USERPROFILE%\.dsh\acms）与 profile 的 cordis.patch.yml；记录路径、时间、大小与 SHA256。
3. 安装：npm ci && npm run build && npm pack；运行 scripts/install.ps1 -TargetProfile desktop -DataDirectory <dataDir>；或用 node scripts/deploy-live.mjs desktop 发布不可变 host bundle（执行 idle 检查并写 install-backups）。
4. 重启或热加载：按安装脚本提示重启 DSH，或刷新页面让 deploy-live 的 host bundle 生效；确认旧运行进程已退出。
5. 验证加载版本：检查 profile 的 ACMS managed 块、host bundle 文件名与 revision、插件 package version、agent-api.json 的 contractVersion/apiVersion/instanceId/pid。
6. 数据保留：对比升级前后核心集合计数、cursor、revision，确认旧任务、审查、凭据仍在。
7. 恢复：失败时用 install-backups 的 yml 与备份回滚，先停写再替换数据；回滚后再次验证发现文件与 API。

> 上述命令来自仓库 scripts/install.ps1 与 scripts/deploy-live.mjs 的现状；执行者必须按现场 profile 与 dataDir 调整，并在发布报告中记录实际命令与输出。

## 6. 真实 DSH 宿主 agent 接口验收（待执行）

### 6.1 首次签发入口（已在候选内，真实宿主待验收）

普通 owner 的可用入口是 ACMS 面板左侧「外部接入」页（src/client/access.jsx），对应命令 agentCredential.create。入口在候选源码内，不依赖测试夹具或直接改库：

1. 打开面板「外部接入」，填写凭据名称、项目范围、可选目标范围、允许命令与有效期。
2. 点击「签发凭据」，页面只显示一次明文 token（acms_ag_ 前缀）；关闭或刷新后不可再读。
3. 列表只显示脱敏前缀、范围、状态与有效期；撤销在同一页完成。

目标范围按并集语义：指定目标与由该凭据提交的目标均可访问；面板提示、签发结果与列表使用同一说明，详见 agent-api.md §2.3。

模拟证据：scripts/external-onboarding-ui-test.mjs 直接驱动真实客户端 bundle 与真实宿主路由，从页面签发 token、按公开文档第 3 节写 token 文件与 ACL、关闭浏览器后再用 scripts/acms-agent.mjs 连接，27/27 断言通过（含无 token、跨目标、伪造 owner、撤销后拒绝）。该证据的宿主是隔离预览宿主加模拟执行器，realModelCalls=0，不能替代真实 DSH 宿主与真实模型证据。

### 6.2 升级后真实宿主验收步骤

1. 使用独立 dataDir 与一次性公司数据启动升级后的宿主；不得直接改运行数据库、不得复制模型认证。
2. 普通 owner 在真实面板「外部接入」签发限定项目与命令的凭据；只记录脱敏前缀与范围。
3. 关闭浏览器工作台（不停止插件），确认 <dataDir>/agent-api.json 存在且 baseUrl 为 127.0.0.1。
4. 按 docs/external-agent-onboarding.md 第 3 节把 token 写入仅当前用户可读文件，执行 discover/projects/status/tasks/reviews/blockers/events，提交并幂等重放一个目标，暂停/恢复范围内任务。
5. 负向：无 token 401、跨范围 403 SCOPE_DENIED、伪造 owner 400、撤销后 401。
6. 真实模型调用只允许在本轮已授权预算内、由 owner 明确发起；普通管理、只读查询和偏好保存不得触发模型检测。记录实际调用入口、模型、耗时与预算。
7. 清理：撤销测试凭据，删除隔离 dataDir 前先用 icacls /reset 恢复 token 文件权限，结束自有进程树并保留清理不确定占位。

## 7. 非作者独立审查（必需，不替代）

- 原验收要求由不参与实现的 ACMS 审查身份核对最终源码与证据；这是无条件必需项，不是可选第三方附加审批，也不因作者自查、克隆目录不同或事后批准而成立。上一版由 ACMS 指派的非作者审查（task_15198221）返回 P1：交付文档把作者复核误称为独立审查。该 P1 已由 v6/v7 更正；v7 冻结候选随后被非作者审查（attempt_2222a18b）复现两项 P2 接口集成缺陷，本版 v8 已修复。作者不能自批，修订后的同版候选必须由 ACMS 重新安排非作者审查。
- 审查内容：git diff 与源码核对、清单 SHA256 复核、npm run check / npm test / build、关键 UI 与接口检查、失败证据保留。
- 作者复核记录见 docs/iteration-2-final-author-verification.md；非作者审查结论以其 ACMS 审查记录为准，本文件不代替。

## 8. 剩余限制

- PR、CI、main 合入、备份升级、真实 DSH 宿主与真实模型均未发生；本文件只证明隔离候选。
- empty-models 失败原因已由原始日志核实为测试脚本顺序缺陷（配对 dialog 拦截下层点击），不是产品缺陷；脚本修复仅 2 行，产品源码未改，旧失败日志保留。
- PSModulePath：外部受信宿主继承异常模块路径时的失败 receipt（autonomy-host-acl-v5）与仅在子进程去掉该路径后的成功 receipt（autonomy-host-acl-v5-system-modules）均保留；测试辅助入口在子进程移除该变量，默认环境直接执行文档块也已通过。GitHub CI 实际结果与继承异常路径的宿主行为仍按未验证处理，不能把限定环境通过写成默认或 CI 通过。
- 审查沙箱 EPERM 清理阻断已由 icacls /reset 与有界 rm 重试修复；默认与 CI 环境兼容性需由实际 CI run 确认。
- UI 构建权限限制见 GitHub #13；本候选不把 #5 的旧宿主模拟 receipt 当作本版本证据。
- 归档内层 manifest 与 artifactHash 语义区分见 #21；本候选改用独立清单文件。
- v8 的两项接口集成修复仅统一偏好读取键与审查 verification 关联并补集成回归，不改变授权判断；非作者复审、PR/CI、合入、升级与真实宿主验收仍未发生，不得把本隔离候选当作发布完成。

## 9. 交接给发布任务

需要：1) 从候选分支创建 PR 并跑 CI；2) 非作者 ACMS 审查记录；3) 备份、升级、恢复证据；4) 真实宿主接口验收；5) 发布报告含提交/PR、检查、审查、部署、恢复与剩余限制。任何未执行步骤保持 pending，不以文字替代动作。

## 10. 修订记录

### 10.1 v6

- 输入：上一版非作者审查 P1；所有者 2026-11-07T10:36 与 12:17 的补充验收输入（首次签发入口、真实宿主区分、empty-models 归因、rm 公式、PSModulePath 双重证据）。
- 文档更正：删除独立审查错误归因与条件句；新增作者复核记录；补充签发入口、模拟与真实区分、empty-models 复核、rm 源码依据、PSModulePath 未验证边界。
- 代码变更：无。产品源码、测试与构建产物相对 8edc035 未改；仅新增或改写文档、证据与清单。
- 复核后改动：任何送审后的文档改动都重新执行受影响的 doc 测试、check、manifest 校验，并由非作者复审。

### 10.2 v7

- 输入：非作者审查 attempt_439973df 的 P2：`src/client/access.jsx:51` 与 `docs/external-agent-onboarding.md:17` 声称指定目标后仅限该目标，但实际 `goalAllowed` 是“指定目标 ∪ 本凭据提交目标”，与 `docs/agent-api.md` 一致。
- 修复：`src/client/access.jsx` 的提示改为并集语义；新增 `goalScopeText()` 统一签发结果与凭据列表展示；`docs/external-agent-onboarding.md` 同步；`docs/agent-api.md` §2.3 补充“提示、结果/列表与并集语义一致”。
- 检查：`test/agent-api.test.js` 新增并集行为回归 1/1；`test/external-onboarding-doc.test.js` 新增文档/源码一致性回归，5/5；`scripts/external-onboarding-ui-test.mjs` 新增 2 项渲染断言，27/27；全量 315/315、owner check 315/315、build 222255 bytes（loader wrapper 前；文件 222458 bytes）。
- 证据：`test-results/iteration-2-final-v7/`（red-doc-scope.log、green-doc-scope.log、union-scope-behavior.log、external-onboarding-ui.log、test.log、owner-check.log）；`docs/iteration-2-autonomy-sources/final-candidate-v7/p2-goal-scope-fix.json`。
- 边界：授权判断未改，未新增权限；本版仍需非作者复审，PR/CI/合入/升级/真实宿主验收未发生。

### 10.3 v8

- 输入：非作者审查 attempt_2222a18b 的复核反馈。该反馈确认权限并集修订通过，但独立复现两项 P2 接口集成缺陷：`/status` 从 company/user 键读偏好，实际保存键为 `model`；`/reviews` 按审查任务 ID 过滤 verification，实际审查 verification 关联源任务 ID 与审查 attemptId。
- 修复：`modelPreferencesView()` 统一读取 `sanitizePreferences(store.get("modelPreferences","model"))`，无记录时返回与界面快照一致的空偏好对象；`reviewsValue()` 与 `taskDetail()` 通过审查 attemptId→审查任务 ID 映射关联 verification，并附 `reviewTaskId`。
- 检查：新增 `test/agent-api-integration.test.js`，使用真实 HTTP 路由、临时 SQLite 与真实审查状态机，覆盖空偏好、偏好保存/清除 revision、批准与退回两种审查结论、审查任务详情追溯；`test/agent-api.test.js` 同步空偏好断言。全量 317/317、owner check 317/317、首次接入 27/27、公开文档 5/5。
- 证据：`test-results/iteration-2-final-v9/`（test.log、agent-api-integration.log、owner-check.log、external-onboarding-ui.log、external-onboarding-doc.log 等）；独立复现证据由审查方保留在 D:/ACMS/test-results/current-review/attempt_2222a18b/api-integration-reproduction.json。
- 边界：授权判断未改；PR/CI/合入/升级/真实宿主验收未发生；本版仍需 ACMS 重新安排非作者复审。

## 10. v9 CI repair delta (supersedes section 8 CI-pending wording)

PR #23 run 42383001370 failed 315/317 in the published ACL guard. The failure is an explicit foreign ACE on the token file, not a test-only issue. The published block now rebuilds the ACL and removes foreign explicit ACEs; the new regression covers an explicit Everyone ACE.

Local evidence: commit 6634c677bd629e6c79480a0cacd376cb8ec260b9 has the exact PR #23 tree 72ced9318a1c1d7a24fdfd9a30300a9a46d6ca4a; red exit 1 (ci-fix-red.log), green 6/6 (ci-fix-green.log), check exit 0. Non-author review, PR update, CI, merge, backup, upgrade and live acceptance remain pending.
