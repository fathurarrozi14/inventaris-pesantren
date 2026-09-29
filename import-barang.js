'use strict';
/* ============================================================
   Deteksi otomatis untuk IMPOR EXCEL inventaris barang:
   1) Kategori  -> ditebak dari KATA KUNCI pada nama barang
   2) Pengkodean aset (Golongan / Bidang / Sub) -> dihitung dari
      kata kunci nama barang + lokasi, memakai data lib.PENGKODEAN
   ============================================================ */
const lib = require('./lib');

/* ---- 1. KATEGORI (urutan penting: yang lebih spesifik dicek dulu) ---- */
const RULES_KATEGORI = [
  ['Perlengkapan Ibadah', ['sajadah', 'karpet', 'al-quran', 'al quran', 'alquran', 'quran', 'juz amma', 'tafsir', 'mukena', 'mukenah', 'sarung', 'mimbar', 'bedug', 'kitab', 'tasbih', 'rukuh', 'mukena', 'hijab', 'sajadah', 'tempat wudhu', 'kran wudhu']],
  ['Perlengkapan Dapur', ['panci', 'wajan', 'penggorengan', 'piring', 'gelas', 'sendok', 'garpu', 'mangkuk', 'kompor', 'tabung gas', 'gas elpiji', 'termos', 'teko', 'kendi', 'baskom', 'talenan', 'pisau', 'rice cooker', 'magic com', 'dispenser', 'kulkas', 'freezer', 'meja makan', 'dandang', 'sutil', 'tampah']],
  ['Perlengkapan Sanitasi', ['sapu', 'pel lantai', 'pengki', 'tempat sampah', 'gerobak sampah', 'tissue', 'tisu', 'sabun', 'keran', 'kran', 'ember', 'sikat', 'gayung', 'shower', 'handuk', 'keset', 'sekop', 'selang', 'bak air', 'wastafel', 'westafel', 'kemoceng', 'pengharum', 'pembersih', 'kloset', 'jet washer', 'pengering tangan']],
  ['Perlengkapan Olahraga', ['bola', 'raket', 'net ', 'gawang', 'ring basket', 'matras', 'skipping', 'shuttlecock', 'bet ', 'meja pingpong', 'tenis meja', 'pompa bola']],
  ['Elektronik', ['proyektor', 'projektor', 'laptop', 'komputer', 'pc ', 'printer', 'monitor', 'televisi', 'tv ', 'sound', 'speaker', 'microphone', 'mic ', 'amplifier', 'mixer', 'kipas', ' ac ', 'ac ', 'air conditioner', 'cctv', 'mesin', 'stabilizer', 'ups', 'scanner', 'keyboard', 'mouse', 'hard disk', 'router', 'wifi', 'access point', 'genset', 'pompa air', 'bor ', 'gerinda', 'vacuum', 'vacum', 'charger', 'power supply', 'remote', 'kabel', 'bel listrik', 'alarm', 'server', 'proyektor']],
  ['Perlengkapan Kelas', ['papan tulis', 'whiteboard', 'spidol', 'penghapus papan', 'meja belajar', 'kursi plastik', 'kursi lipat', 'meja lipat', 'meja santri', 'kursi santri', 'bangku sekolah', 'papan tulis']],
  ['Furniture', ['meja', 'kursi', 'lemari', 'rak ', 'sofa', 'bangku', 'kabinet', 'buffet', 'bufet', 'nakas', 'tempat tidur', 'springbed', 'spring bed', 'kasur', 'ottoman', 'meja rias', 'cermin', 'lemari arsip', 'loker', 'sekat']],
  ['Perlengkapan Kantor', ['atk', 'alat tulis', 'pulpen', 'pena ', 'pensil', 'stapler', 'ordner', 'map ', 'arsip', 'tinta', 'kertas', 'amplop', 'lakban', 'selotip', 'gunting', 'cutter', 'lem ', 'stempel', 'bantalan', 'buku administrasi', 'papan jadwal']]
];
const KATEGORI_DEFAULT = 'Perlengkapan Kantor';

/* Tebak kategori dari nama barang (fallback: 'Perlengkapan Kantor') */
function tebakKategori(nama) {
  const s = ' ' + String(nama || '').toLowerCase() + ' ';
  for (const [kat, keys] of RULES_KATEGORI) {
    if (keys.some((k) => s.includes(k))) return kat;
  }
  return KATEGORI_DEFAULT;
}

/* ---- 2. GOLONGAN dari kategori ---- */
const GOLONGAN_DARI_KATEGORI = {
  'Elektronik': '03 PERALATAN',
  'Furniture': '04 PERLENGKAPAN',
  'Perlengkapan Kelas': '04 PERLENGKAPAN',
  'Perlengkapan Kantor': '04 PERLENGKAPAN',
  'Perlengkapan Ibadah': '04 PERLENGKAPAN',
  'Perlengkapan Sanitasi': '04 PERLENGKAPAN',
  'Perlengkapan Dapur': '04 PERLENGKAPAN',
  'Perlengkapan Olahraga': '04 PERLENGKAPAN'
};

/* ---- 3. BIDANG + SUB dari kata kunci nama & lokasi ----
   Kata kunci dibuat otomatis dari nama sub di lib.PENGKODEAN, dengan
   kata umum dibuang agar tidak salah cocok. Tambahan sinonim manual
   untuk istilah yang sering dipakai di lapangan. */
const STOPWORDS = new Set(['dan', 'atau', 'area', 'komplek', 'gedung', 'lt', 'lantai', 'ruang', 'kamar', 'sekitar', 'wilayah', 'fasum', 'pusat']);
/* sinonim -> nama sub (kata kunci tambahan) */
const SINONIM = {
  'MASJID': ['masjid', 'mushola', 'musala', 'musholla', 'musollah', 'surau'],
  'AULA & KOLAM RENANG': ['aula', 'kolam renang', 'kolam'],
  'JOGLO': ['joglo'],
  'COTTAGE': ['cottage', 'kotak'],
  'GEDUNG ASRAMA PUTRI SELATAN': ['asrama putri', 'asrama putri selatan'],
  'ASRAMA PUTRA': ['asrama putra'],
  'GEDUNG SEKOLAH PUTRA': ['sekolah putra', 'kelas putra'],
  'GEDUNG SEKOLAH AB': ['sekolah ab'],
  'GEDUNG SEKOLAH C': ['sekolah c'],
  'KANTOR SEKOLAH PUTRI DAN FASUM': ['kantor sekolah'],
  'GEDUNG KANTOR PUSAT': ['kantor pusat', 'kantor'],
  'DAPUR/KANTIN': ['dapur', 'kantin', 'foodcourt'],
  'FOODCOURT DAN LAPANGAN': ['foodcourt', 'lapangan', 'lapangan futsal', 'lapangan basket', 'lapangan voli'],
  'SAQUMART': ['saqumart', 'saqu mart'],
  'SAQU MART': ['saqu mart', 'saqumart'],
  'POS SATPAM': ['satpam', 'pos jaga'],
  'AREA PARKIR': ['parkir'],
  'SMC': ['smc'],
  'LAB KOMPUTER': ['lab komputer', 'laboratorium komputer'],
  'LAB': ['lab '],
  'PANGGUNG TEATER': ['panggung', 'teater'],
  'DAYCARE': ['daycare', 'day care'],
  'GAZEBO': ['gazebo'],
  'STABLE': ['stable', 'kandang'],
  'PENGOLAHAN LIMBAH': ['pengolahan limbah', 'limbah'],
  'IPAL': ['ipal'],
  'IPAL PUTRI': ['ipal putri'],
  'PEMILAHAN SAMPAH': ['pemilahan sampah', 'pemilahan'],
  'MENARA': ['menara'],
  'SD SAHABATQU': ['sd sahabatqu', 'sd'],
  'KB DAN TK ANAKQU': ['kb', 'tk anakqu', 'tk'],
  'MAHASANTRI PUTRI': ['mahasantri putri'],
  'MAHASANTRI PUTRA': ['mahasantri putra'],
  'SAHABATQU NGAJI': ['ngaji', 'sahabatqu ngaji'],
  'BADMINTON': ['badminton', 'bulutangkis'],
  'RUMAH TAHFIDZ DERESAN': ['tahfidz', 'rumah tahfidz'],
  'PONDOK ASATIDZ': ['asatidz', 'pondok asatidz'],
  'GUDANG&FASUM': ['gudang'],
  'MAHASANTRI PUTRA': ['mahasantri putra']
};

function subNama(sub) { return String(sub || '').replace(/^\s*[A-Za-z]\s*[.\-]?\s*/, '').trim(); }

/* Kandidat bidang+sub: { bidangKode, bidangNama, subKode, subLabel, keys[] } */
const KANDIDAT = [];
lib.PENGKODEAN.bidang.forEach((b) => {
  (b.sub || []).forEach((s) => {
    const nama = subNama(s.nama);
    const keys = new Set();
    // kata kunci otomatis dari nama sub (panjang >= 3, bukan stopword)
    nama.toLowerCase().split(/[^a-z0-9]+/).forEach((w) => {
      if (w.length >= 3 && !STOPWORDS.has(w)) keys.add(w);
    });
    // frasa lengkap juga jadi kata kunci
    if (nama.length >= 4) keys.add(nama.toLowerCase());
    (SINONIM[nama.toUpperCase()] || []).forEach((k) => keys.add(k));
    KANDIDAT.push({
      bidangKode: b.kode, bidangNama: b.nama, subKode: s.kode,
      subLabel: s.kode + '. ' + s.nama, keys: [...keys]
    });
  });
});

/* Cari sub yang paling cocok dari teks (nama + lokasi). */
function tebakBidangSub(nama, lokasi) {
  const teks = (' ' + String(nama || '') + ' ' + String(lokasi || '') + ' ').toLowerCase();
  let best = null, bestScore = 0;
  for (const k of KANDIDAT) {
    let score = 0;
    for (const key of k.keys) {
      if (!key) continue;
      if (teks.includes(key)) score += key.includes(' ') ? 3 : key.length; // frasa lebih kuat
    }
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return { kandidat: best, score: bestScore };
}

/* Hasil deteksi lengkap untuk satu baris impor. */
function deteksiBaris(nama, lokasi) {
  const kategori = tebakKategori(nama);
  const golongan = GOLONGAN_DARI_KATEGORI[kategori] || '';
  const { kandidat } = tebakBidangSub(nama, lokasi);
  return {
    kategori,
    golongan,
    bidang_aset: kandidat ? (kandidat.bidangKode + ' ' + kandidat.bidangNama) : '',
    kode_aset: kandidat ? kandidat.subLabel : ''
  };
}

module.exports = { tebakKategori, tebakBidangSub, deteksiBaris, RULES_KATEGORI };
