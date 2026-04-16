const CACHE_VERSION = '20260416b';
const CACHE_NAME = 'olighft-' + CACHE_VERSION;
const PRECACHE = [
  '/',
  '/dashboard.html',
  '/wallet.html',
  '/send.html',
  '/receive.html',
  '/swap.html',
  '/auth.html',
  '/invite.html',
  '/activity.html',
  '/card-visa.html',
  '/card-mastercard.html',
  '/card-amex.html',
  '/card-platinum.html',
  '/card-gold.html',
  '/card-black.html',
  '/staking-backend.js',
  '/escrow-backend.js',
  '/p2p-backend.js',
  '/manifest.json'
];

// Install — cache core shell, skip waiting immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate — nuke ALL old caches, claim all clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Listen for cache-clear message from pages
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CLEAR_ALL_CACHES') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
