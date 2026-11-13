const CACHE_NAME = 'vula-static-v2';
const ASSETS_TO_CACHE = [
  '/.vula.cache.js',
  '/.vula.cache.css',
];

function isCacheableStaticRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.mode === 'navigate') return false;
  if (request.headers && request.headers.get('authorization')) return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;

  // Never cache API responses, server-component RPCs, or dynamic SSR fragments
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_vula/')) {
    return false;
  }

  // Only cache versioned/static bundle, font, style, and media assets
  return (
    url.pathname === '/.vula.cache.js' ||
    url.pathname === '/.vula.cache.css' ||
    url.pathname.startsWith('/chunks/') ||
    /\.(js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|ico)$/i.test(url.pathname)
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        ASSETS_TO_CACHE.map((asset) => cache.add(asset))
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

self.addEventListener('fetch', (event) => {
  if (!isCacheableStaticRequest(event.request)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((fetchResponse) => {
        if (fetchResponse && fetchResponse.status === 200 && fetchResponse.type === 'basic') {
          const responseClone = fetchResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return fetchResponse;
      });
    })
  );
});
