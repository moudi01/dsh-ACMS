# 第 1 轮：#3 自有进程树清理交接

## 最新返工补录（2026-11-07）

最终执行为 `attempt_e8366081-e079-48e6-8f5d-71375ef84f12`。依据非作者审查 P1/P2，在保留 #3 清理约束及前次打包资源交付的基础上，修复 blocked 结果提交的崩溃窗口、无 live activation 的暂停/取消核对入口，以及结果已接受但尚在最终清理时的停止竞态。细节与完整 29 文件清单见 [#2 最新交接](iteration-1-issue-2.md)。

本次重新读取、核验 14 个 #3 输入 artifact 和前次 26 个交付 artifact；前次交付与返工前副本 26/26 逐字节一致。#3 原生助手、owned-process、paired、DSH、runtime 及其回归文件本次未改；Engine 在清理明确成功后才落实停止请求，未知执行仍占位且不可重派发。正式审批/沙箱参数、bundle 同目录内容寻址 C# helper、非 Windows 启动前错误保持原交付；未扩大权限、改动 #13 或执行升级。

最终实测：`node scripts/check.mjs`、`git diff --check` 均退出 0；`node --test --test-concurrency=1 --test-timeout=20000 test/recovery-boundaries.test.js` 为 21/21 通过；`node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js packages/codex-runtime/test/*.test.mjs` 为 227/231 通过，4 项打包测试因 esbuild 的 `Cannot read directory "../../../..": Access is denied.` 失败，0 取消/跳过，26466.9421 ms。源码真实进程树及注入失败测试均通过，打包后的真实进程树烟测本次仍须宿主补证。`node scripts/build.mjs` 同因目录权限失败，JSX transform 语法检查通过，不代表完整客户端构建。

CONTRACT.previousFeedback 中的宿主 210/210 和前版独立审查证据属于历史记录，不能用于宣告本次返工已通过独立审查。新交付仍须 ACMS owner check 和非作者复审；未创建 PR、合入或切换现场 host。下文保留前两次交接的历史原因、测试和局限，最新测试结果以本节为准。

## 前次整合补录（#2 执行，2026-11-07）

此文件由任务 `task_456ee225-f835-4168-a5ec-427dec292757` 的最终执行 `attempt_f7efe364-6ee3-46b7-b899-503a3bb1ccfe` 连同 #2/#3 全部改动交付。下文“原始 #3 交接记录”保留 #3 作者的历史证据；其中 160/160 是原 #3 版本数据，不能代替本次整合验收。协作快照记录 #3 后续独立审查已通过，本次新增改动仍须 ACMS 安排非作者重新审查。

已逐个重新读取并核验 CONTRACT 中 14 个 #3 artifact blobs；其 ACMS hash 全部匹配。原生 `owned-job.cs`、`packages/codex-runtime/lib/store.js`、原 #3 的四份测试和两份进程夹具逐字节保留。原 `owned-process.js` 只增补 helper 资源定位；paired、DSH、Engine 及 Codex index 在保留有限时清理、隔离状态、锁和占位约束基础上整合 #2。输入 hash 与最终 26 文件清单见 [#2 完整交接](iteration-1-issue-2.md)。

所有者要求的发布兼容性已落实到源码：`scripts/host-bundle.mjs` 将固定 C# helper 复制为 `dist/owned-job-<SHA256>.cs`，通过编译常量让 `host-<hash>.mjs` 使用自身 `import.meta.url` 定位同目录资源；`scripts/deploy-live.mjs` 使用该构建函数。资源先于 bundle 写入，历史 bundle 与匹配 helper 可以并存回滚。源码 import 仍定位相邻 `owned-job.cs`。正式 runner 的审批、沙箱设置保持原值，未安装插件、扩大模型权限或执行现场部署。非 Windows 仍在启动执行进程前明确报 `PAIRED_CONTAINMENT_UNSUPPORTED`。

`test/bundled-cleanup.test.js` 包含完整 host 资源发布验证，以及从隔离 dist 目录 import 构建产物后启动真实子孙进程的取消、父先退出和自然退出竞态用例。**本次沙箱中的四项均在 esbuild 构建阶段被目录读取权限拒绝，尚未获得打包后清理通过证据。** 必须由宿主 owner check 和 Windows CI 补证，不得用源码 import 测试替代。

最终实际命令及结果：

| 命令 | 结果 |
| --- | --- |
| `node scripts/check.mjs` | 退出 0，语法及包契约检查通过 |
| `git diff --check` | 退出 0 |
| `node --test --test-concurrency=1 --test-timeout=120000 test/paired-recovery.test.js test/engine.test.js` | 58/58 通过，0 失败、0 跳过 |
| `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.js packages/codex-runtime/test/*.test.mjs` | 退出 1，210 项中 206 通过、4 失败、0 取消、0 跳过，24627.965 ms；失败均为上述打包阶段的 `Cannot read directory "../../../..": Access is denied.` |

本次 #3 的真实进程树和注入失败回归全部通过；跨宿主完成回执恢复和真实宿主崩溃测试也通过，测试文字均明确属于协议夹具，并非模型执行证据。未绕过沙箱。宿主 owner check、最终合并产物独立审查、完整客户端构建、真实模型执行和现场验收均待外部流程执行。

原始局限第 5 点由 #2 部分补齐：probe/chat 现在也有独立持久回执，重启后的未知状态会阻止继续调用；诊断执行的专门恢复展示和可核验解除入口仍是后续工作。未知记录不得通过人工勾选、删除锁或修改数据库解除。其他平台、旧失管进程、外部服务、系统编译器兼容性及崩溃临时文件限制继续有效。新增候选问题与 #13 的范围界限见 #2 文档；没有创建 GitHub issue、PR、合入或升级。

## 原始 #3 交接记录

本文件交付开发实现和本隔离副本的验证结果。ACMS 的非作者独立审查、宿主 owner check、GitHub PR、CI、合入和现场升级均不由本开发任务宣告完成。

- 任务：`task_23e3280c-3a18-4568-bd06-410f3b9feee9`
- 执行：`attempt_99ce8c7e-bb58-4ea0-b3a6-207d3a1cd5df`
- 基线：`8d4b2b034c7387395bed61a328b4f64d367980e1`
- 平台：Windows x64，Node `v24.22.0`，日期 2026-11-07。
- 开始前解析 `.acms/context.json`，读取本任务和父规划任务的尝试、交接、依赖、产物以及 `.acms/shared.md`。快照无此前实现、依赖产物或阻塞材料；`changeNotifications`、`ownerConversation` 均为空。遵循当前合同，未修改协作输入、原始源目录、现场服务或公司配置。

## 原因与实现

旧 paired runner 依赖根进程的 `close` 回调结束清理；Windows `taskkill /T /F` 没有检查退出码，失败时仅 `child.kill()`。这既可能无限等待，也不能证明父进程退出后的后代已停止。仅枚举 PID 再杀进程还存在漏掉短寿命父进程和 PID 复用的风险。

新实现使用每次执行独立的 Windows Job Object。固定 C# 源码由系统 `.NET Framework64/v4.0.30319/csc.exe` 编译到随机临时目录，然后通过绝对路径启动。没有包安装、网络下载、PowerShell 脚本、shell 拼接或执行策略调整。编译结果只在当前宿主进程中缓存，正常宿主退出时删除。

原生助手先以 `CREATE_SUSPENDED` 创建根进程，成功加入 Job 后才 `ResumeThread`。Job 设置 `KILL_ON_JOB_CLOSE`，不允许 breakaway；启动只继承三个指定 stdio 句柄，Job 句柄不被子进程继承。根进程、子进程及更深后代的归属由内核维护。退出/取消时调用 `TerminateJobObject`，查询 `ActiveProcesses == 0`，通过独立命名管道回报结果。Node 同时要求助手退出，才能返回已确认清理。父进程退出不会丢失 Job 身份。未成功分配 Job 的根进程始终挂起，只通过原始进程句柄终止并等待退出。

模型的 stdout 不承载清理回执；控制管道在模型启动前连接。root PID 仅用于诊断，生产终止逻辑不按 PID 查找/杀进程，也不调用 `taskkill`。因此 `taskkill` 缺失、失败、超时均不再是依赖路径。测试明确断言它从未被调用；对当前原生终止/验证/回执边界另做失败注入，未把这些注入称作实际操作系统拒绝访问证据。

取消、执行超时、2 MiB stdout 上限、启动错误、正常退出统一经过清理。原生助手还监听宿主控制管道断开，并有独立运行期限。清理失败、回执丢失或验证超时均返回 `PAIRED_CLEANUP_UNCONFIRMED` / `cleanupUncertain: true`，保留原因及可用的 `ownershipId`、`rootPid`。助手句柄终止是最后的容器释放手段，其返回成功不会被当成清理证据。

默认期限：编译 10 秒，编译失败后额外最多 1 秒等编译器退出；助手启动 10 秒；清理判断 5 秒（原生 Job 查询预留在其中，默认 4.5 秒）。取消发生在首次编译期间时先完成这段有界准备，再检查取消，不启动模型。runner 的执行期限沿用原 probe 40 秒 / 公司 `turnTimeoutMs`。Codex 保留原 60 秒协议启动期限和公司轮次期限；进程清理、结果收敛等待均有界，paired 外层 dispose 默认 6 秒封顶。线程索引发布沿用原有最多 10 秒锁等待；发布失败不会被描述为清理成功。

## 占位和恢复约束

- `PairedRuntimes.running` 保留不确定执行及诊断，禁止同一模型继续启动和删除该配置。返回结果前完成清理，不让后续审查先于清理开始。
- Codex runtime 支持异步受管启动；取消、启动异常、waitForExit 返回 false/拒绝/不响应都保留清理错误。成功结果不会抵消清理失败。
- `ThreadStore.quarantine()` 将 `status: reconciling`、`cleanupPending: true` 和原因写入 summary，并保留租约。即使后来宿主租约失效，构造新 ThreadStore 仍检查持久隔离状态，禁止自动重用。`close()` 不会覆盖隔离状态或释放其租约。
- Engine 捕获尚未返回 activation 的启动清理错误，避免 `finally` 因缺少 dispose 而清掉占位；保存 attempt 的 `cleanupPending`、`cleanupUncertain`、`cleanupError`、`cleanupDetails`，任务进入 `reconciling`，不自动重试/修复。调度额外检查该 task 是否仍有活跃或清理中的 attempt，即使任务被换人或改成 ready，也不能绕过占位。
- 恢复未知执行时保留 `cleanupPending`。对已有 `cleanupUncertain` 的 attempt，只有适配器提供明确 `cleanupConfirmed: true` 才能接受 completed/stopped 结论；否则保留原原因及 reconciling。普通“根进程停止”回执不足以释放。
- 不确定的手动模型检测保留 `activeProbes` 容量，避免该入口在失败后提前释放资源。

后继 #2 必须保留以上约束，再实现真实运行 key、provider/model/attempt/context/generation 身份校验和恢复结果。此任务没有实现 #2 的完整进度恢复协议，也没有自行清除旧 quarantine 或添加数据库迁移。人工核对后的解除流程需与 #2/后续管理入口一致；当前对已不确定的记录采取保守保持，不能靠重启或仅删除锁文件宣称清理完成。

## 验证证据

以下命令均在本隔离副本执行，使用 Node 内置测试，没有调用真实模型。已有 fake app-server 和新增故障注入只验证协议/资源生命周期；新增进程树用例确实启动了 Node 子进程、孙进程、无关对照进程和可被终止的独立宿主。每个树成员有 8 秒安全寿命；用例结束断言其自有进程退出，测试不会按裸 PID 终止进程。

| 实际命令 | 结果 |
| --- | --- |
| `node scripts/check.mjs` | 最终执行退出码 0：`Syntax and package contract checks passed.` |
| `git diff --check` | 最终执行退出码 0，无空白错误 |
| `node --test --test-concurrency=1 test/owned-process.test.js test/paired.test.js` | 当时 22/22 通过，0 跳过；随后另增真实宿主崩溃测试并纳入最终全量 |
| `node --test --test-concurrency=1 test/paired-cleanup.test.js packages/codex-runtime/test/store.test.mjs` | 17/17 通过，0 跳过 |
| `node --test --test-concurrency=1 packages/codex-runtime/test/lifecycle.test.mjs` | 最终 11/11 通过，0 跳过 |
| `node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs` | 最终退出码 0，160/160 通过，0 失败、0 取消、0 跳过，20464.5101 ms；此前 153/153、159/159 亦通过 |

覆盖：真实子孙/脱离终端子进程、父先退出、自然退出与取消竞态、无关进程存活、CreateProcess 失败、宿主突然退出；取消/超时/响应过大；终止拒绝、查询拒绝、验证超时、缺少回执、助手非零退出、助手不退出；无 activation 的启动错误、结果完成后的清理错误、租约保留、跨 Engine 重启保持占位、重复派发/自动修复阻断、检测容量保留。

开发中真实受阻项和修正：

1. 最早的 `node --test --test-concurrency=1 test/paired.test.js packages/codex-runtime/test/lifecycle.test.mjs` 因 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-subagent` 退出 1，0/2 通过。后续执行时该环境依赖已可解析，全量和 Codex 专项均实际通过。本任务未执行安装命令。runner 改为按需加载 Codex runtime，使普通 runner 路径不因未用到的 Codex 包而加载失败。
2. 已丢弃的 PowerShell 助手原型通过 `powershell.exe -NoProfile -NonInteractive -File .../owned-job.ps1` 启动时，被本机脚本策略拒绝（`UnauthorizedAccess`）。该路径未通过，不在交付中；没有修改策略或添加 Bypass。最终交付为直接编译/启动的原生 C# 助手，并经上述真实进程测试验证。
3. 原型同步命名管道读导致监督循环阻塞，调试运行被终止；最终原生助手使用 `PipeOptions.Asynchronous`，自然退出及宿主崩溃测试通过。
4. 只读全局检查 `Get-CimInstance Win32_Process -Filter "Name='owned-job.exe'"` 被沙箱拒绝（`0x80041003`）。未提升权限；没有把本任务的自有进程测试当成“现场全宿主无未知进程”的证明。该现场发布门槛仍需外部负责人核查。

## 局限与后续问题

1. 当前保证仅覆盖 Windows；非 Windows 在启动任何执行进程前返回 `PAIRED_CONTAINMENT_UNSUPPORTED`，不沿用无法证明整树退出的 process-group 兜底。仓库现有已验证平台和 CI 均为 Windows。其他平台需要等价内核容器方案后开放。
2. 需要可用的 Windows .NET Framework64 C# 编译器、命名管道和 Job Object API。编译器缺失、权限拒绝或 Job 嵌套不被宿主允许时安全失败，不降级为裸 PID 终止。未在真实 Codex 模型/工具沙箱、企业受限宿主或所有 Windows 版本运行生产验收。
3. Job 保护由本次进程创建的后代，不能追溯旧版本已脱离管理的执行，也不能停止外部共享服务代为发起的工作。新增能力不等同于恶意同用户进程的安全边界；模型自身权限策略保持不变。
4. 宿主强制退出可能留下已编译助手的临时文件；正常退出清理缓存。后续可评估受控构建/签名和临时文件回收，不能因此自动清除未知执行占位。
5. 手动 probe 的 quarantine 当前有内存占位，尚无跨宿主的独立持久恢复记录；后续应补充身份化诊断执行台账及核对解除入口。任务 attempt 和 Codex summary 的隔离状态已经持久化。
6. 人工确认旧执行停止后，适配器内存 quarantine 与线程持久 quarantine 的一致解除需要专门操作及证据设计；当前拒绝自动解除。#2 恢复开发必须明确区分可信清理回执和人工确认，不能串用结果。

以上第 1、4、5、6 点是候选下一轮 issue，本任务仅记录，未在 GitHub 创建 issue。

## 完整文件交接清单

所有下列文件均交付最终完整内容，`originalPath` 等于下列相对路径。后继任务必须从 `CONTRACT.inputArtifacts` 逐个覆盖到自己的隔离副本，依赖关系不会自动合并代码。不要仅拿文档或 patch 代替源码，不要交付 `.acms`、依赖目录、生成 exe、数据库或临时日志。

| originalPath | 用途 |
| --- | --- |
| `src/runtime/owned-process.js` | 有限时助手启动、原生编译、控制回执和清理验证 |
| `src/runtime/owned-job.cs` | Windows 私有 Job Object 原生助手 |
| `src/adapters/paired.js` | runner/Codex 共用受管进程清理和 quarantine |
| `src/adapters/dsh.js` | 检测失败后的容量保留 |
| `src/runtime/engine.js` | 启动错误、恢复、资源占位和重复派发阻断 |
| `packages/codex-runtime/lib/index.js` | Codex 启动/退出期限和失败传播 |
| `packages/codex-runtime/lib/store.js` | 线程持久 quarantine 和租约保护 |
| `packages/codex-runtime/test/lifecycle.test.mjs` | Codex 生命周期及失败注入回归 |
| `packages/codex-runtime/test/store.test.mjs` | 持久隔离记录回归 |
| `test/owned-process.test.js` | 真实进程树、宿主退出和控制协议故障回归 |
| `test/paired-cleanup.test.js` | 终止路径、容量、Engine 重启和调度断言 |
| `test/fixtures/owned-tree.mjs` | 真实三层进程树辅助程序 |
| `test/fixtures/owned-host.mjs` | 可被终止的真实宿主辅助程序 |
| `docs/iteration-1-issue-3.md` | 本交接及验证记录 |

默认独立审查应由 ACMS 安排非作者执行，核查这些完整文件及其边界测试，并补充合同中的宿主 `iteration-1-owner-check` 证据。本开发执行未调度子代理、未自称独立审查、未执行该外部 owner check。发布检查清单与现场操作由既定外部负责人处理。
