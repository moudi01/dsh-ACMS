# 第二轮迭代发布与验收报告

**结项状态：已按用户要求在项目目录完成收尾（2026-11-08，Asia/Shanghai）。** 用户明确改为“不用 ACMS，直接在项目目录下操作”；本轮以本报告和 GitHub 记录为结项依据，不再恢复 ACMS 中的报告、审查或发布任务。

本报告由 Codex 作为外部用户代理整理，合并隔离验收短报告与生产发布报告。范围为第二轮 #15 agent 接口、#16 初始自主规划及审查退回协调、#5 用户模型倾向，以及随轮完成的 Windows 线程索引 #22 与令牌文件 ACL 修复。后续新增 issue 和新增验收要求均不纳入本轮。

## 已完成的交付

| 项目 | 结果与既有证据 |
| --- | --- |
| 发布版本 | [PR #23](https://github.com/moudi01/dsh-ACMS/pull/23) 已合入；main 提交 e53ba09dd8ad9bcef49be1b95b0cfe643a251df2，tree a16ba85cb9dfc9c7d79cba3e288696521ffb25a7。 |
| 代码审查与测试 | 冻结产物 e226acded634f231d7a20aa0978fc03594db30b4cb929d8add5bc11e9cd51456 已获非作者审查 verification_b0c28a31-0d4f-4212-ac1b-1759543e3996 通过。既有宿主检查及 PR CI 42387084321 均为 318 项通过、0 失败；[main CI 42387407619](https://github.com/moudi01/dsh-ACMS/actions/runs/42387407619) 成功。本次收尾不重跑测试、不重新审查源码。 |
| 备份与升级 | 旧宿主退出后完成一致备份及校验；回滚材料位于 D:/ACMS/test-results/iteration-2/release-20261108-0002。已部署 host-dac5154d3b4f57bd.mjs，SHA-256 dac5154d3b4f57bd9e2ac75b22dd9c1ad3985826b1f18400bfe0550c1651beda。升级后 schema 为 2，原有实体 ID、正文和 1572 条事件保留。 |
| #15 真实接口 | 真实安装宿主的隔离实例已验证无效/缺失凭据 401、合法访问、越权拒绝、目标提交、幂等与冲突、状态/任务/审查/阻塞/增量事件查询、暂停/恢复、人工交互回复、重启恢复；交付 CLI discover/status 已运行成功。验收时工作台关闭，使用真实模型。 |
| #5 模型倾向 | UI 保存的模型倾向与 API 读回、实际规划及执行选模记录一致；隔离验收实际选择 DeepSeek flash。 |
| #22 Windows 线程索引 | 并发原子重命名 EPERM 修复已进入同一最终候选、318 项回归、独立审查及 PR #23 发布版本。保留既有错误及修复记录，没有跳过失败测试。 |
| #16 自主规划与协调 | 负责人自行拆分验收任务。首次独立审查 verification_7d203e2f-500d-4407-9864-e90538f48475 退回后，调度器自动创建 task_90f49ebb-1559-4c66-b513-2b5208726276，负责人决定最小返工，原作者执行后由 verification_c96b6808-f8c4-408a-b572-4bcd51e6959e 独立复审通过。该段审查→协调→返工未由外部代理人工唤醒。 |
| 验收产物 | task_d69dd061-2b82-4812-865f-7c9f83bedfab 成功，冻结产物 71a67a4edfb581e9641a67531891dfbdc9a773c288f32699750e0b80de593ad9。result.txt 为三行：controlled-acceptance v2 / owner-marker: ACMS-I2-20261108 / status: READY。marker 来自真实人工交互。 |
| 凭据及进程清理 | 临时验收凭据已于 2026-11-07T16:35:04.832Z 通过正常 owner 界面撤销，原凭据再次请求返回 401；临时验收宿主 PID 93008 已停止。保留隔离数据库、产物、失效令牌文件和回滚材料，仅存本机，未上传。 |

## 证据索引

以下文件均以 D:/ACMS/test-results/iteration-2/ 为根目录，保留原始历史时间，不修改旧回执：

- 版本、CI、部署与数据保留：live-upgrade-evidence.json；ci-candidate-review-1-approved.json；frozen-host-e226acded634/receipt.json。
- 接口与 CLI：real-host-api-acceptance.json；real-host-cli-discover.json；real-host-cli-status.json；real-host-api-evidence/revoked-credential.json。
- 自主规划、偏好与协调：real-acceptance-manager-plan.json；real-acceptance-autonomous-coordination.json；real-acceptance-rework-review-approved.json。
- 收回访问与停止实例：user-stop-final-receipt.json；isolated-host-stopped.json。
- 版本证明边界：production-loaded-bundle-evidence-boundary.json。

## 本次总体核对与结项依据

Codex 直接在项目目录完成一次收尾核对：将本报告的交付结论与既有版本、候选审查、测试、部署、接口、自动协调、凭据撤销和宿主停止回执对应；核对 `closure/evidence-excerpts.json` 索引的 13 份原始文件 SHA-256，全部一致。最终候选独立审查与历史测试均绑定同一冻结产物；没有发现阻止本轮既定交付结项的证据矛盾。

这是外部用户代理按用户变更后的流程所做的报告级总体核对，不冒充 ACMS 的独立审查记录。已有代码非作者审查和真实验收独立复审继续有效；不重跑源码审查、产品测试、构建、部署、模型检测或业务任务。

验证边界：上述不重复执行要求适用于本机收尾；用户明确 GitHub CI 不在限制内，本次文档 PR 按仓库保护规则正常执行 CI，通过后合入，不使用跳过标记。

| 原收尾事项 | 仓库结项状态 | ACMS 历史记录处理 |
| --- | --- | --- |
| 隔离验收短报告 | 完成，已合并到本报告 | task_0f2de69b-bd16-45e8-b0ec-691e2e521dd4 曾提交报告；保留其 reviewing 历史状态，不再运行。 |
| 正式发布报告 | 完成，版本、升级、接口与协调证据已补齐 | task_f956028a-14d8-4eaf-b64f-8cabafb4ca55 保留 blocked/human 历史状态；本次仓库结项替代该重复收尾流程。 |
| 交付总体核对 | 完成，由外部用户代理直接核对既有证据 | task_edcd4c0c-d628-43a4-94d7-355c4292f9be 的中断仍记录为 blocked/budget，未产生通过结论，不改写为成功。 |
| 本轮发布收尾 | 完成，以本报告为准 | 两个 ACMS 目标的旧状态保留，不直接修改数据库、不补造事件，也不再列为本轮交付待办。 |

## 保留的限制与历史事实

- 旧升级回执中的 `realAcceptance=in progress`、`releaseReview=pending` 是当时快照。实际验收使用较新的通过、撤销及停止回执；仓库结项采用本次用户指令后的报告级核对，原回执不改写。
- 部署配置、包哈希、新宿主身份、新 API/schema 与界面支持升级结论；没有独立启动日志证明内存加载文件的完整名称，该限制不扩展为新的开发或验收任务。
- 发布期间的 CI 协调曾由外部代理人工唤醒，不能计入自动协调成果；上述隔离实例的真实自动链路才是 #16 的验收依据。本轮直接收尾也是外部操作，不宣称全流程已经自治。
- 此前报告提交用时 34.825 秒，ACMS 总体复核尝试运行 145.5 秒后因额度中断，未产生 review verification。空检查列表的宿主收集记录不代表测试或审查通过。
- ACMS 最后累计执行为 529.5828167 / 530.11785 分钟。本次直接收尾未启动或恢复 ACMS，没有增加其额度或派生模型执行。此前临时收尾宿主 PID 98736 已停止且停止前无子进程，见 `closure/metadata-host-stop.json`；生产调度保留暂停状态。
- #15 与 #22 的本轮交付可以关闭；#5 的成本适配、#16 的更广泛异常接管等后续要求继续保留在原 issue 中，不计为本轮未完成工作，不在本次实施。

本机历史暂停记录仍位于 `test-results/iteration-2/closure/CLOSURE-STATUS.md`；它描述流程变更前的状态。本报告是用户改为直接操作项目目录后的最新结项记录。只发布本报告及脱敏结项说明，私有备份、认证文件、原始运行数据库和日志留在本机。
