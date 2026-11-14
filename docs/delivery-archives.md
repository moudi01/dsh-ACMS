# 完整交付归档校验

执行器提交完整源码或交接 ZIP 时，在产物声明中使用 `archiveFormat: "acms-delivery/1"`。宿主保存最终 ZIP 的原始字节，并在交付进入集成前验证内部清单。普通文件及未声明此合同的历史 ZIP 仍可作为普通产物提交，但没有归档一致性证明。文件名、扩展名和外层校验和不代表已通过该校验。

```json
{
  "outcome": "completed",
  "summary": "交付源码及验收证据",
  "artifacts": [
    { "path": "delivery.zip", "title": "完整交付包", "archiveFormat": "acms-delivery/1" }
  ]
}
```

## 清单合同 v1

ZIP 根目录必须有 UTF-8 JSON 文件 `acms-delivery.json`。清单列出所有普通文件，唯独不列清单自身。`path` 是 ZIP 内路径，`sourcePath` 是打包前的项目相对路径；二者均使用 `/`。同一原始路径只能出现一次。下例的 `hello.txt` 恰好包含 5 个 ASCII 字节 `hello`，没有末尾换行。

```json
{
  "format": "acms-delivery/1",
  "hashAlgorithm": "sha256-bytes",
  "files": [
    {
      "path": "source/hello.txt",
      "sourcePath": "hello.txt",
      "role": "release",
      "bytes": 5,
      "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    },
    { "path": "source/obsolete.txt", "sourcePath": "obsolete.txt", "role": "deleted" }
  ]
}
```

`role` 取值：`release` 为可发布文件，`evidence` 为检查日志等证据文件，`deleted` 为需要下游移除的原始路径。前两者必须提供非负整数 `bytes` 和 64 位小写十六进制 `sha256`；删除项不能提供这两个字段，ZIP 中不得存在该路径或其子项。删除项只表达交付意图，校验器不删除任何文件。目录条目仅用于 ZIP 结构，不列入文件清单。

`sha256` 计算原始文件字节，保留 LF/CRLF、Unicode 编码、二进制及空文件；不对文本做换行或编码转换。ACMS 现有 `artifact.hash` 是 **Base64 文本的 SHA-256**，不是文件字节 SHA-256，二者不可互换。Node.js 计算文件摘要的方式：

```js
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const bytes = await readFile('hello.txt');
const entry = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
```

先冻结待打包文件并生成清单，再生成最终 ZIP，最后对最终 ZIP 运行校验。宿主另外保存 `manifestSha256`（清单实际字节）和 `archiveSha256`（整个 ZIP 实际字节），避免清单自引用。清单中的额外说明字段不赋予权限或批准；实际来源任务、执行尝试、任务代次和目标合同版本由宿主填写。

## 支持范围与限制

支持单卷、非 ZIP64、stored 或 deflate ZIP，支持数据描述符；非 ASCII 文件名必须设置 UTF-8 标志。拒绝加密、不支持的压缩、链接、Unix 链接扩展、备用 Unicode 路径扩展、隐藏/重叠条目、头部不一致、CRC 错误以及越界路径。v1 不接受自解压 ZIP 或额外的 ZIP 数字签名记录。

路径不能包含反斜杠、绝对路径、盘符、`..`、空分段、控制字符、Windows 设备名或末尾空格/点。重复路径、大小写冲突和 Unicode NFC 等价冲突均拒绝。清单条目与 ZIP 文件名必须精确匹配。ZIP 路径与 `sourcePath` 均检查文件/目录冲突，`src` 文件与 `src/file.js` 不能同时出现，无论条目顺序如何。路径树按分段增量校验，不反复扫描全部前缀。

每个包上限为 64 MiB 压缩字节、10,000 个 ZIP 条目、32 MiB 单文件、128 MiB 总解压字节和 2 MiB 清单。公司现有 `maxArtifactBytes` 同时生效，取更小范围。宿主在独立 worker 中逐项有界解压并计算摘要，不阻塞调度事件循环，不向任何目标目录解压，不执行包内文件。暂停/取消沿用执行信号，等待 worker 退出后返回，取消不会产生通过证据。一次报告最多列出 100 项内容差异；结构损坏会立即停止解析。

## 失败与证据复用

失败保留不可变 artifact blob，并在原有“产物与验收”的检查记录中写入 `archive:<产物路径>`、错误码、路径及预期/实际摘要与大小。宿主不会把失败交付标为已完成或送入集成，后续沿用现有技术失败及返工流程。错误清单与原始包随产物保留；修复后必须提交并重新验证新版本，不能沿用旧批准。

通过的 `artifact.archiveVerification` 包含清单、包/清单字节摘要、数量及宿主绑定的来源版本。完整报告保存在产物记录中，原有授权范围内的外部 API 产物读取仍返回完整内容。下游任务的 `CONTRACT.inputArtifacts` 及独立任务/目标审查只注入摘要与 `manifestReference`，三处共用每次提示词 16 KiB 的摘要预算；达到预算后省略后续摘要，通过 `archiveEvidenceBudget` 标记。省略不代表批准，产物 ID 和不可变 ZIP 路径仍保留，执行器可按需从该 ZIP 读取 `acms-delivery.json`，与提供的清单字节摘要核对。原有审查批准记录仍绑定交付指纹；`passed: true` 只表示归档字节与清单一致，不表示源码完整性、功能正确性或人类/模型审查已批准。

修改 ZIP 内任意文件、清单元数据或重新打包都会改变外层字节摘要。集成仍检查当前工作副本是否与已交付产物一致。外部发布者应读取不可变 blob，并复核最终将发布的 ZIP，不能把旧报告应用到新包上。

独立检查无需启动 DSH 或模型：

```powershell
node scripts/verify-delivery-archive.mjs path/to/delivery.zip
node --test test/delivery-archive.test.js
node --test test/delivery-archive-review.test.js
```

命令输出 JSON 报告，退出码 `0` 为通过、`1` 为校验失败、`2` 为用法或读取失败。自动化测试覆盖中文/混合 Unicode、两种换行、空文件、二进制、缺失/多余/重复项、删除项、清单更新、归档篡改、越界/链接/压缩限制、交付阻断、持久证据、审查/依赖传播和授权读取。测试使用临时数据库及确定性执行器，不调用真实模型。此检查不能发现“中文已变成合法 ASCII 问号”之类内容质量问题（#19），也不能替代多任务成果汇总（#34）。
