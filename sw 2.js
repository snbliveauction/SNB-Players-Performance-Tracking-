/* SNB service worker: offline shell + push notifications (no Firebase SDK needed here) */
const VER = 'snb-v3';
const SHELL = ['./', 'index.html', 'logo.webp', 'favicon.png', 'apple-touch-icon.png', 'manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VER)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const STATIC_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$|^www\.gstatic\.com$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (!same && !STATIC_HOSTS.test(url.hostname)) return; /* Firestore, auth, FCM go straight to the network */
  if (same && (url.pathname.endsWith('/config.js') || url.pathname.startsWith('/api/'))) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VER).then((c) => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html', { ignoreSearch: true }).then((r) => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VER).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* push: the server sends data-only messages {title, body, url, tag} */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { data: { body: e.data ? e.data.text() : '' } }; }
  const n = d.notification || {}, x = d.data || {};
  const title = n.title || x.title || 'SNB';
  const body = n.body || x.body || '';
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: 'apple-touch-icon.png', badge: 'favicon.png', lang: 'bn',
    tag: x.tag || 'snb', renotify: true, data: { url: x.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.focus(); if ('navigate' in c && c.url !== target) c.navigate(target).catch(() => {}); return; } }
      return self.clients.openWindow(target);
    })
  );
});
