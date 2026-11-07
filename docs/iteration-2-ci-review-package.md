# 第二轮 CI 修复候选独立复审包
状态：作者交付完成，等待 ACMS 非作者 reviewer 独立复审。作者未自审，也未宣称发布完成。
## 1. 复审对象（不可变身份）
- 仓库：moudi01/dsh-ACMS
- 冻结候选提交：7063bf2d1aba41cbfda2d88fb09fa14406d4cc9b
- 候选 tree：4a48c0021a23c05134b73def570d5f336c610bf4
- 重建的 PR #23 基线：6634c677bd629e6c79480a0cacd376cb8ec260b9，tree 72ced9318a1c1d7a24fdfd9a30300a9a46d6ca4a
- PR #23 head：3aa5c996ad1beb539950397cd32383ee73412508，tree 同基线
- 冻结包：test-results/iteration-2-ci-coordination/candidate-v9-full.zip，898445 bytes，SHA256 e9f35084ee6b57bb9f7618be29508af5d1ec35316a7fb375ac0786116ad48c6a
- 本工作区检出的 commit 与 tree 与冻结值逐字一致；zip 内 204 个文件逐个 SHA256 与 docs/iteration-2-ci-freeze.json 一致。
- 本任务新增文档与证据均为未跟踪文件，不改变 4a48c002 tree；未改写 docs/iteration-2-ci-freeze.json 或旧 v8 清单。


## 2. 与 PR #23 的差异（仅六项）
| 文件 | 类型 |
| --- | --- |
| docs/external-agent-onboarding.md | 修改 |
| docs/iteration-2-ci-fix-files.json | 新增 |
| docs/iteration-2-ci-fix.patch | 新增 |
| docs/iteration-2-release-handoff.md | 修改 |
| docs/iteration-2-release-report.md | 新增 |
| test/external-onboarding-doc.test.js | 修改 |
`git diff --name-only 6634c677bd629e6c79480a0cacd376cb8ec260b9 HEAD` 精确输出上表，无第七项；复核结果见 verification/import-verification.json。
## 3. 修复内容（请独立核对，不采信作者结论）
- 根因：`icacls /inheritance:r` 只移除继承 ACE；GitHub Windows runner 的 token 文件还存在显式其他身份 ACE，`/grant:r` 只覆盖当前用户，guard `$other.Count` 失败。
- 修复：发布文档的 token setup 块保留 icacls，再用 Get-Acl 与 Set-Acl 重建 DACL，删除所有非继承的其他身份 ACE，要求恰好一个当前用户 ACE，否则抛出并以非零退出。
- 该修复只改公开接入文档中的脚本和对应测试；不放松 guard，不跳过测试。
- 补丁：docs/iteration-2-ci-fix.patch，针对 tree 72ced9318a1c1d7a24fdfd9a30300a9a46d6ca4a 生成。


## 4. 必须复核的证据
### 4.1 原始字节日志（复制自父工作区，未改写）
| 文件 | bytes | SHA256 | 结论 |
| --- | --- | --- | --- |
| test-results/iteration-2-release/ci-fix-red.log | 2492 | dbe30536b1267dfc21d7948430dacbc0ebb1e9a61274d50ee11871cf6c2de2cf | 原始红：`$other.Count` guard 失败，node --test 非零 |
| test-results/iteration-2-release/ci-fix-green.log | 1232 | e8938218f7e952fbb5f979ef92a3d6f854be2214afd6eb862f11c60de19bd730 | 6/6 pass |
| test-results/iteration-2-release/ci-fix-final.log | 1234 | 87060d3027cf3a85e560966b002f46aca33953bec3f7772c4091a3798ea3b010 | 6/6 pass |
| test-results/iteration-2-release/full-test.log | 58310 | eb143e4c217fd13554e61d71af8d1bce846d175b5649770b0b769aae3bfd5828 | 318/318 pass |
| test-results/iteration-2-release/check.log | 198 | 8b5cd8da334524b7d1950a34cb8b84f4a23be48e7e78b0e65af2cea016cb36b9 | Syntax and package contract checks passed |
全部为 UTF-16LE；SHA256 与 docs/iteration-2-ci-freeze.json evidence 完全一致。


### 4.2 本工作区复跑（2026-11-07，Node v24.22.0）
| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| ACL 回归 | node --test --test-concurrency=1 test/external-onboarding-doc.test.js | 6/6 pass，exit 0 | verification/acl-regression.log |
| 静态与包契约 | node scripts/check.mjs | pass，exit 0 | verification/check.log |
| 全量单元与集成 | node --test --test-concurrency=1 test/*.test.js packages/codex-runtime/test/*.test.mjs | 318/318 pass，exit 0 | verification/full-test.log |
| 标准 owner check | node D:/ACMS/test-results/iteration-1/owner-check.mjs，cwd 为本工作区 | 318/318 pass，exit 0 | verification/owner-check.log |
- owner check 未跳过；其内部再次执行 check 与全套测试。所有日志为 UTF-16LE。
- 本机 318/318 不等于 GitHub CI；候选 head 尚未推送，CI 结论保持 pending。


### 4.3 ACL 行为断言（test/external-onboarding-doc.test.js）
- 真实创建显式其他身份 ACE：`icacls token /grant *S-1-1-0:(R)`，并断言夹具存在非当前用户 SID。
- 执行发布块后断言：DACL protected=true；规则数恰好 1；SID 为当前用户；inherited=false；setup exit 0。
- 失败非零：原始红日志 ci-fix-red.log 即 guard 失败、node --test 非零；本次复跑 6/6 绿。
- 继承关闭与仅当前用户读写由上述断言和 icacls `/inheritance:r` 组合覆盖。
## 5. 仍未完成（不得由作者关闭）
- 更新同一个 PR #23、推送候选 head、触发并取得 Windows CI 通过证据。
- 合入 main、备份、升级当前 ACMS、旧运行进程清理、数据保留、实际加载版本与运行可用性。
- 工作台关闭下的真实 agent 接口验收（提交、查询、交互回复、增量事件、暂停恢复、重启恢复）与真实模型及负责人协调验收。
- 上述均由外部用户代理在独立复审通过后执行；作者不宣称完成。
## 6. 复审结论填写
- [ ] 冻结身份与完整保留关系通过
- [ ] 六项增量与补丁一致
- [ ] 原始红绿日志字节一致
- [ ] ACL 夹具与断言、失败非零通过
- [ ] 本机回归与 owner check 通过（不替代 CI）
- [ ] 发布待办保持打开
reviewer：______  证据版本：______  结论：______

