// Service worker: кешує застосунок і демо-карту, щоб усе працювало без інтернету.
const CACHE = 'nav-offline-v1';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/router.js', 'src/instructions.js', 'src/session.js',
  'src/mapview.js', 'src/speech.js', 'src/storage.js', 'src/geo.js',
  'data/demo.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Спершу мережа (щоб отримувати оновлення), а без інтернету — кеш.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
