# 第二轮迭代 #16：负责人协调闭环与决策归因

> 本文是任务 `task_4cff3086-8c6e-43e0-9cf9-ed2b0a0fffe3` 的执行交付说明，不是发布报告。文中测试证据来自隔离副本中的 Node 内置测试与确定性模拟执行器；真实负责人协调、PR/CI/合入、升级和部署后 agent 接口验收仍属于发布验收项，未在本任务宣称完成。

## 1. 交付范围与边界

本任务在隔离工作副本中：

1. 合并并核对前序 #15（外部智能体接口）与 #5（有序模型倾向）的完整改动，解决共享文件冲突。
2. 按 `docs/iteration-2-contract.md` 第 3.8 节补齐负责人自主规划的计划台账、管理批次归因、审查反馈协调、执行侧反馈协调、候选能力与偏好输入。
3. 提供可回归测试与证据，保存真实规划回执到真实任务 ID 的映射并标注来源。
4. 明确列出仍需部署后证明的负责人协调行为与所有者首次接入验收项。

本任务不宣称：

- 运行了真实模型或真实负责人协调；
- 创建、合入 PR 或升级现场 ACMS；
- #15 的 owner 首次签发凭据入口已经可操作；
- #5 的旧宿主模拟界面证据可以代表本版本。

## 2. 前序改动整合与共享文件冲突

### 2.1 合并基线

- 目标基线：`178987ad4337a499f925d4377de44a3b5f11d550`。
- 先以 fast-forward 合入 #5 分支 `acms/task_bec5ae18-2b18-4f35-a791-f52d0542903e`（HEAD `78148e8`）。
- 再以三方方式应用 #15 工作副本中 7 个已修改文件和 10 个新增路径；#15 工作副本未提交，故用其工作树生成补丁后在隔离副本合并，不改动其工作目录。
- 合并后重新生成 `lib/client.js` 前先确认构建产物与暂存版本无内容差异；若仅换行差异则恢复，避免无关改动。

### 2.2 冲突与取舍

| 文件 | 冲突 | 取舍 | 依据 |
| --- | --- | --- | --- |
| `package.json` | #15 增加 `agent` 脚本；#5 增加 `test:model-preferences-ui` | 两者并存 | 互不覆盖 |
| `src/core/domain.js` | #5 增加偏好命令；#15 增加 user-agent 命令、凭据快照 | 保留全部命令与 snapshot 字段 | 契约要求最终合并者保留三类改动 |
| `src/host/http.js` | #5 删除 `agent.save` 的模型详情调用；#15 只删除其中一行 | 删除整个 `agent.save` 隐式选择块 | `adapter.choose` 会读取模型目录并触发检测，违反“普通管理不隐式触发模型检测”；#5 的严格行为优先 |
| `src/runtime/engine.js` | #5 增加选择阻塞分支；#15 只改清理 | 两者并存，并新增协调流 | 无行为重叠 |
| `src/runtime/prompt.js` | #5 增加 `modelContext`；#15 增加 user-agent 指令 | 在负责人合同同时保留，再补 #16 字段 | 契约第 3.7/3.8 节 |
| `test/agent-api.test.js` | #15 期望 `agent.save` 调用 `choose` 一次 | 改为 0，并保留 modelDetails/probe/catalog 均为 0 | 合并后 `agent.save` 不再隐式检测，测试应验证更严格行为 |

上述取舍是执行员在可逆实现细节内的决定，不改变接口、权限或验收门槛。

## 3. 负责人合同新增内容

`src/runtime/prompt.js` 在负责人角色下新增只读字段，全部来自数据库，不调用模型：

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `goalConstraints` / `goalSource` | goal 记录 | 区分用户约束与目标提交主体 |
| `plans` | `plans` 集合，最近 5 条 | 计划原始依据与真实任务映射 |
| `decisionLog` | 事件流中带 `decision` 的条目，最多 20 条 | 负责人决策、调度器动作与审查决定的可读摘要 |
| `goalTasks` | 同目标任务摘要 | 负责人重建上下文时不漏任务 |
| `coordination` | 当前协调任务对应源任务、审查轮次、反馈哈希、返工上限 | 协调任务专用上下文 |
| `rework` | 源任务或当前任务的 feedback/reworks/maxReworks | 返工决策依据 |
| `modelContext` | #5 的候选能力、授权与偏好顺序 | 模型选择不猜测用户偏好 |
| `managementResults` / `managementTurnsRemaining` | 管理批次记录 | 管理续轮与真实结果回填 |

合同不包含 grants 扩大、数据库路径、token 或真实模型探测。

## 4. 计划落地、归因与幂等

### 4.1 计划记录

`acceptPlan` 对负责人计划执行以下动作（实现见 `src/core/plan-ledger.js`）：

- 计划记录 ID 为 `<planTaskId>:g<generation>`；同一代次重复提交返回既有记录，不重复创建任务或事件。
- 同一 ID 但计划内容不同返回 `PLAN_CONFLICT`，不覆盖既有映射。
- `plans` 保存 `goalId`、`taskId`、`generation`、`attemptId`、`managerId`、`rationale`、`rationaleSource`、`nodes`、`acceptedAt` 与 `fingerprint`。
- `rationale` 来自负责人原文并截断到 4000 字符；为空时回退到 summary 并标记 `rationaleSource=summary`；两者都为空标记 `none`。
- 每个子任务写 `origin`：`kind=manager-plan`、`decidedBy/createdBy=manager`、`planTaskId`、`planKey`、`assignment`、`assigneeAgentId`、`basis`。
- 子任务以负责人主体创建，`task.created` 事件 actor 为 manager；计划任务本身仍由调度器创建，其 `task.created` actor 仍是 scheduler。
- `plan.accepted` 事件 actor 为 manager，body 含真实任务映射与 `decision.kind=manager-decision`。
- 未提供 `assignee` 的节点保持调度器默认临时执行员，`assignment=scheduler-default`，不得说成负责人分派；提供 `assignee` 时必须是同目标可分配人员。

### 4.2 归因边界

| 记录 | 产生者 | 证据字段 | 能否证明自主规划 |
| --- | --- | --- | --- |
| 目标提交 | 用户代理或 owner | `goal.source`、`goal.created` actor | 只证明用户约束 |
| 规划任务创建 | 调度器 | `task.created` actor scheduler | 只证明调度派生 |
| 负责人计划 | 负责人 | `plans`、`plan.accepted` actor manager、`origin` | 证明拆分、依赖与分派决定 |
| 负责人管理动作 | 负责人 | `actionBatches` actorId、`management.batch.committed` | 证明负责人调整 |
| 审查/修复/重试/协调入口 | 调度器 | 对应事件 actor scheduler、`decision.kind=scheduler-action` | 只证明调度器行为 |
| 执行/审查结果 | 执行员/审查员 | attempt result、verification、review.decided | 证明结果，不证明规划 |

历史说明：本轮修复前已发生的规划回执与任务创建记录 actor 为 scheduler；本任务不能追溯修改历史事件，也不会把历史调度器记录改写成负责人决定。部署后的新规划必须产生 manager actor 证据。

## 5. 审查与执行反馈的协调闭环

### 5.1 审查要求返工

`src/runtime/review-flow.js` 在 `changes_requested` 时，除记录 verification、返工次数与 feedback 外，还在同一事务中：

1. 把源任务置为 `blocked`，`stageIndex=0`，依赖加入协调任务，blocker 为 `coordination`。
2. 创建一个 `kind=coordination` 的负责人协调任务，`coordinationOf=源任务`，`coordinationKey=review:<reviewId>`，`reviewTaskId`、`reviewRound`、`feedbackHash` 一并保存。
3. 协调任务由调度器创建，事件 `coordination.created` 的 actor 为 scheduler，`decision.kind=scheduler-action`，只证明“反馈到达，需要负责人”。
4. 协调任务只分配给当前目标的专属负责人或没有 `goalId` 的全局负责人；任务本身走普通调度领取，因此并发、预算、租约和恢复边界不变。其他目标的负责人不会被自动选中。若没有合格负责人，或其缺少 `task.create`/`task.retry`，源任务明确阻塞并生成用户交互，不创建跨目标协调任务。

幂等语义：

- 同一 `reviewId` 重放：相同 key 返回既有协调任务，不重复创建。
- 同一 key 但 `feedbackHash` 不同：返回 `COORDINATION_CONFLICT`，不覆盖既有任务。
- 同一 generation 的第二次独立审查（新的 review task）产生新 key，因此会创建第二个协调任务。

负责人可用结果：

- `outcome=coordinated`：先校验当前负责人角色、目标范围和仍有效的 `task.retry`，再记录负责人决定并释放源任务为 `ready` 继续返工；若源任务已被 owner 暂停，则保持 `paused`，只记录决定，不产生执行。
- `outcome=planned`：同上校验负责人角色与有效授权（另需 `task.create`），重新拆分返工任务，新任务成为源任务依赖；源任务等待这些任务成功后再继续。若源任务已被 owner 暂停，依赖与拆分记录仍保存，但源任务保持 `paused`。
- `outcome=managed`：使用现有 `actionBatches` 调整分派、依赖或重试；ACMS 会再次唤醒负责人，最多沿用现有 4 次管理续轮。
- `outcome=blocked`：负责人判断缺少用户授权或重大范围决策时，创建用户交互；不得由执行员代替负责人作答。

协调任务不会递归创建新的协调任务。审查返工上限在创建协调任务之前执行：`reworks > maxReworks` 时不再打开新的协调轮次，而是写入 `reviewLimitExceeded`、把源任务置为 `blocked` 并生成用户交互，等待 owner 决定追加额度或调整范围。协调释放路径也会再次检查该标志，防止迟到的协调结果绕过上限。

### 5.2 执行侧反馈

- 瞬时失败与普通自动修复仍由调度器处理，保持第一轮恢复语义。
- 自动修复达到上限时，`scheduleRepairFlow` 不再直接向用户提问，而是创建 `coordinationKey=executor:<taskId>:g<generation>:repair-limit` 的负责人协调任务。
- 修复任务自身重试耗尽时，进入 `executor:<taskId>:g<generation>:execution-limit` 协调入口。
- 若同一 key 的协调任务已经成功、同一反馈又再次到达，不自动释放源任务，而是阻塞并请求用户或负责人决定，避免自动重试与协调释放形成循环。
- 可回答的用户阻塞仍优先使用既有 interaction 机制；协调入口不能绕过用户授权。

### 5.3 独立审查四项边界缺陷的返工（本轮）

上一轮独立审查在隔离夹具中复现了四项边界缺陷。本轮按缺陷逐项修复，并把复现用例固化为回归测试。缺陷代码位于提交 `ae05874`，修复后的工作树见本轮提交。

| 缺陷 | 根因 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| P1 owner 暂停在协调期间被清除 | `releaseSource` 无条件把源任务改为 `ready` | 直接释放与重新拆分两条路径都先识别 `paused`；暂停时只更新决定/依赖，不产生可执行状态 | `coordination keeps an owner pause on direct release and re-split` |
| P1 协调结果不校验角色和当前有效权限 | `completeCoordination` 只按 attempt 记录决定 | 接受时重新读取 agent，要求当前角色仍为 manager、目标范围匹配、当前有效授权仍含 `task.retry`；重新拆分另需 `task.create`。零权限 worker、被撤回全部授权的负责人均返回 `FORBIDDEN` | `coordinated result re-checks manager role and current grants` |
| P1 负责人回退选择跨目标 | `findManager` 回退到任意可用 manager | 只允许当前目标专属负责人或无 `goalId` 的全局负责人；无合格人员时明确阻塞并生成交互，不回滚审查结果 | `coordination fallback ignores managers dedicated to another goal` |
| P2 超过返工上限仍继续协调返工 | 只写 `reviewLimitExceeded`，仍创建协调任务并释放源任务 | 在创建协调任务前执行上限和授权校验；超限直接阻塞并请求 owner 决定；释放路径拒绝已超限的迟到协调结果 | `review rework ceiling blocks for the user instead of opening another coordination`; `coordination result cannot release a source already beyond the rework ceiling` |

红测证据：`docs/iteration-2-autonomy-sources/coordination-regressions-red.log`。该日志由暂时恢复 `ae05874` 的三个源码文件后运行五个新增用例产生，结果为 0 通过、5 失败；恢复修复版后同一组用例全部通过，原始输出另存为 `coordination-regressions-green.log`。红测用于证明用例确实覆盖缺陷，不表示旧版本可交付。

### 5.4 只读查询与界面状态

- `/api/acms/state` 的 snapshot 增加 `plans` 与 `actionBatches`，便于界面与 owner 读取真实映射和管理批次。
- 外部事件读取的 `eventEntry` 已把 `decision` 与业务 `data` 分开；协调与计划事件不会把决策伪装成普通字段。
- 负责人合同只读数据库；获取候选能力仍通过 #5 的 `modelContext`，不会因查看计划、偏好或决策而启动真实模型探测。

### 5.5 独立审查两项 P1 权限边界缺陷的返工（本轮）

上一轮对本任务的独立审查在隔离夹具中复现了两项权限边界缺陷，当前版本据此返工。

| 缺陷 | 根因 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| P1 负责人停用后协调结果仍被接受 | `coordinationAuthority` 只检查角色、目标范围和 `task.retry`，未检查负责人当前 `status`；在协调执行期间把负责人停用为 `retired` 后，直接恢复与重新拆分仍会成功 | 接受协调结果时在事务内重新读取负责人，要求 `status=available`；直接恢复与重新拆分两条路径共用该检查 | `coordinated and re-split decisions reject a manager retired during execution` |
| P1 规划选择与计划接受未校验负责人目标范围 | `createGoalRecord` 选取任意可用 manager；`acceptPlanFlow` 接受计划时未复核其 `goalId` | 初始规划只选择没有 `goalId` 的全局负责人，无合格人员时明确 `MANAGER_REQUIRED`；接受计划时在事务内重新读取负责人并校验 `goalId` 为空或匹配，同时按 attempt grants 重新校验 `task.create` 与当前状态 | `initial planning never picks a manager dedicated to another goal`; `plan acceptance re-checks the manager goal scope and current status` |

红绿证据：`docs/iteration-2-autonomy-sources/manager-authority-red.log` 由暂时恢复 `ae2672b` 的三个源码文件后运行上述三个用例产生，结果为 0 通过、3 失败；恢复修复版后同一组用例 3/3 通过，原始输出见 `manager-authority-green.log`。红测只证明用例能复现缺陷，不表示旧版本可交付。

### 5.6 第三轮独立审查四项缺陷的返工（本轮）

第三轮独立审查在隔离夹具中复现四项缺陷：managed 路径跨目标、负责人合同决策日志截断、协调失败递归、累计归档清单不一致。本轮逐项修复并把复现用例固化为回归。

| 缺陷 | 根因 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| P1 managed 路径未复核负责人自身 goalId | engine 用任务 goalId 组装 actor，runActionBatch 的 goal 比对因此恒真 | runActionBatch 重新读取持久化 manager，要求 `!manager.goalId || manager.goalId === task.goalId`；全局负责人仍可管理 | `managed batch rejects a manager scoped to another goal after manual reassignment` |
| P2 decisionLog 只读窗口首页 | pageScoped limit 100 后未翻页，突发普通事件会遮住最新决定 | 最多 50 页、每页 200，扫描完 2000 事件窗口后取最后 20 条 decision | `manager contract decision log pages past a burst of ordinary events` |
| P2 协调任务 technical 阻塞后递归 | 达到修复上限后仍以协调任务为源创建新协调 | 协调任务 technical 阻塞不再进入修复/协调；`createCoordination` 拒绝 coordination 源 | `a failed coordination blocks without repair or nested coordination` |
| P2 累计归档 files.json/SHA256SUMS 与 ZIP 字节不一致 | 清单与 ZIP 从不同快照生成 | 同一暂存树先算哈希再打包，落盘后读取 ZIP 中央目录逐项复核 | `verify-cumulative-archive.mjs` 与 `cumulative-archive-verification.json` |

前三项红绿证据：`coordination-third-round-red.log` 由暂时恢复上一轮三个源码文件（action-batch.js、prompt.js、engine.js、coordination.js）后运行三个新增用例产生，预期 0 通过；恢复修复后 3/3 通过，见 `coordination-third-round-green.log`。归档一致性由构建脚本在同一字节快照上生成并复核，结果见 `cumulative-archive-verification.json`，不是文本声明。

### 5.7 第四轮独立审查缺陷的返工（本轮）

第四轮独立审查复现：公开首次接入指南第 3 节的 PowerShell 把 `"$env:USERNAME:(R,W)"` 解析为 `"(R,W)"`，`icacls` 退出码 87，ACL 未改变；`scripts/external-onboarding-ui-test.mjs` 未执行该公开步骤，19 项断言因此未覆盖。另在交付文档中发现 15 个 U+FFFD 替换字符（涉及 6 行）。本轮修复：

| 缺陷 | 根因 | 修复 | 回归 |
| --- | --- | --- | --- |
| P2 token 文件 ACL 命令失败且未被检查 | PowerShell 把 `$env:USERNAME:` 当作驱动器限定变量，`icacls` 收到 `"(R,W)"`；脚本没有检查退出码 | 改用当前用户 SID 的 `${me}` 边界形式，`icacls /inheritance:r /grant:r "*${me}:(R,W)"`；随后检查 `$LASTEXITCODE`、`AreAccessRulesProtected` 与其他身份 ACE，任一步失败即抛错 | UI 测试直接抽取并执行文档第 3 节代码块，读取 token 字节与 `Get-Acl`；新增 `test/external-onboarding-doc.test.js` 在 `npm test` 中执行同一段脚本 |
| P2 公开步骤未被测试执行 | 测试用 `writeFile(..., mode: 0o600)` 自建 token 文件，绕过 icacls 步骤 | 改为运行文档代码块（测试注入 `ACMS_DATA_DIR` 与 `ACMS_AGENT_TOKEN`），CLI 只传 `--discovery` 并使用默认 token 文件；断言由 19 项增至 25 项 | `tokenSetupExitZero`、`tokenFileMatchesIssued`、`tokenAclProtected`、`tokenAclOwnerOnly`、`tokenAclNoInherited`、`tokenAclReadWrite` |
| P2 交付文档替换字符 | 早期修订脚本按字节替换时损坏了多字节字符 | 修复 `docs/agent-api.md`、`docs/external-agent-onboarding.md`、`docs/iteration-2-autonomy.md` 中的 U+FFFD；新增文档扫描断言，交付文档不得含 U+FFFD | `iteration-2 delivery docs contain no Unicode replacement characters` |

补充发现：环境存在 `ACMS_AGENT_TOKEN` 时，CLI 会优先使用环境变量而不是 token 文件。测试在子进程中清除该变量以验证公开的 token 文件路径；文档的常见错误表增加了对应排查项。

## 6. 真实规划回执与任务 ID 映射

### 6.1 来源

- 原始回执：`docs/iteration-2-autonomy-sources/manager-plan-receipt.json`。
- SHA256：`49e0eeaf5f37db6ed15eb2d992e1628d4953471ac2f56189d657c79f74147b07`（与契约记录一致）。
- 负责人 attempt：`attempt_f56471ca-fd7c-48f2-815c-5f921ac1f1bd`。
- 规划任务：`task_760e3e7e-a013-4299-8b94-9394c41f1f49`。
- 目标：`goal_a50f7722-7856-4f98-a303-2a8c17af36bc`。

### 6.2 节点映射

完整结构化映射见 `docs/iteration-2-autonomy-sources/plan-task-mapping.json`。

| 计划 key | 真实任务 ID | ID 来源 | 快照状态 |
| --- | --- | --- | --- |
| requirements | `task_4314019d-436b-4785-aea5-258cbf8006a0` | 协作快照 | succeeded |
| agent_api | `task_ab7105f7-1f5d-4775-9752-9088b3543044` | 协作快照 | succeeded |
| model_preferences | `task_bec5ae18-2b18-4f35-a791-f52d0542903e` | 协作快照 | succeeded |
| autonomous_coordination | `task_4cff3086-8c6e-43e0-9cf9-ed2b0a0fffe3` | 协作快照 | 本任务执行中 |
| release_candidate | `task_5f526a54-6871-4fe7-9425-c43c0b3b1bde` | 契约文档第 3.10 节 | 快照未包含，未核实 |
| release_verification | `task_f956028a-14d8-4eaf-b64f-8cabafb4ca55` | 契约文档第 3.10 节 | 快照未包含，未核实 |

### 6.3 三类记录与实际结果

| 类别 | 本次可核实内容 | 不能证明什么 |
| --- | --- | --- |
| 用户约束 | 目标合同、`.acms/context.json` 初始目标输入；没有预置工作任务表 | 不能证明负责人如何拆分 |
| 负责人决策 | 回执中的六项 DAG、依赖与 rationale 原文 | 不能证明部署后新事件已归因，也不能证明任务执行成功 |
| ACMS/调度器动作 | 规划任务创建、审查任务创建、修复/重试、协调入口；历史事件 actor 为 scheduler | 不能单独证明自主规划 |
| 实际执行结果 | 快照中 requirements/agent_api/model_preferences 为 succeeded；本任务运行中；发布任务未在快照 | 不能证明发布、合入或升级 |

## 7. 验证与证据

### 7.1 本任务运行结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 静态与包契约 | `node scripts/check.mjs` | 通过 |
| 全量 Node 测试 | `npm test` | 312/312 通过，0 失败 |
| 新增协调回归 | `node --test --test-concurrency=1 test/autonomy.test.js` | 20/20 通过 |
| 受影响回归（含引擎与管理批次） | `node --test --test-concurrency=1 test/recovery-boundaries.test.js test/domain.test.js test/task-management.test.js test/engine.test.js test/action-batch.test.js` | 52/52 通过 |
| 边界缺陷红测 | 暂时恢复 `ae05874` 的三个源码文件后运行五个新增用例 | 0/5 通过，5 失败（预期红测） |
| 本轮 P1 红绿复现 | 暂时恢复 `ae2672b` 的三个源码文件后运行本轮三个用例 | 红测 0/3 通过、3 失败；修复版 3/3 通过 |
| 构建 | `npm run build` | 退出 0；构建后 `lib/client.js` 与版本无内容差异，已恢复避免无关改动 |
| 结构检查 | `npm run test:structure` | 通过 |
| 首次接入端到端 | `node scripts/external-onboarding-ui-test.mjs` | 25/25 断言通过（含按公开文档执行 token 写入与 ACL 校验）；隔离预览宿主，真实模型调用 0 |
| token 文件 ACL 回归 | `node --test --test-concurrency=1 test/external-onboarding-doc.test.js` | 3/3 通过 |

原始输出保存在 `docs/iteration-2-autonomy-sources/`，机器可读汇总见 `validation.json`。

### 7.2 验收项覆盖
| 验收关注 | 测试 |
| --- | --- |
| 管理批次重放 | `test/action-batch.test.js` 既有用例 + `test/autonomy.test.js` 的标准化批次与协调批次 |
| 权限收窄/越权 | action-batch 授权用例 + autonomy 的无 `task.create` 负责人 |
| 跨目标拒绝 | action-batch 作用域用例 + autonomy 的跨目标 assignee |
| 反馈续跑 | autonomy 的审查拒绝、两次拒绝、协调后续跑 |
| 独立审查 | engine 既有审查用例 + autonomy 的 review context 隔离与 reviewer 非作者 |
| 上下文隔离 | autonomy 中 work/review/coordination contextKey 互不相同 |
| 协调幂等 | autonomy 中同 key 重放与不同 feedbackHash 冲突 |
| 计划幂等 | autonomy 中 plan 重放与 PLAN_CONFLICT |
| 并发/预算 | 既有 concurrency、runtime-budget 测试 + 协调任务走原调度 |
| 执行侧协调 | autonomy 的 repair-limit 用例与 recovery-boundaries 更新 |
| owner 暂停门槛 | autonomy 的直接释放与重新拆分两条暂停用例 |
| 协调结果权限收窄 | autonomy 的撤回负责人授权、零权限 worker 用例 |
| 跨目标负责人拒绝 | autonomy 的修复上限与审查返工两条无合格负责人用例 |
| 审查返工上限 | autonomy 的超限阻塞与迟到协调释放拒绝用例 |
| 协调结果状态复核 | autonomy 的 `coordinated and re-split decisions reject a manager retired during execution` |
| 计划接受目标范围复核 | autonomy 的 `plan acceptance re-checks the manager goal scope and current status` |
| 初始规划负责人范围 | autonomy 的 `initial planning never picks a manager dedicated to another goal` |
| 只读分类 | autonomy 中 actor/decision 断言与 snapshot.plans |
| 管理批次跨目标 | autonomy 的 `managed batch rejects a manager scoped to another goal after manual reassignment` |
| 决策日志完整性 | autonomy 的 `manager contract decision log pages past a burst of ordinary events` |
| 协调失败不递归 | autonomy 的 `a failed coordination blocks without repair or nested coordination` |
| 累计归档一致性 | `verify-cumulative-archive.mjs` 逐项复核 114/114 |
| 首次签发入口 | external onboarding 25/25 断言 |
| token 文件 ACL | UI 测试 6 项 ACL 断言 + 新增 3 项 Node 回归 |

所有模型相关测试均使用 `SimulatedAdapter`，日志与本文都明确标注为非真实模型证据。

## 8. 发布验收项（尚未完成，不得宣称）

### 8.1 外部动作

- 由已授权外部用户代理创建 PR、获取对应版本 CI、合入 main。
- 现场确认旧运行进程和子孙进程清理后，备份并升级当前 ACMS，确认实际加载版本、数据保留与运行可用。
- 发布报告分别记录自主规划验收与执行发布闭环验收，不得用本任务的测试替代真实部署证据。

### 8.2 部署后的真实负责人协调
- 升级后由真实负责人完成一次审查返工协调：产生 `coordination.created`（scheduler）、`coordination.decided` 或 `plan.accepted`（manager）、`actionBatches`（manager）与源任务恢复记录。
- 只读核对 `GET /api/acms/state` 的 `plans`/`actionBatches` 与事件流的 `actor`/`decision`；不得直接改数据库。
- 用真实 agent 接口完成提交目标、查询进展/审查/阻塞、回答交互、读取增量事件与暂停/恢复；模型调用仅限本目标。

### 8.3 所有者首次接入（本轮已补入口；真实宿主仍待发布验收）

用户指出 #15 文档只有 `agentCredential.create` 方法名，没有可操作的首次签发入口。本轮已实现并在候选版本中验证：

- 面板新增 **外部接入** 页面（`src/client/access.jsx`）：owner 可选择项目范围、可选目标、允许命令、有效期并签发；明文 token 只显示一次，列表仅显示脱敏前缀与状态，可直接撤销。
- 公开操作文档：`docs/external-agent-onboarding.md`，覆盖签发、保存 token、关闭工作台、CLI 提交/查询/暂停恢复、撤销和错误路径。
- 本候选证据：`docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json` 与 `test-results/ui/external-access-issued.png`。证据使用真实客户端 bundle、真实宿主路由、真实 user-agent API 与 `scripts/acms-agent.mjs`，但宿主是隔离预览、执行器是模拟；25 项断言通过（其中 6 项执行公开文档的 token 写入与 ACL 校验），真实模型调用 0。
- 没有通过直接改数据库、复制模型认证、伪造 owner 或绕过权限来制造证据。

发布验收仍必须在升级后的真实 ACMS 宿主上重做：

1. owner 以 owner 会话在 **外部接入** 页面签发最小范围凭据，保存请求、脱敏响应、范围与“明文只返回一次”证据。
2. token 只写入仅当前 Windows 用户可读的本地文件，确认 `GET /api/acms/state` 的 `agentCredentials` 只有脱敏视图。
3. 关闭工作台页面后，用 `scripts/acms-agent.mjs` 完成提交目标、查询任务/审查/阻塞、读取增量事件以及暂停/恢复；记录每次响应与幂等键。
4. 验证跨 goalId、伪造 owner、缺命令授权、无 token、撤销后重放分别返回 `SCOPE_DENIED`/`INVALID_REQUEST`/`FORBIDDEN`/`UNAUTHORIZED`。
5. 在真实数据上确认审计事件与撤销行为。

上述真实宿主证据出现前，发布验收不得通过；模拟 receipt 不替代真实部署或独立审查。

### 8.4 旧界面证据边界
所有者提供的 `D:/ACMS/test-results/iteration-2/preferences-host-ui/receipt.json` 只对应 #5 当时的受信宿主模拟界面；不能作为本版本或真实模型执行通过的证据。最终候选仍须执行对应版本的必要检查与独立审查。

审查沙箱的 UI 构建权限限制记录在 GitHub #13。本轮新增了外部接入面板并为其生成了候选版本的新 receipt（不是复用 #5 的旧 receipt）；该 receipt 仍是隔离预览宿主模拟，不表示真实宿主和真实模型通过。最终候选必须在升级后的对应版本上重新执行必要检查并由独立审查核对。


## 9. 复现与只读核验

### 9.1 复现检查

在隔离工作副本根目录执行：

```powershell
node scripts/check.mjs
npm test
node --test --test-concurrency=1 test/external-onboarding-doc.test.js
node --test --test-concurrency=1 test/autonomy.test.js
node --test --test-concurrency=1 --test-name-pattern="coordinated and re-split|initial planning never|plan acceptance re-checks" test/autonomy.test.js
node --test --test-concurrency=1 --test-name-pattern="coordination keeps|coordinated result re-checks|coordination fallback|review rework ceiling|coordination result cannot release" test/autonomy.test.js
node --test --test-concurrency=1 test/recovery-boundaries.test.js test/domain.test.js test/task-management.test.js test/engine.test.js test/action-batch.test.js
npm run build
npm run test:structure
```

`docs/iteration-2-autonomy-sources/collect-evidence.mjs` 可重新采集检查日志与验证摘要；它不会修改源码或运行数据库。 边界红测需先把 `src/core/coordination.js`、`src/runtime/review-flow.js`、`src/core/plan-ledger.js` 暂时恢复为 `ae05874` 版本，运行同一组五个用例后再恢复修复版；红测输出见 `coordination-regressions-red.log`；本轮两项 P1 的红绿证据使用 `manager-authority-red.log`/`manager-authority-green.log`（红测先把三个源码文件恢复为 `ae2672b` 版本）。红测结果不能作为可交付证据。`npm run build` 可能改写换行形式的 `lib/client.js`，采集后如无内容差异应恢复该文件。

### 9.2 只读查看决策与计划

- `GET /api/acms/state`：读取 `plans`、`actionBatches`、`tasks`、`events` 等快照字段。
- `GET /api/acms/events?after=<cursor>`：事件条目把 `decision` 与 `data` 分开，并给出 `actor`。
- 负责人合同由 `src/runtime/prompt.js` 的 `buildManagerExtras` 生成，只读数据库。

不要用修改 SQLite、复制 token 或伪造 owner 的方式制造证据。

## 10. 剩余限制

1. 本任务没有运行真实模型。全部协调测试使用 `SimulatedAdapter`，只证明状态机、权限、幂等、归因与上下文隔离。
2. 本任务没有部署后真实负责人协调样本。负责人 actor、`decision`、`plans` 与 `actionBatches` 的新路径已由测试验证，但实际 ACMS 管理角色的记录必须由升级后的真实负责人产生。
3. `release_candidate` 与 `release_verification` 的任务 ID 仅来自契约文档，当前协作快照未包含，不能视为已创建或已成功。
4. 所有者首次签发入口已在候选中实现并有隔离宿主证据；升级后真实宿主上的签发、使用与撤销仍是发布验收项，模拟 receipt 不能替代真实部署证据。
5. 计划节点的 `assignee` 必须是同目标可分配的 agent；全局内置 manager/reviewer 没有 goalId，不能直接作为计划 assignee。负责人可先通过管理批次创建目标内人员再分派，或使用 scheduler-default。
6. 若目标没有当前目标专属或全局可用的合格负责人，修复/执行上限和审查返工会明确阻塞并生成用户交互，不会创建跨目标协调任务，也不会把审查接受整体回滚。
7. 协调任务只处理审查拒绝、修复上限与修复任务重试耗尽三类反馈；其他可回答阻塞仍走 interaction。
8. 管理层续轮沿用上限 4 次；超过上限时负责人必须汇总或请求协助，不能无限循环。
9. 界面未新增协调专用页面；状态通过现有任务详情和 `/api/acms/state` 的 `plans`/`actionBatches` 暴露，最终界面检查由发布候选执行。

10. 公开 token 步骤仅在 Windows PowerShell 上验证；环境中已有 `ACMS_AGENT_TOKEN` 时 CLI 会优先使用该环境变量，而不是 token 文件。

## 11. 证据文件清单

| 文件 | 内容 |
| --- | --- |
| `docs/iteration-2-autonomy-sources/manager-plan-receipt.json` | 负责人真实规划回执原文（SHA256 49e0eeaf...） |
| `docs/iteration-2-autonomy-sources/plan-task-mapping.json` | 计划节点到真实任务 ID 的映射与 caveat |
| `docs/iteration-2-autonomy-sources/collect-evidence.mjs` | 可重复的检查采集脚本 |
| `docs/iteration-2-autonomy-sources/validation.json` | 命令、退出码、计数、环境与限制 |
| `docs/iteration-2-autonomy-sources/coordination-regressions-red.log` | 四项边界缺陷的 5 个新增用例在旧源码上的红测原始输出 |
| `docs/iteration-2-autonomy-sources/coordination-regressions-green.log` | 同一组 5 个用例在修复版上的绿测原始输出 |
| `docs/iteration-2-autonomy-sources/*.log` | 原始命令输出 |
| `docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json` | 本候选首次接入面板与关闭工作台后 CLI 的 25 项断言，含文档 token 脚本执行与 ACL 复核 |
| `scripts/onboarding-doc.mjs` | 抽取并执行公开文档第 3 节 PowerShell、读取文件 ACL 的测试辅助 |
| `test/external-onboarding-doc.test.js` | 文档替换字符、ACL 命令守卫与 ACL 实际效果的 3 项回归 |
| `docs/iteration-2-autonomy-sources/cumulative-archive-verification.json` | 累计 ZIP 内 files.json/SHA256SUMS 与归档字节逐项核对结果 |
| `docs/iteration-2-autonomy-sources/coordination-third-round-red.log` | 第三轮三项缺陷在旧源码上的红测原始输出 |
| `docs/iteration-2-autonomy-sources/coordination-third-round-green.log` | 同一组用例在修复版上的绿测原始输出 |
| `docs/external-agent-onboarding.md` | owner 首次接入的公开操作步骤 |
| `scripts/external-onboarding-ui-test.mjs` | 可复现的首次接入端到端测试 |
| `docs/iteration-2-autonomy-sources/SHA256SUMS` | 交付源码、测试、文档的 SHA256 清单 |

## 12. 结论

本轮在上一轮基础上完成第四轮独立审查缺陷的修复：managed 路径复核负责人自身目标、决策日志跨页读取、协调失败不递归、累计归档逐字节一致；并补齐 owner 首次签发面板入口与公开步骤；本轮进一步修复公开 token 脚本的 ACL 命令、让测试执行公开步骤、清除交付文档中的替换字符。

可以确认的是：代码路径、权限边界、幂等、审查独立性、上下文隔离、模拟执行下的协调续跑、管理批次重放/收窄/跨目标拒绝、决策日志完整性以及归档清单一致性均有本轮回归或独立脚本证据；首次接入的签发、关闭工作台后 CLI 使用、暂停恢复与撤销拒绝在隔离预览宿主中通过 25 项断言。

不能确认的是：真实部署后的负责人协调、真实模型执行、PR/CI/合入、升级、真实宿主上的首次接入以及发布闭环。上述未发生事项继续作为发布验收项，不以本文或模拟 receipt 替代。


## 10. 最终候选（task_5f526a54）：v5 环境缺陷、空模型与重试文档复核

本节记录最终候选在固定产物之外的处理；不改写前面各轮的当时结论。

### 10.1 PowerShell 模块路径与 ACL 夹具

- 审查沙箱证据：临时 token 文件删除 EPERM（D:/ACMS/test-results/iteration-2/autonomy-host-acl-v5-trusted 与 autonomy-review-5-technical-retry）。
- 受信宿主继承 PSModulePath 时复现 Microsoft.PowerShell.Security 重复 TypeData/加载失败（autonomy-host-acl-v5/receipt.json）；仅对子进程移除 PSModulePath 后同版 3/3 通过（autonomy-host-acl-v5-system-modules/receipt.json）。
- 最终处置：scripts/onboarding-doc.mjs 的 childEnvironment 只清理子进程 PSModulePath；test/external-onboarding-doc.test.js 先 icacls /reset 再 rm，并新增伪造模块路径回归。本工作副本 4/4 通过（v7 增加目标范围文案一致性后为 5/5）。成功与失败证据均保留；默认环境与 CI 兼容性仍需实际 CI run 确认。
- 公开文档补充兼容性与清理说明（docs/external-agent-onboarding.md 第 3 节）。

### 10.2 empty-models 真实原因与受影响界面

- 初始失败：scripts/empty-models-test.mjs 打开配对 dialog 后直接点击下层导航，原生 dialog 拦截指针事件，30 秒超时。
- 最终结论：这是测试脚本顺序问题，不是模型/配对界面回归。补上关闭配对并断言 dialog 数量为 0 后，同一无模型目录检查通过：配对入口可用、未绑定模型角色禁止保存、无 pageerror、无自动 model-check/model-details 请求。
- 失败原始输出保留（docs/iteration-2-sources/issue-5/empty-models-known-failure.txt）；修复后日志在 test-results/iteration-2-final/empty-models-green.log。

### 10.3 fs.rm 重试等待更正

- docs/iteration-2-issue-5.md 原写“最多重试约 2.5 秒”不准确。Node 24.22 的 fs.rm 等待为 retryDelay × retry：1..25 次累计 32500ms ≈ 32.5 秒（不含 I/O）。
- 实测：maxRetries=5/retryDelay=20 为 342ms，maxRetries=10/retryDelay=20 为 1165ms，符合线性模型；证据见 test-results/iteration-2-final/environment-evidence.json。

### 10.4 最终候选回归与独立审查

- npm run check、npm test（317/317）、npm run build、CI UI/可用性/结构检查、模型偏好、配对、空模型、首次接入 27/27、公开文档 5/5、接口集成 2/2、owner check 317/317 均通过。
- 作者复核在作者克隆上核对最终源码与哈希，记录见 docs/iteration-2-final-author-verification.md，不构成独立审查。非作者 ACMS 审查是必需项：上一版被其指出 P1 归因缺陷（把作者复核称为独立审查），本修订版已更正并须重新审查；任何送审后改动都重新执行受影响检查并复审。
### 10.5 v7：目标范围并集文案与三层检查

- 非作者审查 attempt_439973df 指出 P2：`src/client/access.jsx` 与 `docs/external-agent-onboarding.md` 把“指定目标”描述为仅限该目标，而 `goalAllowed` 实际为“指定目标 ∪ 由本凭据提交的目标”，与 `docs/agent-api.md` 一致。该说明会误导 owner 判断授权范围。
- 修复：页面提示改为并集语义；新增 `goalScopeText()` 统一签发结果与凭据列表；首次接入指南与 agent-api §2.3 同步。授权判断未改。
- 检查：`test/agent-api.test.js` 新增 1 项并集行为回归；`test/external-onboarding-doc.test.js` 新增 1 项文档/源码一致性回归（5/5）；`scripts/external-onboarding-ui-test.mjs` 新增 2 项渲染断言（27/27）。全量 315/315、owner check 315/315、build 222255 bytes（loader wrapper 前；文件 222458 bytes）。
- 证据：`test-results/iteration-2-final-v7/red-doc-scope.log`（修复前失败）与 `green-doc-scope.log`、`union-scope-behavior.log`、`external-onboarding-ui.log`；`docs/iteration-2-autonomy-sources/final-candidate-v7/p2-goal-scope-fix.json`。
- 边界：非作者复审、PR/CI、合入、升级与真实 DSH 宿主验收仍未发生；本版不宣称发布完成。

### 10.6 v8：接口集成 P2 修复与真实状态机回归

- 非作者审查 attempt_2222a18b 确认权限并集修订通过，但独立复现两项 P2：`/status` 从 company/user 键读取偏好，实际保存键为 `model`，导致保存后 `modelPreferences:null`；`/reviews` 按审查任务 ID 过滤 verification，实际 review-flow 将 verification 关联源任务 ID 与审查 attemptId，导致 `verifications:[]`。
- 修复：`modelPreferencesView()` 读取 `sanitizePreferences(store.get("modelPreferences","model"))`，无记录时返回与界面快照一致的空对象；`reviewsValue()` 与 `taskDetail()` 以审查 attemptId→审查任务 ID 映射，并附 `reviewTaskId`。
- 检查：新增 `test/agent-api-integration.test.js`（真实 HTTP + 临时 SQLite + 真实审查状态机，2/2；含审查任务详情追溯）；`test/agent-api.test.js` 空偏好断言更新。全量 317/317、owner check 317/317、首次接入 27/27、公开文档 5/5。
- 证据：`test-results/iteration-2-final-v9/`；独立复现证据由审查方保留在 D:/ACMS/test-results/current-review/attempt_2222a18b/api-integration-reproduction.json。
- 边界：授权判断未改；非作者复审、PR/CI、合入、升级与真实 DSH 宿主验收仍未发生。
