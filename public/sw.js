/**
 * Drone Hive AI service worker.
 *
 * Purpose: make the Home Screen app open instantly and show the app (not a
 * browser error page) when the phone is offline.
 *
 * Safety rules:
 *  - NETWORK FIRST: the newest deploy is always used when online; the cache is
 *    only a fallback, so updates never get "stuck".
 *  - Never touches /api/* (AI requests, status) or anything not GET.
 *  - Never caches other websites (e.g. Google sign-in).
 */
const CACHE = 'dhai-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/tokens.css',
  '/css/base.css',
  '/css/sidebar.css',
  '/css/chat.css',
  '/css/settings.css',
  '/css/auth.css',
  '/js/theme-init.js',
  '/js/main.js',
  '/assets/brand/emblem.png',
  '/assets/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}) // offline install is best-effort
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
});
