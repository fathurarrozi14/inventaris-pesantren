'use strict';
/* ============================================================
   PWA: registrasi Service Worker + tombol "Instal Aplikasi"
   URL service worker dihitung dari lokasi skrip ini sendiri,
   sehingga tetap benar walau aplikasi berada di subpath
   (mis. /inventaris-pesantren/) atau di halaman berkedalaman 2.
   ============================================================ */
(function () {
  // ---- 1. Registrasi Service Worker ----
  var me = document.currentScript;
  if (me && me.src && 'serviceWorker' in navigator) {
    var swUrl = me.src.replace(/pwa\.js.*$/, 'sw.js');
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(swUrl).catch(function () { /* diabaikan (mis. http) */ });
    });
  }

  // ---- 2. Tombol Instal Aplikasi (homescreen) ----
  // Tombol HANYA ditampilkan di BERANDA website (halaman dengan topbar `.fx-top-actions`),
  // ditempel di topbar tersebut — jadi tidak muncul di dashboard/menu aplikasi,
  // maupun di halaman publik lain, dan tidak pernah menutupi menu apa pun.
  var promptEvent = null;
  var tombol = null;

  // Beranda = satu-satunya halaman yang punya topbar beranda (.fx-top-actions).
  function wadahBeranda() {
    return document.querySelector('.fx-top-actions');
  }

  function buatTombol(label, aksi) {
    if (tombol) return tombol;
    var wadah = wadahBeranda();
    if (!wadah) return null; // bukan beranda -> tombol instal tidak ditampilkan
    tombol = document.createElement('button');
    tombol.type = 'button';
    tombol.id = 'pwaInstallBtn';
    tombol.className = 'pwa-install inline';
    tombol.setAttribute('aria-label', 'Instal aplikasi ke layar utama');
    tombol.title = 'Instal aplikasi ke layar utama';
    tombol.innerHTML = '<span class="pwa-install-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span><span class="pwa-install-label">' + label + '</span>';
    tombol.addEventListener('click', aksi);
    wadah.insertBefore(tombol, wadah.firstChild);
    return tombol;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    promptEvent = e;
    buatTombol('Instal Aplikasi', function () {
      if (!promptEvent) return;
      promptEvent.prompt();
      promptEvent.userChoice.then(function () { promptEvent = null; if (tombol) tombol.remove(); tombol = null; });
    });
  });

  window.addEventListener('appinstalled', function () {
    if (tombol) tombol.remove();
    tombol = null; promptEvent = null;
  });

  // iOS Safari tidak mendukung beforeinstallprompt -> tampilkan petunjuk singkat
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isIOS && !standalone) {
    buatTombol('Pasang di Homescreen', function () {
      alert('Cara pasang di iPhone/iPad:\n\n1. Buka menu Bagikan (ikon ⬆️) di Safari\n2. Pilih "Tambahkan ke Layar Utama" / "Add to Home Screen"\n3. Ketuk "Tambah"');
    });
  }
})();
