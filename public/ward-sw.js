// Flagship 4c — the ward tablet's service worker (scope /ward). It keeps the
// app itself available with the network cut: the /ward page (network first,
// the last good copy when offline) and the app's static files (cache first).
// It never caches an API response: patient data lives only in the app's
// encrypted IndexedDB store (src/lib/ward/store.ts).
const CACHE = "aarogya-ward-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("aarogya-ward") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate" && url.pathname.startsWith("/ward")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put("/ward", copy));
          }
          return response;
        })
        .catch(() => caches.match("/ward").then((cached) => cached || Response.error()))
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/ward.webmanifest" || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return response;
      }))
    );
  }
});
