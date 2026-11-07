# empty-models 脚本失败复核（#5 受影响界面）

- 原始失败日志：docs/iteration-2-sources/issue-5/empty-models-known-failure.txt（#5 实现工作副本 test-results 的记录）。
- 现象：Playwright 点击“组织管理”时 Timeout 30000ms；日志显示 <dialog open class="acms-modal wide" aria-labelledby="acms-pairing-title"> 拦截 pointer events。
- 复盘：脚本先打开配对弹窗并截图，未关闭就点击下层导航；弹窗正确阻断背景点击。属既有测试脚本顺序缺陷，不是产品界面缺陷；未发现对应产品回归。
- 修复：scripts/empty-models-test.mjs 在截图后点击“关闭配对”，断言 dialog 数为 0，再进入组织管理（仅新增 2 行，未改产品代码）。
- 绿色重跑：node scripts/empty-models-test.mjs 退出 0；test-results/empty-models-result.json 记录 pairingUsable=true、unboundRoleUsable=true、browserErrors=[]、automaticProbes=[]。
- 受影响界面结论：空模型目录下配对可用；未绑定角色的保存被禁用并提示“请选择 DSH 模型或已配对的外部模型”；无 pageerror；无 model-check/model-details 自动探测请求。
- 边界：这是隔离预览宿主加模拟执行器证据，不能替代真实 DSH 宿主与真实模型验收。
