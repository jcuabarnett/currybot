// Bump CACHE on every release that must reach installed apps immediately.
// When a new version activates it clears old caches and reloads any open app windows,
// so phones pick up the update on their own.
const CACHE = 'currybot-v4';

const SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Pre-caching is best-effort: a failed request must never block the update.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k !== CACHE);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    // Upgrading from an older version: reload open windows so they show the new app now.
    if (old.length) {
      const wins = await self.clients.matchAll({ type: 'window' });
      await Promise.all(wins.map(w => w.navigate(w.url).catch(() => {})));
    }
  })());
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
      fetch(req, { cache: 'no-store' }).then(res => putInCache(req, res))
        .catch(() => caches.match(req).then(c => c || caches.match('/')))
    );
    return;
  }

  // Everything else (icons, fonts, photos): cache first.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => putInCache(req, res)))
  );
});
