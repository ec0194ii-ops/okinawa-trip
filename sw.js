/* Keeps the app shell and built-in photos on the phone so the app opens fast, even with a weak signal.
   Shared data (plans, photos, weather) always comes from the network. */
const V = 'okt-shell-v8';
const SHELL = ['./', 'index.html', 'sync.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (/\/img\/[^/]+\.webp$|\/icon-\d+\.png$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)); } return r; })));
    return;
  }
  // always ask the server whether the page changed (never reuse the browser's short-term copy)
  e.respondWith(fetch(req, { cache:'no-cache' }).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)); } return r; })
    .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Okinawa Trip', {body:d.body || '新しいおしらせがあります', icon:'icon-192.png', badge:'icon-192.png', tag:d.tag || 'okt', renotify:true, data:{url:d.url || './'}}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(ws => { const w = ws.find(x => x.url.includes(self.registration.scope)); return w ? w.focus() : self.clients.openWindow(e.notification.data?.url || './'); }));
});
