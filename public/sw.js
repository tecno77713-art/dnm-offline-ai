const CACHE_NAME = "dnm-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const appUrl = new URL("./", self.registration.scope);
    const response = await fetch(appUrl);
    if (!response.ok) throw new Error("No se pudo guardar la página para usarla sin conexión.");

    const html = await response.clone().text();
    await cache.put(appUrl, response);

    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], appUrl))
      .filter((url) => url.origin === self.location.origin);
    await cache.addAll(assets);

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => (key.startsWith("brisa-shell-") || key.startsWith("dnm-shell-")) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        await cache.put("./", response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match("./"));
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          return caches.open(CACHE_NAME)
            .then((cache) => cache.put(request, response.clone()))
            .then(() => response);
        }
        return response;
      });
    })
  );
});
