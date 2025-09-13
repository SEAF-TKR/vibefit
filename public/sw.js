self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urlsToCache = event.data.urls;
    event.waitUntil(
      caches.open('vibefit-cache-v1').then((cache) => {
        return cache.addAll(urlsToCache);
      })
    );
  }
});
