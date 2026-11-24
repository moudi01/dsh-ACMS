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
$intent = Join-Path $profileRoot '.acms-install-pending.json'
$stagedIntent = Join-Path $profileRoot ".acms-install-$key.json.tmp"
function Write-InstallIntent([string]$Text) {
  $stream = [IO.File]::Open($stagedIntent, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  [IO.File]::Move($stagedIntent, $intent, $true)
}
$previousDshHome = $env:DSH_HOME
$profileLock = Lock-AcmsProfile $profileRoot
$admission = $null
try {
  $patchPath = Join-Path $profileRoot 'cordis.patch.yml'
  $original = Read-AcmsProfilePatch $patchPath
  $existing = [regex]::Replace($original.Text, '(?m)^\s*\[\]\s*(?:#[^\r\n]*)?\r?\n?', '')
  $existing = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
  $lines = @('# BEGIN ACMS MANAGED CONFIG', '- id: acms', '  config:', ('    dataDir: ' + (YamlValue $DataDirectory)), '# END ACMS MANAGED CONFIG')
  $next = $existing.TrimEnd() + "`n" + ($lines -join "`n") + "`n"
  $nextBytes = [Text.Encoding]::UTF8.GetBytes($next)
  $nextDigest = if ($next -ceq $original.Text) { $original.Sha256 } else { Get-AcmsPatchDigest $nextBytes }
  $previous = Get-AcmsRegistration $profileRoot
  $env:DSH_HOME = $DshHomePath
  $modulePath = Join-Path $profileRoot 'node_modules\dsh-acms'
  $registered = $previous.StartsWith('link:') -and
      [IO.Path]::GetFullPath($previous.Substring(5), [IO.Path]::GetFullPath($profileRoot)) -eq $projectRoot -and
      (Test-Path -LiteralPath $modulePath -PathType Container) -and ([IO.Directory]::ResolveLinkTarget($modulePath, $true)).FullName -eq $projectRoot
  $previousIntent = $null
  $published = $false
  $resume = $false
  if ([IO.File]::Exists($intent)) {
    $previousIntent = [IO.File]::ReadAllText($intent)
    $pending = $previousIntent | ConvertFrom-Json
    if ($pending.patchSha256 -cnotmatch '^[0-9A-F]{64}$') { throw "Invalid ACMS installation record: $intent" }
    if ($pending.patchSha256 -ceq $original.Sha256) {
      $published = $true
    } elseif (-not $pending.PSObject.Properties['originalPatchSha256'] -or $pending.originalPatchSha256 -cne $original.Sha256) {
      throw "ACMS profile configuration differs from both states in the pending installation. Review the current configuration before proceeding. Pending record: $intent Previous registration backup: $($pending.registrationBackup)"
    } elseif ($pending.candidate -ne $projectRoot -or $pending.dataDirectory -ne $DataDirectory -or $pending.patchSha256 -cne $nextDigest) {
      throw "Retry the pending ACMS installation with candidate '$($pending.candidate)' and data directory '$($pending.dataDirectory)'. Pending record: $intent Previous registration backup: $($pending.registrationBackup)"
    } else {
      $resume = $true
    }
  }
  $activeDirectories = @(Get-AcmsActiveDataDirectories $DshCommand $TargetProfile)
  if ($published) {
    [IO.File]::Delete($intent)
    $previousIntent = $null
  }
  if ($registered -and -not $resume -and $activeDirectories.Count -eq 1 -and $activeDirectories[0] -eq $DataDirectory) {
    Write-Output "ACMS already installed in profile '$TargetProfile'. Data: $DataDirectory"
    return
  }
  $backups = Join-Path $DataDirectory 'install-backups'
  try { [IO.Directory]::CreateDirectory($backups) | Out-Null }
  catch { throw "Could not prepare ACMS install backups: $($_.Exception.Message)" }
  $admission = Open-AcmsInstallAdmission @($activeDirectories + $DataDirectory)
  $manifestBackup = Join-Path $backups "package-$key.json"
  [IO.File]::Copy($profileManifest, $manifestBackup)
  if ($null -ne $original.Sha256) { [IO.File]::WriteAllBytes((Join-Path $backups "profile-$key.yml"), $original.Bytes) }
  if ($nextDigest -cne $original.Sha256) { [IO.File]::WriteAllBytes($staged, $nextBytes) }
  $registrationBackup = if ($resume) { $pending.registrationBackup } else { $manifestBackup }
  if ($resume) { Write-Output "Resuming ACMS installation. Previous registration backup: $registrationBackup" }
  # The CLI registration and the profile patch are published separately.
  Write-InstallIntent (@{ candidate = $projectRoot; dataDirectory = $DataDirectory; originalPatchSha256 = $original.Sha256
    patchSha256 = $nextDigest; registrationBackup = $registrationBackup } | ConvertTo-Json -Compress)
  try {
    if (-not ($resume -and $registered)) {
      & $DshCommand plugin --profile $TargetProfile add $projectRoot --ignore-scripts
      if ($LASTEXITCODE -ne 0) { throw 'DSH plugin add failed.' }
    }
    $admission.StandardInput.WriteLine('verify')
    $admission.StandardInput.Flush()
    Read-AcmsInstallAdmission $admission
    Publish-AcmsProfilePatch $patchPath $original $staged
  } catch {
    $failure = $_
    try {
      Restore-AcmsRegistration $profileRoot $previous $DshCommand $TargetProfile
      if ($previousIntent) { Write-InstallIntent $previousIntent }
      else { [IO.File]::Delete($intent) }
    }
    catch { throw "ACMS install failed: $($failure.Exception.Message) Automatic registration recovery failed: $($_.Exception.Message) Previous registration backup: $manifestBackup" }
    throw $failure
  }
  [IO.File]::Delete($intent)
  Write-Output "ACMS installed in profile '$TargetProfile'. Data: $DataDirectory"
  Write-Output 'Restart DSH when existing work is safely paused. Open ACMS from the DSH sidebar.'
} finally {
  $env:DSH_HOME = $previousDshHome
  try {
    Close-AcmsInstallAdmission $admission
    if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }
    if ([IO.File]::Exists($stagedIntent)) { [IO.File]::Delete($stagedIntent) }
  }
  finally { $profileLock.Dispose() }
}
