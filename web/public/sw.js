// Service worker. The build replaces __APP_VERSION__, so every deploy produces a new file
// and the browser installs a new worker, which precaches the new shell and drops old caches.
const VERSION = '__APP_VERSION__';
const CACHE = `shell-${VERSION}`;
const STATIC = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png'];

/** Fetch the current index.html and every hashed asset it references. */
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) throw new Error(`shell fetch failed: ${res.status}`);
  const html = await res.clone().text();
  const assets = [...new Set(html.match(/\/assets\/[^"' )]+/g) || [])];
  await cache.put('/', res);
  await cache.addAll([...assets, ...STATIC]);
}

self.addEventListener('install', (e) => {
  // Activate as soon as the new shell is cached; the page decides when to reload.
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source && e.source.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json' || url.pathname === '/sw.js') return;

  if (e.request.mode === 'navigate') {
    // Network first so a fresh launch always gets the latest deploy; cached shell when offline.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) {
    // Hashed assets never change, so cache first.
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// ---- Web Push ----
self.addEventListener('push', (e) => {
  let msg = { title: 'Clem', body: 'Time to log a meal.', url: '/#today' };
  try {
    if (e.data) msg = { ...msg, ...e.data.json() };
  } catch {}
  e.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: msg.url },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === location.origin) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
