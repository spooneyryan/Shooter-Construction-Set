// A zip file, written by hand, because an exported game is a folder and a
// folder has to travel as one file.
//
// Entries are STORED rather than deflated: the browser has no deflate this code
// can reach without pulling in a compression library, and what an export is
// mostly made of -- the audio -- is already compressed. The JavaScript in it
// would shrink, but not enough to be worth a dependency the rest of the app
// would carry on every load.
//
// Zip64 is not here. The format's 32-bit fields cap an entry, and the whole
// archive, at four gigabytes; an export that large is a different problem.

/**
 * One file in the archive. `path` uses forward slashes, as the format requires.
 *
 * The buffer is pinned to a real ArrayBuffer rather than the ArrayBufferLike a
 * bare Uint8Array admits: a Blob will not take a view over a SharedArrayBuffer,
 * and saying so here beats a cast at every call.
 */
export interface ZipEntry {
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array<ArrayBuffer>) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The DOS date and time a zip stamps each entry with. A real one, so a file
 * manager shows something sane rather than 1980.
 */
function dosStamp(when: Date) {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** A zip archive of the given entries, as a Blob ready to download. */
export function zipFiles(entries: ZipEntry[], when = new Date()): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosStamp(when);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);   // local file header
    view.setUint16(4, 20, true);           // version needed
    view.setUint16(6, 0x0800, true);       // UTF-8 names
    view.setUint16(8, 0, true);            // stored
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.data);

    const record = new Uint8Array(46 + name.length);
    const rview = new DataView(record.buffer);
    rview.setUint32(0, 0x02014b50, true);  // central directory header
    rview.setUint16(4, 20, true);          // version made by
    rview.setUint16(6, 20, true);          // version needed
    rview.setUint16(8, 0x0800, true);
    rview.setUint16(10, 0, true);
    rview.setUint16(12, time, true);
    rview.setUint16(14, date, true);
    rview.setUint32(16, crc, true);
    rview.setUint32(20, entry.data.length, true);
    rview.setUint32(24, entry.data.length, true);
    rview.setUint16(28, name.length, true);
    rview.setUint32(42, offset, true);     // where its local header sits
    record.set(name, 46);
    central.push(record);

    offset += local.length + entry.data.length;
  }

  const directorySize = central.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);    // end of central directory
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, directorySize, true);
  eview.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
