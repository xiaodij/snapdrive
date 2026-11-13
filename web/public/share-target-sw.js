// Imported into the generated service worker (workbox importScripts).
//
// Android/Chrome "Share → SnapDrive" POSTs the photos to /share-target. The service worker
// parks them in a cache and redirects to the app, which picks them up on load. iOS does not
// support Web Share Target, so this only ever runs on Android and desktop Chrome.
const SHARE_CACHE = 'snapdrive-shared';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;

  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
        const cache = await caches.open(SHARE_CACHE);
        let i = 0;
        for (const file of files) {
          const key = `/shared/${Date.now()}-${i++}`;
          await cache.put(
            key,
            new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg', 'X-Filename': encodeURIComponent(file.name || 'photo') } }),
          );
        }
        return Response.redirect(`/?shared=${files.length}`, 303);
      } catch (err) {
        return Response.redirect('/?shared=error', 303);
      }
    })(),
  );
});
