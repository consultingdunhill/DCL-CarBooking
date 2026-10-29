/// <reference lib="webworker" />
// Service worker: precached app shell (offline start) and Web Push notifications.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// `/api` is the API when both share one address (`pnpm share`), e.g. a receipt opened in a new tab.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }));
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('push', (event) => {
  const data = (event.data?.json() ?? {}) as { title?: string; body?: string; link?: string; id?: string; type?: string };
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Fleet', {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.id,
      data: { link: data.link ?? '/' },
      requireInteraction: Boolean(data.type?.includes('URGENT')),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data as { link?: string } | undefined)?.link ?? '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = all.find((c) => 'focus' in c) as WindowClient | undefined;
      if (open) {
        await open.navigate(link).catch(() => {});
        return open.focus();
      }
      return self.clients.openWindow(link);
    })(),
  );
});
