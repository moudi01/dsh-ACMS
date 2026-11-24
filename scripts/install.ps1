[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-package.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath $DshCommand)) { throw "DSH CLI not found: $DshCommand" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'lib\client.js'))) { throw 'Run npm ci and npm run build first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Run npm ci before installing.' }
$profileRoot = Join-Path (Join-Path $DshHomePath 'profiles') $TargetProfile
$profileManifest = Join-Path $profileRoot 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) { throw "Profile does not exist: $TargetProfile. Initialize it with DSH first." }
if (-not $DataDirectory) { $DataDirectory = Join-Path $DshHomePath 'acms' }
$DataDirectory = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($DataDirectory))
function YamlValue([string]$Value) { return "'" + $Value.Replace('\', '/').Replace("'", "''") + "'" }
$key = [Guid]::NewGuid().ToString('N')
$staged = Join-Path $profileRoot ".acms-install-$key.tmp"
$previousDshHome = $env:DSH_HOME
$profileLock = Lock-AcmsProfile $profileRoot
$admission = $null
try {
  $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
  $hadPatch = Test-Path -LiteralPath $patchPath -PathType Leaf
  if (-not $hadPatch -and (Test-Path -LiteralPath $patchPath)) { throw 'Expected cordis.patch.yml to be a file.' }
  $original = if ($hadPatch) { [IO.File]::ReadAllText($patchPath) } else { '' }
  $existing = [regex]::Replace($original, '(?m)^\s*\[\]\s*(?:#[^\r\n]*)?\r?\n?', '')
  $existing = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
  $lines = @('# BEGIN ACMS MANAGED CONFIG', '- id: acms', '  config:', ('    dataDir: ' + (YamlValue $DataDirectory)), '# END ACMS MANAGED CONFIG')
  $next = $existing.TrimEnd() + "`n" + ($lines -join "`n") + "`n"
  $previous = Get-AcmsRegistration $profileRoot
  $env:DSH_HOME = $DshHomePath
  $activeDirectories = @(Get-AcmsActiveDataDirectories $DshCommand $TargetProfile)
  $modulePath = Join-Path $profileRoot 'node_modules\dsh-acms'
  if ($activeDirectories.Count -eq 1 -and $activeDirectories[0] -eq $DataDirectory -and $previous.StartsWith('link:') -and
      [IO.Path]::GetFullPath($previous.Substring(5), [IO.Path]::GetFullPath($profileRoot)) -eq $projectRoot -and
      (Test-Path -LiteralPath $modulePath -PathType Container) -and ([IO.Directory]::ResolveLinkTarget($modulePath, $true)).FullName -eq $projectRoot) {
    Write-Output "ACMS already installed in profile '$TargetProfile'. Data: $DataDirectory"
    return
  }
  $backups = Join-Path $DataDirectory 'install-backups'
  try { [IO.Directory]::CreateDirectory($backups) | Out-Null }
  catch { throw "Could not prepare ACMS install backups: $($_.Exception.Message)" }
  $admission = Open-AcmsInstallAdmission @($activeDirectories + $DataDirectory)
  $manifestBackup = Join-Path $backups "package-$key.json"
  [IO.File]::Copy($profileManifest, $manifestBackup)
  if ($hadPatch) { [IO.File]::Copy($patchPath, (Join-Path $backups "profile-$key.yml")) }
  if ($next -cne $original) { [IO.File]::WriteAllText($staged, $next, [Text.UTF8Encoding]::new($false)) }
  try {
    & $DshCommand plugin --profile $TargetProfile add $projectRoot --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin add failed.' }
    $admission.StandardInput.WriteLine('verify')
    $admission.StandardInput.Flush()
    Read-AcmsInstallAdmission $admission
    Publish-AcmsProfilePatch $patchPath $hadPatch $original $staged
  } catch {
    $failure = $_
    try { Restore-AcmsRegistration $profileRoot $previous $DshCommand $TargetProfile }
    catch { throw "ACMS install failed: $($failure.Exception.Message) Automatic registration recovery failed: $($_.Exception.Message) Previous registration backup: $manifestBackup" }
    throw $failure
  }
  Write-Output "ACMS installed in profile '$TargetProfile'. Data: $DataDirectory"
  Write-Output 'Restart DSH when existing work is safely paused. Open ACMS from the DSH sidebar.'
} finally {
  $env:DSH_HOME = $previousDshHome
  try {
    Close-AcmsInstallAdmission $admission
    if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }
  }
  finally { $profileLock.Dispose() }
}
