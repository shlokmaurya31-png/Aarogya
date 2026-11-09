// Flagship 4 (3) — the main app's service worker (scope /). It caches only what
// is the same for every visitor:
//   - the public site's pages (the allow-list below), and only when the server
//     marked the response cacheable — a signed-in visitor's copy of a public
//     page is sent with Cache-Control: no-store and is never kept;
//   - static files (/_next/static, /icons, /fonts, the offline page).
// Never a signed-in page's HTML, never a React Server Component payload, never
// an API response. Logout and session expiry clear its caches (the "clear"
// message below; a 401 from the API). The ward tablet's own cache
// ("aarogya-ward-*", public/ward-sw.js) holds only that app's code and is
// left to the ward's service worker.
const CACHE_NAME = "aarogya-shell-v3";
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png"];
const PUBLIC_PAGES = ["/", "/company", "/platform", "/standards"];
const STATIC_PREFIXES = ["/_next/static/", "/icons/", "/fonts/"];
const OWN_CACHE = (key) => key.startsWith("aarogya-shell");

function isPublicPage(pathname) {
  return PUBLIC_PAGES.some((p) => pathname === p || (p !== "/" && pathname.startsWith(p + "/")));
}

function isStatic(pathname) {
  return pathname === OFFLINE_URL || STATIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Only a plain, successful, shareable response may be kept. */
function cacheable(response) {
  if (!response || !response.ok || response.redirected || response.type !== "basic") return false;
  const cc = (response.headers.get("cache-control") || "").toLowerCase();
  return !/no-store|private/.test(cc);
}

function clearOwnCaches() {
  return caches.keys().then((keys) => Promise.all(keys.filter(OWN_CACHE).map((k) => caches.delete(k))));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => OWN_CACHE(k) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "aarogya:clear-caches") event.waitUntil(clearOwnCaches());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API: never cached. A 401 means the session ended (expiry, revoke):
  // clear the caches on the way past.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.status === 401) event.waitUntil(clearOwnCaches());
        return response;
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    if (!isPublicPage(url.pathname) || url.search) {
      // Signed-in and other pages: the network only; offline, the offline page.
      event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())));
      return;
    }
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (cacheable(response)) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL)).then((r) => r || Response.error()))
    );
    return;
  }

  // Static files: cache first. Anything else (RSC payloads, data, images
  // served by routes) goes to the network untouched.
  if (!isStatic(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (cacheable(response)) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    })
  );
});
