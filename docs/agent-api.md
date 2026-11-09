# ACMS 外部智能体接口 v1（#15）

> 状态：本任务（`task_ab7105f7-1f5d-4775-9752-9088b3543044`）的隔离实现与协议测试。它不是发布报告：PR、CI、main 合入、当前 ACMS 升级和真实宿主发布验收由后续发布任务按目标合同执行，未发生的事项不得在此声明完成。

## 1. 范围与版本

- 接口基路径：`/api/acms/agent/v1`，`apiVersion` 为 `1.0`，发现文件 `contractVersion` 为 `1`。
- 传输：HTTP/1.1，仅绑定 `127.0.0.1`，端口由操作系统分配（`listen(0, "127.0.0.1")`），拒绝非回环来源。
- 宿主：ACMS 插件进程启动时创建独立监听器；DSH 工作台是否打开不影响宿主插件运行。监听器属于插件 owned resource，关闭时有限等待并释放，不产生常驻子进程。
- 版本策略：`v1` 只做向后兼容增量；破坏性变更新建 `v2`，旧版至少保留一个发布周期并返回 `Deprecation`/`Sunset` 头。

## 2. 启用、发现与凭据

### 2.1 自动启用

`src/host/index.js` 在创建公司、工作区、执行适配器和调度器后调用 `createAgentApi(runtime, { dataDir })` 并 `start()`；生命周期 `ctx.effect` 在插件卸载时按监听器 → 会话 → 调度器 → 数据库的顺序释放资源，且该钩子在开始启动前就已注册。任一步启动失败（包括监听器已绑定但发现文件原子发布失败）都会先走同一套幂等清理：关闭监听器、取消会话、停止调度器并释放租约、关闭数据库，然后向宿主抛出启动错误，不会静默降级或遗留已监听端口、调度器或发现文件临时文件。

数据目录默认值为 `ACMS_DATA_DIR` 或 `%DSH_HOME%/acms`，与现有 ACMS 数据库一致。

### 2.2 发现文件

启动成功后原子写入 `<dataDir>/agent-api.json`（临时文件 + rename），关闭时仅删除本实例的发现文件：

```json
{
  "contractVersion": 1,
  "apiVersion": "1.0",
  "baseUrl": "http://127.0.0.1:54321/api/acms/agent/v1",
  "instanceId": "uuid",
  "pid": 1234,
  "startedAt": "2026-11-07T06:30:00.000Z",
  "transport": "http-loopback",
  "auth": "bearer"
}
```

发现文件只说明服务位置与版本，不授予任何权限。客户端按 `--url` > `ACMS_AGENT_URL` > 发现文件的顺序解析；发现文件存在但连接失败时报 `DISCOVERY_MISSING`/连接错误，不静默换端口。

### 2.3 签发凭据（owner-only，面板“外部接入”入口）

普通 owner 在 ACMS 面板左侧 **外部接入** 页面填写名称、项目范围、可选目标范围、允许命令与有效期，点击 **签发凭据** 即可。明文 token 只在创建响应/页面显示一次；撤销与脱敏列表也在同一页面。
页面目标范围提示、签发结果与凭据列表按同一并集语义展示：指定的目标不会排除该凭据后续提交的目标。

完整首次接入步骤（签发、保存 token、关闭工作台、CLI 使用、撤销与失败路径）见 [external-agent-onboarding.md](external-agent-onboarding.md)。该入口的受信宿主模拟证据见 `docs/iteration-2-autonomy-sources/external-onboarding-ui-receipt.json`；升级后真实宿主上的重做仍是发布验收项。

> 测试与 CI：公开 ACL 块由 `scripts/onboarding-doc.mjs` 在子 PowerShell 进程中执行；子进程不继承宿主 `PSModulePath`（只影响子进程，不修改宿主环境），ACL 夹具删除前先 `icacls /reset`。Windows PowerShell 5.1 手工执行若报 `Microsoft.PowerShell.Security` 重复 TypeData/无法加载，可先在当前窗口 `Remove-Item Env:PSModulePath` 后重试。相应回归在 `test/external-onboarding-doc.test.js`（5 项，含伪造模块路径与目标范围并集文案场景）。

凭据只能由 owner 或 system 创建，`token` 明文只在创建响应中出现一次，数据库只保存 `sha256(token)` 与前缀：

```json
{
  "name": "外部用户代理",
  "projectIds": ["project_..."],
  "goalIds": [],
  "allGoals": false,
  "projectCreate": false,
  "commands": ["goal.submit", "status.read", "events.read", "interaction.answer"],
  "expiresAt": null
}
```

- `commands` 可包含 `goal.submit`、`status.read`、`events.read`、`interaction.answer`、`task.pause`、`task.resume`、`project.create`、`goal.pause`、`goal.resume`、`goal.cancel`。默认仍为前四项。
- `allGoals=true` 只允许只读命令子集（`status.read`、`events.read`），用于项目内只读监控。
- `projectCreate=true` 只允许 owner 签发，且 `commands` 必须包含 `project.create`；反向也必须同时成立。
- `goalIds` 必须属于 `projectIds` 中的项目，且目标未删除。
- `updateScope` 支持整体替换范围字段并增加 `revision`；`expectedRevision` 不匹配返回 409 `REVISION_CONFLICT`；token 不变。
- `revoke` 将 `status` 置为 `revoked`；撤销/过期的 token 一律 401。
- 快照和面板只暴露 `id`/`name`/`scope`/`status`/`tokenPrefix`/`lastUsedAt`/`expiresAt`，不暴露 `tokenHash`。
- `agentCredential.create` 的幂等记录只持久化脱敏后的 `credentialView`（不含明文 token）；同一幂等键重放返回 `{credential, tokenOmitted: true}`，明文 token 只在首次成功响应中出现一次，不会从数据库或重放路径再次返回。

## 3. 身份与授权

- 身份只来自 `Authorization: Bearer <token>` 与数据库中的凭据记录；请求体、查询参数或自定义头里的 `actor`/`owner`/`kind`/`grants`/`principal` 一律被 schema 拒绝（`additionalProperties=false`），不能伪造 owner。
- 领域层新增 `user-agent` 主体，稳定身份投影为 `{kind:"user-agent", id:"cred_...", onBehalfOf:{kind:"user", id:"owner"}}`；投影不含 `grants`、`scope`、`revision` 等可变字段。
- `Company.authorize` 的 `user-agent` 分支在写事务内重新读取凭据状态、到期时间和当前范围，并校验命令、目标与范围；owner/agent/system 路径语义不变。
- 目标级范围：`goalIds` 明确列出、或目标由该凭据提交（`goal.source.principalId`）、或只读且 `allGoals=true` 时目标项目在 `projectIds` 内。写操作不接受 `allGoals` 放行。
- 项目级范围：`projectIds` 明确列出，或项目由该凭据创建。
- 越权返回 403 `SCOPE_DENIED`；命令不在白名单返回 403 `FORBIDDEN`；owner-only 操作返回 403 `OWNER_REQUIRED`。错误消息不包含 token、数据库路径或堆栈。
- 所有数据读取端点统一执行命令检查：`/status`、`/projects`、`/projects/{id}`、`/goals`、`/goals/{id}`、`/tasks`、`/tasks/{id}`、`/reviews`、`/blockers` 都要求 `status.read`，`/events` 要求 `events.read`，`/discover` 只要求有效凭据。缺少读取命令时返回 403 `FORBIDDEN`，不会因为目标或项目在范围内而放行。

## 4. 端点

所有路径相对 `baseUrl`。GET 无副作用；POST 必须提供幂等键。

| 方法 | 路径 | 命令 | 说明 |
| --- | --- | --- | --- |
| GET | `/discover` | 任意有效凭据 | 版本、操作清单、限额、实例 ID |
| GET | `/status?goalId=` | `status.read` | 目标、任务、attempt、artifact 元数据、pending interaction、verification、cursor、modelPreferences |
| GET | `/projects` | `status.read` | 凭据范围内的项目摘要 |
| GET | `/projects/{id}` | `status.read` | 项目摘要与检查配置 |
| GET | `/goals` | `status.read` | 范围内目标摘要 |
| GET | `/goals/{id}` | `status.read` | 目标、任务与当前阻塞 |
| GET | `/tasks?goalId=&status=` | `status.read` | 任务列表，最多 200 条 |
| GET | `/tasks/{id}` | `status.read` | 任务、依赖、attempt、artifact、verification、审查与阻塞 |
| GET | `/reviews?goalId=` | `status.read` | 审查任务与 verification 摘要（含 `reviewTaskId` 关联） |
| GET | `/blockers?goalId=` | `status.read` | 仅 pending interaction |
| GET | `/events?goalId=&after=&limit=&wait=` | `events.read` | 按目标增量事件与长轮询 |
| POST | `/goals` | `goal.submit` | 提交目标与约束，创建目标与规划任务 |
| POST | `/projects` | `project.create` + `projectCreate=true` | 仅创建受限项目（强制 `autoMerge=false`、`checks=[]`） |
| POST | `/interactions/{id}/answer` | `interaction.answer` | 回答 pending interaction；`additionalRuntimeMs>0` 仅 owner |
| POST | `/tasks/{id}/pause` | `task.pause` | 任务级暂停 |
| POST | `/tasks/{id}/resume` | `task.resume` | 任务级恢复；blocked 需先回答交互 |
| POST | `/goals/{id}/pause` | `goal.pause` | 暂停目标，默认立即停止。传入 `afterCurrent: true` 等待当前执行结束 |
| POST | `/goals/{id}/resume` | `goal.resume` | 解除目标暂停，保留单任务暂停与其他阻塞 |
| POST | `/goals/{id}/cancel` | `goal.cancel` | 取消目标，保留历史交付、审查和已合入记录 |

目标控制请求需要 `expectedRevision` 和稳定幂等键，使用 `GET /goals/{id}` 返回的目标 `revision`。暂停和取消可填写 `reason`。授权范围仍限凭据明确指定或由该凭据提交的目标，且需逐项授予相应控制命令。目标详情的 `controlSummary.phase` 区分 `draining`、`stopping`、`reconciling`、`paused` 和 `cancelled`。取消后可创建新目标开展后续工作。

不提供：外部创建任意任务、修改 agent/policy/template、公司级暂停/恢复、删除/purge、读取原始数据库或 token、跨目标查询。

### 4.1 目标提交

`POST /goals` 的请求体为 `GoalSubmitRequest`：`title`、`description`、`acceptance`、`projectId` 必填；`constraints`（最多 20 项，`{key,text}`）与 `priority`（0–100）可选；`requestId` 为传输幂等字段。创建的目标写入 `source={kind:"user-agent", principalId, onBehalfOf, requestId, submittedAt, transport}`，并写一条 `goal.submitted` 审计事件（`decision.kind=user-constraint`）。返回 `{goalId, planTaskId, cursor}`。

### 4.2 响应 envelope

成功：

```json
{ "ok": true, "apiVersion": "1.0", "requestId": "...", "instanceId": "...", "replayed": false, "value": {} }
```

失败：`{ok:false, apiVersion, requestId, error:{code, message, details, retryable}}`。所有响应带 `cache-control: no-store`、`x-acms-api-version: 1.0`、`x-acms-request-id`。

### 4.3 状态与审查读取

`GET /status` 的 `modelPreferences` 读取与界面快照相同的 SQLite 实体（集合 `modelPreferences`，单例 id `model`），无记录时返回 `{id:"model",order:[],revision:0,updatedAt:null,updatedBy:null}`；保存或清除后 `order`、`revision` 与界面一致。该读取不启动模型，也不触发 model-check/model-details。

目标的 `contractVersion` 是当前合同版本，`completedContractVersion` 是最近通过验收的版本。要求或验收变化后，`contractChange.status=pending` 表示等待负责人评估，`deliveryHash` 已指向新合同。任务与核验证据保留其 `goalContractVersion`，任务级审查通过 `reviewedContractVersion` 关联被审交付的版本。负责人确认后，`contractChange.decision` 记录沿用成果和后续工作；历史证据仍可查询。

`GET /reviews` 返回 `reviews`（审查任务视图）与 `verifications`。每条 verification 保留源任务 `taskId`、审查任务 `reviewTaskId`、`kind`（`review` 或 `goal-review`）、`passed`、`summary`、`artifactHash` 与 `createdAt`；`reviewTaskId` 由审查 attempt 关联，批准与退回都会记录。审查是用户按需添加的独立子任务，未配置审查时 `reviews` 为空，表示“未审查”，不是失败。任务视图包含 `reviewScope`（`goal` 或 `task`）与 `passed`。`GET /tasks/{id}` 对审查任务同样返回其 verification（附 `reviewTaskId`），对源任务返回关联审查任务列表。读取仅查询 SQLite，不启动模型。

## 5. 幂等

- 外部写请求必须提供 8–200 个可见 ASCII 字符（U+0021–U+007E，无空白）的幂等键：请求头 `Idempotency-Key` 或 body `requestId`，两者完全等价。
- 两者同时出现必须逐字节相同，否则 400 `IDEMPOTENCY_KEY_MISMATCH`；都缺失 400 `IDEMPOTENCY_REQUIRED`；重复同名请求头 400 `INVALID_REQUEST`。
- 内部键为 `ext:` + `sha256(credentialId + "\\0" + externalKey)` 的前 32 个十六进制字符；命名空间是 `(credentialId, externalKey)`，不同凭据可用相同键。
- 指纹使用稳定身份投影 + 命令名 + 剥离 `requestId` 后的业务参数（路径 ID 保留）；不包含授权快照。
- 事务顺序：`BEGIN IMMEDIATE` → 同步 `precheck`（重新鉴权/范围）→ 读旧命令 → 指纹比较或执行。撤销/过期 → 401；命令被移除 → 403 `FORBIDDEN`；目标被移除 → 403 `SCOPE_DENIED`；这些情况不读取旧结果。
- 同键同参重放返回原结果并带 `replayed:true`，不重复业务效果、事件或调度；同键不同操作/参数 409 `IDEMPOTENCY_CONFLICT`。凭据创建的幂等记录只保存脱敏视图，重放不会返回明文 token。
- 只有成功提交才持久化幂等记录；失败事务整体回滚，不占用键。并发重试由 SQLite 写事务串行化。
- 重启后 `commands` 表与事件游标仍在同一 SQLite 数据库；同一键继续重放。

- SQLite 写锁竞争（另一个连接或进程持有 `BEGIN IMMEDIATE`）在 `busy_timeout` 后返回 503 `ENGINE_BUSY`、`retryable:true`，不会退化为 500 `INTERNAL`；客户端应以同一幂等键退避重试，锁释放后只产生一次业务效果。

## 6. 事件游标

- 全局单调 `seq`；`after` 为排他下界。
- `nextCursor` 是本次已扫描的最大 seq（包含被过滤掉的事件），不是最后一条返回事件的 seq；`latestCursor` 是请求开始时的最大 seq；`hasMore = nextCursor < latestCursor`。
- `limit` 1–200（默认 100）；`wait` 0–20000 毫秒（默认 0），有匹配事件、游标推进或超时即返回。
- `after` 非安全整数/负数 → 400 `CURSOR_INVALID`；`after > latestCursor` → 400 `CURSOR_AHEAD`。
- 长轮询在等待结束、读取事件之前重新解析 Bearer 凭据，并重做 `events.read` 命令、目标与项目范围检查；等待期间撤销或过期返回 401 `UNAUTHORIZED`，命令被移除返回 403 `FORBIDDEN`，目标范围收窄返回 403 `SCOPE_DENIED`，均不返回等待期间新增事件。复核与 `pageScoped` 读取之间没有 `await`，不会用旧授权读取或返回数据。
- 事件条目：`{seq, at, type, entityId, goalId, actor:{kind,id}, onBehalfOf, decision, data}`。`actor` 是实际调用主体，`onBehalfOf` 是代表的用户。
- GET 不调用调度器、不创建任务、不写业务事件；鉴权失败写宿主日志而不写数据库。

## 7. 错误码

见 `src/host/agent-api.js` 的 `ERROR_STATUS` 映射，主要码：`INVALID_REQUEST`、`CONTENT_TYPE`、`BODY_LIMIT`、`IDEMPOTENCY_REQUIRED`、`IDEMPOTENCY_KEY_MISMATCH`、`CURSOR_INVALID`、`CURSOR_AHEAD`（400）；`UNAUTHORIZED`（401）；`FORBIDDEN`、`SCOPE_DENIED`、`OWNER_REQUIRED`（403）；`NOT_FOUND`（404）；`METHOD_NOT_ALLOWED`（405）；`IDEMPOTENCY_CONFLICT`、`CONFLICT`、`REVISION_CONFLICT`、`WAITING_INPUT`、`TASK_CLOSED`、`ALREADY_ANSWERED`、`GOAL_BUDGET_EXHAUSTED`（409）；`ENGINE_BUSY`、`SHUTTING_DOWN`（503）。未知内部错误统一 500 `INTERNAL`，不泄露调用栈。

SQLite 的 `SQLITE_BUSY`/`SQLITE_LOCKED`（包括写锁超时）统一映射为 503 `ENGINE_BUSY`、`retryable:true`；仅未知错误映射为 500 `INTERNAL`，且不泄露调用栈。

## 8. 使用示例

### 8.1 CLI

```bash
node scripts/acms-agent.mjs discover --discovery <dataDir>/agent-api.json --token-file <tokenfile>
node scripts/acms-agent.mjs status --goal goal_... --token-file <tokenfile>
node scripts/acms-agent.mjs submit --project project_... --title "目标" --description "说明" --acceptance "验收" --constraint "scope=仅限本仓库" --token-file <tokenfile>
node scripts/acms-agent.mjs events --goal goal_... --after 0 --wait 5000 --token-file <tokenfile>
node scripts/acms-agent.mjs pause --task task_... --reason "暂时停止" --token-file <tokenfile>
node scripts/acms-agent.mjs resume --task task_... --token-file <tokenfile>
```

写命令默认自动生成幂等键；重试时用 `--request-id` 复用同一个键。CLI 只读写 token 文件与 HTTP，不直接打开数据库。

### 8.2 完整示例流程

```bash
ACMS_AGENT_URL=http://127.0.0.1:54321/api/acms/agent/v1 ACMS_AGENT_TOKEN=<token> node examples/agent-api/flow.mjs --project project_...
```

示例依次执行 discover → projects → 提交目标 → 读取状态 → 读取阻塞（如有则回答）→ 读取增量事件 → 暂停/恢复一个可控制任务 → 再次读取状态，并输出 JSON 摘要。脚本显式 `process.exit` 释放连接，不留下后台进程。

## 9. 部署与接入说明

1. 升级/安装包含本模块的 ACMS 插件；宿主启动后检查 `<dataDir>/agent-api.json` 是否存在且 `baseUrl` 可访问。
2. 由 owner 在 ACMS 面板 **外部接入** 页面签发凭据（见 [external-agent-onboarding.md](external-agent-onboarding.md)），把返回的 token 写入仅当前 Windows 用户可读的文件（例如 `%USERPROFILE%\\.dsh\\acms\\agent-token`），不要写入仓库、日志或 issue。
3. 外部智能体使用 CLI 或自己的 HTTP 客户端连接 `baseUrl`；所有请求带 Bearer token，写请求带稳定幂等键。
4. 只读监控使用 `allGoals=true` 且命令仅含 `status.read`/`events.read` 的独立凭据；该凭据不能写、不能触发模型或任务。
5. 宿主升级/重启后，旧 `agent-api.json` 若存在但连接失败，客户端应重新读取发现文件或报错，不能假设端口不变；幂等记录与事件游标会自动从 SQLite 恢复。
6. 数据库 schema 从 1 迁移到 2：事件表新增 `goal_id`、`principal_kind`、`on_behalf_of`，历史行按 actor 回填，index `events_goal_seq` 建立；旧版本宿主打开 schema 2 会被 `SCHEMA_VERSION` 保护拒绝，不会静默降级。

## 10. 测试与证据

协议测试：`node --test --test-concurrency=1 test/agent-api.test.js test/agent-api-lifecycle.test.js`。覆盖合法调用、缺失/无效/过期/撤销身份、伪造 owner/actor/grants、跨目标/跨项目、统一读取命令（含仅有 `goal.submit` 的凭据访问全部读取端点）、凭据签发与范围变更、明文 token 一次性与重放脱敏、项目授权创建、重复请求、两种幂等载体与长度/字符边界、重复请求头、同键异参、并发重试、授权变更后重试、事务内 precheck、回滚、事件续读/长轮询/越界、长轮询期间撤销/过期/范围收窄、重启重放、只读零模型调用、普通管理不触发模型检测、错误 envelope、CLI 与完整示例流程，以及发现文件发布失败后的监听器/调度租约/临时文件清理。新增 test/agent-api-integration.test.js 使用真实 HTTP 路由、临时 SQLite 与真实审查状态机，覆盖 /status 偏好空/保存/清除与 /reviews 批准/退回关联；全量 317/317 通过。

测试夹具使用内存/临时 SQLite、owner 命令和 stub 适配器，**不是真实模型执行证据**；真实宿主、真实凭据和真实模型调用属于发布任务的验收范围。

## 11. 已知限制

- 本任务未修改现场运行数据库、认证或 ACMS 元数据；未创建 PR、未合入 main、未升级当前 ACMS。
- `/status` 的 `modelPreferences` 直接读取与界面快照相同的 SQLite 记录（集合 `modelPreferences`，单例 id 为 `model`）；无记录时返回空偏好对象 `{id:"model",order:[],revision:0,updatedAt:null,updatedBy:null}`，不报错也不伪造。保存、清除后 revision 与顺序和界面一致；`attempt.selection` 在记录存在时返回实际选择。
- 审查是用户按需添加的独立子任务，只核对交付成果；外部接口不直接启动 attempt，也不创建审查任务。审查未通过时由负责人协调返工，被审任务保持已交付状态。外部接口只提交目标/回答/暂停恢复，执行由调度器按预算与并发领取。
- 当前测试不覆盖真实 Windows 防火墙、代理或多用户 ACL 场景；部署时依靠仅回环绑定与 token 文件权限。
- 启动失败清理用注入的发现文件发布失败在测试进程内验证（监听端口、调度租约、临时文件、清理钩子幂等），不等同于真实宿主崩溃或强制断电场景；后者仍由发布任务的现场升级/恢复验收覆盖。
