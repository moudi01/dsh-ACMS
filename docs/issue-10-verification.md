# Issue #10 验证记录

- Issue：[P2][文档] 修正卸载命令与暂停、上下文行为说明，并建立一致性检查（https://github.com/moudi01/dsh-ACMS/issues/10）
- 仓库基线：`origin/main` `17c31b530aa1986ce1c114c950118422ff7e46a8`（Merge pull request #57）
- 改动提交：`bbecc92`（分支 `codex/issue-10-docs-consistency`），包含初版全部代码、测试与文档改动
- 复核修订提交：`1d0b03b`、`b1ac6ed`（修复独立审查两轮发现的问题，详见第 6 节）
- 本记录提交：仅新增本文件和 `docs/validation.md` 的检查指引，不改变被测代码
- 验证日期：2026-11-10（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`。未安装或升级运行中的 DSH，未调用真实模型，未执行会修改 DSH profile 的安装/卸载脚本。

## 1. 基线复现（真实结果，非模拟）

在基线提交的独立 worktree 中执行本次新增的检查器和静态检索：

```text-evidence
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
- `test/docs-consistency.test.js`：覆盖参数解析、命令分隔、反引号续行、`text-evidence` 摘录豁免、fence 边界、未知参数、未记录参数、失效链接、缺失脚本、暂停标签与仓库自检，共 15 项。
- `package.json` / `.github/workflows/ci.yml`：新增 `npm run check:docs` 并在 CI 中执行。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node scripts/check.mjs` | 退出 0：Syntax and package contract checks passed. | 全仓库语法与包契约 |
| `node scripts/docs-consistency.mjs` | 退出 0：文档一致性检查通过 | 命令参数、参数记录、脚本引用、相对链接、暂停语义 |
| `node --test test/docs-consistency.test.js` | 15 项通过，0 失败 | 检查器正负夹具 |
| `npm test` | 484 项通过，0 失败，耗时约 143 秒 | 核心、运行库与新增文档检查测试 |
| `npm run build` | 退出 0：Built lib/client.js | 客户端构建；客户端源码未改，生成产物与已提交版本仅行尾差异，未纳入提交 |

以上结果来自复核修订后的工作树；初版 `bbecc92` 的基线复现与同类命令结果一致，复核修订只修正文档措辞、新增 2 项检查器测试并增强多行命令与大小写解析。PR 推送后 GitHub Actions 会以最终 head 重新运行同一组命令；CI 结果以 PR 页面为准，本文件不预判。

## 4. 验收标准对照

- [x] 安装/卸载命令与脚本参数一致：卸载示例只保留 `-TargetProfile`；安装/卸载参数表覆盖脚本声明的全部参数；`docs-consistency` 在 CI 中拦截未知参数和未记录参数。
- [x] 暂停、停止在途执行、恢复调度与单任务暂停分别说明：`docs/operations.md` 的“暂停、停止与恢复”章节逐项定义，并区分目标级暂停。
- [x] 任务上下文取决于入口能力：README、架构、运行与配对文档统一为“执行入口声明的上下文能力”；独立对话历史传递与任务线程续接分开描述，人员留任不映射为续接。
- [x] 文档统一且检查失效路径/链接：检查器校验相对链接和 `scripts/*` 引用；基线无既有失效项，新增检查防止后续漂移。
- [x] 命令示例/参数与关键文档链接检查加入 CI：`.github/workflows/ci.yml` 增加 `npm run check:docs`。
- [x] 验证记录注明提交、日期与范围：本文件记录 `bbecc92`、2026-11-10、真实本机结果与未覆盖项，未沿用其他入口或其他分支的历史成功结论。

## 5. 范围与限制

- 未对真实 DSH profile 执行 `scripts/install.ps1`/`scripts/uninstall.ps1`，因此不声明完成真实安装/卸载。参数一致性由脚本 `param` 块静态解析和 `test/docs-consistency.test.js` 的临时夹具覆盖；独立审查另在临时 `DSH_HOME` 与 stub `dsh.cmd`（非真实 DSH）下检查过参数绑定和配置块增删，该结果属于审查辅助证据，不等同于真实安装验收。
- 暂停语义通过核对 `src/core/domain.js`、`src/core/goal-control.js`、`src/runtime/engine.js` 的实际行为并检查文档描述完成，未启动真实宿主做界面级交互复现；既有 `graceful-pause`、`goal-control` 等测试继续覆盖运行时行为。
- 检查器不校验 Markdown 锚点、`docs/` 子目录、`CHANGELOG.md` 和 `.mjs` 脚本参数；历史迭代交付文档中引用未随仓库提交的内联归档路径（如 `docs/iteration-2-*/...`）属于历史存证，不在本 issue 的用户文档范围。
- 未部署或升级运行中的 DSH，未调用真实模型，未修改 ACMS 数据库、凭据或策略。
- 复现命令：`node scripts/docs-consistency.mjs`；完整测试：`npm test`；构建：`npm run build`。

## 6. 复核修订

独立审查在初版 `bbecc92` 上发现两处文档与实际行为不符，均已修复并补充验证：

- **目标级暂停的结果处理**：初版把“暂存已完成结果、恢复后入库”写在立即暂停下。实际只有 `afterCurrent=true` 才会在 `src/runtime/engine.js` 的 `GOAL_PAUSED` 路径暂存结果（`attempt.result.deferred`、`resultDeferred`）；立即暂停会中止在途执行，未完成结果不入库。修订后文档按两种模式分别描述，并与 `README.md` 的目标执行控制说明一致。
- **编辑与清理的先后**：初版写成“等待清理确认后再编辑”。实际 `task.edit` 会立即保存修改，并把执行中的旧轮次置为 `stopRequested=ready`、递增 `generation`（`src/core/domain.js`、`src/core/entity-management.js`、`src/client/app.jsx`），清理确认后按新要求继续。修订后按实际顺序描述。
- **补充边界**：单任务暂停默认级联审查子任务；目标级 `afterCurrent` 暂停可在清理确认前把任务置为 `paused`，但资源占位保留到清理确认。
- **检查器增强**：支持反引号续行的多行命令，Windows 下大小写不敏感的脚本名解析；证据摘录改用 `text-evidence` 标记，普通 `text` 代码块不再豁免，避免借摘录隐藏可执行命令。
- **第二轮复审修复**：复审发现第一版续行合并可能吞掉相邻 fence（行内代码以反引号结尾、证据块以续行结尾两种布局），已改为先按物理行识别 fence，只在下一行不是 fence 分隔符时合并反引号续行，并补 3 项 fence 边界与普通 `text` 块回归测试。测试总数增至 15 项。
