import { deflateRawSync, inflateRawSync } from "node:zlib";
const crcTable = (() => { const table = new Uint32Array(256); for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[index] = value >>> 0; } return table; })();
export function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function dosDateTime(date = new Date()) { const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2); const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(); return { time: time & 0xffff, date: day & 0xffff }; }
export function writeZip(files) {
  const locals = []; const central = []; let offset = 0; const stamp = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8"); const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const compressed = deflateRawSync(data, { level: 9 }); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(stamp.time, 12); entry.writeUInt16LE(stamp.date, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32); entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(entry, name); offset += 30 + name.length + compressed.length;
  }
  const centralOffset = offset; const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
export function readZip(buffer) {
  let end = -1; for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  if (end < 0) throw new Error("ZIP end-of-central-directory record not found");
  const count = buffer.readUInt16LE(end + 10); const centralOffset = buffer.readUInt32LE(end + 16); const entries = new Map(); let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid central directory entry at " + cursor);
    const method = buffer.readUInt16LE(cursor + 10); const crc = buffer.readUInt32LE(cursor + 16); const compressedSize = buffer.readUInt32LE(cursor + 20); const size = buffer.readUInt32LE(cursor + 24); const nameLength = buffer.readUInt16LE(cursor + 28); const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32); const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid local header for " + name);
    const localName = buffer.readUInt16LE(localOffset + 26); const localExtra = buffer.readUInt16LE(localOffset + 28); const dataStart = localOffset + 30 + localName + localExtra;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize); const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== size) throw new Error("size mismatch for " + name); if (crc32(data) !== crc) throw new Error("CRC mismatch for " + name);
    entries.set(name, data); cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
