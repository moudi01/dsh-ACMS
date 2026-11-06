[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath $DshCommand)) { throw "DSH CLI not found: $DshCommand" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'lib\client.js'))) { throw 'Run npm ci and npm run build first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Run npm ci before installing.' }
$profileRoot = Join-Path (Join-Path $DshHomePath 'profiles') $TargetProfile
if (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'package.json'))) { throw "Profile does not exist: $TargetProfile. Initialize it with DSH first." }
if (-not $DataDirectory) { $DataDirectory = Join-Path $DshHomePath 'acms' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
function YamlValue([string]$Value) { return "'" + $Value.Replace('\', '/').Replace("'", "''") + "'" }
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $DshHomePath
  & $DshCommand plugin --profile $TargetProfile add $projectRoot --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'DSH plugin add failed.' }
  $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
  $existing = if (Test-Path -LiteralPath $patchPath) { [IO.File]::ReadAllText($patchPath) } else { '' }
  $existing = [regex]::Replace($existing, '(?m)^\s*\[\]\s*(?:#[^\r\n]*)?\r?\n?', '')
  $existing = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDirectory 'install-backups') | Out-Null
  if (Test-Path -LiteralPath $patchPath) { Copy-Item -LiteralPath $patchPath -Destination (Join-Path $DataDirectory ('install-backups\profile-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff') + '.yml')) }
  $lines = @('# BEGIN ACMS MANAGED CONFIG', '- id: acms', '  config:', ('    dataDir: ' + (YamlValue $DataDirectory)))
  $lines += '# END ACMS MANAGED CONFIG'
  [IO.File]::WriteAllText($patchPath, $existing.TrimEnd() + "`n" + ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
  Write-Output "ACMS installed in profile '$TargetProfile'. Data: $DataDirectory"
  Write-Output 'Restart DSH when existing work is safely paused. Open ACMS from the DSH sidebar.'
} finally { $env:DSH_HOME = $previousDshHome }
