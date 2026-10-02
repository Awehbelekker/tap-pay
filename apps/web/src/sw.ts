/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

/**
 * Service worker: precached app shell (opens offline; SPEC 15) and Web Push alerts (SPEC 12).
 * API calls are never cached: bill data must be live.
 */
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/v1\//, /^\/t\//, /^\/b\//, /^\/r\//] }));

self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data?.json() as { title?: string; body?: string; billId?: string | null; kind?: string };
    } catch {
      return { title: "Payment update" };
    }
  })();
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Payment update", {
      body: data.body ?? "",
      // One notification per bill: a newer alert replaces the older one.
      ...(data.billId ? { tag: `bill-${data.billId}` } : {}),
      data: { billId: data.billId ?? null },
      icon: "/icon.svg",
      badge: "/icon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const billId = (event.notification.data as { billId?: string | null } | undefined)?.billId;
  const url = billId ? `/#/bill/${billId}` : "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = wins[0] as WindowClient | undefined;
      if (open) {
        await open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
