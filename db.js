'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const lib = require('./lib');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'), { timeout: 8000 });
// Pragmas dibungkus try/catch: bila file DB sedang terkunci proses lain saat deploy,
// pragma tidak boleh menggagalkan boot (instance baru tetap bisa naik).
try { db.pragma('busy_timeout = 5000'); } catch (e) { console.error('(non-fatal) busy_timeout:', e.message); }
try { db.pragma('journal_mode = WAL'); } catch (e) { console.error('(non-fatal) WAL:', e.message); }
try { db.pragma('foreign_keys = ON'); } catch (e) { console.error('(non-fatal) FK:', e.message); }

try {
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nama          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'santri' CHECK (role IN ('admin','operator','santri')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ruangan (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nama       TEXT NOT NULL,
  lokasi     TEXT NOT NULL DEFAULT '',
  kapasitas  INTEGER NOT NULL DEFAULT 0,
  deskripsi  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS barang (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nama             TEXT NOT NULL,
  kategori         TEXT NOT NULL DEFAULT '',
  jumlah_total     INTEGER NOT NULL DEFAULT 0,
  jumlah_tersedia  INTEGER NOT NULL DEFAULT 0,
  satuan           TEXT NOT NULL DEFAULT 'unit',
  lokasi           TEXT NOT NULL DEFAULT '',
  deskripsi        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pinjam_ruangan (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ruangan_id      INTEGER NOT NULL REFERENCES ruangan(id),
  peminjam_id     INTEGER NOT NULL REFERENCES users(id),
  keperluan       TEXT NOT NULL,
  tanggal_mulai   TEXT NOT NULL,
  tanggal_selesai TEXT NOT NULL,
  jam_mulai       TEXT NOT NULL DEFAULT '08:00',
  jam_selesai     TEXT NOT NULL DEFAULT '17:00',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','disetujui','ditolak','selesai','dibatalkan')),
  catatan         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pinjam_barang (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barang_id       INTEGER NOT NULL REFERENCES barang(id),
  peminjam_id     INTEGER NOT NULL REFERENCES users(id),
  jumlah          INTEGER NOT NULL DEFAULT 1,
  keperluan       TEXT NOT NULL,
  tanggal_pinjam  TEXT NOT NULL,
  tanggal_kembali TEXT NOT NULL,
  jam_mulai       TEXT NOT NULL DEFAULT '08:00',
  jam_selesai     TEXT NOT NULL DEFAULT '17:00',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','disetujui','ditolak','dikembalikan','dibatalkan')),
  catatan         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS maintenance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  objek_tipe     TEXT NOT NULL DEFAULT 'barang' CHECK (objek_tipe IN ('barang','ruangan')),
  barang_id      INTEGER REFERENCES barang(id),
  ruangan_id     INTEGER REFERENCES ruangan(id),
  objek_nama     TEXT NOT NULL DEFAULT '',
  kategori       TEXT NOT NULL DEFAULT 'sarana'
                 CHECK (kategori IN ('kendaraan','elektronik','sarana')),
  pelapor_id     INTEGER NOT NULL REFERENCES users(id),
  judul          TEXT NOT NULL,
  deskripsi      TEXT NOT NULL DEFAULT '',
  tingkat        TEXT NOT NULL DEFAULT 'ringan' CHECK (tingkat IN ('ringan','sedang','berat')),
  status         TEXT NOT NULL DEFAULT 'dilaporkan'
                 CHECK (status IN ('dilaporkan','diperbaiki','selesai')),
  penanggung_jawab TEXT NOT NULL DEFAULT '',
  estimasi_biaya REAL NOT NULL DEFAULT 0,
  biaya_aktual   REAL NOT NULL DEFAULT 0,
  tanggal_lapor  TEXT NOT NULL,
  tanggal_selesai TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS riwayat_perbaikan (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
  tanggal        TEXT NOT NULL,
  keterangan     TEXT NOT NULL,
  biaya          REAL NOT NULL DEFAULT 0,
  pelaksana      TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pengaturan (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  kunci TEXT NOT NULL UNIQUE,
  nilai TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT NOT NULL DEFAULT '',
  nama        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  aksi        TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  browser     TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  waktu       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS jadwal (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  objek_nama TEXT NOT NULL DEFAULT '',
  jenis      TEXT NOT NULL DEFAULT 'servis' CHECK (jenis IN ('servis','pajak_tahunan','pajak_bulanan')),
  tanggal    TEXT NOT NULL,
  keterangan TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','selesai')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bidang (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS kategori_barang (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS piket_sheets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nama       TEXT NOT NULL DEFAULT '',
  bulan      TEXT NOT NULL DEFAULT '',
  area       TEXT NOT NULL DEFAULT '',
  hari_libur TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS piket_tasks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL REFERENCES piket_sheets(id) ON DELETE CASCADE,
  jam      TEXT NOT NULL DEFAULT '',
  tugas    TEXT NOT NULL DEFAULT '',
  urutan   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS piket_checks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id INTEGER NOT NULL REFERENCES piket_sheets(id) ON DELETE CASCADE,
  task_id  INTEGER NOT NULL REFERENCES piket_tasks(id) ON DELETE CASCADE,
  hari     INTEGER NOT NULL,
  checked  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_id, hari)
);

CREATE TABLE IF NOT EXISTS surat_serah_terima (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nomor            TEXT NOT NULL DEFAULT '',
  tanggal          TEXT NOT NULL,
  tempat           TEXT NOT NULL DEFAULT '',
  penyerah_nama    TEXT NOT NULL DEFAULT '',
  penyerah_jabatan TEXT NOT NULL DEFAULT '',
  penerima_nama    TEXT NOT NULL DEFAULT '',
  penerima_jabatan TEXT NOT NULL DEFAULT '',
  catatan          TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS surat_serah_terima_item (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  surat_id   INTEGER NOT NULL REFERENCES surat_serah_terima(id) ON DELETE CASCADE,
  nama       TEXT NOT NULL,
  jumlah     REAL NOT NULL DEFAULT 1,
  satuan     TEXT NOT NULL DEFAULT 'unit',
  keterangan TEXT NOT NULL DEFAULT ''
);

/* ================= PEMINJAMAN MOBIL / KENDARAAN ================= */
CREATE TABLE IF NOT EXISTS mobil (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nama       TEXT NOT NULL,
  plat       TEXT NOT NULL DEFAULT '',
  jenis      TEXT NOT NULL DEFAULT '',
  kapasitas  INTEGER NOT NULL DEFAULT 0,
  keterangan TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','maintenance','nonaktif')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pinjam_mobil (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mobil_id         INTEGER NOT NULL REFERENCES mobil(id),
  peminjam_id      INTEGER NOT NULL REFERENCES users(id),
  nama_peminjam    TEXT NOT NULL DEFAULT '',
  nomor_peminjam   TEXT NOT NULL DEFAULT '',
  jumlah_penumpang INTEGER NOT NULL DEFAULT 0,
  keperluan        TEXT NOT NULL,
  tanggal_mulai    TEXT NOT NULL,
  tanggal_selesai  TEXT NOT NULL,
  jam_mulai        TEXT NOT NULL DEFAULT '08:00',
  jam_selesai      TEXT NOT NULL DEFAULT '17:00',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','disetujui','ditolak','selesai','dibatalkan')),
  catatan          TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS piket (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bulan      TEXT NOT NULL DEFAULT '',      -- format YYYY-MM
  judul      TEXT NOT NULL DEFAULT '',
  keterangan TEXT NOT NULL DEFAULT '',
  isi        TEXT NOT NULL DEFAULT '',      -- baris per petugas/area (satu baris = satu entri)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pr_ruangan ON pinjam_ruangan(ruangan_id, status);
CREATE INDEX IF NOT EXISTS idx_pb_barang ON pinjam_barang(barang_id, status);
CREATE INDEX IF NOT EXISTS idx_pm_mobil ON pinjam_mobil(mobil_id, status);
CREATE INDEX IF NOT EXISTS idx_m_status ON maintenance(status);
CREATE INDEX IF NOT EXISTS idx_rp_maintenance ON riwayat_perbaikan(maintenance_id);
`);
} catch (e) {
  console.error('(non-fatal) init skema gagal (DB mungkin terkunci saat deploy):', e.message);
}

/* ---------------- Migrasi ringan (aman dijalankan tiap boot) ----------------
   Tambahkan kolom sub layanan maintenance bila belum ada (database lama),
   lalu petakan data lama: laporan barang -> elektronik, ruangan -> sarana.
   Dibungkus retry: bila file DB sedang terkunci instance lain saat deploy,
   coba ulang beberapa kali sebelum menyerah. */
function migrateMaintenanceOnce() {
  const cols = db.prepare('PRAGMA table_info(maintenance)').all().map((c) => c.name);
  if (!cols.includes('kategori')) {
    db.exec(`ALTER TABLE maintenance ADD COLUMN kategori TEXT NOT NULL DEFAULT 'sarana'`);
  }
  if (!cols.includes('objek_nama')) {
    db.exec(`ALTER TABLE maintenance ADD COLUMN objek_nama TEXT NOT NULL DEFAULT ''`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_m_kategori ON maintenance(kategori)');
  // Data lama ber-objek barang dianggap servis elektronik (idempoten)
  db.prepare(`UPDATE maintenance SET kategori = 'elektronik' WHERE objek_tipe = 'barang' AND kategori = 'sarana'`).run();
}
(function migrateMaintenance() {
  const waits = [0, 1000, 3000]; // ms jeda antar percobaan
  let lastErr = null;
  for (let i = 0; i < waits.length; i++) {
    if (i > 0) {
      const t0 = Date.now();
      while (Date.now() - t0 < waits[i]) { /* sleep sinkron singkat saat boot */ }
    }
    try {
      migrateMaintenanceOnce();
      return;
    } catch (e) {
      lastErr = e;
      if (!/SQLITE_BUSY/.test(String(e && e.message))) throw e;
    }
  }
  console.error('Migrasi maintenance gagal (DB terkunci):', lastErr && lastErr.message);
  throw lastErr;
})();

/* Tambahkan kolom jam peminjaman bila belum ada (database lama) */
(function migrateJamPeminjaman() {
  try {
    for (const t of ['pinjam_ruangan', 'pinjam_barang']) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      if (!cols.includes('jam_mulai')) db.exec(`ALTER TABLE ${t} ADD COLUMN jam_mulai TEXT NOT NULL DEFAULT '08:00'`);
      if (!cols.includes('jam_selesai')) db.exec(`ALTER TABLE ${t} ADD COLUMN jam_selesai TEXT NOT NULL DEFAULT '17:00'`);
    }
  } catch (e) { console.error('(non-fatal) migrasi jam gagal:', e.message); }
})();

/* Tambahkan kolom jadwal service berikutnya pada maintenance (pengingat service kendaraan) */
(function migrateServiceSelanjutnya() {
  try {
    const cols = db.prepare('PRAGMA table_info(maintenance)').all().map((c) => c.name);
    if (!cols.includes('service_selanjutnya')) {
      db.exec(`ALTER TABLE maintenance ADD COLUMN service_selanjutnya TEXT NOT NULL DEFAULT ''`);
    }
  } catch (e) { console.error('(non-fatal) migrasi service_selanjutnya gagal:', e.message); }
})();

/* Kolom foto barang (upload foto untuk stiker/scanner) */
(function migrateFotoBarang() {
  try {
    const cols = db.prepare('PRAGMA table_info(barang)').all().map((c) => c.name);
    if (!cols.includes('foto')) {
      db.exec(`ALTER TABLE barang ADD COLUMN foto TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.includes('seri')) {
      db.exec(`ALTER TABLE barang ADD COLUMN seri TEXT NOT NULL DEFAULT ''`);
    }
  } catch (e) { console.error('(non-fatal) migrasi foto/seri gagal:', e.message); }
})();

/* Kolom nomor peminjam & bidang/unit pada peminjaman ruangan */
(function migratePeminjam() {
  try {
    const cols = db.prepare('PRAGMA table_info(pinjam_ruangan)').all().map((c) => c.name);
    if (!cols.includes('nomor_peminjam')) db.exec(`ALTER TABLE pinjam_ruangan ADD COLUMN nomor_peminjam TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('bidang')) db.exec(`ALTER TABLE pinjam_ruangan ADD COLUMN bidang TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi nomor_peminjam/bidang gagal:', e.message); }
})();

/* Kolom nama peminjam (ruangan) + nama & nomor peminjam (barang) */
(function migrateNamaPeminjam() {
  try {
    const colsR = db.prepare('PRAGMA table_info(pinjam_ruangan)').all().map((c) => c.name);
    if (!colsR.includes('nama_peminjam')) db.exec(`ALTER TABLE pinjam_ruangan ADD COLUMN nama_peminjam TEXT NOT NULL DEFAULT ''`);
    if (!colsR.includes('jumlah_peserta')) db.exec(`ALTER TABLE pinjam_ruangan ADD COLUMN jumlah_peserta INTEGER NOT NULL DEFAULT 0`);
    const colsB = db.prepare('PRAGMA table_info(pinjam_barang)').all().map((c) => c.name);
    if (!colsB.includes('nama_peminjam')) db.exec(`ALTER TABLE pinjam_barang ADD COLUMN nama_peminjam TEXT NOT NULL DEFAULT ''`);
    if (!colsB.includes('nomor_peminjam')) db.exec(`ALTER TABLE pinjam_barang ADD COLUMN nomor_peminjam TEXT NOT NULL DEFAULT ''`);
    // Konfirmasi WhatsApp peminjaman MOBIL (pengaju wajib chat WA dulu, baru admin menyetujui)
    const colsM = db.prepare('PRAGMA table_info(pinjam_mobil)').all().map((c) => c.name);
    if (!colsM.includes('wa_konfirmasi')) db.exec(`ALTER TABLE pinjam_mobil ADD COLUMN wa_konfirmasi INTEGER NOT NULL DEFAULT 0`);
  } catch (e) { console.error('(non-fatal) migrasi nama/nomor peminjam gagal:', e.message); }
})();

/* Kolom jenis_list pada jadwal (multi pilihan jenis jadwal) */
(function migrateJadwal() {
  try {
    const cols = db.prepare('PRAGMA table_info(jadwal)').all().map((c) => c.name);
    if (!cols.includes('jenis_list')) db.exec(`ALTER TABLE jadwal ADD COLUMN jenis_list TEXT NOT NULL DEFAULT ''`);
    // Tanggal realisasi (otomatis terisi saat "Tandai Selesai")
    if (!cols.includes('tanggal_selesai')) db.exec(`ALTER TABLE jadwal ADD COLUMN tanggal_selesai TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi jenis_list gagal:', e.message); }
})();

/* Pengkodean aset pada barang (golongan/bidang/kode aset — skema sama dgn ruangan) */
(function migrateKodeAsetBarang() {
  try {
    const cols = db.prepare('PRAGMA table_info(barang)').all().map((c) => c.name);
    if (!cols.includes('golongan')) db.exec(`ALTER TABLE barang ADD COLUMN golongan TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('bidang_aset')) db.exec(`ALTER TABLE barang ADD COLUMN bidang_aset TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('kode_aset')) db.exec(`ALTER TABLE barang ADD COLUMN kode_aset TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi kode aset barang gagal:', e.message); }
})();

/* Kolom tanggal/jam update barang (untuk stiker & form edit) */
(function migrateBarangWaktu() {
  try {
    const cols = db.prepare('PRAGMA table_info(barang)').all().map((c) => c.name);
    if (!cols.includes('tgl_update')) db.exec(`ALTER TABLE barang ADD COLUMN tgl_update TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('jam_update')) db.exec(`ALTER TABLE barang ADD COLUMN jam_update TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi tgl/jam gagal:', e.message); }
})();

/* Kolom golongan/bidang/kode pada ruangan (dropdown aset) */
(function migrateRuanganAset() {
  try {
    const cols = db.prepare('PRAGMA table_info(ruangan)').all().map((c) => c.name);
    if (!cols.includes('golongan')) db.exec(`ALTER TABLE ruangan ADD COLUMN golongan TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('bidang_aset')) db.exec(`ALTER TABLE ruangan ADD COLUMN bidang_aset TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('kode_aset')) db.exec(`ALTER TABLE ruangan ADD COLUMN kode_aset TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi golongan/bidang/kode gagal:', e.message); }
})();

/* Kolom golongan/bidang/kode pada barang (pengkodean stiker) */
(function migrateBarangAset() {
  try {
    const cols = db.prepare('PRAGMA table_info(barang)').all().map((c) => c.name);
    if (!cols.includes('golongan')) db.exec(`ALTER TABLE barang ADD COLUMN golongan TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('bidang_aset')) db.exec(`ALTER TABLE barang ADD COLUMN bidang_aset TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('kode_aset')) db.exec(`ALTER TABLE barang ADD COLUMN kode_aset TEXT NOT NULL DEFAULT ''`);
  } catch (e) { console.error('(non-fatal) migrasi golongan/bidang/kode barang gagal:', e.message); }
})();

/* Normalisasi label pengkodean ruangan lama (huruf kecil) ke skema baru (huruf besar) */
(function normalizeKodeAsetRuangan() {
  try {
    const map = {
      '01 Tanah': '01 TANAH', '02 Bangunan': '02 BANGUNAN',
      '03 Peralatan': '03 PERALATAN', '04 Perlengkapan': '04 PERLENGKAPAN',
      '01 Deresan': '01 DERESAN', '02 Pakem Putri': '02 PAKEM PUTRI',
      '03 Pakem Putra': '03 PAKEM PUTRA', '04 Sewa': '04 SEWA'
    };
    const up = db.prepare('UPDATE ruangan SET golongan = ? WHERE golongan = ?');
    const upb = db.prepare('UPDATE ruangan SET bidang_aset = ? WHERE bidang_aset = ?');
    for (const [lama, baru] of Object.entries(map)) {
      up.run(baru, lama);
      upb.run(baru, lama);
    }
  } catch (e) { console.error('(non-fatal) normalisasi kode aset ruangan gagal:', e.message); }
})();


/* Update label default "Maintenance" -> "Pemeliharaan" pada pengaturan website
   (dibungkus try/catch agar DB yang terkunci saat deploy tidak menggagalkan boot) */
try {
  db.prepare(`UPDATE pengaturan SET nilai = 'Pemeliharaan Sedang Berjalan' WHERE kunci = 'title_maintenance' AND nilai = 'Maintenance Sedang Berjalan'`).run();
} catch (e) { console.error('(non-fatal) update label pengaturan gagal:', e.message); }

/* ---------------- Seed awal (hanya bila tabel kosong, tidak pernah menghapus) ---------------- */
const seedUsers = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT INTO users (username, password_hash, nama, role) VALUES (?,?,?,?)');
  ins.run('admin', lib.hashPassword('admin123'), 'Administrator Pesantren', 'admin');
  ins.run('operator', lib.hashPassword('operator123'), 'Operator Sarana & Prasarana', 'operator');
  ins.run('santri', lib.hashPassword('santri123'), 'Ahmad Fauzi (Santri)', 'santri');
};

const seedRooms = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM ruangan').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT INTO ruangan (nama, lokasi, kapasitas, deskripsi) VALUES (?,?,?,?)');
  const rooms = [
    ['Masjid Al-Hikmah', 'Komplek Utama', 500, 'Masjid utama untuk shalat berjamaah, kajian, dan kegiatan keagamaan'],
    ['Aula Serbaguna', 'Gedung Serbaguna', 300, 'Aula untuk acara besar, wisuda, dan pertemuan'],
    ['Perpustakaan', 'Gedung Pendidikan Lt. 1', 60, 'Koleksi kitab, buku pelajaran, dan literatur islami'],
    ['Lab Komputer', 'Gedung Pendidikan Lt. 2', 40, 'Laboratorium komputer dan multimedia'],
    ['Asrama Putra A', 'Komplek Timur', 100, 'Asrama santri putra'],
    ['Asrama Putri B', 'Komplek Barat', 100, 'Asrama santri putri'],
    ['Kelas 1A', 'Gedung Pendidikan Lt. 1', 30, 'Ruang kelas tahfidz dasar'],
    ['Kelas 2B', 'Gedung Pendidikan Lt. 2', 30, 'Ruang kelas lanjutan'],
    ['Ruang Guru', 'Gedung Pendidikan Lt. 2', 25, 'Ruang kerja dan rapat guru/ustadz'],
    ['Lapangan Olahraga', 'Area Terbuka', 200, 'Lapangan serbaguna di area terbuka']
  ];
  for (const r of rooms) ins.run(...r);
};

const seedItems = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM barang').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT INTO barang (nama, kategori, jumlah_total, jumlah_tersedia, satuan, lokasi, deskripsi) VALUES (?,?,?,?,?,?,?)');
  const items = [
    ['Meja Belajar', 'Perlengkapan Kelas', 60, 60, 'unit', 'Gedung Pendidikan', 'Meja kayu untuk kegiatan belajar'],
    ['Kursi Plastik', 'Perlengkapan Kelas', 120, 120, 'unit', 'Gudang Sarpras', 'Kursi lipat plastik untuk kegiatan'],
    ['Proyektor', 'Elektronik', 5, 3, 'unit', 'Lab Komputer', 'Proyektor untuk pembelajaran dan acara'],
    ['Sound System', 'Elektronik', 2, 2, 'set', 'Aula Serbaguna', 'Sound system untuk acara dan kajian'],
    ['Laptop', 'Elektronik', 4, 4, 'unit', 'Lab Komputer', 'Laptop untuk administrasi dan belajar'],
    ['Kipas Angin', 'Elektronik', 10, 10, 'unit', 'Gudang Sarpras', 'Kipas angin standar'],
    ['Papan Tulis', 'Perlengkapan Kelas', 8, 8, 'unit', 'Gedung Pendidikan', 'Papan tulis whiteboard'],
    ['Karpet Sajadah', 'Perlengkapan Ibadah', 60, 60, 'lembar', 'Gudang Sarpras', 'Karpet sajadah untuk kegiatan ibadah'],
    ["Al-Qur'an", 'Perlengkapan Ibadah', 80, 80, 'eksemplar', 'Masjid Al-Hikmah', "Al-Qur'an untuk kegiatan tahfidz"],
    ['Buku Tafsir', 'Perlengkapan Ibadah', 40, 40, 'eksemplar', 'Perpustakaan', 'Buku tafsir untuk kajian'],
    ['Paket ATK', 'Perlengkapan Kantor', 30, 30, 'paket', 'Ruang Kantor', 'Paket alat tulis kantor'],
    ['Mic Wireless', 'Elektronik', 3, 3, 'unit', 'Aula Serbaguna', 'Microphone wireless untuk acara']
  ];
  for (const it of items) ins.run(...it);
};

const seedTransactions = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM pinjam_ruangan').get().c;
  if (c > 0) return;
  const santri = db.prepare('SELECT id FROM users WHERE username = ?').get('santri');
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  const roomByName = (n) => db.prepare('SELECT id FROM ruangan WHERE nama = ?').get(n);
  const itemByName = (n) => db.prepare('SELECT id FROM barang WHERE nama = ?').get(n);

  const aula = roomByName('Aula Serbaguna');
  const masjid = roomByName('Masjid Al-Hikmah');
  const proyektor = itemByName('Proyektor');
  const karpet = itemByName('Karpet Sajadah');
  const sound = itemByName('Sound System');

  // PENTING (bug deploy): DB lama yang sudah dipakai/diubah user bisa punya pinjam_ruangan kosong
  // tetapi ruangan/barangnya sudah di-rename sehingga data acuan seed tidak ditemukan.
  // Dalam kondisi itu JANGAN menyemai transaksi demo — langsung berhenti agar boot tidak crash.
  if (!santri || !admin || !aula || !masjid || !proyektor || !karpet || !sound) return;

  // Status proyektor konsisten: 2 unit sedang dipinjam
  db.prepare('UPDATE barang SET jumlah_tersedia = 3 WHERE id = ?').run(proyektor.id);

  const insPR = db.prepare(`INSERT INTO pinjam_ruangan (ruangan_id, peminjam_id, keperluan, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai, nomor_peminjam, bidang, status, catatan) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insPR.run(aula.id, santri.id, 'Kajian Kitab Kuning ba\u2019da Maghrib', lib.addDays(-2), lib.addDays(2), '18:00', '21:00', 'S-2026-001', 'Asrama Putra', 'disetujui', 'Kegiatan rutin santri');
  insPR.run(masjid.id, santri.id, "Khataman Al-Qur'an 30 Juz", lib.addDays(-30), lib.addDays(-28), '08:00', '12:00', 'S-2026-002', 'Tahfidz', 'selesai', 'Acara syukuran khataman');
  insPR.run(aula.id, admin.id, 'Rapat koordinasi pengurus', lib.addDays(5), lib.addDays(5), '09:00', '12:00', 'STF-001', 'Kantor', 'pending', '');

  const insPB = db.prepare(`INSERT INTO pinjam_barang (barang_id, peminjam_id, jumlah, keperluan, tanggal_pinjam, tanggal_kembali, jam_mulai, jam_selesai, status, catatan) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insPB.run(proyektor.id, santri.id, 2, 'Pemutaran film islami', lib.addDays(-1), lib.addDays(1), '19:00', '22:00', 'disetujui', '');
  insPB.run(karpet.id, santri.id, 20, 'Peringatan Maulid Nabi', lib.addDays(-20), lib.addDays(-18), '07:00', '17:00', 'dikembalikan', '');

  const insM = db.prepare(`INSERT INTO maintenance (objek_tipe, barang_id, ruangan_id, objek_nama, kategori, pelapor_id, judul, deskripsi, tingkat, status, penanggung_jawab, estimasi_biaya, biaya_aktual, tanggal_lapor, tanggal_selesai) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const m1 = insM.run('ruangan', null, aula.id, '', 'sarana', santri.id, 'AC aula bocor dan berbunyi kasar',
    'AC di ruang aula mengeluarkan air serta bunyi kasar saat dinyalakan.',
    'sedang', 'diperbaiki', 'H. Hasan (Sarpras)', 600000, 450000, lib.addDays(-6), '');
  const m2 = insM.run('barang', sound.id, null, '', 'elektronik', santri.id, 'Sound system berdengung saat volume naik',
    'Speaker utama mengeluarkan dengung ketika volume dinaikkan melebihi setengah.',
    'ringan', 'dilaporkan', '', 0, 0, lib.addDays(-1), '');

  const insR = db.prepare(`INSERT INTO riwayat_perbaikan (maintenance_id, tanggal, keterangan, biaya, pelaksana) VALUES (?,?,?,?,?)`);
  insR.run(m1.lastInsertRowid, lib.addDays(-5), 'Pemeriksaan AC, pengecekan kompresor dan freon', 150000, 'Teknisi Acun');
  insR.run(m1.lastInsertRowid, lib.addDays(-2), 'Penggantian kompresor dan pembersihan unit', 300000, 'Teknisi Acun');
};

const seedSettings = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM pengaturan').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT INTO pengaturan (kunci, nilai) VALUES (?,?)');
  const defs = {
    hero_title: 'Pesantren SahabatQu',
    hero_badge: 'Pesantren Islami · Modern · Qur\u2019ani',
    hero_sub: 'Transparansi sarana & prasarana pesantren. Pantau inventaris, peminjaman, dan maintenance fasilitas — kapan saja, di mana saja.',
    hero_note: 'Santri, guru, dan staf dapat mendaftar — akses kelola penuh untuk admin & operator.',
    hero_image: '',
    kontak_size: 'medium',
    header_brand: 'Pesantren SahabatQu',
    header_tagline: 'Sistem Inventaris, Peminjaman & Pemeliharaan',
    title_inventaris: 'Info Inventaris',
    title_maintenance: 'Pemeliharaan Sedang Berjalan',
    title_kontak: 'Kontak & Layanan',
    btn_login: 'Masuk ke Sistem Inventaris',
    btn_register: 'Daftar Akun Baru',
    sub_inventaris: 'Ringkasan inventaris Pesantren SahabatQu saat ini.',
    sub_maintenance: 'Fasilitas yang sedang dalam perawatan. Perkembangan lengkap dapat dipantau setelah masuk.',
    sub_kontak: 'Hubungi bagian Sarana & Prasarana untuk kebutuhan fasilitas.',
    kontak_alamat: 'Jl. Pesantren SahabatQu No. 1, Komplek Pendidikan Islam, Indonesia',
    kontak_telepon: '+62 812-3456-7890',
    kontak_email: 'sarana@sahabatqu.sch.id',
    kontak_jam: 'Senin – Sabtu · 08.00 – 16.00 WIB',
    cta_title: 'Kelola Inventaris & Pemeliharaan Pesantren',
    cta_sub: 'Masuk ke sistem untuk mengajukan peminjaman, melapor kerusakan, memantau maintenance, dan mencetak laporan.',
    url_website: 'https://sintapqu.co.id',
    logo_data: '',
    wa_pesan: 'Assalamualaikum, saya ingin bertanya tentang fasilitas Pesantren SahabatQu.',
    wa_telepon2: '',
    wa_label1: 'Sarana & Prasarana',
    wa_label2: 'Kantor Pesantren',
    /* Nomor WhatsApp khusus info/konfirmasi PEMINJAMAN MOBIL (pengaju wajib chat dulu) */
    wa_mobil: '+62 856-4183-8302',
    about_title: 'Profil Pesantren SahabatQu',
    about_text: 'Pesantren SahabatQu adalah lembaga pendidikan Islam yang menekankan keseimbangan ilmu agama dan ilmu umum, dengan sarana & prasarana yang dikelola secara transparan dan tertib.',
    visi: 'Menjadi pesantren unggul yang melahirkan generasi Qur\u2019ani, berakhlak mulia, dan berdaya saing global.',
    misi: '1) Menyelenggarakan pendidikan agama & umum yang berkualitas. 2) Membina akhlak dan kemandirian santri. 3) Mengelola sarana prasarana secara modern, transparan, dan akuntabel.',
    footer_text: '© {tahun} Pesantren SahabatQu — Sarana & Prasarana. Jl. Pesantren SahabatQu No. 1, Komplek Pendidikan Islam, Indonesia.'
  };
  for (const [k, v] of Object.entries(defs)) ins.run(k, v);
};

/* Contoh surat serah terima — tinggal diedit oleh admin */
const seedSuratSerahTerima = () => {
  const c = db.prepare('SELECT COUNT(*) c FROM surat_serah_terima').get().c;
  if (c > 0) return;
  const th = new Date().getFullYear();
  const info = db.prepare(`INSERT INTO surat_serah_terima (nomor, tanggal, tempat, penyerah_nama, penyerah_jabatan, penerima_nama, penerima_jabatan, catatan) VALUES (?,?,?,?,?,?,?,?)`)
    .run('001/SST/SARPRAS/' + th, lib.addDays(-3), 'Kantor Sarana & Prasarana',
      'H. Hasan', 'Kepala Sarana & Prasarana', 'Ustadz Ahmad Fauzi', 'Koordinator Asrama Putra',
      'Barang diserahkan dalam kondisi baik dan siap pakai.');
  const sid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO surat_serah_terima_item (surat_id, nama, jumlah, satuan, keterangan) VALUES (?,?,?,?,?)');
  const find = (n) => { const r = db.prepare('SELECT nama, satuan FROM barang WHERE nama = ?').get(n); return r || { nama: n, satuan: 'unit' }; };
  const contoh = [
    ['Meja Belajar', 10, 'unit', 'Kondisi baik'],
    ['Kursi Plastik', 20, 'unit', 'Warna biru'],
    ['Kipas Angin', 2, 'unit', 'Standar'],
    ['Papan Tulis', 4, 'unit', 'Whiteboard']
  ];
  for (const [n, j, s, k] of contoh) {
    const b = find(n);
    ins.run(sid, b.nama, j, b.satuan || s, k);
  }
};

seedUsers();
seedRooms();
seedItems();
seedTransactions();
seedSettings();
seedSuratSerahTerima();
seedBidang();
seedPiket();
seedMobil();
syncKategoriBarang();

/* Data Mobil — diisi OTOMATIS dari data kendaraan yang sudah ada
   (objek kendaraan pada Jadwal Pemeliharaan & Pemeliharaan kategori kendaraan).
   Hanya berjalan bila tabel mobil masih kosong (tidak pernah menghapus data). */
function seedMobil() {
  const c = db.prepare('SELECT COUNT(*) c FROM mobil').get().c;
  if (c > 0) return;
  // Pisahkan "NAMA-PLAT" (kendaraan disimpan sebagai nama-plat di jadwal)
  const parse = (s) => {
    const t = String(s || '').trim();
    if (!t) return null;
    const i = t.lastIndexOf('-');
    if (i > 0) {
      return {
        nama: t.slice(0, i).replace(/-/g, ' ').replace(/\s+/g, ' ').trim(),
        plat: t.slice(i + 1).trim()
      };
    }
    return { nama: t, plat: '' };
  };
  const sumber = [];
  try {
    db.prepare("SELECT DISTINCT objek_nama FROM jadwal WHERE objek_nama <> ''").all()
      .forEach((r) => sumber.push(parse(r.objek_nama)));
  } catch (e) { /* tabel jadwal mungkin belum ada */ }
  try {
    db.prepare("SELECT DISTINCT objek_nama FROM maintenance WHERE kategori = 'kendaraan' AND objek_nama <> ''").all()
      .forEach((r) => sumber.push(parse(r.objek_nama)));
  } catch (e) { /* diabaikan */ }

  const uniq = new Map();
  sumber.forEach((m) => {
    if (!m || !m.nama) return;
    const nm = String(m.nama).trim();
    // Lewati data sampah: nama terlalu pendek / hanya angka (mis. '0')
    if (nm.length < 3 || /^[\d\s.,-]+$/.test(nm)) return;
    const kunci = (nm + '|' + m.plat).toLowerCase();
    if (!uniq.has(kunci)) uniq.set(kunci, { nama: nm, plat: m.plat });
  });
  const ins = db.prepare('INSERT INTO mobil (nama, plat, jenis, kapasitas, keterangan) VALUES (?,?,?,?,?)');
  for (const m of uniq.values()) {
    const nm = m.nama.toLowerCase();
    let jenis = 'Kendaraan', kap = 0;
    if (nm.includes('bus')) { jenis = 'Bus'; kap = 40; }
    else if (nm.includes('hiace') || nm.includes('commuter')) { jenis = 'Minibus'; kap = 14; }
    else if (nm.includes('luxio') || nm.includes('apv') || nm.includes('xenia')) { jenis = 'MPV'; kap = 7; }
    else if (nm.includes('carry') || nm.includes('pickup') || nm.includes('pick up')) { jenis = 'Pickup'; kap = 2; }
    ins.run(m.nama, m.plat, jenis, kap, '');
  }
}

/* Arsip Jadwal Piket Bulanan Cleaning Service — contoh bila kosong */
function seedPiket() {
  const c = db.prepare('SELECT COUNT(*) c FROM piket').get().c;
  if (c > 0) return;
  const t = new Date();
  const bln = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  db.prepare('INSERT INTO piket (bulan, judul, keterangan, isi) VALUES (?,?,?,?)').run(
    bln,
    'Jadwal Piket Bulanan Cleaning Service',
    'Jadwal kebersihan harian area pesantren.',
    'Senin|Pak Budi|Masjid & Aula|0\nSelasa|Bu Sari|Asrama Putri & Kantor|0\nRabu|Pak Joko|Gedung Pendidikan & Lab|0\nKamis|Pak Budi|Masjid & Aula|0\nJumat|Bu Sari|Asrama Putri & Kantor|0\nSabtu|Pak Joko|Gedung Pendidikan & Lapangan|0\nAhad|Libur|Piket bergilir|0'
  );
}

/* Pilihan Bidang/Unit/Bagian — isi default bila kosong */
function seedBidang() {
  const c = db.prepare('SELECT COUNT(*) c FROM bidang').get().c;
  if (c > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO bidang (nama) VALUES (?)');
  ['Santri', 'Guru / Ustadz', 'Staf', 'Tahfidz', 'Asrama Putra', 'Asrama Putri', 'Pendidikan', 'Kantin / Dapur', 'Kantor', 'Lainnya'].forEach((b) => ins.run(b));
}

/* Sinkronkan tabel kategori_barang dengan kategori barang existing (idempoten) */
function syncKategoriBarang() {
  const rows = db.prepare("SELECT DISTINCT kategori FROM barang WHERE kategori != ''").all();
  const ins = db.prepare('INSERT OR IGNORE INTO kategori_barang (nama) VALUES (?)');
  rows.forEach((r) => ins.run(r.kategori));
}

module.exports = db;
