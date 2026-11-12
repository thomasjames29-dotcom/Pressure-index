const CACHE_NAME = 'pressure-index-v5';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/goal-timing.css', '/model-analysis.css', '/match-card-summary.css', '/app.js', '/lib/browser-calibration.mjs', '/lib/inplay-model.mjs', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then((response) => {
      const copy = response.clone();
      const isAppShell = event.request.url.startsWith(self.location.origin) && (
        event.request.url.includes('/index.html') || event.request.url.includes('/styles.css') ||
        event.request.url.includes('/goal-timing.css') || event.request.url.includes('/model-analysis.css') ||
        event.request.url.includes('/match-card-summary.css') || event.request.url.includes('/app.js') ||
        event.request.url.includes('/lib/browser-calibration.mjs') || event.request.url.includes('/lib/inplay-model.mjs') ||
        event.request.url.includes('/icon.svg') || event.request.url.includes('/manifest.webmanifest') ||
        new URL(event.request.url).pathname === '/'
      );
      if (response.ok && isAppShell) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => cached || Response.error());
  }));
});
