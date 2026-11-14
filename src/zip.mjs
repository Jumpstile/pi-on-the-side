// Minimal stored-only ZIP used for the private .mcpb and the update bundle.
// Entries are uncompressed with a fixed timestamp, so identical sources give an
// identical archive hash on any Node.
const DOS_DATE = (1 << 5) | 1; // 1980-01-01 00:00:00
const UTF8 = 0x0800;
// zlib.crc32 only exists from Node 22.2, and Node 22.0 and 22.1 are allowed: the standard CRC-32 table.
const TABLE = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Strict reader for untrusted archives in exactly the shape zip() writes: one
// disk, no comment, no ZIP64, no encryption, no data descriptors, no extra
// fields, stored entries only, contiguous with nothing hidden between or after
// them, CRC checked, regular files only, safe relative names, no duplicates
// (case-folded). Anything else is refused; callers apply their own allowlist.
export function unzip(buffer, { maxEntries = 64, maxFile = 1024 * 1024 } = {}) {
  const fail = () => { throw new Error('invalid archive'); };
  if (buffer.length < 22) fail();
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 ||
      buffer.readUInt16LE(end + 20) !== 0) fail();
  const count = buffer.readUInt16LE(end + 10);
  if (count < 1 || count > maxEntries || buffer.readUInt16LE(end + 8) !== count) fail();
  const size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (start + size !== end) fail();
  const entries = [], seen = new Set();
  let central = start, local = 0;
  for (let i = 0; i < count; i++) {
    if (central + 46 > end || buffer.readUInt32LE(central) !== 0x02014b50) fail();
    const flags = buffer.readUInt16LE(central + 8), crc = buffer.readUInt32LE(central + 16);
    const length = buffer.readUInt32LE(central + 20), nameLength = buffer.readUInt16LE(central + 28);
    const external = buffer.readUInt32LE(central + 38), type = (external >>> 16) & 0o170000;
    if ((flags !== 0 && flags !== UTF8) || buffer.readUInt16LE(central + 10) !== 0 || buffer.readUInt32LE(central + 24) !== length ||
        length > maxFile || nameLength < 1 || buffer.readUInt16LE(central + 30) !== 0 || buffer.readUInt16LE(central + 32) !== 0 ||
        buffer.readUInt16LE(central + 34) !== 0 || (type !== 0 && type !== 0o100000) || (external & 0x10) ||
        buffer.readUInt32LE(central + 42) !== local || central + 46 + nameLength > end) fail();
    const nameBytes = buffer.subarray(central + 46, central + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes) || /[\u0000-\u001f\u007f\\:]/.test(name) ||
        name.split('/').some(part => part === '' || part === '.' || part === '..') || seen.has(name.toLowerCase())) fail();
    seen.add(name.toLowerCase());
    const data = local + 30 + nameLength;
    if (data + length > start || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags ||
        buffer.readUInt16LE(local + 8) !== 0 || buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== length ||
        buffer.readUInt32LE(local + 22) !== length || buffer.readUInt16LE(local + 26) !== nameLength || buffer.readUInt16LE(local + 28) !== 0 ||
        !buffer.subarray(local + 30, data).equals(nameBytes)) fail();
    const content = buffer.subarray(data, data + length);
    if (crc32(content) !== crc) fail();
    entries.push({ name, data: Buffer.from(content) });
    local = data + length;
    central += 46 + nameLength;
  }
  if (local !== start || central !== end) fail();
  return entries;
}
