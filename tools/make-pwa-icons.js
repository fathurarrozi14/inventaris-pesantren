'use strict';
/* Generator ikon PWA (PNG) untuk inventaris-pesantren.
   Jalankan: node tools/make-pwa-icons.js
   Membuat: public/icons/icon-192.png, icon-512.png, maskable-512.png
   Ditulis manual (zlib + crc32 dari lib.js) tanpa dependensi gambar. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const lib = require('../lib');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(lib.crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* Gambar ikon: latar gradien indigo→violet (+ sudut membulat bila rounded),
   kubah masjid putih, dua menara emas, garis dasar emas. Digambar dgn supersampling 3x. */
function buatIkon(size, { rounded = true, scale = 1 } = {}) {
  const SS = 3;                       // supersample
  const W = size * SS;
  const buf = Buffer.alloc(size * size * 4);
  const R = Math.round(size * 0.22) * SS; // radius sudut (utk rounded)
  const cx = W / 2, cy = W / 2;
  const s = scale;                    // 1 = isi penuh; <1 = konten lebih kecil (maskable)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = px * SS + sx + 0.5, Y = py * SS + sy + 0.5;
          let col = null;
          // batas sudut membulat (utk ikon biasa)
          let inside = true;
          if (rounded) {
            const dx = Math.min(X, W - X), dy = Math.min(Y, W - Y);
            if (dx < R && dy < R) {
              const d = Math.hypot(R - dx, R - dy);
              if (d > R) inside = false;
            }
          }
          if (!inside) { continue; }
          // latar: gradien diagonal indigo #6366F1 -> violet #8B5CF6
          const t = Math.min(1, Math.max(0, (X / W * 0.6 + Y / W * 0.4)));
          col = [Math.round(0x63 + (0x8B - 0x63) * t), Math.round(0x66 + (0x5C - 0x66) * t), Math.round(0xF1 + (0xF6 - 0xF1) * t)];
          // konten (koordinat ternormalisasi thd W, dikompres dgn scale)
          const nx = (X - cx) / (W * s) + 0.5, ny = (Y - cy) / (W * s) + 0.5; // 0..1
          const white = [255, 255, 255], gold = [232, 196, 106];
          // kubah: lingkaran di (0.5, 0.44) r 0.155
          if (Math.hypot(nx - 0.5, ny - 0.44) <= 0.155) col = white;
          // badan kubah: persegi 0.36..0.64 x 0.44..0.66
          else if (nx >= 0.355 && nx <= 0.645 && ny >= 0.44 && ny <= 0.66) col = white;
          // menara kiri/kanan (emas)
          else if (((nx >= 0.225 && nx <= 0.275) || (nx >= 0.725 && nx <= 0.775)) && ny >= 0.36 && ny <= 0.66) col = gold;
          // garis dasar putih
          else if (nx >= 0.30 && nx <= 0.70 && ny >= 0.68 && ny <= 0.735) col = white;
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cover = a / (n * 255);
      buf[i] = Math.round(r / n); buf[i + 1] = Math.round(g / n); buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(255 * cover);
    }
  }
  return png(size, size, buf);
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), buatIkon(192, { rounded: true }));
fs.writeFileSync(path.join(dir, 'icon-512.png'), buatIkon(512, { rounded: true }));
// maskable: latar penuh (tanpa sudut membulat), konten diperkecil ke safe zone
fs.writeFileSync(path.join(dir, 'maskable-512.png'), buatIkon(512, { rounded: false, scale: 0.72 }));
console.log('Ikon dibuat di public/icons/ :', fs.readdirSync(dir).join(', '));
