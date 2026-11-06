# 外部模型配对

ACMS 初始模型列表只读取 DSH 的内部模型目录，不再把旧桥接的 Codex/persistent provider 自动加入列表或作为自动派发候选。

外部模型通过「模型列表 → 配对外部 agent」添加。交互参考 [Paperclip 的外部 agent 邀请流程](https://github.com/paperclipai/paperclip-docs/blob/main/docs/how-to/bring-your-own-agent.md)：生成 prompt，目标 agent 准备运行环境，所有者核对后接入。ACMS Demo 使用本机回执文件与进程协议，**不兼容 Paperclip 的邀请 API**，也不需要另开管理网站或端口。

## 操作

1. 点击「配对外部 agent」，复制 prompt 到目标 agent。配对邀请有效期 24 小时，仅可接受一次。
2. 目标 agent 根据自己的实际 CLI/SDK 创建 runner，写入指定的 `response.json`。不要提交 API 密钥、登录数据库或环境变量；认证继续由目标运行环境管理。
3. 回到 DSH 点击「读取配对结果」。核对模型名称、程序绝对路径、固定参数、上下文能力和思考深度，再点「确认添加模型」。读取、添加都不会启动模型。
4. 对支持无工具检测的入口，点击「检测模型连通性」才发送实际简短请求。不支持时检测会在启动模型前拒绝，仍可登记并分配任务，但登记本身不能证明连通。正式任务分配后 ACMS 自动启动执行入口；独立审查也会自动启动，不要求配对聊天一直打开。

本版本支持与 DSH 在同一台机器上的外部环境。远程 agent 需要额外的远程传输适配器，不能只填一个模型名称即使用。外部 runner 是用户确认的本机程序，需要遵守 prompt 中的隔离约定；ACMS 不会把任意自定义程序变成操作系统沙箱。

## 协议

`src/adapters/paired.js` 生成完整配对 prompt。回执包含 `protocol: acms.runner.v1`、邀请 ID 和随机 token、名称、真实模型 ID、绝对可执行路径、固定参数数组、`persistent`、可公开的 `reasoningEffort`、可选的 `probeSupported` 和不支持原因。Windows 使用 `.exe` 运行时加参数，不接受 `.cmd/.bat` 启动串。读取只校验数据和文件存在性；接受时重新校验 fingerprint，防止核对后回执被替换。

ACMS 以 `shell: false`、隐藏窗口方式启动程序，把单个 JSON 请求写入 stdin。请求包含模式 `probe/task`、随机 requestId、模型、prompt、隔离 cwd、contextKey、retainContext、sandbox 与 approvalPolicy。stdout 必须是一个 JSON 响应，日志写 stderr；退出、请求 ID、模型身份和完成事实都会校验。暂停、超时会回收所拥有的进程树。

检测是可选能力：仅在运行时可确认禁用所有工具和文件写入时声明支持，并使用独立上下文请求短回答；只读沙箱或提示词约束不足以声明支持。任务请求：按具体任务和审查角色隔离；只有配对 agent 声明支持续接时才传 `retainContext=true`。外部模型不能继承 DSH 父代理上下文。断电或重启后无法确认的外部执行仍进入核对状态，不盲目重复执行。

思考深度初始显示回执声明并标注来源，检测后显示 runner 返回值；未公开时显示未知。此能力及回答真实性依赖已确认的 runner 实现，不能把自报元数据当作服务端证明。

## 管理角色的派工与自动续跑

外部管理者不需要 DSH 内部工具，也能创建执行人员、使用其真实 ID 派发任务。返回 `outcome: "managed"`、稳定的 `actionBatchId` 和 `actions`（每批 1–10 项）即可。后续动作的参数可使用完整字符串 `$actions[0].id` 引用本批前一步返回的 ID；只允许引用更早动作的 ID，不执行表达式。

例如先 `agent.save` 创建 `role: "worker", grants: []` 的人员，再以 `agentId: "$actions[0].id"` 调用 `task.create`。仍须明确授权目标的 `goalId` 与父任务 `parentId`，执行器及模型按任务约定选择。ACMS 在一个事务内执行所有动作，任何一项失败均回滚角色、任务、命令回执与审计事件。每个动作沿用原有权限、目标范围、限额校验，并同时受执行开始时捕获的授权与当前授权限制；管理者不能扩大自己的授权范围。

提交成功后，ACMS 回收本轮资源，再自动唤醒管理者。下一轮 `CONTRACT.managementResults` 包含已提交批次的真实返回值，管理者可据此生成交付物，或继续必要的管理动作（每个任务约定最多 4 次续轮）。重试应使用相同 `actionBatchId` 和相同动作，返回相同 ID，不重复创建；同一批次名的不同输入会被拒绝。合同版本改变后重新划分批次作用域。管理者最终仍需提交可验证交付物并通过独立审查。

## 测试边界

`test/paired.test.js` 使用真实子进程和模拟模型响应，验证配对、一次性接受、变更拒绝、手动检测、自动执行/审查、模型身份校验和取消回收。`scripts/structure-test.mjs` 覆盖完整配对界面，并断言打开页面、切换模型和读取回执不会请求检测接口。它们不证明任意第三方 CLI 已经适配成功；实际使用前应配对具体环境并手动检测。
