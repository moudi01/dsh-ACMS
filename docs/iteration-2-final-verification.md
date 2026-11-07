# 最终候选验证摘要（task_5f526a54）

> 本文件汇总最终候选（v8）在本隔离工作副本的实测结果；PR、CI、合入、升级与真实宿主验收仍未发生。本文不是独立审查。

## 快照

- 本修订版 attempt：attempt_2d0b21af-7b07-4f30-a89f-0a2bb506b498（v8，修复非作者审查 attempt_2222a18b 复现的两项 P2；上一版 v7 为 attempt_c350a352-92ca-49e6-8c09-eac3c555d389）
- 基线：main 178987ad4337a499f925d4377de44a3b5f11d550
- 分支：acms/task_5f526a54-6871-4fe7-9425-c43c0b3b1bde
- 环境：Windows 10 19041 x64；Node v24.22.0；npm 11.19.1；Chrome + Playwright 1.56.1
- 候选文件：docs/iteration-2-final-files.json；校验和：docs/iteration-2-final-SHA256SUMS
- 原始日志：test-results/iteration-2-final-v9/

## 实测结果

| 检查 | 结果 |
| --- | --- |
| npm run check | 退出 0 |
| npm test | 317 tests / 317 pass / 0 fail |
| npm run build | 退出 0；lib/client.js 222255 bytes（loader wrapper 前；文件 222458 bytes） |
| CI UI / 可用性 / 结构 | 均退出 0 |
| 模型偏好 / 配对 / 空模型 | 均退出 0；无自动检测请求 |
| 首次接入端到端 | 27/27 断言通过（面板签发、关闭浏览器后 CLI/HTTP、ACL 与负向路径）；realModelCalls=0 |
| 公开文档 ACL / 文案一致性 | 5/5 通过（含伪造 PSModulePath、ACL 清理与目标范围并集文案） |
| 目标范围行为回归 | 1/1 通过（指定目标与凭据提交目标的并集） |
| 接口集成（偏好/审查） | 2/2 通过；真实 HTTP 路由、临时 SQLite、真实审查状态机；批准与退回均有 verification，审查任务详情可追溯 |
| 第一轮 owner check | 317/317 pass；退出 0 |

## 本轮修复与证据

- P2 接口集成：`src/host/agent-api.js` 的 `modelPreferencesView()` 改为读取单例 `model` 并复用 `sanitizePreferences`，与界面快照同源；`reviewsValue()` 通过审查 attemptId→审查任务 ID 映射关联 verification 并附 `reviewTaskId`。新增 `test/agent-api-integration.test.js` 覆盖空偏好、保存/清除 revision、批准/退回；`test/agent-api.test.js` 同步空偏好断言。
- P2 目标范围文案（v7）：src/client/access.jsx 的提示、签发结果与凭据列表，docs/external-agent-onboarding.md，docs/agent-api.md 统一为“指定目标 ∪ 本凭据提交的目标”；RED/GREEN 原始日志见 test-results/iteration-2-final-v7/red-doc-scope.log 与 green-doc-scope.log。
- 首次签发入口：普通 owner 在 ACMS 面板“外部接入”页签发；scripts/external-onboarding-ui-test.mjs 通过真实客户端 bundle 与真实宿主路由从页面签发，按公开文档写 token 与 ACL，关闭浏览器后 CLI 读取/提交/暂停恢复；27/27。该证据是隔离预览宿主 + 模拟执行器，不是真实模型或生产部署证据。
- PSModulePath：scripts/onboarding-doc.mjs 仅清理子进程；test/external-onboarding-doc.test.js 覆盖继承异常路径；默认环境直接执行文档块与子进程受限环境证据均保留。
- ACL EPERM：test/external-onboarding-doc.test.js 先 icacls /reset 再 rm(maxRetries:25, retryDelay:100)；通过。
- empty-models：原始失败日志核实为测试脚本顺序缺陷（配对 dialog 拦截下层点击），不是产品缺陷；脚本先关闭配对并断言 dialog 为 0；旧失败与绿色重跑均保留。
- fs.rm 等待：Node 24.22 为 retryDelay × retry 线性递增，1..25 次累计约 32.5 秒上限；实测 342ms / 1165ms；environment-evidence.json。
- codex-runtime rename：有界重试；317/317 两次通过。

## 哈希复核

- 以 measuredCommit 的 git blob 复核：git show <measuredCommit>:<path>，计算 SHA256 并与清单一致；文本 blob 为规范 LF，不受工作树 autocrlf 影响。
- docs/iteration-2-final-SHA256SUMS 不含自身；清单不含自身与校验和文件；v8 的 measuredCommit 由 docs/iteration-2-final-files.json 记录，清单提交仅含清单与校验和，不改变被测内容。
- 复核命令：node -e 读取清单并逐项比对（或 Get-FileHash -Algorithm SHA256）。

## 审查状态

最终候选由 ACMS 指派的非作者审查核对；作者自查记录见 docs/iteration-2-final-author-verification.md，不构成独立审查。上一版 v6 被非作者审查指出目标范围文案 P2（attempt_439973df）；v7 已修复。v7 冻结候选又被非作者审查（attempt_2222a18b）复现两项 P2 接口集成缺陷；本版 v8 已修复并补充集成回归。修订版仍须 ACMS 另行安排非作者复审，审查通过前本文件不宣称候选已获独立批准。