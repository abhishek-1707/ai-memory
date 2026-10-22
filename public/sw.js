/* global URL, caches, fetch, self */

const CACHE_NAME = 'omnimemory-static-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/api-client.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/sw.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    !STATIC_ASSETS.includes(url.pathname)
  ) {
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        }),
    ),
  );
});
