[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-package.ps1')
$profileRoot = Join-Path (Join-Path $DshHomePath 'profiles') $TargetProfile
if (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'package.json') -PathType Leaf)) { throw "Profile does not exist: $TargetProfile." }
$patchPath = Join-Path $profileRoot 'cordis.patch.yml'
$staged = Join-Path $profileRoot ('.acms-uninstall-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$previousDshHome = $env:DSH_HOME
$profileLock = Lock-AcmsProfile $profileRoot
try {
  $previous = Get-AcmsRegistration $profileRoot
  $hadPatch = Test-Path -LiteralPath $patchPath -PathType Leaf
  if (-not $hadPatch -and (Test-Path -LiteralPath $patchPath)) { throw 'Expected cordis.patch.yml to be a file.' }
  $original = if ($hadPatch) { [IO.File]::ReadAllText($patchPath) } else { '' }
  $changed = [regex]::Replace($original, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
  if ($changed -match '(?m)^# (?:BEGIN|END) ACMS MANAGED CONFIG\r?$') { throw 'The ACMS profile configuration block is incomplete.' }
  if ($changed -cne $original) {
    $meaningfulLines = @($changed -split '\r?\n' | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') })
    if (-not $meaningfulLines.Count) { $changed = $changed.TrimEnd() + "`n[]`n" }
    [IO.File]::WriteAllText($staged, $changed, [Text.UTF8Encoding]::new($false))
  }
  $env:DSH_HOME = $DshHomePath
  try {
    if ($previous) {
      & $DshCommand plugin --profile $TargetProfile remove dsh-acms
      if ($LASTEXITCODE -ne 0 -or (Get-AcmsRegistration $profileRoot)) { throw 'DSH plugin removal failed.' }
    }
    Publish-AcmsProfilePatch $patchPath $hadPatch $original $staged
  } catch {
    $failure = $_
    try { Restore-AcmsRegistration $profileRoot $previous $DshCommand $TargetProfile }
    catch { throw "ACMS uninstall failed: $($failure.Exception.Message) Automatic registration recovery failed: $($_.Exception.Message) Retry uninstall to clear the remaining managed configuration." }
    throw $failure
  }
  Write-Output 'ACMS removed. Company database, deliverables, worktrees are retained.'
} finally {
  $env:DSH_HOME = $previousDshHome
  try { if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) } }
  finally { $profileLock.Dispose() }
}
