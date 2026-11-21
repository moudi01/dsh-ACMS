import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lstat, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export function cleanupError(reason, cause) {
  return Object.assign(new Error(`Owned process cleanup unconfirmed: ${reason}`, { cause }), {
    code: 'PAIRED_CLEANUP_UNCONFIRMED', cleanupUncertain: true, ...(cause?.cleanup ? { cleanup: cause.cleanup } : {}),
  });
}

export async function bounded(promise, ms, reason) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(cleanupError(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}

// Same small process-service interface as the host, also usable by Node tests.
export function spawnNode(spec) {
  const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd, env: spec.replaceEnv ? spec.env : { ...process.env, ...spec.env }, shell: false, windowsHide: true, stdio: 'pipe',
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { if (!child.pid) error.noProcessStarted = true; reject(error); });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  done.catch(() => {});
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
    terminate: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); },
    waitForExit: () => done.then(() => true),
  };
}

const nativePhases = channel('acms.owned-process.native-phase');
const compileMs = 10000;
const compilerExitMs = 1000;

function nativePhase(phase, started, fields) {
  const record = Object.freeze({ phase, elapsedMs: Math.round(performance.now() - started), ...fields });
  nativePhases.publish(record);
  return record;
}

function exitFields(exit) {
  return { exitCode: Number.isInteger(exit?.exitCode) ? exit.exitCode : null,
    signal: /^SIG[A-Z0-9]{2,10}$/.test(exit?.signal ?? '') ? exit.signal : null };
}

function helperStartupError(phases) {
  const latest = phases.at(-1);
  const reason = phases.map(item => item.phase + '=' + item.outcome + ' (' + item.elapsedMs + 'ms)').join(', ');
  const error = latest.confirmed
    ? Object.assign(new Error('Native containment helper unavailable: ' + reason),
      { code: 'PAIRED_CONTAINMENT_STARTUP', noProcessStarted: true })
    : cleanupError('native containment helper: ' + reason);
  return Object.assign(error, { ownedProcessPhases: phases });
}

// A spawn error is not an exit receipt if the compiler actually started.
// The fixed Windows compiler uses no stdin or diagnostic output from the task.
function startCompiler(argv) {
  const child = nodeSpawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: 'ignore' });
  const done = Promise.withResolvers(), exited = Promise.withResolvers();
  let proof;
  child.once('exit', (exitCode, signal) => {
    proof = { exitCode, signal };
    exited.resolve(proof);
    done.resolve(proof);
  });
  child.on('error', error => {
    if (!child.pid) {
      proof = { notStarted: true };
      exited.resolve(proof);
    }
    done.reject(error);
  });
  return { done: done.promise, exited: exited.promise, proof: () => proof, terminate: () => child.kill() };
}

async function removeCompilerDirectory(directory) {
  try { await rm(directory, { recursive: true, force: true }); return true; }
  catch { return false; }
}

async function checkHelperOutput(executable) {
  try {
    const file = await lstat(executable);
    if (!file.isFile() || file.size === 0) return 'output-unusable';
    const handle = await open(executable, 'r');
    await handle.close();
    return 'ready';
  } catch (error) {
    return error.code === 'ENOENT' ? 'output-missing' : 'output-unusable';
  }
}

let helper;
const helperDirectories = new Set();
// The host bundler copies the fixed source under a content-addressed filename
// next to the immutable bundle. Source imports retain the adjacent .cs file.
const helperResource = typeof __ACMS_OWNED_JOB_RESOURCE__ === 'string' ? __ACMS_OWNED_JOB_RESOURCE__ : './owned-job.cs';
async function compileHelper(entry) {
  // Compile our fixed source with the OS .NET compiler, without PowerShell,
  // dependency downloads, execution-policy changes, or a shell command.
  const lookup = performance.now();
  const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = fileURLToPath(new URL(helperResource, import.meta.url));
  let directory;
  try {
    const files = await Promise.all([stat(csc), stat(source)]);
    if (files.some(file => !file.isFile())) throw new Error('Expected a compiler and helper source file');
    directory = await mkdtemp(path.join(tmpdir(), 'acms-owned-helper-'));
  } catch {
    throw helperStartupError([nativePhase('helper-lookup', lookup, { outcome: 'unavailable', confirmed: true })]);
  }
  const phases = [nativePhase('helper-lookup', lookup, { outcome: 'found' })];
  const executable = path.join(directory, 'owned-job.exe');
  const compiling = performance.now();
  let compiler, result, outcome;
  try {
    compiler = startCompiler([csc, '/nologo', '/target:exe', '/platform:anycpu', '/out:' + executable, source]);
    result = await bounded(compiler.done, compileMs, 'native containment helper compile deadline exceeded');
    if (result.exitCode === 0) {
      const output = await checkHelperOutput(executable);
      outcome = output === 'ready' ? 'compiled' : output;
    } else outcome = 'failed';
  } catch (error) { outcome = error.cleanupUncertain ? 'deadline' : 'process-error'; }
  phases.push(nativePhase('helper-compile', compiling, { deadlineMs: compileMs, outcome, ...exitFields(result) }));

  const cleaning = performance.now();
  let proof = compiler ? compiler.proof() : { notStarted: true };
  if (!proof) {
    try { compiler.terminate(); } catch {}
    try { proof = await bounded(compiler.exited, compilerExitMs, 'compiler exit deadline exceeded'); } catch {}
  }
  if (!proof) {
    entry.recovery = compiler.exited.then(async exit => {
      const temporaryRemoved = await removeCompilerDirectory(directory);
      nativePhase('compiler-cleanup', cleaning, { outcome: 'late-exit', deadlineMs: compilerExitMs,
        confirmed: true, ...exitFields(exit), temporaryRemoved });
    });
    phases.push(nativePhase('compiler-cleanup', cleaning, { outcome: 'unconfirmed', deadlineMs: compilerExitMs, confirmed: false }));
    throw helperStartupError(phases);
  }
  const compiled = outcome === 'compiled';
  const temporaryRemoved = compiled ? false : await removeCompilerDirectory(directory);
  phases.push(nativePhase('compiler-cleanup', cleaning, { outcome: proof.notStarted ? 'not-started' : 'exited',
    deadlineMs: compilerExitMs, confirmed: true, ...exitFields(proof), temporaryRemoved }));
  if (!compiled) throw helperStartupError(phases);
  if (helperDirectories.size === 0) process.once('exit', () => {
    for (const owned of helperDirectories) {
      try { rmSync(owned, { recursive: true, force: true }); } catch {}
    }
  });
  helperDirectories.add(directory);
  return executable;
}

function helperEntry() {
  if (helper) return helper;
  const entry = helper = { state: 'shared' };
  const release = () => { if (helper === entry) helper = undefined; };
  entry.promise = compileHelper(entry).then(executable => { entry.state = 'warm'; return executable; }, error => {
    if (entry.recovery) {
      entry.state = 'held';
      entry.recovery.then(release);
    } else release();
    throw error;
  });
  return entry;
}

async function nativeHelper(signal) {
  const started = performance.now();
  let use = helper?.state ?? 'cold';
  let entry = helperEntry();
  if (use === 'warm') {
    const outcome = await checkHelperOutput(await entry.promise);
    signal?.throwIfAborted();
    if (entry.replacement) {
      // A slower probe of the same old generation shares its replacement,
      // even if that compilation already finished or failed.
      entry = entry.replacement;
      use = 'shared';
    } else if (outcome === 'output-missing') {
      // A previous supervisor may still be using this generation's directory.
      helper = undefined;
      entry.replacement = helperEntry();
      nativePhase('helper-acquire', started, { use, outcome });
      entry = entry.replacement;
      use = 'cold';
    } else if (outcome === 'output-unusable') {
      throw helperStartupError([nativePhase('helper-acquire', started, { use, outcome, confirmed: true })]);
    }
  }
  try {
    const executable = await entry.promise;
    nativePhase('helper-acquire', started, { use, outcome: 'ready' });
    return executable;
  } catch (error) {
    nativePhase('helper-acquire', started, { use, outcome: 'failed' });
    throw error;
  }
}

export async function windowsDirectoryAccess(entries) {
  const executable = await nativeHelper();
  const input = entries.map(({ path, write }) => (write ? 'w' : 'r') + path).join('\0');
  return new Promise((resolve, reject) => {
    execFile(executable, ['--directory-access', Buffer.from(input).toString('base64')],
      { windowsHide: true, timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim().split(/\r?\n/).map(Number));
      });
  });
}

/**
 * A job is the ownership boundary, never a numeric PID. The helper launches
 * suspended, assigns before resume, and reports ActiveProcesses == 0. Its
 * private control pipe is connected before any model code can execute.
 * No taskkill fallback: missing/failed taskkill cannot weaken this invariant.
 */
export async function startOwnedProcess(spec, options = {}) {
  options.signal?.throwIfAborted();
  if ((options.platform ?? process.platform) !== 'win32') {
    throw Object.assign(new Error('Verified process containment is currently supported only on Windows; no process was started'), { code: 'PAIRED_CONTAINMENT_UNSUPPORTED' });
  }
  const cleanupMs = options.cleanupMs ?? 5000;
  const startupMs = options.startupMs ?? 10000;
  const executable = options.helperPath ?? await nativeHelper(options.signal);
  options.signal?.throwIfAborted();
  const pipeName = `acms-owned-${randomUUID()}`;
  let connection, receipt, processHandle, rootPid, started = false, cleanup, startupTimer;
  let handshake, supervisorExit, supervisorExited = false;
  let handshakeStarted = performance.now();
  const recordHandshake = outcome => handshake ??= nativePhase('supervisor-handshake', handshakeStarted, { outcome, deadlineMs: startupMs });
  const final = Promise.withResolvers(); final.promise.catch(() => {});
  const server = createServer(socket => {
    if (connection) { socket.destroy(); return; }
    connection = socket;
    server.close();
    socket.on('error', error => final.reject(cleanupError(`control pipe: ${error.code ?? error.message}`)));
    socket.on('end', () => { if (!receipt) final.reject(cleanupError('supervisor disconnected without an exit receipt')); });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16384) { final.reject(cleanupError('invalid oversized control receipt')); socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/^\uFEFF/, ''); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'started' && !started && Number.isSafeInteger(message.pid) && message.pid > 0) {
            started = true; rootPid = message.pid; clearTimeout(startupTimer); recordHandshake('started');
          } else if (message.type === 'cleanup' && !receipt && typeof message.confirmed === 'boolean' && Number.isInteger(message.exitCode)) {
            receipt = message; clearTimeout(startupTimer); recordHandshake('no-start-receipt'); final.resolve(message);
          } else throw new Error('unexpected receipt');
        } catch { final.reject(cleanupError('invalid control receipt')); }
      }
    });
    socket.write([Buffer.from(spec.cwd).toString('base64'), spec.runMs ?? 3600000, Math.max(50, cleanupMs - 500),
      Buffer.from(spec.cleanupReceipt ?? '').toString('base64'), spec.argv.length, ...spec.argv.map(a => Buffer.from(a).toString('base64'))].join('\n') + '\n');
    if (cleanup) socket.write('stop\n');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipeName}`, resolve); });
    options.signal?.throwIfAborted();
    options.beforeStart?.();
    handshakeStarted = performance.now();
    processHandle = (options.spawn ?? spawnNode)({ ...spec,
      argv: [executable, pipeName],
    });
  } catch (error) {
    recordHandshake('launch-failed');
    server.close(); connection?.destroy(); throw error;
  }
  processHandle.done.then(exit => { supervisorExited = true; supervisorExit = exit; }, () => {});

  const dispose = () => cleanup ??= (async () => {
    clearTimeout(startupTimer);
    const cleaning = performance.now();
    const recordCleanup = (outcome, confirmed) => nativePhase('supervisor-cleanup', cleaning, { outcome,
      deadlineMs: cleanupMs, confirmed, jobConfirmed: receipt?.confirmed === true, supervisorExited,
      rootExitCode: receipt?.exitCode ?? null, ...exitFields(supervisorExit) });
    if (connection?.writable) connection.write('stop\n');
    try {
      const [proof] = await bounded(Promise.all([final.promise, processHandle.done]), cleanupMs, 'job verification or supervisor exit deadline exceeded');
      if (!proof.confirmed) throw cleanupError(proof.reason || 'job still has members');
      recordCleanup('verified', true);
      return proof;
    } catch (error) {
      // This only targets our supervisor handle. Closing its private job handle
      // is an additional containment guard, never evidence of successful cleanup.
      try { processHandle.terminate(); } catch (terminationError) { error = cleanupError(`supervisor termination: ${terminationError.message}; ${error.message}`, terminationError); }
      if (error.noProcessStarted) {
        recordHandshake('not-started');
        recordCleanup('not-started', true);
        return { confirmed: true, exitCode: 1, reason: error.message };
      }
      const failure = error.cleanupUncertain ? error : cleanupError(error.message, error);
      failure.ownedProcessPhases = [recordHandshake('unacknowledged'), recordCleanup('unconfirmed', false)];
      failure.cleanup = { ownershipId: pipeName, rootPid: rootPid ?? null, confirmed: false, reason: failure.message };
      failure.message += ` [${pipeName}]`;
      throw failure;
    } finally {
      server.close(); connection?.destroy();
      processHandle.stdin?.destroy(); processHandle.stdout?.destroy(); processHandle.stderr?.destroy();
    }
  })();
  startupTimer = setTimeout(() => {
    recordHandshake('deadline');
    final.reject(cleanupError('supervisor startup deadline exceeded'));
    dispose().catch(() => {});
  }, startupMs);
  // Natural root exit also triggers job termination/verification in the helper.
  // Neither a closed pipe nor the supervisor exit is sufficient alone.
  const done = Promise.race([processHandle.done, final.promise]).then(async () => {
    const proof = await dispose();
    return { exitCode: proof.exitCode, signal: null, cleanup: proof };
  }, async error => {
    await dispose(); throw error;
  });
  done.catch(() => {});
  return { stdin: processHandle.stdin, stdout: processHandle.stdout, stderr: processHandle.stderr,
    done, cleanup: dispose, terminate: () => { dispose().catch(() => {}); },
    waitForExit: () => done.then(() => true),
  };
}
