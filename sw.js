/* Service Worker: App-Shell offline verfügbar halten, OSM-Kacheln opportunistisch cachen. */
// __BUILD__ wird beim Deploy durch den Commit-SHA ersetzt (deploy/deploy.php).
const VERSION    = '__BUILD__';
const SHELL      = `boatspeed-shell-${VERSION}`;
const TILES      = 'boatspeed-tiles';
const TILE_LIMIT = 800; // grob ~40 MB; reicht für das befahrene Revier

const SHELL_FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/track.js',
  'manifest.webmanifest',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('boatspeed-shell-') && k !== SHELL)
                          .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = (url) => /(^|\.)(tile\.openstreetmap\.org|tile\.osm\.org)$/.test(url.hostname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) { event.respondWith(tileStrategy(req)); return; }
  if (url.origin !== self.location.origin) return;

  // Navigationen: Netz zuerst, sonst die gecachte Shell.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match('index.html')) || Response.error(); }
    })());
    return;
  }

  // Statische Dateien: Cache zuerst, im Hintergrund auffrischen.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      if (res && res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});

/* Kacheln: erst Cache (auch offline nutzbar), sonst Netz und ablegen.
   Es wird nur gespeichert, was ohnehin angezeigt wird – kein Bulk-Download,
   wie es die OSM-Tile-Usage-Policy verlangt. */
async function tileStrategy(req) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Kachel offline nicht verfügbar' });
  }
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > TILE_LIMIT) {
      // FIFO: die ältesten Einträge zuerst entfernen.
      await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
    }
  } finally {
    trimming = false;
  }
}
