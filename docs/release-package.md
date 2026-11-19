# ACMS 安装候选包

在 GitHub Actions 中打开通过的 **ACMS validation** 运行，下载 `acms-release-<提交>-<运行尝试>` 产物。也可在本地检出需要的提交，并使用 Node.js 24、npm、Git 和 `tar` 运行 `npm run package:release`。脚本从 Git 的 `HEAD` 解出源码，在临时目录用 `npm ci` 安装锁定依赖并构建客户端。验证通过的产物写入 `dist/release/` 下的新目录。

产物目录中有 ACMS 的 `.tgz`、与该提交对应的 `package-lock.json` 和 `release-manifest.json`。清单记录提交、CI 运行及尝试编号、构建机平台和 Node.js/npm 版本。Node.js 和 DSH 范围取自包定义。校验包含解包后的依赖安装、宿主与运行库入口导入、客户端模块注册以及许可证文件检查。打包脚本会运行解包目录中的 `codex --version`，核对并记录实际启动器报告的版本。

在包含这三个文件的目录中，校验并解包到新的目录。

```powershell
$manifest = Get-Content -LiteralPath .\release-manifest.json -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    $hash = (Get-FileHash -LiteralPath $file.name -Algorithm SHA256).Hash
    if ($hash -ine $file.sha256) { throw "SHA-256 mismatch for $($file.name)" }
}
$archive = ($manifest.files | Where-Object { $_.name.EndsWith('.tgz') }).name
if (Test-Path -LiteralPath .\package) { throw 'Extract in a directory without an existing package folder.' }
tar -xzf $archive
if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed.' }
Copy-Item -LiteralPath .\package-lock.json -Destination .\package\package-lock.json
Set-Location .\package
npm ci --include=optional
```

依赖安装成功后，可按 [快速开始](../README.md#快速开始) 使用包内的安装脚本注册到已初始化的 DSH profile。候选包验证使用临时目录和模拟的模块加载器。实际 DSH 安装、升级回滚与模型验收见 [实际环境验收](validation.md#实际环境验收)。
