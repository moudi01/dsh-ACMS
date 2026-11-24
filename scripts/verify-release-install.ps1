[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PreviousCandidate,
  [Parameter(Mandatory)][string]$Candidate,
  [string]$DshCommand = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This check requires the Windows DSH CLI.' }
$DshCommand = (Resolve-Path -LiteralPath $DshCommand).Path
$PreviousCandidate = (Resolve-Path -LiteralPath $PreviousCandidate).Path
$Candidate = (Resolve-Path -LiteralPath $Candidate).Path

function Assert-Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Read-Json([string]$File) { Get-Content -LiteralPath $File -Raw | ConvertFrom-Json }
function Write-Text([string]$File, [string]$Text) { [IO.File]::WriteAllText($File, $Text, [Text.UTF8Encoding]::new($false)) }
function Hash-File([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash }
function Yaml-Path([string]$File) { "'" + $File.Replace('\', '/').Replace("'", "''") + "'" }
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
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

function Expand-Candidate([string]$Directory, [string]$Output) {
  $manifest = Read-Json (Join-Path $Directory 'release-manifest.json')
  Assert-Check ($manifest.package.name -eq 'dsh-acms' -and $manifest.commit -match '^[0-9a-f]{40}$') 'Invalid ACMS candidate manifest.'
  $archives = @($manifest.files | Where-Object { $_.name.EndsWith('.tgz') })
  $locks = @($manifest.files | Where-Object { $_.name -eq 'package-lock.json' })
  Assert-Check ($archives.Count -eq 1 -and $locks.Count -eq 1 -and $manifest.files.Count -eq 2) 'Expected the package and its lockfile.'
  foreach ($record in $manifest.files) {
    Assert-Check ([IO.Path]::GetFileName($record.name) -ceq $record.name) 'Invalid candidate filename.'
    Assert-Check ((Hash-File (Join-Path $Directory $record.name)) -ieq $record.sha256) "SHA-256 mismatch for $($record.name)."
  }
  [IO.Directory]::CreateDirectory($Output) | Out-Null
  Invoke-Checked tar @('-xzf', (Join-Path $Directory $archives[0].name), '-C', $Output)
  $pkg = Join-Path $Output 'package'
  [IO.File]::Copy((Join-Path $Directory 'package-lock.json'), (Join-Path $pkg 'package-lock.json'))
  Invoke-Checked npm @('ci','--prefix',$pkg,'--offline','--include=dev','--include=optional','--no-audit','--no-fund') | Out-Host
  return @{ Root = $pkg; Commit = $manifest.commit; ArchiveSha256 = $archives[0].sha256; CodexCli = $manifest.build.codexCli }
}

$tempRoot = [IO.Path]::TrimEndingDirectorySeparator((Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName)
$validationRoot = Join-Path $tempRoot ('acms-release-install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($validationRoot) | Out-Null
$npmConfig = Join-Path $validationRoot 'npm-user-config'
Write-Text $npmConfig ''
$environment = @{
  DSH_HOME = Join-Path $validationRoot 'dsh'
  COREPACK_ENABLE_NETWORK = '0'
  npm_config_offline = 'true'
  npm_config_fetch_retries = '0'
  npm_config_audit = 'false'
  npm_config_fund = 'false'
  npm_config_userconfig = $npmConfig
}
$savedEnvironment = @{}
foreach ($key in $environment.Keys) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $environment[$key]) }

try {
  $old = Expand-Candidate $PreviousCandidate (Join-Path $validationRoot 'previous')
  $new = Expand-Candidate $Candidate (Join-Path $validationRoot 'candidate')
  Assert-Check ($old.Commit -ne $new.Commit) 'Choose candidates built from distinct commits.'
  $dshVersion = ((Invoke-Checked $DshCommand @('--version')) | Out-String).Trim()
  $originalPatch = "# Unrelated profile setting`n- id: hmr`n  disabled: true`n"
  function Initialize-TestProfile([string]$Name) {
    Invoke-Checked $DshCommand @('--profile',$Name,'--from-default-profile','web','--dump-config') | Out-Null
    $directory = Join-Path $env:DSH_HOME "profiles\$Name"
    $workspace = Join-Path $directory 'pnpm-workspace.yaml'
    Add-Content -LiteralPath $workspace -Encoding UTF8 -Value @('', ('storeDir: ' + (Yaml-Path (Join-Path $validationRoot 'pnpm-store'))), 'offline: true', 'updateNotifier: false')
    Write-Text (Join-Path $directory 'cordis.patch.yml') $originalPatch
    return $directory
  }
  $profile = 'acms-release-check'
  $profileRoot = Initialize-TestProfile $profile
  $patch = Join-Path $profileRoot 'cordis.patch.yml'
  $profileManifest = Join-Path $profileRoot 'package.json'
  $preservedHash = Hash-File $patch
  $dataDir = Join-Path $validationRoot "company data #1"

  function Install-Candidate([string]$Package, [string]$Data) {
    & (Join-Path $Package 'scripts\install.ps1') -DshCommand $DshCommand -DshHomePath $env:DSH_HOME -TargetProfile $profile -DataDirectory $Data
  }
  function Uninstall-Candidate([string]$Package) {
    & (Join-Path $Package 'scripts\uninstall.ps1') -DshCommand $DshCommand -DshHomePath $env:DSH_HOME -TargetProfile $profile
  }
  function Assert-Profile([string]$Package, [string]$Data, [string]$HostEntry = 'dsh-acms') {
    $spec = (Read-Json $profileManifest).dependencies.'dsh-acms'
    $module = Join-Path $profileRoot 'node_modules\dsh-acms'
    $raw = [IO.File]::ReadAllText($patch)
    $dump = (Invoke-Checked $DshCommand @('--profile',$profile,'--dump-config')) -join "`n"
    $entries = [regex]::Matches($dump, '(?m)^- id: acms\r?$')
    $versioned = [regex]::Matches($dump, '(?m)^- id: acms-versioned-host\r?$')
    Assert-Check ($raw.StartsWith($originalPatch, [StringComparison]::Ordinal)) 'The unrelated configuration changed.'
    if (-not $Package) {
      Assert-Check (-not $spec -and $entries.Count -eq 0 -and $versioned.Count -eq 0) 'ACMS remains registered after removal.'
      Assert-Check ((Hash-File $patch) -eq $preservedHash) 'The unmanaged profile bytes were not restored.'
      return
    }
    Assert-Check ($spec -and $spec.StartsWith('link:')) 'Expected a linked ACMS candidate.'
    Assert-Check ([IO.Path]::GetFullPath($spec.Substring(5), $profileRoot) -eq $Package) 'The profile points to a different candidate.'
    Assert-Check (([IO.Directory]::ResolveLinkTarget($module, $true)).FullName -eq $Package) 'The installed module link points to a different candidate.'
    Assert-Check ($entries.Count -eq 1 -and [regex]::Matches($raw, '(?m)^# BEGIN ACMS MANAGED CONFIG\r?$').Count -eq 1) 'Expected a single composed ACMS entry and managed patch.'
    $acms = [regex]::Match($dump, '(?m)^- id: acms\r?\n(?:[ \t]+[^\r\n]*\r?\n?)*').Value
    $inactive = $acms -match '(?m)^  disabled: true$'
    if ($HostEntry -eq 'dsh-acms') {
      Assert-Check (-not $inactive -and $versioned.Count -eq 0) 'The stock host is not the only active host.'
      $expectedName = $HostEntry
    } else {
      Assert-Check ($inactive -and $versioned.Count -eq 1) 'The versioned host is not the only active host.'
      $acms = [regex]::Match($dump, '(?m)^- id: acms-versioned-host\r?\n(?:[ \t]+[^\r\n]*\r?\n?)*').Value
      Assert-Check ($acms -notmatch '(?m)^  disabled: true$') 'The versioned host is disabled.'
      $expectedName = [Uri]::new($HostEntry).AbsoluteUri
    }
    Assert-Check ((Read-DumpedPath $acms 'name') -eq $expectedName) 'DSH composed an unexpected host entry.'
    Assert-Check ((Read-DumpedPath $acms 'dataDir') -eq $Data.Replace('\', '/')) 'DSH composed an unexpected data directory.'
  }

  Install-Candidate $old.Root $dataDir | Out-Host
  Assert-Profile $old.Root $dataDir
  $installedPatch = Hash-File $patch
  Install-Candidate $old.Root $dataDir | Out-Host
  Assert-Profile $old.Root $dataDir
  Assert-Check ((Hash-File $patch) -eq $installedPatch) 'Reinstall changed the profile bytes.'

  $invalidData = Join-Path $validationRoot 'regular file'
  Write-Text $invalidData 'fixture'
  try { Install-Candidate $new.Root $invalidData | Out-Host; throw 'Unexpected install success.' }
  catch { Assert-Check ($_.Exception.Message -match 'Could not prepare ACMS install backups') "Expected backup directory preflight failure. $($_.Exception.Message)" }
  Assert-Profile $old.Root $dataDir
  Assert-Check ((Hash-File $patch) -eq $installedPatch) 'Preflight failure changed the profile.'

  $lockedData = Join-Path $validationRoot "locked data #2"
  $held = [IO.File]::Open($patch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    try { Install-Candidate $new.Root $lockedData | Out-Host; throw 'Unexpected install success.' }
    catch { Assert-Check ($_.Exception.Message -match 'Could not publish the ACMS profile configuration' -and $_.Exception.Message -notmatch 'recovery failed') "Expected protected profile publication failure. $($_.Exception.Message)" }
  } finally { $held.Dispose() }
  Assert-Profile $old.Root $dataDir
  Assert-Check ((Hash-File $patch) -eq $installedPatch) 'Failed publication changed the profile.'
  $backupDir = Join-Path $lockedData 'install-backups'
  $profileBackup = Get-ChildItem -LiteralPath $backupDir -Filter 'profile-*.yml'
  $manifestBackup = Get-ChildItem -LiteralPath $backupDir -Filter 'package-*.json'
  Assert-Check ($profileBackup.Count -eq 1 -and $manifestBackup.Count -eq 1 -and (Hash-File $profileBackup.FullName) -eq $installedPatch) 'Missing install recovery backups.'
  Assert-Check ((Read-Json $manifestBackup.FullName).dependencies.'dsh-acms' -eq (Read-Json $profileManifest).dependencies.'dsh-acms') 'The previous package registration was not backed up.'

  $dbFile = Join-Path $dataDir 'company.db'
  $artifact = Join-Path $dataDir 'retained deliverable.txt'
  Write-Text $artifact 'Offline data retention probe'
  $artifactHash = Hash-File $artifact
  $databaseProbe = @'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [storeFile, database, action] = process.argv.slice(2);
if (action === 'verify') {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM entities WHERE collection='goals' AND id='goal-offline-probe'").get();
    assert.equal(JSON.parse(row.body).title, 'Retained before candidate upgrade');
  } finally { db.close(); }
} else {
  const { Store } = await import(pathToFileURL(storeFile).href);
  const store = new Store(database);
  try {
    if (action === 'seed') store.put('goals', { id: 'goal-offline-probe', title: 'Retained before candidate upgrade', status: 'active' });
    store.put('attempts', { id: 'attempt-offline-probe', status: action === 'seed' ? 'running' : 'completed' });
  } finally { store.close(); }
}
'@
  function Invoke-DatabaseProbe([string]$Action) {
    $databaseProbe | node --input-type=module - (Join-Path $old.Root 'src\core\store.js') $dbFile $Action
    if ($LASTEXITCODE -ne 0) { throw "Database probe failed: $Action" }
  }
  Invoke-DatabaseProbe seed
  $deployScript = Join-Path $new.Root 'scripts\deploy-live.mjs'
  $previousErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $PSNativeCommandUseErrorActionPreference = $false
    $rejected = (& node $deployScript $profile 2>&1) -join "`n"
    Assert-Check ($LASTEXITCODE -ne 0 -and $rejected -match 'active executions') 'Expected deployment to reject an active execution row.'
  } finally { $PSNativeCommandUseErrorActionPreference = $previousErrorPreference }
  Assert-Profile $old.Root $dataDir
  Invoke-DatabaseProbe settle
  $dataHash = Hash-File $dbFile

  Install-Candidate $new.Root $dataDir | Out-Host
  Assert-Profile $new.Root $dataDir
  $deployResult = (Invoke-Checked node @($deployScript,$profile)) -join "`n"
  $previousPatch = [regex]::Match($deployResult, '(?m)^Previous configuration: (.+)$').Groups[1].Value.Trim()
  $revision = [regex]::Match($deployResult, 'ACMS host ([a-f0-9]+) published').Groups[1].Value
  Assert-Check ($previousPatch -and $revision -and (Hash-File $previousPatch) -eq $installedPatch) 'Missing live deployment backup or host revision.'
  $bundle = Join-Path $new.Root "dist\host-$revision.mjs"
  Assert-Check (Test-Path -LiteralPath $bundle -PathType Leaf) 'The versioned host is missing.'
  Assert-Profile $new.Root $dataDir $bundle
  [IO.File]::WriteAllBytes($patch, [IO.File]::ReadAllBytes($previousPatch))
  Assert-Profile $new.Root $dataDir

  Uninstall-Candidate $new.Root | Out-Host
  Assert-Profile '' ''
  Invoke-DatabaseProbe verify
  Assert-Check ((Hash-File $dbFile) -eq $dataHash -and (Hash-File $artifact) -eq $artifactHash) 'The database or deliverable changed.'

  $profile = 'acms-release-fresh'
  $profileRoot = Initialize-TestProfile $profile
  $patch = Join-Path $profileRoot 'cordis.patch.yml'
  $profileManifest = Join-Path $profileRoot 'package.json'
  Assert-Profile '' ''
  $freshData = Join-Path $validationRoot 'fresh data #3'
  Install-Candidate $new.Root $freshData | Out-Host
  Assert-Profile $new.Root $freshData
  $freshPatch = Hash-File $patch
  Install-Candidate $new.Root $freshData | Out-Host
  Assert-Profile $new.Root $freshData
  Assert-Check ((Hash-File $patch) -eq $freshPatch) 'Repeating the candidate install changed the profile.'
  Uninstall-Candidate $new.Root | Out-Host
  Assert-Profile '' ''

  [ordered]@{
    passed = $true; dsh = $dshVersion; node = ((Invoke-Checked node @('--version')) -join '').Trim()
    previousCommit = $old.Commit; previousArchiveSha256 = $old.ArchiveSha256
    candidateCommit = $new.Commit; candidateArchiveSha256 = $new.ArchiveSha256; candidateCodexCli = $new.CodexCli
    checks = @('fresh install', 'repeat install', 'invalid data path', 'locked profile publication rollback', 'candidate upgrade', 'active-record deployment gate', 'versioned host entry and rollback', 'uninstall', 'unrelated profile and data retention')
  } | ConvertTo-Json -Depth 3
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key]) }
  $directory = Get-Item -LiteralPath $validationRoot
  $actual = $directory.FullName
  if ($actual -cne $validationRoot -or [IO.Path]::GetDirectoryName($actual) -cne $tempRoot -or
      ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The temporary validation directory moved.' }
  Remove-Item -LiteralPath $actual -Recurse -Force
}
