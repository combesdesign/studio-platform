/* Snowy Pilates Club — client app service worker.
   - App shell + static assets: cache-first (versioned cache; build.mjs swaps in the build id below).
   - Everything else same-origin (navigations, data files): network-first, falling back to cache.
   - Cross-origin API calls (Supabase, Stripe) and non-GET requests are never touched. */
const VERSION = '__BUILD__';
const CACHE = 'spc-client-' + VERSION;
const SHELL = [
  './', 'index.html', 'assets/client.js', 'assets/client.css', 'manifest.webmanifest',
  'favicon.svg', 'apple-touch-icon.png', 'icons/icon-192.png',
  'brand/flower.svg', 'brand/flower-white.svg', 'brand/logo.svg', 'brand/logo-white.svg',
  'img/portrait.webp', 'img/wide.webp', 'img/square.webp',
  'img/libby.webp', 'img/julia.webp', 'img/grace-t.webp', 'img/grace-p.webp',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // add individually so one missing file doesn't sink the whole install
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('spc-client-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isStatic = (url) =>
  /\/(assets|brand|img|icons)\//.test(url.pathname) || /\.(js|css|svg|png|webp|woff2?|ttf|otf|webmanifest)$/.test(url.pathname);

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await caches.match('index.html')) || (await caches.match('./'));
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (FONT_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req));
    return; // Supabase / Stripe / anything else: straight to the network
  }
  // The studio app shares this origin; leave its pages to the network.
  if (url.pathname.includes('/studio/') || /\/assets\/studio\./.test(url.pathname)) return;
  event.respondWith(isStatic(url) ? cacheFirst(req) : networkFirst(req));
});

/* ---------------------------------------------------------------- push notifications
   The server sends either an encrypted JSON payload { title, body, icon?, url?, tag? } or an empty push.
   An empty push (or one we can't read) shows a generic "You have a new message". Nothing here touches the caches above. */
const FALLBACK_ICON = 'icons/icon-192.png'; // the manifest's icon
const FALLBACK_URL = '#/messages';

/** A URL from a payload, kept on this origin: a full URL on this origin, or a hash route like '#/messages'. */
function targetUrl(raw) {
  const base = self.registration.scope;
  try {
    const u = new URL(typeof raw === 'string' && raw ? raw : FALLBACK_URL, base);
    return u.origin === self.location.origin ? u.href : new URL(FALLBACK_URL, base).href;
  } catch (e) { return new URL(FALLBACK_URL, base).href; }
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  if (!d || typeof d !== 'object') d = {};
  const title = typeof d.title === 'string' && d.title ? d.title : 'You have a new message';
  const icon = typeof d.icon === 'string' && d.icon ? d.icon : FALLBACK_ICON;
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === 'string' ? d.body : (d.title ? '' : 'Tap to read it.'),
    icon,
    badge: icon,
    tag: typeof d.tag === 'string' && d.tag ? d.tag : 'spc-message', // same tag: a newer message replaces the older one
    data: { url: targetUrl(d.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const path = new URL(url).pathname;
    const inApp = (w) => !/\/(studio|admin)\//.test(new URL(w.url).pathname + '/');
    const open = wins.find((w) => new URL(w.url).pathname === path) || wins.find(inApp);
    if (open) {
      // Same page, new hash: this just changes the route, no reload.
      let w = open;
      try { w = (await open.navigate(url)) || open; } catch (e) { /* not navigable: just bring it to the front */ }
      try { await w.focus(); } catch (e) { /* ignore */ }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
