'use strict';
/* ============================================================
   Service Worker — Sistem Inventaris Pesantren SahabatQu (PWA)
   Strategi:
   - Navigasi halaman PUBLIK: network-first, cache sebagai cadangan,
     fallback offline.html bila tidak ada koneksi & belum pernah dibuka.
   - Navigasi halaman APLIKASI (dashboard, data, admin): TIDAK di-cache
     (mencegah data pengguna terbaca pengguna lain di perangkat yang sama).
   - Aset statis (css/js/ikon/font): stale-while-revalidate.
   - API, login/logout, backup, logo dinamis: selalu ke jaringan.
   ============================================================ */
const CACHE = 'sintapqu-v14';
const OFFLINE = 'offline.html';
const PRECACHE = [
  OFFLINE,
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png'
];
/* Selalu ke jaringan (jangan pernah di-cache).
   'manifest.webmanifest' ikut di sini karena isinya (ikon) mengikuti LOGO WEBSITE —
   agar perubahan logo langsung terpakai saat aplikasi dipasang/diperbarui. */
const SKIP = ['/api/', 'logout', 'login', 'register', 'backup', 'audit-log', 'profile', '/logo', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function bolehCache(url) {
  if (url.origin !== self.location.origin) return false;
  return !SKIP.some((s) => url.pathname.includes(s));
}
/* Halaman publik yang aman di-cache (relatif terhadap scope service worker) */
function halamanPublik(url) {
  const scope = self.registration.scope;                 // mis. https://host/inventaris-pesantren/
  if (!url.href.startsWith(scope)) return false;
  let p = url.href.slice(scope.length).split('?')[0];     // '' | 'barang/1' | 'inventaris' | ...
  p = p.replace(/^\/+|\/+$/g, '');
  if (p === '' || p === 'index.html') return true;        // halaman website (publik)
  return /^(barang|ruangan)\/\d+$/.test(p)                // hasil scan QR barang/ruangan
    || ['cek-barang', 'inventaris', 'scan-qr', 'login', 'register'].includes(p);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                        // operasi tulis tidak di-cache
  const url = new URL(req.url);
  if (!bolehCache(url)) return;

  // 1) Navigasi halaman
  if (req.mode === 'navigate') {
    const publik = halamanPublik(url);
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (publik && res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(OFFLINE)))
    );
    return;
  }

  // 2) Aset statis -> stale-while-revalidate
  e.respondWith(
    caches.match(req).then((hit) => {
      const jaringan = fetch(req)
        .then((res) => { if (res && res.ok && res.type === 'basic') caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => hit);
      return hit || jaringan;
    })
  );
});
