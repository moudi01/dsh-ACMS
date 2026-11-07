# PR：第二轮迭代：外部智能体接口、负责人协调闭环与模型倾向

## 摘要

完成 #15、#16、#5：版本化外部智能体接口与 owner 首次签发入口；负责人自主规划、协调与决策归因；owner 可持久设置的有序模型偏好与可解释自动选择。

## 关联 issue

Refs #15、#16、#5。合入后按仓库约定关闭；本 PR 不宣称部署与真实宿主验收已完成。

## 主要变更

- #15：/api/acms/agent/v1 回环接口、发现文件、Bearer 凭据、幂等键、范围校验、事件增量、暂停/恢复、owner 面板签发与 27 项端到端断言。
- #16：负责人自主拆分/派工/返工、管理批次重放、权限收窄、跨目标拒绝、反馈续跑、独立审查与决策归因。
- #5：有序模型偏好；显式绑定优先，自动选择在授权/能力/可用性满足后采用偏好；未知能力保持未知，无合格候选明确阻塞；管理查询不触发检测。
- 最终候选硬化：ACL 子进程隔离 PSModulePath、icacls /reset 清理、codex-runtime 瞬时 rename 重试、空模型脚本先关闭弹窗、修正 fs.rm 线性重试文档。
- v7 修复审查 P2：签发提示、签发结果与凭据列表统一为“指定目标 ∪ 本凭据提交目标”，与 agent-api.md 一致；新增 API 行为、文档/源码一致性与 UI 渲染三层回归。
- v8 修复审查 P2：`/status` 偏好统一读取单例 `model` 并与界面快照一致；`/reviews` 以审查 attempt 关联 verification 并返回 `reviewTaskId`；新增真实 HTTP + SQLite + 审查状态机集成回归 2 项。

## 验证

- npm run check / npm test（317/317）/ npm run build：通过。
- test:ui、test:usability、test:structure、模型偏好、配对、空模型：均退出 0。
- external-onboarding-ui：27/27；external-onboarding-doc：5/5；agent-api-integration：2/2；owner-check：317/317。
- 日志与哈希：docs/iteration-2-release-handoff.md、docs/iteration-2-final-files.json、test-results/iteration-2-final-v9/。

## 复现

```powershell
git checkout acms/task_5f526a54-6871-4fe7-9425-c43c0b3b1bde
npm ci; npm run check; npm test; npm run build
node scripts/external-onboarding-ui-test.mjs
node --test test/external-onboarding-doc.test.js
node --test test/agent-api-integration.test.js
```

## 发布与回滚

按 docs/iteration-2-release-handoff.md 执行清理、备份、升级、恢复；失败时用 profile 与 dataDir 备份回滚。真实宿主与真实模型验收待发布任务完成。

## 风险

- 27 项接口断言是隔离宿主模拟证据，不是生产部署或真实模型证据。
- 实际 CI windows-latest 与真实宿主兼容性需由 CI run 和发布验收确认。