/* Coaching app — push only. No offline cache of the app shell.
   Caching the SPA here would serve a stale bundle after deploys. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "Your coaching app", body: "Open your hub.", url: "/client" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch { /* keep defaults */ }
  const url = data.url || "/client";
  event.waitUntil(
    self.registration.showNotification(data.title || "Your coaching app", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/client";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const hit = all.find((c) => c.url.includes(self.location.origin));
    if (hit) {
      await hit.focus();
      if ("navigate" in hit) await hit.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});
