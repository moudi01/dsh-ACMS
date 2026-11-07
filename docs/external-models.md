# 外部模型配对

ACMS 初始模型列表读取 DSH 的内部模型目录，外部模型经所有者配对确认后加入。

外部模型通过「模型列表 → 配对外部 agent」添加：生成配对 prompt，由目标 agent 准备运行入口，再由所有者核对回执。ACMS 使用本机回执文件与进程协议。

## 操作

1. 点击「配对外部 agent」，复制 prompt 到目标 agent。配对邀请有效期 24 小时，仅可接受一次。
2. 目标 agent 根据自己的实际 CLI/SDK 创建 runner，写入指定的 `response.json`。不要提交 API 密钥、登录数据库或环境变量；认证继续由目标运行环境管理。
3. 回到 DSH 点击「读取配对结果」。核对模型名称、程序绝对路径、固定参数、上下文能力和思考深度，再点「确认添加模型」。读取、添加都不会启动模型。
4. 对支持无工具检测的入口，点击「检测模型连通性」才发送实际简短请求。不支持时检测会在启动模型前拒绝，仍可登记并分配任务，但登记本身不能证明连通。
登记、读取回执和确认添加都不调用模型；不支持检测的入口不要求也没有替代的手动检测步骤。正式任务分配后 ACMS 自动启动执行入口；独立审查也会自动启动，不要求配对聊天一直打开。

本版本支持与 DSH 在同一台机器上的外部环境。远程 agent 需要额外的远程传输适配器，不能只填一个模型名称即使用。外部 runner 是用户确认的本机程序，需要遵守 prompt 中的隔离约定；ACMS 不会把任意自定义程序变成操作系统沙箱。

## 协议

`src/adapters/paired.js` 生成完整配对 prompt。回执包含 `protocol: acms.runner.v1`、邀请 ID 和随机 token、名称、真实模型 ID、绝对可执行路径、固定参数数组、`persistent`、可公开的 `reasoningEffort`、可选的 `probeSupported` 和不支持原因。Windows 使用 `.exe` 运行时加参数，不接受 `.cmd/.bat` 启动串。读取只校验数据和文件存在性；接受时重新校验 fingerprint，防止核对后回执被替换。

ACMS 以 `shell: false`、隐藏窗口方式启动程序，把单个 JSON 请求写入 stdin。请求包含模式 `probe/task`、随机 requestId、模型、prompt、隔离 cwd、contextKey、retainContext、sandbox 与 approvalPolicy。stdout 必须是一个 JSON 响应，日志写 stderr；退出、请求 ID、模型身份和完成事实都会校验。取消、超时、stdout 上限和启动失败都会在有限时间内终止本次执行所属的 Windows Job Object，并核实其中进程数为 0 后才算清理完成；无法证实时保留占位并保持核对。

检测是可选能力：仅在运行时可确认禁用所有工具和文件写入时声明支持，并使用独立上下文请求短回答；只读沙箱或提示词约束不足以声明支持。任务请求：按具体任务和审查角色隔离；只有配对 agent 声明支持续接时才传 `retainContext=true`。外部模型不能继承 DSH 父代理上下文。断电或重启后无法确认的外部执行仍进入核对状态，不盲目重复执行。

思考深度初始显示回执声明并标注来源，检测后显示 runner 返回值；未公开时显示未知。此能力及回答真实性依赖已确认的 runner 实现，不能把自报元数据当作服务端证明。

### 进程容器、回执与部署资源

外部执行当前只在 Windows 上提供已核实的进程容器：ACMS 用系统 .NET Framework64（`v4.0.30319`）的 `csc.exe` 编译固定的原生助手 `owned-job.cs`，以命名管道下发控制消息，并用 Job Object 维护本次执行的全部子孙进程。它不是安装其他 DSH 插件，也不改变模型运行环境的 sandbox 与 approvalPolicy；非 Windows 会在启动模型前返回 `PAIRED_CONTAINMENT_UNSUPPORTED`，缺少编译器、管道或 Job Object 权限时安全失败，不退化为按 PID 或进程组猜测。

构建把固定 C# 源码按内容哈希复制为 `owned-job-<hash>.cs`，并写入引用它的 `host-<hash>.mjs`。部署和回滚要把版本 host 与匹配资源成对保留、成对切换；只保留其中一个会使该宿主无法启动进程容器。

每次执行在宿主 `<dataDir>/paired-runs/` 留 `<runKey摘要>.json` 回执与同名 `.json.lock`。只有身份匹配、已结束且确认清理的终态才能恢复结果或允许重试；运行中、锁、缺失、损坏或身份错配保持核对与占位，没有人工强制释放入口。详见 [运行说明](operations.md)。

## Codex app-server 入口

支持 app-server 的 Codex 环境可在回执中声明 `runtime: "codex-app-server"`，由 `command` 和固定 `args` 直接启动 CLI。ACMS 使用内置 `@acms/codex-runtime` 管理线程、轮次、即时消息及进程清理，不另装 provider 插件。

该入口使用 app-server 的 JSON-RPC 协议，不使用单请求 runner 的 stdin/stdout 响应格式。模型和思考深度由回执明确指定；`persistent` 决定是否按任务键恢复线程，独立聊天和审查保持隔离。此入口必须声明 `probeSupported: false`，登记不会调用模型。

## 管理角色的派工与自动续跑

外部管理者不需要 DSH 内部工具，也能创建执行人员、使用其真实 ID 派发任务。返回 `outcome: "managed"`、稳定的 `actionBatchId` 和 `actions`（每批 1–10 项）即可。后续动作的参数可使用完整字符串 `$actions[0].id` 引用本批前一步返回的 ID；只允许引用更早动作的 ID，不执行表达式。

例如先 `agent.save` 创建 `role: "worker", grants: []` 的人员，再以 `agentId: "$actions[0].id"` 调用 `task.create`。仍须明确授权目标的 `goalId` 与父任务 `parentId`，执行器及模型按任务约定选择。ACMS 在一个事务内执行所有动作，任何一项失败均回滚角色、任务、命令回执与审计事件。每个动作沿用原有权限、目标范围、限额校验，并同时受执行开始时捕获的授权与当前授权限制；管理者不能扩大自己的授权范围。

提交成功后，ACMS 回收本轮资源，再自动唤醒管理者。下一轮 `CONTRACT.managementResults` 包含已提交批次的真实返回值，管理者可据此生成交付物，或继续必要的管理动作（每个任务约定最多 4 次续轮）。重试应使用相同 `actionBatchId` 和相同动作，返回相同 ID，不重复创建；同一批次名的不同输入会被拒绝。合同版本改变后重新划分批次作用域。管理者最终仍需提交可验证交付物并通过独立审查。

## 测试边界

`test/paired.test.js` 使用真实子进程和模拟模型响应，验证配对、一次性接受、变更拒绝、手动检测、自动执行/审查、模型身份校验和取消回收。
这些协议夹具只证明身份校验和清理路径，不是真实模型执行证据；真实业务验收需要在具体环境配对后实际派发任务。`scripts/structure-test.mjs` 覆盖完整配对界面，并断言打开页面、切换模型和读取回执不会请求检测接口。它们不证明任意第三方 CLI 已经适配成功；实际使用前应配对具体环境，支持无工具检测时可手动检测，不支持时不要求检测。
