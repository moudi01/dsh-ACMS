import { parentPort } from 'node:worker_threads';
import { verifyDeliveryArchive } from './delivery-archive.js';
import { inspectDeliveryText } from './text-integrity.js';

parentPort.once('message', ({ kind, bytes }) => {
  const content = Buffer.from(bytes);
  parentPort.postMessage(kind === 'text' ? inspectDeliveryText(content) : verifyDeliveryArchive(content));
  parentPort.close();
});
