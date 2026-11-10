# Issue #10 验证记录

- Issue：[P2][文档] 修正卸载命令与暂停、上下文行为说明，并建立一致性检查（https://github.com/moudi01/dsh-ACMS/issues/10）
- 仓库基线：`origin/main` `17c31b530aa1986ce1c114c950118422ff7e46a8`（Merge pull request #57）
- 改动提交：`bbecc92`（分支 `codex/issue-10-docs-consistency`），包含全部代码、测试与文档改动
- 本记录提交：仅新增本文件和 `docs/validation.md` 的检查指引，不改变被测代码
- 验证日期：2026-11-10（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`。未安装或升级运行中的 DSH，未调用真实模型，未执行会修改 DSH profile 的安装/卸载脚本。

## 1. 基线复现（真实结果，非模拟）

在基线提交的独立 worktree 中执行本次新增的检查器和静态检索：

```text
> git show 17c31b5:docs/operations.md | Select-String RemoveCodexProvider
pwsh -File .\scripts\uninstall.ps1 -TargetProfile desktop -RemoveCodexProvider

> node <本次分支>/scripts/docs-consistency.mjs    # 工作目录为基线 worktree
文档一致性检查失败：2 项
- docs/operations.md:113: scripts/uninstall.ps1 未声明参数 -RemoveCodexProvider
- docs/operations.md: 缺少“暂停、停止与恢复”章节
退出码 1
```

基线确实存在 issue #10 描述的两类问题：卸载示例引用了 `scripts/uninstall.ps1` 未声明的参数，运行说明没有分别描述公司暂停、恢复调度、单任务暂停与停止在途执行。基线文档的相对链接和脚本引用没有既有失效项，因此本次从零加入检查，不虚构链接故障。

## 2. 改动范围

- `docs/operations.md`：卸载示例只使用 `uninstall.ps1` 已声明参数，补充卸载参数表；新增“暂停、停止与恢复”章节，分别说明 `company.pause`/`company.resume`、`task.pause`/`task.resume`、`goal.pause`/`goal.resume`/`goal.cancel`、停止在途执行、清理确认与 `reconciling` 占位；明确上下文续接取决于执行入口声明，并与人员留任、独立对话历史分开。
- `docs/architecture.md`：把“长期任务保留角色与线程”改为人员留任与线程续接分离，补充三级暂停与清理边界。
- `docs/agent-conversations.md`：补充独立对话历史传递与任务线程续接的边界。
- `README.md`：统一上下文续接表述为执行入口声明的上下文能力。
- `scripts/docs-consistency.mjs`：无依赖检查器，校验 PowerShell 命令参数与脚本声明一致、脚本参数已在运行说明记录、文档相对链接有效、引用的 `scripts/*` 文件存在、暂停章节包含四个动作及清理语义。
- `test/docs-consistency.test.js`：覆盖参数解析、命令分隔、`text` 摘录豁免、未知参数、未记录参数、失效链接、缺失脚本、暂停标签与仓库自检，共 10 项。
- `package.json` / `.github/workflows/ci.yml`：新增 `npm run check:docs` 并在 CI 中执行。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node scripts/check.mjs` | 退出 0：Syntax and package contract checks passed. | 全仓库语法与包契约 |
| `node scripts/docs-consistency.mjs` | 退出 0：文档一致性检查通过 | 命令参数、参数记录、脚本引用、相对链接、暂停语义 |
| `node --test test/docs-consistency.test.js` | 10 项通过，0 失败 | 检查器正负夹具 |
| `npm test` | 479 项通过，0 失败，耗时约 143 秒 | 核心、运行库与新增文档检查测试 |
| `npm run build` | 退出 0：Built lib/client.js | 客户端构建；客户端源码未改，生成产物与已提交版本仅行尾差异，未纳入提交 |

以上结果来自 `bbecc92` 的工作树。本记录提交只追加文档，PR 推送后 GitHub Actions 会以 PR head 重新运行同一组命令；CI 结果以 PR 页面为准，本文件不预判。

## 4. 验收标准对照

- [x] 安装/卸载命令与脚本参数一致：卸载示例只保留 `-TargetProfile`；安装/卸载参数表覆盖脚本声明的全部参数；`docs-consistency` 在 CI 中拦截未知参数和未记录参数。
- [x] 暂停、停止在途执行、恢复调度与单任务暂停分别说明：`docs/operations.md` 的“暂停、停止与恢复”章节逐项定义，并区分目标级暂停。
- [x] 任务上下文取决于入口能力：README、架构、运行与配对文档统一为“执行入口声明的上下文能力”；独立对话历史传递与任务线程续接分开描述，人员留任不映射为续接。
- [x] 文档统一且检查失效路径/链接：检查器校验相对链接和 `scripts/*` 引用；基线无既有失效项，新增检查防止后续漂移。
- [x] 命令示例/参数与关键文档链接检查加入 CI：`.github/workflows/ci.yml` 增加 `npm run check:docs`。
- [x] 验证记录注明提交、日期与范围：本文件记录 `bbecc92`、2026-11-10、真实本机结果与未覆盖项，未沿用其他入口或其他分支的历史成功结论。

## 5. 范围与限制

- 未执行 `scripts/install.ps1`/`scripts/uninstall.ps1`：它们会修改本机 DSH profile。参数一致性通过解析脚本 `param` 块、在临时目录夹具中验证检查器正负用例来完成，因此证明的是“命令示例与脚本声明一致”，不是“已在本机完成一次真实安装/卸载”。对应验收项要求的隔离测试目录验证由 `test/docs-consistency.test.js` 的临时夹具覆盖。
- 暂停语义通过核对 `src/core/domain.js`、`src/core/goal-control.js`、`src/runtime/engine.js` 的实际行为并检查文档描述完成，未启动真实宿主做界面级交互复现；既有 `graceful-pause`、`goal-control` 等测试继续覆盖运行时行为。
- 未部署或升级运行中的 DSH，未调用真实模型，未修改 ACMS 数据库、凭据或策略。
- 复现命令：`node scripts/docs-consistency.mjs`；完整测试：`npm test`；构建：`npm run build`。
