'use strict';
const crypto = require('crypto');

/* ---------------- Password (scrypt) ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const test = crypto.scryptSync(String(pw), salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
  } catch {
    return false;
  }
}

/* ---------------- HTML escape ---------------- */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------------- Labels & badge colors ---------------- */
const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', santri: 'Santri/Guru' };

const KATEGORI_LABEL = {
  kendaraan: 'Service / Perbaikan',
  elektronik: 'Service Barang',
  sarana: 'Perawatan Sarana'
};
function kategoriLabel(k) {
  return KATEGORI_LABEL[k] || k || '—';
}

const STATUS_LABEL = {
  pinjam_ruangan: { pending: 'Menunggu', disetujui: 'Disetujui', ditolak: 'Ditolak', selesai: 'Selesai', dibatalkan: 'Dibatalkan' },
  pinjam_barang:  { pending: 'Menunggu', disetujui: 'Dipinjam', ditolak: 'Ditolak', dikembalikan: 'Dikembalikan', dibatalkan: 'Dibatalkan' },
  maintenance:    { dilaporkan: 'Dilaporkan', diperbaiki: 'Sedang Diperbaiki', selesai: 'Selesai' },
  ruangan:        { tersedia: 'Tersedia', dipakai: 'Dipakai', maintenance: 'Maintenance' }
};

const BADGE_COLOR = {
  pending: 'amber', disetujui: 'green', dipinjam: 'violet', ditolak: 'red',
  selesai: 'sky', dikembalikan: 'teal', dibatalkan: 'slate',
  dilaporkan: 'orange', diperbaiki: 'cyan',
  tersedia: 'green', dipakai: 'amber', maintenance: 'red'
};

function statusLabel(status, ctx) {
  const map = STATUS_LABEL[ctx] || STATUS_LABEL.pinjam_ruangan;
  return map[status] || status;
}
function badgeColor(status, ctx) {
  if (ctx === 'barang' && status === 'disetujui') return 'violet';
  return BADGE_COLOR[status] || 'slate';
}

/* ---------------- Date & currency ---------------- */
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, dd] = String(d).split('-').map(Number);
  if (!y || !m || !dd) return String(d);
  return `${HARI[new Date(y, m - 1, dd).getDay()]}, ${dd} ${BULAN[m - 1]} ${y}`;
}
function fmtDateShort(d) {
  if (!d) return '—';
  const [y, m, dd] = String(d).split('-').map(Number);
  if (!y || !m || !dd) return String(d);
  return `${dd} ${BULAN[m - 1].slice(0, 3)} ${y}`;
}
function fmtIDR(n) {
  const v = Number(n || 0);
  return 'Rp ' + v.toLocaleString('id-ID');
}
function today() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function addDays(offset) {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/* ---------------- Relative URL helper ----------------
 * Semua link memakai path relatif supaya aplikasi tetap berfungsi
 * ketika dipublikasikan di bawah subpath (https://user.vibecoder.co.id/<slug>/).
 */
function rel(fromPath, to) {
  const depth = String(fromPath).split('/').filter(Boolean).length;
  const prefix = depth <= 1 ? '' : '../'.repeat(depth - 1);
  return prefix + to;
}

/* ---------------- Pengkodean Aset (Golongan · Bidang · Sub-bidang) ----------------
   Skema kode aset Pesantren SahabatQu:
   Kode penuh = GOLONGAN.BIDANG.SUB  (cth: 02.01.B = Bangunan · Deresan · SD SahabatQu)
   Disimpan per kolom: golongan='02 BANGUNAN', bidang_aset='01 DERESAN', kode_aset='B. SD SAHABATQU' */
const PENGKODEAN = {
  golongan: [
    { kode: '01', nama: 'TANAH' },
    { kode: '02', nama: 'BANGUNAN' },
    { kode: '03', nama: 'PERALATAN' },
    { kode: '04', nama: 'PERLENGKAPAN' }
  ],
  bidang: [
    { kode: '01', nama: 'DERESAN', sub: [
      { kode: 'A', nama: 'MENARA' },
      { kode: 'B', nama: 'SD SAHABATQU' },
      { kode: 'C', nama: 'KB DAN TK ANAKQU' },
      { kode: 'D', nama: 'MAHASANTRI PUTRI' },
      { kode: 'E', nama: 'MAHASANTRI PUTRA' },
      { kode: 'F', nama: 'SAHABATQU NGAJI' },
      { kode: 'G', nama: 'BADMINTON' },
      { kode: 'H', nama: 'RUMAH TAHFIDZ DERESAN' }
    ]},
    { kode: '02', nama: 'PAKEM PUTRI', sub: [
      { kode: 'A', nama: 'KOMPLEK INTENSIF' },
      { kode: 'B', nama: 'JOGLO' },
      { kode: 'C', nama: 'COTTAGE' },
      { kode: 'D', nama: 'GEDUNG SEKOLAH AB' },
      { kode: 'E', nama: 'GEDUNG ASRAMA PUTRI SELATAN' },
      { kode: 'F', nama: 'DAPUR/KANTIN' },
      { kode: 'G', nama: 'GEDUNG SEKOLAH C' },
      { kode: 'H', nama: 'AULA & KOLAM RENANG' },
      { kode: 'I', nama: 'SMC' },
      { kode: 'J', nama: 'GEDUNG KANTOR PUSAT' },
      { kode: 'K', nama: 'PANGGUNG TEATER' },
      { kode: 'L', nama: 'SAQUMART' },
      { kode: 'M', nama: 'GEDUNG KAMAR MANDI' },
      { kode: 'N', nama: 'KANTOR SEKOLAH PUTRI DAN FASUM' },
      { kode: 'O', nama: 'DAYCARE' },
      { kode: 'P', nama: 'STABLE' },
      { kode: 'Q', nama: 'PENGOLAHAN LIMBAH' },
      { kode: 'R', nama: 'GAZEBO' }
    ]},
    { kode: '03', nama: 'PAKEM PUTRA', sub: [
      { kode: 'A', nama: 'GEDUNG SEKOLAH PUTRA' },
      { kode: 'B', nama: 'KOLAM RENANG' },
      { kode: 'C', nama: 'ASRAMA PUTRA' },
      { kode: 'D', nama: 'POS SATPAM' },
      { kode: 'E', nama: 'SAQU MART' },
      { kode: 'F', nama: 'FOODCOURT DAN LAPANGAN' },
      { kode: 'G', nama: 'MASJID' },
      { kode: 'H', nama: 'IPAL' },
      { kode: 'I', nama: 'AREA PARKIR' }
    ]},
    { kode: '04', nama: 'SEWA', sub: [
      { kode: 'A', nama: 'PONDOK ASATIDZ' },
      { kode: 'B', nama: 'GUDANG&FASUM' },
      { kode: 'C', nama: 'STABLE' },
      { kode: 'D', nama: 'PEMILAHAN SAMPAH' },
      { kode: 'E', nama: 'IPAL PUTRI' }
    ]}
  ]
};
/* Kode penuh dari label tersimpan: '02 BANGUNAN' + '01 DERESAN' + 'B. SD SAHABATQU' -> '02.01.B' */
function kodeAset(golongan, bidang, sub) {
  const g = (String(golongan || '').match(/^\d{2}/) || [''])[0];
  const b = (String(bidang || '').match(/^\d{2}/) || [''])[0];
  const m = String(sub || '').match(/^\s*([A-Za-z])\s*[.\-]?\s*/);
  const s = m ? m[1].toUpperCase() : '';
  return [g, b, s].filter(Boolean).join('.');
}
/* Nama sub dari label 'B. SD SAHABATQU' -> 'SD SAHABATQU' */
function subNama(sub) {
  return String(sub || '').replace(/^\s*[A-Za-z]\s*[.\-]?\s*/, '');
}

/* ---------------- Barcode Code128 (subset B) -> SVG ---------------- */
const CODE128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213', // 0-9
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132', // 10-19
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211', // 20-29
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313', // 30-39
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331', // 40-49
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111', // 50-59
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214', // 60-69
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111', // 70-79
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141', // 80-89
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141', // 90-99
  '114131','311141','411131', // 100-102
  '211412','211214','211232', // 103 StartA, 104 StartB, 105 StartC
  '2331112'                    // 106 Stop
];
function code128b(text) {
  const str = String(text == null ? '' : text);
  const values = [];
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126) values.push(c - 32); // subset B
  }
  if (!values.length) return '';
  let checksum = 104; // Start B
  values.forEach((v, i) => { checksum += v * (i + 1); });
  checksum %= 103;
  const seq = [104, ...values, checksum, 106];
  let x = 0;
  let bar = true;
  const bars = [];
  for (const v of seq) {
    const pat = String(CODE128[v]);
    for (const d of pat) {
      const w = Number(d);
      if (bar) bars.push([x, w]);
      x += w;
      bar = !bar;
    }
  }
  const height = 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height}" width="${x}" height="${height}" shape-rendering="crispEdges" aria-hidden="true">` +
    bars.map(([bx, w]) => `<rect x="${bx}" y="0" width="${w}" height="${height}"/>`).join('') +
    `</svg>`;
}
function kodeStiker(id) {
  return 'SBQ-' + String(Number(id) || 0).padStart(5, '0');
}
function kodeStikerRuangan(id) {
  return 'RK-' + String(Number(id) || 0).padStart(5, '0');
}
/* Kode stiker otomatis = kode aset dari menu inventaris (golongan.bidang.sub + nama + bulanTahun + urutan).
   Cukup Golongan+Bidang terisi untuk memakai format kode aset (Sub kosong memakai '-');
   fallback SBQ-xxxxx / RK-xxxxx hanya bila barang/ruangan belum punya data aset sama sekali. */
function kodeStikerTampil(obj, id, tipe) {
  const g = String(obj && obj.golongan || '').match(/^\d{2}/);
  const b = String(obj && obj.bidang_aset || '').match(/^\d{2}/);
  if (g && b) return kodeQR(obj, id);
  return tipe === 'ruangan' ? kodeStikerRuangan(id) : kodeStiker(id);
}
/* Kode QR stiker: Golongan(2) - Bidang(2) - Kode(huruf) - Nama - BulanTahun - Urutan
   contoh: 0303A Projektor 102025 01 */
function kodeQR(obj, urutanId) {
  const g = String(obj.golongan || '').slice(0, 2).padEnd(2, '0');
  const b = String(obj.bidang_aset || '').slice(0, 2).padEnd(2, '0');
  const k = String(obj.kode_aset || '').slice(0, 1) || '-';
  const nama = String(obj.nama || '').trim();
  const now = new Date();
  const bln = String(now.getMonth() + 1).padStart(2, '0');
  const thn = now.getFullYear();
  const urut = String(Number(urutanId) || 0).padStart(2, '0');
  return g + b + k + ' ' + nama + ' ' + bln + thn + ' ' + urut;
}

/* ---------------- CRC32 & ZIP (metode STORE, tanpa dependensi) ---------------- */
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) { // files: [{name, data}] -> Buffer ZIP (STORE)
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);
    central.push({ nameBuf, crc, len: data.length, offset });
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.len, 20); ch.writeUInt32LE(c.len, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.nameBuf);
    offset += ch.length + c.nameBuf.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}
function zipRead(buf) { // baca entri ZIP metode STORE -> {nama: Buffer}
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const comp = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (method === 0) out[name] = Buffer.from(buf.subarray(lho + 30 + nameLen, lho + 30 + nameLen + comp));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------------- Info perangkat dari User-Agent ---------------- */
function parseUserAgent(ua) {
  const s = String(ua || ''), l = s.toLowerCase();
  let os = '—', device = 'Desktop';
  if (/windows/.test(l)) os = 'Windows';
  else if (/android/.test(l)) { os = 'Android'; device = 'HP / Tablet'; }
  else if (/iphone|ipad|ipod/.test(l)) { os = 'iOS'; device = 'HP / Tablet'; }
  else if (/mac os/.test(l)) os = 'macOS';
  else if (/linux/.test(l)) os = 'Linux';
  let browser = '—';
  if (/edg\//.test(l)) browser = 'Edge';
  else if (/opr\//.test(l)) browser = 'Opera';
  else if (/chrome\//.test(l)) browser = 'Chrome';
  else if (/firefox\//.test(l)) browser = 'Firefox';
  else if (/safari\//.test(l)) browser = 'Safari';
  else if (/miuibrowser/.test(l)) browser = 'Mi Browser';
  return { os, browser, device };
}
function phoneToWa(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (d.startsWith('62')) return d;
  return '62' + d;
}

/* ---------------- CSRF ---------------- */
function csrfToken(req) {
  if (!req.session._csrf) req.session._csrf = crypto.randomBytes(16).toString('hex');
  return req.session._csrf;
}
function csrfCheck(req, res) {
  const ok = req.body._csrf && req.body._csrf === req.session._csrf;
  if (!ok) {
    res.status(403).send('Token keamanan tidak valid. Silakan muat ulang halaman.');
    return false;
  }
  return true;
}

/* ---------------- Session store berbasis SQLite ---------------- */
const session = require('express-session');
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 864e5;
      this.db.prepare(`INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`)
        .run(sid, JSON.stringify(sess), exp);
      cb();
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(); }
    catch (e) { cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = {
  hashPassword, verifyPassword, esc,
  ROLE_LABEL, STATUS_LABEL, BADGE_COLOR, statusLabel, badgeColor,
  KATEGORI_LABEL, kategoriLabel,
  fmtDate, fmtDateShort, fmtIDR, today, addDays,
  code128b, kodeStiker, kodeStikerRuangan, kodeStikerTampil, kodeQR,
  PENGKODEAN, kodeAset, subNama,
  crc32, zipStore, zipRead, parseUserAgent, phoneToWa,
  rel, csrfToken, csrfCheck, SqliteStore
};
