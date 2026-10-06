/* FamilyPoints Service Worker — PWA instalable + caché offline */
const CACHE = "familypoints-v24";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/stats.css",
  "/fonts.css",
  "/fonts/Baloo2.woff2",
  "/fonts/Nunito.woff2",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png"
];

// Instalar: precache básico
self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// Activar: limpiar cachés viejas
self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: red primero, si falla (offline) cae a caché.
// Para las rutas API dinámicas (login, tareas...) NO cacheamos respuesta por defecto,
// pero ofrecemos el HTML/styles desde caché cuando no hay red.
self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);

  // Solo cacheamos GET del mismo origen, no las llamadas /api/ (datos vivos)
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return; // deja pasar a la red (o falla si offline)
  }

  ev.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match("/index.html")))
  );
});
