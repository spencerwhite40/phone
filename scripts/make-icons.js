'use strict';
// Generates the PNG icons (iOS needs PNG for add-to-home-screen) with zero dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

// Draw: dark rounded tile + green circle + white handset-ish bar. `safe` shrinks art for maskable icons.
function render(size, { rounded, safe }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const R = size * 0.22, cx = size / 2, cy = size / 2, rad = size * (safe ? 0.28 : 0.34);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let px = [15, 23, 42, 255];
      if (rounded) { // clip corners
        const dx = Math.max(R - x, x - (size - 1 - R), 0), dy = Math.max(R - y, y - (size - 1 - R), 0);
        if (dx * dx + dy * dy > R * R) px = [0, 0, 0, 0];
      }
      const d = Math.hypot(x - cx, y - cy);
      if (px[3] && d <= rad) px = [34, 197, 94, 255];
      // white "handset": a rotated bar with two end nubs
      const u = ((x - cx) * 0.7071 + (y - cy) * 0.7071), v = ((x - cx) * -0.7071 + (y - cy) * 0.7071);
      const L = rad * 0.62, T = rad * 0.16;
      const bar = Math.abs(v) < T && Math.abs(u) < L;
      const nub = Math.abs(Math.abs(u) - L) < T * 1.2 && v > -T * 2.6 && v < T;
      if (px[3] && d <= rad && (bar || nub)) px = [255, 255, 255, 255];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const files = {
  'icon-192.png': render(192, { rounded: true }),
  'icon-512.png': render(512, { rounded: true }),
  'icon-maskable-512.png': render(512, { rounded: false, safe: true }),
  'apple-touch-icon.png': render(180, { rounded: false }), // iOS rounds it itself
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(out, name), buf);

fs.writeFileSync(path.join(out, 'icon.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f172a"/><circle cx="256" cy="256" r="174" fill="#22c55e"/>'
  + '<path d="M196 168c-14 0-26 12-26 26 0 84 74 158 158 158 14 0 26-12 26-26v-24l-56-20-24 24c-24-12-44-32-56-56l24-24-20-56z" fill="#fff"/></svg>\n');
console.log('icons written to', out);
