# 最终候选作者复核记录（非独立审查）

> 本文件是作者自查/复核记录，不是独立审查，也不构成放行。非作者 ACMS 审查是本轮验收的必需项。

- 记录性质：实现执行者在同一次执行中完成的复核。作者与实现者为同一身份，因此不能自称独立审查。
- 产生身份：task_5f526a54-6871-4fe7-9425-c43c0b3b1bde 的实现执行者（v6 为 attempt_b02b40fa-1ede-4d52-bdcd-eca55386ddf4；v7 为 attempt_c350a352-92ca-49e6-8c09-eac3c555d389；本修订版 v8 为 attempt_2d0b21af-7b07-4f30-a89f-0a2bb506b498）。身份与公开工具记录见 D:/ACMS/test-results/iteration-2/candidate-review-attribution-evidence.json。
- 复核对象：分支 acms/task_5f526a54-6871-4fe7-9425-c43c0b3b1bde。本修订版 v8 的内容提交由 docs/iteration-2-final-files.json 的 measuredCommit 固定；v7 冻结候选随后被非作者审查 attempt_2222a18b 复现两项 P2，本版已修复。
- 复核位置：本版作者复核在本隔离工作副本直接执行；该副本仍与执行者同源，不是独立副本，不能替代非作者审查。
- 时间：2026-11-07。
- 归因更正：上一版把本文称为“task_5f526a54 的审查阶段”，并写入“若发布要求完全独立第三方”的条件句，属于错误归因。本版明确标为作者复核，并明确非作者 ACMS 审查无条件必需。

## 方法

1. 作者只读核对 git diff main..HEAD 与源文件，确认改动覆盖 #15/#16/#5 及最终候选硬化。
2. 对 docs/iteration-2-final-files.json 的每个条目，用 git show <measuredCommit>:<path> 重算 SHA256，并核对 sourceTreeHash。
3. 在作者克隆上重新执行 node scripts/check.mjs、node --test test/external-onboarding-doc.test.js、node --test test/agent-api-integration.test.js、node scripts/empty-models-test.mjs、node scripts/external-onboarding-ui-test.mjs、npm test、node scripts/build.mjs，以及目标范围文案/行为、模型偏好、配对与 CI 界面检查。
4. 核对失败证据是否保留、文档数字是否与实测一致、是否有未解决阻断项。

## 结果（作者自查）

| 项目 | 结果 |
| --- | --- |
| Manifest 与 SHA256SUMS | 条目数与实际改动一致；逐项 SHA256 0 mismatch；sourceTreeHash 由清单条目计算 |
| node scripts/check.mjs | 退出 0 |
| test/external-onboarding-doc.test.js | 5/5 通过（含继承 PSModulePath 的子进程场景、ACL 夹具清理与目标范围并集文案） |
| test/agent-api-integration.test.js | 2/2 通过；真实 HTTP 路由、临时 SQLite、真实审查状态机；覆盖偏好保存/清除与批准/退回 |
| scripts/empty-models-test.mjs | 退出 0；配对可用、未绑定角色禁止保存、无 pageerror、无自动检测请求 |
| scripts/external-onboarding-ui-test.mjs | 27/27 断言通过（含面板签发、关闭浏览器后 CLI 与 2 项目标范围文案）；realModelCalls=0 |
| 目标范围文案与行为 | 三层检查通过：API 行为 1/1、文档/源码一致性 1/1、UI 文案 2 项断言 |
| npm test | 317 tests / 317 pass / 0 fail |
| scripts/build.mjs | 退出 0；lib/client.js 222255 bytes（loader wrapper 前；文件 222458 bytes）；重跑前后内容一致 |
| model-preferences / pairing / ui / usability / structure | 均退出 0 |
| 第一轮 owner check | 317/317 pass；退出 0 |
| 工作树影响 | receipt/screenshot 由测试刷新并纳入候选；build 后 lib/client.js 与源码一致 |

## 结论

- 作者自查未发现阻断性缺陷；源码、测试、文档与证据一致。
- 本文不构成独立审查，也不代表候选已获独立批准。v7 冻结候选被非作者审查 attempt_2222a18b 复现两项 P2 接口集成缺陷；本版 v8 已修复并补充集成回归，仍须由 ACMS 安排的非作者审查复核。
- 保留限制：PR、CI、main 合入、备份升级、真实 DSH 宿主与真实模型验收未发生；27 项接口断言是隔离预览宿主模拟证据，不是真实模型或生产部署证据。
- 证据日志：test-results/iteration-2-final-v9/（check.log、test.log、build.log、ui-test.log、usability-test.log、structure-test.log、model-preferences-ui.log、pairing-ui.log、empty-models.log、external-onboarding-ui.log、external-onboarding-doc.log、agent-api-integration.log、owner-check.log、union-scope-behavior.log）。