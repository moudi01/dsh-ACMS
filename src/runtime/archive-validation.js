import { Worker } from 'node:worker_threads';

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

async function validateArtifact(kind, bytes, signal) {
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
    // Transfer an owned copy; the caller still needs the original immutable bytes.
    const input = Uint8Array.from(bytes);
    worker.postMessage({ kind, bytes: input }, [input.buffer]);
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
