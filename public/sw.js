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
