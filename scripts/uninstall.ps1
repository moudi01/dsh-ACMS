[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$RemoveCodexProvider
)
$ErrorActionPreference = 'Stop'
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $DshHomePath
  & $DshCommand plugin --profile $TargetProfile remove dsh-acms
  if ($LASTEXITCODE -ne 0) { throw 'DSH plugin removal failed.' }
  if ($RemoveCodexProvider) { & $DshCommand plugin --profile $TargetProfile remove dsh-acms-codex; if ($LASTEXITCODE -ne 0) { throw 'Provider removal failed.' } }
  $patchPath = Join-Path (Join-Path (Join-Path $DshHomePath 'profiles') $TargetProfile) 'cordis.patch.yml'
  if (Test-Path -LiteralPath $patchPath) {
    $existing = [IO.File]::ReadAllText($patchPath)
    $provider = [regex]::Match($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?(^- id: acms-codex\r?\n.*?)(?=^# END ACMS MANAGED CONFIG)')
    $replacement = if (-not $RemoveCodexProvider -and $provider.Success) { "# BEGIN ACMS MANAGED CONFIG`n" + $provider.Groups[1].Value.TrimEnd() + "`n# END ACMS MANAGED CONFIG`n" } else { '' }
    $changed = [regex]::Replace($existing, '(?ms)^# BEGIN ACMS MANAGED CONFIG\r?\n.*?^# END ACMS MANAGED CONFIG\r?\n?', [Text.RegularExpressions.MatchEvaluator]{param($match) $replacement})
    $meaningfulLines = @($changed -split '\r?\n' | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') })
    if (-not $meaningfulLines.Count) { $changed = $changed.TrimEnd() + "`n[]`n" }
    [IO.File]::WriteAllText($patchPath, $changed, [Text.UTF8Encoding]::new($false))
  }
  Write-Output 'ACMS removed. Company database, deliverables, worktrees and Codex authentication are retained.'
} finally { $env:DSH_HOME = $previousDshHome }
