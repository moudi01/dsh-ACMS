# Issue #8 验证记录

- Issue：[P2][运维] 提供一致性备份恢复与运行数据保留策略（https://github.com/moudi01/dsh-ACMS/issues/8）
- 仓库基线：`origin/main` `8f7a4453763ac5dada48cda7a412e4f82caaa664`（Merge pull request #61）
- 实现提交：`0b4eb51`（分支 `codex/issue-8-backup`）；本记录提交只补记该 SHA
- 复核修订提交：`c3329de`（修复嵌套数据库保留、全量校验、空间估算、集成目录保护与恢复路径改写；本记录提交只补记该 SHA）
- 验证日期：2026-11-11（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`。未安装或升级运行中的 DSH，未调用真实模型。

## 1. 基线复现（真实静态证据）

基线 `8f7a445` 只有手工复制说明，没有受控备份、校验、恢复或保留 dry-run 入口：

```text
> git show 8f7a445:scripts/backup.mjs
（文件不存在）

> git show 8f7a445:scripts/restore-backup.mjs
（文件不存在）

> git show 8f7a445:scripts/prune-data.mjs
（文件不存在）

> git show 8f7a445:docs/operations.md | Select-String '备份前暂停'
备份前暂停执行并关闭宿主，再备份完整数据目录和项目 Git 仓库。SQLite 正在运行时，不要只复制 company.db 而忽略 WAL。
```

因此备份范围、文件量、空间需求、排除材料与恢复方法都依赖所有者手工判断，无法机器校验。

## 2. 改动范围

- `scripts/backup.mjs`：
  - `--data-dir <dir>` 默认只输出计划（文件数、字节、排除项、空间需求、敏感告警），`--apply` 才写备份。
  - 数据库用 SQLite `VACUUM INTO` 生成一致性快照（覆盖 WAL），写入后 `PRAGMA integrity_check`；文件按原始字节 SHA-256 生成 `backup-manifest.json`。计划空间需求包含数据库快照估算（主库 + WAL），并按目标卷可用空间判断。
  - 默认排除 `node_modules`、`.git`（目录或 worktree 的 `.git` 文件）、`.cache`、`diagnostics`、顶层 `company.db`/`-wal`/`-shm`（快照替代）与 `pairing/`（敏感，需 `--include-pairing` 显式加入）；历史备份/交付物中嵌套的 `company.db` 会正常备份。符号链接不跟随并记录原因。`conversations/`、`artifacts/` 私有内容在计划中告警。
  - `--verify <backup>` 做全量独立遍历：数据库完整性、每项大小/摘要、缺失、多余文件与符号链接；失败返回非零。
- `scripts/restore-backup.mjs`：先校验清单，再只能恢复到空目录；复制后把数据库实体中指向旧数据目录的绝对路径（任务工作副本、artifact blob 等）改写为新目录并更新恢复清单，生成 `REBUILD.md` 记录排除材料、路径改写、在途执行 `reconciling` 和源项目仓库边界；已存在的恢复目标拒绝覆盖。
- `scripts/prune-data.mjs`：保留策略 dry-run，按目录树最新修改时间列出过期的 `workspaces/`、`reviews/`、`integration/`、`diagnostics/` 及字节数；仍被未完成任务、运行中执行、待清理占位或在途集成 ID 引用的目录标记保护，不进入可清理列表；不自动删除。
- `docs/operations.md`：新增“备份、恢复与保留”章节，记录命令、范围、排除/重建、私有内容告警、恢复步骤、路径改写与保留边界。
- `test/backup.test.js`（6 项）：计划范围与嵌套数据保留、apply+全量校验+隐藏额外文件/篡改失败、恢复到空目录并改写旧路径、保留 dry-run 保护活跃任务与在途集成、WAL 空间估算与缺值参数、显式包含 pairing。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node --test test/backup.test.js` | 6 项通过，0 失败 | 计划、嵌套数据保留、备份、全量校验、恢复路径改写、保留 dry-run、WAL 空间、配对包含 |
| `npm test` | 513 项通过，0 失败，约 149 秒 | 全量核心、运行库与既有测试 |
| `npm run check` | 退出 0 | 语法与包契约 |
| `npm run check:docs` | 退出 0 | 文档一致性 |
| 备份 CLI 错误路径 | 缺失数据目录/缺值参数返回非零并输出明确原因 | 非伪成功 |

以上结果来自实现提交的工作树。PR 推送后 GitHub Actions 会在最终 head 重新运行同一组命令；CI 结果以 PR 页面为准。

## 4. 验收标准对照

- [x] 备份前展示范围、文件量、空间需求和不可排除的恢复材料：计划输出文件数/字节、排除项及原因、包含数据库快照估算与目标卷可用空间的空间需求、私有内容与配对告警。
- [x] 区分可重建依赖缓存与不可丢失材料，缓存排除需要明确恢复方法：排除项带 `reason`/`rebuild`；`REBUILD.md` 写明 npm ci、重新配对、工作副本重建等；只排除顶层数据库文件，历史/嵌套 `company.db` 保留。
- [x] 最小可恢复集合在新目录演练成功，记录排除内容如何重建；一致性、版本和引用关系可核对：测试从备份恢复到空目录，逐字节恢复产物与数据库，恢复时把旧数据目录绝对路径改写为新目录并复核清单；`REBUILD.md` 记录重建与改写。
- [x] 复用既有清单与校验机制，避免多套等价包；快速校验不能冒充全量校验：单一 `backup-manifest.json`，verify 全量独立遍历（含隐藏多余文件/符号链接），不沿用备份排除规则；raw-byte SHA-256 与 ACMS `artifact.hash` 在清单中说明不可互换。
- [x] 历史备份和证据保留；清理只做 dry-run：嵌套历史 `company.db` 正常备份；`prune-data.mjs` 不删除任何文件，保护未完成任务、cleanupPending 与在途集成目录，列出候选与保护原因，删除仍由所有者按现有授权流程执行。

## 5. 范围与限制

- 仅支持当前本机数据目录；不包含云备份、跨设备同步、源项目 Git 仓库、认证文件或外部模型配对令牌。
- 数据库快照是一致的，但文件复制不是对运行中宿主的整体锁；推荐先暂停执行（最好关闭宿主），计划与文档均如此提示。若宿主持续写入工作副本，备份文件可能与数据库某一时点不完全对应。
- 排除 `pairing/` 后，恢复环境需要重新配对外部模型；`--include-pairing` 会把本机 runner 信息写入备份，需所有者自行评估敏感性。
- `prune-data.mjs` 只做 dry-run；实际删除不在本脚本中执行。保留期限只覆盖工作副本/审查/集成/诊断目录，按目录树内最新修改时间判断；不覆盖 `artifacts/`（内容寻址，可能仍被任务引用）与 `company.db`。只读打开 WAL 数据库可能由 SQLite 生成瞬时 `-shm/-wal` 辅助文件，不修改业务数据。
- 恢复会改写数据库实体中的旧数据目录绝对路径；历史事件/命令文本中的旧路径作为审计记录保留，不改写。恢复后外部配对需按 `REBUILD.md` 重建（除非显式包含 pairing）。
- 备份为有界内存读取（单个文件受现有 `maxArtifactBytes` 约束），不保留原始 mtime/文件模式；恢复后的文件按私有内容权限写入。
- 未修改 ACMS 运行时状态机、界面或调度；工具不触发模型，也不写业务数据库。
- 复现命令：`node --test test/backup.test.js`；完整测试：`npm test`。

## 6. 复核修订

独立审查在 `0b4eb51` 上提出 5 个阻塞项，均已修复并补回归：

- **嵌套 company.db 被误排除**：只排除数据目录顶层的 `company.db`/`-wal`/`-shm`，历史备份与交付物中嵌套数据库正常进入备份；测试覆盖 `legacy/.../company.db` 与 workspace 内 `company.db`。
- **在途集成目录被列为可清理**：保留 dry-run 读取 `integrations` 实体，按 integration/task ID 保护 `preparing/checking/applying/reconciling` 的候选目录；测试覆盖 `integration/integration_pending`。
- **空间计划不含数据库快照且取错卷**：计划估算主库 + WAL，并按目标卷可用空间判断；WAL 夹具验证 `estimatedBytes`/`requiredBytes`。
- **`--verify` 非全量**：改用独立全量遍历，报告隐藏的 `node_modules`、嵌套 `company.db` 与符号链接；测试验证隐藏额外文件导致校验失败。
- **恢复后旧 dataDir 路径失效**：恢复时改写数据库实体中的旧数据目录绝对路径（任务工作副本、artifact blob 等）并更新恢复清单，`REBUILD.md` 说明改写范围；测试断言新路径可通过校验。
- 额外采纳：缺值参数拒绝、`.git` worktree 文件排除、目标路径 realpath/junction 校验、retention 使用目录树最新 mtime、`--include-pairing` 恢复说明按实际状态生成。
