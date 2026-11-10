// Service worker : l'app s'ouvre même hors ligne, le programme est toujours rechargé en priorité depuis le réseau.
// Changer VERSION à chaque publication du code (même valeur que dans index.html et app.js).
const VERSION = "4";
const CACHE = `a8a-paddock-v${VERSION}`;
const SHELL = ["./", "index.html", `css/styles.css?v=${VERSION}`, `js/app.js?v=${VERSION}`, `js/ics.js?v=${VERSION}`, "manifest.webmanifest", "icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Réseau d'abord (données et code toujours frais), cache en secours hors ligne.
  e.respondWith(
    // cache: "no-cache" = toujours redemander au serveur si le fichier a changé (évite de mélanger deux versions)
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
