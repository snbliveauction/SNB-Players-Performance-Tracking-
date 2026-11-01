/* SNB service worker: push notifications only (no offline caching, so the site always loads the newest version) */
self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.map((k) => caches.delete(k)))) /* remove caches left by the older offline version */
      .then(() => self.clients.claim())
  );
});

/* a fetch handler keeps the site installable on Android; it does nothing, so the network is always used */
self.addEventListener('fetch', () => {});

/* the server sends data-only messages: {title, body, url, tag} */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { data: { body: e.data ? e.data.text() : '' } }; }
  const n = d.notification || {}, x = d.data || {};
  const title = n.title || x.title || 'SNB';
  const body = n.body || x.body || '';
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: 'apple-touch-icon.png', badge: 'favicon.png', lang: 'bn',
    tag: x.tag || ('snb-' + Date.now()), data: { url: x.url || './' }
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
