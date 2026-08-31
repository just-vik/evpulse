/* EVPulse — Service Worker v5: offline shell + TTL-aware API cache + push */
const V = 5;
const SHELL_CACHE    = `tesla-shell-v${V}`;
const API_CACHE      = `tesla-api-v${V}`;
const REALTIME_CACHE = `tesla-rt-v${V}`;
const ALL_CACHES     = [SHELL_CACHE, API_CACHE, REALTIME_CACHE];

const PRECACHE = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

// Routes that hold fast-changing vehicle data — shorter TTL
const REALTIME_PREFIXES = [
  '/api/v1/vehicles/',
  '/api/v1/telemetry/',
  '/api/v1/battery/',
];

// TTL in ms
const REALTIME_TTL = 2 * 60 * 60 * 1000;  // 2 h
const API_TTL      = 24 * 60 * 60 * 1000; // 24 h

/* ── helpers ── */
function isRealtimeRoute(pathname) {
  return REALTIME_PREFIXES.some((p) => pathname.startsWith(p));
}

async function storeWithTimestamp(cacheName, request, response) {
  const headers = new Headers(response.headers);
  headers.set('x-cache-time', String(Date.now()));
  const stamped = new Response(await response.clone().blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const cache = await caches.open(cacheName);
  await cache.put(request, stamped);
}

async function getFreshCached(cacheName, request, maxAgeMs) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (!cached) return null;
  const age = Date.now() - Number(cached.headers.get('x-cache-time') || 0);
  return age <= maxAgeMs ? cached : null;
}

/* ── lifecycle ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

/* ── fetch ── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    const rt      = isRealtimeRoute(pathname);
    const cacheNm = rt ? REALTIME_CACHE : API_CACHE;
    const ttl     = rt ? REALTIME_TTL   : API_TTL;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) storeWithTimestamp(cacheNm, request, response.clone());
          return response;
        })
        .catch(async () => {
          // Network failed — return fresh-enough cache or expired as last resort
          const fresh = await getFreshCached(cacheNm, request, ttl);
          if (fresh) return fresh;
          const stale = await caches.open(cacheNm).then((c) => c.match(request));
          return stale ?? new Response(JSON.stringify({ offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'x-offline': '1' },
          });
        }),
    );
    return;
  }

  // Shell / static: cache-first
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});

/* ── push notifications ── */
self.addEventListener('push', (event) => {
  let payload = { title: 'EVPulse', body: 'You have a new notification', url: '/dashboard' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag || 'evpulse',
      data: { url: payload.url || '/dashboard' },
      requireInteraction: payload.requireInteraction || false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          if ('navigate' in c) c.navigate(url);
          return c.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});

/* ── background sync (when supported) ── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'evpulse-sync') {
    // Just claim clients — TanStack Query will refetch on window focus
    event.waitUntil(self.clients.claim());
  }
});
