/* eslint-disable */
// Service worker — satisfies installability ("Add to Home Screen") and receives
// background Web Push so alerts arrive even when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// A fetch handler is required for installability; pass through to the network.
self.addEventListener('fetch', () => {});

// Background push: show the notification even when the companion is backgrounded/closed.
self.addEventListener('push', (event) => {
  let data = { title: 'Glance', body: '' };
  try {
    if (event.data) data = event.data.json();
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Glance', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      renotify: true,
    }),
  );
});

// Tapping a notification focuses the open app, or opens it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) if ('focus' in client) return client.focus();
      return self.clients.openWindow('/');
    }),
  );
});
