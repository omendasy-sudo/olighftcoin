const CACHE_NAME = 'olighft-v5';
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

// Install — cache core shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', e => {
  // Skip non-GET and cross-origin
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request).then(res => {
      // Cache successful responses
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
