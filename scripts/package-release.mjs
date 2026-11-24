import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this script with npm run package:release');

const run = (command, args, cwd, options = {}) => execFileSync(command, args, { cwd, encoding: 'utf8', ...options });
const npm = (args, cwd, options) => run(process.execPath, [npmCli, ...args], cwd, options);
const install = cwd => npm(['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], cwd, { stdio: 'inherit' });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

function githubRun(commit) {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  const { GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  assert.equal(commit, GITHUB_SHA, 'The packaged commit must match the workflow checkout');
  assert(GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID && GITHUB_RUN_ATTEMPT, 'Missing GitHub Actions run metadata');
  return { repository: GITHUB_REPOSITORY, runId: GITHUB_RUN_ID, attempt: GITHUB_RUN_ATTEMPT,
    url: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}` };
}

async function verifyCodexCli(cwd, runtimeEntry, expectedVersion) {
  const manifestPath = createRequire(runtimeEntry).resolve('@openai/codex/package.json');
  const packageDir = path.dirname(manifestPath);
  const cli = await readJson(manifestPath);
  const lock = await readJson(path.join(cwd, 'package-lock.json'));
  const lockPath = path.relative(cwd, packageDir).split(path.sep).join('/');
  const lockedVersion = lock.packages?.[lockPath]?.version;
  assert.equal(lockedVersion, expectedVersion, 'Codex CLI lockfile version must match the runtime dependency');
  assert.equal(cli.version, lockedVersion, 'Installed Codex CLI version must match the lockfile');
  assert(typeof cli.bin?.codex === 'string' && cli.bin.codex, 'Codex CLI package is missing its launcher');
  const launcher = path.resolve(packageDir, cli.bin.codex);
  const reported = run(process.execPath, [launcher, '--version'], cwd, { timeout: 30000, windowsHide: true }).trim();
  assert.equal(reported, `codex-cli ${lockedVersion}`, 'Codex CLI reported an unexpected version');
  console.log(`Verified ${reported} from the extracted candidate`);
  return lockedVersion;
}

async function verifyPackage(cwd, expectedCodexVersion) {
  const requireFromPackage = createRequire(path.join(cwd, 'package.json'));
  const host = await import(pathToFileURL(requireFromPackage.resolve('dsh-acms')).href);
  assert.equal(host.name, 'acms');
  assert.equal(typeof host.apply, 'function');
  const runtimeEntry = requireFromPackage.resolve('@acms/codex-runtime');
  const codex = await import(pathToFileURL(runtimeEntry).href);
  assert.equal(typeof codex.startCodexRun, 'function');
  const client = await readFile(requireFromPackage.resolve('dsh-acms/client'), 'utf8');
  let registered = false;
  const window = { __ModuleLoader__: { load(plugin) {
    assert.equal(plugin.id, 'dsh-acms');
    assert.equal(typeof plugin.factory(requireFromPackage).apply, 'function');
    registered = true;
  } } };
  runInNewContext(client, { window });
  assert(registered, 'Client entry did not register with the DSH module loader');
  return verifyCodexCli(cwd, runtimeEntry, expectedCodexVersion);
}

async function describeFile(directory, name) {
  const bytes = await readFile(path.join(directory, name));
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function buildCandidate(staging, commit, workflow) {
  const source = path.join(staging, 'source');
  await mkdir(source);
  const sourceArchive = path.join(staging, 'source.tar');
  run('git', ['archive', '--format=tar', '--output', sourceArchive, commit], root);
  run('tar', ['-xf', sourceArchive, '-C', source], staging);

  console.log(`Building release candidate from ${commit}`);
  install(source);
  npm(['run', 'build'], source, { stdio: 'inherit' });
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', staging], source));
  assert(packed?.filename?.endsWith('.tgz') && path.basename(packed.filename) === packed.filename, 'npm pack returned an invalid archive name');

  const members = new Map(packed.files.map(file => [file.path, file.size]));
  for (const required of ['package.json', 'src/host/index.js', 'src/runtime/owned-job.cs', 'src/runtime/delivery-archive-worker.js', 'src/runtime/bare-transaction-hook.js',
    'lib/client.js', 'cordis.patch.yml', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/profile-package.ps1', 'scripts/deployment-guard.mjs',
    'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'packages/codex-runtime/package.json', 'packages/codex-runtime/lib/index.js', 'packages/codex-runtime/lib/store.js', 'packages/codex-runtime/LICENSE']) {
    assert(members.get(required) > 0, `Package is missing nonempty ${required}`);
  }

  console.log('Installing locked dependencies from the extracted candidate');
  run('tar', ['-xzf', path.join(staging, packed.filename), '-C', staging], staging);
  const extracted = path.join(staging, 'package');
  const lockfile = 'package-lock.json';
  await copyFile(path.join(source, lockfile), path.join(staging, lockfile));
  await copyFile(path.join(staging, lockfile), path.join(extracted, lockfile));
  install(extracted);

  const pkg = await readJson(path.join(extracted, 'package.json'));
  const runtime = await readJson(path.join(extracted, 'packages/codex-runtime/package.json'));
  const requirements = { node: pkg.engines?.node, dsh: pkg.engines?.dsh, codexCli: runtime.dependencies?.['@openai/codex'] };
  for (const [name, version] of Object.entries(requirements)) {
    assert(typeof version === 'string' && version.trim(), `Package must declare its ${name} version requirement`);
  }
  const codexCli = await verifyPackage(extracted, requirements.codexCli);
  const manifest = {
    schemaVersion: 1,
    package: { name: pkg.name, version: pkg.version, license: pkg.license },
    commit,
    workflow,
    build: { platform: process.platform, arch: process.arch, node: process.versions.node, npm: npm(['--version'], source).trim(), codexCli },
    requirements,
    checks: ['required package files', 'extracted npm ci', 'host entry', 'DSH client entry', 'Codex runtime entry', 'Codex CLI --version'],
    files: await Promise.all([packed.filename, lockfile].map(name => describeFile(staging, name))),
  };

  const releaseRoot = path.join(root, 'dist', 'release');
  await mkdir(releaseRoot, { recursive: true });
  const output = await mkdtemp(path.join(releaseRoot, `${pkg.name}-${pkg.version}-${commit.slice(0, 12)}-`));
  for (const file of manifest.files) await copyFile(path.join(staging, file.name), path.join(output, file.name));
  await writeFile(path.join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return output;
}

const commit = run('git', ['rev-parse', 'HEAD'], root).trim();
const workflow = githubRun(commit);
const tempRoot = await realpath(tmpdir());
const staging = await mkdtemp(path.join(tempRoot, 'acms-release-'));
let output;
try {
  output = await buildCandidate(staging, commit, workflow);
} finally {
  const target = await realpath(staging);
  assert(target === staging && path.dirname(target) === tempRoot, 'The release staging directory moved');
  await rm(target, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`Verified release candidate: ${output}`);
