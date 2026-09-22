/* Tango Kilo Finder — offline shell cache. Bump CACHE to force an update. */
const CACHE = "tkfinder-v1";
const ASSETS = ["./", "index.html", "manifest.webmanifest",
                "icon-192.png", "icon-512.png", "icon-maskable.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                 // leave maps/etc. alone
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then(r => r || fetch(e.request).catch(() => caches.match("index.html")))
  );
});
