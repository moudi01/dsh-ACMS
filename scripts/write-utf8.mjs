import { open, readFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// ASCII transport avoids shell code-page conversion. The expected raw-byte
// digest must be derived from intended content, before crossing that boundary.
export async function writeVerifiedUtf8(filename, base64, expectedSha256) {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid canonical Base64');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new Error('Invalid canonical Base64');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actual !== expectedSha256) throw new Error('UTF-8 byte digest mismatch; destination was not written');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const target = path.resolve(filename), temporary = target + '.utf8-' + randomUUID();
  let handle;
  try {
    handle = await open(temporary, 'wx'); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (!(await readFile(temporary)).equals(bytes)) throw new Error('UTF-8 temporary file readback mismatch');
    await rename(temporary, target);
    if (!(await readFile(target)).equals(bytes)) throw new Error('UTF-8 destination readback mismatch');
    return { bytes: bytes.length, sha256: actual, encoding: 'utf-8', readbackVerified: true };
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) { console.error('Usage: node scripts/write-utf8.mjs <output-file> <base64> <sha256-of-intended-utf8-bytes>'); process.exitCode = 2; }
  else try { console.log(JSON.stringify(await writeVerifiedUtf8(...process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
