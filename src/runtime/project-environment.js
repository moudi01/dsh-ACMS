import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, release, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assert, digest } from '../core/util.js';
import { resolveHostExecutable } from './host-command.js';
import { classifyEnvironment, environmentFailure } from './preflight.js';

const excluded = new Set(['.git', '.acms', '.codex', '.aws', '.ssh', '.npmrc', '.netrc', 'node_modules', 'auth.json', 'credentials.json']);
const included = (name, dependencies = false) => (dependencies && name.toLowerCase() === 'node_modules') ||
  (!excluded.has(name.toLowerCase()) && !name.toLowerCase().startsWith('.env'));

async function fileHash(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function copyProject(source, destination, { collaboration = false, dependencies = false } = {}) {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, filter: async item => item === source ||
    ((included(path.basename(item), dependencies) || (collaboration && path.basename(item) === '.acms')) && !(await lstat(item)).isSymbolicLink()) });
}

async function inputFiles(root, signal, dependencies = false) {
  const files = [];
  async function walk(relative, inDependencies) {
    const directory = path.join(root, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (!included(entry.name, dependencies)) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name, inDependencies || entry.name.toLowerCase() === 'node_modules');
      else if (entry.isFile() && (!dependencies || inDependencies)) files.push([name, await fileHash(path.join(root, name), signal)]);
      else if (entry.isSymbolicLink() && !dependencies) throw Object.assign(new Error('Verification input contains a symbolic link'), { code: 'CHECK_INPUT_LINK' });
    }
  }
  await walk('', false);
  return files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export async function inputFingerprint(root, signal) {
  return digest(await inputFiles(root, signal));
}

const toolHashes = new Map();
async function toolHash(file) {
  const info = await stat(file);
  const version = digest([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  if (toolHashes.get(file)?.version !== version) {
    const hash = fileHash(file);
    if (toolHashes.size >= 64) toolHashes.clear();
    toolHashes.set(file, { version, hash });
    hash.catch(() => { if (toolHashes.get(file)?.hash === hash) toolHashes.delete(file); });
  }
  return toolHashes.get(file).hash;
}

function baseEnvironment() {
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'path', 'pathext', 'number_of_processors', 'processor_architecture']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
}

export function hostEnvironmentIdentity() {
  return digest([hostname(), release(), userInfo().username, process.platform, process.arch, process.versions, baseEnvironment()]);
}

async function privateEnvironment(directory) {
  const home = path.join(directory, 'home');
  const tmp = path.join(directory, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  return { ...baseEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: tmp, TMP: tmp };
}

export function logSummary(result) {
  const output = [result.stdout ?? '', result.stderr ?? ''];
  const combined = output.join('\n');
  return { hash: digest(output), capturedBytes: output.map(value => Buffer.byteLength(value)),
    diagnostic: combined.match(/\b(?:ENOTCACHED|EACCES|EPERM|ENOENT|EUSAGE)\b/)?.[0] ??
      classifyEnvironment({ message: combined })?.code ?? null };
}

async function lockInputs(cwd, spec, signal) {
  const root = await realpath(cwd);
  return Promise.all(spec.inputs.map(async file => {
    const target = path.join(root, file);
    const actual = await realpath(target);
    const relative = path.relative(root, actual);
    assert(relative === path.normalize(file) && (await lstat(target)).isFile(),
      'PREPARATION_INPUT', 'Preparation input must be a regular file inside the workspace');
    return [file, await fileHash(target, signal)];
  }));
}

async function offlineNpm(cwd, spec, env, directory) {
  const hasConfig = await lstat(path.join(cwd, '.npmrc')).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  assert(!hasConfig, 'PREPARATION_INPUT', 'Offline npm preparation requires a workspace without a project .npmrc');
  const lock = JSON.parse(await readFile(path.join(cwd, 'package-lock.json'), 'utf8'));
  assert(lock.lockfileVersion >= 2 && lock.packages && !Array.isArray(lock.packages), 'PREPARATION_INPUT', 'Offline npm requires a v2 or v3 lockfile');
  const blobs = new Set();
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name.split('/').includes('node_modules') || entry.inBundle) continue;
    if (entry.link) {
      const relative = path.relative(cwd, await realpath(path.resolve(cwd, entry.resolved)));
      assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
        'PREPARATION_INPUT', 'Offline npm workspace links must stay inside the copy');
    } else {
      const url = new URL(entry.resolved);
      const integrity = String(entry.integrity ?? '').matchAll(/(?:^|\s)(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})(?=\s|$)/g);
      const entries = [...integrity];
      assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && entries.length,
        'PREPARATION_INPUT', 'Offline npm dependencies require integrity-pinned HTTPS entries');
      for (const [, algorithm, encoded] of entries) {
        const hash = Buffer.from(encoded, 'base64').toString('hex');
        if (hash.length >= 40 && hash.length <= 128) blobs.add(path.join(algorithm, hash.slice(0, 2), hash.slice(2, 4), hash.slice(4)));
      }
    }
  }
  const cache = path.join(directory, 'npm-cache');
  if (spec.cacheSeed) {
    const source = path.join(spec.cacheSeed, '_cacache', 'content-v2');
    const root = await realpath(source).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    for (const blob of root ? blobs : []) {
      const file = path.join(root, blob);
      const actual = await realpath(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (actual !== file || !(await lstat(file)).isFile()) continue;
      const destination = path.join(cache, '_cacache', 'content-v2', blob);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file, destination);
    }
  }
  const userconfig = path.join(directory, 'user.npmrc');
  const globalconfig = path.join(directory, 'global.npmrc');
  await writeFile(userconfig, '');
  await writeFile(globalconfig, '');
  Object.assign(env, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: cache, npm_config_update_notifier: 'false' });
  return [...spec.args, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'];
}

// A workspace owns its installed tree and its cache. Only the owner's optional
// npm content cache is read as a seed, with no links into the source cache.
export async function prepareDependencies(dataDir, cwd, spec, invoke, signal) {
  if (!spec) return null;
  let evidence = { command: spec.command, cwd, network: spec.network };
  try {
    const root = await realpath(cwd);
    const relative = path.relative(await realpath(dataDir), root);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
      'PREPARATION_INPUT', 'Preparation requires an isolated workspace under the host data directory');
    const inputs = await lockInputs(cwd, spec, signal);
    const runtime = await toolHash(spec.command);
    const commandInputs = await preparationCommandInputs(spec, cwd, signal);
    const environment = hostEnvironmentIdentity();
    const key = digest([spec, inputs, runtime, commandInputs.files, environment]);
    const assertInputsStable = async () => {
      assert(digest(await lockInputs(cwd, spec, signal)) === digest(inputs), 'PREPARATION_INPUT', 'Preparation inputs changed');
      const stable = spec.network === 'offline-npm'
        ? await toolHash(spec.args[0]) === commandInputs.files : await boundFilesStable(commandInputs.files, cwd, signal);
      assert(stable, 'PREPARATION_INPUT', 'Preparation command inputs changed');
    };
    const directory = path.join(dataDir, 'env', digest(cwd).slice(0, 24));
    const receipt = path.join(directory, 'prepared.json');
    const previous = await readFile(receipt, 'utf8').then(JSON.parse).catch(() => null);
    const installed = await lstat(path.join(cwd, 'node_modules')).then(stat => stat.isDirectory(), () => false);
    if (commandInputs.reusable && previous?.key === key && installed &&
        previous.dependenciesHash === digest(await inputFiles(cwd, signal, true))) {
      await assertInputsStable();
      return { ...previous, reused: true };
    }
    signal?.throwIfAborted();
    const execution = path.join(directory, key.slice(0, 24));
    const env = await privateEnvironment(execution);
    const args = spec.network === 'offline-npm' ? await offlineNpm(cwd, spec, env, execution) : spec.args;
    evidence = { ...evidence, args: redactArguments(args), key, inputs, environment, reusable: commandInputs.reusable };
    // Do not let a partially prepared tree reuse an earlier success receipt.
    await rm(receipt, { force: true });
    await rm(path.join(root, 'node_modules'), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    const result = await invoke(spec.command, args, cwd, { timeout: spec.timeoutMs, signal, env, checkId: 'dependency-preparation' });
    evidence = { ...evidence, code: result.code, timedOut: result.timedOut, cleanupConfirmed: result.cleanupConfirmed, log: logSummary(result) };
    assert(result.code === 0 && !result.timedOut && result.cleanupConfirmed === true, 'PREPARATION_FAILED', 'Dependency preparation failed');
    await assertInputsStable();
    evidence.dependenciesHash = digest(await inputFiles(cwd, signal, true));
    if (commandInputs.reusable) await writeFile(receipt, JSON.stringify(evidence), { flush: true });
    return evidence;
  } catch (error) {
    if (error.cleanupUncertain || signal?.aborted || ['STALE_RESULT', 'LEASE_LOST', 'GOAL_PAUSED', 'GOAL_CLOSED', 'PREPARATION_CHANGED'].includes(error.code)) throw error;
    const failure = environmentFailure('preparation', '项目依赖准备');
    throw Object.assign(new Error(failure.reason), { environmentFailure: failure, evidence: { ...evidence, errorCode: error.code ?? error.name } });
  }
}

const sensitive = /(?:token|password|secret|authorization|api[_-]?key)/i;
function redactArguments(args) {
  return args.map((value, index) => (index > 0 && /^--/.test(args[index - 1]) && sensitive.test(args[index - 1])) ||
    sensitive.test(value) || /:\/\/[^/\s]+@/.test(value) ? '[redacted]' : value);
}
function redactLog(value) {
  return (value ?? '').slice(-12000)
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(:\/\/)[^/\s]+@/g, '$1[redacted]@');
}

async function fingerprintFiles(paths, cwd, signal) {
  const files = [];
  for (const file of paths) {
    signal?.throwIfAborted();
    let entry = null;
    try {
      const filename = /^file:\/\//i.test(file) ? fileURLToPath(file) : path.resolve(cwd, file);
      const actual = await realpath(filename);
      if ((await stat(actual)).isFile()) {
        const relative = path.relative(cwd, actual);
        const external = path.isAbsolute(file) || /^file:\/\//i.test(file) ||
          relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
        entry = [external ? actual : relative, await fileHash(actual, signal)];
      }
    } catch {
      signal?.throwIfAborted();
    }
    files.push([file, entry]);
  }
  return files;
}

async function boundFilesStable(files, cwd, signal) {
  const bound = files.filter(([, entry]) => entry !== null);
  const after = await fingerprintFiles(bound.map(([file]) => file), cwd, signal);
  return digest(after) === digest(bound);
}

function fileArguments(args, includeRelativeScripts = false) {
  const values = args.map(arg => arg.startsWith('-') ? arg.match(/^--?[^=]+=(.*)$/s)?.[1] : arg);
  return values.filter(value => {
    if (!value) return false;
    if (path.isAbsolute(value) || /^file:\/\//i.test(value) || /^\.\.[/\\]/.test(value)) return true;
    return includeRelativeScripts && (/^\.[/\\]/.test(value) || /^[^<>:"|?*\r\n]+\.(?:[cm]?js|tsx?|py|ps1|cmd|bat|sh)$/i.test(value));
  });
}

async function preparationCommandInputs(spec, cwd, signal) {
  if (spec.network === 'offline-npm') return { files: await toolHash(spec.args[0]), reusable: true };
  const paths = new Set([...(spec.externalInputs ?? []), ...fileArguments(spec.args, true)]);
  const files = await fingerprintFiles(paths, cwd, signal);
  return { files, reusable: Array.isArray(spec.externalInputs) && files.every(([, entry]) => entry !== null) };
}

async function checkInputs(check, cwd, signal) {
  // Absolute argv paths are inputs even when the owner omits them from the
  // declaration. The declaration covers inputs hidden from argv, e.g. imports.
  const paths = new Set([...(check.inputs ?? []), ...fileArguments(check.args)]);
  const files = await fingerprintFiles(paths, cwd, signal);
  return { files, reusable: Array.isArray(check.inputs) && files.every(([, entry]) => entry !== null) };
}

export async function checkIdentity(check, cwd, preparation, signal) {
  const executable = await resolveHostExecutable(check.command, cwd);
  const binary = await toolHash(executable);
  const environment = hostEnvironmentIdentity();
  const preparationIdentity = preparation ? digest([preparation, await lockInputs(cwd, preparation, signal),
    await toolHash(preparation.command), (await preparationCommandInputs(preparation, cwd, signal)).files])
    : digest(await inputFiles(cwd, signal, true));
  const { files, reusable } = await checkInputs(check, cwd, signal);
  return { environment, version: digest([check, binary, preparationIdentity, environment, files]), executable, inputs: files,
    reusable: reusable && preparation?.network !== 'allow' };
}

export async function verifyInCopy({ dataDir, source, inputHash, check, preparation, identity, signal, invoke }) {
  const directory = await mkdtemp(path.join(dataDir, 'check-'));
  const cwd = path.join(directory, 'project');
  let retain = false;
  try {
    // Preserve manually supplied dependencies in a private, content-bound copy.
    await copyProject(source, cwd, { dependencies: !preparation });
    const inputs = await inputFiles(cwd, signal);
    assert(digest(inputs) === inputHash, 'CHECK_INPUT_CHANGED', 'Verification copy does not match its input');
    const prepared = await prepareDependencies(directory, cwd, preparation, invoke, signal);
    assert(await inputFingerprint(cwd, signal) === inputHash, 'CHECK_INPUT_CHANGED', 'Dependency preparation changed verification input');
    const actual = await checkIdentity(check, cwd, preparation, signal);
    assert(!identity || actual.version === identity.version, 'CHECK_INPUT_CHANGED', 'Verification command or environment changed');
    const env = await privateEnvironment(directory);
    const result = await invoke(actual.executable, check.args, cwd, { timeout: check.timeoutMs ?? 120000, signal, env, checkId: check.id });
    // Unresolved paths already prevent reuse. They may be output or signal
    // paths, so their creation does not invalidate the live command result.
    const inputsStable = await boundFilesStable(actual.inputs, cwd, signal);
    const outputs = await inputFiles(cwd, signal);
    const outputMap = new Map(outputs);
    const inputUnchanged = inputs.every(([file, hash]) => outputMap.get(file) === hash);
    return { ...result, stdout: redactLog(result.stdout), stderr: redactLog(result.stderr), id: check.id, command: check.command, args: redactArguments(check.args), cwd,
      inputHash, outputHash: digest(outputs), inputUnchanged, environment: actual.environment, checkVersion: actual.version, preparation: prepared,
      reusable: actual.reusable && inputsStable,
      log: logSummary(result), passed: result.cleanupConfirmed === true && result.code === 0 && !result.timedOut && inputUnchanged && inputsStable,
      ...(!inputsStable ? { reason: 'Declared or external check inputs changed during execution' }
        : !inputUnchanged ? { reason: 'Check changed input files in the isolated copy' } : {}) };
  } catch (error) {
    retain = error.cleanupUncertain === true;
    throw error;
  } finally {
    if (!retain) await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}
