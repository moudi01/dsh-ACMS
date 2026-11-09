import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupError, startOwnedProcess } from './owned-process.js';

async function windowsExecutable(command, cwd) {
  const locations = /[/\\]/.test(command) ? [path.resolve(cwd, command)] :
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir.replace(/^"|"$/g, ''), command));
  for (const location of locations) {
    const executable = path.extname(location) ? location : location + '.exe';
    try { await access(executable); return executable; } catch {}
  }
  throw Object.assign(new Error(`Executable unavailable: ${command}`), { code: 'ENOENT', noProcessStarted: true });
}

export async function readCommandCleanup(file) {
  try {
    const proof = JSON.parse(await readFile(file, 'utf8'));
    return proof.confirmed === true && Number.isInteger(proof.exitCode) ? proof : null;
  } catch { return null; }
}

async function persistCleanup(file, proof) {
  if (!file || await readCommandCleanup(file)) return;
  try {
    await writeFile(file + '.host', JSON.stringify(proof), { flag: 'wx', flush: true });
    await rename(file + '.host', file);
  } catch (error) { throw cleanupError('could not persist command cleanup receipt', error); }
}

// The Windows supervisor writes its own receipt even if the host disappears.
// Auto-merge requires the same verified Windows containment as paired runners.
export async function runContained(command, args, cwd, { signal, timeout = 120000, maxOutput = 100000, cleanupReceipt, beforeStart } = {}) {
  signal?.throwIfAborted();
  const executable = command === 'node' ? process.execPath : command;
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Automatic integration requires verified process containment on Windows'), { code: 'INTEGRATION_CONTAINMENT_UNSUPPORTED' });
  }
  const runMs = Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, 2147483647) : 120000;
  let child;
  try {
    const argv = [await windowsExecutable(executable, cwd), ...args];
    child = await startOwnedProcess({ argv, cwd, runMs, cleanupReceipt }, { signal, beforeStart: () => beforeStart?.(argv[0]) });
  } catch (error) {
    if (!error.cleanupUncertain) await persistCleanup(cleanupReceipt, { confirmed: true, exitCode: 1, notStarted: true });
    throw error;
  }
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-maxOutput); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxOutput); });
  child.stdin.end();
  const stopped = Promise.withResolvers();
  const abort = () => {
    child.cleanup().then(proof => stopped.resolve({ exitCode: proof.exitCode, signal: null, cleanup: proof }), stopped.reject);
  };
  const timer = setTimeout(() => { timedOut = true; abort(); }, runMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([child.done, stopped.promise]);
    await persistCleanup(cleanupReceipt, result.cleanup);
    signal?.throwIfAborted();
    return { code: result.exitCode, signal: result.signal, timedOut: timedOut || result.cleanup.reason === 'Owned job run deadline exceeded', stdout, stderr };
  } catch (error) {
    if (error.noProcessStarted) await persistCleanup(cleanupReceipt, { confirmed: true, exitCode: 1, notStarted: true });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
