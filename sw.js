// Praca offline: najpierw sieć (świeże wersje), w razie braku — kopia z pamięci.
const CACHE = "repertuar-v11";
const FILES = [
  "./", "index.html", "style.css", "app.js", "board.js", "pegasus.js", "repertoire.js",
  "lib/chess.js", "engine.js", "lichess.js",
  "lib/stockfish/stockfish-17.1-lite-single-03e3232.js", "lib/stockfish/stockfish-17.1-lite-single-03e3232.wasm", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
  ..."wb".split("").flatMap((c) => "KQRBNP".split("").map((p) => `piece/${c}${p}.svg`)),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (e.request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // Kod jednorazowego logowania Lichess nie powinien trafić do pamięci offline.
  if (url.searchParams.has("code") || url.searchParams.has("error")) return;
  if (/\/(?:piece|lib\/stockfish)\//.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request).then((r) => {
      if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
      return r;
    })));
    return;
  }
  e.respondWith(
    // no-cache: zawsze pytaj serwer o świeżą wersję (omija 10-min pamięć GitHub Pages)
    fetch(e.request, { cache: "no-cache" })
      .then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
