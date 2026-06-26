/* eslint-disable */
// Minimal service worker — satisfies the install ("Add to Home Screen") criteria.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// A fetch handler is required for installability; pass through to the network.
self.addEventListener('fetch', () => {});
