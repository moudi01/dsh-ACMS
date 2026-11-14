import { open } from 'node:fs/promises';
import { ARCHIVE_LIMITS, verifyDeliveryArchive } from '../src/runtime/delivery-archive.js';

const filename = process.argv[2];
if (!filename || process.argv.length !== 3) {
  console.error('Usage: node scripts/verify-delivery-archive.mjs delivery.zip');
  process.exitCode = 2;
} else {
  let file;
  try {
    file = await open(filename, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > ARCHIVE_LIMITS.archiveBytes) throw new Error('Archive must be a file no larger than 64 MiB');
    // Read at most the limit + 1 even if another writer grows the file.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, ARCHIVE_LIMITS.archiveBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size || (await file.stat()).size !== stat.size) throw new Error('Archive changed while reading');
    const report = verifyDeliveryArchive(bytes.subarray(0, length));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
  finally { await file?.close(); }
}
