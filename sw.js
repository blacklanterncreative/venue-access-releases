// Phone web app service worker: keeps the app working offline and serves stored files
// (IndexedDB 'assets', written by phone-shim.js) at ./_va/blob/<id>, with byte ranges for video.
const VERSION = '0.3.74-mvezyvuw';
const SHELL = ["./","index.html","platform.js","cloud.js","phone-shim.js","manifest.webmanifest","venues-compact.json","vendor/supabase.js","vendor/three/build/three.module.js","fonts/fonts.css","fonts/inter/files/inter-latin-400-normal.woff2","fonts/inter/files/inter-latin-500-normal.woff2","fonts/inter/files/inter-latin-600-normal.woff2","fonts/inter/files/inter-latin-700-normal.woff2"];   // the build fills in the files the first screen needs
const CACHE = 'va-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('va-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let dbP = null;
const open = () => (dbP ||= new Promise((res, rej) => {
  const r = indexedDB.open('venue-access', 1);
  r.onupgradeneeded = () => {   // same layout as phone-shim.js, in case the worker opens it first
    const d = r.result;
    d.createObjectStore('docs', { keyPath: ['c', 'id'] }).createIndex('c', 'c');
    d.createObjectStore('assets', { keyPath: 'id' });
    d.createObjectStore('kv');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function asset(id) {
  const d = await open();
  return new Promise((res, rej) => {
    const r = d.transaction('assets', 'readonly').objectStore('assets').get(id);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function serveBlob(req, id) {
  const row = await asset(id);
  if (!row) return new Response('not on this phone', { status: 404 });
  const blob = row.blob, size = blob.size, type = row.mime || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
  if (m && size) {
    let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(blob, { headers: { ...base, 'Content-Length': String(size) } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
  if (rel && rel.startsWith('_va/blob/')) { e.respondWith(serveBlob(e.request, decodeURIComponent(rel.slice(9)))); return; }
  // app files: the cached copy, so it opens with no signal (anything not cached yet is fetched once
  // and kept); each deploy has a new VERSION, which starts a fresh cache
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
