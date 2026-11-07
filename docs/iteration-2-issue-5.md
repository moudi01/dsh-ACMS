# #5 交付说明：有序模型倾向与可解释自动选择

- 目标：goal_a50f7722-7856-4f98-a303-2a8c17af36bc
- 任务：task_bec5ae18-2b18-4f35-a791-f52d0542903e
- 本次 attempt：attempt_b5ea0fa6-cb17-4156-a035-d5fee52c8106
- 基线：178987ad4337a499f925d4377de44a3b5f11d550（main）
- 工作分支：acms/task_bec5ae18-2b18-4f35-a791-f52d0542903e
- 工作区：隔离工作副本；未修改源项目 D:/ACMS、运行数据库、认证或 ACMS 元数据

## 实现范围

| 文件 | 变更 |
| --- | --- |
| src/core/model-selection.js | 偏好校验、候选能力模型、选择算法、回退原因、阻塞码、选择结果中的思考深度 |
| src/core/domain.js | model.preferences.set/clear 命令、owner/system 边界、审计事件、快照暴露、任务 requirements |
| src/adapters/dsh.js | provider 能力来源与未知值；select、modelContext、providerFor；routeDetails 按已选路由读取详情；start 使用同一选路结果并持久化 attempt.selection |
| src/runtime/engine.js | 负责人合同注入 modelContext；无候选选择阻塞且不自动重试；计划任务传递 requirements |
| src/runtime/prompt.js | 负责人合同返回只读 modelContext，并说明显式绑定与偏好边界 |
| src/client/model-picker.jsx | 模型偏好区域：添加、上移、下移、标签、保存、清除；显示默认行为说明 |
| src/client/app.jsx | 执行记录显示模型通道、选择依据、回退原因和候选阻塞码 |
| src/client/style.css | 偏好列表样式 |
| src/host/http.js | agent.save 不再预跑模型选择或详情读取；不可用的显式绑定在任务启动时按规则阻塞 |
| test/model-preferences.test.js | 持久化、排序、清除、幂等、校验、owner/system 边界、上下文隔离 |
| test/model-selection.test.js | 选择算法、adapter、负责人合同、引擎阻塞；新增要求深度与未知深度回归 |
| test/models.test.js | 详情与启动参数一致、显式绑定深度传递、未知外部深度阻塞、内部深度不支持阻塞 |
| scripts/model-preferences-ui-test.mjs | 界面验收脚本与截图 |
| docs/model-preferences.md | 用户文档、优先级、深度一致性、回退与迁移说明 |

## 本轮返工（审查独立复现的 3 个缺陷）

| 缺陷 | 根因 | 修复与回归 |
| --- | --- | --- |
| P1：详情读取、选择记录和启动参数可能不一致 | start 使用原角色再次执行选择来决定详情深度，丢失任务选路约束 | 新增 routeDetails(route)，只按已选路由读取详情；start 用同一结果写 attempt.selection、attempt.reasoningEffort 与 agentOptions。回归：models.test.js 的任务要求 m2 场景。 |
| P2：要求的思考深度未写入最终选择 | chosen.reasoningEffort 固定取候选默认深度 | 新增 selectedEffort，显式绑定或任务要求深度优先写入 chosen，并沿用到启动参数。回归：models.test.js 的显式绑定加 requirements 深度场景。 |
| P2：未知思考深度被放行 | 深度未知时 known 为 false，显式深度约束被跳过 | 外部入口未知深度返回 capability_unknown，选择阶段阻塞；内部入口在启动前用模型详情校验，不支持时转为 model-selection 阻塞，不启动模型、不被偏好替换。回归：model-selection.test.js 与 models.test.js 的未知深度场景。 |

修复前后对照：把两个源码文件临时还原到上一交付版本后，本轮 6 项新测试全部失败、退出 1（regression-red.txt）；恢复修复版本后，同一目标测试 39 项全部通过、退出 0（targeted-tests.txt）。

同时修复上一交付的文本损坏：3 个 Markdown 文件的空行曾被写成「空格加两个 at 字符」，导致部分段落不可读；本次已恢复为正常空行并全文扫描确认无残留，证据日志改为 UTF-8 重新生成。

## 契约落实

- 有序偏好持久化在 modelPreferences 单例；空数组表示清除但保留记录；revision 递增；重启后顺序保留。
- 显式绑定优先；显式绑定不可用时 blocked.code 为 EXPLICIT_BINDING_UNAVAILABLE，chosen 为 null，不使用偏好替代。
- 授权、硬能力和健康状态先于偏好过滤；偏好不能把未授权候选变成合格。
- 同一模型多入口由 provider/llmProvider 条目过滤；未指定时保留稳定入口顺序。
- chosen.reasoningEffort 记录实际使用的深度；详情读取、attempt.selection、attempt.reasoningEffort 与启动参数一致。
- 未知能力保持未知：外部未知深度不满足显式约束；内部深度在启动前解析校验；不伪造续接能力。
- 回退原因是封闭枚举；无合格候选阻塞并创建待处理问题，不自动重试。
- 选择结果持久化到 attempt.selection，并发出 attempt.route.selected 事件；界面可读。
- 设置、查看、排序、保存、清除都不调用模型检测；agent.save 预校验不再触发 modelDetails。
- 任务与审查 contextKey 包含角色；测试验证作者与审查 attempt 的 contextKey 不同。

## 验证记录

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs | 260 项通过，0 失败，退出 0 | full-test.txt |
| node --test test/model-selection.test.js test/model-preferences.test.js test/models.test.js | 39 项通过，0 失败，退出 0 | targeted-tests.txt |
| node scripts/check.mjs | 通过，退出 0 | static-check.txt |
| node scripts/build.mjs | 生成 lib/client.js（205400 bytes），退出 0 | build.txt |
| node scripts/model-preferences-ui-test.mjs | 退出 0；偏好增删改序与选择依据展示通过；无检测请求 | ui-run.txt、ui-report.json、docs/images 截图 |
| node scripts/structure-test.mjs | 退出 0 | ui-structure.txt |
| node scripts/ui-test.mjs | 退出 0 | ui-regression.txt |
| node scripts/usability-test.mjs | 退出 0 | usability.txt |

## 已知失败与环境说明

- node scripts/empty-models-test.mjs 初始退出 1：脚本打开「配对外部 agent」弹窗后直接点击「组织管理」，被已打开的原生 dialog 拦截并超时（scripts/empty-models-test.mjs:18）。最终候选核实：根因是测试脚本未先关闭弹窗；弹窗拦截下层导航是预期界面行为，不是模型/配对功能缺陷。脚本补上「关闭配对」并用 toHaveCount(0) 确认关闭后，在无模型目录下通过两项界面结论：配对入口可用、未绑定模型的角色禁止保存；无页面错误，无自动 model-check/model-details 请求。失败原始输出保留在 empty-models-known-failure.txt，修复后输出在 test-results/iteration-2-final/empty-models-green.log。
- 指定 owner check（D:/ACMS/test-results/iteration-1/owner-check.mjs）未在本副本执行；本任务不以它替代全量测试与界面检查，发布任务需在宿主独立复核。
- 界面证据来自隔离 preview harness 与真实 DSH client bundle；没有调用真实模型，没有发送 model-check 或 model-details 请求。

## 发布边界

本次只交付可合入源码、测试、文档和隔离环境证据。GitHub PR、CI、main 合入、当前 ACMS 备份升级、真实加载版本、旧进程清理和发布后 agent 接口验收仍由发布任务按授权执行；本文件不宣称这些动作已经完成。

## 迁移兼容

旧数据库没有 modelPreferences 记录时按空偏好处理，行为与基线默认一致，无需 schema 迁移。旧 attempt 没有 selection 字段，或 selection 中没有新增的深度信息时，界面按未记录处理，不重算旧记录。任务新增 requirements 字段对旧任务默认为无硬要求。重启后偏好顺序与 revision 保留。

## 证据索引

- validation.json：执行命令、退出码、测试计数、交付文件清单与已知限制。
- SHA256SUMS：交付文件的 SHA256(fileBytes) 清单（不含清单自身）。
- full-test.txt、targeted-tests.txt、regression-red.txt、static-check.txt、build.txt、ui-run.txt、ui-report.json、ui-structure.txt、ui-regression.txt、usability.txt、empty-models-known-failure.txt：原始输出或结构化报告。
- docs/images/model-preferences.png、docs/images/model-selection-evidence.png：受影响界面截图。

## 本轮返工：owner check 失败根因与修复（attempt_b5ea0fa6）

### 失败证据（上一次 attempt_e57d57b7）

- ACMS 验收记录 verification_103aab99-fc22-4d7c-9cfd-b600756ac208（2026-11-07T09:05:01Z）判定 passed=false、code=1。
- 原始输出：`✖ abrupt host exit closes the control pipe and reaps the real owned tree`，错误为 `EBUSY: resource busy or locked, rmdir 'C:\Users\Administrator\AppData\Local\Temp\acms-owned-crash-G3Y83q'`，发生在 test/owned-process.test.js:68 的 teardown。
- 该失败与 #5 的偏好与选路功能无关：同一提交在 09:03 的本地全套件为 260/260 通过，属 Windows 临时目录删除的时序抖动。

### 根因与修复

- 根因：进程树被终止后，Windows 仍需短暂时间释放目录与文件句柄；`fs.rm(..., { recursive: true, force: true })` 默认 `maxRetries: 0`，首次 `rmdir` 遇到 EBUSY 立即抛错，使整套 owner check 退出 1。
- 修复：测试中删除临时目录的 11 处调用统一追加 `maxRetries: 25, retryDelay: 100`（Node 24.22 的 fs.rm 每次重试按 retryDelay × retry 线性递增等待，1..25 次累计 100×(25×26/2)=32500ms≈32.5 秒，不含 I/O；实测 maxRetries=5/retryDelay=20 为 342ms、maxRetries=10/retryDelay=20 为 1165ms，与线性模型一致。32.5 秒是上限而非通常耗时）。涉及 test/owned-process.test.js、test/helpers.js、test/bundled-cleanup.test.js、test/model-preferences.test.js、packages/codex-runtime/test/lifecycle.test.mjs、store.test.mjs、wire.test.mjs。
- 未修改生产代码语义，未放宽任何断言，只让清理对 Windows 句柄释放延迟具备确定性。

### 本轮复验（真实运行）

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| D:/ACMS/test-results/iteration-1/owner-check.mjs（第 1 次） | 退出 0 | owner-check-1.txt |
| D:/ACMS/test-results/iteration-1/owner-check.mjs（第 2 次） | 退出 0 | owner-check-2.txt |
| node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs | 260 通过 / 0 失败，退出 0 | full-test.txt |
| node --test test/model-selection.test.js test/model-preferences.test.js test/models.test.js | 39 通过 / 0 失败，退出 0 | targeted-tests.txt |
| node scripts/check.mjs | 通过，退出 0 | static-check.txt |
| node scripts/model-preferences-ui-test.mjs | 退出 0；偏好增删改序与选择依据通过；无 model-check/model-details 请求 | ui-run.txt、ui-report.json |

lib/client.js 运行前后 SHA256 均为 82514F23C20CF2FE93C5610461EFB6594A25BA97630AFB515A91DBC3CC91C5AC，界面检查未重建或覆盖交付 bundle。

### 边界

- 以上仅为隔离工作副本内的复验结果；GitHub PR、CI、合入 main、现场备份升级、旧进程清理与发布后 agent 接口验收尚未执行，由发布任务在授权内完成，本轮不宣称。


## 本轮返工：独立审查 P1/P2（attempt_b6396732）

独立复审在 2026-11-07 复现两项交付缺陷；本轮在隔离副本修复并补充回归。

| 缺陷 | 根因 | 修复与回归 |
| --- | --- | --- |
| P1：详情读取丢弃已选路由 | routeDetails 用 providers() 注册信息重新取 provider.model/llmProvider，内部入口 model 为 null；缓存键不含模型，切换模型后复用旧详情 | routeDetails 只按传入的已选路由读取 model/llmProvider，缓存键包含 provider/llmProvider/model；新增 test/issue5-route-consistency.test.js，断言 resolveModelInfo 实际收到 deepseek/m1 与 deepseek/m2、同路由复用缓存，任务要求 m2 时以 m2/max 启动并持久化 |
| P2：偏好授权回退原因错误 | 仅当模型完全不存在时才检查偏好条目的授权，同模型由其他入口提供时被记为 route_mismatch | 回退分类改为 unauthorized_model → unauthorized_provider → preference_model_absent → route_mismatch；新增同模型多入口用例：allowedProviders=[spawn]、偏好 fork/m1、spawn 提供 m1 时回退到 spawn 且原因记录 unauthorized_provider |

修复前后对照：恢复上一交付源码后运行新测试，2 项失败、退出 1，实际值为 m2 的 low 深度与 route_mismatch（regression-p1p2-red.txt）；恢复修复后同一测试 2 项通过、退出 0（route-consistency-tests.txt）。

本轮复验：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs | 262 通过 / 0 失败，退出 0 | full-test.txt |
| node --test test/model-selection.test.js test/model-preferences.test.js test/models.test.js test/issue5-route-consistency.test.js | 41 通过 / 0 失败，退出 0 | targeted-tests.txt |
| node scripts/check.mjs | 通过，退出 0 | static-check.txt |
| node scripts/build.mjs | 退出 0；lib/client.js 哈希不变 | build.txt |
| node scripts/model-preferences-ui-test.mjs | 退出 0；无 model-check/model-details 请求 | ui-run.txt、ui-report.json、截图 |
| node scripts/structure-test.mjs / ui-test.mjs / usability-test.mjs | 均退出 0 | ui-structure.txt、ui-regression.txt、usability.txt |
| D:/ACMS/test-results/iteration-1/owner-check.mjs（2 次） | 均退出 0，262 项通过 | owner-check-1.txt、owner-check-2.txt |

边界不变：本文件只证明隔离副本源码、测试、文档与界面证据；PR、CI、合入 main、现场备份升级与发布后 agent 接口验收由后续发布任务执行，本轮不宣称。

## 本轮返工：chat 选路与详情不一致（attempt_27d934ff）

### 原始审查记录（不当作通过）

- 审查任务 task_d39b122b-6830-4d47-9290-c8de248324a8 因 owner 误触界面被取消；取消不是负责人决定，也不是审查通过，原发现继续有效。
- 独立复现（隔离夹具，真实模型调用 0）：偏好 m2 在可用性检查中不可用后，chat 先选出 m1/low，随后又调用 modelDetails(agent) 以 ignoreHealth 重新选中 m2 并读取 m2 的 max 详情，最终向 m1 传入 max。选择记录与实际调用不一致。
- 审查环境另受沙箱限制：model-preferences-ui-test.mjs 的 esbuild 读取父目录报 Access is denied；owner 提供的受信宿主界面证据只补充该环境证据，不豁免本缺陷，也不覆盖后续修订版本。

### 根因与修复

- 根因：src/adapters/dsh.js 的 chat 入口先用 choose(agent) 取得 provider，再用 modelDetails(agent) 第二次执行选择；第二次选择允许忽略健康状态，可能落到另一条路由。
- 修复：chat 只执行一次 select(agent)，用 providerFor(selection) 固定实际 provider/model/llmProvider，再用 routeDetails(同一已选路由 + selection.chosen.reasoningEffort) 读取详情。
- 思考深度不支持时，chat 与 start 使用同一选择阻塞错误；不会静默改用另一条路由或另一个深度。
- 新增 test/issue5-chat-route.test.js：固定 spawn/m2 偏好并标记其不可用，断言只读取 m1 详情，实际调用为 m1/low。

### 红绿与回归证据

- 红：仅将 src/adapters/dsh.js 临时恢复为上一版本，保留新测试运行 node --test test/issue5-chat-route.test.js，退出 1；实际读取 deepseek/m2，期望 deepseek/m1（chat-route-red.txt）。
- 绿：修复后同一测试退出 0；目标测试 48 项通过、0 失败（chat-route-targeted.txt）。
- 全量：263 项通过、0 失败，退出 0（chat-route-full.txt）。
- 静态检查、构建、偏好界面、结构、界面回归、可用性均退出 0；构建后 lib/client.js 哈希不变（chat-route-static.txt、chat-route-build.txt、chat-route-ui.txt、chat-route-ui-report.json、chat-route-structure.txt、chat-route-ui-regression.txt、chat-route-usability.txt）。
- 指定 owner check 连续两次退出 0，各 263 项通过（chat-route-owner-check-1.txt、chat-route-owner-check-2.txt）。
- 偏好界面检查 diagnostics 为 0，未调用真实模型；截图更新为 docs/images/model-preferences.png 与 docs/images/model-selection-evidence.png。

