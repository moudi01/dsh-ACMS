# #5 测试与证据日志

记录时间：2026-11-07。attempt：attempt_e57d57b7-d95a-46eb-b07c-8ee1f350a4cd。基线：178987ad4337a499f925d4377de44a3b5f11d550。

## 本轮返工背景

上一交付经独立审查复现 3 个功能缺陷（详情读取与启动参数不一致；要求的思考深度未写入选择；未知思考深度被放行）。本轮修复后，两个源码文件临时还原到上一交付版本时，6 项新回归测试失败、退出 1（regression-red.txt）；恢复修复版本后目标测试全部通过。

同时修复上一交付的 3 个 Markdown 文件文本损坏（空行曾被写成空格加两个 at 字符），并全文扫描确认无残留。本日志与全部证据日志均以 UTF-8 重新生成，对应当前版本。

## 全量回归

命令：node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs

结果：260 项通过、0 失败、0 跳过、0 取消，退出码 0，duration_ms 30312.1383。原始输出见 full-test.txt。

## 目标测试

命令：node --test test/model-selection.test.js test/model-preferences.test.js test/models.test.js

结果：39 项通过、0 失败，退出码 0，duration_ms 283.3493。原始输出见 targeted-tests.txt。新增回归覆盖：

- 任务要求模型 m2 时，详情读取、选择记录与启动参数都使用 m2 及其默认 max 深度。
- 显式绑定加任务 reasoningEffort max 时，选择结果与启动参数都是 max，而不是候选默认 low。
- 外部配对声明深度未知时，显式深度约束在选择阶段返回 capability_unknown 并阻塞；有可用偏好时也不会替换，不调用外部执行器。
- 内部入口目录深度未知但模型详情只支持 low 时，在启动前转为 model-selection 阻塞，不调用 startActivation。

## 静态检查与构建

node scripts/check.mjs：通过，退出码 0（static-check.txt）。

node scripts/build.mjs：生成 lib/client.js（205400 bytes），退出码 0（build.txt）。

## 界面验收

node scripts/model-preferences-ui-test.mjs：退出码 0。偏好添加、上移、标签、保存、清除通过；保存后 revision 为 1，清除后 revision 为 2 且 order 为空；打开、保存和清除期间 model-check 与 model-details 请求数为 0；执行记录显示「用户偏好第 1 项」、模型通道和回退原因。报告见 ui-report.json，原始输出见 ui-run.txt。

node scripts/structure-test.mjs：退出码 0，层级、导航、回收站、模型配对、仅手动检测、内部父上下文通过（ui-structure.txt）。

node scripts/ui-test.mjs：退出码 0，真实 DSH client loader bundle、仪表盘、依赖图、工作流、模型选择、诊断、删除恢复、阻塞回复、暗色、390px、Esc 通过（ui-regression.txt）。

node scripts/usability-test.mjs：退出码 0，首个目标、原生选择器、目录浏览、真实剪贴板粘贴、禁用操作说明通过（usability.txt）。

截图：docs/images/model-preferences.png、docs/images/model-selection-evidence.png（本轮重新生成）。

## 已知非本任务回归

node scripts/empty-models-test.mjs 初始退出码 1：脚本在打开「配对外部 agent」弹窗后直接点击「组织管理」，被原生 dialog 拦截并超时（scripts/empty-models-test.mjs:18）。最终候选已核实根因是测试脚本未先关闭弹窗，弹窗拦截是预期界面行为；补上关闭步骤后同一无模型目录检查通过（配对可用、未绑定模型角色不可保存、无自动检测请求）。失败原始输出保留在 empty-models-known-failure.txt，修复后输出见 test-results/iteration-2-final/empty-models-green.log。

指定 owner check（D:/ACMS/test-results/iteration-1/owner-check.mjs）未在本工作副本执行；此前记录显示 231 项中有 4 项因 esbuild 读取父目录被环境拒绝而失败。本任务不使用该检查替代全量测试与界面检查，发布任务需在宿主独立复核。

## 未宣称完成

本日志只证明隔离工作副本的源码、测试和界面证据。GitHub PR、CI、main 合入、当前 ACMS 备份升级、实际加载版本、旧进程清理和发布后 agent 接口验收尚未执行，由发布任务负责，不在本次交付中宣称完成。

## 本轮复验（2026-11-07，attempt_b5ea0fa6）

- 修复：11 处测试临时目录清理追加 maxRetries: 25, retryDelay: 100，消除 Windows EBUSY 抖动导致的 owner check 失败。注意 Node 24.22 的重试等待为线性递增：1..25 次累计约 32.5 秒（不含 I/O），不是每轮固定 100ms 的 2.5 秒。
- owner-check.mjs 连续两次退出 0（owner-check-1.txt、owner-check-2.txt）。
- 全套件 260 通过 / 0 失败（full-test.txt）；目标测试 39 通过 / 0 失败（targeted-tests.txt）。
- 静态检查、构建、偏好界面、结构、界面回归与可用性脚本均退出 0；构建前后 lib/client.js 哈希一致。
- 未调用真实模型：偏好界面脚本对 model-check/model-details 请求计数为 0。


## 本轮复验（2026-11-07，attempt_b6396732，P1/P2 返工）

独立复审复现两项缺陷：routeDetails 丢弃已选 model/llmProvider 并跨路由复用详情缓存；同模型多入口时偏好授权回退原因记为 route_mismatch。修复后：

- 红测：恢复上一交付源码，2 项新测试失败、退出 1；实际为 m2 的 low 深度与 route_mismatch（regression-p1p2-red.txt）。
- 绿测：修复后 2 项通过、退出 0（route-consistency-tests.txt）；目标测试 41 项通过、退出 0（targeted-tests.txt）。
- 全量：262 项通过 / 0 失败，退出 0（full-test.txt）。
- 静态检查、构建、偏好界面、结构、界面回归、可用性均退出 0；构建后 lib/client.js 哈希仍为 82514F23C20CF2FE93C5610461EFB6594A25BA97630AFB515A91DBC3CC91C5AC（build.txt）。
- 指定 owner check 连续两次退出 0，各 262 项通过（owner-check-1.txt、owner-check-2.txt）。
- 未调用真实模型；偏好界面脚本 model-check/model-details 请求计数为 0。

## 本轮返工：chat 选路一致性（attempt_27d934ff）

- 红测：临时恢复上一版本 src/adapters/dsh.js，node --test test/issue5-chat-route.test.js 退出 1，实际读取 deepseek/m2（chat-route-red.txt）。
- 绿测：修复后同一测试退出 0；目标测试 48 项通过、0 失败（chat-route-targeted.txt）。
- 全量：263 项通过、0 失败，退出 0（chat-route-full.txt）。
- 静态检查、构建、偏好界面、结构、界面回归、可用性均退出 0；owner check 连续两次退出 0，各 263 项通过（chat-route-*.txt）。
- 未调用真实模型；偏好界面 diagnostics 为空。

