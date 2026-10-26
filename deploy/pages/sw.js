self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('thp-')) await caches.delete(key);
  await self.clients.claim();
  await self.registration.unregister();
})()));
