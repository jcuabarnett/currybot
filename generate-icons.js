// Generates PNG icons for the PWA using only built-in Node.js modules.
// Run once: node generate-icons.js
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG chunk writer ─────────────────────────────────────────────────────────
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf  = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Rounded rectangle membership ────────────────────────────────────────────
function inRR(x, y, w, h, r) {
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// ── Build RGBA pixel buffer ──────────────────────────────────────────────────
function makePixels(size) {
  const buf    = Buffer.alloc(size * size * 4);    // RGBA
  const radius = Math.round(size * 0.22);          // iOS-style corner radius
  const cx     = size / 2, cy = size / 2;

  // Saffron background + chilli accent ring
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRR(x, y, size, size, radius)) { buf[i + 3] = 0; continue; }

      // Distance from centre for a subtle gradient
      const d  = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.5);
      const rr = Math.round(245 - d * 20);
      const gg = Math.round(166 - d * 30);
      const bb = Math.round(35  - d * 10);
      buf[i]   = Math.max(0, rr);
      buf[i+1] = Math.max(0, gg);
      buf[i+2] = Math.max(0, bb);
      buf[i+3] = 255;
    }
  }

  // Dark bowl shape (simplified: filled ellipse at 55 % height)
  const bw = size * 0.52, bh = size * 0.22;
  const bx = cx, by = size * 0.60;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (buf[i+3] === 0) continue;
      const ex = (x - bx) / bw, ey = (y - by) / bh;
      if (ex*ex + ey*ey <= 1) {
        buf[i] = 26; buf[i+1] = 13; buf[i+2] = 4;
      }
    }
  }

  // Steam dots (3 small circles above bowl)
  const dots = [[-0.15, -0.12], [0, -0.16], [0.15, -0.12]];
  const dr = size * 0.035;
  for (const [dx, dy] of dots) {
    const sx = cx + dx * size, sy = size * 0.44 + dy * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (buf[i+3] === 0) continue;
        if ((x-sx)**2 + (y-sy)**2 <= dr*dr) {
          buf[i] = 26; buf[i+1] = 13; buf[i+2] = 4; buf[i+3] = 180;
        }
      }
    }
  }

  return buf;
}

// ── Encode as PNG ────────────────────────────────────────────────────────────
function buildPng(size) {
  const pixels = makePixels(size);

  // Raw scanlines: filter-byte(0) + RGBA per pixel
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;  // filter: None
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write files ──────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };
for (const [name, size] of Object.entries(sizes)) {
  fs.writeFileSync(path.join(outDir, name), buildPng(size));
  console.log(`  ✓  ${name}  (${size}×${size})`);
}
console.log('\nDone. Run: node server.js\n');
