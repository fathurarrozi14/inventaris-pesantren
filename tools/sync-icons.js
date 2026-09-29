'use strict';
/* ============================================================
   Sinkronkan IKON STATIS (public/icons/*.png) dengan LOGO WEBSITE.
   Tujuan: file statis (yang bisa terpakai lewat cache/manifest lama,
   fallback, atau WebAPK yang sudah terinstal) JUGA berisi logo website,
   bukan ikon bawaan lagi.

   Jalankan:  node tools/sync-icons.js
   Dipakai juga otomatis oleh server setiap logo disimpan (best-effort).
   ============================================================ */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

const DIR = path.join(__dirname, '..', 'public', 'icons');

function warnaRataRata(img) {
  let r = 0, g = 0, b = 0, n = 0;
  const langkah = Math.max(1, Math.floor(Math.min(img.bitmap.width, img.bitmap.height) / 40));
  for (let y = 0; y < img.bitmap.height; y += langkah) {
    for (let x = 0; x < img.bitmap.width; x += langkah) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, y));
      if (c.a < 20) continue;
      r += c.r; g += c.g; b += c.b; n++;
    }
  }
  if (!n) return { r: 99, g: 102, b: 241 };
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/* Buat buffer PNG persegi dari buffer gambar logo */
async function ikonDariLogo(logoBuf, ukuran, mode) {
  const img = await Jimp.read(logoBuf);
  const latar = warnaRataRata(img);
  const canvas = new Jimp(ukuran, ukuran, Jimp.rgbaToInt(latar.r, latar.g, latar.b, 255));
  const sisi = Math.round(ukuran * (mode === 'maskable' ? 0.66 : 0.84));
  img.scaleToFit(sisi, sisi);
  canvas.composite(img, Math.round((ukuran - img.bitmap.width) / 2), Math.round((ukuran - img.bitmap.height) / 2));
  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

/* Tulis 3 ikon statis dari buffer logo. Mengembalikan true bila berhasil. */
async function tulisIkonStatis(logoBuf) {
  const files = [
    ['icon-192.png', 192, 'any'],
    ['icon-512.png', 512, 'any'],
    ['maskable-512.png', 512, 'maskable']
  ];
  for (const [nama, ukuran, mode] of files) {
    const png = await ikonDariLogo(logoBuf, ukuran, mode);
    fs.writeFileSync(path.join(DIR, nama), png);
  }
  return true;
}

module.exports = { tulisIkonStatis, ikonDariLogo };

/* --- Bila dijalankan langsung dari CLI: ambil logo dari database --- */
if (require.main === module) {
  (async () => {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT nilai FROM pengaturan WHERE kunci = 'logo_data'").get();
    const m = row && row.nilai ? String(row.nilai).match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i) : null;
    if (!m) {
      console.log('Tidak ada logo kustom di database — ikon statis bawaan dibiarkan apa adanya.');
      return;
    }
    await tulisIkonStatis(Buffer.from(m[2], 'base64'));
    console.log('Ikon statis disinkronkan dengan logo website:');
    for (const f of ['icon-192.png', 'icon-512.png', 'maskable-512.png']) {
      const b = fs.readFileSync(path.join(DIR, f));
      console.log('  ' + f, b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), b.length + ' bytes');
    }
  })().catch((e) => { console.error('Gagal sinkron ikon:', e.message); process.exit(1); });
}
