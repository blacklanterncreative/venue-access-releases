// Desktop stand-in for the claude.ai artifact capabilities the prototype page was written against
// (window.claude.use: db, user, sample, assets, downloads). Each one is backed by a Rust command,
// so the page itself runs unchanged: SQLite for db, a files folder for assets, the Claude API for sample.
(() => {
  const T = window.__TAURI__;
  if (!T || !T.core) return;   // opened in a plain browser: the page falls back to read-only
  const invoke = T.core.invoke;
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const ASSET_ID = /^[A-Za-z0-9_-]{8,64}$/;
  const blobUrl = id => (window.__VA_BLOB_BASE || (navigator.userAgent.includes('Windows') ? 'http://vablob.localhost/' : 'vablob://localhost/')) + id;

  // the page passes null for "nothing here" when it rebuilds a section; skip those instead of printing "null"
  for (const P of [Element.prototype, DocumentFragment.prototype]) {
    for (const m of ['replaceChildren', 'append', 'prepend']) {
      const orig = P[m];
      P[m] = function (...kids) { return orig.apply(this, kids.filter(k => k != null && k !== false)); };
    }
  }

  // ---------- db: collections of JSON docs, live snapshots within this window ----------
  const subs = new Map();
  async function emit(col) {
    const set = subs.get(col);
    if (!set || !set.size) return;
    let rows;
    try { rows = await invoke('db_list', { collection: col }); }
    catch (e) { for (const s of set) s.err && s.err(fail('unavailable', String(e))); return; }
    const snap = { docs: rows.map(r => ({ id: r.id, exists: true, data: () => r.data })) };
    for (const s of set) { try { s.cb(snap); } catch (e) { console.error(e); } }
  }
  const db = {
    collection(col) {
      return {
        onSnapshot(cb, err) {
          let set = subs.get(col);
          if (!set) subs.set(col, set = new Set());
          const s = { cb, err };
          set.add(s);
          emit(col);
          return () => set.delete(s);
        },
        doc(id) {
          return {
            async get() {
              const r = await invoke('db_get', { collection: col, id });
              return { id, exists: r != null, data: () => r };
            },
            async set(data) { await invoke('db_set', { collection: col, id, data }); emit(col); },
            async delete() { await invoke('db_delete', { collection: col, id }); emit(col); },
          };
        },
      };
    },
  };

  // ---------- user: nobody signed in ----------
  // With accounts (a build that has the online store), signed out is view-only: browsing, no
  // adding, editing or importing. Only a build made without the online store (for local testing)
  // still takes its rights from the build role.
  let roleP = null;
  const role = () => (roleP ||= invoke('app_role'));
  const localEdit = async () => !window.__VA_CLOUD_CONFIG && (await role()) === 'admin';
  const user = {
    async id() { return 'local'; },
    async canEdit() { return localEdit(); },
    async can(perm) { return localEdit(); },
    async profiles(ids) {
      const name = await invoke('user_name').catch(() => '');
      return Object.fromEntries((ids || []).map(id => [id, { name }]));
    },
  };

  // ---------- assets: files kept in the app's library folder ----------
  const bytesOf = async b => new Uint8Array(await b.arrayBuffer());
  const assets = {
    async upload(blob, opts = {}) {
      const name = (blob && blob.name) || opts.filename || 'file';
      const type = opts.type || (blob && blob.type) || 'application/octet-stream';
      const id = await invoke('asset_put', await bytesOf(blob), { headers: { 'x-name': encodeURIComponent(name), 'x-type': type } });
      return { id, url: blobUrl(id), contentType: type };
    },
    async delete(id) { await invoke('asset_delete', { id }); },
    async list() { return invoke('asset_list'); },
  };
  // the page reads stored files as /_blob/<id>: point those at the app's file protocol
  const urls = {};
  window.__blobUrls = new Proxy(urls, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'string' && ASSET_ID.test(k) ? blobUrl(k) : undefined),
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : input && input.url;
    if (u && u.startsWith('/_blob/')) return nativeFetch(window.__blobUrls[u.slice(7)], init);
    return nativeFetch(input, init);
  };
  // links to a stored tech pack open it in Preview; web links open in the browser
  // (the composed path reaches links inside the Vendors screens' shadow root)
  document.addEventListener('click', e => {
    const a = e.composedPath().find(n => n instanceof Element && n.matches('a[href]'));
    const href = a && a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('/_blob/')) {
      e.preventDefault();
      invoke('asset_open', { id: href.slice(7) }).catch(err => console.error(err));
    } else if (/^https?:\/\//i.test(href) && a.target === '_blank') {
      e.preventDefault();
      invoke('plugin:opener|open_url', { url: href }).catch(err => console.error(err));
    }
  }, true);

  // ---------- downloads: a Save dialog ----------
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const saved = await invoke('save_file', await bytesOf(blob), { headers: { 'x-name': encodeURIComponent(filename || 'download') } });
      if (!saved) throw fail('declined');   // the page reads 'declined' as "closed the Save dialog"
    },
  };

  // ---------- sample: Claude through the user's own API key ----------
  const b64 = async blob => {
    const s = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    return String(s).split(',')[1];
  };
  const PHONE = !!window.__VA_PHONE;   // the web app for phones (phone-shim.js stands in for the Mac core)
  async function json(prompt, opts = {}) {
    if (PHONE) {
      banner('Sign in to read tech packs on your phone.', [['OK', closeBanner, 'ghost']]);
      throw fail('not_granted');
    }
    if (!(await invoke('api_key_status'))) {
      const ok = await askKey('Tech pack import reads packs with Claude. Paste your Anthropic API key to turn it on.');
      if (!ok) throw fail('not_granted');
    }
    const sig = opts.signal;
    if (sig && sig.aborted) throw fail('cancelled');
    const images = [];
    for (const b of opts.images || []) images.push({ media_type: b.type || 'image/jpeg', data: await b64(b) });
    const run = invoke('claude_json', { prompt, images });
    if (opts.onText) setTimeout(() => { try { opts.onText(''); } catch {} }, 1500);
    const aborted = new Promise((_, rej) => sig && sig.addEventListener('abort', () => rej(fail('cancelled')), { once: true }));
    try { return await Promise.race([run, aborted]); }
    catch (e) { throw e && e.code ? e : fail(String(e || 'error')); }
  }
  const sample = Object.assign((...a) => json(...a), {
    json,
    async limits() { return { images: { mediaTypes: ['image/jpeg', 'image/png'], maxCount: 20, maxInputBytes: 5 * 1024 * 1024 } }; },
  });

  // ---------- API key dialog (also opened from Settings > Claude API Key…) ----------
  function askKey(why) {
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.style.cssText = 'max-width:460px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--fg);padding:18px 20px;font:inherit';
      d.innerHTML = `<form method="dialog" style="display:grid;gap:10px">
        <h3 style="margin:0;font-family:var(--display);text-transform:uppercase;letter-spacing:.04em">Claude API key</h3>
        <p style="margin:0">${why}</p>
        <p style="margin:0;color:var(--muted);font-size:13px">This is separate from your Claude subscription: create a key at <a href="https://console.anthropic.com/settings/keys" data-ext style="color:var(--accent)">console.anthropic.com</a> (API Keys, then Create Key), copy it, and paste it here with ⌘V. Usage is billed to that account, usually a few cents per pack. The key is stored in your Mac's Keychain and only used to read tech packs.</p>
        <input name="k" type="password" autocomplete="off" placeholder="sk-ant-…" style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)">
        <p class="err" style="margin:0;color:var(--fail)" hidden></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button value="remove" type="button" data-rm class="btn sm danger" style="margin-right:auto">Remove key</button>
          <button value="cancel" class="btn sm ghost">Cancel</button><button value="save" type="submit" class="btn sm">Save</button>
        </div></form>`;
      document.body.append(d);
      const input = d.querySelector('input'), err = d.querySelector('.err');
      d.querySelector('[data-ext]').onclick = e => { e.preventDefault(); invoke('plugin:opener|open_url', { url: e.currentTarget.href }).catch(() => {}); };
      input.oninput = () => { err.hidden = true; };
      invoke('api_key_status').then(has => { d.querySelector('[data-rm]').hidden = !has; });
      d.querySelector('[data-rm]').onclick = async () => { await invoke('api_key_clear'); d.close('removed'); };
      d.querySelector('form').onsubmit = async e => {
        if (e.submitter && e.submitter.value !== 'save') return;
        e.preventDefault();
        const k = input.value.trim();
        if (!k) { err.textContent = 'Paste your key into the box first (⌘V).'; err.hidden = false; return; }
        if (!/^sk-ant-\S{20,}$/.test(k)) { err.textContent = 'Anthropic API keys start with sk-ant- and are about 100 characters long. Copy the whole key and paste it again.'; err.hidden = false; return; }
        try { await invoke('api_key_set', { key: k }); d.close('saved'); }
        catch (x) { err.textContent = String(x); err.hidden = false; }
      };
      d.addEventListener('close', () => { d.remove(); resolve(d.returnValue === 'saved'); });
      d.showModal();
      input.focus();
    });
  }
  if (T.event) T.event.listen('va-api-key', () => askKey('Tech pack import reads packs with Claude using this key.'));

  // the claude.ai file store capped stored models at 18 MB, so heavy rigs were simplified;
  // on the desktop they are kept at full detail
  window.__modelMaxBytes = 400e6;

  // ---------- updates: the app checks the public releases page at launch and from the app menu ----------
  function banner(html, actions = []) {
    let b = document.getElementById('vaUpdate');
    if (!b) {
      b = document.createElement('div');
      b.id = 'vaUpdate';
      b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:380px;display:grid;gap:10px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--fg);box-shadow:0 8px 28px rgba(0,0,0,.25);font-size:14px';
      document.body.append(b);
    }
    b.innerHTML = `<div>${html}</div><div style="display:flex;gap:8px;justify-content:flex-end"></div>`;
    for (const [label, fn, cls] of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn sm ' + (cls || '');
      btn.textContent = label;
      btn.onclick = fn;
      b.lastElementChild.append(btn);
    }
    return b;
  }
  const closeBanner = () => { const b = document.getElementById('vaUpdate'); if (b) b.remove(); };
  const esc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let checking = false;
  async function checkUpdates(manual) {
    if (checking) return;
    checking = true;
    try {
      if (manual) banner('Checking for updates…');
      const up = await invoke('plugin:updater|check', {});
      if (!up) { if (manual) banner("You're on the latest version.", [['OK', closeBanner, 'ghost']]); return; }
      const notes = up.body ? `<p style="margin:6px 0 0;color:var(--muted);font-size:13px;white-space:pre-line">${esc(up.body).slice(0, 600)}</p>` : '';
      banner(`<b>Venue Access ${esc(up.version)} is available.</b> You have ${esc(up.currentVersion)}. Your venues, tours and settings stay as they are.${notes}`, [
        ['Later', closeBanner, 'ghost'],
        ['Install and restart', () => install(up)],
      ]);
    } catch (e) {
      if (manual) banner(`Couldn't check for updates right now. ${esc(e && e.message || e)}`, [['OK', closeBanner, 'ghost']]);
      else console.info('update check:', e);
    } finally { checking = false; }
  }
  async function install(up) {
    let total = 0, got = 0;
    const b = banner('Downloading the update…');
    const ch = new T.core.Channel();
    ch.onmessage = ev => {
      if (ev.event === 'Started') total = ev.data.contentLength || 0;
      if (ev.event === 'Progress') { got += ev.data.chunkLength; if (total) b.firstElementChild.textContent = `Downloading the update… ${Math.round(got / total * 100)}%`; }
      if (ev.event === 'Finished') b.firstElementChild.textContent = 'Installing…';
    };
    try {
      await invoke('plugin:updater|download_and_install', { rid: up.rid, onEvent: ch });
      await invoke('plugin:process|restart');
    } catch (e) {
      banner(`The update didn't install. ${esc(e && e.message || e)}`, [['OK', closeBanner, 'ghost']]);
    }
  }
  if (T.event) T.event.listen('va-check-updates', () => checkUpdates(true));
  if (!PHONE) setTimeout(() => checkUpdates(false), 4000);

  // ---------- feedback: a pre-filled email with the version and Mac details ----------
  if (T.event) T.event.listen('va-feedback', () => feedback());

  // ---------- library files: File > Import Library… / Export Library… run in the app core ----------
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (T.event) T.event.listen('va-library', ({ payload: p }) => {
    const imp = p.kind === 'import';
    if (p.state === 'busy') { banner(imp ? 'Importing the library… This can take a minute with big 3D models.' : 'Exporting your library…'); return; }
    if (p.state === 'error') { banner(`${imp ? "The library didn't import" : "The library didn't export"}. ${esc(p.message)}`, [['OK', closeBanner, 'ghost']]); return; }
    if (imp) {
      banner(`<b>Library imported.</b> ${plural(p.docs, 'item')} and ${plural(p.assets, 'file')} added. Reloading…`);
      setTimeout(() => location.reload(), 1500);
    } else {
      banner(`<b>Library exported.</b> ${plural(p.docs, 'item')} and ${plural(p.assets, 'file')} saved. Send the file to a colleague; they open it with File > Import Library…`, [['OK', closeBanner, 'ghost']]);
    }
  });

  // Import Library replaces library data, so it needs Settings > Admin unlocked (signed out is browse-only)
  const importLibrary = () => {
    if (window.vaAdmin && window.vaAdmin.open()) return invoke('library_import');
    banner('Unlock Settings > Admin to import a library.', [['OK', closeBanner, 'ghost']]);
    if (window.vaOpenSettings) window.vaOpenSettings('admin');
  };
  if (T.event) T.event.listen('va-lib-import', () => importLibrary());

  // ---------- Settings page hooks (the page shows a button for each one that exists) ----------
  const feedback = async () => {
    const ver = await invoke('plugin:app|version').catch(() => '?');
    const who = PHONE ? 'phone' : (await role()) === 'admin' ? 'admin' : 'viewer';
    const body = `What I was doing:\n\nWhat happened:\n\nWhat I expected:\n\n\n---\nVenue Access ${ver} (${who})\n${navigator.userAgent}`;
    const url = `mailto:julien@blacklanterncreative.com?subject=${encodeURIComponent('Venue Access feedback (' + ver + ')')}&body=${encodeURIComponent(body)}`;
    invoke('plugin:opener|open_url', { url }).catch(e => console.error(e));
  };
  window.vaDesktop = {
    version: '',
    ...(PHONE ? {} : { importLibrary, checkForUpdates: () => checkUpdates(true) }),
    sendFeedback: feedback,
    // Settings > Admin keeps its password record in the Keychain
    adminSecret: {
      get: () => invoke('admin_secret_get'),
      set: v => invoke('admin_secret_set', { value: v == null ? null : String(v) }),
    },
  };
  invoke('plugin:app|version').then(v => { window.vaDesktop.version = v; }).catch(() => {});
  role().then(r => { if (r === 'admin' && !PHONE) window.vaDesktop.exportLibrary = () => invoke('library_export'); });
  if (T.event) T.event.listen('va-settings', () => window.vaOpenSettings && window.vaOpenSettings());

  // signed-in sync with the online store (cloud.js), when this build has one configured
  const cloud = window.__vaCloudSetup && window.__vaCloudSetup({
    invoke, fail, banner, closeBanner, esc, emit, localDb: db, localUser: user, localSample: sample,
  });
  if (!cloud && T.event) {
    const off = () => banner('Accounts and shared tours are coming in a later update.', [['OK', closeBanner, 'ghost']]);
    T.event.listen('va-account', off);
    T.event.listen('va-testers', off);
  }
  const caps = { db, user, assets, downloads, sample, ...(cloud || {}) };
  window.claude = {
    use(name) { return name in caps ? Promise.resolve(caps[name]) : Promise.reject(fail('not_declared')); },
  };
})();
