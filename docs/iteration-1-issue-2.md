# 第 1 轮：#2 恢复协议及 #3 合并交接

本交付是隔离副本中的开发结果，供 ACMS 的非作者独立审查及宿主 owner check 使用。未发布 PR、合入 main、切换现场 host 或升级。打包验证在本沙箱中受阻，不能把本交付称为已满足全部发布门槛。

- 任务：`task_456ee225-f835-4168-a5ec-427dec292757`
- 最终执行：`attempt_e8366081-e079-48e6-8f5d-71375ef84f12`，针对独立审查 P1/P2 返工。复用 `attempt_f7efe364-6ee3-46b7-b899-503a3bb1ccfe` 的完整检查点；该执行继续了因外部总时限结束的 `attempt_0ec1098c-3efb-4960-bed5-9c8ae2f0f3ab`。本次重新读取协作记录、14 个 #3 输入 blob 和前次 26 个交付 blob，全部按 ACMS artifact hash 核验，前次交付与返工前副本 26/26 逐字节一致。没有用旧 #3 文件覆盖已整合的 #2 改动。
- 工作副本基线：`8d4b2b034c7387395bed61a328b4f64d367980e1`，已用 `git rev-parse HEAD` 核实。
- 平台：Windows x64，Node `v24.22.0`，2026-11-07。
- 开发前解析只读 `.acms/context.json`，选取本任务、父规划及 #3 依赖，并读取 `.acms/shared.md`。`changeNotifications` 为空。依赖 #3 的独立审查在快照中为 succeeded，最新审查执行 `attempt_6ae6501c-516d-4055-8226-aa60aedde340` 明确通过；这是 #3 的历史证据，不是本次合并改动的独立批准。
- 已落实所有者补充：修复 helper 相对 bundle 的发布路径，新增打包后的真实进程树测试；维持正式 runner 原审批/沙箱参数；不扩展 #13，不修改依赖、原始项目、现场数据库、插件、认证、策略或调度。未创建子代理。

## 独立审查返工：P1/P2（本次最终验证）

本节为最新交接，优先于后文前次执行的历史测试记录。本次没有自行独立审批。CONTRACT.previousFeedback 记录前版宿主 210/210 通过及审查人发现的三项失败断言；该历史证据不替代本次 29 个完整文件的宿主检查和非作者复审。

### P1：blocked 结果提交崩溃窗口

原 `Engine.accept()` 先以独立事务提交 `completed/resultAccepted`，随后才写 blocked 任务、待回复问题或技术重试/修复任务。宿主在 `attempt.finished` 提交后退出，恢复会误认为业务结果已经应用。

现在将接受标记、运行时间记账、reversibleDefault 交接说明、任务状态与提问/重试/修复副作用统一放在同一外层 SQLite 事务。已有嵌套事务沿用同一提交，事件仅在提交后发出。提交前崩溃全部回滚，可靠完成回执可重新应用；提交后崩溃业务结果已经完整入库，恢复仅确认清理，不创建重复问题/修复任务、不重复记账或调用模型。

`test/fixtures/blocked-accept-host.mjs` 是明确标注的状态故障夹具：在独立真实 Node 宿主里调用 Engine.accept，在业务写入前或 `attempt.finished` 提交后的事件回调中直接 `process.exit(86)`，由另一个宿主重新获取租约和恢复。覆盖人工阻塞、技术重试、自动修复和修复上限四条路径。没有模型调用或伪装模型执行证据。

### P2：暂停/取消仍需完成执行核对

- `controlTask()` 把 `cleanupPending` 也视为未释放资源。对 reconciling 执行保持该状态并保存 stopRequested，同时请求一次回执读取；已接受但仍在清理的执行进入 stopping。
- 新增共享 `canReconcileTask()`，使后端与任务详情界面均允许 reconciling，以及仍有未释放执行的 stopping 状态刷新回执。兼容旧宿主持久化的 stopping 状态。界面保留真实原因并说明暂停/取消等待清理确认。
- Engine 在当前 attempt/generation 匹配且可靠回执明确确认清理后，落实 paused/cancelled 并释放占位；已有接受标记继续保留。completed 回执同样能证明已经停止，有停止意图时遵循停止请求、不再次应用已被停止的业务结果，原回执继续保留。缺失、损坏、身份不匹配或清理未知的回执仍保留 stopRequested 和占位，禁止重新派发或自动修复。
- 补齐本次发现的相邻竞态：暂停/取消在 live 结果接受之后、dispose 尚未结束时到达，清理成功事务直接落实停止状态，避免清理标记被清除后再也没有可恢复 attempt。清理失败仍走原 reconciling 约束。

新增 `test/recovery-boundaries.test.js` 共 21 项：8 项真实宿主崩溃；8 项暂停/取消 × stopped/completed 回执 × 未接受/已接受执行；2 项旧 stopping 重启；1 项 completed 仍有清理占位；2 项 live 最终清理阶段停止竞态。断言业务效果唯一、占位和停止意图保留、共享界面操作条件、停止生效以及没有额外执行调用。原有身份错配、代际、任务/审查隔离及 #3 回归继续保留。

| 本次最终命令 | 实测结果 |
| --- | --- |
| `node --test --test-concurrency=1 --test-timeout=20000 test/recovery-boundaries.test.js` | 退出 0，21/21 通过，0 失败/取消/跳过，1372.6329 ms |
| `node scripts/check.mjs` | 退出 0，Syntax and package contract checks passed |
| `git diff --check` | 退出 0 |
| `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js packages/codex-runtime/test/*.test.mjs` | 退出 1，231 项中 227 通过、4 失败、0 取消/跳过，26466.9421 ms。四项全部在 `test/bundled-cleanup.test.js` 的 esbuild 构建阶段报 `Cannot read directory "../../../..": Access is denied.`；未运行到打包后的真实树清理。其余核心测试及 #2/#3 回归均通过 |
| `node scripts/build.mjs` | 退出 1，同一目录读取权限错误，随后无法解析客户端入口；未完成客户端构建 |
| `node --input-type=module -e "import fs from 'node:fs/promises';import {transform} from 'esbuild';await transform(await fs.readFile('src/client/app.jsx','utf8'),{loader:'jsx'});console.log('Updated JSX syntax transform passed');"` | 退出 0，JSX 语法转换通过；不等同于完整构建或视觉验收 |

中间检查：最初 19 项专项通过；随后完整 229 项中 225 通过、同样 4 项打包受阻。发现并补齐 live 清理停止竞态后，以上 21/21 和 227/231 才是最终数据。临时日志未列入代码 artifacts。未修改沙箱、安装依赖或绕过审批；未执行现场 deploy-live。打包资源和正式 runner 参数相对前次交付未改，非 Windows 的启动前明确拒绝继续保留。owner check 需针对本次源码重新准备依赖和验证完整 231 项及构建；#13 未扩入实现。

局限：本次原子性保证适用于新版本接受过程，不能凭状态推测修复旧版已经留下的 `completed + running + 缺失业务效果` 历史损坏记录；如现场存在，需另有可审计迁移/修复证据，不能直接重调模型或改现场数据库。本轮没有此类现场材料。完整 UI 视觉验收、真实模型端到端、现场进程残留检查仍未执行。新版非作者独立复审、宿主补证和全部发布步骤仍由外部流程完成。

## 故障原因与恢复协议

旧实现把 Codex 状态写入 `codex-chat-threads.json` 的 `model.id:contextKey` 或 `model.id:runId`，查询却从 DSH provider registry 的 stateFile 使用原始 contextKey 读取，paired provider 因而没有有效查询路径。可复用会话 summary 还会被下一次执行覆盖，不能单独充当某个 attempt 的结果凭证。

新增 `src/runtime/execution-receipt.js`，以执行身份生成独立 runKey 和实际 Codex threadKey。身份包括 provider、model、attemptId、contextKey、generation、kind、persistent、runtime。DshAdapter 在启动进程前将完整引用和实际选中的 provider/model 保存到 attempt；无引用的旧版本执行不猜测映射。

- runKey 由完整身份摘要确定，每次 attempt 独立，不被后续会话覆盖。
- 持久 threadKey 由 provider/model/context/generation/kind 确定；不同 attempt 可续接同一任务会话，但每次回执分离。审查、代际变化、模型或上下文变化均隔离。
- 非持久或 freshContext 的 threadKey 使用本次 runKey。这里的“非持久”表示 ACMS 不复用会话；Codex 的 thread/start 协议仍沿用原 durable-thread 字段，不冒充其底层历史销毁能力。
- runner 与 Codex app-server 共用宿主侧逐次回执；Codex 进度按引用中的真实 threadKey，直接读取其确定的 summary 路径，校验 summary 的身份和模型，不再依赖 paired 不存在的 DSH registry entry。
- 原生 DSH 的旧 summary 不提供完整身份与子孙清理证据，保持 unknown；不把其 idle 状态升级为重试许可。

逐次回执位于宿主 dataDir 的 `paired-runs/<run-key摘要>.json`，与模型工作副本分离。先取得不可抢占的专属 `.lock`、原子写入 starting，再启动执行；仅在 #3 的完整进程树清理成功返回后，写入 completed/stopped，最后移除本次锁。写入或解锁失败也保持占位。完成回执包含宿主已解析的完整结果；进度文本不会被当成结果。

查询只读，不删除锁，也不根据 PID 已死、根进程退出或宿主重启推断子孙已清理。启动入口扫描先前未确认回执；跨宿主的未知执行、隔离记录和没有 JSON 的孤锁会阻止继续调用模型。当前宿主中已知的并发执行仍可按现有容量运行。重复调用相同 attempt 拒绝启动，不破坏已完成回执。

| 可信观察 | 处理 |
| --- | --- |
| 身份全部匹配、终态 completed、结果完整、清理确认、无执行锁 | 恢复现有结果，经原验收/收集/审查流程入库；模型调用次数不增加 |
| 身份匹配、终态 stopped、清理确认、无完整结果、无锁 | 可按现有调度继续重试 |
| 正在运行、锁存在/无法读取、清理未确认、缺失/损坏状态、身份错配、矛盾或不完整终态 | reconciling，保留资源占位，不自动重试/修复 |
| 已完成但业务入库中断 | 保留逐次回执及 reconciling，再读回执完成入库，不重复调用模型 |
| 结果此前已经入库，仅清理/回执待核对 | 保留已接受标记及原任务阶段，确认后恢复阶段，不重复执行验收副作用 |

恢复增加租约 fencing、当前 activeAttempt/generation 检查，避免旧停止回执唤醒新一代任务。重复收敛同一次执行不重复计入已经累计的运行时间。Codex 拒绝 thread/start/resume 返回不同模型，且不提交后续 turn。

本次续做补齐两个实际故障边界：完成回执已经提交、但适配器结果 Promise 在保存附加信息时失败，Engine 也必须读取回执，不能按普通异常再次调用模型；用户在本次执行最终清理尚未结束时请求刷新，则保留 recoveryRequested，等 live activation 移除后再处理。新增真实协议夹具与确定性生命周期测试覆盖两者，并分别验证旧 generation 和旧 activeAttemptId 的 completed/stopped 回执不能修改当前任务。

`task.reconcile` 的语义改为“请求重新读取回执”。旧的 `confirmedStopped` 勾选不能清空占位；界面移除该强制重派发流程，显示真实 recovery/cleanup 原因、最近可校验进度及“重新读取回执”操作。人工检查日志/工作副本可以帮助定位问题，但不能由一个布尔值伪装成进程树清理证据。

## #3 整合与发布兼容性

开发前已从 CONTRACT.inputArtifacts 对应的宿主只读 artifact blobs 逐一校验并完整覆盖 originalPath，未以基线版本冒充整合结果。ACMS 的 hash 算法是 `SHA256(bytes.toString('base64'))`，不是文件原始字节的 SHA256；首次按原始字节校验失败后，读取 `src/runtime/workspaces.js` 确认了算法，再按实际算法验证全部 14 文件。字节数也与协作快照一致。

原有 Windows Job Object、挂起启动后加入 Job、仅按本次容器所有权清理、清理有界与 quarantine/占位保护均保留。正式 runner 仍使用 `approvalPolicy: never` 和原工作区沙箱；Codex 的审批、writable_roots 与关闭 multi_agent 参数未放宽。

`scripts/host-bundle.mjs` 提供无现场副作用的打包函数，`deploy-live.mjs` 调用它。固定 C# 源码按原始字节 SHA256 命名为 `owned-job-<hash>.cs`，先复制到 bundle 同目录，再写 `host-<hash>.mjs`；编译时将该资源名作为常量纳入 bundle，运行时由 import.meta.url 定位。资源内容变化同时改变资源名和 host hash，旧 bundle 与旧 helper 可并存用于回滚。源码直接 import 时仍使用相邻 `owned-job.cs`。

新增 `test/bundled-cleanup.test.js` 使用与正式部署相同的 buildHost，先验证完整 host 包含匹配资源，再从没有相邻源码树的临时 dist 目录 import 打包后的 owned-process，实际启动三层 Node 进程及无关对照进程，验证取消、父先退出和自然退出竞态的清理。**这 4 项在本次沙箱中均因 esbuild 的目录读取权限受阻，尚未执行到真实打包产物烟测；必须由宿主补证。** 未运行 deploy-live，也没有借修改权限绕过错误。

非 Windows 仍在启动任何执行进程前明确返回 `PAIRED_CONTAINMENT_UNSUPPORTED`，无静默弱化方案。Windows 仍需系统 .NET Framework64 编译器、命名管道及 Job Object 能力。

## 实际验证

以下前次命令由检查点文档记录；本次最终重跑单独列在后面的“续做执行验证”表。历史通过数不替代最终检查。

所有测试文本均是明确标注的协议夹具或状态注入。本次未调用真实模型，未把 fake app-server 的回答称为模型证据。进程树测试和跨宿主测试确实运行 Node 进程；恢复测试分别启动新的宿主进程读取回执，并用调用计数确认没有再次执行协议夹具。崩溃测试使用真正退出的宿主，等待其自有进程消失，随后仍断言 unknown，证明“进程已死”不能代替缺失的清理回执。

| 本隔离副本实际命令 | 结果 |
| --- | --- |
| `node scripts/check.mjs` | 最终退出 0：Syntax and package contract checks passed |
| `git diff --check` | 最终退出 0 |
| `node --test --test-concurrency=1 test/paired.test.js test/paired-cleanup.test.js test/paired-conversations.test.js test/engine.test.js` | 当时 30/30 通过；包含 #3 真实终止路径和占位保护 |
| `node --test --test-concurrency=1 test/paired-recovery.test.js test/engine.test.js` | 当时 50/50 通过；随后新增已接受阶段恢复及计费回归，纳入最终全量 |
| `node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs` | 前次日志记录 204 项，200 通过、4 失败、0 跳过；4 项均为下述打包目录权限错误，退出 1 |
| `node --test --test-concurrency=1 test/bundled-cleanup.test.js` | 退出 1，0/4 通过；esbuild 报 `Cannot read directory "../../../..": Access is denied`，并无法解析入口文件 |
| `node scripts/build.mjs` | 退出 1；同样的 esbuild 目录权限错误，未生成新版客户端包 |
| `node --input-type=module -e "import fs from 'node:fs/promises';import {transform} from 'esbuild';await transform(await fs.readFile('src/client/app.jsx','utf8'),{loader:'jsx'});console.log('Updated JSX syntax transform passed');"` | 退出 0，修改后的 JSX 语法转换通过；不等同于完整客户端构建或视觉验收 |

开发过程中另发现进度字段包含 undefined 时，比较摘要与持久化 JSON 不一致，会产生自唤醒循环。已过滤未定义字段，相关 runner/Engine 测试随后通过。早期两次停滞的测试命令已中断，未当成通过结果。本轮未安装依赖，没有以 node_modules 是否存在代替产品验证；未处理所有者已登记的 #13。

### 续做执行验证（2026-11-07）

本次开始时重新执行旧检查点：静态检查通过，全量 204 项中 200 通过、4 项打包受阻，与旧记录一致。补充适配器入库异常测试后，一次全量出现第 5 个失败：清理期间的刷新请求被消费，等待恢复超时。随后修复请求处理竞态；新增的确定性生命周期夹具最初因未提供必需交付物失败，修正为合法 blocked 回执，未放松产品验收约束。这些中间失败不计为最终通过证据。

| 最终命令 | 本次实测结果 |
| --- | --- |
| `node scripts/check.mjs` | 退出 0，`Syntax and package contract checks passed.` |
| `git diff --check` | 退出 0 |
| `node --test --test-concurrency=1 --test-timeout=120000 test/paired-recovery.test.js test/engine.test.js` | 退出 0，58/58 通过，0 失败、0 跳过，8084.0445 ms |
| `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js packages/codex-runtime/test/*.test.mjs` | 退出 1，210 项中 206 通过、4 失败、0 取消、0 跳过，24627.965 ms。四项失败均在 `test/bundled-cleanup.test.js` 的 esbuild 构建阶段：`Cannot read directory "../../../..": Access is denied.`，未运行到打包后真实进程测试；其余 #2/#3 及原有核心测试通过 |

本任务未执行 `D:\ACMS\test-results\iteration-1\owner-check.mjs`，避免在隔离开发执行中把外部验收或现场写入当作已授权操作；由 ACMS 在交付验收中调用该既定检查，并由非作者审查其证据。未修改沙箱、目录权限或依赖策略。

宿主 owner check 和非作者独立审查必须对本次最终完整产物重新运行。尤其需要确认最终全量 Node 测试、完整 host bundle 及三项打包后真实树清理、客户端构建。不要只复用 #3 历史 160/160 或本沙箱中的源码 import 结果。

## 局限、后续问题和发布门槛

1. 缺失/损坏或旧版本无身份回执不能自动重建；宿主在清理与写入终态之间崩溃也会保守卡在 reconciling。这是避免重复执行的边界，当前没有人工勾选释放功能。后续需设计带可核验证据的修复/迁移流程，而不是删除锁或改数据库。
2. 逐次回执和 Codex 历史目前不自动回收，启动前扫描台账的成本随历史增长；后续需保留审计证据的归档/索引方案。
3. 手动 probe/chat 现在也持久记录逐次回执并阻止未知旧执行继续启动；它们没有 task attempt 的完整恢复展示/处置界面，仍需后续单独诊断入口。
4. 原子文件替换覆盖进程崩溃场景；未验证断电/文件系统损坏恢复，也不宣称是同用户恶意进程的安全隔离边界。
5. helper 的系统编译器/企业策略兼容性、真实模型端到端运行、现场无未知执行进程、完整 UI 视觉验收均未在本任务验证。沿用 #3 对非 Windows、旧失管进程、外部共享服务和崩溃临时文件的限制。
6. 新发现的待办仅记在交接：旧回执证据修复、台账归档、独立诊断恢复入口。未创建 GitHub issue；由外部负责人整理下一轮，#13 不扩入本轮。

外部发布负责人须在独立审查及宿主补证通过后，将两 issue 的完整改动放入同一个 PR 并关联 #2/#3，等待 Windows CI，执行现场备份及空闲核验后部署。部署时保留旧 host 和其匹配的 C# 资源、配置备份及回退路径；确认新 host 加载、基本功能和所有执行清理。**以上步骤本任务均未执行，不宣称升级已完成。**

## #3 输入整合清单

下表 hash 是本合同的 ACMS artifact hash。前次开发先按 originalPath 完整复制，再在其中五个源码及说明文档上增补 #2/发布兼容性。本次再次逐个读取源 blob 核验，14/14 匹配合同 hash。`owned-job.cs`、runtime store、两项 runtime #3 测试、两项顶层 #3 测试、两份进程夹具均与输入逐字节一致；其余源码保留 #3 实现并增补恢复或资源定位，本文及 #3 文档记载最终状态。

| originalPath | 输入 artifact hash |
| --- | --- |
| `src/runtime/owned-process.js` | `48068097fe546acb7e028b42fd1192b7f7ae9a51848c4c697c4666a1aab1c808` |
| `src/runtime/owned-job.cs` | `31dc125fb1e9f4a9791b302cdc0f3dec59fbc4df46d3a9a470842f6071a60427` |
| `src/adapters/paired.js` | `4af858d6f910db7cd01874e688d6a7a0f36eddaecc4302314d9f18430ebbe8f3` |
| `src/adapters/dsh.js` | `89dd4a901d0af0870884aadacf506b735b0e3ae7dd74ed055fbb9ebca4120765` |
| `src/runtime/engine.js` | `3c73f79636e698366411fd4c909b447365b56f5495fc5b2d50bfd75134ccc156` |
| `packages/codex-runtime/lib/index.js` | `05ecec0d2d7d284a70b524e710b3b2f9522a1bd9a89c2d0b1030e823d5dd419a` |
| `packages/codex-runtime/lib/store.js` | `c90e6e88d81437361c01ee0f8b9d0620d393cb30cbd2e4e093fdb0b4e936010c` |
| `packages/codex-runtime/test/lifecycle.test.mjs` | `e29ae6ca609bf4d28bc827268d1cc7c45a24d1a5e0526c862f2332f02390bc1d` |
| `packages/codex-runtime/test/store.test.mjs` | `ac184d7c5af06eaf340002eb04c01e5a5870ae2ab7283f071f9b5cf4350898ef` |
| `test/owned-process.test.js` | `d2e2561dedd909026cc2dd493bcb04e4c4ecb73e2caf60269bb02cdea4be2b78` |
| `test/paired-cleanup.test.js` | `379dbb5a9b4884530124bbf20585e70ea7a7b2221e49ddce8d05ffbfddfa8243` |
| `test/fixtures/owned-tree.mjs` | `7fddbecf5f3c3db1a187bab9683b664e770f2e93910ec9d7555a713a1d03cc0a` |
| `test/fixtures/owned-host.mjs` | `e6ffa33aec1ac0f87554577b2ec47fa568204efd82a38f0c74b7c9f1bc881459` |
| `docs/iteration-1-issue-3.md` | `30ab9fc2fb60414cdb64cd9ffe9100ab57e500fe32675bb45c0c601306875052` |

## 最终交付路径

以下文件均为完整内容，并逐一列入本次 artifacts；originalPath 与所列路径相同。不得只拿差异或单独拿 #2 文件合入。

- `src/runtime/execution-receipt.js`
- `src/runtime/owned-process.js`
- `src/runtime/owned-job.cs`
- `src/runtime/engine.js`
- `src/adapters/paired.js`
- `src/adapters/dsh.js`
- `src/core/domain.js`
- `src/core/task-actions.js`
- `src/client/app.jsx`
- `packages/codex-runtime/lib/index.js`
- `packages/codex-runtime/lib/store.js`
- `packages/codex-runtime/test/lifecycle.test.mjs`
- `packages/codex-runtime/test/store.test.mjs`
- `packages/codex-runtime/test/wire.test.mjs`
- `scripts/host-bundle.mjs`
- `scripts/deploy-live.mjs`
- `test/engine.test.js`
- `test/owned-process.test.js`
- `test/paired-cleanup.test.js`
- `test/paired-recovery.test.js`
- `test/recovery-boundaries.test.js`
- `test/bundled-cleanup.test.js`
- `test/fixtures/owned-tree.mjs`
- `test/fixtures/owned-host.mjs`
- `test/fixtures/recovery-host.mjs`
- `test/fixtures/recovery-runtime.mjs`
- `test/fixtures/blocked-accept-host.mjs`
- `docs/iteration-1-issue-2.md`
- `docs/iteration-1-issue-3.md`

不交付 `.acms`、临时日志、测试数据库、node_modules、编译 exe 或 dist 构建物。本任务未执行现场升级脚本；外部发布前需重新构建客户端与 host。
