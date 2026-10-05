// Minimal reader for uncompressed, stripped, 8-bit TIFF files (the format of the
// Natural Earth 10m shaded-relief rasters). Reads arbitrary windows without
// loading the whole 230 MB file into memory.
import fs from 'node:fs';

export function openTiff(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  const le = head.toString('ascii', 0, 2) === 'II';
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifdOff = u32(head, 4);
  const cntBuf = Buffer.alloc(2);
  fs.readSync(fd, cntBuf, 0, 2, ifdOff);
  const n = u16(cntBuf, 0);
  const ifd = Buffer.alloc(n * 12);
  fs.readSync(fd, ifd, 0, n * 12, ifdOff + 2);
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 16: 8 };
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = i * 12;
    const tag = u16(ifd, e), type = u16(ifd, e + 2), count = u32(ifd, e + 4);
    const size = (typeSize[type] || 1) * count;
    let buf;
    if (size <= 4) buf = ifd.subarray(e + 8, e + 12);
    else { buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, u32(ifd, e + 8)); }
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      if (type === 3) vals.push(u16(buf, k * 2));
      else if (type === 4) vals.push(u32(buf, k * 4));
      else if (type === 1) vals.push(buf[k]);
    }
    tags[tag] = vals;
  }
  const width = tags[256][0], height = tags[257][0];
  const spp = tags[277] ? tags[277][0] : 1;
  const compression = tags[259] ? tags[259][0] : 1;
  if (compression !== 1) throw new Error(`${file}: compressed TIFF not supported`);
  if (tags[322]) throw new Error(`${file}: tiled TIFF not supported`);
  const rowsPerStrip = tags[278] ? tags[278][0] : height;
  const offsets = tags[273];
  const rowBytes = width * spp;

  // Read a window [x0, x0+w) x [y0, y0+h); returns Uint8Array (first sample only).
  function readWindow(x0, y0, w, h) {
    const out = new Uint8Array(w * h);
    const row = Buffer.alloc(w * spp);
    for (let y = 0; y < h; y++) {
      const yy = y0 + y;
      const strip = Math.floor(yy / rowsPerStrip);
      const off = offsets[strip] + (yy - strip * rowsPerStrip) * rowBytes + x0 * spp;
      fs.readSync(fd, row, 0, w * spp, off);
      for (let x = 0; x < w; x++) out[y * w + x] = row[x * spp];
    }
    return out;
  }
  return { width, height, spp, readWindow, close: () => fs.closeSync(fd) };
}
