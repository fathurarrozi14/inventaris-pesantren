'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const QRCode = require('qrcode');
const db = require('./db');
const lib = require('./lib');
const compression = require('compression');
const crypto = require('crypto');
const XLSX = require('xlsx');
const importBarang = require('./import-barang');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(compression()); // gzip semua respons HTML/JS/CSS/JSON -> loading jauh lebih ringan
app.use(express.urlencoded({ extended: false, limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

app.use(session({
  store: new lib.SqliteStore(db),
  secret: process.env.SESSION_SECRET || 'sahabatqu-pesantren-inventaris-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 }
}));

/* ================= Helpers ================= */
const q = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);

function mobilStatus(id) {
  const m = q('SELECT status FROM mobil WHERE id = ?', id);
  if (!m) return 'nonaktif';
  if (m.status !== 'aktif') return m.status; // maintenance / nonaktif (diatur dari menu Data Mobil)
  const t = lib.today();
  const used = q(`SELECT COUNT(*) c FROM pinjam_mobil WHERE mobil_id = ? AND status = 'disetujui' AND tanggal_mulai <= ? AND tanggal_selesai >= ?`, id, t, t).c;
  if (used > 0) return 'dipakai';
  return 'tersedia';
}
/* Cek bentrok peminjaman mobil: peminjaman DISETUJUI yang tanggal & jam-nya tumpang tindih */
function cekTabrakanMobil(mobilId, mulai, selesai, jamMulai, jamSelesai, excludeId) {
  const clauses = [`pm.mobil_id = ?`, `pm.status = 'disetujui'`, `pm.tanggal_mulai <= ?`, `pm.tanggal_selesai >= ?`];
  const params = [mobilId, selesai, mulai];
  if (excludeId) { clauses.push('pm.id != ?'); params.push(excludeId); }
  const rows = all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat,
           COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    WHERE ${clauses.join(' AND ')}`, ...params);
  return rows.filter((b) => {
    const b1 = b.jam_mulai || '00:00', b2 = b.jam_selesai || '23:59';
    return jamMulai < b2 && b1 < jamSelesai;
  });
}
function pesanMobilDipinjam(b) {
  return `Mobil "${b.mobil_nama}${b.mobil_plat ? ' (' + b.mobil_plat + ')' : ''}" sudah dipinjam pada ${lib.fmtDateShort(b.tanggal_mulai)} ${b.jam_mulai || '08:00'}–${b.jam_selesai || '17:00'} WIB oleh ${b.peminjam_tampil}. Silakan pilih mobil atau waktu lain.`;
}
function ruanganStatus(id) {
  const open = q(`SELECT COUNT(*) c FROM maintenance WHERE ruangan_id = ? AND status IN ('dilaporkan','diperbaiki')`, id).c;
  if (open > 0) return 'maintenance';
  const t = lib.today();
  const used = q(`SELECT COUNT(*) c FROM pinjam_ruangan WHERE ruangan_id = ? AND status = 'disetujui' AND tanggal_mulai <= ? AND tanggal_selesai >= ?`, id, t, t).c;
  if (used > 0) return 'dipakai';
  return 'tersedia';
}

function isManageStaff(user) {
  return user && (user.role === 'admin' || user.role === 'operator');
}
function isAdmin(user) {
  return user && user.role === 'admin';
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validTime(v) { return TIME_RE.test(v); }
function nowTime() {
  const t = new Date();
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
}
/* Waktu WIB (UTC+7) sekarang dalam format "YYYY-MM-DD HH:MM" —
   aplikasi menampilkan & menyimpan jam sebagai WIB, sedangkan server berjalan UTC,
   jadi perbandingan auto-selesai HARUS memakai WIB agar akurat. */
function nowWIB() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const s = d.toISOString(); // UTC dari waktu+7 = waktu WIB saat ini
  return s.slice(0, 10) + ' ' + s.slice(11, 16);
}
/* Auto-selesaikan peminjaman ruangan yang sudah melewati batas tanggal & jam selesai (WIB).
   Status 'disetujui' otomatis menjadi 'selesai' bila (tanggal_selesai + jam_selesai) < sekarang.
   Mengembalikan jumlah baris yang baru diubah. */
function autoSelesaikanPeminjamanRuangan() {
  let total = 0;
  try {
    const now = nowWIB();
    const a = db.prepare(`UPDATE pinjam_ruangan SET status = 'selesai'
                WHERE status = 'disetujui'
                  AND (tanggal_selesai || ' ' || COALESCE(NULLIF(jam_selesai,''), '17:00')) < ?`)
      .run(now);
    total += a.changes || 0;
  } catch (e) { console.error('(non-fatal) auto-selesai peminjaman ruangan gagal:', e.message); }
  try {
    const now = nowWIB();
    const b = db.prepare(`UPDATE pinjam_mobil SET status = 'selesai'
                WHERE status = 'disetujui'
                  AND (tanggal_selesai || ' ' || COALESCE(NULLIF(jam_selesai,''), '17:00')) < ?`)
      .run(now);
    total += b.changes || 0;
  } catch (e) { console.error('(non-fatal) auto-selesai peminjaman mobil gagal:', e.message); }
  return total;
}
function getSettings() {
  const s = {};
  all('SELECT kunci, nilai FROM pengaturan').forEach((r) => { s[r.kunci] = r.nilai; });
  return s;
}
/* Ambil nomor PERTAMA dari kolom telepon (pisah koma/titik-koma, buang kosong) */
function normTel(s) {
  // Bila body parser mengirim array (duplikat name), pakai nilai pertama
  const v = Array.isArray(s) ? s[0] : s;
  return String(v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)[0] || '';
}
/* ============================================================
   PENCARIAN JADWAL PEMINJAMAN (beranda website)
   Teks yang bisa dicari: nama ruangan/mobil + plat/jenis, keperluan,
   nama peminjam, bidang, dan tanggal (mis. "sep", "24", "2026",
   "24/09/2026", "kamis"). Dipakai untuk ?q= di halaman depan.
   ============================================================ */
const NAMA_BULAN_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const NAMA_BULAN_PANJANG = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
const NAMA_HARI_ID = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
/* "2026-09-24" -> "24 24/09/2026 2026-09-24 sep september kamis 24 Sep 2026" */
function teksTanggalCari(ymd) {
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const hari = NAMA_HARI_ID[new Date(s + 'T00:00:00').getDay()] || '';
  return [Number(m[3]), `${m[3]}/${m[2]}/${m[1]}`, s, NAMA_BULAN_ID[Number(m[2]) - 1], NAMA_BULAN_PANJANG[Number(m[2]) - 1], hari].join(' ');
}
/* Saring daftar peminjaman publik sesuai kata kunci (kosong = semua) */
function saringJadwal(qs, rows, tipe) {
  const cari = String(qs || '').trim().toLowerCase();
  if (!cari) return rows;
  const kata = cari.split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const bagian = tipe === 'mobil'
      ? [r.mobil_nama, r.mobil_plat, r.mobil_jenis, 'mobil', 'kendaraan']
      : [r.ruangan_nama, 'ruangan', r.bidang_tampil];
    const teks = [
      ...bagian, r.keperluan, r.peminjam_tampil, r.nama_peminjam, r.catatan,
      teksTanggalCari(r.tanggal_mulai), teksTanggalCari(r.tanggal_selesai),
      r.jam_mulai, r.jam_selesai, r.jumlah_peserta, r.jumlah_penumpang
    ].filter(Boolean).join(' ').toLowerCase();
    return kata.every((k) => teks.includes(k));   // semua kata harus cocok
  });
}
/* ============================================================
   KONFIRMASI WHATSAPP PEMINJAMAN MOBIL
   Alur: pengaju WAJIB chat WhatsApp dulu ke nomor info (Sarana &
   Prasarana) → baru mengisi formulir → admin memeriksa & menyetujui.
   Nomor bisa diubah admin di Halaman Website ("Nomor WhatsApp
   Peminjaman Mobil"); bila kosong dipakai nomor kontak, lalu bawaan.
   ============================================================ */
const WA_MOBIL_DEFAULT = '+62 856-4183-8302';
const WA_MOBIL_PESAN = 'Assalamualaikum, saya ingin mengajukan peminjaman mobil pesantren. Mohon info ketersediaan unit dan persetujuannya. Terima kasih.';
function waMobilLabel(set) {
  return normTel(set.wa_mobil) || normTel(set.kontak_telepon) || WA_MOBIL_DEFAULT;
}
function waMobilInfo(set) {
  const label = waMobilLabel(set);
  return { label, link: lib.phoneToWa(label), pesan: WA_MOBIL_PESAN };
}

const JENIS_JADWAL = { servis: 'Service / Perbaikan', pajak_tahunan: 'Pajak Tahunan', pajak_bulanan: 'Pajak 5 Tahunan' };
/* Interval pengulangan tiap jenis jadwal (dalam bulan) — dipakai untuk membuat
   jadwal jatuh tempo BERIKUTNYA otomatis saat "Tandai Selesai" diklik. */
const INTERVAL_JADWAL = { servis: 3, pajak_tahunan: 12, pajak_bulanan: 60 };
/* Tambah n bulan ke tanggal "YYYY-MM-DD" (aman utk akhir bulan). */
function tambahBulan(tanggal, bulan) {
  const [y, m, d] = String(tanggal || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const t = new Date(y, m - 1 + Number(bulan || 0), d);
  // bila hari "meluber" (mis. 31 Feb), mundurkan ke hari terakhir bulan itu
  if (t.getDate() !== d) t.setDate(0);
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
/* Hitung jatuh tempo berikutnya dari daftar jenis (ambil interval TERBESAR agar
   Pajak 5 Tahunan tidak dibuat ulang tiap 3 bulan). */
function jatuhTempoBerikutnya(tanggal, jenisList) {
  const list = String(jenisList || '').split(',').map((x) => x.trim()).filter(Boolean);
  const bulan = list.reduce((mx, j) => Math.max(mx, INTERVAL_JADWAL[j] || 12), 0) || 12;
  return { tanggal: tambahBulan(tanggal, bulan), bulan };
}

/* ================= Middleware ================= */
app.use((req, res, next) => {
  // Muat ulang data user dari DB agar perubahan role langsung berlaku
  if (req.session.user) {
    const u = q('SELECT id, username, nama, role FROM users WHERE id = ?', req.session.user.id);
    if (!u) { req.session.destroy(() => {}); return redir(req, res, 'login'); }
    req.session.user = u;
  }
  res.locals.u = req.session.user || null;
  res.locals.e = lib.esc;
  res.locals.badge = (status, ctx) =>
    `<span class="badge badge-${lib.badgeColor(status, ctx)}">${lib.esc(lib.statusLabel(status, ctx))}</span>`;
  res.locals.roleLabel = (r) => lib.ROLE_LABEL[r] || r;
  res.locals.kategoriLabel = (k) => lib.kategoriLabel(k);
  res.locals.statusLabel = (s, ctx) => lib.statusLabel(s, ctx);
  res.locals.barcode = (t) => lib.code128b(t);
  res.locals.kodeStiker = (id) => lib.kodeStiker(id);
  res.locals.kodeStikerRuangan = (id) => lib.kodeStikerRuangan(id);
  res.locals.kodeStikerTampil = (obj, id, tipe) => lib.kodeStikerTampil(obj, id, tipe);
  // Pengkodean aset (golongan·bidang·sub) — dipakai form & tabel barang/ruangan
  res.locals.pengkodean = lib.PENGKODEAN;
  res.locals.kodeAset = lib.kodeAset;
  res.locals.subNama = lib.subNama;
  res.locals.fmtDate = lib.fmtDate;
  res.locals.fmtDateShort = lib.fmtDateShort;
  res.locals.fmtIDR = lib.fmtIDR;
  res.locals.today = lib.today;
  res.locals.csrfField = `<input type="hidden" name="_csrf" value="${lib.csrfToken(req)}">`;
  res.locals.csrfToken = lib.csrfToken(req);
  res.locals.url = (to) => lib.rel(req.path, to);
  res.locals.isManageStaff = isManageStaff(req.session.user);
  res.locals.isAdmin = isAdmin(req.session.user);
  // Kategori barang (untuk sub-menu sidebar & filter)
  try {
    res.locals.barangKategori = all(`SELECT nama FROM kategori_barang ORDER BY nama ASC`).map((r) => r.nama);
    if (!res.locals.barangKategori.length) {
      res.locals.barangKategori = all(`SELECT DISTINCT kategori FROM barang WHERE kategori != '' ORDER BY kategori ASC`).map((r) => r.kategori);
    }
  } catch (e) { res.locals.barangKategori = []; }
  // Notifikasi lonceng (staff): pengajuan & laporan yang belum diproses
  res.locals.notifCount = 0;
  res.locals.notifList = [];
  if (isManageStaff(req.session.user)) {
    const pendings = all(`SELECT 'ruangan' AS tipe, id, keperluan AS judul, 'Peminjaman Ruangan' AS menu FROM pinjam_ruangan WHERE status = 'pending'
      UNION ALL SELECT 'barang', id, keperluan, 'Peminjaman Barang' FROM pinjam_barang WHERE status = 'pending'
      UNION ALL SELECT 'mobil', id, keperluan, 'Peminjaman Mobil' FROM pinjam_mobil WHERE status = 'pending'
      UNION ALL SELECT 'maint', id, judul, 'Laporan Pemeliharaan' FROM maintenance WHERE status = 'dilaporkan'
      ORDER BY id DESC LIMIT 20`);
    res.locals.notifList = pendings;
    res.locals.notifCount = pendings.length;
  }
  // Logo website kustom (data URI dari tabel pengaturan; kosong = pakai logo SVG default)
  res.locals.logoData = '';
  res.locals.logoVer = 'def';
  try {
    const lr = q("SELECT nilai FROM pengaturan WHERE kunci = 'logo_data'");
    if (lr && lr.nilai) {
      res.locals.logoData = lr.nilai;
      // Versi singkat logo -> dipakai sebagai ?v= pada URL ikon.
      // Tujuannya: bila logo diganti, URL ikon berubah sehingga ikon homescreen
      // yang lama (di-cache browser/OS) tidak dipakai lagi.
      res.locals.logoVer = crypto.createHash('md5').update(lr.nilai).digest('hex').slice(0, 8);
    }
  } catch (e) { /* tabel pengaturan selalu dibuat di db.js */ }
  const flashes = req.session.flash || [];
  req.session.flash = [];
  res.locals.flashes = flashes;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = [{ type: 'danger', msg: 'Silakan masuk terlebih dahulu.' }];
    return redir(req, res, 'login?next=' + encodeURIComponent(req.path));
  }
  next();
}
function requireRoles(...roles) {
  return (req, res, next) => {
    requireLogin(req, res, () => {
      if (req.session.user && roles.includes(req.session.user.role)) return next();
      req.session.flash = [{ type: 'danger', msg: 'Anda tidak memiliki izin untuk tindakan ini.' }];
      return redir(req, res, 'index');
    });
  };
}
function flash(req, type, msg) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, msg });
}
function catatAudit(req, user, aksi) {
  try {
    const ua = req.headers['user-agent'] || '';
    const info = lib.parseUserAgent(ua);
    db.prepare(`INSERT INTO audit_log (user_id, username, nama, role, aksi, ip, browser, os, device, user_agent, waktu)
                VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'))`)
      .run(user.id, user.username, user.nama, user.role, aksi,
        (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
        info.browser, info.os, info.device, ua.slice(0, 300));
  } catch (e) { /* audit tidak boleh menggagalkan login */ }
}
function postGuard(req, res) {
  return lib.csrfCheck(req, res);
}
/* Redirect dengan Location RELATIF murni (bukan root-absolute) agar tetap
   berfungsi saat dipublikasikan di bawah subpath /<slug>/. */
function redir(req, res, to) {
  res.status(302);
  res.setHeader('Location', lib.rel(req.path, to));
  res.end();
}

/* ================= AUTH ================= */
function validNext(n) {
  const s = String(n || '');
  if (!s) return '';
  if (s.startsWith('//') || /^[a-z]+:/i.test(s)) return '';
  return s.replace(/^\/+/, '');
}
app.get('/login', (req, res) => {
  if (req.session.user) return redir(req, res, 'index');
  res.render('login', { error: null, regError: null, mode: 'login', regNama: '', regUsername: '', next: validNext(req.query.next) });
});
app.post('/login', (req, res) => {
  if (!postGuard(req, res)) return;
  const { username, password } = req.body;
  const user = username ? q('SELECT * FROM users WHERE username = ?', String(username).trim().toLowerCase()) : null;
  if (!user || !lib.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).render('login', { error: 'Username atau password salah.', regError: null, mode: 'login', regNama: '', regUsername: '', next: validNext(req.body.next) });
  }
  req.session.user = { id: user.id, username: user.username, nama: user.nama, role: user.role };
  catatAudit(req, user, 'login');
  flash(req, 'success', `Selamat datang, ${user.nama}!`);
  const next = validNext(req.body.next);
  redir(req, res, next || 'index');
});
app.get('/logout', (req, res) => {
  if (req.session.user) catatAudit(req, req.session.user, 'logout');
  req.session.destroy(() => redir(req, res, 'login'));
});

/* ---- Pendaftaran pengguna baru (publik, otomatis peran santri) ---- */
app.get('/register', (req, res) => {
  if (req.session.user) return redir(req, res, 'index');
  res.render('login', { error: null, regError: null, mode: 'register', regNama: '', regUsername: '', next: '' });
});
app.post('/register', (req, res) => {
  if (!postGuard(req, res)) return;
  const nama = String(req.body.nama || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const pw2 = String(req.body.password_konfirmasi || '');
  const fail = (msg) =>
    res.status(400).render('login', { error: null, regError: msg, mode: 'register', regNama: nama, regUsername: username, next: '' });
  if (!nama || !username) return fail('Nama lengkap dan username wajib diisi.');
  if (pw.length < 6) return fail('Password minimal 6 karakter.');
  if (pw !== pw2) return fail('Konfirmasi password tidak cocok.');
  const exists = q('SELECT id FROM users WHERE username = ?', username);
  if (exists) return fail('Username sudah digunakan, silakan pilih username lain.');
  const info = db.prepare('INSERT INTO users (username, password_hash, nama, role) VALUES (?,?,?,?)')
    .run(username, lib.hashPassword(pw), nama, 'santri');
  const user = q('SELECT id, username, nama, role FROM users WHERE id = ?', info.lastInsertRowid);
  req.session.user = user;
  catatAudit(req, user, 'register');
  flash(req, 'success', `Selamat datang, ${user.nama}! Akun Anda telah terdaftar sebagai Santri/Guru.`);
  redir(req, res, 'index');
});

/* ================= BERANDA PUBLIK (front-end) ================= */
const kunjunganCache = new Map(); // ip -> timestamp (throttle 10 menit)
app.get('/', (req, res) => {
  autoSelesaikanPeminjamanRuangan();
  // Catat kunjungan website anonim (throttle 1x per IP per 10 menit) untuk statistik tamu
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const now = Date.now();
    if (!req.session.user && ip && (!kunjunganCache.has(ip) || now - kunjunganCache.get(ip) > 600000)) {
      kunjunganCache.set(ip, now);
      if (kunjunganCache.size > 500) kunjunganCache.clear();
      const ua = req.headers['user-agent'] || '';
      const info = lib.parseUserAgent(ua);
      db.prepare(`INSERT INTO audit_log (user_id, username, nama, role, aksi, ip, browser, os, device, user_agent, waktu)
                  VALUES (NULL, '', 'Tamu Website', 'tamu', 'kunjungan', ?, ?, ?, ?, ?, datetime('now','localtime'))`)
        .run(ip, info.browser, info.os, info.device, ua.slice(0, 300));
    }
  } catch (e) { /* abaikan */ }
  // Halaman website selalu bisa dibuka (juga saat sudah login — untuk pratinjau);
  // tombol di halaman menyesuaikan status login (Dashboard/Keluar vs Masuk/Daftar).
  const stats = {
    ruangan: q('SELECT COUNT(*) c FROM ruangan').c,
    barangJenis: q('SELECT COUNT(*) c FROM barang').c,
    stokTotal: q('SELECT COALESCE(SUM(jumlah_total),0) t FROM barang').t,
    maintBerjalan: q("SELECT COUNT(*) c FROM maintenance WHERE status IN ('dilaporkan','diperbaiki')").c,
    maintSelesai: q("SELECT COUNT(*) c FROM maintenance WHERE status = 'selesai'").c,
    pinjamAktif: q("SELECT COUNT(*) c FROM pinjam_ruangan WHERE status='disetujui'").c +
      q("SELECT COUNT(*) c FROM pinjam_barang WHERE status='disetujui'").c
  };
  const maint = all(`
    SELECT m.*, u.nama AS pelapor_nama, COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m
    JOIN users u ON u.id = m.pelapor_id
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    WHERE m.status IN ('dilaporkan','diperbaiki')
    ORDER BY m.id DESC LIMIT 8`);
  // Peminjaman ruangan yang bisa dilihat publik — diurutkan dari yang TERBARU (id DESC)
  const pinjamPublik = all(`
    SELECT pr.*, r.nama AS ruangan_nama,
           COALESCE(NULLIF(pr.nama_peminjam, ''), u.nama) AS peminjam_tampil,
           pr.bidang AS bidang_tampil
    FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id
    JOIN users u ON u.id = pr.peminjam_id
    WHERE pr.status = 'disetujui' AND pr.tanggal_selesai >= ?
    ORDER BY pr.tanggal_mulai ASC, pr.jam_mulai ASC, pr.id ASC`, lib.today());
  // Peminjaman MOBIL yang bisa dilihat publik — diurutkan dari tanggal terdekat
  const pinjamMobilPublik = all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat, m.jenis AS mobil_jenis,
           COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    WHERE pm.status = 'disetujui' AND pm.tanggal_selesai >= ?
    ORDER BY pm.tanggal_mulai ASC, pm.jam_mulai ASC, pm.id ASC`, lib.today());
  // Pencarian jadwal: ?q= (mis. "hall", "rapat", "ahmad", "sep", "kamis", "bus")
  const cari = String(req.query.q || '').trim();
  const pinjamPublikCari = saringJadwal(cari, pinjamPublik, 'ruangan');
  const pinjamMobilCari = saringJadwal(cari, pinjamMobilPublik, 'mobil');
  // Peminjaman ruangan TERBARU (untuk panel website)
  const pinjamTerbaru = all(`
    SELECT pr.*, r.nama AS ruangan_nama,
           COALESCE(NULLIF(pr.nama_peminjam, ''), u.nama) AS peminjam_tampil,
           pr.bidang AS bidang_tampil
    FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id
    JOIN users u ON u.id = pr.peminjam_id
    WHERE pr.status IN ('disetujui','selesai')
    ORDER BY pr.id DESC LIMIT 6`);
  // Breakdown inventaris per kategori (untuk rincian jumlah sekali-klik)
  const breakdown = all(`
    SELECT kategori,
           COUNT(*) AS jenis,
           COALESCE(SUM(jumlah_total), 0) AS total,
           COALESCE(SUM(jumlah_tersedia), 0) AS tersedia
    FROM barang GROUP BY kategori ORDER BY kategori ASC`);
  const set = getSettings();
  // Nomor tampilan kontak (Kontak & Layanan) — nomor sendiri
  const tel = normTel(set.kontak_telepon) || '+62 812-3456-7890';
  const kontak = {
    alamat: set.kontak_alamat || 'Jl. Pesantren SahabatQu No. 1, Komplek Pendidikan Islam, Indonesia',
    telepon: tel,
    email: set.kontak_email || 'sarana@sahabatqu.sch.id',
    jam: set.kontak_jam || 'Senin – Sabtu · 08.00 – 16.00 WIB'
  };
  // Nomor WhatsApp 1 (tombol WA) — terpisah dari kontak; fallback ke kontak utk data lama
  const wa1Label = normTel(set.wa_telepon1) || tel;
  const wa = lib.phoneToWa(wa1Label);
  const wa2 = set.wa_telepon2 ? lib.phoneToWa(normTel(set.wa_telepon2)) : '';
  const wa2Label = normTel(set.wa_telepon2);
  const waMaint = set.wa_maintenance ? lib.phoneToWa(normTel(set.wa_maintenance)) : '';
  const waMaintLabel = set.wa_maint_label || 'Lapor Pemeliharaan';
  res.render('front', {
    page: 'front', stats, maint,
    pinjamPublik: pinjamPublikCari, pinjamMobilPublik: pinjamMobilCari,
    cari, jumlahCari: pinjamPublikCari.length + pinjamMobilCari.length,
    pinjamTerbaru, breakdown, kontak, set, wa, wa1Label, wa2, wa2Label, waMaint, waMaintLabel
  });
});

/* ---- Halaman publik barang (hasil scan QR/barcode stiker) ---- */
app.get('/logo', (req, res) => {
  // Serve logo kustom sebagai file gambar (bukan base64 inline di HTML) — HTML jadi ringan,
  // browser meng-cache gambar 1 hari. Fallback 404 → view memakai SVG default.
  const lr = q("SELECT nilai FROM pengaturan WHERE kunci = 'logo_data'");
  const data = lr && lr.nilai ? lr.nilai : '';
  const m = String(data).match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i);
  if (!m) return res.status(404).end();
  const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
  res.setHeader('Content-Type', 'image/' + ext);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(m[2], 'base64'));
});

/* ---- Ikon PWA mengikuti LOGO WEBSITE (Halaman Website → Logo) ----
   Manifest & ikon disajikan dinamis: bila admin mengganti logo di Halaman Website,
   ikon di homescreen ikut berubah otomatis tanpa mengubah file apa pun.
   Logo diubah menjadi PNG PERSEGI (aman utk Android & iOS) dgn latar dari warna logo. */
const Jimp = require('jimp');
const ikonCache = new Map(); // key -> Buffer PNG (dibuat sekali per logo/ukuran)

function dataLogoKustom() {
  const lr = q("SELECT nilai FROM pengaturan WHERE kunci = 'logo_data'");
  return lr && lr.nilai ? lr.nilai : '';
}
function bacaLogoKustom() {
  const m = String(dataLogoKustom()).match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
  return { mime: 'image/' + ext, buf: Buffer.from(m[2], 'base64') };
}
/* Warna rata-rata logo (sampel grid) -> dipakai sebagai latar ikon persegi */
function warnaRataRata(img) {
  let r = 0, g = 0, b = 0, n = 0;
  const w = img.bitmap.width, h = img.bitmap.height;
  const langkah = Math.max(1, Math.floor(Math.min(w, h) / 40));
  for (let y = 0; y < h; y += langkah) {
    for (let x = 0; x < w; x += langkah) {
      const c = Jimp.intToRGBA(img.getPixelColor(x, y));
      if (c.a < 20) continue;              // lewati piksel transparan
      r += c.r; g += c.g; b += c.b; n++;
    }
  }
  if (!n) return { r: 99, g: 102, b: 241, a: 255 }; // default indigo
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: 255 };
}
/* Buat ikon PNG persegi dari logo: latar warna logo + logo di tengah (safe zone utk maskable) */
async function ikonPngDariLogo(ukuran, mode) {
  const logo = bacaLogoKustom();
  if (!logo) return null;
  const kunci = ukuran + ':' + mode + ':' + crypto.createHash('md5').update(logo.buf).digest('hex');
  if (ikonCache.has(kunci)) return ikonCache.get(kunci);
  const img = await Jimp.read(logo.buf);
  const latar = warnaRataRata(img);
  const canvas = new Jimp(ukuran, ukuran, Jimp.rgbaToInt(latar.r, latar.g, latar.b, 255));
  const sisi = Math.round(ukuran * (mode === 'maskable' ? 0.66 : 0.84)); // maskable = safe zone lebih kecil
  img.scaleToFit(sisi, sisi);
  canvas.composite(img, Math.round((ukuran - img.bitmap.width) / 2), Math.round((ukuran - img.bitmap.height) / 2));
  const buf = await canvas.getBufferAsync(Jimp.MIME_PNG);
  if (ikonCache.size > 12) ikonCache.clear();  // batasi memori (logo lama dibuang)
  ikonCache.set(kunci, buf);
  return buf;
}
/* /ikon-192.png, /ikon-512.png, /ikon-maskable.png — PNG persegi dari logo website
   (fallback ke ikon bawaan bila logo belum diunggah / gagal diproses) */
app.get(/^\/ikon-(192|512|maskable)\.png$/, async (req, res) => {
  const jenis = req.params[0];
  const ukuran = jenis === '192' ? 192 : 512;
  const mode = jenis === 'maskable' ? 'maskable' : 'any';
  const bawaan = jenis === '192' ? 'icon-192.png' : (jenis === '512' ? 'icon-512.png' : 'maskable-512.png');
  const kirimBawaan = () => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'public', 'icons', bawaan));
  };
  try {
    const png = await ikonPngDariLogo(ukuran, mode);
    if (!png) return kirimBawaan();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (e) {
    console.error('(non-fatal) gagal membuat ikon dari logo:', e.message);
    kirimBawaan();
  }
});
/* Manifest dinamis: ikon = PNG persegi dari logo website (tipe selalu image/png) */
app.get('/manifest.webmanifest', (req, res) => {
  const logo = bacaLogoKustom();
  const adaLogo = !!logo;
  const ver = adaLogo ? crypto.createHash('md5').update(dataLogoKustom()).digest('hex').slice(0, 8) : 'def';
  const src = (nama) => (adaLogo ? nama : 'icons/' + nama.replace('ikon-192.png', 'icon-192.png').replace('ikon-512.png', 'icon-512.png').replace('ikon-maskable.png', 'maskable-512.png'));
  // ?v=<hash logo> -> URL ikon berubah setiap logo diganti, sehingga ikon homescreen
  // yang lama (di-cache browser/OS) tidak dipakai lagi.
  const ico = (nama) => src(nama) + '?v=' + ver;
  const manifest = {
    // id unik & stabil: memaksa Android membuat WebAPK BARU (ikon diambil ulang),
    // sehingga ikon lama yang ter-cache di homescreen tidak dipakai lagi.
    id: 'sintapqu-inventaris-pesantren-v1',
    name: 'Sistem Inventaris Pesantren SahabatQu',
    short_name: 'SINTAPQU',
    description: 'Aplikasi inventaris, peminjaman, dan pemeliharaan sarana & prasarana Pesantren SahabatQu.',
    lang: 'id',
    dir: 'ltr',
    start_url: '.',
    scope: '.',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#0A1638',
    theme_color: '#4F46E5',
    categories: ['productivity', 'education', 'utilities'],
    icons: [
      { src: ico('ikon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: ico('ikon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: ico('ikon-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [
      { name: 'Dashboard', short_name: 'Dashboard', url: 'index', icons: [{ src: ico('ikon-192.png'), sizes: '192x192', type: 'image/png' }] },
      { name: 'Inventaris Barang', short_name: 'Barang', url: 'barang', icons: [{ src: ico('ikon-192.png'), sizes: '192x192', type: 'image/png' }] },
      { name: 'Peminjaman Ruangan', short_name: 'Pinjam Ruangan', url: 'peminjaman-ruangan', icons: [{ src: ico('ikon-192.png'), sizes: '192x192', type: 'image/png' }] },
      { name: 'Pemeliharaan', short_name: 'Pemeliharaan', url: 'maintenance', icons: [{ src: ico('ikon-192.png'), sizes: '192x192', type: 'image/png' }] }
    ]
  };
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  // Jangan cache lama — agar perubahan logo langsung tercermin di homescreen
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.send(JSON.stringify(manifest, null, 2));
});
app.get('/barang/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const b = q('SELECT * FROM barang WHERE id = ?', Number(req.params.id) || 0);
  if (!b) return res.status(404).render('notfound', { page: '' });
  res.render('barang-publik', { page: '', barang: b, set: getSettings() });
});

/* ---- Halaman publik ruangan (hasil scan QR stiker ruangan) ---- */
app.get('/ruangan/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const r = q('SELECT * FROM ruangan WHERE id = ?', Number(req.params.id) || 0);
  if (!r) return res.status(404).render('notfound', { page: '' });
  res.render('ruangan-publik', { page: '', ruangan: { ...r, status: ruanganStatus(r.id) }, set: getSettings() });
});

/* ---- Halaman publik daftar inventaris (kartu info bisa diklik) ---- */
app.get('/inventaris', (req, res) => {
  const kat = String(req.query.kategori || '').trim();
  const list = all(`SELECT id, nama, kategori, lokasi, jumlah_total, jumlah_tersedia, satuan, foto, deskripsi FROM barang
    WHERE (? = '' OR kategori = ?) ORDER BY nama ASC`, kat, kat);
  const kategories = all(`SELECT DISTINCT kategori FROM barang WHERE kategori != '' ORDER BY kategori ASC`).map((r) => r.kategori);
  const set = getSettings();
  res.render('inventaris-publik', { page: '', list, kategories, kat, set });
});

/* ---- Upload foto barang (dari menu cetak stiker & form barang) ---- */
app.post('/barang/:id/foto', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const foto = String(req.body.foto || '').trim();
  if (!q('SELECT id FROM barang WHERE id = ?', id)) { flash(req, 'danger', 'Barang tidak ditemukan.'); return redir(req, res, 'cetak-stiker'); }
  if (foto && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(foto)) { flash(req, 'danger', 'Format foto tidak didukung.'); return redir(req, res, 'cetak-stiker'); }
  db.prepare('UPDATE barang SET foto = ? WHERE id = ?').run(foto, id);
  flash(req, 'success', 'Foto barang disimpan.');
  redir(req, res, 'cetak-stiker');
});

/* ---- Halaman publik "scan QR lain" ---- */
app.get('/scan-qr', (req, res) => {
  res.render('scan-qr', { page: '', set: getSettings() });
});

/* ---- Halaman publik "cek kode stiker" ---- */
app.get('/cek-barang', (req, res) => {
  const kode = String(req.query.kode || '').trim().toUpperCase();
  let hasil = null;
  if (kode.startsWith('SBQ-')) {
    const id = Number(kode.slice(4));
    hasil = q('SELECT * FROM barang WHERE id = ?', id);
  }
  res.render('cek-barang', { page: '', hasil, kode, set: getSettings() });
});

/* ---- Pengaturan halaman website (khusus admin) ---- */
app.get('/pengaturan-website', requireRoles('admin'), (req, res) => {
  res.render('pengaturan-website', { page: 'pengaturan-website', set: getSettings() });
});
app.post('/pengaturan-website', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;

  // Kembalikan logo ke default
  if (req.body._aksi === 'hapus_logo') {
    db.prepare(`INSERT INTO pengaturan (kunci, nilai) VALUES ('logo_data', '')
                ON CONFLICT(kunci) DO UPDATE SET nilai = ''`).run();
    flash(req, 'success', 'Logo dikembalikan ke logo default.');
    return redir(req, res, 'pengaturan-website');
  }
  if (req.body._aksi === 'hapus_hero_image') {
    db.prepare(`INSERT INTO pengaturan (kunci, nilai) VALUES ('hero_image', '')
                ON CONFLICT(kunci) DO UPDATE SET nilai = ''`).run();
    flash(req, 'success', 'Gambar hero dihapus.');
    return redir(req, res, 'pengaturan-website');
  }

  // Validasi logo & gambar hero (data URI gambar raster)
  const logo = String(req.body.logo_data || '');
  const heroImage = String(req.body.hero_image || '');
  if (logo && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo)) {
    flash(req, 'danger', 'Format logo tidak didukung. Gunakan PNG, JPG, GIF, atau WebP.');
    return redir(req, res, 'pengaturan-website');
  }
  if (heroImage && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(heroImage)) {
    flash(req, 'danger', 'Format gambar hero tidak didukung. Gunakan PNG, JPG, GIF, atau WebP.');
    return redir(req, res, 'pengaturan-website');
  }
  if (logo.length > 4 * 1024 * 1024 || heroImage.length > 4 * 1024 * 1024) {
    flash(req, 'danger', 'Ukuran file terlalu besar (maksimal sekitar 3 MB).');
    return redir(req, res, 'pengaturan-website');
  }

  const keys = ['hero_badge', 'hero_title', 'hero_sub', 'hero_note', 'hero_image', 'kontak_size',
    'title_inventaris', 'title_maintenance', 'title_kontak',
    'btn_login', 'btn_register',
    'sub_inventaris', 'sub_maintenance', 'sub_kontak',
    'kontak_alamat', 'kontak_telepon', 'kontak_email', 'kontak_jam', 'cta_title', 'cta_sub', 'logo_data',
    'header_brand', 'header_tagline', 'footer_text', 'url_website', 'wa_pesan', 'wa_telepon1', 'wa_telepon2', 'wa_label1', 'wa_label2',
    'wa_maintenance', 'wa_maint_label', 'wa_mobil'];
  const upsert = db.prepare(`INSERT INTO pengaturan (kunci, nilai) VALUES (?, ?)
    ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai`);
  db.transaction(() => {
    for (const k of keys) {
      let v = String(req.body[k] || '').trim();
      // Nomor telepon hanya simpan SATU nomor (nomor pertama) — cegah "1,2" / ",," ikut tersimpan
      if (k === 'kontak_telepon' || k === 'wa_telepon1' || k === 'wa_telepon2' || k === 'wa_maintenance' || k === 'wa_mobil') v = normTel(v);
      upsert.run(k, v);
    }
  })();
  // Sinkronkan ikon statis (public/icons/*.png) dgn logo terbaru — best-effort,
  // sehingga semua jalur (file statis, cache lama, WebAPK lama) menampilkan logo website.
  try {
    const logo = bacaLogoKustom();
    if (logo) {
      require('./tools/sync-icons').tulisIkonStatis(logo.buf)
        .then(() => console.log('Ikon statis disinkronkan dengan logo website.'))
        .catch((e) => console.error('(non-fatal) sinkron ikon statis gagal:', e.message));
    }
  } catch (e) { console.error('(non-fatal) sinkron ikon statis gagal:', e.message); }
  flash(req, 'success', 'Pengaturan halaman website berhasil disimpan.');
  redir(req, res, 'pengaturan-website');
});

/* ================= DASHBOARD ================= */
app.get('/index', requireLogin, (req, res) => {
  const me = req.session.user;
  const own = me.role === 'santri';
  autoSelesaikanPeminjamanRuangan();

  const stats = {
    barangJenis: q('SELECT COUNT(*) c FROM barang').c,
    stokTotal: q('SELECT COALESCE(SUM(jumlah_total),0) t FROM barang').t,
    stokTersedia: q('SELECT COALESCE(SUM(jumlah_tersedia),0) t FROM barang').t,
    ruangan: q('SELECT COUNT(*) c FROM ruangan').c,
    pinjamAktif: q("SELECT COUNT(*) c FROM pinjam_ruangan WHERE status='disetujui'").c +
      q("SELECT COUNT(*) c FROM pinjam_barang WHERE status='disetujui'").c +
      q("SELECT COUNT(*) c FROM pinjam_mobil WHERE status='disetujui'").c,
    maintBerjalan: q("SELECT COUNT(*) c FROM maintenance WHERE status IN ('dilaporkan','diperbaiki')").c,
    maintSelesai: q("SELECT COUNT(*) c FROM maintenance WHERE status='selesai'").c,
    biayaMaint: q("SELECT COALESCE(SUM(biaya_aktual),0) t FROM maintenance").t,
    pengguna: q('SELECT COUNT(*) c FROM users').c
  };

  const whereOwn = own ? 'WHERE pr.peminjam_id = ?' : '';
  const recentPR = all(`
    SELECT pr.*, r.nama AS ruangan_nama, u.nama AS peminjam_nama
    FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id
    JOIN users u ON u.id = pr.peminjam_id
    ${whereOwn} ORDER BY pr.id DESC LIMIT 5`, ...(own ? [me.id] : []));

  const recentPB = all(`
    SELECT pb.*, b.nama AS barang_nama, b.satuan, u.nama AS peminjam_nama
    FROM pinjam_barang pb
    JOIN barang b ON b.id = pb.barang_id
    JOIN users u ON u.id = pb.peminjam_id
    ${whereOwn ? 'WHERE pb.peminjam_id = ?' : ''} ORDER BY pb.id DESC LIMIT 5`, ...(own ? [me.id] : []));

  const recentPM = all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat, m.jenis AS mobil_jenis,
           u.nama AS peminjam_nama, COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    ${own ? 'WHERE pm.peminjam_id = ?' : ''} ORDER BY pm.id DESC LIMIT 5`, ...(own ? [me.id] : []));

  const recentM = all(`
    SELECT m.*, u.nama AS pelapor_nama,
           COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m
    JOIN users u ON u.id = m.pelapor_id
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    ${own ? 'WHERE m.pelapor_id = ?' : ''} ORDER BY m.id DESC LIMIT 5`, ...(own ? [me.id] : []));

  // Pengingat otomatis: jadwal (servis/pajak) + service_selanjutnya dari maintenance kendaraan
  const todayMs = Date.parse(lib.today());
  const norm = (s, jenis) => {
    const nextMs = Date.parse(s.tanggal);
    const diff = Math.round((nextMs - todayMs) / 86400000);
    return { id: s.id, objek_nama: s.objek_nama, jenis, service_selanjutnya: s.tanggal, sisa: diff };
  };
  const dariJadwal = all("SELECT id, objek_nama, jenis, jenis_list, tanggal FROM jadwal WHERE status = 'aktif'")
    .map((r) => norm(r, (r.jenis_list || r.jenis).split(',').map((x) => JENIS_JADWAL[x] || x).join(', ')));
  const dariMaint = all(`
    SELECT m.id, COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama, m.service_selanjutnya AS tanggal
    FROM maintenance m
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    WHERE m.kategori = 'kendaraan' AND m.status = 'selesai' AND m.service_selanjutnya != ''`)
    .map((r) => norm(r, 'Service / Perbaikan'));
  const serviceReminder = dariJadwal.concat(dariMaint)
    .filter((s) => s.sisa <= 30)
    .sort((a, b) => a.service_selanjutnya.localeCompare(b.service_selanjutnya));

  res.render('dashboard', { page: 'index', stats, recentPR, recentPB, recentPM, recentM, serviceReminder });
});

/* ================= RUANGAN ================= */
app.get('/ruangan', requireLogin, (req, res) => {
  const list = all(`
    SELECT * FROM ruangan
    WHERE (? = '' OR nama LIKE ? OR lokasi LIKE ?)
    ORDER BY nama ASC`, req.query.q || '', `%${req.query.q || ''}%`, `%${req.query.q || ''}%`)
    .map((r) => ({ ...r, status: ruanganStatus(r.id) }));

  const editId = Number(req.query.edit) || null;
  const edit = editId ? q('SELECT * FROM ruangan WHERE id = ?', editId) : null;
  const busy = (edit && editId)
    ? q('SELECT COUNT(*) c FROM pinjam_ruangan WHERE ruangan_id = ?', editId).c +
      q('SELECT COUNT(*) c FROM maintenance WHERE ruangan_id = ?', editId).c
    : 0;
  const bidangList = all('SELECT * FROM bidang ORDER BY nama ASC');
  res.render('ruangan', { page: 'ruangan', list, edit, busy, q: req.query.q || '', bidangList });
});
app.post('/ruangan', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const { _aksi, id } = req.body;

  // Kelola Bidang / Unit (dipindah dari menu terpisah ke halaman Ruangan)
  if (_aksi === 'tambah_bidang') {
    const namaB = String(req.body.nama_bidang || '').trim();
    if (!namaB) { flash(req, 'danger', 'Nama bidang wajib diisi.'); return redir(req, res, 'ruangan'); }
    db.prepare('INSERT OR IGNORE INTO bidang (nama) VALUES (?)').run(namaB);
    flash(req, 'success', 'Bidang/Unit ditambahkan.');
    return redir(req, res, 'ruangan');
  }
  if (_aksi === 'hapus_bidang') {
    db.prepare('DELETE FROM bidang WHERE id = ?').run(Number(id));
    flash(req, 'success', 'Bidang/Unit dihapus.');
    return redir(req, res, 'ruangan');
  }

  if (_aksi === 'hapus') {
    const rid = Number(id);
    const refs = q('SELECT COUNT(*) c FROM pinjam_ruangan WHERE ruangan_id = ?', rid).c +
      q('SELECT COUNT(*) c FROM maintenance WHERE ruangan_id = ?', rid).c;
    if (refs > 0) {
      flash(req, 'danger', 'Ruangan tidak dapat dihapus karena masih memiliki riwayat peminjaman/maintenance.');
    } else {
      db.prepare('DELETE FROM ruangan WHERE id = ?').run(rid);
      flash(req, 'success', 'Ruangan berhasil dihapus.');
    }
    return redir(req, res, 'ruangan');
  }
  // simpan (tambah / ubah)
  const nama = String(req.body.nama || '').trim();
  if (!nama) { flash(req, 'danger', 'Nama ruangan wajib diisi.'); return redir(req, res, 'ruangan'); }
  const lokasi = String(req.body.lokasi || '').trim();
  const kapasitas = Math.max(0, Number(req.body.kapasitas) || 0);
  const deskripsi = String(req.body.deskripsi || '').trim();
  const golongan = String(req.body.golongan || '').trim();
  const bidangAset = String(req.body.bidang_aset || '').trim();
  const kodeAset = String(req.body.kode_aset || '').trim();
  if (id) {
    db.prepare('UPDATE ruangan SET nama = ?, lokasi = ?, kapasitas = ?, deskripsi = ?, golongan = ?, bidang_aset = ?, kode_aset = ? WHERE id = ?')
      .run(nama, lokasi, kapasitas, deskripsi, golongan, bidangAset, kodeAset, Number(id));
    flash(req, 'success', 'Data ruangan diperbarui.');
  } else {
    db.prepare('INSERT INTO ruangan (nama, lokasi, kapasitas, deskripsi, golongan, bidang_aset, kode_aset) VALUES (?,?,?,?,?,?,?)')
      .run(nama, lokasi, kapasitas, deskripsi, golongan, bidangAset, kodeAset);
    flash(req, 'success', 'Ruangan baru ditambahkan.');
  }
  redir(req, res, 'ruangan');
});

/* ---- Cetak / PDF daftar ruangan (staff) ---- */
app.get('/ruangan/cetak', requireRoles('admin', 'operator'), (req, res) => {
  const list = all('SELECT * FROM ruangan ORDER BY nama ASC')
    .map((r) => ({ ...r, status: ruanganStatus(r.id) }));
  const set = getSettings();
  res.render('ruangan-cetak', { page: 'laporan', list, set });
});

/* ---- Download Excel (CSV) daftar ruangan (staff) — format sama dgn cetak PDF ---- */
app.get('/ruangan/excel', requireRoles('admin', 'operator'), (req, res) => {
  const ST = { tersedia: 'Tersedia', dipakai: 'Dipakai', maintenance: 'Maintenance' };
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Bagian Sarana & Prasarana · Sistem Inventaris'],
    ['Daftar Ruangan & Fasilitas'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Nama Ruangan', 'Golongan', 'Bidang', 'Kode Aset', 'Lokasi', 'Kapasitas', 'Status']
  ];
  all('SELECT * FROM ruangan ORDER BY nama ASC')
    .forEach((r, i) => {
      const st = ruanganStatus(r.id);
      rows.push([i + 1, r.nama, r.golongan || '', r.bidang_aset || '', r.kode_aset || '', r.lokasi || '', r.kapasitas + ' orang', ST[st] || st]);
    });
  sendCsv(res, 'daftar-ruangan', rows);
});

/* ================= BARANG ================= */
app.get('/barang', requireLogin, (req, res) => {
  const kat = String(req.query.kategori || '').trim();
  const list = all(`
    SELECT * FROM barang
    WHERE (? = '' OR nama LIKE ? OR kategori LIKE ? OR lokasi LIKE ?)
      AND (? = '' OR kategori = ?)
    ORDER BY nama ASC`, req.query.q || '', `%${req.query.q || ''}%`, `%${req.query.q || ''}%`, `%${req.query.q || ''}%`, kat, kat);
  const kategories = all(`SELECT DISTINCT kategori FROM barang WHERE kategori != '' ORDER BY kategori ASC`).map((r) => r.kategori);
  // Breakdown inventaris per kategori
  const breakdown = all(`
    SELECT kategori,
           COUNT(*) AS jenis,
           COALESCE(SUM(jumlah_total), 0) AS total,
           COALESCE(SUM(jumlah_tersedia), 0) AS tersedia
    FROM barang GROUP BY kategori ORDER BY kategori ASC`);
  const editId = Number(req.query.edit) || null;
  const edit = editId ? q('SELECT * FROM barang WHERE id = ?', editId) : null;
  res.render('barang', { page: 'barang', list, edit, q: req.query.q || '', kat, kategories, breakdown });
});
app.post('/barang', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const { _aksi, id } = req.body;
  if (_aksi === 'hapus') {
    // Hapus barang tetap khusus admin
    if (!isAdmin(req.session.user)) { flash(req, 'danger', 'Anda tidak memiliki izin untuk tindakan ini.'); return redir(req, res, 'barang'); }
    const bid = Number(id);
    const refs = q('SELECT COUNT(*) c FROM pinjam_barang WHERE barang_id = ?', bid).c +
      q('SELECT COUNT(*) c FROM maintenance WHERE barang_id = ?', bid).c;
    if (refs > 0) {
      flash(req, 'danger', 'Barang tidak dapat dihapus karena masih memiliki riwayat peminjaman/maintenance.');
    } else {
      db.prepare('DELETE FROM barang WHERE id = ?').run(bid);
      flash(req, 'success', 'Barang berhasil dihapus.');
    }
    return redir(req, res, 'barang');
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) { flash(req, 'danger', 'Nama barang wajib diisi.'); return redir(req, res, 'barang'); }
  const kategori = String(req.body.kategori || '').trim();
  const satuan = String(req.body.satuan || 'unit').trim() || 'unit';
  const lokasi = String(req.body.lokasi || '').trim();
  const deskripsi = String(req.body.deskripsi || '').trim();
  const seri = String(req.body.seri || '').trim();
  const foto = String(req.body.foto || '').trim();
  if (foto && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(foto)) { flash(req, 'danger', 'Format foto tidak didukung.'); return redir(req, res, 'barang'); }
  const jumlahTotal = Math.max(0, Number(req.body.jumlah_total) || 0);
  const golongan = String(req.body.golongan || '').trim();
  const bidangAset = String(req.body.bidang_aset || '').trim();
  const kodeAset = String(req.body.kode_aset || '').trim();
  // Kategori baru langsung masuk ke daftar pilihan (sidebar & statistik)
  if (kategori) db.prepare('INSERT OR IGNORE INTO kategori_barang (nama) VALUES (?)').run(kategori);
  if (id) {
    const cur = q('SELECT jumlah_tersedia, jumlah_total FROM barang WHERE id = ?', Number(id));
    // Jumlah tersedia: dari form bila diisi; default mempertahankan selisih yang dipinjam
    let jumlahTersedia = req.body.jumlah_tersedia !== undefined && req.body.jumlah_tersedia !== ''
      ? Math.max(0, Number(req.body.jumlah_tersedia) || 0)
      : Math.max(0, cur.jumlah_tersedia + (jumlahTotal - cur.jumlah_total));
    // Saat total dikurangi/ditambah, tersedia otomatis mengikuti nilai terbaru (tanpa error):
    // tersedia tidak boleh melebihi total, dan tidak negatif.
    if (jumlahTersedia > jumlahTotal) jumlahTersedia = jumlahTotal;
    db.prepare('UPDATE barang SET nama = ?, kategori = ?, jumlah_total = ?, jumlah_tersedia = ?, satuan = ?, lokasi = ?, deskripsi = ?, foto = ?, seri = ?, golongan = ?, bidang_aset = ?, kode_aset = ?, tgl_update = ?, jam_update = ? WHERE id = ?')
      .run(nama, kategori, jumlahTotal, jumlahTersedia, satuan, lokasi, deskripsi, foto, seri, golongan, bidangAset, kodeAset,
        String(req.body.tgl_update || lib.today()), String(req.body.jam_update || nowTime()), Number(id));
    flash(req, 'success', 'Data barang diperbarui.');
  } else {
    db.prepare('INSERT INTO barang (nama, kategori, jumlah_total, jumlah_tersedia, satuan, lokasi, deskripsi, foto, seri, golongan, bidang_aset, kode_aset, tgl_update, jam_update) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nama, kategori, jumlahTotal, jumlahTotal, satuan, lokasi, deskripsi, foto, seri, golongan, bidangAset, kodeAset,
        String(req.body.tgl_update || lib.today()), String(req.body.jam_update || nowTime()));
    flash(req, 'success', 'Barang baru ditambahkan.');
  }
  redir(req, res, 'barang');
});

/* ================= IMPOR EXCEL BARANG (admin & operator) ================= */
/* Kolom file: Nama Barang | Seri | Kategori | Kode Aset | Lokasi | Stok
   Kategori & pengkodean aset (golongan/bidang/sub) dideteksi otomatis dari nama & lokasi. */
app.get('/barang/impor', requireRoles('admin', 'operator'), (req, res) => {
  res.render('barang-impor', { page: 'barang', kat: '', hasil: null, kategories: [] });
});
app.post('/barang/impor', requireRoles('admin', 'operator'), upload.single('file'), (req, res) => {
  if (!postGuard(req, res)) return;
  if (!req.file || !req.file.buffer) { flash(req, 'danger', 'Pilih file Excel (.xlsx/.xls) terlebih dahulu.'); return redir(req, res, 'barang/impor'); }
  let rows = [];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  } catch (e) {
    flash(req, 'danger', 'File tidak dapat dibaca sebagai Excel: ' + e.message);
    return redir(req, res, 'barang/impor');
  }
  // Buang baris judul (bila baris pertama tidak mengandung angka stok & memuat kata 'nama')
  const norm = (v) => String(v == null ? '' : v).trim();
  let start = 0;
  if (rows.length && /nama|barang/i.test(norm(rows[0][0])) && /kategori|kode|lokasi|stok|seri/i.test(rows[0].join(' '))) start = 1;
  const hasil = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const nama = norm(r[0]);
    if (!nama) continue;
    const seri = norm(r[1]);
    const kategoriFile = norm(r[2]);
    const kodeFile = norm(r[3]);
    const lokasi = norm(r[4]);
    const stokMentah = norm(r[5]);
    const stok = Math.max(0, Number(String(stokMentah).replace(/[^\d.-]/g, '')) || 0);
    const det = importBarang.deteksiBaris(nama, lokasi);
    // Kategori: tebak otomatis dari nama; bila kolom kategori terisi namun nama tak terdeteksi,
    // pakai isi kolom tsb. Kode aset: pakai kolom file bila ada, jika tidak -> hasil deteksi.
    const kategori = det.kategori || kategoriFile || '';
    let gol = det.golongan, bid = det.bidang_aset, kodeAset = kodeFile || det.kode_aset;
    // Fallback: bila kode aset belum dapat, cari dari data RUANGAN yang namanya cocok dgn lokasi
    // (ruangan sudah punya golongan/bidang/kode aset di menu Ruangan)
    let kodeRuangan = '';
    if (!kodeAset && lokasi) {
      const lk = lokasi.toLowerCase();
      const room = all("SELECT nama, golongan, bidang_aset, kode_aset FROM ruangan WHERE kode_aset <> ''")
        .find((r) => {
          const rn = String(r.nama || '').toLowerCase();
          return rn && (lk.includes(rn) || rn.includes(lk));
        });
      if (room) {
        gol = room.golongan; bid = room.bidang_aset; kodeAset = room.kode_aset; kodeRuangan = room.nama;
      }
    }
    hasil.push({ baris: i + 1, nama, seri, kategori, kategoriFile, kode_aset: kodeAset, kode_deteksi: kodeAset, golongan: gol, bidang_aset: bid, lokasi, stok, satuan: 'unit', kodeRuangan });
  }
  const kategories = all(`SELECT nama FROM kategori_barang ORDER BY nama ASC`).map((x) => x.nama);
  res.render('barang-impor', { page: 'barang', kat: '', hasil, kategories, namaFile: req.file.originalname });
});
app.post('/barang/impor/simpan', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const arr = (k) => (Array.isArray(req.body[k]) ? req.body[k] : (req.body[k] === undefined ? [] : [req.body[k]]));
  const nama = arr('nama'), seri = arr('seri'), kategori = arr('kategori'), kodeAset = arr('kode_aset'),
    lokasi = arr('lokasi'), stok = arr('stok'), golongan = arr('golongan'), bidang = arr('bidang_aset'), pilih = arr('pilih');
  const ins = db.prepare(`INSERT INTO barang (nama, kategori, jumlah_total, jumlah_tersedia, satuan, lokasi, deskripsi, seri, golongan, bidang_aset, kode_aset, tgl_update, jam_update)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insKat = db.prepare('INSERT OR IGNORE INTO kategori_barang (nama) VALUES (?)');
  let n = 0;
  const tgl = lib.today(), jam = nowTime();
  db.transaction(() => {
    for (let i = 0; i < nama.length; i++) {
      if (String(pilih[i] || '') !== '1') continue;           // hanya baris yang dicentang
      const nm = String(nama[i] || '').trim();
      if (!nm) continue;
      const jml = Math.max(0, Number(stok[i]) || 0);
      const kat = String(kategori[i] || '').trim();
      ins.run(nm, kat, jml, jml, 'unit', String(lokasi[i] || '').trim(), '', String(seri[i] || '').trim(),
        String(golongan[i] || '').trim(), String(bidang[i] || '').trim(), String(kodeAset[i] || '').trim(), tgl, jam);
      if (kat) insKat.run(kat);
      n++;
    }
  })();
  flash(req, n ? 'success' : 'danger', n ? `${n} barang berhasil diimpor (kategori & kode aset terisi otomatis).` : 'Tidak ada baris yang dipilih untuk diimpor.');
  redir(req, res, 'barang');
});

/* ================= PEMINJAMAN RUANGAN ================= */
/* Cek tabrakan: peminjaman DISETUJUI yang tanggalnya tumpang tindih + jamnya tumpang tindih.
   Mengembalikan daftar bentrok lengkap (nama ruangan + nama peminjam) untuk notifikasi yang jelas. */
function cekTabrakanRuangan(ruanganId, mulai, selesai, jamMulai, jamSelesai, excludeId) {
  const clauses = [`pr.ruangan_id = ?`, `pr.status = 'disetujui'`, `pr.tanggal_mulai <= ?`, `pr.tanggal_selesai >= ?`];
  const params = [ruanganId, selesai, mulai];
  if (excludeId) { clauses.push('pr.id != ?'); params.push(excludeId); }
  const rows = all(`
    SELECT pr.*, r.nama AS ruangan_nama, COALESCE(NULLIF(pr.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id
    JOIN users u ON u.id = pr.peminjam_id
    WHERE ${clauses.join(' AND ')}`, ...params);
  return rows.filter((b) => {
    const b1 = b.jam_mulai || '00:00', b2 = b.jam_selesai || '23:59';
    return jamMulai < b2 && b1 < jamSelesai;
  });
}
function pesanRuanganDipinjam(b) {
  return `Ruangan "${b.ruangan_nama}" telah dipinjam pada ${lib.fmtDateShort(b.tanggal_mulai)} ${b.jam_mulai || '08:00'}–${b.jam_selesai || '17:00'} WIB oleh ${b.peminjam_tampil}. Silakan pilih ruangan atau waktu lain.`;
}
app.get('/peminjaman-ruangan', requireLogin, (req, res) => {
  const me = req.session.user;
  const st = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const gol = String(req.query.golongan || '').trim();
  const own = me.role === 'santri';
  autoSelesaikanPeminjamanRuangan();
  const qs = String(req.query.q || '').trim();
  // Daftar peminjaman ruangan:
  //  - staf (admin/operator) melihat semua
  //  - santri/guru melihat pengajuan MILIKNYA SENDIRI (semua status) PLUS seluruh
  //    peminjaman yang sudah DISETUJUI (data ini sudah tampil publik di website,
  //    jadi tidak ada data pribadi berstatus menunggu/ditolak yang terekspos).
  const list = all(`
    SELECT pr.*, r.nama AS ruangan_nama, u.nama AS peminjam_nama, u.username AS peminjam_username
    FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id
    JOIN users u ON u.id = pr.peminjam_id
    WHERE (? = '' OR pr.status = ?)
      AND (? = 1 OR pr.peminjam_id = ? OR pr.status = 'disetujui')
      AND (? = '' OR r.golongan = ?)
      AND (? = '' OR r.nama LIKE ? OR pr.keperluan LIKE ? OR COALESCE(pr.nama_peminjam, u.nama) LIKE ? OR pr.nomor_peminjam LIKE ? OR pr.bidang LIKE ?)
    ORDER BY pr.id DESC`, st, st, own ? 0 : 1, me.id,
    gol, gol,
    qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  const rooms = all('SELECT * FROM ruangan ORDER BY nama ASC');
  const bidangList = all('SELECT nama FROM bidang ORDER BY nama ASC').map((r) => r.nama);
  const preselect = Number(req.query.ruangan_id) || 0;
  const editId = Number(req.query.edit) || 0;
  const edit = editId ? q('SELECT * FROM pinjam_ruangan WHERE id = ?', editId) : null;
  if (edit && me.role !== 'santri' && edit.peminjam_id !== me.id && !isManageStaff(me)) edit.id = null;
  // Jadwal pinjam DISETUJUI untuk ruangan yang sedang dipilih/diedit — tampil sebagai notifikasi di form
  let roomJadwal = [];
  const noticeRoomId = edit && edit.id ? edit.ruangan_id : preselect;
  if (noticeRoomId) {
    roomJadwal = all(`
      SELECT pr.*, COALESCE(NULLIF(pr.nama_peminjam, ''), u.nama) AS peminjam_tampil
      FROM pinjam_ruangan pr JOIN users u ON u.id = pr.peminjam_id
      WHERE pr.ruangan_id = ? AND pr.status = 'disetujui' AND pr.tanggal_selesai >= ?
      ORDER BY pr.tanggal_mulai ASC, pr.jam_mulai ASC`, noticeRoomId, lib.today());
  }
  res.render('peminjaman-ruangan', { page: 'peminjaman-ruangan', list, rooms, bidangList, filter: st, gol, preselect, edit, q: qs, roomJadwal });
});
app.post('/peminjaman-ruangan/:id', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const row = q('SELECT * FROM pinjam_ruangan WHERE id = ?', id);
  const me = req.session.user;
  if (!row) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'peminjaman-ruangan'); }
  if (me.role === 'santri' && row.peminjam_id !== me.id) { flash(req, 'danger', 'Anda tidak berhak mengubah data ini.'); return redir(req, res, 'peminjaman-ruangan'); }
  // Staf (admin/operator) boleh mengoreksi data peminjaman apa pun statusnya; pemilik hanya saat pending/ditolak
  if (!isManageStaff(me) && !['pending', 'ditolak'].includes(row.status)) {
    flash(req, 'danger', 'Peminjaman sudah diproses, tidak dapat diedit.');
    return redir(req, res, 'peminjaman-ruangan');
  }
  let ruanganId = Number(req.body.ruangan_id) || row.ruangan_id;
  // Tambah ruangan baru langsung dari form (staff)
  if (ruanganId === 0 && isManageStaff(me)) {
    const namaBaru = String(req.body.nama_ruangan_baru || '').trim();
    if (!namaBaru) { flash(req, 'danger', 'Isi nama ruangan baru.'); return redir(req, res, `peminjaman-ruangan?edit=${id}`); }
    const info = db.prepare('INSERT INTO ruangan (nama, lokasi) VALUES (?,?)')
      .run(namaBaru, String(req.body.lokasi_ruangan_baru || '').trim());
    ruanganId = info.lastInsertRowid;
  }
  const keperluan = String(req.body.keperluan || '').trim() || row.keperluan;
  const namaPeminjam = String(req.body.nama_peminjam || '').trim() || row.nama_peminjam;
  const jumlahPeserta = Math.max(0, Number(req.body.jumlah_peserta) || 0);
  const mulai = String(req.body.tanggal_mulai || '') || row.tanggal_mulai;
  const selesai = String(req.body.tanggal_selesai || '') || row.tanggal_selesai;
  const jamMulai = String(req.body.jam_mulai || '') || row.jam_mulai;
  const jamSelesai = String(req.body.jam_selesai || '') || row.jam_selesai;
  const nomorPeminjam = String(req.body.nomor_peminjam || '').trim();
  const bidang = String(req.body.bidang || '').trim();
  const catatan = String(req.body.catatan || '').trim();
  // Staf boleh mengubah status lewat form edit (mis. kembalikan ke "Menunggu")
  const ST_ALLOWED = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'];
  const statusBaru = isManageStaff(me) && ST_ALLOWED.includes(req.body.status) ? req.body.status : row.status;
  if (mulai > selesai || (mulai === selesai && jamSelesai <= jamMulai)) { flash(req, 'danger', 'Rentang waktu tidak valid.'); return redir(req, res, `peminjaman-ruangan?edit=${id}`); }
  // Cek tabrakan hanya relevan bila hasilnya tetap/bakal berstatus disetujui
  if (statusBaru === 'disetujui') {
    const bentrokList = cekTabrakanRuangan(ruanganId, mulai, selesai, jamMulai, jamSelesai, id);
    if (bentrokList.length) { flash(req, 'danger', pesanRuanganDipinjam(bentrokList[0])); return redir(req, res, `peminjaman-ruangan?edit=${id}`); }
  }
  db.prepare(`UPDATE pinjam_ruangan SET ruangan_id = ?, nama_peminjam = ?, keperluan = ?, jumlah_peserta = ?, tanggal_mulai = ?, tanggal_selesai = ?, jam_mulai = ?, jam_selesai = ?, nomor_peminjam = ?, bidang = ?, catatan = ?, status = ? WHERE id = ?`)
    .run(ruanganId, namaPeminjam, keperluan, jumlahPeserta, mulai, selesai, jamMulai, jamSelesai, nomorPeminjam, bidang, catatan, statusBaru, id);
  flash(req, 'success', 'Data peminjaman ruangan diperbarui.');
  redir(req, res, 'peminjaman-ruangan');
});
app.post('/peminjaman-ruangan', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi, id } = req.body;

  if (_aksi === 'ajukan') {
    let ruanganId = Number(req.body.ruangan_id);
    // Tambah ruangan baru langsung dari form (staff)
    if (ruanganId === 0 && isManageStaff(me)) {
      const namaBaru = String(req.body.nama_ruangan_baru || '').trim();
      if (!namaBaru) { flash(req, 'danger', 'Isi nama ruangan baru.'); return redir(req, res, 'peminjaman-ruangan'); }
      const info = db.prepare('INSERT INTO ruangan (nama, lokasi) VALUES (?,?)')
        .run(namaBaru, String(req.body.lokasi_ruangan_baru || '').trim());
      ruanganId = info.lastInsertRowid;
    }
    const keperluan = String(req.body.keperluan || '').trim();
    const namaPeminjam = String(req.body.nama_peminjam || '').trim();
    const jumlahPeserta = Math.max(0, Number(req.body.jumlah_peserta) || 0);
    const mulai = String(req.body.tanggal_mulai || '');
    const selesai = String(req.body.tanggal_selesai || '');
    const jamMulai = String(req.body.jam_mulai || '');
    const jamSelesai = String(req.body.jam_selesai || '');
    const nomorPeminjam = String(req.body.nomor_peminjam || '').trim();
    const bidang = String(req.body.bidang || '').trim();
    const catatan = String(req.body.catatan || '').trim();
    if (!ruanganId || !keperluan || !namaPeminjam || !mulai || !selesai || !jamMulai || !jamSelesai) { flash(req, 'danger', 'Lengkapi semua kolom wajib.'); return redir(req, res, 'peminjaman-ruangan'); }
    if (!validTime(jamMulai) || !validTime(jamSelesai)) { flash(req, 'danger', 'Format jam tidak valid.'); return redir(req, res, 'peminjaman-ruangan'); }
    if (mulai > selesai) { flash(req, 'danger', 'Tanggal selesai tidak boleh sebelum tanggal mulai.'); return redir(req, res, 'peminjaman-ruangan'); }
    if (mulai === selesai && jamSelesai <= jamMulai) { flash(req, 'danger', 'Jam selesai harus setelah jam mulai.'); return redir(req, res, 'peminjaman-ruangan'); }
    if (mulai < lib.today()) { flash(req, 'danger', 'Tanggal mulai tidak boleh di masa lalu.'); return redir(req, res, 'peminjaman-ruangan'); }
    // Bentrok bila tanggal tumpang tindih DAN rentang jam juga tumpang tindih
    // (jam_mulai/jam_selesai berlaku setiap hari dalam rentang tanggal).
    const bentrokList = cekTabrakanRuangan(ruanganId, mulai, selesai, jamMulai, jamSelesai);
    if (bentrokList.length) {
      flash(req, 'danger', pesanRuanganDipinjam(bentrokList[0]));
      return redir(req, res, 'peminjaman-ruangan');
    }
    db.prepare('INSERT INTO pinjam_ruangan (ruangan_id, peminjam_id, nama_peminjam, keperluan, jumlah_peserta, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai, nomor_peminjam, bidang, catatan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ruanganId, me.id, namaPeminjam, keperluan, jumlahPeserta, mulai, selesai, jamMulai, jamSelesai, nomorPeminjam, bidang, catatan);
    flash(req, 'success', 'Pengajuan terkirim. Konfirmasi melalui WhatsApp supaya segera diproses.');
    return redir(req, res, 'peminjaman-ruangan');
  }

  const row = id ? q('SELECT * FROM pinjam_ruangan WHERE id = ?', Number(id)) : null;
  if (!row) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'peminjaman-ruangan'); }
  const owner = me.id === row.peminjam_id;

  if (_aksi === 'batalkan' && (owner || isAdmin(me))) {
    if (row.status === 'pending') {
      db.prepare("UPDATE pinjam_ruangan SET status = 'dibatalkan' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Pengajuan dibatalkan.');
    } else flash(req, 'danger', 'Hanya pengajuan dengan status menunggu yang dapat dibatalkan.');
  } else if (_aksi === 'setujui' && isManageStaff(me)) {
    if (row.status === 'pending') {
      db.prepare("UPDATE pinjam_ruangan SET status = 'disetujui' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Peminjaman ruangan disetujui.');
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'tolak' && isManageStaff(me)) {
    if (row.status === 'pending') {
      const alasan = String(req.body.catatan || '').trim();
      db.prepare("UPDATE pinjam_ruangan SET status = 'ditolak', catatan = ? WHERE id = ?").run(alasan, row.id);
      flash(req, 'success', 'Pengajuan ditolak.');
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'selesai' && isManageStaff(me)) {
    if (row.status === 'disetujui') {
      db.prepare("UPDATE pinjam_ruangan SET status = 'selesai' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Peminjaman ditandai selesai.');
    } else flash(req, 'danger', 'Hanya peminjaman disetujui yang dapat diselesaikan.');
  } else if (_aksi === 'hapus' && isAdmin(me)) {
    db.prepare('DELETE FROM pinjam_ruangan WHERE id = ?').run(row.id);
    flash(req, 'success', 'Data peminjaman dihapus.');
  } else {
    flash(req, 'danger', 'Anda tidak memiliki izin untuk tindakan ini.');
  }
  redir(req, res, 'peminjaman-ruangan');
});

/* ================= PEMINJAMAN BARANG ================= */
app.get('/peminjaman-barang', requireLogin, (req, res) => {
  const me = req.session.user;
  const st = ['pending', 'disetujui', 'ditolak', 'dikembalikan', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const own = me.role === 'santri';
  const qs = String(req.query.q || '').trim();
  const list = all(`
    SELECT pb.*, b.nama AS barang_nama, b.satuan, u.nama AS peminjam_nama, u.username AS peminjam_username
    FROM pinjam_barang pb
    JOIN barang b ON b.id = pb.barang_id
    JOIN users u ON u.id = pb.peminjam_id
    WHERE (? = '' OR pb.status = ?) AND (? = 1 OR pb.peminjam_id = ?)
      AND (? = '' OR b.nama LIKE ? OR pb.keperluan LIKE ? OR u.nama LIKE ? OR pb.nama_peminjam LIKE ? OR pb.nomor_peminjam LIKE ?)
    ORDER BY pb.id DESC`, st, st, own ? 0 : 1, me.id,
    qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  const items = all('SELECT * FROM barang WHERE jumlah_tersedia > 0 ORDER BY nama ASC');
  const preselect = Number(req.query.barang_id) || 0;
  res.render('peminjaman-barang', { page: 'peminjaman-barang', list, items, filter: st, preselect, q: qs });
});
app.post('/peminjaman-barang', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi, id } = req.body;

  if (_aksi === 'ajukan') {
    let barangId = Number(req.body.barang_id);
    const jumlah = Number(req.body.jumlah) || 0;
    const keperluan = String(req.body.keperluan || '').trim();
    const namaPeminjam = String(req.body.nama_peminjam || '').trim();
    const nomorPeminjam = String(req.body.nomor_peminjam || '').trim();
    const pinjam = String(req.body.tanggal_pinjam || '');
    const kembali = String(req.body.tanggal_kembali || '');
    const jamMulai = String(req.body.jam_mulai || '');
    const jamSelesai = String(req.body.jam_selesai || '');
    const catatan = String(req.body.catatan || '').trim();
    // Tambah barang baru langsung dari form (staff)
    if (barangId === 0 && isManageStaff(me)) {
      const namaBaru = String(req.body.nama_barang_baru || '').trim();
      if (!namaBaru) { flash(req, 'danger', 'Isi nama barang baru.'); return redir(req, res, 'peminjaman-barang'); }
      const jmlBaru = Math.max(jumlah, 1);
      const info = db.prepare('INSERT INTO barang (nama, kategori, jumlah_total, jumlah_tersedia, satuan, lokasi, deskripsi) VALUES (?,?,?,?,?,?,?)')
        .run(namaBaru, String(req.body.kategori_barang_baru || 'Lainnya').trim(), jmlBaru, jmlBaru,
          String(req.body.satuan_barang_baru || 'unit').trim(), '', '');
      barangId = info.lastInsertRowid;
    }
    const item = barangId ? q('SELECT * FROM barang WHERE id = ?', barangId) : null;
    if (!item) { flash(req, 'danger', 'Pilih barang yang valid.'); return redir(req, res, 'peminjaman-barang'); }
    if (!keperluan || !namaPeminjam || !nomorPeminjam || !pinjam || !kembali || !jamMulai || !jamSelesai) { flash(req, 'danger', 'Lengkapi semua kolom wajib.'); return redir(req, res, 'peminjaman-barang'); }
    if (!validTime(jamMulai) || !validTime(jamSelesai)) { flash(req, 'danger', 'Format jam tidak valid.'); return redir(req, res, 'peminjaman-barang'); }
    if (jumlah < 1 || jumlah > item.jumlah_tersedia) { flash(req, 'danger', `Jumlah peminjaman tidak valid (tersedia ${item.jumlah_tersedia} ${item.satuan}).`); return redir(req, res, 'peminjaman-barang'); }
    if (pinjam > kembali) { flash(req, 'danger', 'Tanggal kembali tidak boleh sebelum tanggal pinjam.'); return redir(req, res, 'peminjaman-barang'); }
    if (pinjam === kembali && jamSelesai <= jamMulai) { flash(req, 'danger', 'Jam selesai harus setelah jam mulai.'); return redir(req, res, 'peminjaman-barang'); }
    if (pinjam < lib.today()) { flash(req, 'danger', 'Tanggal pinjam tidak boleh di masa lalu.'); return redir(req, res, 'peminjaman-barang'); }
    db.prepare('INSERT INTO pinjam_barang (barang_id, peminjam_id, nama_peminjam, nomor_peminjam, jumlah, keperluan, tanggal_pinjam, tanggal_kembali, jam_mulai, jam_selesai, catatan) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(barangId, me.id, namaPeminjam, nomorPeminjam, jumlah, keperluan, pinjam, kembali, jamMulai, jamSelesai, catatan);
    flash(req, 'success', 'Pengajuan terkirim. Konfirmasi melalui WhatsApp supaya segera diproses.');
    return redir(req, res, 'peminjaman-barang');
  }

  const row = id ? q('SELECT * FROM pinjam_barang WHERE id = ?', Number(id)) : null;
  if (!row) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'peminjaman-barang'); }
  const owner = me.id === row.peminjam_id;

  if (_aksi === 'batalkan' && (owner || isAdmin(me))) {
    if (row.status === 'pending') {
      db.prepare("UPDATE pinjam_barang SET status = 'dibatalkan' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Pengajuan dibatalkan.');
    } else flash(req, 'danger', 'Hanya pengajuan dengan status menunggu yang dapat dibatalkan.');
  } else if (_aksi === 'setujui' && isManageStaff(me)) {
    if (row.status === 'pending') {
      const item = q('SELECT * FROM barang WHERE id = ?', row.barang_id);
      if (item.jumlah_tersedia >= row.jumlah) {
        const update = db.transaction(() => {
          db.prepare('UPDATE barang SET jumlah_tersedia = jumlah_tersedia - ? WHERE id = ?').run(row.jumlah, row.barang_id);
          db.prepare("UPDATE pinjam_barang SET status = 'disetujui' WHERE id = ?").run(row.id);
        });
        update();
        flash(req, 'success', 'Peminjaman disetujui, stok berkurang.');
      } else {
        flash(req, 'danger', `Stok tidak mencukupi (tersisa ${item.jumlah_tersedia} ${item.satuan}).`);
      }
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'tolak' && isManageStaff(me)) {
    if (row.status === 'pending') {
      const alasan = String(req.body.catatan || '').trim();
      db.prepare("UPDATE pinjam_barang SET status = 'ditolak', catatan = ? WHERE id = ?").run(alasan, row.id);
      flash(req, 'success', 'Pengajuan ditolak.');
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'kembalikan' && isManageStaff(me)) {
    if (row.status === 'disetujui') {
      const update = db.transaction(() => {
        db.prepare('UPDATE barang SET jumlah_tersedia = jumlah_tersedia + ? WHERE id = ?').run(row.jumlah, row.barang_id);
        db.prepare("UPDATE pinjam_barang SET status = 'dikembalikan', tanggal_kembali = ? WHERE id = ?").run(lib.today(), row.id);
      });
      update();
      flash(req, 'success', 'Barang ditandai telah dikembalikan, stok kembali.');
    } else flash(req, 'danger', 'Hanya peminjaman berstatus dipinjam yang dapat dikembalikan.');
  } else if (_aksi === 'hapus' && isAdmin(me)) {
    // Hapus data; jika barang sedang dipinjam, kembalikan stok dulu
    if (row.status === 'disetujui') {
      db.prepare('UPDATE barang SET jumlah_tersedia = jumlah_tersedia + ? WHERE id = ?').run(row.jumlah, row.barang_id);
    }
    db.prepare('DELETE FROM pinjam_barang WHERE id = ?').run(row.id);
    flash(req, 'success', 'Data peminjaman dihapus.');
  } else {
    flash(req, 'danger', 'Anda tidak memiliki izin untuk tindakan ini.');
  }
  redir(req, res, 'peminjaman-barang');
});

/* ================= DATA MOBIL (staff) ================= */
app.get('/mobil', requireLogin, (req, res) => {
  const qs = String(req.query.q || '').trim();
  const list = all(`
    SELECT * FROM mobil
    WHERE (? = '' OR nama LIKE ? OR plat LIKE ? OR jenis LIKE ? OR keterangan LIKE ?)
    ORDER BY nama ASC`, qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`)
    .map((m) => ({ ...m, statusTampil: mobilStatus(m.id) }));
  const editId = Number(req.query.edit) || null;
  const edit = editId ? q('SELECT * FROM mobil WHERE id = ?', editId) : null;
  const dipinjam = editId ? q('SELECT COUNT(*) c FROM pinjam_mobil WHERE mobil_id = ?', editId).c : 0;
  res.render('mobil', { page: 'mobil', list, edit, busy: dipinjam, q: qs });
});
app.post('/mobil', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const { _aksi, id } = req.body;
  if (_aksi === 'hapus') {
    if (!isAdmin(req.session.user)) { flash(req, 'danger', 'Hanya admin yang dapat menghapus data mobil.'); return redir(req, res, 'mobil'); }
    const mid = Number(id);
    const refs = q('SELECT COUNT(*) c FROM pinjam_mobil WHERE mobil_id = ?', mid).c;
    if (refs > 0) {
      flash(req, 'danger', 'Mobil tidak dapat dihapus karena masih memiliki riwayat peminjaman.');
    } else {
      db.prepare('DELETE FROM mobil WHERE id = ?').run(mid);
      flash(req, 'success', 'Data mobil dihapus.');
    }
    return redir(req, res, 'mobil');
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) { flash(req, 'danger', 'Nama mobil wajib diisi.'); return redir(req, res, 'mobil'); }
  const plat = String(req.body.plat || '').trim().toUpperCase();
  const jenis = String(req.body.jenis || '').trim();
  const kapasitas = Math.max(0, Number(req.body.kapasitas) || 0);
  const keterangan = String(req.body.keterangan || '').trim();
  const statusM = ['aktif', 'maintenance', 'nonaktif'].includes(req.body.status) ? req.body.status : 'aktif';
  if (id) {
    db.prepare('UPDATE mobil SET nama = ?, plat = ?, jenis = ?, kapasitas = ?, keterangan = ?, status = ? WHERE id = ?')
      .run(nama, plat, jenis, kapasitas, keterangan, statusM, Number(id));
    flash(req, 'success', 'Data mobil diperbarui.');
  } else {
    db.prepare('INSERT INTO mobil (nama, plat, jenis, kapasitas, keterangan, status) VALUES (?,?,?,?,?,?)')
      .run(nama, plat, jenis, kapasitas, keterangan, statusM);
    flash(req, 'success', 'Mobil baru ditambahkan.');
  }
  redir(req, res, 'mobil');
});

/* ================= PEMINJAMAN MOBIL ================= */
app.get('/peminjaman-mobil', requireLogin, (req, res) => {
  const me = req.session.user;
  const st = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const own = me.role === 'santri';
  const qs = String(req.query.q || '').trim();
  autoSelesaikanPeminjamanRuangan();
  const list = all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat, m.jenis AS mobil_jenis, m.kapasitas AS mobil_kapasitas,
           u.nama AS peminjam_nama, u.username AS peminjam_username
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    WHERE (? = '' OR pm.status = ?) AND (? = 1 OR pm.peminjam_id = ?)
      AND (? = '' OR m.nama LIKE ? OR m.plat LIKE ? OR pm.keperluan LIKE ? OR COALESCE(pm.nama_peminjam, u.nama) LIKE ? OR pm.nomor_peminjam LIKE ?)
    ORDER BY pm.id DESC`, st, st, own ? 0 : 1, me.id,
    qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  // statusAsli = kolom status di DB (aktif/maintenance/nonaktif) -> dipakai untuk menentukan
  // apakah mobil BOLEH dipilih di dropdown; status = status tampilan (tersedia/dipakai/maintenance/nonaktif).
  const mobils = all('SELECT * FROM mobil ORDER BY nama ASC')
    .map((m) => ({ ...m, statusAsli: m.status, status: mobilStatus(m.id) }));
  const preselect = Number(req.query.mobil_id) || 0;
  const editId = Number(req.query.edit) || 0;
  const edit = editId ? q('SELECT * FROM pinjam_mobil WHERE id = ?', editId) : null;
  if (edit && own && edit.peminjam_id !== me.id) edit.id = null;
  // Jadwal pinjam yang sudah disetujui untuk mobil terpilih -> tampil sebagai pemberitahuan di form
  const noticeId = edit && edit.id ? edit.mobil_id : preselect;
  const mobilJadwal = noticeId ? all(`
    SELECT pm.*, COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm JOIN users u ON u.id = pm.peminjam_id
    WHERE pm.mobil_id = ? AND pm.status = 'disetujui' AND pm.tanggal_selesai >= ?
    ORDER BY pm.tanggal_mulai ASC, pm.jam_mulai ASC`, noticeId, lib.today()) : [];
  // Nomor WhatsApp info peminjaman mobil (wajib di-chat pengaju sebelum mengisi formulir)
  const waMobil = waMobilInfo(getSettings());
  res.render('peminjaman-mobil', { page: 'peminjaman-mobil', list, mobils, filter: st, preselect, edit, q: qs, mobilJadwal, waMobil });
});
app.post('/peminjaman-mobil/:id', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const row = q('SELECT * FROM pinjam_mobil WHERE id = ?', id);
  const me = req.session.user;
  if (!row) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'peminjaman-mobil'); }
  if (me.role === 'santri' && row.peminjam_id !== me.id) { flash(req, 'danger', 'Anda tidak berhak mengubah data ini.'); return redir(req, res, 'peminjaman-mobil'); }
  if (!isManageStaff(me) && !['pending', 'ditolak'].includes(row.status)) {
    flash(req, 'danger', 'Peminjaman sudah diproses, tidak dapat diedit.');
    return redir(req, res, 'peminjaman-mobil');
  }
  const mobilId = Number(req.body.mobil_id) || row.mobil_id;
  const keperluan = String(req.body.keperluan || '').trim() || row.keperluan;
  const namaPeminjam = String(req.body.nama_peminjam || '').trim() || row.nama_peminjam;
  const nomorPeminjam = String(req.body.nomor_peminjam || '').trim() || row.nomor_peminjam;
  const penumpang = Math.max(0, Number(req.body.jumlah_penumpang) || 0);
  const mulai = String(req.body.tanggal_mulai || '') || row.tanggal_mulai;
  const selesai = String(req.body.tanggal_selesai || '') || row.tanggal_selesai;
  const jamMulai = String(req.body.jam_mulai || '') || row.jam_mulai;
  const jamSelesai = String(req.body.jam_selesai || '') || row.jam_selesai;
  const catatan = String(req.body.catatan || '').trim();
  const ST_ALLOWED = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'];
  const statusBaru = isManageStaff(me) && ST_ALLOWED.includes(req.body.status) ? req.body.status : row.status;
  if (!q('SELECT id FROM mobil WHERE id = ?', mobilId)) { flash(req, 'danger', 'Pilih mobil yang valid.'); return redir(req, res, `peminjaman-mobil?edit=${id}`); }
  if (mulai > selesai || (mulai === selesai && jamSelesai <= jamMulai)) { flash(req, 'danger', 'Rentang waktu tidak valid.'); return redir(req, res, `peminjaman-mobil?edit=${id}`); }
  if (statusBaru === 'disetujui') {
    const bentrok = cekTabrakanMobil(mobilId, mulai, selesai, jamMulai, jamSelesai, id);
    if (bentrok.length) { flash(req, 'danger', pesanMobilDipinjam(bentrok[0])); return redir(req, res, `peminjaman-mobil?edit=${id}`); }
  }
  db.prepare(`UPDATE pinjam_mobil SET mobil_id = ?, nama_peminjam = ?, nomor_peminjam = ?, jumlah_penumpang = ?, keperluan = ?, tanggal_mulai = ?, tanggal_selesai = ?, jam_mulai = ?, jam_selesai = ?, catatan = ?, status = ? WHERE id = ?`)
    .run(mobilId, namaPeminjam, nomorPeminjam, penumpang, keperluan, mulai, selesai, jamMulai, jamSelesai, catatan, statusBaru, id);
  flash(req, 'success', 'Data peminjaman mobil diperbarui.');
  redir(req, res, 'peminjaman-mobil');
});
app.post('/peminjaman-mobil', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi, id } = req.body;

  if (_aksi === 'ajukan') {
    const mobilId = Number(req.body.mobil_id);
    const keperluan = String(req.body.keperluan || '').trim();
    const namaPeminjam = String(req.body.nama_peminjam || '').trim();
    const nomorPeminjam = String(req.body.nomor_peminjam || '').trim();
    const penumpang = Math.max(0, Number(req.body.jumlah_penumpang) || 0);
    const mulai = String(req.body.tanggal_mulai || '');
    const selesai = String(req.body.tanggal_selesai || '');
    const jamMulai = String(req.body.jam_mulai || '');
    const jamSelesai = String(req.body.jam_selesai || '');
    const catatan = String(req.body.catatan || '').trim();
    // kembali ke formulir dengan mobil yang tadi dipilih tetap terpilih
    const formBack = 'peminjaman-mobil' + (mobilId ? '?mobil_id=' + mobilId : '') + '#formPeminjaman';
    const mobil = mobilId ? q('SELECT * FROM mobil WHERE id = ?', mobilId) : null;
    if (!mobil) { flash(req, 'danger', 'Pilih mobil yang tersedia terlebih dahulu.'); return redir(req, res, 'peminjaman-mobil'); }
    if (mobil.status !== 'aktif') { flash(req, 'danger', `Mobil "${mobil.nama}" sedang ${mobil.status === 'maintenance' ? 'maintenance' : 'tidak aktif'}, tidak dapat dipinjam.`); return redir(req, res, formBack); }
    if (!keperluan || !namaPeminjam || !nomorPeminjam || !mulai || !selesai || !jamMulai || !jamSelesai) {
      flash(req, 'danger', 'Lengkapi semua kolom wajib.'); return redir(req, res, formBack);
    }
    // WAJIB: pengaju sudah chat WhatsApp ke nomor info peminjaman mobil (langkah 1)
    if (String(req.body.wa_konfirmasi || '') !== '1') {
      flash(req, 'danger', `Konfirmasi WhatsApp wajib: chat dulu ke ${waMobilInfo(getSettings()).label} sebelum mengirim pengajuan peminjaman mobil.`);
      return redir(req, res, formBack);
    }
    if (!validTime(jamMulai) || !validTime(jamSelesai)) { flash(req, 'danger', 'Format jam tidak valid.'); return redir(req, res, formBack); }
    if (mulai > selesai) { flash(req, 'danger', 'Tanggal selesai tidak boleh sebelum tanggal mulai.'); return redir(req, res, formBack); }
    if (mulai === selesai && jamSelesai <= jamMulai) { flash(req, 'danger', 'Jam selesai harus setelah jam mulai.'); return redir(req, res, formBack); }
    if (mulai < lib.today()) { flash(req, 'danger', 'Tanggal mulai tidak boleh di masa lalu.'); return redir(req, res, formBack); }
    const bentrok = cekTabrakanMobil(mobilId, mulai, selesai, jamMulai, jamSelesai);
    if (bentrok.length) { flash(req, 'danger', pesanMobilDipinjam(bentrok[0])); return redir(req, res, formBack); }
    db.prepare('INSERT INTO pinjam_mobil (mobil_id, peminjam_id, nama_peminjam, nomor_peminjam, jumlah_penumpang, keperluan, tanggal_mulai, tanggal_selesai, jam_mulai, jam_selesai, catatan, wa_konfirmasi) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)')
      .run(mobilId, me.id, namaPeminjam, nomorPeminjam, penumpang, keperluan, mulai, selesai, jamMulai, jamSelesai, catatan);
    flash(req, 'success', 'Pengajuan terkirim & konfirmasi WhatsApp tercatat. Menunggu persetujuan admin.');
    return redir(req, res, 'peminjaman-mobil');
  }

  const row = id ? q('SELECT * FROM pinjam_mobil WHERE id = ?', Number(id)) : null;
  if (!row) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'peminjaman-mobil'); }
  const owner = me.id === row.peminjam_id;

  if (_aksi === 'batalkan' && (owner || isAdmin(me))) {
    if (row.status === 'pending') {
      db.prepare("UPDATE pinjam_mobil SET status = 'dibatalkan' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Pengajuan dibatalkan.');
    } else flash(req, 'danger', 'Hanya pengajuan berstatus menunggu yang dapat dibatalkan.');
  } else if (_aksi === 'setujui' && isManageStaff(me)) {
    if (row.status === 'pending') {
      const bentrok = cekTabrakanMobil(row.mobil_id, row.tanggal_mulai, row.tanggal_selesai, row.jam_mulai, row.jam_selesai, row.id);
      if (bentrok.length) flash(req, 'danger', pesanMobilDipinjam(bentrok[0]));
      else { db.prepare("UPDATE pinjam_mobil SET status = 'disetujui' WHERE id = ?").run(row.id); flash(req, 'success', 'Peminjaman mobil disetujui.'); }
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'tolak' && isManageStaff(me)) {
    if (row.status === 'pending') {
      db.prepare("UPDATE pinjam_mobil SET status = 'ditolak', catatan = ? WHERE id = ?").run(String(req.body.catatan || '').trim(), row.id);
      flash(req, 'success', 'Pengajuan ditolak.');
    } else flash(req, 'danger', 'Status pengajuan bukan menunggu.');
  } else if (_aksi === 'selesai' && isManageStaff(me)) {
    if (row.status === 'disetujui') {
      db.prepare("UPDATE pinjam_mobil SET status = 'selesai' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Peminjaman mobil ditandai selesai.');
    } else flash(req, 'danger', 'Hanya peminjaman disetujui yang dapat diselesaikan.');
  } else if (_aksi === 'hapus' && isAdmin(me)) {
    db.prepare('DELETE FROM pinjam_mobil WHERE id = ?').run(row.id);
    flash(req, 'success', 'Data peminjaman mobil dihapus.');
  } else {
    flash(req, 'danger', 'Anda tidak memiliki izin untuk tindakan ini.');
  }
  redir(req, res, 'peminjaman-mobil');
});

/* ---- Cetak / PDF daftar peminjaman mobil (staff) ---- */
app.get('/peminjaman-mobil/cetak', requireRoles('admin', 'operator'), (req, res) => {
  const st = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const list = all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat, m.jenis AS mobil_jenis,
           COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    WHERE (? = '' OR pm.status = ?)
    ORDER BY pm.tanggal_mulai ASC, pm.jam_mulai ASC`, st, st);
  res.render('peminjaman-mobil-cetak', { page: 'laporan', list, filter: st, set: getSettings() });
});
/* ---- Excel (CSV) daftar peminjaman mobil (staff) ---- */
app.get('/peminjaman-mobil/excel', requireRoles('admin', 'operator'), (req, res) => {
  const st = ['pending', 'disetujui', 'ditolak', 'selesai', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Bagian Sarana & Prasarana · Sistem Inventaris'],
    ['Daftar Peminjaman Mobil'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Mobil', 'Plat', 'Jenis', 'Peminjam', 'No. Telepon/WA', 'Penumpang', 'Keperluan', 'Mulai', 'Selesai', 'Jam Mulai', 'Jam Selesai', 'Status']
  ];
  all(`
    SELECT pm.*, m.nama AS mobil_nama, m.plat AS mobil_plat, m.jenis AS mobil_jenis,
           COALESCE(NULLIF(pm.nama_peminjam, ''), u.nama) AS peminjam_tampil
    FROM pinjam_mobil pm
    JOIN mobil m ON m.id = pm.mobil_id
    JOIN users u ON u.id = pm.peminjam_id
    WHERE (? = '' OR pm.status = ?)
    ORDER BY pm.tanggal_mulai ASC, pm.jam_mulai ASC`, st, st)
    .forEach((x, i) => rows.push([i + 1, x.mobil_nama, x.mobil_plat || '', x.mobil_jenis || '', x.peminjam_tampil,
      x.nomor_peminjam || '', x.jumlah_penumpang || '', x.keperluan, x.tanggal_mulai, x.tanggal_selesai,
      x.jam_mulai, x.jam_selesai, lib.statusLabel(x.status, 'ruangan')]));
  sendCsv(res, 'daftar-peminjaman-mobil', rows);
});

/* ================= MAINTENANCE ================= */
app.get('/maintenance', requireLogin, (req, res) => {
  const me = req.session.user;
  const st = ['dilaporkan', 'diperbaiki', 'selesai'].includes(req.query.status) ? req.query.status : '';
  const kat = ['kendaraan', 'elektronik', 'sarana'].includes(req.query.kategori) ? req.query.kategori : '';
  const own = me.role === 'santri';
  const qs = String(req.query.q || '').trim();
  const list = all(`
    SELECT m.*, u.nama AS pelapor_nama,
           COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m
    JOIN users u ON u.id = m.pelapor_id
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    WHERE (? = '' OR m.status = ?) AND (? = '' OR m.kategori = ?) AND (? = 1 OR m.pelapor_id = ?)
      AND (? = '' OR COALESCE(b.nama, r.nama, m.objek_nama) LIKE ? OR m.judul LIKE ? OR u.nama LIKE ?)
    ORDER BY m.id DESC`, st, st, kat, kat, own ? 0 : 1, me.id,
    qs, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  const items = all('SELECT * FROM barang ORDER BY nama ASC');
  const rooms = all('SELECT * FROM ruangan ORDER BY nama ASC');
  res.render('maintenance', { page: 'maintenance', list, items, rooms, filter: st, kat, q: qs });
});
app.post('/maintenance', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi, id } = req.body;

  if (_aksi === 'ajukan') {
    const kategori = ['kendaraan', 'elektronik', 'sarana'].includes(req.body.kategori) ? req.body.kategori : 'sarana';
    const judul = String(req.body.judul || '').trim();
    const deskripsi = String(req.body.deskripsi || '').trim();
    const tingkat = ['ringan', 'sedang', 'berat'].includes(req.body.tingkat) ? req.body.tingkat : 'ringan';
    let objekTipe = 'ruangan', objekId = 0, objekNama = '';
    if (kategori === 'kendaraan') {
      objekTipe = 'barang';
      objekNama = String(req.body.objek_nama || '').trim();
      if (!objekNama) { flash(req, 'danger', 'Nama kendaraan / plat wajib diisi.'); return redir(req, res, 'maintenance'); }
    } else if (kategori === 'elektronik') {
      objekTipe = 'barang';
      objekId = Number(req.body.barang_id) || 0;
      if (!q('SELECT id FROM barang WHERE id = ?', objekId)) { flash(req, 'danger', 'Pilih barang yang valid.'); return redir(req, res, 'maintenance'); }
    } else {
      objekTipe = 'ruangan';
      objekId = Number(req.body.ruangan_id) || 0;
      objekNama = String(req.body.area_nama || req.body.objek_nama || '').trim(); // area_nama dari dropdown Bidang/Sub (unik, tidak bentrok dgn input kendaraan)
      // Boleh memilih ruangan tertentu ATAU hanya area (Bidang · Sub/Kode) sebagai teks
      if (objekId && q('SELECT id FROM ruangan WHERE id = ?', objekId)) {
        // ruangan valid — objekNama bisa dikosongkan (fallback nama ruangan di tampilan)
      } else {
        objekId = 0;
        if (!objekNama) { flash(req, 'danger', 'Pilih Bidang / Sub-Kode area pemeliharaan.'); return redir(req, res, 'maintenance'); }
      }
    }
    if (!judul) { flash(req, 'danger', 'Judul laporan wajib diisi.'); return redir(req, res, 'maintenance'); }
    const barangId = kategori === 'elektronik' ? objekId : null;
    const ruanganId = kategori === 'sarana' ? (objekId || null) : null;
    db.prepare(`INSERT INTO maintenance (objek_tipe, barang_id, ruangan_id, objek_nama, kategori, pelapor_id, judul, deskripsi, tingkat, tanggal_lapor)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(objekTipe, barangId, ruanganId, objekNama, kategori, me.id, judul, deskripsi, tingkat, lib.today());
    flash(req, 'success', 'Laporan terkirim. Konfirmasi melalui WhatsApp supaya segera teratasi.');
    return redir(req, res, 'maintenance');
  }

  if (_aksi === 'mulai' && isManageStaff(me)) {
    const row = q('SELECT * FROM maintenance WHERE id = ?', Number(id));
    if (row && row.status === 'dilaporkan') {
      db.prepare("UPDATE maintenance SET status = 'diperbaiki' WHERE id = ?").run(row.id);
      flash(req, 'success', 'Perbaikan dimulai.');
    } else flash(req, 'danger', 'Hanya laporan berstatus dilaporkan yang dapat dimulai.');
    return redir(req, res, 'maintenance');
  }

  if (_aksi === 'hapus' && isManageStaff(me)) {
    const row = q('SELECT * FROM maintenance WHERE id = ?', Number(id));
    if (row) {
      db.prepare('DELETE FROM maintenance WHERE id = ?').run(row.id); // riwayat ikut terhapus (cascade)
      flash(req, 'success', 'Laporan maintenance dihapus.');
    }
    return redir(req, res, 'maintenance');
  }

  flash(req, 'danger', 'Anda tidak memiliki izin untuk tindakan ini.');
  redir(req, res, 'maintenance');
});

/* ---- Detail maintenance + riwayat perbaikan ---- */
app.get('/maintenance/:id', requireLogin, (req, res) => {
  const me = req.session.user;
  const id = Number(req.params.id);
  const m = q(`
    SELECT m.*, u.nama AS pelapor_nama, u.username AS pelapor_username,
           COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m
    JOIN users u ON u.id = m.pelapor_id
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    WHERE m.id = ?`, id);
  if (!m) return res.status(404).render('notfound', { page: '' });
  if (me.role === 'santri' && m.pelapor_id !== me.id) {
    flash(req, 'danger', 'Anda hanya dapat melihat laporan milik sendiri.');
    return redir(req, res, 'maintenance');
  }
  const riwayat = all('SELECT * FROM riwayat_perbaikan WHERE maintenance_id = ? ORDER BY tanggal DESC, id DESC', id);
  const totalBiaya = riwayat.reduce((s, r) => s + (Number(r.biaya) || 0), 0);
  res.render('maintenance-detail', { page: 'maintenance', m, riwayat, totalBiaya });
});
app.post('/maintenance/:id', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const m = q('SELECT * FROM maintenance WHERE id = ?', id);
  if (!m) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'maintenance'); }
  const status = ['dilaporkan', 'diperbaiki', 'selesai'].includes(req.body.status) ? req.body.status : m.status;
  const pic = String(req.body.penanggung_jawab || '').trim();
  const estimasi = Math.max(0, Number(req.body.estimasi_biaya) || 0);
  const biaya = Math.max(0, Number(req.body.biaya_aktual) || 0);
  const tglSelesai = status === 'selesai' ? (m.tanggal_selesai || lib.today()) : '';
  const serviceNext = m.kategori === 'kendaraan' ? String(req.body.service_selanjutnya || '').trim() : m.service_selanjutnya;
  db.prepare(`UPDATE maintenance SET status = ?, penanggung_jawab = ?, estimasi_biaya = ?, biaya_aktual = ?, tanggal_selesai = ?, service_selanjutnya = ? WHERE id = ?`)
    .run(status, pic, estimasi, biaya, tglSelesai, serviceNext, id);
  flash(req, 'success', status === 'selesai' ? 'Pemeliharaan ditandai selesai.' : 'Data pemeliharaan diperbarui.');
  redir(req, res, `maintenance/${id}`);
});
app.post('/maintenance/:id/riwayat', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  if (!q('SELECT id FROM maintenance WHERE id = ?', id)) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'maintenance'); }
  const tanggal = String(req.body.tanggal || lib.today());
  const keterangan = String(req.body.keterangan || '').trim();
  const biaya = Math.max(0, Number(req.body.biaya) || 0);
  const pelaksana = String(req.body.pelaksana || '').trim();
  if (!keterangan) { flash(req, 'danger', 'Keterangan riwayat wajib diisi.'); return redir(req, res, `maintenance/${id}`); }
  db.prepare('INSERT INTO riwayat_perbaikan (maintenance_id, tanggal, keterangan, biaya, pelaksana) VALUES (?,?,?,?,?)')
    .run(id, tanggal, keterangan, biaya, pelaksana);
  flash(req, 'success', 'Riwayat perbaikan ditambahkan.');
  redir(req, res, `maintenance/${id}`);
});
app.post('/maintenance/:id/riwayat/:rid/hapus', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const rid = Number(req.params.rid);
  db.prepare('DELETE FROM riwayat_perbaikan WHERE id = ? AND maintenance_id = ?').run(rid, id);
  flash(req, 'success', 'Riwayat perbaikan dihapus.');
  redir(req, res, `maintenance/${id}`);
});

/* ================= PENGGUNA (admin) ================= */
app.get('/users', requireRoles('admin'), (req, res) => {
  const qs = String(req.query.q || '').trim();
  const role = ['admin', 'operator', 'santri'].includes(req.query.role) ? req.query.role : '';
  const list = all(`
    SELECT id, username, nama, role, created_at FROM users
    WHERE (? = '' OR username LIKE ? OR nama LIKE ?) AND (? = '' OR role = ?)
    ORDER BY id ASC`, qs, `%${qs}%`, `%${qs}%`, role, role);
  const editId = Number(req.query.edit) || null;
  const edit = editId ? q('SELECT id, username, nama, role FROM users WHERE id = ?', editId) : null;
  res.render('users', { page: 'users', list, edit, q: qs, role });
});
app.get('/users/:id/log', requireRoles('admin'), (req, res) => {
  const uid = Number(req.params.id);
  const user = q('SELECT id, username, nama, role FROM users WHERE id = ?', uid);
  if (!user) return res.status(404).render('notfound', { page: '' });
  const logs = all(`
    SELECT * FROM audit_log WHERE (user_id = ? OR username = ?)
    ORDER BY id DESC LIMIT 200`, uid, user.username);
  res.render('user-log', { page: 'users', user, logs });
});
app.post('/users', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi, id } = req.body;

  if (_aksi === 'reset_password') {
    const uid = Number(id);
    const target = q('SELECT * FROM users WHERE id = ?', uid);
    if (!target) { flash(req, 'danger', 'Pengguna tidak ditemukan.'); return redir(req, res, 'users'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(lib.hashPassword('sahabat123'), uid);
    flash(req, 'success', `Password ${target.nama} direset menjadi: sahabat123`);
    return redir(req, res, 'users');
  }

  if (_aksi === 'hapus') {
    const uid = Number(id);
    const target = q('SELECT * FROM users WHERE id = ?', uid);
    if (!target) { flash(req, 'danger', 'Pengguna tidak ditemukan.'); return redir(req, res, 'users'); }
    if (target.id === me.id) { flash(req, 'danger', 'Tidak dapat menghapus akun sendiri.'); return redir(req, res, 'users'); }
    const adminCount = q("SELECT COUNT(*) c FROM users WHERE role = 'admin'").c;
    if (target.role === 'admin' && adminCount <= 1) { flash(req, 'danger', 'Minimal harus ada satu admin.'); return redir(req, res, 'users'); }
    const refs = q('SELECT COUNT(*) c FROM pinjam_ruangan WHERE peminjam_id = ?', uid).c +
      q('SELECT COUNT(*) c FROM pinjam_barang WHERE peminjam_id = ?', uid).c +
      q('SELECT COUNT(*) c FROM maintenance WHERE pelapor_id = ?', uid).c;
    if (refs > 0) { flash(req, 'danger', 'Pengguna memiliki riwayat peminjaman/maintenance, tidak dapat dihapus.'); return redir(req, res, 'users'); }
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    flash(req, 'success', 'Pengguna dihapus.');
    return redir(req, res, 'users');
  }

  const username = String(req.body.username || '').trim();
  const nama = String(req.body.nama || '').trim();
  const role = ['admin', 'operator', 'santri'].includes(req.body.role) ? req.body.role : 'santri';
  if (!username || !nama) { flash(req, 'danger', 'Username dan nama wajib diisi.'); return redir(req, res, 'users'); }

  if (id) {
    const target = q('SELECT * FROM users WHERE id = ?', Number(id));
    if (!target) { flash(req, 'danger', 'Pengguna tidak ditemukan.'); return redir(req, res, 'users'); }
    if (target.role === 'admin' && role !== 'admin' && q("SELECT COUNT(*) c FROM users WHERE role='admin'").c <= 1) {
      flash(req, 'danger', 'Minimal harus ada satu admin.'); return redir(req, res, 'users');
    }
    db.prepare('UPDATE users SET username = ?, nama = ?, role = ? WHERE id = ?').run(username, nama, role, Number(id));
    const pw = String(req.body.password || '');
    if (pw) {
      if (pw.length < 6) { flash(req, 'danger', 'Password baru minimal 6 karakter.'); return redir(req, res, 'users'); }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(lib.hashPassword(pw), Number(id));
    }
    flash(req, 'success', 'Data pengguna diperbarui.');
  } else {
    const exists = q('SELECT id FROM users WHERE username = ?', username);
    if (exists) { flash(req, 'danger', 'Username sudah digunakan.'); return redir(req, res, 'users'); }
    const pw = String(req.body.password || '');
    if (pw.length < 6) { flash(req, 'danger', 'Password minimal 6 karakter.'); return redir(req, res, 'users'); }
    db.prepare('INSERT INTO users (username, password_hash, nama, role) VALUES (?,?,?,?)')
      .run(username, lib.hashPassword(pw), nama, role);
    flash(req, 'success', 'Pengguna baru ditambahkan.');
  }
  redir(req, res, 'users');
});

/* ================= PROFIL ================= */
app.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { page: 'profile' });
});
app.post('/profile', requireLogin, (req, res) => {
  if (!postGuard(req, res)) return;
  const me = req.session.user;
  const { _aksi } = req.body;
  if (_aksi === 'nama') {
    const nama = String(req.body.nama || '').trim();
    if (!nama) { flash(req, 'danger', 'Nama wajib diisi.'); return redir(req, res, 'profile'); }
    db.prepare('UPDATE users SET nama = ? WHERE id = ?').run(nama, me.id);
    req.session.user.nama = nama;
    flash(req, 'success', 'Nama diperbarui.');
  } else if (_aksi === 'password') {
    const cur = String(req.body.password_lama || '');
    const pw1 = String(req.body.password_baru || '');
    const pw2 = String(req.body.password_konfirmasi || '');
    const user = q('SELECT * FROM users WHERE id = ?', me.id);
    if (!lib.verifyPassword(cur, user.password_hash)) { flash(req, 'danger', 'Password lama salah.'); return redir(req, res, 'profile'); }
    if (pw1.length < 6) { flash(req, 'danger', 'Password baru minimal 6 karakter.'); return redir(req, res, 'profile'); }
    if (pw1 !== pw2) { flash(req, 'danger', 'Konfirmasi password tidak cocok.'); return redir(req, res, 'profile'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(lib.hashPassword(pw1), me.id);
    flash(req, 'success', 'Password berhasil diganti.');
  }
  redir(req, res, 'profile');
});

/* ================= LAPORAN (staff: admin & operator) ================= */
function csvResponse(res, nama, rows) {
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nama + '-' + lib.today() + '.csv"');
  res.send(csv);
}
app.get('/laporan/inventaris/excel', requireRoles('admin', 'operator'), (req, res) => {
  const items = all('SELECT * FROM barang ORDER BY kategori ASC, nama ASC');
  const rooms = all('SELECT * FROM ruangan ORDER BY nama ASC');
  const ST = { tersedia: 'Tersedia', dipakai: 'Dipakai', maintenance: 'Maintenance' };
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Sistem Inventaris, Peminjaman & Pemeliharaan'],
    ['Laporan Inventaris Barang & Ruangan'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Nama Barang', 'Kategori', 'Lokasi', 'Stok Tersedia', 'Total', 'Satuan']
  ];
  items.forEach((b, i) => rows.push([i + 1, b.nama, b.kategori, b.lokasi, b.jumlah_tersedia, b.jumlah_total, b.satuan]));
  rows.push([]);
  rows.push(['Ruangan']);
  rows.push(['No', 'Ruangan', 'Lokasi', 'Kapasitas', 'Status']);
  rooms.forEach((r, i) => {
    const st = ruanganStatus(r.id);
    rows.push([i + 1, r.nama, r.lokasi, r.kapasitas + ' orang', ST[st] || st]);
  });
  csvResponse(res, 'laporan-inventaris', rows);
});
app.get('/laporan/maintenance/excel', requireRoles('admin', 'operator'), (req, res) => {
  const list = all(`
    SELECT m.*, COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m LEFT JOIN barang b ON b.id = m.barang_id LEFT JOIN ruangan r ON r.id = m.ruangan_id
    ORDER BY m.id DESC`);
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Sistem Inventaris, Peminjaman & Pemeliharaan'],
    ['Laporan Pemeliharaan & Perbaikan'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Objek', 'Judul Laporan', 'Tingkat', 'Status', 'Estimasi', 'Biaya', 'PIC', 'Tanggal']
  ];
  list.forEach((m, i) => rows.push([i + 1, m.objek_nama, m.judul, m.tingkat, lib.statusLabel(m.status, 'maintenance'), m.estimasi_biaya, m.biaya_aktual, m.penanggung_jawab, m.tanggal_lapor]));
  csvResponse(res, 'laporan-maintenance', rows);
});
app.get('/laporan/peminjaman/excel', requireRoles('admin', 'operator'), (req, res) => {
  const listR = all(`SELECT pr.*, r.nama objek, u.nama peminjam FROM pinjam_ruangan pr JOIN ruangan r ON r.id=pr.ruangan_id JOIN users u ON u.id=pr.peminjam_id ORDER BY pr.id DESC`);
  const listB = all(`SELECT pb.*, b.nama objek, u.nama peminjam FROM pinjam_barang pb JOIN barang b ON b.id=pb.barang_id JOIN users u ON u.id=pb.peminjam_id ORDER BY pb.id DESC`);
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Sistem Inventaris, Peminjaman & Pemeliharaan'],
    ['Laporan Peminjaman Barang & Ruangan'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Jenis', 'Objek', 'Nama Peminjam', 'No. Telepon/WA', 'Peserta', 'Keperluan', 'Jumlah', 'Tanggal Mulai', 'Tanggal Selesai', 'Jam Mulai', 'Jam Selesai', 'Status']
  ];
  listR.forEach((r, i) => rows.push([i + 1, 'Ruangan', r.objek, r.nama_peminjam || r.peminjam, r.nomor_peminjam || '', r.jumlah_peserta || '', r.keperluan, '', r.tanggal_mulai, r.tanggal_selesai, r.jam_mulai, r.jam_selesai, lib.statusLabel(r.status, 'ruangan')]));
  listB.forEach((r, i) => rows.push([i + 1, 'Barang', r.objek, r.nama_peminjam || r.peminjam, r.nomor_peminjam || '', '', r.keperluan, r.jumlah + ' ' + r.satuan, r.tanggal_pinjam, r.tanggal_kembali, r.jam_mulai, r.jam_selesai, lib.statusLabel(r.status, 'barang')]));
  csvResponse(res, 'laporan-peminjaman', rows);
});
app.get('/laporan', requireRoles('admin', 'operator'), (req, res) => {
  const stats = {
    barangJenis: q('SELECT COUNT(*) c FROM barang').c,
    stokTotal: q('SELECT COALESCE(SUM(jumlah_total),0) t FROM barang').t,
    ruangan: q('SELECT COUNT(*) c FROM ruangan').c,
    maintTotal: q('SELECT COUNT(*) c FROM maintenance').c,
    maintSelesai: q("SELECT COUNT(*) c FROM maintenance WHERE status = 'selesai'").c,
    biayaMaint: q("SELECT COALESCE(SUM(biaya_aktual),0) t FROM maintenance").t
  };
  res.render('laporan', { page: 'laporan', stats });
});

app.get('/laporan/inventaris', requireRoles('admin', 'operator'), (req, res) => {
  const items = all('SELECT * FROM barang ORDER BY kategori ASC, nama ASC');
  const rooms = all('SELECT * FROM ruangan ORDER BY nama ASC')
    .map((r) => ({ ...r, status: ruanganStatus(r.id) }));
  const sum = {
    jenis: items.length,
    total: items.reduce((s, b) => s + b.jumlah_total, 0),
    tersedia: items.reduce((s, b) => s + b.jumlah_tersedia, 0),
    ruangan: rooms.length
  };
  res.render('laporan-inventaris', { page: 'laporan', items, rooms, sum });
});

app.get('/laporan/maintenance', requireRoles('admin', 'operator'), (req, res) => {
  const st = ['dilaporkan', 'diperbaiki', 'selesai'].includes(req.query.status) ? req.query.status : '';
  const kat = ['kendaraan', 'elektronik', 'sarana'].includes(req.query.kategori) ? req.query.kategori : '';
  const list = all(`
    SELECT m.*, u.nama AS pelapor_nama,
           COALESCE(b.nama, r.nama, m.objek_nama) AS objek_nama
    FROM maintenance m
    JOIN users u ON u.id = m.pelapor_id
    LEFT JOIN barang b ON b.id = m.barang_id
    LEFT JOIN ruangan r ON r.id = m.ruangan_id
    WHERE (? = '' OR m.status = ?) AND (? = '' OR m.kategori = ?)
    ORDER BY m.id DESC`, st, st, kat, kat);
  const sum = {
    total: list.length,
    berjalan: list.filter((m) => m.status !== 'selesai').length,
    selesai: list.filter((m) => m.status === 'selesai').length,
    estimasi: list.reduce((s, m) => s + (Number(m.estimasi_biaya) || 0), 0),
    biaya: list.reduce((s, m) => s + (Number(m.biaya_aktual) || 0), 0)
  };
  res.render('laporan-maintenance', { page: 'laporan', list, sum, filter: st, kat });
});

/* ================= ARSIP SURAT SERAH TERIMA (admin) ================= */
function parseSuratItems(body) {
  const arr = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
  const nama = arr(body.items_nama).map((s) => String(s).trim());
  const jumlah = arr(body.items_jumlah).map((s) => Number(s) || 1);
  const satuan = arr(body.items_satuan).map((s) => String(s).trim() || 'unit');
  const ket = arr(body.items_keterangan).map((s) => String(s).trim());
  const out = [];
  for (let i = 0; i < nama.length; i++) {
    if (!nama[i]) continue;
    out.push({ nama: nama[i], jumlah: jumlah[i] || 1, satuan: satuan[i] || 'unit', keterangan: ket[i] || '' });
  }
  return out;
}

app.get('/arsip-surat', requireRoles('admin'), (req, res) => {
  const qs = String(req.query.q || '').trim();
  const list = all(`
    SELECT s.*, (SELECT COUNT(*) FROM surat_serah_terima_item i WHERE i.surat_id = s.id) AS jml_item
    FROM surat_serah_terima s
    WHERE (? = '' OR s.nomor LIKE ? OR s.penyerah_nama LIKE ? OR s.penerima_nama LIKE ? OR s.tempat LIKE ?)
    ORDER BY s.id DESC`, qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  res.render('arsip-surat', { page: 'arsip-surat', list, q: qs });
});

app.get('/arsip-surat/baru', requireRoles('admin'), (req, res) => {
  const cnt = q('SELECT COUNT(*) c FROM surat_serah_terima').c;
  const th = new Date().getFullYear();
  const prefill = {
    nomor: String(cnt + 1).padStart(3, '0') + '/SST/SARPRAS/' + th,
    tanggal: lib.today(),
    tempat: 'Kantor Sarana & Prasarana',
    penyerah_nama: 'H. Hasan',
    penyerah_jabatan: 'Kepala Sarana & Prasarana',
    penerima_nama: 'Ustadz Ahmad Fauzi',
    penerima_jabatan: 'Koordinator Asrama Putra',
    catatan: 'Barang diserahkan dalam kondisi baik dan siap pakai.'
  };
  const items = [
    { nama: 'Meja Belajar', jumlah: 10, satuan: 'unit', keterangan: 'Kondisi baik' },
    { nama: 'Kursi Plastik', jumlah: 20, satuan: 'unit', keterangan: '' },
    { nama: '', jumlah: 1, satuan: 'unit', keterangan: '' }
  ];
  const daftar = all('SELECT nama, satuan FROM barang ORDER BY nama ASC');
  res.render('arsip-surat-form', { page: 'arsip-surat', surat: null, items, daftar, prefillNmr: prefill.nomor });
});

app.post('/arsip-surat', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const nomor = String(req.body.nomor || '').trim();
  const tanggal = String(req.body.tanggal || '');
  if (!tanggal) { flash(req, 'danger', 'Tanggal surat wajib diisi.'); return redir(req, res, 'arsip-surat/baru'); }
  const info = db.prepare(`INSERT INTO surat_serah_terima (nomor, tanggal, tempat, penyerah_nama, penyerah_jabatan, penerima_nama, penerima_jabatan, catatan) VALUES (?,?,?,?,?,?,?,?)`)
    .run(nomor, tanggal, String(req.body.tempat || '').trim(),
      String(req.body.penyerah_nama || '').trim(), String(req.body.penyerah_jabatan || '').trim(),
      String(req.body.penerima_nama || '').trim(), String(req.body.penerima_jabatan || '').trim(),
      String(req.body.catatan || '').trim());
  const sid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO surat_serah_terima_item (surat_id, nama, jumlah, satuan, keterangan) VALUES (?,?,?,?,?)');
  const items = parseSuratItems(req.body);
  for (const it of items) ins.run(sid, it.nama, it.jumlah, it.satuan, it.keterangan);
  flash(req, 'success', 'Surat serah terima berhasil disimpan.');
  redir(req, res, `arsip-surat/${sid}`);
});

app.get('/arsip-surat/:id', requireRoles('admin'), (req, res) => {
  const id = Number(req.params.id);
  const surat = q('SELECT * FROM surat_serah_terima WHERE id = ?', id);
  if (!surat) return res.status(404).render('notfound', { page: '' });
  const items = all('SELECT * FROM surat_serah_terima_item WHERE surat_id = ? ORDER BY id ASC', id);
  const set = getSettings();
  const kop = {
    alamat: set.kontak_alamat || '',
    telepon: normTel(set.kontak_telepon),
    email: set.kontak_email || ''
  };
  res.render('arsip-surat-view', { page: 'arsip-surat', surat, items, kop });
});

app.get('/arsip-surat/:id/edit', requireRoles('admin'), (req, res) => {
  const id = Number(req.params.id);
  const surat = q('SELECT * FROM surat_serah_terima WHERE id = ?', id);
  if (!surat) return res.status(404).render('notfound', { page: '' });
  const items = all('SELECT * FROM surat_serah_terima_item WHERE surat_id = ? ORDER BY id ASC', id);
  items.push({ id: 0, nama: '', jumlah: 1, satuan: 'unit', keterangan: '' }); // satu baris kosong siap isi
  const daftar = all('SELECT nama, satuan FROM barang ORDER BY nama ASC');
  res.render('arsip-surat-form', { page: 'arsip-surat', surat, items, daftar, prefillNmr: '' });
});

app.post('/arsip-surat/:id', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  if (!q('SELECT id FROM surat_serah_terima WHERE id = ?', id)) { flash(req, 'danger', 'Surat tidak ditemukan.'); return redir(req, res, 'arsip-surat'); }
  const tanggal = String(req.body.tanggal || '');
  if (!tanggal) { flash(req, 'danger', 'Tanggal surat wajib diisi.'); return redir(req, res, `arsip-surat/${id}/edit`); }
  const upd = db.transaction(() => {
    db.prepare(`UPDATE surat_serah_terima SET nomor = ?, tanggal = ?, tempat = ?, penyerah_nama = ?, penyerah_jabatan = ?, penerima_nama = ?, penerima_jabatan = ?, catatan = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(String(req.body.nomor || '').trim(), tanggal, String(req.body.tempat || '').trim(),
        String(req.body.penyerah_nama || '').trim(), String(req.body.penyerah_jabatan || '').trim(),
        String(req.body.penerima_nama || '').trim(), String(req.body.penerima_jabatan || '').trim(),
        String(req.body.catatan || '').trim(), id);
    db.prepare('DELETE FROM surat_serah_terima_item WHERE surat_id = ?').run(id);
    const ins = db.prepare('INSERT INTO surat_serah_terima_item (surat_id, nama, jumlah, satuan, keterangan) VALUES (?,?,?,?,?)');
    for (const it of parseSuratItems(req.body)) ins.run(id, it.nama, it.jumlah, it.satuan, it.keterangan);
  });
  upd();
  flash(req, 'success', 'Surat serah terima diperbarui.');
  redir(req, res, `arsip-surat/${id}`);
});

app.post('/arsip-surat/:id/hapus', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  db.prepare('DELETE FROM surat_serah_terima WHERE id = ?').run(id); // item ikut terhapus (cascade)
  flash(req, 'success', 'Surat serah terima dihapus dari arsip.');
  redir(req, res, 'arsip-surat');
});

/* ================= CETAK STIKER (staff) ================= */
app.get('/cetak-stiker', requireRoles('admin', 'operator'), (req, res) => {
  const qs = String(req.query.q || '').trim();
  const tipe = req.query.tipe === 'ruangan' ? 'ruangan' : 'barang';
  const items = tipe === 'ruangan'
    ? all(`SELECT * FROM ruangan
           WHERE (? = '' OR nama LIKE ? OR lokasi LIKE ?)
           ORDER BY nama ASC`, qs, `%${qs}%`, `%${qs}%`)
      .map((r) => ({ ...r, status: ruanganStatus(r.id) }))
    : all(`SELECT * FROM barang
           WHERE (? = '' OR nama LIKE ? OR kategori LIKE ? OR lokasi LIKE ?)
           ORDER BY nama ASC`, qs, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  res.render('cetak-stiker', { page: 'cetak-stiker', items, q: qs, tipe });
});
app.get('/cetak-stiker/cetak', requireRoles('admin', 'operator'), async (req, res) => {
  const tipe = req.query.tipe === 'ruangan' ? 'ruangan' : 'barang';
  const ids = Array.isArray(req.query.ids) ? req.query.ids : (req.query.ids ? [req.query.ids] : []);
  const jml = Math.min(99, Math.max(1, Number(req.query.jml) || 1));
  const set = new Set(ids.map((x) => Number(x)).filter((x) => x > 0));
  const selected = [];
  if (set.size) {
    const placeholders = [...set].map(() => '?').join(',');
    const rows = tipe === 'ruangan'
      ? all(`SELECT * FROM ruangan WHERE id IN (${placeholders}) ORDER BY nama ASC`, ...set)
      : all(`SELECT * FROM barang WHERE id IN (${placeholders}) ORDER BY nama ASC`, ...set);
    for (const b of rows) {
      // Kode QR berisi LINK https ke halaman publik barang/ruangan (hasil scan langsung membuka halaman).
      const kode = lib.kodeQR(b, b.id); // kode aset yang ditampilkan di bawah QR (bukan isi QR)
      let base = String(getSettings().url_website || '').trim();
      if (!base) base = 'https://sintapqu.co.id';
      base = base.replace(/^http:\/\//i, 'https://'); // paksa https
      if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
      base = base.replace(/\/+$/, '');
      const urlQr = base + (tipe === 'ruangan' ? '/ruangan/' : '/barang/') + b.id;
      selected.push({ ...b, qr: await QRCode.toDataURL(urlQr, { width: 260, margin: 1 }), qrLink: urlQr, kodeQR: kode });
    }
  }
  const now = new Date();
  const waktuCetak = {
    tgl: lib.today(),
    jam: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  };
  res.render('cetak-stiker-cetak', { page: 'cetak-stiker', selected, jml, waktuCetak, tipe });
});


/* ================= AUDIT LOG (admin) ================= */
app.get('/audit-log', requireRoles('admin'), (req, res) => {
  const qs = String(req.query.q || '').trim();
  const list = all(`
    SELECT * FROM audit_log
    WHERE (? = '' OR username LIKE ? OR nama LIKE ? OR browser LIKE ? OR os LIKE ?)
    ORDER BY id DESC LIMIT 300`, qs, `%${qs}%`, `%${qs}%`, `%${qs}%`, `%${qs}%`);
  const stat = {
    kunjunganHariIni: q("SELECT COUNT(*) c FROM audit_log WHERE aksi = 'kunjungan' AND substr(waktu,1,10) = ?", lib.today()).c,
    kunjunganTotal: q("SELECT COUNT(*) c FROM audit_log WHERE aksi = 'kunjungan'").c
  };
  res.render('audit-log', { page: 'audit-log', list, q: qs, stat });
});
app.post('/audit-log/hapus-kunjungan', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const info = db.prepare("DELETE FROM audit_log WHERE aksi = 'kunjungan'");
  const n = info.run().changes;
  flash(req, 'success', n + ' catatan kunjungan website dihapus.');
  redir(req, res, 'audit-log');
});
app.post('/audit-log/:id/hapus', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  db.prepare('DELETE FROM audit_log WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'Catatan aktivitas dihapus.');
  redir(req, res, 'audit-log');
});

/* ================= BACKUP & RESTORE (admin) ================= */
const fs = require('fs');
app.get('/backup', requireRoles('admin'), (req, res) => {
  res.render('backup', { page: 'backup' });
});
app.get('/backup/download', requireRoles('admin'), (req, res) => {
  const tmp = path.join(require('os').tmpdir(), 'sahabatqu-backup-' + Date.now() + '.sqlite');
  try {
    db.backup(tmp).then(() => {
      const data = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (e) {}
      const tgl = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const zip = lib.zipStore([
        { name: 'data.sqlite', data },
        { name: 'README.txt', data: Buffer.from(
          'Backup Database Sistem Inventaris Pesantren SahabatQu\nTanggal: ' + new Date().toLocaleString('id-ID') +
          '\nDibuat oleh: ' + req.session.user.nama + '\nCara restore: menu Backup & Restore -> unggah file zip ini.\n', 'utf8') }
      ]);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="backup-sahabatqu-${tgl}.zip"`);
      res.send(zip);
    }).catch((e) => {
      try { fs.unlinkSync(tmp); } catch (x) {}
      flash(req, 'danger', 'Gagal membuat backup: ' + e.message);
      redir(req, res, 'backup');
    });
  } catch (e) {
    flash(req, 'danger', 'Gagal membuat backup: ' + e.message);
    redir(req, res, 'backup');
  }
});
app.post('/backup/restore', requireRoles('admin'), upload.single('file'), (req, res) => {
  if (!postGuard(req, res)) return;
  if (!req.file) { flash(req, 'danger', 'Pilih file backup (zip) terlebih dahulu.'); return redir(req, res, 'backup'); }
  try {
    const files = lib.zipRead(req.file.buffer);
    const dbBuf = files['data.sqlite'];
    if (!dbBuf) { flash(req, 'danger', 'File zip tidak berisi data.sqlite.'); return redir(req, res, 'backup'); }
    // validasi: file sqlite harus bisa dibuka
    const tmp = path.join(require('os').tmpdir(), 'sahabatqu-restore-' + Date.now() + '.sqlite');
    fs.writeFileSync(tmp, dbBuf);
    const Database = require('better-sqlite3');
    const test = new Database(tmp, { readonly: true, fileMustExist: true });
    test.prepare('SELECT COUNT(*) c FROM users').get();
    test.close();
    // cadangkan DB sekarang lalu salin file restore sebagai DB baru
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
    const bak = dbPath + '.bak-' + Date.now();
    db.backup(bak).then(() => {
      fs.copyFileSync(tmp, dbPath);
      try { fs.unlinkSync(tmp); } catch (e) {}
      flash(req, 'success', 'Restore berhasil. Data lama dicadangkan ke ' + path.basename(bak) + ' (berlaku penuh setelah aplikasi dimuat ulang).');
      redir(req, res, 'backup');
    }).catch((e) => {
      try { fs.unlinkSync(tmp); } catch (x) {}
      flash(req, 'danger', 'Gagal restore: ' + e.message);
      redir(req, res, 'backup');
    });
  } catch (e) {
    flash(req, 'danger', 'File backup tidak valid: ' + e.message);
    redir(req, res, 'backup');
  }
});

/* ================= JADWAL & PENGINGAT (pemeliharaan) ================= */
app.get('/pemeliharaan/jadwal', requireRoles('admin', 'operator'), (req, res) => {
  const jn = ['servis', 'pajak_tahunan', 'pajak_bulanan'].includes(req.query.jenis) ? req.query.jenis : '';
  const qs = String(req.query.q || '').trim();
  const list = all(`SELECT * FROM jadwal WHERE (? = '' OR jenis = ?) AND (? = '' OR objek_nama LIKE ? OR keterangan LIKE ?) ORDER BY tanggal ASC`, jn, jn, qs, `%${qs}%`, `%${qs}%`);
  res.render('jadwal', { page: 'jadwal', list, jn, jenisLabel: JENIS_JADWAL, q: qs, edit: null });
});
app.post('/pemeliharaan/jadwal', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const objek = String(req.body.objek_nama || '').trim();
  const pilih = Array.isArray(req.body.jenis) ? req.body.jenis : (req.body.jenis ? [req.body.jenis] : []);
  const jenisList = pilih.filter((x) => ['servis', 'pajak_tahunan', 'pajak_bulanan'].includes(x));
  const jenis = jenisList[0] || 'servis';
  // Tanggal diisi terpisah: tanggal / bulan / tahun
  const dd = String(req.body.tgl_d || '').padStart(2, '0');
  const mm = String(req.body.tgl_m || '').padStart(2, '0');
  const yy = String(req.body.tgl_y || '');
  const tanggal = (dd && mm && yy) ? `${yy}-${mm}-${dd}` : String(req.body.tanggal || '');
  if (!objek || !tanggal) { flash(req, 'danger', 'Nama kendaraan dan tanggal (hari/bulan/tahun) wajib diisi.'); return redir(req, res, 'pemeliharaan/jadwal'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { flash(req, 'danger', 'Format tanggal tidak valid.'); return redir(req, res, 'pemeliharaan/jadwal'); }
  if (!jenisList.length) { flash(req, 'danger', 'Pilih minimal satu jenis jadwal.'); return redir(req, res, 'pemeliharaan/jadwal'); }
  db.prepare('INSERT INTO jadwal (objek_nama, jenis, jenis_list, tanggal, keterangan) VALUES (?,?,?,?,?)')
    .run(objek, jenis, jenisList.join(','), tanggal, String(req.body.keterangan || '').trim());
  flash(req, 'success', 'Jadwal ditambahkan.');
  redir(req, res, 'pemeliharaan/jadwal');
});
/* ---- Edit jadwal pemeliharaan ---- */
app.get('/pemeliharaan/jadwal/:id/edit', requireRoles('admin', 'operator'), (req, res) => {
  const jn = ['servis', 'pajak_tahunan', 'pajak_bulanan'].includes(req.query.jenis) ? req.query.jenis : '';
  const qs = String(req.query.q || '').trim();
  const list = all(`SELECT * FROM jadwal WHERE (? = '' OR jenis = ?) AND (? = '' OR objek_nama LIKE ? OR keterangan LIKE ?) ORDER BY tanggal ASC`, jn, jn, qs, `%${qs}%`, `%${qs}%`);
  const edit = q('SELECT * FROM jadwal WHERE id = ?', Number(req.params.id) || 0);
  if (!edit) return res.status(404).render('notfound', { page: '' });
  res.render('jadwal', { page: 'jadwal', list, jn, jenisLabel: JENIS_JADWAL, q: qs, edit });
});
app.post('/pemeliharaan/jadwal/:id', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  if (!q('SELECT id FROM jadwal WHERE id = ?', id)) { flash(req, 'danger', 'Jadwal tidak ditemukan.'); return redir(req, res, 'pemeliharaan/jadwal'); }
  const objek = String(req.body.objek_nama || '').trim();
  const pilih = Array.isArray(req.body.jenis) ? req.body.jenis : (req.body.jenis ? [req.body.jenis] : []);
  const jenisList = pilih.filter((x) => ['servis', 'pajak_tahunan', 'pajak_bulanan'].includes(x));
  const jenis = jenisList[0] || 'servis';
  const tanggal = String(req.body.tanggal || '');
  if (!objek || !tanggal) { flash(req, 'danger', 'Nama kendaraan dan tanggal wajib diisi.'); return redir(req, res, `pemeliharaan/jadwal/${id}/edit`); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) { flash(req, 'danger', 'Format tanggal tidak valid.'); return redir(req, res, `pemeliharaan/jadwal/${id}/edit`); }
  if (!jenisList.length) { flash(req, 'danger', 'Pilih minimal satu jenis jadwal.'); return redir(req, res, `pemeliharaan/jadwal/${id}/edit`); }
  db.prepare('UPDATE jadwal SET objek_nama = ?, jenis = ?, jenis_list = ?, tanggal = ?, keterangan = ? WHERE id = ?')
    .run(objek, jenis, jenisList.join(','), tanggal, String(req.body.keterangan || '').trim(), id);
  flash(req, 'success', 'Jadwal diperbarui.');
  redir(req, res, 'pemeliharaan/jadwal');
});
app.post('/pemeliharaan/jadwal/:id/selesai', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const row = q('SELECT * FROM jadwal WHERE id = ?', id);
  if (!row) { flash(req, 'danger', 'Jadwal tidak ditemukan.'); return redir(req, res, 'pemeliharaan/jadwal'); }

  // Bila sudah selesai -> aktifkan kembali (batalkan penyelesaian)
  if (row.status === 'selesai') {
    db.prepare("UPDATE jadwal SET status = 'aktif', tanggal_selesai = '' WHERE id = ?").run(id);
    flash(req, 'success', 'Jadwal diaktifkan kembali.');
    return redir(req, res, 'pemeliharaan/jadwal');
  }

  // 1) Tandai selesai + catat TANGGAL SELESAI otomatis (hari ini, WIB)
  const tglSelesai = nowWIB().slice(0, 10);
  db.prepare("UPDATE jadwal SET status = 'selesai', tanggal_selesai = ? WHERE id = ?").run(tglSelesai, id);

  // 2) Buat otomatis jadwal JATUH TEMPO BERIKUTNYA (reminder baru, status aktif)
  const next = jatuhTempoBerikutnya(row.tanggal, row.jenis_list || row.jenis);
  if (next.tanggal) {
    db.prepare('INSERT INTO jadwal (objek_nama, jenis, jenis_list, tanggal, keterangan, status, tanggal_selesai) VALUES (?,?,?,?,?,?,?)')
      .run(row.objek_nama, row.jenis, row.jenis_list || row.jenis, next.tanggal,
        row.keterangan || '', 'aktif', '');
    flash(req, 'success', `Jadwal ditandai selesai (${tglSelesai}). Pengingat berikutnya otomatis dibuat: ${lib.fmtDate(next.tanggal)} (${next.bulan} bulan).`);
  } else {
    flash(req, 'success', 'Jadwal ditandai selesai.');
  }
  redir(req, res, 'pemeliharaan/jadwal');
});
app.post('/pemeliharaan/jadwal/:id/hapus', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  db.prepare('DELETE FROM jadwal WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'Jadwal dihapus.');
  redir(req, res, 'pemeliharaan/jadwal');
});
/* Cetak Excel (CSV) */
app.get('/pemeliharaan/jadwal/excel', requireRoles('admin', 'operator'), (req, res) => {
  const list = all('SELECT * FROM jadwal ORDER BY tanggal ASC');
  const rows = [
    ['PESANTREN SAHABATQU'],
    ['Bagian Sarana & Prasarana · Sistem Inventaris'],
    ['Jadwal Pemeliharaan — Servis / Perbaikan, Pajak Tahunan & Pajak 5 Tahunan'],
    ['Per ' + lib.fmtDate(lib.today())],
    [],
    ['No', 'Kendaraan / Objek', 'Jenis Jadwal', 'Tanggal', 'Keterangan', 'Status']
  ];
  list.forEach((j, i) => rows.push([i + 1, j.objek_nama, (j.jenis_list || j.jenis).split(',').map((x) => JENIS_JADWAL[x] || x).join(', '), j.tanggal, j.keterangan, j.status === 'selesai' ? 'Selesai' : 'Aktif']));
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="jadwal-pemeliharaan-' + lib.today() + '.csv"');
  res.send(csv);
});
/* Cetak / PDF (print view) */
app.get('/pemeliharaan/jadwal/cetak', requireRoles('admin', 'operator'), (req, res) => {
  const jn = ['servis', 'pajak_tahunan', 'pajak_bulanan'].includes(req.query.jenis) ? req.query.jenis : '';
  const list = all(`SELECT * FROM jadwal WHERE (? = '' OR jenis = ?) ORDER BY tanggal ASC`, jn, jn);
  res.render('jadwal-cetak', { page: 'jadwal', list, jn, jenisLabel: JENIS_JADWAL });
});

/* ================= WEBSITE PROFIL (admin) ================= */
app.get('/website-profil', requireRoles('admin'), (req, res) => {
  res.render('website-profil', { page: 'website-profil', set: getSettings() });
});
app.post('/website-profil', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const keys = ['about_title', 'about_text', 'footer_text', 'url_website'];
  const upsert = db.prepare(`INSERT INTO pengaturan (kunci, nilai) VALUES (?, ?)
    ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai`);
  db.transaction(() => { for (const k of keys) upsert.run(k, String(req.body[k] || '').trim()); })();
  flash(req, 'success', 'Profil website disimpan.');
  redir(req, res, 'website-profil');
});

/* ================= PENGATURAN (admin) ================= */
app.get('/pengaturan', requireRoles('admin'), (req, res) => {
  res.render('pengaturan', { page: 'pengaturan', set: getSettings() });
});

/* ================= LAPORAN PEMINJAMAN (staff) ================= */
app.get('/laporan/peminjaman', requireRoles('admin', 'operator'), (req, res) => {
  const jenis = ['barang', 'ruangan'].includes(req.query.jenis) ? req.query.jenis : '';
  const st = ['pending', 'disetujui', 'ditolak', 'selesai', 'dikembalikan', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const dari = String(req.query.dari || '');
  const sampai = String(req.query.sampai || '');
  const mk = (tbl, kolTgl) => {
    const w = [];
    const p = [];
    if (st) { w.push(`${tbl}.status = ?`); p.push(st); }
    if (dari) { w.push(`${tbl}.${kolTgl} >= ?`); p.push(dari); }
    if (sampai) { w.push(`${tbl}.${kolTgl} <= ?`); p.push(sampai); }
    return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
  };
  const qr = mk('pr', 'tanggal_mulai');
  const qb = mk('pb', 'tanggal_pinjam');
  const listR = all(`
    SELECT pr.*, r.nama AS objek_nama, u.nama AS peminjam_nama FROM pinjam_ruangan pr
    JOIN ruangan r ON r.id = pr.ruangan_id JOIN users u ON u.id = pr.peminjam_id
    ${qr.where} ORDER BY pr.id DESC${jenis === 'barang' ? ' LIMIT 0' : ''}`, ...qr.p);
  const listB = all(`
    SELECT pb.*, b.nama AS objek_nama, b.satuan, u.nama AS peminjam_nama FROM pinjam_barang pb
    JOIN barang b ON b.id = pb.barang_id JOIN users u ON u.id = pb.peminjam_id
    ${qb.where} ORDER BY pb.id DESC${jenis === 'ruangan' ? ' LIMIT 0' : ''}`, ...qb.p);
  res.render('laporan-peminjaman', { page: 'laporan', jenis, filter: st, dari, sampai, list: null, listR, listB });
});

/* ================= KATEGORI BARANG (admin) ================= */
app.post('/barang/kategori', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const nama = String(req.body.nama || '').trim();
  if (!nama) { flash(req, 'danger', 'Nama kategori wajib diisi.'); return redir(req, res, 'barang'); }
  db.prepare('INSERT OR IGNORE INTO kategori_barang (nama) VALUES (?)').run(nama);
  // pastikan kategori dipakai sebagai pilihan saat tambah barang
  flash(req, 'success', 'Kategori "' + nama + '" ditambahkan.');
  redir(req, res, 'barang');
});
app.post('/barang/kategori/hapus', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const nama = String(req.body.nama || '').trim();
  if (!nama) { flash(req, 'danger', 'Nama kategori tidak valid.'); return redir(req, res, 'barang'); }
  db.transaction(() => {
    db.prepare('DELETE FROM kategori_barang WHERE nama = ?').run(nama);
    db.prepare('UPDATE barang SET kategori = ? WHERE kategori = ?').run('', nama);
  })();
  flash(req, 'success', `Kategori "${nama}" dihapus. Barang terkait menjadi tanpa kategori.`);
  redir(req, res, 'barang');
});
app.post('/barang/kategori/edit', requireRoles('admin'), (req, res) => {
  if (!postGuard(req, res)) return;
  const lama = String(req.body.nama || '').trim();
  const baru = String(req.body.nama_baru || '').trim();
  if (!lama) { flash(req, 'danger', 'Nama kategori tidak valid.'); return redir(req, res, 'barang'); }
  if (!baru) { flash(req, 'danger', 'Nama kategori baru wajib diisi.'); return redir(req, res, 'barang'); }
  if (lama === baru) { flash(req, 'info', 'Nama kategori tidak berubah.'); return redir(req, res, 'barang'); }
  db.transaction(() => {
    // hindari bentrok UNIQUE bila nama baru sudah ada → hapus dulu baris lama
    db.prepare('DELETE FROM kategori_barang WHERE nama = ?').run(lama);
    db.prepare('INSERT OR IGNORE INTO kategori_barang (nama) VALUES (?)').run(baru);
    db.prepare('UPDATE barang SET kategori = ? WHERE kategori = ?').run(baru, lama);
  })();
  flash(req, 'success', `Kategori "${lama}" diubah menjadi "${baru}".`);
  redir(req, res, 'barang');
});

/* ================= JADWAL PIKET CLEANING SERVICE (staff) ================= */
const BLN_NAMA = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
// Jaminan tabel ada (idempoten) — db.exec saat boot bisa gagal bila DB terkunci instance lama
function ensurePiketTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS piket_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL DEFAULT '',
      bulan TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL DEFAULT '',
      hari_libur TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS piket_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL REFERENCES piket_sheets(id) ON DELETE CASCADE,
      jam TEXT NOT NULL DEFAULT '',
      tugas TEXT NOT NULL DEFAULT '',
      urutan INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS piket_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL REFERENCES piket_sheets(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES piket_tasks(id) ON DELETE CASCADE,
      hari INTEGER NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id, hari)
    );
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(piket_sheets)').all().map((c) => c.name);
    if (!cols.includes('kordinator_kebersihan')) db.exec(`ALTER TABLE piket_sheets ADD COLUMN kordinator_kebersihan TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('kordinator_k3')) db.exec(`ALTER TABLE piket_sheets ADD COLUMN kordinator_k3 TEXT NOT NULL DEFAULT ''`);
    db.prepare(`UPDATE piket_sheets SET kordinator_kebersihan = 'Ustadz Ahmad Syukri Rohman' WHERE kordinator_kebersihan = ''`).run();
    db.prepare(`UPDATE piket_sheets SET kordinator_k3 = 'Ustadz Ahmad Shobirin' WHERE kordinator_k3 = ''`).run();
  } catch (e) { console.error('(non-fatal) migrasi kordinator piket gagal:', e.message); }
}
/* Urutkan tugas piket berdasarkan JAM AWAL (baris sub-tugas tanpa jam tetap mengikuti
   baris utama di atasnya). Baris KHUSUS (jam "-" / diawali "-") ditaruh PALING BAWAH.
   Format jam: "HH.MM - HH.MM" atau "HH:MM". */
function urutTugasPiket(raw) {
  const isKhusus = (j) => String(j || '').trim() === '-' || String(j || '').trim().startsWith('-');
  const jamNum = (j) => {
    const m = String(j || '').match(/(\d{1,2})[.:](\d{2})/);
    if (!m) return 99999;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const groups = [];
  let cur = null;
  for (const t of raw) {
    if (t.jam) { cur = { header: t, subs: [], khusus: isKhusus(t.jam) }; groups.push(cur); }
    else if (cur) cur.subs.push(t);
    else { cur = { header: null, subs: [t], khusus: false }; groups.push(cur); }
  }
  groups.sort((a, b) => {
    if (a.khusus !== b.khusus) return a.khusus ? 1 : -1; // baris khusus selalu di bawah
    const ja = a.header ? jamNum(a.header.jam) : 99999;
    const jb = b.header ? jamNum(b.header.jam) : 99999;
    if (ja !== jb) return ja - jb;
    return (a.header ? a.header.id : Infinity) - (b.header ? b.header.id : Infinity);
  });
  const out = [];
  for (const g of groups) {
    if (g.header) out.push(g.header);
    for (const s of g.subs) out.push(s);
  }
  return out;
}
const DEF_TUGAS_PIKET = [
  ['07.00 - 07.10', 'APEL di Pos Satpam'],
  ['07.10 - 08.00', 'Mengambil sampah di Area Joglo, kantor, musola, SMC, Satpam Putra, Sekolah Putra'],
  ['08.00 - 08.45', 'Mengambil Sampah Area Foodcourt, Masjid, Saqumart, Kolam, Dapur Putra, Asrama Putra'],
  ['08.45 - 09.30', 'Mengambil sampah Dapur Putri, Sekolah Putri, Asrama Putri, Lapangan Putri, Perumahan, Kolam Putri, Aula Putri'],
  ['09.30 - 11.00', 'Proses Pemilahan Sampah dan menata ke pembakaran'],
  ['', '- Memilah Botol'],
  ['', '- Memilah Kardus'],
  ['', '- Memilah Sampah Organik'],
  ['', '- Menata ke Pembakaran sesuai SOP'],
  ['', '- Bersihkan AREA Pemilahan'],
  ['11.00 - 13.30', 'Proses Pemusnahan Sampah'],
  ['', '- Memastikan penataan sudah sesuai'],
  ['', '- Cek kondisi Air'],
  ['', '- Cek kondisi Pompa'],
  ['', '- Cek kondisi Kipas'],
  ['', '- Cek kondisi Kran dan Air'],
  ['', '- Membuang ke kolam sampah Organik'],
  ['13.30 - 14.00', 'Closing Pembakaran'],
  ['', '- Memastikan api mati tidak ada asap'],
  ['', '- Membersihkan Abu'],
  ['', '- Membersihkan Air'],
  ['14.00 - 14.30', 'Sapu area jalan dari sampah ke perumahan dan area perumahan'],
  ['14.30 - 14.55', 'Mengambil sampah Area Joglo dan sekitarnya, dan Foodcourt'],
  ['14.55 - 15.00', 'Persiapan pulang']
];
app.get('/piket', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  const list = all(`
    SELECT s.*, (SELECT COUNT(*) FROM piket_tasks t WHERE t.sheet_id = s.id) AS jml
    FROM piket_sheets s ORDER BY s.id DESC`);
  const now = new Date();
  res.render('piket', { page: 'piket', list, tahun: now.getFullYear(), bulanKe: now.getMonth() + 1, BLN: BLN_NAMA });
});
app.post('/piket', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  if (!postGuard(req, res)) return;
  const nama = String(req.body.nama || '').trim();
  const bulan = String(req.body.bulan || '');
  if (!nama || !/^\d{4}-\d{2}$/.test(bulan)) { flash(req, 'danger', 'Nama dan bulan wajib diisi.'); return redir(req, res, 'piket'); }
  const area = String(req.body.area || '').trim();
  const hariLibur = String(req.body.hari_libur || '').trim();
  const kordKeb = String(req.body.kordinator_kebersihan || '').trim() || 'Ustadz Ahmad Syukri Rohman';
  const kordK3 = String(req.body.kordinator_k3 || '').trim() || 'Ustadz Ahmad Shobirin';
  const info = db.prepare('INSERT INTO piket_sheets (nama, bulan, area, hari_libur, kordinator_kebersihan, kordinator_k3) VALUES (?,?,?,?,?,?)')
    .run(nama, bulan, area, hariLibur, kordKeb, kordK3);
  const sid = info.lastInsertRowid;
  const ins = db.prepare('INSERT INTO piket_tasks (sheet_id, jam, tugas, urutan) VALUES (?,?,?,?)');
  DEF_TUGAS_PIKET.forEach((d, i) => ins.run(sid, d[0], d[1], i));
  flash(req, 'success', 'Jadwal Piket dibuat.');
  redir(req, res, 'piket/' + sid);
});
app.get('/piket/:id', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  const id = Number(req.params.id);
  const s = q('SELECT * FROM piket_sheets WHERE id = ?', id);
  if (!s) return res.status(404).render('notfound', { page: '' });
  const tasks = urutTugasPiket(all('SELECT * FROM piket_tasks WHERE sheet_id = ? ORDER BY urutan ASC, id ASC', id));
  const checks = all('SELECT task_id, hari, checked FROM piket_checks WHERE sheet_id = ?', id);
  const cmap = {};
  checks.forEach((c) => { cmap[c.task_id + '_' + c.hari] = c.checked; });
  const jmlHari = new Date(+s.bulan.slice(0, 4), +s.bulan.slice(5, 7), 0).getDate();
  const sundays = [];
  const y = +s.bulan.slice(0, 4), m = +s.bulan.slice(5, 7);
  for (let d = 1; d <= jmlHari; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays.push(d);
  res.render('piket-view', { page: 'piket', s, tasks, cmap, jmlHari, sundays, BLN: BLN_NAMA });
});
app.get('/piket/:id/edit', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  const s = q('SELECT * FROM piket_sheets WHERE id = ?', Number(req.params.id));
  if (!s) return res.status(404).render('notfound', { page: '' });
  res.render('piket-edit', { page: 'piket', s, BLN: BLN_NAMA });
});
app.post('/piket/:id', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  ensurePiketTables();
  const id = Number(req.params.id);
  if (!q('SELECT id FROM piket_sheets WHERE id = ?', id)) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'piket'); }
  const nama = String(req.body.nama || '').trim();
  const bulan = String(req.body.bulan || '');
  if (!nama || !/^\d{4}-\d{2}$/.test(bulan)) { flash(req, 'danger', 'Nama dan bulan wajib diisi.'); return redir(req, res, `piket/${id}/edit`); }
  const kordKeb = String(req.body.kordinator_kebersihan || '').trim() || 'Ustadz Ahmad Syukri Rohman';
  const kordK3 = String(req.body.kordinator_k3 || '').trim() || 'Ustadz Ahmad Shobirin';
  db.prepare('UPDATE piket_sheets SET nama = ?, bulan = ?, area = ?, hari_libur = ?, kordinator_kebersihan = ?, kordinator_k3 = ? WHERE id = ?')
    .run(nama, bulan, String(req.body.area || '').trim(), String(req.body.hari_libur || '').trim(), kordKeb, kordK3, id);
  flash(req, 'success', 'Jadwal piket diperbarui.');
  redir(req, res, `piket/${id}`);
});
app.post('/piket/:id/tugas/:tid/edit', requireRoles('admin', 'operator'), (req, res) => {
  if (!postGuard(req, res)) return;
  const tugas = String(req.body.tugas || '').trim();
  if (!tugas) { flash(req, 'danger', 'Tugas wajib diisi.'); return redir(req, res, `piket/${req.params.id}`); }
  const khusus = req.body.khusus === '1' || req.body.khusus === 'on' || req.body.khusus === 'true';
  const jam = khusus ? '-' : String(req.body.jam || '').trim();
  db.prepare('UPDATE piket_tasks SET jam = ?, tugas = ? WHERE id = ? AND sheet_id = ?')
    .run(jam, tugas, Number(req.params.tid), Number(req.params.id));
  flash(req, 'success', 'Tugas diperbarui.');
  redir(req, res, `piket/${req.params.id}`);
});
app.get('/piket/:id/excel', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  const id = Number(req.params.id);
  const s = q('SELECT * FROM piket_sheets WHERE id = ?', id);
  if (!s) return redir(req, res, 'piket');
  const tasks = urutTugasPiket(all('SELECT * FROM piket_tasks WHERE sheet_id = ? ORDER BY urutan ASC, id ASC', id));
  const checks = all('SELECT task_id, hari, checked FROM piket_checks WHERE sheet_id = ?', id);
  const cmap = {};
  checks.forEach((c) => { cmap[c.task_id + '_' + c.hari] = c.checked; });
  const jmlHari = new Date(+s.bulan.slice(0, 4), +s.bulan.slice(5, 7), 0).getDate();
  const sundays = [];
  const y = +s.bulan.slice(0, 4), m = +s.bulan.slice(5, 7);
  for (let d = 1; d <= jmlHari; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays.push(d);
  const esc = lib.esc;
  // File Excel (.xls berbasis HTML) — membawa pengaturan cetak A4 landscape & lebar kolom,
  // jadi langsung bisa diprint dari Excel/WPS menghasilkan halaman SAMA dengan Cetak/PDF.
  const colDay = 17; // 6mm
  let colgroup = '<col style="width:23pt"><col style="width:62pt"><col style="width:170pt">';
  for (let d = 1; d <= jmlHari; d++) colgroup += `<col style="width:${colDay}pt">`;
  let headCells = '<th>No</th><th>Jam</th><th>Tugas Harian</th>';
  for (let d = 1; d <= jmlHari; d++) {
    if (sundays.includes(d)) headCells += `<th class="sun">${d}<br>Hari Libur</th>`;
    else headCells += `<th>${d}</th>`;
  }
  let bodyRows = '';
  let nomorPiket = 0;
  tasks.forEach((t) => {
    if (t.jam) nomorPiket++;
    let cells = `<td class="c">${t.jam ? nomorPiket : ''}</td><td class="c">${esc(t.jam || '')}</td><td>${esc(t.tugas)}</td>`;
    for (let d = 1; d <= jmlHari; d++) {
      if (sundays.includes(d)) cells += '<td class="sun c">–</td>';
      else cells += `<td class="c">${cmap[t.id + '_' + d] ? 'v' : ''}</td>`;
    }
    bodyRows += `<tr>${cells}</tr>`;
  });
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook>
  <x:ExcelWorksheets>
    <x:ExcelWorksheet>
      <x:Name>Jadwal Piket</x:Name>
      <x:WorksheetOptions>
        <x:Print>
          <x:ValidPrinterInfo/>
          <x:PaperSizeIndex>9</x:PaperSizeIndex>
          <x:Landscape/>
          <x:FitToPage/>
          <x:FitHeight>0</x:FitHeight>
        </x:Print>
        <x:PageMargins x:Left="0.2" x:Right="0.2" x:Top="0.2" x:Bottom="0.2"/>
      </x:WorksheetOptions>
    </x:ExcelWorksheet>
  </x:ExcelWorksheets>
</x:ExcelWorkbook>
</xml><![endif]-->
<style>
  @page { size: 29.7cm 21cm; margin: 5mm; }
  table { border-collapse: collapse; }
  td, th { border: 0.5pt solid #000; font-family: 'Segoe UI', Arial, sans-serif; vertical-align: middle; }
  .kop { text-align: center; font-size: 13pt; font-weight: bold; border: none; }
  .info { font-size: 9pt; border: none; }
  .tbl td, .tbl th { font-size: 7.5pt; padding: 1px 2px; }
  .tbl th { background: #f1f0fa; text-align: center; font-weight: bold; }
  .tbl .c { text-align: center; }
  .sun { background: #d33 !important; color: #fff; }
  .note { font-size: 8pt; }
  .ttd { text-align: center; font-size: 9pt; border: none; }
  .ttd-name { font-weight: bold; }
</style>
</head>
<body>
  <table class="kop" width="100%"><tr><td>JOB DESCRIPTION</td></tr><tr><td>Cleaning Service</td></tr><tr><td>PPTQ SAHABATQU</td></tr></table>
  <table class="info" width="100%">
    <tr>
      <td width="25%"><b>Nama</b> : ${esc(s.nama)}</td>
      <td width="25%"><b>Bulan</b> : ${esc(BLN_NAMA[+s.bulan.slice(5, 7)] + ' ' + s.bulan.slice(0, 4))}</td>
      <td width="25%"><b>Area</b> : ${esc(s.area)}</td>
      <td width="25%"><b>Hari Libur</b> : ${esc(s.hari_libur || '—')}</td>
    </tr>
  </table>
  <p class="note"><span style="background:#d33;color:#fff">&nbsp;&nbsp;&nbsp;</span>&nbsp; Hari Minggu</p>
  <table class="tbl" width="100%" cellspacing="0" cellpadding="0">
    <colgroup>${colgroup}</colgroup>
    <thead><tr>${headCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <br>
  <p class="note">* dikerjakan sesuai keadaan</p>
  <table width="100%">
    <tr>
      <td width="50%" class="ttd">Kordinator Kebersihan<br><br><br><span class="ttd-name">${esc(s.kordinator_kebersihan || 'Ustadz Ahmad Syukri Rohman')}</span></td>
      <td width="50%" class="ttd">Kordinator K3<br><br><br><span class="ttd-name">${esc(s.kordinator_k3 || 'Ustadz Ahmad Shobirin')}</span></td>
    </tr>
  </table>
</body>
</html>`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="jadwal-piket-${s.nama.replace(/[^a-z0-9]+/gi, '-')}-${lib.today()}.xls"`);
  res.send(html);
});
app.post('/piket/:id/cek', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const s = q('SELECT * FROM piket_sheets WHERE id = ?', id);
  if (!s) { flash(req, 'danger', 'Data tidak ditemukan.'); return redir(req, res, 'piket'); }
  const tasks = all('SELECT id FROM piket_tasks WHERE sheet_id = ?', id);
  const jmlHari = new Date(+s.bulan.slice(0, 4), +s.bulan.slice(5, 7), 0).getDate();
  const upsert = db.prepare(`INSERT INTO piket_checks (sheet_id, task_id, hari, checked) VALUES (?,?,?,?)
    ON CONFLICT(task_id, hari) DO UPDATE SET checked = excluded.checked`);
  db.transaction(() => {
    for (const t of tasks) {
      for (let d = 1; d <= jmlHari; d++) {
        upsert.run(id, t.id, d, req.body['cek_' + t.id + '_' + d] ? 1 : 0);
      }
    }
  })();
  flash(req, 'success', 'Checklist tersimpan.');
  redir(req, res, 'piket/' + id);
});
app.post('/piket/:id/tugas', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  if (!postGuard(req, res)) return;
  const id = Number(req.params.id);
  const tugas = String(req.body.tugas || '').trim();
  if (!tugas) { flash(req, 'danger', 'Tugas wajib diisi.'); return redir(req, res, 'piket/' + id); }
  const jam = String(req.body.jam || '').trim();
  const max = q('SELECT COALESCE(MAX(urutan), -1) m FROM piket_tasks WHERE sheet_id = ?', id).m;
  db.prepare('INSERT INTO piket_tasks (sheet_id, jam, tugas, urutan) VALUES (?,?,?,?)')
    .run(id, jam, tugas, max + 1);
  flash(req, 'success', 'Tugas ditambahkan.');
  redir(req, res, 'piket/' + id);
});
app.post('/piket/:id/tugas/:tid/hapus', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  if (!postGuard(req, res)) return;
  db.prepare('DELETE FROM piket_tasks WHERE id = ? AND sheet_id = ?').run(Number(req.params.tid), Number(req.params.id));
  flash(req, 'success', 'Tugas dihapus.');
  redir(req, res, 'piket/' + req.params.id);
});
app.post('/piket/:id/hapus', requireRoles('admin', 'operator'), (req, res) => {
  ensurePiketTables();
  if (!postGuard(req, res)) return;
  db.prepare('DELETE FROM piket_sheets WHERE id = ?').run(Number(req.params.id)); // cascade tasks & checks
  flash(req, 'success', 'Jadwal Piket dihapus.');
  redir(req, res, 'piket');
});

/* ================= LAPORAN EXCEL (staff) ================= */
function sendCsv(res, nama, rows) {
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nama + '-' + lib.today() + '.csv"');
  res.send(csv);
}

/* ================= API cek status peminjaman ruangan (auto-selesai real-time) ================= */
app.get('/api/status-peminjaman-ruangan', requireLogin, (req, res) => {
  const changed = autoSelesaikanPeminjamanRuangan();
  res.json({ changed, ok: true });
});

/* ================= 404 ================= */
app.use((req, res) => {
  if (req.path.startsWith('/maintenance/')) return res.status(404).render('notfound', { page: '' });
  res.status(404).render('notfound', { page: '' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inventaris Pesantren SahabatQu berjalan di port ${PORT}`));
