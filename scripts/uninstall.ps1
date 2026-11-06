[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh')
)
$ErrorActionPreference = 'Stop'
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $DshHomePath
  & $DshCommand plugin --profile $TargetProfile remove dsh-acms
  if ($LASTEXITCODE -ne 0) { throw 'DSH plugin removal failed.' }
  $patchPath = Join-Path (Join-Path (Join-Path $DshHomePath 'profiles') $TargetProfile) 'cordis.patch.yml'
  if (Test-Path -LiteralPath $patchPath) {
    $existing = [IO.File]::ReadAllText($patchPath)
    $changed = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', '')
    $meaningfulLines = @($changed -split '\r?\n' | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') })
    if (-not $meaningfulLines.Count) { $changed = $changed.TrimEnd() + "`n[]`n" }
    [IO.File]::WriteAllText($patchPath, $changed, [Text.UTF8Encoding]::new($false))
  }
  Write-Output 'ACMS removed. Company database, deliverables, worktrees are retained.'
} finally { $env:DSH_HOME = $previousDshHome }
