/* 離線快取：App 本體先用快取（秒開、沒網路也能用），課表先上網拿最新、拿不到再用快取 */
const VERSION = 'v1.1.1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'data/courses.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/courses.json')) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put('data/courses.json', copy)); return r;
    }).catch(() => caches.match('data/courses.json')));
    return;
  }
  if (url.pathname.includes('/voice/')) {  // 語音檔：有存就用存的，沒有就下載並存起來
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    })));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
