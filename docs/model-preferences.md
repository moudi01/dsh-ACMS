# 模型偏好与自动选择

ACMS 允许所有者持久设置有序的模型偏好。偏好只影响自动选择，不改变公司授权、角色的显式绑定或模型的真实能力。所有设置都由领域命令写入并记录审计事件，不需要重启，也不会打开模型检测。

## 选择优先级

从高到低：

1. 显式绑定：角色的 model、非 auto 的 provider、llmProvider 或 reasoningEffort 必须精确匹配授权候选；没有匹配就阻塞，不会改用偏好替代。
2. 授权：公司策略的 allowedProviders、allowedModels、provider 是否存在、模型是否在目录中。偏好不能扩大授权。
3. 任务硬能力：任务 requirements 中标记为 required 的能力必须明确受支持。unknown 或未声明的能力不满足硬要求。
4. 可用性：模型健康状态不是 unavailable；verified 为 required 时还要求健康状态为 available。
5. 用户偏好：按 modelPreferences.order 从第 0 项开始，对每个条目筛选合格候选；条目中的 provider、llmProvider、reasoningEffort 作为额外过滤。同一偏好条目内，continuity 为 preferred 的软匹配优先，然后按固定入口顺序。
6. 稳定默认：没有偏好或偏好都不适用时，先按软能力匹配，再按 DSH 默认选择与固定入口顺序（spawn、fork、配对列表顺序）。没有偏好时与基线行为一致。

## 思考深度与选路一致性

选择结果里的 chosen.reasoningEffort 就是启动时实际使用的思考深度：显式绑定或任务 reasoningEffort 优先，否则使用所选通道的默认深度。

- 启动前读取模型详情时使用的就是已经选出的同一个 provider / model / llmProvider / 深度；不会再拿原角色重新选一次路。
- 详情读取、attempt.selection、attempt.reasoningEffort 与 startActivation 的 agentOptions 必须描述同一结果。
- 内部 DSH 入口在目录尚未声明思考深度时允许先选出候选，但在启动前用模型详情校验；不支持时任务以 model-selection 阻塞（EXPLICIT_BINDING_UNAVAILABLE 或 NO_ELIGIBLE_CANDIDATE，回退原因 route_mismatch 或 capability_unknown），不会被偏好或其他候选静默替换。
- 外部配对入口无法在启动前读取详情；角色显式要求的深度与配对声明的 reasoningEffort 不一致，或声明为未知时，选择阶段就按 capability_unknown / route_mismatch 排除，不会启动外部执行器。
- 已声明且一致的深度仍然可用，例如配对声明 high 且角色绑定 high。

## 设置与清除

在「模型列表 → 模型偏好」中可以从当前模型目录添加条目、上移、下移、填写标签、保存或清除。列表顺序就是优先级顺序，最多 20 项。

- 保存：model.preferences.set，参数为 order 和可选的 expectedRevision。
- 清除：model.preferences.clear，参数为可选的 expectedRevision。清除后记录仍存在，order 为空数组，版本号递增，便于审计。
- 只有 owner/system 能写；manager 和外部 user-agent 只能读。
- 保存和查看只读取公司快照，不发送 model-check 或 model-details 请求，也不启动模型。

每条偏好包含 id（pref_...）、model（必填，1–200 字符）、可选的 provider、llmProvider、reasoningEffort 和 label。相同 model、provider、llmProvider、reasoningEffort 组合不能重复。

## 持久化与迁移

偏好保存在 SQLite 的 entities 集合 modelPreferences（单例 id 为 model）中，顺序、版本、更新时间和更新者都会保留。旧数据库没有该记录时直接按空偏好处理，不需要 schema 迁移，行为与基线默认一致。外部 status、界面快照和负责人合同都读取同一份数据。

## 能力未知与续接

- 内部 provider 的能力来自运行时观测：任务上下文是否续接、父代理上下文、运行中消息、工具和沙箱都有明确来源。
- 外部配对入口只有配对配置声明的持久线程能力可信；未声明的父上下文继承必须是 null（未知），运行中消息、工具和沙箱保持 unknown。
- 不得从 provider 名字、模型名或用户代理请求推断续接能力。continuity 为 preferred 只做软排序，不会让未知能力变成支持。
- 人员留任（longLived）不等于线程续接，不能映射成 continuity 为 required。

## 回退与阻塞

选择结果会记录在 attempt.selection，并产生 attempt.route.selected 事件：

- binding.mode：explicit、preference 或 default。
- preferenceIndex：选中偏好条目的序号；默认选择为 null。
- chosen.reasoningEffort：实际使用的思考深度，可能与候选默认深度不同。
- fallbacks：被排除候选的原因，封闭枚举包括 unauthorized_provider、unauthorized_model、health_unavailable、capability_mismatch、capability_unknown、route_mismatch、preference_model_absent、explicit_binding_absent。
- blocked.code：EXPLICIT_BINDING_UNAVAILABLE、NO_AUTHORIZED_PROVIDER、NO_ELIGIBLE_CANDIDATE 或 CAPABILITY_UNKNOWN。

偏好条目不可用时，逐候选记录原因；显式绑定不可用直接阻塞，不会静默改用偏好。没有合格候选同样是阻塞而不是临时错误：任务保持 blocked，创建待处理问题，不自动重试，直到所有者或负责人调整绑定、偏好或补充候选。

偏好条目的授权回退按以下优先顺序归类：偏好模型不在 allowedModels → unauthorized_model；偏好入口不在 allowedProviders → unauthorized_provider；模型未被任何已授权入口提供 → preference_model_absent；其余不匹配 → route_mismatch。因此同一模型由多个入口提供时，未授权的入口不会被误报为 route_mismatch。详情读取与启动使用同一个已选路由（provider + llmProvider + model），详情缓存按完整路由区分，切换模型不会复用旧模型的思考深度。

## 负责人可见性与一致性

负责人合同包含只读 modelContext，列出候选能力、当前偏好顺序、任务要求默认值和授权策略。负责人设置角色绑定时不会触发模型详情或连通性检测；实际任务启动时使用与负责人合同相同的选择函数。任务与独立审查使用各自的 contextKey，偏好或绑定不会合并两者上下文。

## 检测边界

设置、查看、排序、保存和清除偏好都不会调用模型，也不会隐式执行连通性检测。只有用户点击「检测模型连通性」才会发送真实简短请求。检测结果缓存在 modelHealth 中，选择器只读缓存，不主动探测。

## 测试

- test/model-preferences.test.js：保存、排序、清除、重启持久化、幂等、校验、owner/system 边界、任务要求与任务/审查上下文隔离。
- test/model-selection.test.js：偏好顺序、稳定默认、多入口、显式绑定、授权、能力未知、软排序、回退、阻塞、选择不探测、要求深度写入选择结果、未知外部深度失败关闭、内部深度延后校验。
- test/models.test.js：任务要求驱动详情与启动参数一致、显式绑定下的要求深度传递、未知外部深度启动前阻塞且不被偏好替换、内部深度不支持时启动前阻塞。
- scripts/model-preferences-ui-test.mjs：偏好添加、排序、标签、保存、清除以及选择依据和回退原因展示，断言期间没有检测请求。

## 本轮返工修正

独立审查复现的三个缺陷已修复：启动时不再用原角色重新读取模型详情；要求的思考深度会写入选择记录并传递给启动参数；未知思考深度不再放行显式要求。对应回归测试在修复前失败、修复后通过，原始证据见 docs/iteration-2-sources/issue-5/regression-red.txt 与 targeted-tests.txt。

## chat 入口一致性（本轮补充）

独立审查发现 chat 入口在偏好模型不可用时二次选路：先选出 m1/low，又用 ignoreHealth 重新选中 m2 并读取其详情，最终向 m1 传入 max。现已改为单次选择：chat 使用与任务启动相同的 select 和 providerFor，并按已选完整路由读取详情；思考深度不支持时与 start 使用同一选择阻塞错误。详情缓存按完整路由区分，任务、审查和独立对话仍使用各自上下文 key 与选择结果。回归见 test/issue5-chat-route.test.js。
