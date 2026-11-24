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
. (Join-Path $PSScriptRoot 'profile-package.ps1')

function Assert-Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Read-Json([string]$File) { Get-Content -LiteralPath $File -Raw | ConvertFrom-Json }
function Write-Text([string]$File, [string]$Text) { [IO.File]::WriteAllText($File, $Text, [Text.UTF8Encoding]::new($false)) }
function Hash-File([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash }
function Yaml-Path([string]$File) { "'" + $File.Replace('\', '/').Replace("'", "''") + "'" }
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
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
  function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    try { & $Action | Out-Host; throw 'Unexpected command success.' }
    catch { Assert-Check ($_.Exception.Message -match $Pattern -and $_.Exception.Message -notmatch 'recovery failed') "Unexpected failure. $($_.Exception.Message)" }
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
  Expect-Failure { Install-Candidate $new.Root $invalidData } 'Could not prepare ACMS install backups'
  Assert-Profile $old.Root $dataDir
  Assert-Check ((Hash-File $patch) -eq $installedPatch) 'Preflight failure changed the profile.'

  $lockedData = Join-Path $validationRoot "locked data #2"
  $held = [IO.File]::Open($patch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { Expect-Failure { Install-Candidate $new.Root $lockedData } 'Could not publish the ACMS profile configuration' }
  finally { $held.Dispose() }
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
    store.put('attempts', { id: 'attempt-offline-probe', status: action === 'settle' ? 'completed' : 'running' });
  } finally { store.close(); }
}
'@
  function Invoke-DatabaseProbe([string]$Action, [string]$Database = $dbFile) {
    $databaseProbe | node --input-type=module - (Join-Path $old.Root 'src\core\store.js') $Database $Action
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
  Expect-Failure { Install-Candidate $new.Root $dataDir } 'active executions'
  Expect-Failure { Install-Candidate $new.Root $lockedData } 'active executions'
  Assert-Profile $old.Root $dataDir
  Invoke-DatabaseProbe settle

  # The wrapper runs the real DSH registration, then injects contention before returning to the installer.
  $wrapper = Join-Path $validationRoot 'dsh-install-probe.ps1'
  $wrapperSettings = Join-Path $validationRoot 'install-probe.json'
  $writerProbe = Join-Path $validationRoot 'check-writer-lock.mjs'
  Write-Text $writerProbe @'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
try {
  db.exec('PRAGMA busy_timeout=0');
  assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/);
} finally { db.close(); }
'@
  Write-Text $wrapper @'
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$settings = Get-Content (Join-Path $PSScriptRoot 'install-probe.json') -Raw | ConvertFrom-Json
& $settings.dsh @args
$code = $LASTEXITCODE
if ($code -ne 0 -or $args[0] -ne 'plugin' -or $args[3] -ne 'add') { exit $code }
[IO.File]::WriteAllText($settings.marker, 'registered')
if ($settings.abrupt) { [Diagnostics.Process]::GetCurrentProcess().Kill() }
node $settings.writerProbe $settings.database
if ($LASTEXITCODE -ne 0) { throw 'Installation did not hold the current database write lock.' }
$common = @('-DshCommand',$settings.dsh,'-DshHomePath',$env:DSH_HOME,'-TargetProfile',$settings.profile)
$competingInstall = (& pwsh -NoProfile -File $settings.install @common -DataDirectory $settings.otherData 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0 -or $competingInstall -notmatch 'Could not lock the ACMS profile') { throw "Unexpected overlapping install: $competingInstall" }
$competingUninstall = (& pwsh -NoProfile -File $settings.uninstall @common 2>&1) -join "`n"
if ($LASTEXITCODE -eq 0 -or $competingUninstall -notmatch 'Could not lock the ACMS profile') { throw "Unexpected overlapping uninstall: $competingUninstall" }
& pwsh -NoProfile -File $settings.install -DshCommand $settings.dsh -DshHomePath $env:DSH_HOME -TargetProfile $settings.independent -DataDirectory $settings.independentData
if ($LASTEXITCODE -ne 0) { throw 'A separate profile could not install during the first transaction.' }
exit 0
'@
  $independentProfile = 'acms-release-concurrent'
  $independentRoot = Initialize-TestProfile $independentProfile
  $settings = @{
    dsh = $DshCommand; install = Join-Path $new.Root 'scripts\install.ps1'; uninstall = Join-Path $new.Root 'scripts\uninstall.ps1'
    profile = $profile; otherData = Join-Path $validationRoot 'competing data'; independent = $independentProfile
    independentData = Join-Path $validationRoot 'independent data'; writerProbe = $writerProbe; database = $dbFile
    marker = Join-Path $validationRoot 'registered'; abrupt = $false
  }
  Write-Text $wrapperSettings ($settings | ConvertTo-Json)
  $installProbe = @('-NoProfile','-File',$settings.install,'-DshCommand',$wrapper,'-DshHomePath',$env:DSH_HOME)
  Invoke-Checked pwsh ($installProbe + @('-TargetProfile',$profile,'-DataDirectory',$dataDir)) | Out-Host
  Assert-Check ((Get-AcmsRegistration $independentRoot).StartsWith('link:')) 'The independent profile did not register the candidate.'
  Assert-Check (-not (Test-Path -LiteralPath $settings.otherData)) 'A competing install changed the requested data path.'
  Assert-Profile $new.Root $dataDir
  Install-Candidate $new.Root $settings.otherData | Out-Host
  Assert-Profile $new.Root $settings.otherData

  function Invoke-InterruptedInstall([string]$Marker, [string]$Data = $dataDir) {
    $settings.abrupt = $true
    $settings.marker = Join-Path $validationRoot $Marker
    Write-Text $wrapperSettings ($settings | ConvertTo-Json)
    $previousErrorPreference = $PSNativeCommandUseErrorActionPreference
    try {
      $PSNativeCommandUseErrorActionPreference = $false
      & pwsh @installProbe -TargetProfile $profile -DataDirectory $Data | Out-Host
      Assert-Check ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $settings.marker)) 'Expected the isolated installer to exit after registration.'
    } finally { $PSNativeCommandUseErrorActionPreference = $previousErrorPreference }
  }
  Invoke-InterruptedInstall 'registered-before-process-exit'
  Assert-Profile $new.Root $settings.otherData
  Install-Candidate $new.Root $dataDir | Out-Host
  Assert-Profile $new.Root $dataDir

  # Keep the same data path while replacing an older versioned host.
  Install-Candidate $old.Root $dataDir | Out-Host
  $versionedProbe = @'
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [deployScript, previousRoot, profile] = process.argv.slice(2);
const { deployLive } = await import(pathToFileURL(deployScript));
const { buildHost } = await import(pathToFileURL(path.join(previousRoot, 'scripts/host-bundle.mjs')));
const { filename } = await deployLive({ root: previousRoot, profile, home: process.env.DSH_HOME, build: buildHost });
console.log(filename);
'@
  $oldBundle = ($versionedProbe | node --input-type=module - $deployScript $old.Root $profile)
  Assert-Check ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $oldBundle -PathType Leaf)) 'Could not prepare the previous candidate host.'
  Assert-Profile $old.Root $dataDir $oldBundle
  $oldDeployedHash = Hash-File $patch
  $oldRegistration = Get-AcmsRegistration $profileRoot
  Invoke-InterruptedInstall 'registered-with-old-versioned-host'
  Assert-Profile $new.Root $dataDir $oldBundle
  $intentFile = Join-Path $profileRoot '.acms-install-pending.json'
  $interruptedRecordHash = Hash-File $intentFile
  $pending = Read-Json $intentFile
  $patchBeforeExit = Join-Path (Split-Path $pending.registrationBackup) ((Split-Path $pending.registrationBackup -Leaf).Replace('package-', 'profile-').Replace('.json', '.yml'))
  Assert-Check ((Get-AcmsRegistration $profileRoot) -ne $oldRegistration -and (Read-Json $pending.registrationBackup).dependencies.'dsh-acms' -eq $oldRegistration) 'The interrupted registration or its old backup is incorrect.'
  Assert-Check ((Hash-File $patch) -eq $oldDeployedHash -and (Hash-File $patchBeforeExit) -eq $oldDeployedHash -and $pending.originalPatchSha256 -ceq $oldDeployedHash) 'The pending record or backup does not match the old versioned patch.'
  Invoke-DatabaseProbe active
  Expect-Failure { Install-Candidate $new.Root $dataDir } 'active executions'
  Assert-Profile $new.Root $dataDir $oldBundle
  Invoke-DatabaseProbe settle
  $held = [IO.File]::Open($patch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { Expect-Failure { Install-Candidate $new.Root $dataDir } 'Could not publish the ACMS profile configuration' }
  finally { $held.Dispose() }
  Assert-Profile $new.Root $dataDir $oldBundle
  Assert-Check ((Hash-File $intentFile) -eq $interruptedRecordHash) 'A failed retry did not preserve the original pending record.'
  Install-Candidate $new.Root $dataDir | Out-Host
  Assert-Profile $new.Root $dataDir
  Assert-Check (-not (Test-Path -LiteralPath $intentFile) -and (Hash-File $patchBeforeExit) -eq $oldDeployedHash -and (Read-Json $pending.registrationBackup).dependencies.'dsh-acms' -eq $oldRegistration) 'The retry left pending state or lost the original backups.'

  # The same record can survive a process exit just after the patch was published.
  Assert-Check ($pending.patchSha256 -ceq (Hash-File $patch)) 'The published patch differs from the recorded install intent.'
  Write-Text $intentFile ($pending | ConvertTo-Json)
  Invoke-DatabaseProbe active
  Install-Candidate $new.Root $dataDir | Out-Host
  Assert-Profile $new.Root $dataDir
  Assert-Check (-not (Test-Path -LiteralPath $intentFile)) 'A fully published install did not clear its pending record.'
  Invoke-DatabaseProbe settle

  Write-Text $intentFile ($pending | ConvertTo-Json)
  $staleIntentHash = Hash-File $intentFile
  $deployResult = (Invoke-Checked node @($deployScript,$profile)) -join "`n"
  $previousPatch = [regex]::Match($deployResult, '(?m)^Previous configuration: (.+)$').Groups[1].Value.Trim()
  $revision = [regex]::Match($deployResult, 'ACMS host ([a-f0-9]+) published').Groups[1].Value
  Assert-Check ($previousPatch -and $revision -and (Hash-File $previousPatch) -eq $installedPatch) 'Missing live deployment backup or host revision.'
  $bundle = Join-Path $new.Root "dist\host-$revision.mjs"
  Assert-Check (Test-Path -LiteralPath $bundle -PathType Leaf) 'The versioned host is missing.'
  Assert-Profile $new.Root $dataDir $bundle
  $deployedPatch = [IO.File]::ReadAllBytes($patch)
  $deployedHash = Hash-File $patch
  $deployedManifestHash = Hash-File $profileManifest
  Expect-Failure { Install-Candidate $new.Root $dataDir } 'configuration differs from both states'
  Assert-Profile $new.Root $dataDir $bundle
  Assert-Check ((Hash-File $patch) -eq $deployedHash -and (Hash-File $profileManifest) -eq $deployedManifestHash -and (Hash-File $intentFile) -eq $staleIntentHash) 'The subsequent deployment, registration or pending record changed.'
  [IO.File]::Move($intentFile, (Join-Path $validationRoot 'reviewed-install-intent.json'))
  Invoke-DatabaseProbe active
  Install-Candidate $new.Root $dataDir | Out-Host
  Assert-Profile $new.Root $dataDir $bundle
  Expect-Failure { Install-Candidate $new.Root $lockedData } 'active executions'
  Assert-Check ((Hash-File $patch) -eq $deployedHash) 'An install changed the active versioned configuration.'
  Invoke-DatabaseProbe settle
  Invoke-DatabaseProbe seed (Join-Path $lockedData 'company.db')
  Expect-Failure { Install-Candidate $new.Root $lockedData } 'active executions'
  Assert-Profile $new.Root $dataDir $bundle
  $dataHash = Hash-File $dbFile
  [IO.File]::WriteAllBytes($patch, [IO.File]::ReadAllBytes($previousPatch))
  Assert-Profile $new.Root $dataDir

  [IO.File]::WriteAllBytes($patch, $deployedPatch)
  $held = [IO.File]::Open($patch, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { Expect-Failure { Uninstall-Candidate $new.Root } 'Could not publish the ACMS profile configuration' }
  finally { $held.Dispose() }
  Assert-Profile $new.Root $dataDir $bundle
  Assert-Check ((Hash-File $patch) -eq $deployedHash) 'Uninstall failure changed the versioned configuration.'
  Uninstall-Candidate $new.Root | Out-Host
  Assert-Profile '' ''
  # An older uninstall could unregister the package before clearing its standalone entry.
  [IO.File]::WriteAllBytes($patch, $deployedPatch)
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

  $profile = 'acms-release-without-patch'
  $profileRoot = Initialize-TestProfile $profile
  $patch = Join-Path $profileRoot 'cordis.patch.yml'
  $profileManifest = Join-Path $profileRoot 'package.json'
  $intentFile = Join-Path $profileRoot '.acms-install-pending.json'
  [IO.File]::Delete($patch)
  Invoke-InterruptedInstall 'registered-before-first-patch' $freshData
  $pending = Read-Json $intentFile
  Assert-Check (-not (Test-Path -LiteralPath $patch) -and $pending.PSObject.Properties['originalPatchSha256'] -and $null -eq $pending.originalPatchSha256) 'The install did not record a missing original patch.'
  Write-Text $patch ''
  Expect-Failure { Install-Candidate $new.Root $freshData } 'configuration differs from both states'
  Assert-Check ((Get-Item -LiteralPath $patch).Length -eq 0 -and (Test-Path -LiteralPath $intentFile)) 'An empty file was mistaken for a missing patch.'
  [IO.File]::Delete($patch)
  Install-Candidate $new.Root $freshData | Out-Host
  $originalPatch = ''
  Assert-Profile $new.Root $freshData
  Assert-Check (-not (Test-Path -LiteralPath $intentFile)) 'The interrupted first install did not clear its pending record.'

  [ordered]@{
    passed = $true; dsh = $dshVersion; node = ((Invoke-Checked node @('--version')) -join '').Trim()
    previousCommit = $old.Commit; previousArchiveSha256 = $old.ArchiveSha256
    candidateCommit = $new.Commit; candidateArchiveSha256 = $new.ArchiveSha256; candidateCodexCli = $new.CodexCli
    checks = @('fresh install', 'idempotent versioned reinstall', 'invalid data path', 'locked install and uninstall recovery', 'candidate upgrade', 'active current and destination database gates', 'concurrent package operation exclusion', 'interrupted same-data and cross-data upgrades', 'completed publication cleanup', 'pending install preserves a later deployment', 'missing patch differs from an empty patch', 'versioned host entry and rollback', 'uninstall with or without package registration', 'unrelated profile and data retention')
  } | ConvertTo-Json -Depth 3
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key]) }
  $directory = Get-Item -LiteralPath $validationRoot
  $actual = $directory.FullName
  if ($actual -cne $validationRoot -or [IO.Path]::GetDirectoryName($actual) -cne $tempRoot -or
      ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The temporary validation directory moved.' }
  Remove-Item -LiteralPath $actual -Recurse -Force
}
