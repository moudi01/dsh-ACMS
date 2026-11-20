import { Worker } from 'node:worker_threads';
import { AcmsError } from '../core/util.js';

const workerResource = typeof __ACMS_ARCHIVE_WORKER_RESOURCE__ === 'string'
  ? __ACMS_ARCHIVE_WORKER_RESOURCE__ : './delivery-archive-worker.js';

// Keep inflation, hashing and path validation off the scheduler's event loop.
// Settlement always waits for worker exit, including cancellation and errors.
export async function validateDeliveryArchive(bytes, { signal } = {}) {
  return validateArtifact('archive', bytes, signal);
}

export async function validateDeliveryText(bytes, { signal } = {}) {
  return validateArtifact('text', bytes, signal);
}

export async function validateCandidateArchive(bytes, { authority, signal }) {
  return validateArtifact('candidate-read', bytes, signal, authority);
}

export async function buildCandidateArchive(candidate, { signal } = {}) {
  const result = await runArchiveWorker({ kind: 'candidate', candidate }, [], signal);
  if (result.failure) throw new AcmsError(result.failure.code, result.failure.message);
  return { ...result, bytes: Buffer.from(result.bytes) };
}

function validateArtifact(kind, bytes, signal, authority) {
  signal?.throwIfAborted();
  // Transfer an owned copy; the caller still needs the original immutable bytes.
  const input = Uint8Array.from(bytes);
  return runArchiveWorker({ kind, bytes: input, authority }, [input.buffer], signal);
}

async function runArchiveWorker(message, transfer, signal) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL(workerResource, import.meta.url), { execArgv: [] });
  let report, failure;
  const exited = new Promise(resolve => {
    worker.once('message', value => { report = value; });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      if (code !== 0 && !failure) failure = new Error(`Archive validation worker exited with code ${code}`);
      resolve();
    });
  });
  const abort = () => { worker.terminate().catch(error => { failure ??= error; }); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    worker.postMessage(message, transfer);
    await exited;
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!report) throw new Error('Archive validation worker exited without a result');
    return report;
  } finally {
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
    await exited;
  }
}
