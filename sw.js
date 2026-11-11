// ASYS Machinery — service worker: ağ öncelikli; ağ yoksa kabuk önbellekten. Veri her zaman sunucudan (Supabase).
const CACHE = "asys-machinery-v4";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./pdfmake.min.js", "./vfs_fonts.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // Supabase ve CDN istekleri doğrudan ağa
  // index.html ve config.js her zaman taze (GitHub Pages 10 dk HTTP önbelleği atlanır); diğerleri ağ öncelikli
  const fresh = e.request.mode === "navigate" || /\/(index\.html|config\.js)?$/.test(u.pathname);
  e.respondWith(fetch(fresh ? new Request(e.request, { cache: "no-store" }) : e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)).catch(() => {}); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
