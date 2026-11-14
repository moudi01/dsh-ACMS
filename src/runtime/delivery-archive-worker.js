import { parentPort } from 'node:worker_threads';
import { verifyDeliveryArchive } from './delivery-archive.js';

parentPort.once('message', bytes => {
  parentPort.postMessage(verifyDeliveryArchive(Buffer.from(bytes)));
  parentPort.close();
});
