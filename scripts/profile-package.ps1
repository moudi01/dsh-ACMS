# Shared by ACMS install and uninstall. Windows releases the handle on process exit.
function Lock-AcmsProfile([string]$ProfileRoot) {
  $lockFile = Join-Path $ProfileRoot '.acms-package.lock'
  try {
    return [IO.FileStream]::new($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
  } catch {
    throw "Could not lock the ACMS profile for installation or removal: $($_.Exception.Message)"
  }
}

function Get-AcmsRegistration([string]$ProfileRoot) {
  $manifest = Join-Path $ProfileRoot 'package.json'
  return [string](([IO.File]::ReadAllText($manifest) | ConvertFrom-Json).dependencies.'dsh-acms')
}

function Restore-AcmsRegistration([string]$ProfileRoot, [string]$Registration, [string]$DshCommand, [string]$TargetProfile) {
  if ((Get-AcmsRegistration $ProfileRoot) -ceq $Registration) { return }
  if ($Registration) {
    if ($Registration.StartsWith('link:')) {
      $previousPackage = [IO.Path]::GetFullPath($Registration.Substring(5), [IO.Path]::GetFullPath($ProfileRoot))
    } else { $previousPackage = "dsh-acms@$Registration" }
    & $DshCommand plugin --profile $TargetProfile add $previousPackage --ignore-scripts --offline | Out-Host
  } else {
    & $DshCommand plugin --profile $TargetProfile remove dsh-acms --offline | Out-Host
  }
  if ($LASTEXITCODE -ne 0 -or (Get-AcmsRegistration $ProfileRoot) -cne $Registration) { throw 'Could not restore the previous ACMS registration.' }
}

function Get-AcmsPatchDigest([byte[]]$Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))
}

function Read-AcmsProfilePatch([string]$Patch) {
  if ([IO.Directory]::Exists($Patch)) { throw 'Expected cordis.patch.yml to be a file.' }
  try { $bytes = [IO.File]::ReadAllBytes($Patch) }
  catch [IO.FileNotFoundException] { return @{ Text = ''; Sha256 = $null } }
  $reader = [IO.StreamReader]::new([IO.MemoryStream]::new($bytes))
  try { return @{ Text = $reader.ReadToEnd(); Sha256 = Get-AcmsPatchDigest $bytes; Bytes = $bytes } }
  finally { $reader.Dispose() }
}

function Publish-AcmsProfilePatch([string]$Patch, [hashtable]$Original, [string]$Staged) {
  if ((Read-AcmsProfilePatch $Patch).Sha256 -cne $Original.Sha256) {
    throw 'Profile configuration changed during the operation. Review the current configuration before retrying.'
  }
  if ([IO.File]::Exists($Staged)) {
    try { [IO.File]::Move($Staged, $Patch, $true) }
    catch { throw "Could not publish the ACMS profile configuration: $($_.Exception.Message)" }
  }
}

function Read-DumpedPath([string]$Block, [string]$Key) {
  # The DSH YAML emitter may fold long local paths across indented lines.
  $pattern = '(?m)^(?<indent> +)' + [regex]::Escape($Key) + ': (?<value>[^\r\n]*)(?:\r?\n(?<fold>(?:\k<indent>  [^\r\n]*(?:\r?\n|$))+))?'
  $match = [regex]::Match($Block, $pattern)
  $value = $match.Groups['value'].Value
  if ($value -eq '>-') {
    return ($match.Groups['fold'].Value.TrimEnd() -split '\r?\n' | ForEach-Object { $_.TrimStart() }) -join ' '
  }
  if ($value.StartsWith("'") -and $value.EndsWith("'")) { return $value.Substring(1, $value.Length - 2).Replace("''", "'") }
  if ($value.StartsWith('"') -and $value.EndsWith('"')) { return $value | ConvertFrom-Json }
  return $value
}

function Get-AcmsActiveDataDirectories([string]$DshCommand, [string]$TargetProfile) {
  $dump = (& $DshCommand --profile $TargetProfile --dump-config) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Could not confirm the current ACMS profile configuration.' }
  foreach ($entry in [regex]::Matches($dump, '(?m)^- id: acms(?:-versioned-host)?\r?\n(?:[ \t]+[^\r\n]*\r?\n?)*')) {
    if ($entry.Value -match '(?m)^  disabled: true\r?$') { continue }
    $dataDir = Read-DumpedPath $entry.Value 'dataDir'
    if (-not $dataDir) { $dataDir = if ($env:ACMS_DATA_DIR) { $env:ACMS_DATA_DIR } else { Join-Path $env:DSH_HOME 'acms' } }
    if (-not [IO.Path]::IsPathFullyQualified($dataDir)) { throw 'Could not confirm an absolute data directory for the active ACMS host.' }
    [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($dataDir))
  }
}

function Read-AcmsInstallAdmission($Gate) {
  if ($Gate.StandardOutput.ReadLine() -ne 'ready') { throw "ACMS install admission failed: $($Gate.StandardError.ReadToEnd().Trim())" }
}

function Close-AcmsInstallAdmission($Gate) {
  if (-not $Gate) { return }
  try {
    $Gate.StandardInput.Close()
    if (-not $Gate.WaitForExit(10000)) { $Gate.Kill() }
  } finally { $Gate.Dispose() }
}

function Open-AcmsInstallAdmission([string[]]$DataDirectories) {
  $launch = [Diagnostics.ProcessStartInfo]::new('node')
  $launch.ArgumentList.Add((Join-Path $PSScriptRoot 'deployment-guard.mjs'))
  foreach ($directory in $DataDirectories) { $launch.ArgumentList.Add($directory) }
  $launch.UseShellExecute = $false
  $launch.CreateNoWindow = $true
  $launch.RedirectStandardInput = $true
  $launch.RedirectStandardOutput = $true
  $launch.RedirectStandardError = $true
  $launch.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  $gate = [Diagnostics.Process]::Start($launch)
  try { Read-AcmsInstallAdmission $gate }
  catch { Close-AcmsInstallAdmission $gate; throw }
  return $gate
}
