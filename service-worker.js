const CACHE_NAME = "Amortization-v1.3";

const CACHE_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon512.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      const cachePromises = CACHE_FILES.map(async (url) => {
        const response = await fetch(
          new Request(url, { cache: "reload" })
        );

        if (!response.ok) {
          throw new Error(`Network response was not OK for ${url}`);
        }

        await cache.put(url, response);
      });

      await Promise.all(cachePromises);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((cacheName) => {
            return (
              cacheName.startsWith("Amortization-v") &&
              cacheName !== CACHE_NAME
            );
          })
          .map((cacheName) => caches.delete(cacheName))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(event.request);

      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        return await fetch(event.request);
      } catch (error) {
        if (event.request.mode === "navigate") {
          return (
            (await cache.match("./index.html")) ||
            (await cache.match("./"))
          );
        }

        return new Response("Offline resource not available", {
          status: 503,
          statusText: "Offline"
        });
      }
    })()
  );
});