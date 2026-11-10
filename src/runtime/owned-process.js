import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
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

let helper;
// The host bundler copies the fixed source under a content-addressed filename
// next to the immutable bundle. Source imports retain the adjacent .cs file.
const helperResource = typeof __ACMS_OWNED_JOB_RESOURCE__ === 'string' ? __ACMS_OWNED_JOB_RESOURCE__ : './owned-job.cs';
async function nativeHelper() {
  // Compile our fixed source with the OS .NET compiler, without PowerShell,
  // dependency downloads, execution-policy changes, or a shell command.
  if (!helper) helper = (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'acms-owned-helper-'));
    const executable = path.join(directory, 'owned-job.exe');
    const compiler = spawnNode({ argv: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      '/nologo', '/target:exe', '/platform:anycpu', `/out:${executable}`, fileURLToPath(new URL(helperResource, import.meta.url))] });
    let diagnostic = '';
    compiler.stdout.on('data', b => { diagnostic = (diagnostic + b).slice(-4000); });
    compiler.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-4000); });
    compiler.stdin.end();
    try {
      const result = await bounded(compiler.done, 10000, 'native containment helper compile deadline exceeded');
      if (result.exitCode !== 0) throw new Error(`Native containment helper compilation failed: ${diagnostic}`);
      process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} });
      return executable;
    } catch (error) {
      compiler.terminate();
      await bounded(compiler.done.catch(() => {}), 1000, 'compiler exit deadline exceeded');
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  })().catch(error => { helper = undefined; throw error; });
  return helper;
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
  const executable = options.helperPath ?? await nativeHelper();
  options.signal?.throwIfAborted();
  const pipeName = `acms-owned-${randomUUID()}`;
  let connection, receipt, processHandle, rootPid, started = false, cleanup, startupTimer;
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
          if (message.type === 'started' && !started && Number.isSafeInteger(message.pid) && message.pid > 0) { started = true; rootPid = message.pid; clearTimeout(startupTimer); }
          else if (message.type === 'cleanup' && !receipt && typeof message.confirmed === 'boolean' && Number.isInteger(message.exitCode)) {
            receipt = message; clearTimeout(startupTimer); final.resolve(message);
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
    processHandle = (options.spawn ?? spawnNode)({ ...spec,
      argv: [executable, pipeName],
    });
  } catch (error) { server.close(); connection?.destroy(); throw error; }

  const dispose = () => cleanup ??= (async () => {
    clearTimeout(startupTimer);
    if (connection?.writable) connection.write('stop\n');
    try {
      const [proof] = await bounded(Promise.all([final.promise, processHandle.done]), cleanupMs, 'job verification or supervisor exit deadline exceeded');
      if (!proof.confirmed) throw cleanupError(proof.reason || 'job still has members');
      return proof;
    } catch (error) {
      // This only targets our supervisor handle. Closing its private job handle
      // is an additional containment guard, never evidence of successful cleanup.
      try { processHandle.terminate(); } catch (terminationError) { error = cleanupError(`supervisor termination: ${terminationError.message}; ${error.message}`, terminationError); }
      if (error.noProcessStarted) return { confirmed: true, exitCode: 1, reason: error.message };
      const failure = error.cleanupUncertain ? error : cleanupError(error.message, error);
      failure.cleanup = { ownershipId: pipeName, rootPid: rootPid ?? null, confirmed: false, reason: failure.message };
      failure.message += ` [${pipeName}]`;
      throw failure;
    } finally {
      server.close(); connection?.destroy();
      processHandle.stdin?.destroy(); processHandle.stdout?.destroy(); processHandle.stderr?.destroy();
    }
  })();
  startupTimer = setTimeout(() => { final.reject(cleanupError('supervisor startup deadline exceeded')); dispose().catch(() => {}); }, startupMs);
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
