'use strict';
// No fetch handler: authenticated pages and API responses never enter an offline cache.
self.addEventListener('push', event => {
  // Ignore event payloads: private repository details stay off the lock screen.
  event.waitUntil(self.registration.showNotification('От агентов', {
    body: 'В репозитории появились изменения. Открой Хаб.',
    icon: new URL('icons/icon-192.png', self.registration.scope).href,
    tag: 'hub-agent-push',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // The destination is fixed to this worker's scope; payloads cannot supply URLs.
  const target = new URL('./', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === target);
    if (existing) return existing.focus();
    return self.clients.openWindow(target);
  })());
});
