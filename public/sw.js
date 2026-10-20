// Bump CACHE whenever the shell list changes. The page itself is fetched network-first,
// so normal deploys show up on the next open without a bump.
const CACHE = 'currybot-v3';

const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
  'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Shrikhand&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(req, res) {
  if (res.ok && req.method === 'GET') {
    const clone = res.clone();
    caches.open(CACHE).then(c => c.put(req, clone));
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API calls: always network, never cached
  if (url.pathname.startsWith('/api/')) return;

  // The app page: network first so new versions appear straight away; cache when offline.
  if (req.mode === 'navigate' || (url.origin === location.origin && url.pathname === '/')) {
    e.respondWith(
      fetch(req).then(res => putInCache(req, res))
        .catch(() => caches.match(req).then(c => c || caches.match('/')))
    );
    return;
  }

  // Everything else (icons, fonts): cache first.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => putInCache(req, res)))
  );
});
