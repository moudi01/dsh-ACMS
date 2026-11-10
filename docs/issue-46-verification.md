# Issue #46 验证记录

- Issue：[P2][调度] 让目标优先级影响跨目标派发并在界面显示（https://github.com/moudi01/dsh-ACMS/issues/46）
- 仓库基线：`origin/main` `57bed91d5a53a36c5ef4e878253d9e85714a4909`（Merge pull request #59）
- 实现提交：`1831b18`（分支 `codex/issue-46-goal-priority`）；本记录提交只补记该 SHA
- 验证日期：2026-11-10（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`；本机 Chrome（UI 检查）。未安装或升级运行中的 DSH，未调用真实模型。

## 1. 基线复现（真实静态证据）

基线 `57bed91` 已能保存目标 `priority` 字段（外部提交显式传入时会保存），但派发排序没有读取目标优先级，界面也没有目标优先级输入：

```text
> git show 57bed91:src/runtime/engine.js | Select-String "const ready = this.store.list"
.sort((a, b) => (['plan', 'review', 'coordination'].includes(b.kind) - ['plan', 'review', 'coordination'].includes(a.kind))
  || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))

> git show 57bed91:src/client/app.jsx | Select-String "优先级（0–100）"
（仅任务编辑分支出现；目标新建/编辑表单没有优先级字段）

> git show 57bed91:src/core/external-access.js | Select-String "const priority ="
const priority = args.priority === undefined ? 0 : args.priority;
```

因此 issue 复现步骤成立：并发限制 1 时先创建优先级 0、后创建优先级 100 的两个目标，两者规划任务均为默认优先级 50，旧排序只看任务优先级与创建时间，较早的低优先级目标先获得名额。外部提交缺省值为 0，与界面/任务默认 50 也不一致。

## 2. 改动范围

- `src/core/domain.js`：创建目标时始终保存 `priority`（默认 50，0–100 整数校验）；`goal.edit` 允许修改 `priority`，非法值拒绝；只改优先级不算合同变更，不递增 `contractVersion`、不重启在途任务。
- `src/runtime/engine.js`：就绪任务排序在控制类优先、任务优先级之后加入目标优先级，再以任务创建时间稳定排序；控制类（规划/审查/协调）仍先占用预留名额。
- `src/core/external-access.js`：外部提交未提供优先级时默认 50，与界面一致；显式值保持 0–100。
- `src/host/agent-api.js`：目标快照对缺失优先级的旧目标返回 50，而不是 null。
- `src/client/app.jsx`：新建目标、编辑目标表单增加“优先级（0–100）”字段（默认 50，带语义说明）；提交参数与外部接口一致。
- `src/client/entities.jsx`：目标详情显示优先级。
- `docs/architecture.md`：记录派发顺序与目标优先级边界。
- `docs/agent-api.md`：注明外部提交优先级默认 50。
- `test/goal-priority.test.js`：7 项隔离夹具，覆盖高低优先级、同优先级稳定顺序、高优先级不可派发、任务优先级优先、修改优先级影响后续派发且保留在途合同、编辑语义与外部默认值。
- `scripts/goal-priority-ui-test.mjs`：UI 检查目标新建默认 50、设置 80、详情查看、编辑为 10、清空回落 50、后端快照同步；`package.json` 与 CI 增加 `test:goal-priority`。

派发顺序（写入架构文档）：控制类任务先占用预留名额，其后任务优先级降序、目标优先级降序、任务创建时间升序。目标优先级只影响后续跨目标派发，不改变在途任务、依赖、暂停、额度或清理占位。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node --test test/goal-priority.test.js` | 7 项通过，0 失败 | 排序、编辑、后续派发变化、外部默认值 |
| `npm test` | 503 项通过，0 失败，约 148 秒 | 全量核心、运行库与既有测试 |
| `npm run check` | 退出 0：Syntax and package contract checks passed. | 语法与包契约 |
| `npm run build` | 退出 0：Built lib/client.js | 客户端 bundle |
| `node scripts/goal-priority-ui-test.mjs` | `goal priority UI checks passed` | 新建默认值、设置、查看、修改 |
| `npm run test:ui` / `test:usability` / `test:display` | 均退出 0（既有界面回归） | 主界面、首次目标创建、显示默认值 |

以上结果来自实现提交的工作树。PR 推送后 GitHub Actions 会在最终 head 重新运行同一组命令；CI 结果以 PR 页面为准。

## 4. 验收标准对照

- [x] 说明目标优先级、任务优先级、协调与审查预留的排序关系：控制类任务先占预留名额，再按任务优先级、目标优先级、任务创建时间排序；文档与测试同时覆盖。
- [x] 所有者能设置、查看和修改目标优先级，界面与外部提交同一语义：新建/编辑表单与目标详情；外部提交默认 50，显式值原样保存；旧目标按 50 展示。
- [x] 优先级变化作用于后续派发，保留在途、依赖、暂停、额度、清理占位与协调预留边界：只改优先级不触发合同变更；`调整目标优先级影响后续派发` 用例实际运行调度，验证在途执行的 attempt/generation/合同不变，而下一次跨目标派发切换到新优先级更高的目标；暂停目标的任务不参与竞争，其他目标继续派发。
- [x] 单名额夹具覆盖高低优先级、同优先级稳定顺序和高优先级目标不可派发：`test/goal-priority.test.js` 使用模拟执行入口记录首次派发，不调用真实模型。

## 5. 范围与限制

- 排序规则只在“同类可派发任务”之间比较目标优先级；任务自身优先级更高时以任务设置为准，这是明确的产品语义而非缺陷。
- 目标优先级不会抢占已派发或清理中的占位；暂停、依赖、额度和清理确认仍是硬边界。
- UI 检查使用预览服务、模拟适配器和静态夹具，Chrome 无头运行；未部署或升级运行中的 DSH，未修改 ACMS 数据库、凭据或策略。
- 旧目标没有 `priority` 字段时，排序与界面按 50 处理，不重写历史记录。
- 已取消/归档/legacy 目标仍可修改优先级（与既有标题编辑一致），但这些目标不参与派发，修改没有调度影响。
- 复现命令：`node scripts/goal-priority-ui-test.mjs`；完整测试：`npm test`；构建：`npm run build`。

## 6. 复核修订

独立审查在 `1831b18` 上给出 APPROVE，并提出若干非阻塞改进，已采纳：

- **补后续派发回归**：新增“调整目标优先级影响后续派发，且在途任务与合同保持不变”用例：在阻塞执行的第一个任务上修改两个目标的优先级，释放在途任务后断言下一次派发切换到新的高优先级目标，同时 attempt/generation/contractVersion 不变。
- **空输入回落 50**：新建/编辑表单在优先级输入被清空时按 50 提交，不再经 `Number('')` 变成 0；UI 夹具增加清空后保存并断言 50。
- **格式与注释**：恢复 `ensureGoalContractCoordination` 的换行格式；UI 测试注释不再声称覆盖外部提交语义（由单测覆盖）。
- **接口文档**：`docs/agent-api.md` 补充目标响应中旧目标 `priority` 按 50 返回。
