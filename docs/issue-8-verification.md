# Issue #8 验证记录

- Issue：[P2][运维] 提供一致性备份恢复与运行数据保留策略（https://github.com/moudi01/dsh-ACMS/issues/8）
- 仓库基线：`origin/main` `8f7a4453763ac5dada48cda7a412e4f82caaa664`（Merge pull request #61）
- 实现提交：`0b4eb51`（分支 `codex/issue-8-backup`）；本记录提交只补记该 SHA
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
  - 数据库用 SQLite `VACUUM INTO` 生成一致性快照（覆盖 WAL），写入后 `PRAGMA integrity_check`；文件按原始字节 SHA-256 生成 `backup-manifest.json`。
  - 默认排除 `node_modules`、`.git`、`.cache`、`diagnostics`、`company.db-wal/shm`（快照替代）与 `pairing/`（敏感，需 `--include-pairing` 显式加入）；符号链接不跟随并记录原因。`conversations/`、`artifacts/` 私有内容在计划中告警。
  - `--verify <backup>` 校验数据库完整性、每项大小/摘要、缺失与多余文件；失败返回非零。
- `scripts/restore-backup.mjs`：先校验清单，再只能恢复到空目录；复制后生成 `REBUILD.md`，列出被排除目录的重建方法、在途执行进入 `reconciling` 的处置和源项目仓库另行保留的边界；已存在的恢复目标拒绝覆盖。
- `scripts/prune-data.mjs`：保留策略 dry-run，按 `--days` 列出过期的 `workspaces/`、`reviews/`、`integration/`、`diagnostics/` 及字节数；仍被未完成任务、运行中执行或待清理占位引用的目录标记保护，不进入可清理列表；不自动删除。
- `docs/operations.md`：新增“备份、恢复与保留”章节，记录命令、范围、排除/重建、私有内容告警、恢复步骤与保留边界。
- `test/backup.test.js`（4 项）：计划范围与排除、apply+verify+篡改失败、恢复到空目录与重建说明、保留 dry-run 保护活跃任务。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node --test test/backup.test.js` | 4 项通过，0 失败 | 计划、备份、校验、恢复、保留 dry-run |
| `npm test` | 511 项通过，0 失败，约 149 秒 | 全量核心、运行库与既有测试 |
| `npm run check` | 退出 0 | 语法与包契约 |
| `npm run check:docs` | 退出 0 | 文档一致性 |
| 备份 CLI 错误路径 | 缺失数据目录返回非零并输出明确原因 | 非伪成功 |

以上结果来自实现提交的工作树。PR 推送后 GitHub Actions 会在最终 head 重新运行同一组命令；CI 结果以 PR 页面为准。

## 4. 验收标准对照

- [x] 备份前展示范围、文件量、空间需求和不可排除的恢复材料：计划输出文件数/字节、排除项及原因、空间需求与可用空间、私有内容与配对告警。
- [x] 区分可重建依赖缓存与不可丢失材料，缓存排除需要明确恢复方法：排除项带 `reason`/`rebuild`；`REBUILD.md` 写明 npm ci、重新配对、工作副本重建等。
- [x] 最小可恢复集合在新目录演练成功，记录排除内容如何重建；一致性、版本和引用关系可核对：测试从备份恢复到空目录，逐字节恢复产物与数据库并校验清单；`REBUILD.md` 记录重建方法。
- [x] 复用既有清单与校验机制，避免多套等价包；快速校验不能冒充全量校验：单一 `backup-manifest.json`，verify 校验全部文件与数据库完整性；raw-byte SHA-256 与 ACMS `artifact.hash` 在清单中说明不可互换。
- [x] 历史备份和证据保留；清理只做 dry-run：`prune-data.mjs` 不删除任何文件，列出候选与保护原因，删除仍由所有者按现有授权流程执行。

## 5. 范围与限制

- 仅支持当前本机数据目录；不包含云备份、跨设备同步、源项目 Git 仓库、认证文件或外部模型配对令牌。
- 数据库快照是一致的，但文件复制不是对运行中宿主的整体锁；推荐先暂停执行（最好关闭宿主），计划与文档均如此提示。若宿主持续写入工作副本，备份文件可能与数据库某一时点不完全对应。
- 排除 `pairing/` 后，恢复环境需要重新配对外部模型；`--include-pairing` 会把本机 runner 信息写入备份，需所有者自行评估敏感性。
- `prune-data.mjs` 只做 dry-run；实际删除不在本脚本中执行。保留期限只覆盖工作副本/审查/集成/诊断目录，不覆盖 `artifacts/`（内容寻址，可能仍被任务引用）与 `company.db`。
- 未修改 ACMS 运行时状态机、界面或调度；工具不触发模型，也不写业务数据库。
- 复现命令：`node --test test/backup.test.js`；完整测试：`npm test`。
