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
$profileManifest = Join-Path $profileRoot 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) { throw "Profile does not exist: $TargetProfile. Initialize it with DSH first." }
if (-not $DataDirectory) { $DataDirectory = Join-Path $DshHomePath 'acms' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
function YamlValue([string]$Value) { return "'" + $Value.Replace('\', '/').Replace("'", "''") + "'" }
function Get-AcmsRegistration {
  return ([IO.File]::ReadAllText($profileManifest) | ConvertFrom-Json).dependencies.'dsh-acms'
}
function Restore-AcmsRegistration([string]$Registration) {
  if ([string](Get-AcmsRegistration) -ceq $Registration) { return }
  if ($Registration) {
    if ($Registration.StartsWith('link:')) {
      $previousPackage = [IO.Path]::GetFullPath($Registration.Substring(5), [IO.Path]::GetFullPath($profileRoot))
    } else { $previousPackage = "dsh-acms@$Registration" }
    & $DshCommand plugin --profile $TargetProfile add $previousPackage --ignore-scripts --offline | Out-Host
  } else {
    & $DshCommand plugin --profile $TargetProfile remove dsh-acms --offline | Out-Host
  }
  if ($LASTEXITCODE -ne 0 -or [string](Get-AcmsRegistration) -cne $Registration) { throw 'Could not restore the previous ACMS registration.' }
}
$patchPath = Join-Path $profileRoot 'cordis.patch.yml'
$hadPatch = Test-Path -LiteralPath $patchPath -PathType Leaf
if (-not $hadPatch -and (Test-Path -LiteralPath $patchPath)) { throw 'Expected cordis.patch.yml to be a file.' }
$original = if ($hadPatch) { [IO.File]::ReadAllText($patchPath) } else { '' }
$existing = [regex]::Replace($original, '(?m)^\s*\[\]\s*(?:#[^\r\n]*)?\r?\n?', '')
$existing = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
$lines = @('# BEGIN ACMS MANAGED CONFIG', '- id: acms', '  config:', ('    dataDir: ' + (YamlValue $DataDirectory)), '# END ACMS MANAGED CONFIG')
$next = $existing.TrimEnd() + "`n" + ($lines -join "`n") + "`n"
$previous = [string](Get-AcmsRegistration)
$backups = Join-Path $DataDirectory 'install-backups'
try { [IO.Directory]::CreateDirectory($backups) | Out-Null }
catch { throw "Could not prepare ACMS install backups: $($_.Exception.Message)" }
$key = [Guid]::NewGuid().ToString('N')
$manifestBackup = Join-Path $backups "package-$key.json"
[IO.File]::Copy($profileManifest, $manifestBackup)
if ($hadPatch) { [IO.File]::Copy($patchPath, (Join-Path $backups "profile-$key.yml")) }
$staged = Join-Path $profileRoot ".acms-install-$key.tmp"
$previousDshHome = $env:DSH_HOME
try {
  if ($next -cne $original) { [IO.File]::WriteAllText($staged, $next, [Text.UTF8Encoding]::new($false)) }
  $env:DSH_HOME = $DshHomePath
  try {
    & $DshCommand plugin --profile $TargetProfile add $projectRoot --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin add failed.' }
    $current = if (Test-Path -LiteralPath $patchPath -PathType Leaf) { [IO.File]::ReadAllText($patchPath) } else { '' }
    if ($current -cne $original -or (Test-Path -LiteralPath $patchPath -PathType Leaf) -ne $hadPatch) {
      throw 'Profile configuration changed during installation. Review the current configuration before retrying.'
    }
    if ([IO.File]::Exists($staged)) {
      try { [IO.File]::Move($staged, $patchPath, $true) }
      catch { throw "Could not publish the ACMS profile configuration: $($_.Exception.Message)" }
    }
  } catch {
    $failure = $_
    try { Restore-AcmsRegistration $previous }
    catch { throw "ACMS install failed: $($failure.Exception.Message) Automatic registration recovery failed: $($_.Exception.Message) Previous registration backup: $manifestBackup" }
    throw $failure
  }
  Write-Output "ACMS installed in profile '$TargetProfile'. Data: $DataDirectory"
  Write-Output 'Restart DSH when existing work is safely paused. Open ACMS from the DSH sidebar.'
} finally {
  $env:DSH_HOME = $previousDshHome
  if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }
}
