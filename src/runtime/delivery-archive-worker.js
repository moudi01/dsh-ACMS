import { parentPort } from 'node:worker_threads';
import { verifyDeliveryArchive } from './delivery-archive.js';
import { inspectDeliveryText } from './text-integrity.js';
import { packageCandidateZip, verifyCandidateZip } from './candidate-zip.js';

parentPort.once('message', async ({ kind, bytes, candidate, authority }) => {
  try {
    if (kind === 'candidate') {
      const result = await packageCandidateZip(candidate);
      const output = Uint8Array.from(result.bytes);
      parentPort.postMessage({ ...result, bytes: output }, [output.buffer]);
    } else {
      const content = Buffer.from(bytes);
      parentPort.postMessage(kind === 'text' ? inspectDeliveryText(content)
        : kind === 'candidate-read' ? verifyCandidateZip(content, authority) : verifyDeliveryArchive(content));
    }
  } catch (error) {
    if (kind !== 'candidate') throw error;
    parentPort.postMessage({ failure: { code: error.code ?? 'COMPOSITE_ARCHIVE_INVALID',
      message: error.diagnostic ? `${error.diagnostic.code} (${error.diagnostic.path})` : error.message } });
  } finally { parentPort.close(); }
});
