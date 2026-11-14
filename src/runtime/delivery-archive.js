import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';

export const ARCHIVE_FORMAT = 'acms-delivery/1';
export const MANIFEST_PATH = 'acms-delivery.json';
export const ARCHIVE_LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, entries: 10000,
  fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024 });
export const byteSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (code, path, details = {}) => { throw Object.assign(new Error(code), { diagnostic: { code, path, ...details } }); };
const requireValue = (ok, code, path, details) => { if (!ok) fail(code, path, details); };

// Use one portable namespace. Never extract entries, follow links, or normalize
// an unsafe name into a safe one. NFC/case aliases are rejected, not overwritten.
function portablePath(name) {
  requireValue(typeof name === 'string' && name.length > 0 && name.length <= 1024 && name.isWellFormed(), 'INVALID_PATH', String(name).slice(0, 1024));
  requireValue(!/[\\:\x00-\x1f\x7f<>"|?*]/u.test(name), 'INVALID_PATH', name);
  requireValue(name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'INVALID_PATH', name);
  return name.normalize('NFC').toUpperCase().toLowerCase();
}

function recordPathAliases(aliases, name) {
  const parts = name.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/'), key = portablePath(prefix), previous = aliases.get(key);
    requireValue(!previous || previous === prefix, 'PATH_ALIAS_CONFLICT', name, { otherPath: previous });
    aliases.set(key, prefix);
  }
}

function extras(bytes, name) {
  for (let p = 0; p < bytes.length;) {
    requireValue(p + 4 <= bytes.length, 'INVALID_ZIP_EXTRA', name);
    const type = bytes.readUInt16LE(p), size = bytes.readUInt16LE(p + 2); p += 4;
    requireValue(p + size <= bytes.length, 'INVALID_ZIP_EXTRA', name);
    // ZIP64 and alternate Unicode names introduce a second interpretation.
    requireValue(![0x0001, 0x000d, 0x7075, 0x756e].includes(type), 'UNSUPPORTED_ZIP_EXTRA', name, { type });
    p += size;
  }
}

function readZip(bytes, limits) {
  requireValue(bytes.length <= limits.archiveBytes, 'ARCHIVE_SIZE_LIMIT', null);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  }
  requireValue(end >= 0, 'INVALID_ZIP_END', null);
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  requireValue(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count,
    'UNSUPPORTED_MULTIDISK_ZIP', null);
  requireValue(count !== 65535 && central !== 0xffffffff && centralSize !== 0xffffffff, 'UNSUPPORTED_ZIP64', null);
  requireValue(count <= limits.entries, 'ENTRY_LIMIT', null);
  requireValue(central + centralSize === end, 'INVALID_ZIP_DIRECTORY', null);
  const records = [], names = new Map(), aliases = new Map(); let p = central, total = 0;
  for (let i = 0; i < count; i++) {
    requireValue(p + 46 <= end && bytes.readUInt32LE(p) === 0x02014b50, 'INVALID_ZIP_ENTRY', null);
    const flags = bytes.readUInt16LE(p + 8), method = bytes.readUInt16LE(p + 10), crc = bytes.readUInt32LE(p + 16);
    const compressed = bytes.readUInt32LE(p + 20), size = bytes.readUInt32LE(p + 24), n = bytes.readUInt16LE(p + 28);
    const x = bytes.readUInt16LE(p + 30), comment = bytes.readUInt16LE(p + 32), offset = bytes.readUInt32LE(p + 42);
    requireValue(p + 46 + n + x + comment <= end, 'INVALID_ZIP_ENTRY', null);
    const nameBytes = bytes.subarray(p + 46, p + 46 + n);
    requireValue((flags & ~0x080e) === 0 && [0, 8].includes(method) && (method === 8 || !(flags & 6)), 'UNSUPPORTED_ZIP_ENCODING', null);
    requireValue((flags & 0x800) || nameBytes.every(b => b < 128), 'ZIP_NAME_REQUIRES_UTF8', null);
    let name;
    try { name = decoder.decode(nameBytes); } catch { fail('INVALID_UTF8_PATH', null); }
    const directory = name.endsWith('/'), key = portablePath(directory ? name.slice(0, -1) : name);
    requireValue(!names.has(key), 'DUPLICATE_ZIP_PATH', name, { otherPath: names.get(key) }); names.set(key, name);
    recordPathAliases(aliases, directory ? name.slice(0, -1) : name);
    const attributes = bytes.readUInt32LE(p + 38), type = (attributes >>> 16) & 0xf000;
    requireValue([0, 0x8000, 0x4000].includes(type) && !(attributes & 0x400), 'UNSUPPORTED_LINK', name);
    requireValue((type !== 0x4000 || directory) && (type !== 0x8000 || !directory) && (!(attributes & 0x10) || directory), 'ZIP_TYPE_MISMATCH', name);
    requireValue(bytes.readUInt16LE(p + 34) === 0, 'UNSUPPORTED_MULTIDISK_ZIP', name);
    requireValue(size <= (name === MANIFEST_PATH ? limits.manifestBytes : limits.fileBytes) && (total += size) <= limits.totalBytes,
      'EXPANDED_SIZE_LIMIT', name);
    requireValue(!directory || size === 0, 'DIRECTORY_HAS_CONTENT', name);
    extras(bytes.subarray(p + 46 + n, p + 46 + n + x), name);
    records.push({ name, key, directory, nameBytes, flags, method, crc, compressed, size, offset });
    p += 46 + n + x + comment;
  }
  requireValue(p === end, 'INVALID_ZIP_DIRECTORY', null);
  const files = new Map(); let localEnd = 0;
  // Contiguous local records rule out hidden entries, overlapping entries and
  // self-extracting prefixes that other ZIP readers could interpret differently.
  for (const record of records.sort((a, b) => a.offset - b.offset)) {
    const { name, nameBytes, offset, flags, method, compressed, size, crc, directory } = record;
    requireValue(offset === localEnd && offset + 30 <= central && bytes.readUInt32LE(offset) === 0x04034b50, 'INVALID_LOCAL_ENTRY', name);
    const n = bytes.readUInt16LE(offset + 26), x = bytes.readUInt16LE(offset + 28), start = offset + 30 + n + x;
    requireValue(start + compressed <= central, 'INVALID_LOCAL_ENTRY', name);
    requireValue(bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method &&
      bytes.subarray(offset + 30, offset + 30 + n).equals(nameBytes), 'ZIP_HEADER_MISMATCH', name);
    extras(bytes.subarray(offset + 30 + n, start), name);
    for (const [at, expected] of [[14, crc], [18, compressed], [22, size]]) {
      const actual = bytes.readUInt32LE(offset + at);
      requireValue(actual === expected || ((flags & 8) && actual === 0), 'ZIP_HEADER_MISMATCH', name);
    }
    localEnd = start + compressed;
    if (flags & 8) {
      const signed = localEnd + 4 <= central && bytes.readUInt32LE(localEnd) === 0x08074b50;
      const descriptor = localEnd + (signed ? 4 : 0);
      requireValue(descriptor + 12 <= central && bytes.readUInt32LE(descriptor) === crc &&
        bytes.readUInt32LE(descriptor + 4) === compressed && bytes.readUInt32LE(descriptor + 8) === size, 'INVALID_DATA_DESCRIPTOR', name);
      localEnd = descriptor + 12;
    }
    let content;
    if (method === 0) content = bytes.subarray(start, start + compressed);
    else {
      try {
        const result = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size), info: true });
        requireValue(result.engine.bytesWritten === compressed, 'TRAILING_DEFLATE_DATA', name);
        content = result.buffer;
      } catch (error) { if (error.diagnostic) throw error; fail('INVALID_DEFLATE', name); }
    }
    requireValue(content.length === size, 'ZIP_SIZE_MISMATCH', name, { expected: size, actual: content.length });
    requireValue(crc32(content) === crc, 'ZIP_CRC_MISMATCH', name);
    if (!directory) files.set(name, { bytes: size, sha256: byteSha256(content), ...(name === MANIFEST_PATH ? { content } : {}) });
    for (let i = 1, parts = record.key.split('/'); i < parts.length; i++) {
      const parent = names.get(parts.slice(0, i).join('/'));
      requireValue(!parent || parent.endsWith('/'), 'FILE_DIRECTORY_CONFLICT', name, { otherPath: parent });
    }
  }
  requireValue(localEnd === central, 'UNINDEXED_ZIP_CONTENT', null);
  return { files, names, total };
}

// The report is evidence for these exact archive bytes, never an approval of
// their content. Caller supplies provenance; the archive cannot assert approval.
export function verifyDeliveryArchive(bytes, limits = ARCHIVE_LIMITS) {
  const report = { format: ARCHIVE_FORMAT, passed: false, archiveSha256: byteSha256(bytes), errors: [] };
  try {
    const { files, names, total } = readZip(bytes, limits);
    const manifestFile = files.get(MANIFEST_PATH);
    requireValue(manifestFile, 'MISSING_MANIFEST', MANIFEST_PATH);
    report.manifestSha256 = manifestFile.sha256;
    let manifest;
    try { manifest = JSON.parse(decoder.decode(manifestFile.content)); } catch { fail('INVALID_MANIFEST_JSON', MANIFEST_PATH); }
    requireValue(manifest?.format === ARCHIVE_FORMAT && manifest.hashAlgorithm === 'sha256-bytes' && Array.isArray(manifest.files), 'INVALID_MANIFEST_CONTRACT', MANIFEST_PATH);
    requireValue(manifest.files.length <= limits.entries, 'MANIFEST_ENTRY_LIMIT', MANIFEST_PATH);
    const listed = new Map(), sources = new Map(), normalized = [], pathAliases = new Map(), sourceAliases = new Map();
    const addError = error => { if (report.errors.length < 100) report.errors.push(error); };
    for (const entry of manifest.files) {
      requireValue(entry && typeof entry === 'object', 'INVALID_MANIFEST_ENTRY', MANIFEST_PATH);
      const key = portablePath(entry.path), sourceKey = portablePath(entry.sourcePath);
      requireValue(key !== MANIFEST_PATH, 'SELF_LISTED_MANIFEST', entry.path);
      requireValue(!listed.has(key), 'DUPLICATE_MANIFEST_PATH', entry.path, { otherPath: listed.get(key) });
      requireValue(!sources.has(sourceKey), 'DUPLICATE_SOURCE_PATH', entry.sourcePath);
      listed.set(key, entry.path); sources.set(sourceKey, entry.sourcePath);
      recordPathAliases(pathAliases, entry.path); recordPathAliases(sourceAliases, entry.sourcePath);
      requireValue(['release', 'evidence', 'deleted'].includes(entry.role), 'INVALID_FILE_ROLE', entry.path);
      if (entry.role === 'deleted') {
        requireValue(entry.bytes === undefined && entry.sha256 === undefined, 'INVALID_DELETION', entry.path);
        if (names.has(key) || [...names.keys()].some(name => name.startsWith(key + '/'))) addError({ code: 'DELETED_PATH_PRESENT', path: entry.path });
        normalized.push({ path: entry.path, sourcePath: entry.sourcePath, role: entry.role });
        continue;
      }
      requireValue(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= limits.fileBytes && /^[a-f0-9]{64}$/.test(entry.sha256), 'INVALID_FILE_DIGEST', entry.path);
      normalized.push({ path: entry.path, sourcePath: entry.sourcePath, role: entry.role, bytes: entry.bytes, sha256: entry.sha256 });
      const actual = files.get(entry.path);
      if (!actual) addError({ code: 'MISSING_FILE', path: entry.path, expectedSha256: entry.sha256, actualSha256: null });
      else if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) addError({ code: 'CONTENT_MISMATCH', path: entry.path,
        expectedSha256: entry.sha256, actualSha256: actual.sha256, expectedBytes: entry.bytes, actualBytes: actual.bytes });
    }
    for (const name of files.keys()) if (name !== MANIFEST_PATH && listed.get(portablePath(name)) !== name) addError({ code: 'UNEXPECTED_FILE', path: name });
    report.manifest = { format: ARCHIVE_FORMAT, hashAlgorithm: 'sha256-bytes', files: normalized };
    report.totals = { files: files.size, expandedBytes: total };
    report.passed = report.errors.length === 0;
  } catch (error) { report.errors.push(error.diagnostic ?? { code: 'INVALID_ARCHIVE', path: null }); }
  return report;
}
