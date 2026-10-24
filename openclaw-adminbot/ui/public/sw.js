// Jinesis Portal – Service Worker
// Handles offline caching and push notifications.

const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const CONTROL_CACHE_LIMIT = 3;

// Minimal app-shell files to precache.
const PRECACHE_URLS = ["./"];

// A hashed asset must never resolve to the index.html SPA fallback: a missing
// hash served as text/html would be cached and later executed as a JS module,
// crashing the app on reload until the cache is cleared. Guard reads and writes.
const isHtmlResponse = (response) =>
  (response.headers.get("content-type") || "").includes("text/html");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Keep a small prior-build window so open tabs can still load old hashed chunks after updates.
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        const controlKeys = keys.filter((key) => key.startsWith(CACHE_PREFIX));
        const priorCacheLimit = Math.max(0, CONTROL_CACHE_LIMIT - 1);
        const retained = new Set([
          ...controlKeys.filter((key) => key !== CACHE_NAME).slice(-priorCacheLimit),
          CACHE_NAME,
        ]);
        return Promise.all(
          controlKeys.filter((key) => !retained.has(key)).map((key) => caches.delete(key)),
        );
      }),
    ]),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "ADMINBOT_OFFLINE_STATUS") return;
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const entries = await Promise.all(
        PRECACHE_URLS.map((url) => cache.match(new URL(url, self.registration.scope).href)),
      );
      event.ports[0]?.postMessage({ offlineReady: entries.every(Boolean) });
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Skip non-UI routes — API, RPC, and plugin routes should never be cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/")
  ) {
    return;
  }

  if (event.request.mode === "navigate") {
    // A one-time browser-managed navigation preserves reverse-proxy auth dialogs.
    if (url.searchParams.get("__adminbot_native_auth") === "1") return;
    const shell = new URL("./", self.registration.scope).href;
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 401 && response.headers.has("WWW-Authenticate")) {
            url.searchParams.set("__adminbot_native_auth", "1");
            return Response.redirect(url.href, 302);
          }
          return response;
        })
        .catch(
          async () => (await (await caches.open(CACHE_NAME)).match(shell)) ?? Response.error(),
        ),
    );
    return;
  }

  // Cache-first for hashed assets; network-first for HTML/other. Reading across
  // all retained build caches lets open tabs still load their prior-build
  // chunks, but a cached HTML fallback is ignored so a poisoned entry can never
  // be served as a module — it self-heals on the next load.
  if (url.pathname.startsWith(new URL("assets/", self.registration.scope).pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached && !isHtmlResponse(cached)) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          if (response.ok && !isHtmlResponse(response)) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)),
            );
          }
          return response;
        });
      }),
    );
  } else {
    // Only known public UI files belong in the shared shell cache. Authenticated
    // records use the account-scoped IndexedDB cache, never the service worker.
    const publicFiles = [
      "manifest.webmanifest",
      "favicon.svg",
      "favicon-32.png",
      "apple-touch-icon.png",
      "favicon.ico",
      "adminbot-logo.png",
      "bg-dark.png",
      "paperflow.svg",
    ];
    const allowed = publicFiles.some(
      (name) => url.href === new URL(name, self.registration.scope).href,
    );
    if (!allowed) return;
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && !isHtmlResponse(response)) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)),
            );
          }
          return response;
        })
        .catch(async () => (await caches.match(event.request)) ?? Response.error()),
    );
  }
});

// --- Web Push ---

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "OpenClaw", body: event.data.text() };
  }

  const title = data.title || "OpenClaw";
  const options = {
    body: data.body || "",
    icon: "./apple-touch-icon.png",
    badge: "./favicon-32.png",
    tag: data.tag || "openclaw-notification",
    data: { url: data.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open.
      for (const client of clients) {
        if (new URL(client.url).pathname === new URL(targetUrl, self.location.origin).pathname) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
