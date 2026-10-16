// Phone (web app) stand-in for the Mac app's core: answers the same commands platform.js and cloud.js
// send to Tauri, backed by the browser's IndexedDB. Stored files are served to the page by sw.js at
// ./_va/blob/<id>, so models, pictures and videos load the same way they do on the Mac.
(() => {
  const VERSION = '0.3.70-mvak5b15';
  const fail = m => Promise.reject(m);

  // ---------- IndexedDB ----------
  let dbP = null;
  const open = () => (dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('venue-access', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: ['c', 'id'] }).createIndex('c', 'c');
      d.createObjectStore('assets', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(store, mode, fn) {
    const t = (await open()).transaction(store, mode);
    const out = await fn(t.objectStore(store));
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return out;
  }

  // ---------- helpers ----------
  const hdr = (o, k) => decodeURIComponent(((o && o.headers) || {})[k] || '');
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
  const ID = /^[A-Za-z0-9_-]{8,64}$/;
  const blobOf = (bytes, type) => (bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
  async function share(blob, name) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) { if (e && e.name === 'AbortError') return false; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }
  const openUrl = url => { window.open(url, '_blank', 'noopener'); };

  const commands = {
    // db
    db_list: ({ collection }) => tx('docs', 'readonly', s => req(s.index('c').getAll(collection)))
      .then(rows => rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(r => ({ id: r.id, data: r.data }))),
    db_get: ({ collection, id }) => tx('docs', 'readonly', s => req(s.get([collection, id]))).then(r => (r ? r.data : null)),
    db_set: ({ collection, id, data }) => tx('docs', 'readwrite', s => req(s.put({ c: collection, id, data: JSON.parse(JSON.stringify(data)) }))).then(() => null),
    db_delete: ({ collection, id }) => tx('docs', 'readwrite', s => req(s.delete([collection, id]))).then(() => null),

    // assets
    async asset_put(bytes, opts) {
      const given = hdr(opts, 'x-id');
      if (given && !ID.test(given)) return fail('bad file id');
      const id = given || newId(), filename = hdr(opts, 'x-name') || 'file', mime = hdr(opts, 'x-type') || 'application/octet-stream';
      const blob = blobOf(bytes, mime);
      await tx('assets', 'readwrite', s => req(s.put({ id, filename, mime, blob, size: blob.size })));
      return id;
    },
    asset_info: ({ id }) => tx('assets', 'readonly', s => req(s.get(id))).then(r => (r ? { filename: r.filename, mime: r.mime } : null)),
    asset_delete: ({ id }) => tx('assets', 'readwrite', s => req(s.delete(id))).then(() => null),
    async asset_list() {
      const rows = await tx('assets', 'readonly', s => req(s.getAll()));
      return { assets: rows.map(r => r.id).sort(), usage: { usedBytes: rows.reduce((n, r) => n + (r.size || 0), 0) } };
    },
    async asset_open({ id }) {
      const r = await tx('assets', 'readonly', s => req(s.get(id)));
      if (!r) return fail('That file is not on this phone yet.');
      openUrl(window.__VA_BLOB_BASE + id);
      return null;
    },

    // downloads
    save_file: (bytes, opts) => share(blobOf(bytes, 'application/octet-stream'), hdr(opts, 'x-name') || 'download'),

    // who and what
    app_role: () => 'viewer',
    user_name: () => '',
    'plugin:app|version': () => VERSION,
    'plugin:opener|open_url': ({ url }) => { openUrl(url); return null; },
    'plugin:process|restart': () => { location.reload(); return null; },
    'plugin:updater|check': () => null,   // the web app updates itself (sw.js)

    // Settings > Admin's password record (a hash, never the password)
    admin_secret_get: () => tx('kv', 'readonly', s => req(s.get('admin-lock'))).then(v => v ?? null),
    admin_secret_set: ({ value }) => tx('kv', 'readwrite', s => req(value == null ? s.delete('admin-lock') : s.put(value, 'admin-lock'))).then(() => null),

    // reading tech packs with Claude stays on the Mac
    api_key_status: () => false,
    api_key_set: () => fail('Reading tech packs runs in the Mac app.'),
    api_key_clear: () => null,
    claude_json: () => fail('Reading tech packs runs in the Mac app.'),
    library_import: () => fail('Importing a library file runs in the Mac app.'),
    library_export: () => fail('Exporting a library file runs in the Mac app.'),
  };

  window.__VA_PHONE = true;
  window.__VA_BLOB_BASE = new URL('./_va/blob/', location.href).href;
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args, opts) {
        const f = commands[cmd];
        if (!f) throw new Error(`${cmd} isn't available in the phone app`);
        try { return await f(args, opts); }
        catch (e) { throw typeof e === 'string' ? e : String((e && e.message) || e); }
      },
      Channel: class { constructor() { this.onmessage = null; } },
    },
    event: { listen: () => Promise.resolve(() => {}) },
  };

  // the service worker (sw.js) keeps the app usable offline and serves stored files. On the very first
  // visit nothing is stored yet, so the page reloads once as soon as the worker is in charge; later, a
  // new version takes over in the background and the next launch uses it (or Reload, from the note).
  if ('serviceWorker' in navigator) {
    const first = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (first) { location.reload(); return; }
      const n = document.createElement('div');
      n.setAttribute('role', 'status');
      n.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;padding:12px 14px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font-size:14px;display:flex;gap:10px;align-items:center';
      n.innerHTML = '<span style="flex:1">A new version of Venue Access is ready.</span><button class="btn sm">Reload</button>';
      n.querySelector('button').onclick = () => location.reload();
      document.body.append(n);
    });
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('offline mode unavailable', e));
  }
})();
