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

依赖安装成功后，可按 [快速开始](../README.md#快速开始) 使用包内的安装脚本注册到已初始化的 DSH profile。构建阶段在临时目录用模拟模块加载器校验客户端入口。

## 离线 DSH 安装验收

准备来自两个不同提交的本地候选目录，每个目录包含归档、锁文件及清单。使用装有 DSH CLI 的 Windows、Node.js 24、PowerShell 7 和已填充的 npm 缓存，在项目目录运行以下命令。候选来自本仓库的打包命令或可信 CI 产物。

```powershell
pwsh -File .\scripts\verify-release-install.ps1 `
  -DshCommand 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' `
  -PreviousCandidate 'D:\releases\previous' `
  -Candidate 'D:\releases\candidate'
```

验收用独立的临时 DSH_HOME，从内置 `web` 模板创建 profile。脚本校验两个候选的哈希并离线安装锁定依赖，再通过真实 DSH `plugin add`、`plugin remove` 和 `--dump-config` 核对首次安装、重复安装、候选切换及卸载。卸载以 profile 注销和合成配置为准。pnpm 可能保留未挂载的本地链接。通过临时数据库中的执行状态记录核对部署门禁，再构建版本化宿主、验证入口并从配置备份回退。验收核对原有非 ACMS 配置、数据库及样例交付文件。结果记录候选提交、归档哈希和工具版本，临时 profile 在结束时清理。

验收覆盖实际 CLI 注册及配置合成。宿主挂载、侧边栏、认证连接和模型执行由 [实际环境验收](validation.md#实际环境验收) 跟踪。

## 安装失败后的入口恢复

安装和卸载在同一 profile 内串行。对同一本地包和数据目录重复执行已完成的安装时，脚本保留当前宿主入口，包括已启用的版本化宿主。其他安装根据 DSH 合成配置核对当前运行目录，并在注册和发布期间对涉及的既有数据库执行部署空闲检查。

安装脚本先准备数据目录与备份，在注册候选前记录本次配置发布目标。若进程在注册后、配置发布前退出，用同一候选和数据目录重新执行安装。脚本会再次执行部署空闲检查，并打印中断前的注册备份路径。注册或发布报错时，脚本尝试使用离线缓存恢复原 ACMS 包入口。对本地链接候选，先保留旧解包目录，直到新配置验收通过。

如果原包已移除、缓存缺失或 DSH 拒绝恢复，报错会给出 `<dataDir>/install-backups/package-<编号>.json`。停止对应 profile，查看备份中 `dependencies.dsh-acms` 的原来源。使用 DSH 的插件命令恢复该包或取消新增注册，并通过 `--dump-config` 核对入口与 `dataDir`。如需恢复原 ACMS 配置，用同编号的 `profile-<编号>.yml` 核对旧配置块，保留当前其他插件的修改。
