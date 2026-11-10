# Issue #47 验证记录

- Issue：[P2][体验] 总览与调度器使用同一执行资源占用口径（https://github.com/moudi01/dsh-ACMS/issues/47）
- 仓库基线：`origin/main` `2fc7a678b3e90598e80fcbd5f5128653dcc50c18`（Merge pull request #58）
- 实现提交：见本 PR 的实现提交（本记录在提交后补记 SHA）
- 验证日期：2026-11-10（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`；本机 Chrome（UI 检查）。未安装或升级运行中的 DSH，未调用真实模型。

## 1. 基线复现（真实静态证据）

基线 `2fc7a67` 上总览从任务尝试单独计算占用，宿主快照没有容量字段，核心只有总占用而无分类明细：

```text
> git show 2fc7a67:src/client/app.jsx | Select-String '执行资源'
['执行资源', `${active.length} / ${data.policy.maxConcurrent}`, 'ACTIVE RUNS', () => setTab('runs')],

> git show 2fc7a67:src/host/http.js | Select-String 'executionCapacity'
（无匹配：runtime 快照只有 activeProbes，没有统一容量）

> git show 2fc7a67:src/core/execution-capacity.js
（只有 executionOccupancy 返回 used，没有分类、阶段、空闲名额或入口信息）
```

因此调度器计入的 Git 集成、独立对话和模型检测占用不会出现在总览数字中，也无法从总览进入对应活动；这正是 issue 复现步骤描述的现象。

## 2. 改动范围

- `src/core/execution-capacity.js`：新增 `executionCapacity(store, adapter, live, policy)`，从与 `executionOccupancy` 相同的活执行部件计算 `used/limit/free/reserve/ordinaryLimit`，逐项返回 `kind`、`phase`、任务/目标/角色/会话标识；新增 `capacityBlockReason` 供宿主拒绝条件与模型检测入口共用。占用阶段划分为 `running`、`stopping`、`cleanupPending`、`integrating`、`chat`、`probe`。
- `src/host/http.js`：`/api/acms/state` 增加 `runtime.capacity`，由宿主在生成快照时计算，不信任前端自行推算。
- `src/runtime/conversations.js`：独立对话占用同时维护 `activeChatDetails`，让容量条目能关联到角色会话；清理未确认时标记为 `cleanupPending`。
- `src/client/app.jsx`：总览“执行资源”改用 `runtime.capacity`；点击进入“当前执行”后新增“执行容量”面板，显示总占用/上限、空闲、协调预留、各阶段计数，以及任务、集成、对话、模型检测的入口。
- `src/client/model-picker.jsx`：模型检测入口使用同一 `capacityBlockReason` 与快照容量，提示文案与宿主拒绝条件一致。
- `src/client/style.css`：容量面板样式。
- `test/capacity.test.js`：6 项隔离夹具，覆盖纯聊天、检测、任务执行、正在停止、待清理核对、集成、混合占用、同一活动只计一次、满额原因和未知上限。
- `test/transport.test.js`：断言宿主快照暴露与调度器一致的容量数据，并在活动结束后归零。
- `scripts/capacity-ui-test.mjs`：静态数据 + 模拟适配器的 UI 检查，验证总览数字、分类计数和四类入口（任务详情、集成任务、角色对话、模型列表）。
- `package.json` / `.github/workflows/ci.yml`：新增 `npm run test:capacity` 并在 CI 执行。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node --test test/capacity.test.js test/transport.test.js` | 9 项通过，0 失败 | 容量分类、混合占用、快照一致性 |
| `npm test` | 493 项通过，0 失败，约 138 秒 | 全量核心、运行库与既有测试 |
| `npm run check` | 退出 0：Syntax and package contract checks passed. | 语法与包契约 |
| `npm run build` | 退出 0：Built lib/client.js | 客户端 bundle |
| `node scripts/capacity-ui-test.mjs` | `capacity UI checks passed` | 总览数字、阶段计数、任务/集成/对话/检测入口 |
| `npm run test:ui` / `test:display` / `test:usability` | 均退出 0（既有界面回归） | 总览、显示默认值、首次目标创建 |

以上结果来自实现提交的工作树。PR 推送后 GitHub Actions 会在最终 head 重新运行同一组命令；CI 结果以 PR 页面为准。

## 4. 验收标准对照

- [x] 总览采用宿主统一容量数据：`runtime.capacity` 由宿主生成，总览显示总占用与上限；“当前执行”页列出各类占用及可用入口。
- [x] 区分运行中、正在停止、待清理核对及协调预留：阶段计数与预留名额单独展示；同一活动在尝试、集成、对话、检测之间只计一次，结束时随快照更新。
- [x] 模型检测入口与宿主拒绝一致：共用 `capacityBlockReason`，满额原因包含 `used/limit` 与占用分类。
- [x] 隔离夹具覆盖纯聊天、检测、集成、任务、待核对及混合占用：`test/capacity.test.js` 与 UI 静态夹具；不调用模型。
- [x] 不改变调度排序、暂停、依赖、额度或清理规则：仅新增只读容量投影与展示；`executionOccupancy` 仍返回原字段，调度器行为不变。

## 5. 范围与限制

- UI 检查使用 `scripts/preview-server.mjs`、模拟适配器和静态夹具，Chrome 无头运行；不代表真实 DSH 面板或真实模型执行。
- 对话条目依赖运行期维护的 `activeChatDetails`；历史遗留或恢复场景中缺失明细时，容量只显示计数，不伪造角色入口。
- 本次未部署或升级运行中的 DSH，未修改 ACMS 数据库、凭据或策略；容量数据是只读投影，不写入业务状态。
- 复现命令：`node scripts/capacity-ui-test.mjs`；完整测试：`npm test`；构建：`npm run build`。
