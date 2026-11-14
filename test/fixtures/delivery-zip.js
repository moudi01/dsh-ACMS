import { crc32, deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function manifestFor(entries) {
  return { format: 'acms-delivery/1', hashAlgorithm: 'sha256-bytes', files: entries.filter(e => !e.name.endsWith('/')).map(e => ({
    path: e.name, sourcePath: e.name, role: 'release', bytes: Buffer.byteLength(e.data), sha256: sha(e.data),
  })) };
}
export function deliveryZip(entries, manifest = manifestFor(entries)) {
  return zip([{ name: 'acms-delivery.json', data: Buffer.from(JSON.stringify(manifest)) }, ...entries]);
}
// A deterministic ZIP writer for adversarial fixtures; deliberately permits
// invalid names/flags/types so tests exercise the consumer's trust boundary.
export function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), method = entry.method ?? 8;
    const flags = entry.flags ?? (0x800 | (entry.descriptor ? 8 : 0)), crc = crc32(data);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const extra = entry.extra ?? Buffer.alloc(0), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!entry.descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(data.length, 12); }
    const record = Buffer.concat([local, name, extra, compressed, descriptor]); locals.push(record);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(entry.attributes ?? 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name, extra])); offset += record.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
