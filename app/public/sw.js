// Offline cache: network-first for the app shell, cache-first for heavy static assets.
const C = 'augur-v4';
const HEAVY = /\/(engine|model|pieces|lesson)\//;
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./', './app.html', './history.html', './engine/stockfish-19-lite-single.js', './engine/stockfish-19-lite-single.wasm', './model/augur.json', './model/augur.bin']))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url); if (url.origin !== location.origin) return;
  if (HEAVY.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(e.request, cp)); return res; })));
  } else {
    e.respondWith(fetch(e.request).then(res => { const cp = res.clone(); caches.open(C).then(c => c.put(e.request, cp)); return res; }).catch(() => caches.match(e.request)));
  }
});
