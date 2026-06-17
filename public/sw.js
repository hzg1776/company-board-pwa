const ASSET_VERSION = "__ASSET_VERSION__";
const CACHE_NAME = `palziv-portal-v${ASSET_VERSION}`;
const SHELL_ASSETS = [
  "/index.html",
  "/styles.css?v=__ASSET_VERSION__",
  "/app.js?v=__ASSET_VERSION__",
  "/device-setup.js",
  "/manifest.webmanifest",
  "/assets/logo.svg",
  "/assets/palziv-logo.png",
  "/assets/palziv-wordmark.png"
];

function defaultNotificationPayload() {
  return {
    title: "Palziv alert",
    body: "Open the Palziv portal for details.",
    url: "/palzivalerts/employee"
  };
}

async function getClients() {
  return self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("push", (event) => {
  const fallback = defaultNotificationPayload();
  let payload = fallback;

  if (event.data) {
    const text = event.data.text();

    try {
      payload = {
        ...fallback,
        ...JSON.parse(text || "{}")
      };
    } catch {
      if (text) {
        payload = {
          ...fallback,
          body: text
        };
      }
    }
  }

  const title = String(payload.title || fallback.title);
  const url = String(payload?.data?.url || payload.url || fallback.url);
  const tag = String(payload.tag || payload?.data?.postId || "palziv-alert");

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: String(payload.body || fallback.body),
        icon: "/assets/logo.svg",
        badge: "/assets/logo.svg",
        tag,
        renotify: Boolean(payload.renotify),
        requireInteraction: Boolean(payload.requireInteraction),
        data: {
          url
        }
      });

      const clients = await getClients();
      await Promise.all(
        clients.map((client) =>
          client.postMessage({
            type: "board-updated"
          })
        )
      );
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(String(event.notification?.data?.url || "/palzivalerts/employee"), self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clients = await getClients();
      const existingClient = clients.find((client) => client.url.startsWith(self.location.origin));

      if (existingClient && "navigate" in existingClient) {
        await existingClient.navigate(url);
        await existingClient.focus();
        return;
      }

      await self.clients.openWindow(url);
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).catch(async () => {
        return (
          (await caches.match("/index.html")) ||
          (await caches.match(event.request))
        );
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request, {
      cache: url.searchParams.has("v") ? "no-store" : "default"
    })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
