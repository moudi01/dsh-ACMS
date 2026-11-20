import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { AcmsError, assert } from '../core/util.js';
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, MANIFEST_PATH, byteSha256, portablePath, verifyDeliveryArchive } from './delivery-archive.js';

const directoryMode = 0o40755;
const utf8 = 0x800;
const stableDate = 0x2821; // 2000-01-01 in DOS date format.

function createZip(limit) {
  const parts = [], central = [];
  let offset = 0, indexBytes = 0;
  return {
    add(name, bytes, mode) {
      const directory = mode === directoryMode;
      portablePath(directory ? name.slice(0, -1) : name);
      const filename = Buffer.from(name, 'utf8');
      const compressed = bytes.length ? deflateRawSync(bytes) : bytes;
      const useCompression = compressed.length < bytes.length;
      const data = useCompression ? compressed : bytes;
      const crc = crc32(bytes);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(utf8, 6);
      local.writeUInt16LE(useCompression ? 8 : 0, 8);
      local.writeUInt16LE(stableDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(filename.length, 26);
      const index = Buffer.alloc(46);
      index.writeUInt32LE(0x02014b50);
      index.writeUInt16LE(0x0314, 4);
      local.copy(index, 6, 4, 28);
      index.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
      index.writeUInt32LE(offset, 42);
      offset += local.length + filename.length + data.length;
      indexBytes += index.length + filename.length;
      assert(offset + indexBytes + 22 <= limit, 'ARTIFACT_TOO_LARGE', '候选 ZIP 超出公司或交付归档大小限制。');
      parts.push(local, filename, data);
      central.push(index, filename);
    },
    finish() {
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50);
      end.writeUInt16LE(central.length / 2, 8);
      end.writeUInt16LE(central.length / 2, 10);
      end.writeUInt32LE(indexBytes, 12);
      end.writeUInt32LE(offset, 16);
      return Buffer.concat([...parts, ...central, end], offset + indexBytes + end.length);
    },
  };
}

async function readEntry(root, name, item, mode, remaining) {
  const filename = path.join(root, name);
  const info = await lstat(filename);
  assert(await realpath(filename) === filename &&
    (item.mode === 'directory' ? info.isDirectory() : info.isFile()),
  'COMPOSITE_CONTENT', `候选路径 ${name} 无法作为普通文件或目录核对。`);
  if (item.mode === 'directory') return null;
  assert(info.size <= ARCHIVE_LIMITS.fileBytes && info.size <= remaining,
    'ARTIFACT_TOO_LARGE', `候选文件 ${name} 超出归档展开大小限制。`);
  const bytes = await readFile(filename);
  assert(bytes.length === info.size && (process.platform === 'win32' || !!(info.mode & 0o111) === (item.mode === '100755')),
    'COMPOSITE_CONTENT', `归档期间候选文件 ${name} 的大小或模式已变化。`);
  const identity = mode === 'copy' ? byteSha256(bytes) : createHash(item.oid.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert(identity === item.oid, 'COMPOSITE_CONTENT', `候选文件 ${name} 与已验证版本字节不一致。`);
  return bytes;
}

export async function packageCandidateZip({ root: source, entries, mode, evidence, maxBytes }) {
  const root = await realpath(source);
  const files = [], directories = new Set(['source']);
  const zip = createZip(Math.min(ARCHIVE_LIMITS.archiveBytes, maxBytes));
  let expandedBytes = 0;
  for (const [name, item] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    portablePath(name);
    const bytes = await readEntry(root, name, item, mode, ARCHIVE_LIMITS.totalBytes - expandedBytes);
    const filename = `source/${name}`;
    for (let dir = bytes ? path.posix.dirname(filename) : filename; dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
    if (bytes) {
      expandedBytes += bytes.length;
      files.push({ path: filename, sourcePath: name, role: 'release', bytes: bytes.length, sha256: byteSha256(bytes) });
      zip.add(filename, bytes, item.mode === '100755' ? 0o100755 : 0o100644);
    }
    assert(files.length + directories.size + 1 <= ARCHIVE_LIMITS.entries, 'ARTIFACT_TOO_LARGE', '候选文件和目录数量超出归档限制。');
  }
  for (const directory of [...directories].sort()) zip.add(directory + '/', Buffer.alloc(0), directoryMode);
  const manifest = Buffer.from(JSON.stringify({ format: ARCHIVE_FORMAT, hashAlgorithm: 'sha256-bytes',
    candidate: { ...evidence, materialization: 'clean-directory' }, files }));
  assert(manifest.length <= ARCHIVE_LIMITS.manifestBytes && expandedBytes + manifest.length <= ARCHIVE_LIMITS.totalBytes,
    'ARTIFACT_TOO_LARGE', '候选清单或展开后的大小超出交付归档限制。');
  zip.add(MANIFEST_PATH, manifest, 0o100644);
  const bytes = zip.finish();
  const report = verifyDeliveryArchive(bytes);
  if (!report.passed) throw new AcmsError('COMPOSITE_ARCHIVE_INVALID',
    `完整候选无法使用交付归档格式保存：${report.errors.map(({ code, path }) => path ? `${code} (${path})` : code).slice(0, 5).join('、')}`);
  return { bytes, archiveSha256: report.archiveSha256, manifestSha256: report.manifestSha256, files: files.length,
    directories: directories.size - 1 };
}
