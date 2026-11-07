# 第 1 轮迭代发布检查清单（#2 / #3）

> 用途：外部发布负责人执行 GitHub PR、Windows CI、合入与现场升级时使用的门槛、证据与回滚清单。

> 版本：v1.2（2026-11-07T11:59+08:00 修订）。v1.1 针对独立审查提出的 5 项缺陷重写了门槛阶段、回滚顺序、部署前后判定、进程快照与证据命令。v1.2 删除回滚第 0 步与 G14 中「所有者书面接受残余清理风险」的例外：只有证实本次拥有的执行及子孙进程全部停止，才允许恢复数据、切换版本并启动旧 host；证据不足时保留 reconciling 与资源占位（attempt 占位及 cleanupPending/cleanupUncertain 标记）并停止切换。修订对照见第 11 节。

> 编写时状态（2026-11-07T11:49+08:00）：尚未创建 PR、尚未运行 Windows CI、尚未合入 main、尚未做现场备份，也未部署或回滚。除第 1 节基线核对和第 3 节只读进度快照外，所有门槛默认「待验证」。

> 本文只定义流程与证据要求，不执行 PR、合入、发布、现场切换或回滚，不修改原始源目录、数据库、插件、认证、公司策略或 .acms 输入。开发完成、文档完成、任务创建、合入、部署均不等于发布完成。

## 1. 基线与两个实现任务

| 项 | 值 |
| --- | --- |
| 仓库 | D:\ACMS（GitHub https://github.com/moudi01/dsh-ACMS） |
| 基线提交 | main @ 8d4b2b034c7387395bed61a328b4f64d367980e1 |
| 本轮目标 | goal_ee7cd3dc-593a-4b6b-b3ed-c79d4789b96d：第 1 轮迭代，只处理 #2 异常恢复与 #3 进程树清理 |
| #3 实现任务 | task_23e3280c-3a18-4568-bd06-410f3b9feee9：「#3：有限时清理自有进程树并保留不确定执行占位」 |
| #2 实现任务 | task_456ee225-f835-4168-a5ec-427dec292757：「#2：校验执行身份并恢复配对运行结果，整合 #3 完整改动」 |
| 本清单任务 | task_6d38f685-98b7-44a2-80f8-d332127dd259：「本轮发布检查清单」 |

基线核对证据：2026-11-07T11:49+08:00 在清单工作副本执行 `git log --oneline -5`，HEAD、main、origin/main 均为 8d4b2b0（Fix Windows CI path assertions and streamed-message race (#12)）。该核对只证明起点，不证明后续发布状态。

范围约束：

1. 两个 issue 对应一个 GitHub PR，base 为上述基线。
2. #2 依赖 #3，但依赖不会自动合并代码。#2 必须先从自己的 CONTRACT.inputArtifacts 读取 #3 的最终交付，按每条记录的 originalPath 把完整文件合入隔离副本，逐文件核对字节一致后再在其上开发；#2 的交付必须是同时包含 #2 与 #3 全部最终改动的完整文件集合，适合单个 PR。
3. 发布由外部发布负责人 Codex 执行。开发或文档完成只表示具备送审条件，不表示可以发布。
4. 本轮禁止在 ACMS 子任务内发布、切换现场 host，或修改原始源目录、数据库、插件、认证、公司策略。

## 2. 责任分工

| 角色 | 负责 | 不得负责 |
| --- | --- | --- |
| #3 开发执行员 | #3 源码、测试、docs/iteration-1-issue-3.md | 审查自己的交付 |
| #2 开发执行员 | 合入 #3 完整文件后的 #2 源码、测试、docs/iteration-1-issue-2.md | 审查自己的交付 |
| 独立审查员 | 审核实际源码、边界测试与宿主证据；角色须与作者不同 | 自审或替作者填写审查结论 |
| 外部发布负责人 Codex | PR、CI、合入、现场备份、部署、加载核对、基本功能验证、必要时回滚 | 在清理不确定或证据不足时强行升级 |
| 所有者 | 发布范围与最终升级决定；处理人工门槛 | 把开发完成当作发布完成 |

## 3. 当前进度快照（只读观察，不等于验收）

| 项 | 观察值 |
| --- | --- |
| #3 实现任务 | running（编写本文时） |
| #2 实现任务 | blocked，等待 #3 |
| #3 与 #2 的独立审查 | 尚未开始 |
| GitHub PR | 未创建 |
| Windows CI | 未运行 |
| 现场备份、部署、版本加载核对、回滚 | 未执行 |

以上来自清单作者对 ACMS 与工作副本的只读观察（2026-11-07T11:49+08:00）；后续以 ACMS 实际记录和外部证据为准。该快照不构成本清单任何门槛的通过证据。

## 4. 状态字段、阶段与判定规则

每个门槛填写以下字段，缺任一项即视为未通过：

- 状态：待验证 / 通过 / 失败 / 不适用。没有实际证据时只能写「待验证」。
- 证据位置：可复核的绝对路径、GitHub URL 或 CI run URL；本地日志保留原文件，不覆盖、不改写。
- 提交版本：Git commit sha（未合入时用 PR head sha，至少 40 位）；部署类门槛另填 host revision（16 位）。
- 验证时间：ISO 8601 含时区，例如 2026-11-07T12:00:00+08:00。
- 责任人：实际执行者角色；审查类必须是作者以外的角色。

通过必须同时满足：实际执行过（非转述）、有原始输出或 URL、版本一致、时间可追溯、责任人明确。截图、命令输出或 CI 结果缺失时不得写「通过」。

**阶段划分（修正门槛循环）：**

| 阶段 | 门槛 | 允许的动作 | 不得混同 |
| --- | --- | --- | --- |
| A 升级前置 | G1–G14 | 在 G1–G14 全部「通过」后，才允许执行 G15 | G15、G16 不是开始升级的前置条件；不得要求它们先完成 |
| B 部署执行 | G15 | 构建、切换 profile 入口、重载/重启并核对新 host 加载 | G15 成功不等于发布完成 |
| C 发布完成 | G16 + 所有者签署 | 部署后基本功能与恢复界面验证、收尾、签署 | G16 必须在 G15 之后评估；未完成不得称发布完成 |

判定口径：

1. **允许开始升级**：仅当 G1–G14 全部为「通过」，且 G13、G14 的证据在部署窗口内仍然有效。
2. **允许宣告发布完成**：G1–G16 全部为「通过」，并由所有者签署；其中 G15 只能在 G1–G14 通过后执行，G16 只能在 G15 通过后评估。
3. 任何前置门槛为「失败」「待验证」或证据不足：停止在部署前，按第 6.1 节处理，不属于回滚。
4. 已切换现场后 G15 或 G16 失败：按第 6.2 节回滚或中止切换。

**关键区分：**“G1–G16 全部通过才能升级”是错误表述，会把部署后的验证当作部署前提。正确表述是“G1–G14 全部通过才能部署；G1–G16 加所有者签署才叫发布完成”。

## 5. 发布门槛与所需证据

G1–G14 是升级前置；G15 是部署执行；G16 是部署后完成条件。表格中的「阶段」列用于防止混用。

### 5.1 开发、交接与独立审查（G1–G6）

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G1 | 前置 | #3 交付完整：ACMS #3 任务交付的新增和修改源文件、测试文件全部列入 artifacts，并附 docs/iteration-1-issue-3.md；文档记录原因、改动、实际测试命令与结果、局限；测试包含真实子/孙进程用例和注入失败用例（父进程先退出、自然退出竞态、拒绝访问、taskkill 缺失或失败、清理超时） | 文件可从 artifact 或 PR diff 复核；测试可运行；#3 的取消、超时、stdout 上限、启动失败均走有限时清理；无法证实进程树退出时标记 cleanupUncertain、保留资源占位并进入 reconciling，禁止重复派发与自动修复；只操作本次拥有的 PID，保留可诊断原因 |
| G2 | 前置 | #3 独立审查：由与作者不同角色的审查任务完成，审查记录说明核对了实际源码、边界测试与宿主证据，不是只读摘要；不得自审 | 审查通过且对应 PR head commit；findings 已修复或有明确不阻断理由；审查人不是 #3 作者 |
| G3 | 前置 | #2 合入 #3 后交付：从 #2 CONTRACT.inputArtifacts 读取 #3 最终交付，按 originalPath 合入完整文件，提供逐文件 sha256 或字节一致证据，确认 #3 修复未被覆盖；#2 交付包含两个 issue 的全部最终改动与 docs/iteration-1-issue-2.md，适合单个 PR | 合入前后哈希对照可复算；#3 的代码与测试仍存在；单一 PR 可完整承载；无依赖缓存或缺文件 |
| G4 | 前置 | #2 功能完整：统一 paired runner 与 Codex app-server 的进度查询与恢复；持久化或可推导真实 run key（现状写入见 src/adapters/paired.js:122-123，查询口径见 src/adapters/dsh.js:211-216）；校验 provider、model、attemptId、contextKey、generation；区分任务与审查、持久与非持久；已结束且已清理的可靠回执直接恢复结果、不得重调模型；确定停止但无完整结果才可重试；运行、锁或状态不确定保持 reconciling；界面显示真实原因与可采取操作。测试覆盖跨宿主进程重启、崩溃、结果完成未入库、非持久、损坏状态、身份错配；不得用模拟模型文本冒充真实模型 | 源码、测试、文档三处一致；新增测试在 Node 内置测试中可运行；不存在绕过身份校验、串用结果或盲目重试的路径 |
| G5 | 前置 | #2 独立审查：与 #2 作者不同角色的审查通过，且审核的是含 #3 的完整改动集；审查人不得是任一实现任务作者 | 审查结论批准并对应最终 commit；findings 与实际 diff 一致；无自审或代审 |
| G6 | 前置 | 交接清单与哈希：发布负责人拿到两张 artifact 清单（ACMS 路径、originalPath、sha256、字节数）与 git diff --stat；所有新增和修改的源文件、测试文件都在内；不含 .acms、临时日志、node_modules、test-results、数据库、profile 或凭据 | 清单与 PR diff 一致；禁止项为零；哈希可复算；交付是完整文件而非补丁片段（#2 尤其） |

### 5.2 代码质量与宿主证据（G7–G9）

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G7 | 前置 | 静态检查：在 PR head commit 的隔离副本运行 npm run check（即 node scripts/check.mjs），退出码 0，输出 Syntax and package contract checks passed.；由发布负责人或 CI 在目标 commit 上执行 | 命令、完整输出、退出码、commit、时间、责任人齐全；只跑新增测试或改写输出不算通过 |
| G8 | 前置 | 全部核心测试：同一 commit 运行 npm test，即 node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs，Node 24，退出码 0；记录通过、失败、跳过数量与新增测试名；日志原样保存 | 完整套件（非子集）0 失败；失败或跳过必须解释；本地沙箱权限导致失败时标注为受限并补宿主证据，不得写成通过 |
| G9 | 前置 | 宿主 owner check：在隔离仓库副本中，以 `Push-Location <隔离副本>`；`& "C:\Program Files\nodejs\node.exe" "D:\ACMS\test-results\iteration-1\owner-check.mjs"` 运行；工作目录必须是 `C:\Users\Administrator\.dsh\acms` 下 workspaces、reviews 或 integration 的隔离副本；超时 420000 ms；脚本依次运行 scripts/check.mjs 与全部核心测试，并打印 command、args、cwd | 退出码 0，输出保留；执行机器、commit、时间记录；由宿主或发布负责人执行，不能由开发者用总结代填；该脚本在缺依赖时会先在 cwd 运行 npm ci --offline --ignore-scripts，因此必须在隔离副本执行，离线缓存不可用时如实记录为受阻 |

### 5.3 GitHub PR、CI 与合入（G10–G12）

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G10 | 前置 | 单一 PR 关联 #2/#3：GitHub PR URL；base=main；head=最终审查过的 commit；标题与正文同时关联 #2 与 #3（写明两个 issue 编号并链接 ACMS 任务或说明对应关系）；changed files 与交接清单一致 | PR 可打开，base/head 正确，无无关改动、无强制推送掩盖历史，关联关系可复核 |
| G11 | 前置 | Windows CI 通过：workflow ACMS validation 在 pull_request 上运行，runs-on windows-latest，Node 24，步骤 npm ci、npm run check、npm test、npm run build、npm run test:ui、npm run test:usability、npm run test:structure 全部成功；提供 run URL、commit、时间与 acms-ui-evidence artifact | CI 成功且步骤无失败或取消；PR head 与 CI commit 相同；任一步失败不得合入 |
| G12 | 前置 | 合入 main：PR 正常合入 main（非 force push）；记录 merge commit sha 与合入时间；main HEAD 包含两个修复；按仓库要求记录审查批准与保护分支状态 | GitHub 可核对 merge commit 与文件；main 相对基线的差异仅本轮范围；合入后再次运行的 CI 须通过 |

### 5.4 现场升级前置：备份、空闲与清理（G13–G14）

执行顺序：先做 G14 的空闲/清理核对（宿主仍在运行，只读查询），再停机并按 G13 备份；G14 证据必须在停机前采集。

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G13 | 前置 | 备份与回退版本：在 G14 通过后停止 DSH 宿主；备份完整数据目录（company.db 及 WAL、artifacts、workspaces、pairing、install-backups）并记录项目 Git 状态或 bundle；记录升级前 profile 配置、当前 host 文件与 sha256、host revision、可用回退版本（安装包或已验证提交）。按 docs/operations.md，不要只复制 company.db 而忽略 WAL | 备份路径、大小、sha256、时间、责任人齐全；回退版本实际可取得；发布负责人已核对回退流程，不只记录哈希 |
| G14 | 前置（阻断） | 空闲与清理：宿主停机前以只读方式核对——attempts 中没有 preparing、running、cancelling、reconciling，也没有 cleanupPending=1；如 #3 新增独立持久字段 cleanupUncertain（或等价字段），该字段计数也必须为 0；conversationMessages 中没有 sending、streaming、restarting，也没有 cleanupPending=1（与 scripts/deploy-live.mjs:24、:26 条件一致）。核对合并后 commit 的 checkIdle 是否覆盖 #3 的清理不确定标记；未覆盖时，必须在部署窗口内用只读查询证明相关计数为 0；无法证明计数为 0 时一律「不具备升级条件」并停止，不得以所有者接受残余风险代替只读证据。另需完整进程快照与归属核对证明无本项目拥有的不明子/孙进程遗留，详见第 7.5 节。 | 查询计数均为 0；存在 cleanupUncertain、未解决 reconciling、cleanupPending 或清理证据不足时，一律「不具备升级条件」并停止；不得删除锁、修改数据库、重复派发或强杀未知 PID 绕过；进程快照不完整或无法归属时阻断 |

### 5.5 部署执行（G15，仅当 G1–G14 全部通过）

仅当 G1–G14 全部为「通过」时，才允许外部发布负责人执行本阶段。G15 是部署动作本身，不是开始升级的前置条件。

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G15 | 部署执行 | 构建部署与版本加载：在合并后 main 的干净隔离检出执行 `npm ci`、`npm run build`、`node scripts/deploy-live.mjs <profile>`；脚本输出 `ACMS host <revision> published to <profile>`；记录 dist/host-<revision>.mjs 的 sha256、dataDir/install-backups 下新生成的配置备份、profile 中 ACMS 入口指向该文件；重启宿主或按 DSH 方式重载并刷新页面，核对宿主加载的是该 revision | 部署日志、revision、文件名与 sha256 一致；profile 入口可复核；宿主加载无插件错误；无法证明加载的是新版本时视为未加载，不得写「通过」。部署脚本的 checkIdle 若因活动执行、reconciling 或 cleanupPending 拒绝，属于部署前阻断，按第 6.1 节停止，不进入回滚；此时 profile 入口尚未改变，但可能已生成 dist 文件，记录即可 |

补充：`scripts/deploy-live.mjs` 在开始时执行一次 checkIdle，在写入 profile 前再执行一次。第二次拒绝时仅可能已写入 dist 文件，live profile 未切换；不得把这种情况写成「已部署后回滚」。部署用的检出目录必须持久保留（profile 入口指向该目录的 dist/host-<revision>.mjs），不得在部署后删除，否则下次重载会找不到宿主文件。

### 5.6 发布完成（G16，部署后）

G16 只在 G15 已通过且新 host 已接管后评估；它是发布完成条件，不是升级前置门槛。

| 编号 | 阶段 | 门槛与所需证据 | 判定条件 |
| --- | --- | --- | --- |
| G16 | 部署后完成 | 基本功能与现场收尾：刷新后核对侧边栏、公司总览、任务工作台、任务详情、回收站、模型列表可打开且无报错；如存在已结束或曾中断的任务，抽查其恢复或清理界面是否显示真实原因与可执行操作（不调用真实模型、不改业务状态）；保存截图与页面控制台无错误证据；再次采集完整进程快照并确认无不明执行进程；记录最终 commit、host revision、profile、备份与回滚路径，并由所有者签署 | 基本功能正常；只能靠模拟数据或改库得到的证据无效；若不存在可抽查任务，明确记录未覆盖该路径，不得伪造；所有者签署升级结论后才算发布完成 |

### 5.7 门槛登记表

缺少证据一律保持「待验证」，不得预填「通过」。

**升级前置（G1–G14）**

| 编号 | 门槛 | 状态 | 证据位置 | 提交版本 | 验证时间 | 责任人 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | #3 交付 | 待验证 | | | | |
| G2 | #3 独立审查 | 待验证 | | | | |
| G3 | #2 合入 #3 并交付 | 待验证 | | | | |
| G4 | #2 功能与测试 | 待验证 | | | | |
| G5 | #2 独立审查 | 待验证 | | | | |
| G6 | 交接清单与哈希 | 待验证 | | | | |
| G7 | 静态检查 | 待验证 | | | | |
| G8 | 全部核心测试 | 待验证 | | | | |
| G9 | 宿主 owner check | 待验证 | | | | |
| G10 | 单一 PR 关联 #2/#3 | 待验证 | | | | |
| G11 | Windows CI | 待验证 | | | | |
| G12 | 合入 main | 待验证 | | | | |
| G13 | 备份与回退版本 | 待验证 | | | | |
| G14 | 空闲与清理（阻断） | 待验证 | | | | |

**部署与发布完成（G15–G16）**

| 编号 | 门槛 | 状态 | 证据位置 | 提交版本 | 验证时间 | 责任人 |
| --- | --- | --- | --- | --- | --- | --- |
| G15 | 部署与版本加载 | 待验证 | | | | |
| G16 | 基本功能与收尾 | 待验证 | | | | |

判定：

- **升级放行**：G1–G14 全部「通过」才允许开始 G15。任何一项非「通过」→ 不得部署。
- **发布完成**：G1–G16 全部「通过」且所有者签署。G15、G16 不得倒置为升级前置条件。

## 6. 中止与回滚决策

先判断现场是否已经改变：profile 中 ACMS 入口未切换、新 host 未接管，属于第 6.1 节；已经切换或已加载新 host，属于第 6.2 节。不得把部署前阻断写成回滚，也不得在活动执行未结束时通过重启现场来「重试」。

### 6.1 部署前阻断（现场未切换，不执行回滚）

**适用**：G1–G14 任一未通过；PR/CI/合入失败；备份或回退版本不可用；清理不确定或进程证据不足；deploy 的 checkIdle 拒绝；构建失败；profile 入口尚未切换前的任何失败。

**触发条件**：

1. 任一前置门槛为「失败」「待验证」或证据不足。
2. PR 的 Windows CI 失败，或同一 commit 重跑仍失败；PR 与交接清单、最终审查 commit 不一致，或包含禁止文件。
3. 合入后 main 的 CI 失败，或合并提交缺少任一 issue 的修复。
4. 备份缺失、不可读，或回退版本不可取得。
5. 存在 cleanupUncertain、未解决的 reconciling、cleanupPending、无法归属的进程，或进程快照不完整。
6. `node scripts/deploy-live.mjs <profile>` 的 checkIdle 因活动执行、reconciling 或 cleanupPending 拒绝。
7. 构建失败，或部署产物与目标 commit、哈希不一致，且 profile 入口尚未改变。
8. 无法证明目标 commit、PR head 或部署产物来源。

**处理步骤**：

1. 停在当前阶段；不运行或不再运行部署；不切换 profile 入口；不为了「重试」而停止或重启现场 host。
2. 记录触发条件、阶段、命令、完整输出、commit、时间和责任人，把对应门槛标为「失败」。
3. 若因活动执行被拒绝：等待执行自然结束并按 #3 语义完成清理；不得强杀未知 PID、删除锁、修改数据库或重复派发。无法证实清理完成时保持阻断/reconciling 并保留诊断证据。
4. 修复原因；若 commit 变化，重新从受影响的最早门槛开始核验，不能只重跑失败的那一步。
5. 部署脚本在 checkIdle 拒绝前可能已生成 dist 文件；记录该文件及哈希，不把它当作 live 变更，也不因此触发回滚。
6. **不进入第 6.2 节**，除非 profile 入口已经改变或新 host 已经接管。

### 6.2 部署后回滚（现场已切换或已加载新 host）

**触发条件**（仅在 profile 入口已切换或新 host 已接管后适用）：

1. 新 host 加载失败、ACMS 不可用、插件加载报错。
2. 基本功能或恢复/清理界面出现回归。
3. 出现重复派发、结果串用、错误重试、身份错配等恢复异常。
4. 部署后发现 cleanupUncertain、未解决 reconciling、cleanupPending 或不明执行进程。
5. 无法证明新 host 已实际加载（入口、revision、sha256 不能互证）。
6. 数据或状态异常，且无法在当前版本内安全恢复。
7. 所有者决定回滚。

**执行顺序（外部发布负责人）：**

0. **清理不确定时先停止切换。** 若无法证实本次拥有的执行及子孙进程已停止，或存在 cleanupUncertain、未解决 reconciling，不得切换 profile 入口、不得重启到另一个版本、不得强杀 PID。当前 host 若仍能安全完成清理，保持其运行并保留 reconciling 占位与诊断证据；若当前 host 已无法安全运行而必须停机，只停机一次并保存现场。步骤 1–3 可立即执行，但第 4–6 步（恢复数据、切换版本、启动旧 host）只有在清理结论为「已证实本次拥有的执行及子孙进程全部停止」后才允许执行。本清单不提供「所有者书面接受残余清理风险后继续切换」的例外：清理证据不足时一律停在步骤 3，保持 reconciling 与资源占位（attempt 占位及 cleanupPending/cleanupUncertain 标记），保留完整进程快照与诊断证据并等待人工处置，不得启动旧 host。
1. 判定与记录：确认触发条件，记录当前 commit、host revision、profile、时间、症状、截图和日志，不要只写在聊天里。
2. 停止新增工作：暂停公司调度，阻止新派发；不删除任务、不清理数据库、不删锁。
3. 必要时停止宿主：仅在安全需要时停机一次；保存进程快照、数据目录和配置。停机后不要先启动任何版本。
4. **先判定数据兼容性，再启动旧 host。** 在宿主停止状态下判断新版本是否写入了旧版本无法读取的数据/结构/状态；若不能证明兼容，先从升级前完整数据目录备份恢复（company.db 与 WAL、artifacts、workspaces、pairing 等按实际受影响范围），再启动旧版本。兼容性有证据时可不恢复数据。
5. 恢复宿主入口：把 profile 中 ACMS 入口改回升级前的 dist/host-<previous>.mjs；或复制 dataDir/install-backups/<profile>-before-host-<timestamp>.yml 覆盖 profile 配置，覆盖前再备份当前配置一次。
6. 启动旧 host 并刷新页面；核对 profile 入口、文件哈希与宿主加载的 revision，确认旧版本基本功能正常。
7. 复核运行状态：确认无未知执行进程；attempts 中没有新增 running、reconciling、cleanupUncertain 或 cleanupPending；审查与恢复记录未被篡改。
8. 记录与上报：把回滚证据填入第 5.7 节，状态改为失败或已回滚，通知所有者，并生成下一轮 issue。

**禁止事项：** 不得通过改数据库、删除锁、重复派发或强杀未知 PID 来制造已恢复的表象；不得在清理不确定时先启动旧 host 再处理数据兼容性；不得以「所有者接受残余风险」或人工口头保证豁免清理证实门槛。

## 7. 证据采集命令（区分只读与写操作）

### 7.1 工作目录与写操作边界

- `$EvidenceDir` 建议为 `D:\ACMS\test-results\iteration-1\release\<YYYYMMDD-HHmmss>`，只存诊断证据，不提交 Git，不写入 .acms 输入。
- `$GateDir` 必须是 `C:\Users\Administrator\.dsh\acms` 下 workspaces、reviews 或 integration 的隔离仓库副本，例如 `C:\Users\Administrator\.dsh\acms\integration\iteration-1-<timestamp>`。
- D:\ACMS 只做只读核对。**npm ci 会改写 node_modules 并可能执行依赖脚本，不是只读命令**；npm run check、npm test、npm run build、owner check 也只在隔离副本运行，避免污染源目录。
- 所有命令输出重定向到 `$EvidenceDir`，保留原始文件；不要覆盖旧证据。

### 7.2 只读核对（可在源目录执行）

```powershell
$EvidenceDir = "D:\ACMS\test-results\iteration-1\release\<YYYYMMDD-HHmmss>"
git -C D:\ACMS rev-parse HEAD
git -C D:\ACMS status --short
git -C D:\ACMS log --oneline -5
git -C D:\ACMS diff --stat 8d4b2b034c7387395bed61a328b4f64d367980e1..<target-commit>
gh pr view <number> --json url,baseRefName,headRefOid,files,state,body
gh run list --workflow "ACMS validation" --limit 5
gh run view <run-id> --log
Get-Content <DSH_HOME>\profiles\<profile>\cordis.patch.yml -Encoding UTF8
Get-FileHash <repo>\dist\host-<revision>.mjs -Algorithm SHA256
```

### 7.3 隔离副本中的写操作（只改隔离副本）

```powershell
$GateDir = "C:\Users\Administrator\.dsh\acms\integration\iteration-1-<timestamp>"
# 从目标 commit 建立隔离检出；不要在 D:\ACMS 直接执行 npm ci
git clone --no-hardlinks D:\ACMS $GateDir
git -C $GateDir checkout <target-commit>
Set-Location $GateDir
git rev-parse HEAD
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
```

- 目标 commit 必须是 PR head 或合并后的 main。`npm ci` 失败（离线缓存缺失、权限不足）时不得写成通过；记录退出码和错误。
- 宿主 owner check 必须引用绝对可执行路径并加引号，否则 PowerShell 会把 `C:\Program Files...` 解析为 `C:\Program`：

```powershell
Push-Location $GateDir
& "C:\Program Files\nodejs\node.exe" "D:\ACMS\test-results\iteration-1\owner-check.mjs"
$ownerExit = $LASTEXITCODE
Pop-Location
```

- owner-check 在 cwd 运行 scripts/check.mjs 与全部核心测试；缺少依赖时会先在该目录运行 `npm ci --offline --ignore-scripts`。因此 `$GateDir` 必须是隔离副本；若离线缓存不可用，记录为受阻，不得伪造退出码 0。

### 7.4 空闲与清理只读查询

将以下内容保存为 `$EvidenceDir\check-idle.mjs` 后执行；它只以 readOnly 打开数据库，不写库：

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const attempts = db.prepare(`SELECT count(*) AS n FROM entities WHERE collection='attempts' AND (json_extract(body,'$.status') IN ('preparing','running','cancelling','reconciling') OR json_extract(body,'$.cleanupPending')=1 OR json_extract(body,'$.cleanupUncertain')=1)`).get().n;
const chats = db.prepare(`SELECT count(*) AS n FROM entities WHERE collection='conversationMessages' AND (json_extract(body,'$.status') IN ('sending','streaming','restarting') OR json_extract(body,'$.cleanupPending')=1)`).get().n;
console.log(JSON.stringify({ attempts, chats, at: new Date().toISOString() }));
db.close();
```

```powershell
& "C:\Program Files\nodejs\node.exe" "$EvidenceDir\check-idle.mjs" "<dataDir>\company.db" | Tee-Object "$EvidenceDir\idle-$(Get-Date -Format yyyyMMdd-HHmmss).json"
```

- 输出必须为 `{"attempts":0,"chats":0,...}`。非 0、抛错或无法读取时阻断。
- `cleanupUncertain` 若在最终实现中不是持久字段，查询结果为 0 不代表有覆盖；需按 G14 核对合并后 `checkIdle` 的实际条件并保留源码行号证据。
- 只读打开仍会读取 WAL 当前状态；不要只复制 company.db 而忽略 WAL。

### 7.5 完整进程快照与归属核对

**不要**使用 `Where-Object { $_.CommandLine -match "codex|host-[0-9a-f]{16}" }` 作为 G14 证据：它会漏掉普通 node、PowerShell、cmd、conhost 等子/孙进程，也无法覆盖父进程先退出的情况。

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine | Export-Csv "$EvidenceDir\process-$ts.csv" -NoTypeInformation -Encoding UTF8
```

采集时点：T0 停机前；T1 所有执行报告结束且清理返回后；T2 新 host 加载后。每次保留完整 CSV 和采集命令、时间、机器名。

归属核对步骤：

1. 从 ACMS attempts、执行日志和 #3 清理回执导出本次拥有的 PID、创建时间、父 PID、命令、attemptId/contextKey；字段名以实现为准。
2. 对快照中的每个进程，以 **PID + CreationDate** 匹配（防止 PID 复用），再核对可执行路径、命令行和父链。
3. 父进程已退出时，用记录的子孙列表和创建时间窗口还原归属，不能假设「父进程退出 = 子孙退出」。
4. 分类：owned-alive（仍存活）、owned-exited（有退出证据）、明确无关（系统/服务进程，有独立证据）、无法归属。
5. 只要存在 owned-alive 或无法归属且可能属于本次执行的进程，即为清理证据不足，G14 不通过；快照因权限不完整时同样阻断。

### 7.6 PR、CI 与部署证据

- PR：`gh pr view <number> --json url,baseRefName,headRefOid,files,state,body`，保存 JSON 与页面截图。
- CI：`gh run view <run-id> --log`，保存完整日志；下载 `acms-ui-evidence` artifact 并记录文件名。
- 部署：保存 `deploy-live.mjs` 完整 stdout/stderr、profile 修改前后副本、`Get-FileHash dist\host-<revision>.mjs`、`install-backups` 新文件列表。
- 若 gh 不可用，改为在浏览器打开 PR 与 CI 页面，保存完整 URL、页面导出和截图，效果等同。

## 8. 本轮新问题与下一轮 issue 候选

以下为编写/修订清单时通过只读源码核对发现、与本轮范围相关的问题。它们可能已被 #3 或 #2 修复；未在最终交付中核实的，不得当作已解决。

| 临时编号 | 问题 | 影响 | 建议处理 |
| --- | --- | --- | --- |
| N1 | 部署空闲检查与清理不确定性字段的一致性：scripts/deploy-live.mjs:24-26 只检查 attempts 的 cleanupPending 与四个状态；当前实现的 cleanupUncertain 错误会转为 cleanupPending（src/runtime/engine.js:160、:319-322），但 #3 若引入独立字段，闸门未必覆盖 | 可能出现界面提示清理不确定、部署闸门却放行 | #3 合入后核对最终 commit；未覆盖则下一轮增加检查与测试 |
| N2 | 部署空闲检查缺少自动化测试：test/deployment.test.js 只覆盖 replaceHostEntry，checkIdle 内嵌在脚本中 | 升级闸门只能靠人工核对，回归风险高 | 下一轮把空闲检查抽成可测试函数并覆盖 active、reconciling、cleanup 场景 |
| N3 | 配对 runner 取消路径的可诊断性：修复前 src/adapters/paired.js:84-88 的 taskkill 忽略退出码，回退 child.kill 不能证明进程树退出，且缺少有限时等待与结果校验 | 无法证明子/孙进程已结束，可能遗留执行 | 若 #3 已覆盖则关闭；否则保留为下一轮问题 |
| N4 | run key 与查询口径：src/adapters/paired.js:122-123 与 src/adapters/dsh.js:211-216 的键不一致 | 跨宿主重启或恢复时查不到真实进度，可能误判 | #2 统一后，下一轮补真实 app-server 双进程恢复回归，不得用模拟模型文本冒充 |
| N5 | 发布证据缺少机器可读记录：本轮门槛依靠人工表格 | 漏填、错填难以及时发现 | 下一轮提供 gate 结果 JSON 或 CSV 与校验脚本 |
| N6 | 进程归属证据未统一持久化：跨宿主重启后，PID、创建时间、父子链可能只存在于日志中 | 人工核对成本高，父子链断裂时易误判 | 下一轮在 attempt/cleanup 记录中持久化 owned PID 与创建时间，并提供核对脚本 |
| N7 | deploy-live 在写 dist 后再次 checkIdle：第二次拒绝会留下未被 profile 引用的 dist 文件 | 无害，但可能被误认为已部署 | 下一轮在拒绝时清理或标注未引用产物，并在输出中说明 |

记录模板：

| 字段 | 填写要求 |
| --- | --- |
| 编号 | N-YYYYMMDD-序号 |
| 标题 | 一句话描述 |
| 现象与复现 | 最小复现步骤、涉及文件与行号 |
| 影响 | 对执行、恢复、发布或数据的影响 |
| 证据 | 日志、截图、命令输出或链接 |
| 本轮处理 | 已由 #3 或 #2 覆盖、范围外、待下一轮 |
| 下一轮建议 | 具体验收条件与测试要求 |
| 记录人、时间 | 角色与 ISO 8601 时间 |

## 9. 结论：阶段判定

截至本清单修订时（2026-11-07T11:59+08:00），不具备发布完成结论：PR 未创建、Windows CI 未运行、未合入 main、未做现场备份与部署，版本加载与基本功能验证均无证据；#3 仍在执行，#2 被 #3 阻塞。

- **升级放行条件**：G1–G14 全部为「通过」。只有满足此条件，外部发布负责人才可以执行 G15（部署）。
- **发布完成条件**：G15 与 G16 也为「通过」，且所有者签署。G15 只能在前置条件满足后执行；G16 只能在 G15 之后评估。
- **不存在循环**：G15、G16 是部署及部署后的完成条件，不是开始升级的前置条件；不得用「G1–G16 全部通过才能升级」的写法。
- **失败处理**：前置条件失败按第 6.1 节阻断，不进入回滚；已部署后 G15/G16 失败按第 6.2 节回滚或中止切换。
- 开发完成、审查完成、合入完成、部署完成分别属于不同阶段，任何一项都不能替代发布完成。

## 10. 发布签署与证据归档

本地证据建议归档到 `D:\ACMS\test-results\iteration-1\release\<YYYYMMDD-HHmmss>\`，只作诊断材料，不提交 Git，不写入 .acms 输入。

| 签署项 | 内容 |
| --- | --- |
| 最终发布 commit | |
| host revision | |
| profile | |
| 升级前置放行（G1–G14）决定 | 放行 / 阻断（待填） |
| 升级前置放行签署（所有者、时间） | |
| 部署执行人（外部负责人、时间） | |
| 发布完成（G15–G16）决定 | 完成 / 回滚（待填） |
| 发布完成签署（所有者、时间） | |
| 未通过或待验证门槛 | 列出编号；升级前置非空则不得部署，完成阶段非空则不得称完成 |
| 回滚版本与备份位置 | |
| 备注 | |

## 11. 修订对照

### 11.1 v1.1 对独立审查 5 项缺陷

| 审查发现 | 本版处理 | 位置 |
| --- | --- | --- |
| 门槛循环：G1–G16 全部通过才可升级，但 G15、G16 是部署及部署后验证 | 拆成阶段 A 前置 G1–G14、阶段 B 部署 G15、阶段 C 完成 G16；明确开始升级只要求 G1–G14 | 第 4、5.5、5.6、5.7、9 节 |
| 回滚顺序：清理不确定仍切换重启；先启动旧 host 后处理数据兼容 | 增加第 6.2 节第 0 步「清理不确定先停止切换」；第 4 步强制先判定兼容性/恢复数据，再启动旧 host | 第 6.2 节 |
| 部署前失败被统一当作回滚 | 区分 6.1 部署前阻断（现场未变，不回滚）与 6.2 部署后回滚；checkIdle 拒绝归入 6.1 | 第 6.1、6.2 节，G15 补充 |
| 进程快照只匹配 codex/host 名称，漏掉普通子/孙进程和父进程先退出的情况 | 改为完整 Win32_Process 快照 + PID/创建时间/父链/归属证据核对；无法归属即阻断 | G14、第 7.5 节 |
| npm ci 被列为只读；owner check 路径未加引号导致解析为 C:\Program | 把 npm ci 等写入操作限定在隔离副本；owner check 用 `& "C:\Program Files\nodejs\node.exe"` 调用 | 第 7.1、7.3 节 |

### 11.2 v1.2 对独立审查（清理门槛绕过）

| 审查发现 | 本版处理 | 位置 |
| --- | --- | --- |
| 回滚第 0 步保留「所有者书面接受残余清理风险」例外：清理未证实时仍可进入第 4–6 步（恢复数据、切换版本、启动旧 host），可能与旧执行并存 | 删除该例外；第 4–6 步仅在「已证实本次拥有的执行及子孙进程全部停止」后执行；证据不足一律停在步骤 3，保持 reconciling 与资源占位（attempt 占位、cleanupPending/cleanupUncertain 标记），保留进程快照与诊断证据等待人工处置 | 第 6.2 节第 0 步、禁止事项 |
| G14 也允许以「所有者接受残余风险」代替只读计数为 0 的证据 | 删除该例外；无法用只读查询证明计数为 0 时一律「不具备升级条件」并停止 | 第 5.4 节 G14 |

v1.1 与 v1.2 均只修改文档；未执行 PR、合入、发布、现场切换或回滚，未修改源目录、数据库、插件、认证、公司策略或 .acms 输入。
