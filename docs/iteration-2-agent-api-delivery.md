# #15 外部智能体接口：交付与证据清单

> 状态：隔离工作副本中的实现、测试和文档已完成并自查通过，等待非作者独立审查。本文件不是发布报告：未创建 PR、未合入 main、未升级现场 ACMS、未做真实宿主发布验收，也未用模拟模型输出冒充真实执行。
>
> 版本说明：本文件是 #15 子任务的交付记录；最终累计候选（v8）的文件清单、检查结果与交接以 docs/iteration-2-final-files.json、docs/iteration-2-final-verification.md、docs/iteration-2-release-handoff.md 为准。下文 216 项为 #15 当时的完整套件计数，不代表最终累计候选的 317 项；历史哈希仅记录该子任务版本。

| 项 | 值 |
| --- | --- |
| 任务 | `task_ab7105f7-1f5d-4775-9752-9088b3543044`（#15） |
| 本次执行 | `attempt_9562f7e8-60d1-48f1-94c8-84e5e842d5b7` |
| 指定基线 | `178987ad4337a499f925d4377de44a3b5f11d550` |
| 工作副本 HEAD | `178987ad4337a499f925d4377de44a3b5f11d550` |
| 变更范围 | 18 个文件（新增 11，修改 7） |
| 协议测试 | 26/26 通过 |
| 受影响回归 | 53/53 通过 |
| 静态检查 | 通过（`node scripts/check.mjs`，exit 0） |
| 完整套件 | 216 项全部通过 |
| 独立审查 | 待非作者 reviewer 核对最终文件、哈希与证据；作者不自批通过 |

## 0. 本轮返工：SQLite 写锁超时的错误分类（P2）

独立审查复现：第二个连接持有 `BEGIN IMMEDIATE` 时，`POST /goals` 等待约 5 秒后返回 500 `INTERNAL`、`retryable:false`，而共享契约 3.3 节要求 503 `ENGINE_BUSY`、`retryable:true`。本轮只修复该缺陷并补回归，不改动上一轮已复核的 4 项修复。

| 缺陷 | 修复 | 回归测试 |
| --- | --- | --- |
| P2 SQLite 写锁超时被当作未知内部错误 | `src/core/util.js` 新增 `isBusyError`/`asBusyError`（识别 `SQLITE_BUSY`/`SQLITE_LOCKED` 的 errcode 与 message）；`Store.transaction` 对 `BEGIN IMMEDIATE` 与 `COMMIT` 的忙错误映射为 `ENGINE_BUSY`；agent API 对原始 SQLite 忙错误兜底转换，输出 503、`retryable:true` 与可读消息；CLI 对 `retryable` 响应退避重试并复用同一幂等键 | `maps database write-lock contention to a retryable 503 and a single business effect`、`CLI retries a retryable 503 busy response with the same idempotency key` |

### 历史返工：上一轮四项 P1/P2 修复（已复核）

该轮针对当时独立审查复现的 4 项缺陷做了修复并新增回归测试；以下为作者自查证据，最终放行仍须非作者 reviewer 复核。

| 缺陷 | 修复 | 回归测试 |
| --- | --- | --- |
| P1 读权限：`/projects`、`/projects/{id}`、`/goals` 未检查 `status.read` | 数据读取统一经 `read()` 执行命令检查；`/events` 单独要求 `events.read`；`/discover` 仅要求有效凭据 | `enforces status.read and events.read on every scoped read endpoint` |
| P1 token 持久化：命令结果保存并重放明文 token | `Store.command` 新增 `persistResult`；`agentCredential.create` 只持久化脱敏视图与 `tokenOmitted`，重放不再返回明文 | `returns credential plaintext once and persists only a redacted replay record` |
| P1 长轮询：等待结束后未复核授权 | 等待结束、读取事件前重新解析 Bearer 凭据并重做命令/目标范围检查；撤销/过期 401，命令移除 403 `FORBIDDEN`，范围收窄 403 `SCOPE_DENIED` | `revalidates credential state and scope when a long poll completes` |
| P2 启动失败清理：仅关闭数据库，遗留监听器与调度租约 | `ctx.effect` 在启动前注册；统一幂等 dispose 按监听器 → 会话 → 调度器 → 数据库释放；`createAgentApi.start()` 失败自清理；`Engine.stop()` 可安全处理部分启动 | `releases listener, scheduler lease and discovery files when agent API startup fails` |

## 1. 交付文件（originalPath 与 SHA256）

| 文件 | 状态 | 字节 | SHA256 |
| --- | --- | --- | --- |
| `src/core/store.js` | 修改 | 12867 | `5bf475166ca341db2b0c9a52911daf5ac9e2bfd20d48b57e8c5128ae93ae6b65` |
| `src/core/util.js` | 修改 | 2589 | `57c142a182966ed4ae9cced3d324c386bb30d69e567e8bb6842b8607a6daf5ce` |
| `src/core/agent-identity.js` | 新增 | 7450 | `a10b76449f68e56ae9effeb1ea20dec2e249373d8e70ae85a20ba6a8b1005d8f` |
| `src/core/external-access.js` | 新增 | 9617 | `285f24b446d10fb9b46c6b4a048667007ed98a8d57a8d74e3c3f196697470405` |
| `src/core/domain.js` | 修改 | 38667 | `2c4b15728203652ae792e8c7d57f2377d35db55207dc25be31e46155677f1964` |
| `src/host/agent-api.js` | 新增 | 33029 | `719a5758cbcbc4cf559bda3005e6cd2bb28e6acd8d72b63fc3e897b547bdcf9d` |
| `src/host/index.js` | 修改 | 3661 | `36feb5718320b276ba67f50038a6cd208ab09bb473ec4b2319e9495b276b8bd3` |
| `src/host/http.js` | 修改 | 6741 | `e80b3a0ebac797413cd6b76044696bab097768341618c20edf97ce8e844d866a` |
| `src/runtime/engine.js` | 修改 | 36837 | `d9a2940caf69844c735600d81b9aad5574f5fe555792a6aa0a7950eca2a06c66` |
| `scripts/acms-agent.mjs` | 新增 | 8791 | `e3758204ae41934184f482dae566fda129e47b79fd4f9b91e8dde5a1655facfb` |
| `examples/agent-api/flow.mjs` | 新增 | 6077 | `be0a343090d5c745b96bd07ce975257e9c97637cff17397acb22c69f048304a2` |
| `test/agent-api.test.js` | 新增 | 49587 | `9b010be1d2491e2511a748d1dd53e9e0269a193b3ac358de328f12af040f5794` |
| `test/agent-api-lifecycle.test.js` | 新增 | 2350 | `2e31b74a5f34618e2eaad1e5bb4189f0abacbdf94ec0f6d064c023098bf633a5` |
| `docs/agent-api.md` | 新增 | 16249 | `5b80a410c68c44e7c51e94723ceb0124c3d91a19e9e47c3105362e729803cc63` |
| `docs/iteration-2-agent-api-sources/hash-manifest.mjs` | 新增 | 1368 | `a877be9a101abefb7c35664bf33f15fcc7aaa71a411a6586b54340d54bbfddef` |
| `docs/iteration-2-agent-api-sources/collect-evidence.mjs` | 新增 | 3327 | `a5d5ceb2d7eaff7ab6be95bf64a2815bee3b3022a308e61527d1f11e6264f1a2` |
| `docs/iteration-2-agent-api-sources/write-delivery.mjs` | 新增 | 12589 | `e5c3ca908be8a295af332aa13a249341eb161ac8bada77a7ed4d628770eee7e8` |
| `package.json` | 修改 | 1897 | `78d49b913ac25e34095e61f25da2afc6dcfbb81b5c80fdcef6ace5c18211357c` |

机器可读清单：`docs/iteration-2-agent-api-sources/files.json` 与 `docs/iteration-2-agent-api-sources/SHA256SUMS`；可用 `node docs/iteration-2-agent-api-sources/hash-manifest.mjs` 重新生成并逐文件核对。哈希只证明文件字节一致，不能替代内容审查。

## 2. 与合同要求的对应

| 合同项 | 落实位置 | 证据 |
| --- | --- | --- |
| 15-1 可发现、版本化、结构化响应与错误码、可运行接入说明和示例 | `src/host/agent-api.js`（v1 基路径、envelope、错误映射、发现文件）、`docs/agent-api.md`、`scripts/acms-agent.mjs`、`examples/agent-api/flow.mjs` | 协议测试 1、7、17、18；CLI 与示例流程测试 |
| 15-2 受信身份、区分主体、不能伪造 owner、范围隔离 | `src/core/agent-identity.js`、`src/core/external-access.js`、`Company.authorize` 的 user-agent 分支、schema `additionalProperties=false` | 测试 2、3、4、5、15 |
| 15-3 目标提交、项目创建、任务/审查/阻塞查询、回答交互、暂停/恢复 | `src/host/agent-api.js` 路由、`submitGoal`、`createExternalProject`、既有 `answer`/`controlTask`/`resumeTask` | 测试 1、8、14、15、16 |
| 15-4 复用领域校验、审计与调度入口，requestId 幂等，禁止直接改数据库 | 全部写命令经 `Company.command`/`Store.command`；`ext:` 内部键；`goal.submitted`/`agentCredential.*` 审计事件 | 测试 7、8、9、10、11；重启测试 12 |
| 15-5 按目标增量读取事件与恢复游标，只读无模型副作用 | `Store.pageScoped`/`eventEntry`/`goalOf`、`/events` 长轮询、GET 处理不调用调度器 | 测试 1、13；只读调用计数为 0 |
| 15-6 普通管理不隐式触发模型检测 | `src/host/http.js` 删除 `agent.save` 路由中的隐式 `modelDetails`；外部 API 不导入适配器 | 测试 17；`modelDetails`/`probeModel`/`modelCatalog` 计数为 0 |
| 15-7 真实宿主端到端验收 | 未在本任务执行；由发布任务在真实宿主、真实凭据下完成 | 未发生，不得声明完成 |
| 15-8 审计区分实际调用代理与代表用户 | schema v2 的 `principal_kind`/`on_behalf_of`/`goal_id`；`goal.submitted` 的 `decision.kind=user-constraint` | 测试 1、2、6、7；`pageScoped` 条目断言 |
| 15-9 凭据范围签发、更新、撤销 | `agentCredential.create`/`updateScope`/`revoke`，owner-only；`REVISION_CONFLICT`；快照脱敏 | 测试 4、5、8 |
| G-4 源码/测试/文档完整交付，相关回归与核心检查通过 | 本清单；`validation.json`；测试日志 | 协议测试 26/26、受影响回归 53/53、静态检查 exit 0、完整套件 216/216 |

## 3. 测试与证据

| 检查 | 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| agent-api-protocol | `node --test --test-concurrency=1 test/agent-api.test.js test/agent-api-lifecycle.test.js` | 0 | 26/26 通过，0 失败 | `docs/iteration-2-agent-api-sources/agent-api-tests.log` |
| affected-regression | `node --test --test-concurrency=1 test/domain.test.js test/transport.test.js test/delegation-permissions.test.js test/action-batch.test.js test/recovery-boundaries.test.js test/engine.test.js` | 0 | 53/53 通过，0 失败 | `docs/iteration-2-agent-api-sources/regression.log` |
| static-checks | `node scripts/check.mjs` | 0 | 静态语法与包契约检查通过 | `docs/iteration-2-agent-api-sources/static-checks.log` |
| full-suite | `node --test --test-concurrency=1 test/action-batch.test.js test/agent-api-lifecycle.test.js test/agent-api.test.js test/bundled-cleanup.test.js test/collaboration.test.js test/conversations.test.js test/delegation-permissions.test.js test/deployment.test.js test/domain.test.js test/engine.test.js test/entity-management.test.js test/exploratory-regression.test.js test/graceful-pause.test.js test/models.test.js test/owned-process.test.js test/paired-cleanup.test.js test/paired-conversations.test.js test/paired-recovery.test.js test/paired.test.js test/recovery-boundaries.test.js test/recovery.test.js test/runtime-budget.test.js test/task-management.test.js test/transport.test.js` | 0 | 216/216 通过，0 失败 | `docs/iteration-2-agent-api-sources/full-suite.log` |

环境说明：本隔离任务工作区带有本地 `node_modules`，完整套件已直接执行并通过；未通过修改测试或跳过检查来获得该结果。

测试夹具使用临时 SQLite、owner 命令与 stub 适配器，明确属于非真实模型证据；真实模型调用只允许在发布验收任务中按目标授权执行。

## 4. 幂等、授权与重启证据要点

- 事务内 precheck：范围收窄后同一幂等键返回 403 `SCOPE_DENIED`，命令被移除返回 403 `FORBIDDEN`，撤销/过期返回 401 `UNAUTHORIZED`；均不读取旧结果。恢复范围后同一键返回 `replayed:true`，业务事件只产生一次。
- 同键不同参数或不同操作返回 409 `IDEMPOTENCY_CONFLICT`；不同凭据可用相同外部键并各自产生一次业务效果。
- 两种幂等载体（请求头/body）等价；两者不同返回 400 `IDEMPOTENCY_KEY_MISMATCH`；缺失返回 400 `IDEMPOTENCY_REQUIRED`；重复请求头 400 `INVALID_REQUEST`；长度 8/200 有效，7/201/空白/Unicode/控制字符/终止换行无效。
- 关闭并重新打开同一 SQLite 文件后，同一键重放为 `replayed:true` 且不重复创建目标，事件游标继续。
- GET 全部读接口不调用 `choose`/`modelDetails`/`probeModel`/`modelCatalog`/`engine.kick`；`agent.save` 普通管理只做路由校验，不触发模型详情或探测。

- 数据库写锁竞争：第二连接持有 `BEGIN IMMEDIATE` 时 POST /goals 返回 503 `ENGINE_BUSY`、`retryable:true`，锁释放后同一幂等键成功且只创建一个目标，重放 `replayed:true`；CLI 对可重试 503 退避重试并复用同一键。

## 5. 未完成事项与移交要求

- 非作者 reviewer 必须核对 `files.json`/`SHA256SUMS` 的实际字节、阅读 `docs/agent-api.md` 与关键源码，并运行 `node --test --test-concurrency=1 test/agent-api.test.js test/agent-api-lifecycle.test.js`；作者自查不构成放行。
- 发布任务负责 GitHub PR、CI、main 合入、现场备份与升级、旧进程清理、数据保留、真实加载版本与真实宿主 agent 接口验收；这些事项在本任务中均未发生。
- 整合后 `/status` 的 `modelPreferences` 读取与界面快照相同的 SQLite 记录（单例 id `model`）；无记录时返回空偏好对象而不是 `null`。`attempt.selection` 在存在记录时返回实际选择，本任务不伪造。
- 整合后 `/reviews` 的 verification 以源任务 `taskId` 与审查 `reviewTaskId` 关联；批准与退回均返回结论摘要。
- 现场部署需要 owner 在真实 ACMS 中签发凭据并安全管理 token 文件；本任务未修改现场数据库、认证或 ACMS 元数据。

## 6. 复现命令

```bash
node --test --test-concurrency=1 test/agent-api.test.js test/agent-api-lifecycle.test.js
node --test --test-concurrency=1 test/domain.test.js test/transport.test.js test/delegation-permissions.test.js test/action-batch.test.js test/recovery-boundaries.test.js test/engine.test.js
node scripts/check.mjs
node docs/iteration-2-agent-api-sources/hash-manifest.mjs
node docs/iteration-2-agent-api-sources/collect-evidence.mjs
```
