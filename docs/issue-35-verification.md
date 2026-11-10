# Issue #35 验证记录

- Issue：[P2][交付] 提供完整产物下载与授权读取，保留二进制原始字节（https://github.com/moudi01/dsh-ACMS/issues/35）
- 仓库基线：`origin/main` `4687a3b2e4bc8eaed6aeafb38d2ff396d876ebf6`（Merge pull request #60）
- 实现提交：见本 PR 的实现提交（本记录在提交后补记 SHA）
- 验证日期：2026-11-10（Asia/Shanghai）
- 验证环境：Windows；Node.js `v24.22.0`；npm `11.19.1`；本机 Chrome（UI 下载检查）。未安装或升级运行中的 DSH，未调用真实模型。

## 1. 基线复现（真实静态证据）

基线 `4687a3b` 只有截断的文本预览，没有完整下载或外部机器读取入口：

```text
> git show 4687a3b:src/host/http.js | Select-String 'api/acms/artifact'
'/api/acms/artifact': async request => { ... content: bytes.subarray(0, 262144).toString('utf8'), truncated: ... }

> git show 4687a3b:src/host/agent-api.js | Select-String '/artifacts'
（无匹配：外部代理只能看到产物元数据）

> git show 4687a3b:src/client/app.jsx | Select-String '下载'
（无匹配：界面没有下载入口）
```

原始 blob 已按内容哈希保存在 `<dataDir>/artifacts/`，问题在产品入口不完整；这符合 issue 描述。

## 2. 改动范围

- `src/host/http.js`：新增 owner 路由 `GET /api/acms/artifact/download?id=`，按 artifact ID 读取不可变 blob 并返回完整原始字节；`content-length` 使用实际字节数，`content-disposition` 同时提供 ASCII 回退与 RFC 5987 `filename*=UTF-8''`，MIME 按扩展名白名单（未知扩展名 `application/octet-stream`），不修改预览接口。响应头返回 `x-acms-artifact-id`、`x-acms-artifact-hash`（ACMS Base64 文本摘要）与 `x-acms-artifact-sha256`（原始字节 SHA-256）以及实际字节数。
- 下载错误结构化返回：参数缺失 400、未知产物 404、blob 字节数与记录不符 409 `ARTIFACT_CORRUPT`、blob 缺失 410 `ARTIFACT_MISSING`、超过 `maxArtifactBytes` 413 `ARTIFACT_TOO_LARGE`；不在错误中泄漏本机路径或认证。
- `src/host/agent-api.js`：新增 `GET /artifacts/{id}`，要求 `status.read` 且目标在凭据范围内；返回元数据、`goalId`/`taskId`、`size`、`encoding:"base64"`、完整 `content` 与原始字节 `sha256`。跨目标、撤销/过期凭据、缺失/损坏/超大 blob 使用既有错误 envelope。
- `src/client/app.jsx`：产物预览弹窗增加“下载原始文件（N 字节）”链接，直接使用 owner 下载路由；预览截断提示改为“完整原始文件仍可下载”。
- `README.md`、`docs/agent-api.md`：说明下载入口、外部读取响应字段、错误码与两种摘要语义（ACMS `artifact.hash` 不可与原始字节 SHA-256 互换）。
- `test/artifact-download.test.js`（3 项）：二进制/300KB 文本/空文件/Unicode 文件名、只截断预览不影响下载、结构化错误与上限拒绝。
- `test/agent-api.test.js`：新增授权读取用例，覆盖同目标成功、跨目标 403、撤销凭据 401、未知产物 404，并校验 base64 与 SHA-256。
- `scripts/artifact-download-ui-test.mjs`：真实 Chrome 下载，比较原始字节、Unicode 文件名、空文件；`package.json` 与 CI 增加 `test:artifact-download`。

## 3. 命令与结果

| 命令 | 结果 | 覆盖范围 |
|---|---|---|
| `node --test test/artifact-download.test.js` | 3 项通过，0 失败 | 原始字节、预览/下载分离、错误与上限 |
| `node --test test/agent-api.test.js` | 28 项通过，0 失败（含新增授权读取） | 范围授权、撤销、摘要 |
| `npm test` | 507 项通过，0 失败，约 149 秒 | 全量核心、运行库与既有测试 |
| `npm run check` | 退出 0 | 语法与包契约 |
| `npm run check:docs` | 退出 0 | 文档一致性 |
| `npm run build` | 退出 0 | 客户端 bundle |
| `node scripts/artifact-download-ui-test.mjs` | `artifact download UI checks passed` | 面板下载、Unicode 名称、空文件 |
| `npm run test:ui` / `test:usability` / `test:display` | 见 CI 与下方记录 | 既有界面回归 |

以上结果来自实现提交的工作树。PR 推送后 GitHub Actions 会在最终 head 重新运行同一组命令；CI 结果以 PR 页面为准。

## 4. 验收标准对照

- [x] UI 可下载完整文件；超过 256 KiB 的文本、二进制、空文件及 Unicode 文件名下载后原始字节与 blob 一致：单元夹具与真实 Chrome 下载均比较逐字节内容；300KB 文件完整返回。
- [x] 文件名、MIME/Content-Disposition 合理，二进制不经 UTF-8 转码，文本预览截断不影响完整下载：响应直接返回原始 Buffer；预览仍截断到 262144 字节。
- [x] 外部代理只能获取凭据范围内任务的产物；跨目标、撤销/过期身份、无读取权限均被拒绝，不能退回 owner 路由绕过：`GET /artifacts/{id}` 要求 bearer 凭据、`status.read` 与目标范围；owner 路由与外部路由分离，无回退路径。
- [x] 不接受路径遍历或任意本机路径；接口不泄漏认证或其他目标数据：只接受 artifact ID，blob 路径来自产物记录；错误不包含本机路径或 token。
- [x] 返回大小与明确算法/口径的摘要，可验证完整性；缺失或损坏的 blob 返回结构化错误：`size`/`sha256`（原始字节）与 `x-acms-artifact-sha256`；410/409/413/404 结构化错误，不静默截断。
- [x] 下载采用有界资源方式，遵循现有产物大小与数据保留边界：读取前校验记录字节数与 `maxArtifactBytes`，超出返回 413；不提供批量 ZIP 或目录浏览。
- [x] 使用本地文件及授权夹具覆盖上述场景，读取不派生任务、不触发模型或修改业务状态：测试只读 store/blob，未调用模型；下载不写事件或业务状态。

## 5. 范围与限制

- 仅支持已有单文件产物；批量 ZIP、在线编辑、云存储不在本次范围。
- owner 下载依赖 DSH owner 连接路由；外部代理读取是 JSON Base64 响应（不是原始二进制流），受凭据范围与 `maxArtifactBytes` 约束。
- 下载将完整 blob 读入内存后作为有界响应发送（上限为 `maxArtifactBytes`，默认 16 MiB）；没有远程流式分块或断点续传。
- 不修改 ACMS 既有 `artifact.hash` 语义，也不声称已定位 #19 的编码损坏链；本 issue 只保证保存的 blob 可按原始字节完整取回。
- UI 检查使用预览服务与静态产物夹具，Chrome 无头运行；未部署或升级运行中的 DSH，未修改数据库、凭据或策略。
- 复现命令：`node scripts/artifact-download-ui-test.mjs`；完整测试：`npm test`；构建：`npm run build`。
