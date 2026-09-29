'use strict';
(function () {
  // ---------- Ganti tema terang/gelap ----------
  var themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      var next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('sq-theme', next); } catch (e) {}
    });
  }

  // ---------- Sub-menu barang (accordion dropdown) ----------
  var menuBarang = document.getElementById('menuBarang');
  var subnavBarang = document.getElementById('subnavBarang');
  if (menuBarang && subnavBarang) {
    menuBarang.addEventListener('click', function (e) {
      // Buka/tutup dropdown; navigasi lewat item di dalamnya ("Semua Barang"/kategori)
      e.preventDefault();
      if (subnavBarang.classList.contains('open')) {
        subnavBarang.classList.remove('open');
        menuBarang.classList.remove('subnav-open');
      } else {
        subnavBarang.classList.add('open');
        menuBarang.classList.add('subnav-open');
      }
    });
    // Tetap bisa membuka dropdown saat sudah berada di halaman barang
    if (document.getElementById('menuBarang').classList.contains('active')) {
      subnavBarang.classList.add('open');
      menuBarang.classList.add('subnav-open');
    }
  }

  // ---------- Notifikasi lonceng ----------
  var notifBtn = document.getElementById('notifBtn');
  var notifWrap = document.querySelector('.notif-wrap');
  if (notifBtn && notifWrap) {
    notifBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      notifWrap.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!notifWrap.contains(e.target)) notifWrap.classList.remove('open');
    });
  }

  // ---------- Sidebar (mobile) ----------
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const hamburger = document.getElementById('hamburger');
  const sideClose = document.getElementById('sideClose');

  function openSide() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('show');
  }
  function closeSide() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
  }
  if (hamburger) hamburger.addEventListener('click', openSide);
  if (sideClose) sideClose.addEventListener('click', closeSide);
  if (overlay) overlay.addEventListener('click', closeSide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSide(); });

  // ---------- Tombol buka/tutup formulir ----------
  // GOTCHA: setiap halaman yg punya tombol + Tambah memakai id="toggleForm"; daftar target
  // form WAJIB memuat id form milik halaman tsb (dulu #mobilForm tertinggal -> tombol
  // "+ Tambah Mobil" tidak membuka apa pun). Bisa di-override via data-form-target.
  document.querySelectorAll('#toggleForm').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targets = (btn.dataset.formTarget || '#ruanganForm,#barangForm,#userForm,#mobilForm')
        .split(',').map((s) => s.trim()).filter(Boolean);
      targets.forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) el.hidden = !el.hidden;
      });
      const anyOpen = targets.some((sel) => {
        const el = document.querySelector(sel);
        return el && !el.hidden;
      });
      btn.textContent = anyOpen ? 'Tutup Formulir' : (btn.dataset.addLabel || '+ Tambah');
    });
  });

  // ---------- Toggle objek laporan maintenance berdasarkan sub layanan ----------
  window.toggleKategori = function () {
    var sel = document.getElementById('kategoriSelect');
    if (!sel) return;
    var k = sel.value;
    var fNama = document.getElementById('fieldObjekNama');
    var fBarang = document.getElementById('fieldObjekBarang');
    var fRuangan = document.getElementById('fieldObjekRuangan');
    if (fNama) fNama.style.display = k === 'kendaraan' ? '' : 'none';
    if (fBarang) fBarang.style.display = k === 'elektronik' ? '' : 'none';
    if (fRuangan) fRuangan.style.display = k === 'sarana' ? '' : 'none';
    var iNama = document.querySelector('input[name="objek_nama"]');
    var sBarang = document.getElementById('objekBarang');
    if (iNama) iNama.required = k === 'kendaraan';
    if (sBarang) sBarang.required = k === 'elektronik';
    // Bidang pada Perawatan Sarana: wajib hanya saat sub layanan sarana
    var sBidang = document.getElementById('maintBidang');
    if (sBidang) sBidang.required = k === 'sarana';
  };
  if (document.getElementById('kategoriSelect')) window.toggleKategori();

  // ---------- Pengkodean aset: isi sub-bidang sesuai bidang yang dipilih ----------
  // Form menandai dirinya dgn class .pk-form + atribut data-golongan/data-bidang/data-kode/data-preview.
  (function () {
    var PK = window.PENGKODEAN;
    if (!PK || !PK.bidang) return;
    document.querySelectorAll('.pk-form').forEach(function (wrap) {
      var gol = wrap.querySelector('[data-golongan]');
      var bid = wrap.querySelector('[data-bidang]');
      var sub = wrap.querySelector('[data-kode]');
      var preview = wrap.querySelector('[data-preview]');
      var current = wrap.getAttribute('data-kode-saatini') || '';
      if (!bid || !sub) return;
      function fill() {
        var prevVal = sub.value; // simpan pilihan yang sedang aktif agar tidak hilang saat rebuild
        var b = null;
        for (var i = 0; i < PK.bidang.length; i++) {
          if ((bid.value || '').indexOf(PK.bidang[i].kode) === 0) { b = PK.bidang[i]; break; }
        }
        sub.innerHTML = '<option value="">— Pilih —</option>';
        if (b) {
          b.sub.forEach(function (s) {
            var v = s.kode + '. ' + s.nama;
            var opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            // pilih ulang nilai yang barusan dipilih; saat edit pakai nilai tersimpan bila belum ada pilihan
            if (v === prevVal || (v === current && !prevVal)) opt.selected = true;
            sub.appendChild(opt);
          });
        } else {
          sub.innerHTML = '<option value="">— Pilih Bidang dulu —</option>';
        }
        if (preview) {
          var g = gol ? ((gol.value.match(/^\d{2}/) || [''])[0]) : '';
          var bd = (bid.value.match(/^\d{2}/) || [''])[0];
          var s2 = (sub.value.match(/^\s*([A-Za-z])/) || ['', ''])[1] || '';
          var code = [g, bd, s2.toUpperCase()].filter(Boolean).join('.');
          preview.textContent = code ? 'Kode Aset: ' + code.toUpperCase() : '';
          // Pratinjau kode stiker (format kodeQR) — otomatis dari kode aset yang dipilih
          var stPrev = wrap.querySelector('[data-stiker-preview]');
          if (stPrev) {
            var iNama = wrap.querySelector('input[name="nama"]');
            var namaObj = iNama ? iNama.value.trim() : '';
            var now = new Date();
            var bln = String(now.getMonth() + 1).padStart(2, '0');
            var thn = now.getFullYear();
            if (g && bd && s2) {
              stPrev.textContent = (g + bd + s2.toUpperCase() + ' ' + namaObj + ' ' + bln + thn + ' <No.Urut>').toUpperCase();
            } else {
              stPrev.textContent = '— isi Golongan, Bidang & Sub —';
            }
          }
        }
      }
      if (gol) gol.addEventListener('change', fill);
      bid.addEventListener('change', fill);
      sub.addEventListener('change', fill);
      var iNama = wrap.querySelector('input[name="nama"]');
      if (iNama) iNama.addEventListener('input', fill);
      fill();
    });
  })();

  // ---------- Konfirmasi form berbahaya ----------
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm || 'Lanjutkan tindakan ini?')) e.preventDefault();
    });
  });

  // ---------- Edit kategori (submenu Inventaris Barang) ----------
  window.editKategori = function (btn, nama) {
    var item = btn.closest('.subnav-item');
    if (!item) return;
    var cat = item.querySelector('.subnav-cat');
    var form = item.querySelector('.subnav-editform');
    var input = form && form.querySelector('input[name="nama_baru"]');
    if (cat) cat.style.display = 'none';
    if (form) form.hidden = false;
    if (input) { input.focus(); input.select(); }
  };
  window.batalEditKategori = function (btn) {
    var item = btn.closest('.subnav-item');
    if (!item) return;
    var cat = item.querySelector('.subnav-cat');
    var form = item.querySelector('.subnav-editform');
    if (cat) cat.style.display = '';
    if (form) form.hidden = true;
  };

  // ---------- Flash otomatis memudar ----------
  document.querySelectorAll('.flash').forEach((el) => {
    setTimeout(() => {
      el.style.transition = 'opacity .6s ease, transform .6s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
      setTimeout(() => el.remove(), 650);
    }, 5200);
  });
})();
