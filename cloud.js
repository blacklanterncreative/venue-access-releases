// Online accounts and sync for Venue Access (Supabase).
//
// This Mac's SQLite library stays the working copy: the page reads and writes it exactly as before,
// and this file keeps it in step with the online store in the background.
// - Pull: documents changed online since the last pull (the `seq` cursor) are copied in. A document
//   with unsent local changes gets those changes re-applied on top of the new version, field by field.
// - Push: a changed document is sent with the version it was based on. If someone saved in between,
//   the server returns their version, our field changes are re-applied to it and it is sent again.
//   A delete wins over edits it didn't see.
// - Bookkeeping lives in collections that start with _ (never exported in a library file):
//   _sync/state {userId, seq}, _base/<col>:<id> {v, data, del} (the last version seen online),
//   _fit/<assetId> {cell} (a model here is the online fit copy). Files online: see the files section.
// Signed out (or "Browse only"), the app is view-only when the build has the online store.
window.__vaCloudSetup = function (ctx) {
  const HERE = window.__VA_PHONE ? 'this phone' : 'this Mac';   // where unsent changes and files wait
  const cfg = window.__VA_CLOUD_CONFIG;
  if (!cfg || !cfg.url || !cfg.key || !window.supabase) return null;
  const { invoke, fail, banner, closeBanner, esc, emit } = ctx;

  const LIBRARY = ['venue_edits', 'venue_models'];
  const TOUR = ['tours', 'tour_packs', 'tour_models'];
  // a stage build is its owner's, and also seen by the tour it was sent to (the server keeps the rules)
  const BUILDS = ['stage_builds'];
  // the Vendors section: admins only, files included (under admin/ online)
  const ADMIN = ['vendors', 'vendor_lists', 'estimates', 'quotes'];
  const SYNCED = [...TOUR.slice(0, 1), ...LIBRARY, ...TOUR.slice(1), ...BUILDS, ...ADMIN]; // tours first: other tour docs need their tour online
  const ASSET_ID = /^[A-Za-z0-9_-]{8,64}$/;
  const MAX_FILE = 50 * 1024 * 1024;
  const STORAGE_LIMIT = 1024 ** 3;   // the free plan's file storage
  const tourOf = (col, id) => (col === 'tours' ? id : TOUR.includes(col) ? id.split('~')[0] : null);
  const keyOf = (col, id) => col + ':' + id;
  const splitKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

  const sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'va-auth' },
  });

  // ---------- local store ----------
  const L = {
    list: col => invoke('db_list', { collection: col }),
    get: (col, id) => invoke('db_get', { collection: col, id }),
    set: (col, id, data) => invoke('db_set', { collection: col, id, data }),
    del: (col, id) => invoke('db_delete', { collection: col, id }),
  };
  // one writer at a time on the local copy, so a page save never lands between sync's read and write
  let chain = Promise.resolve();
  const locked = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ---------- field-level diff and merge ----------
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const stable = x => Array.isArray(x) ? '[' + x.map(stable).join(',') + ']'
    : isObj(x) ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}'
    : JSON.stringify(x === undefined ? null : x);
  const same = (a, b) => stable(a) === stable(b);
  // arrays of objects that each carry a unique string id (dates, versions, sources) merge per element
  const keyed = a => Array.isArray(a) && a.length > 0 && a.every(e => isObj(e) && typeof e.id === 'string') && new Set(a.map(e => e.id)).size === a.length;
  const keyedOrEmpty = a => Array.isArray(a) && (a.length === 0 || keyed(a));
  function diff(a, b, path = [], out = []) {
    if (same(a, b)) return out;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(b)) if (!(k in a)) out.push({ p: [...path, k], v: b[k] }); else diff(a[k], b[k], [...path, k], out);
      for (const k of Object.keys(a)) if (!(k in b)) out.push({ p: [...path, k], o: a[k] });
      return out;
    }
    if (keyedOrEmpty(a) && keyedOrEmpty(b)) {
      const A = new Map(a.map(e => [e.id, e])), B = new Map(b.map(e => [e.id, e]));
      for (const e of b) if (A.has(e.id)) diff(A.get(e.id), e, [...path, { id: e.id }], out); else out.push({ p: [...path, { id: e.id }], v: e });
      for (const e of a) if (!B.has(e.id)) out.push({ p: [...path, { id: e.id }], o: e });
      const kept = a.filter(e => B.has(e.id)).map(e => e.id), now = b.filter(e => A.has(e.id)).map(e => e.id);
      if (kept.join('\n') !== now.join('\n')) out.push({ p: path, order: b.map(e => e.id) });
      return out;
    }
    out.push(a === undefined ? { p: path, v: b } : { p: path, o: a, v: b });
    return out;
  }
  const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const child = (node, seg) => typeof seg === 'object'
    ? (Array.isArray(node) ? node.find(e => isObj(e) && e.id === seg.id) : undefined)
    : (isObj(node) ? node[seg] : undefined);
  // re-applies field changes onto another version of the document; a change inside an element
  // that was removed elsewhere is dropped along with it
  function apply(doc, ops) {
    const W = { r: clone(doc) };
    for (const op of ops) {
      const P = ['r', ...op.p], set = 'v' in op;
      let node = W, ok = true;
      const upto = op.order ? P.length : P.length - 1;
      for (let i = 0; i < upto; i++) {
        let next = child(node, P[i]);
        const want = (i + 1 < P.length ? typeof P[i + 1] === 'object' : op.order) ? 'arr' : 'obj';
        const fits = want === 'arr' ? Array.isArray(next) : isObj(next);
        if (!fits) {
          if (!set || op.order || typeof P[i] === 'object' || !isObj(node)) { ok = false; break; }
          next = node[P[i]] = want === 'arr' ? [] : {};
        }
        node = next;
      }
      if (!ok) continue;
      if (op.order) {
        if (!Array.isArray(node)) continue;
        const pos = new Map(op.order.map((id, i) => [id, i]));
        const listed = node.filter(e => isObj(e) && pos.has(e.id)).sort((x, y) => pos.get(x.id) - pos.get(y.id));
        let i = 0;
        node.splice(0, node.length, ...node.map(e => (isObj(e) && pos.has(e.id) ? listed[i++] : e)));
        continue;
      }
      const last = P[P.length - 1];
      if (typeof last === 'object') {
        const i = node.findIndex(e => isObj(e) && e.id === last.id);
        if (set) { if (i >= 0) node[i] = clone(op.v); else node.push(clone(op.v)); }
        else if (i >= 0) node.splice(i, 1);
      } else if (set) node[last] = clone(op.v);
      else delete node[last];
    }
    return W.r;
  }

  // ---------- account state ----------
  let session = null, me = null, roles = new Map(), offline = false;
  const listeners = new Set();
  const changed = what => { for (const cb of listeners) { try { cb(what); } catch (e) { console.error(e); } } };
  const signedIn = () => !!(session && me);

  async function loadMe() {
    const { data, error } = await sb.rpc('my_account');
    if (error) throw error;
    me = data;
    try { localStorage.setItem('va-me', JSON.stringify(me)); } catch {}
    return me;
  }
  // the account as last seen online, so a signed-in admin keeps their rights with no internet
  function cachedMe() {
    try { const m = JSON.parse(localStorage.getItem('va-me') || 'null'); return m && session && session.user && m.id === session.user.id ? m : null; }
    catch { return null; }
  }
  async function loadRoles() {
    if (!me) return;
    const { data, error } = await sb.from('tour_members').select('tour_id, role').eq('user_id', me.id);
    if (error) throw error;
    const next = new Map(data.map(r => [r.tour_id, r.role]));
    const before = stable([...roles].sort());
    roles = next;
    if (stable([...roles].sort()) !== before) changed({ roles: true });
  }

  // ---------- push ----------
  const touched = new Set();
  let pushTimer = null, pushing = null, notices = new Set();
  const schedulePush = (ms = 800) => { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(), ms); };
  function notice(kind, text) {
    if (notices.has(kind)) return;
    notices.add(kind);
    banner(text, [['OK', closeBanner, 'ghost']]);
  }
  function mayWrite(col, id) {
    if (LIBRARY.includes(col) || ADMIN.includes(col)) return !!me.is_admin;
    const t = tourOf(col, id), r = roles.get(t);
    return r ? r !== 'viewer' : true;  // no role yet: a tour this person is starting
  }
  async function push() {
    if (!signedIn() || offline) return;
    if (pushing) { schedulePush(1500); return; }
    pushing = (async () => {
      const keys = [...touched].sort((a, b) => SYNCED.indexOf(splitKey(a)[0]) - SYNCED.indexOf(splitKey(b)[0]));
      for (const k of keys) {
        touched.delete(k);
        try { await pushOne(...splitKey(k)); }
        catch (e) {
          touched.add(k);
          if (isNetwork(e)) { setStatus('offline'); schedulePush(15000); return; }
          console.warn('sync push', k, e);
        }
      }
      setStatus('ok');
    })();
    try { await pushing; } finally { pushing = null; }
  }
  const isNetwork = e => e && (e.name === 'TypeError' || /fetch|network|Failed to/i.test(String(e.message || e)));
  async function revert(col, id, base) {
    await locked(async () => {
      if (base && !base.del) await L.set(col, id, base.data); else await L.del(col, id);
    });
    emit(col);
  }
  // a build's owner field is the server's (the page doesn't write it): keep the one it gave
  const withOwner = (col, doc, base) => BUILDS.includes(col) && isObj(doc)
    ? { ...doc, owner: (base && !base.del && isObj(base.data) && base.data.owner) || doc.owner || me.id } : doc;
  async function pushOne(col, id) {
    const bk = keyOf(col, id);
    const base = await L.get('_base', bk);
    const stored = await L.get(col, id), local = withOwner(col, stored, base);
    if (local == null) {
      if (!base || base.del) return;
      if (!mayWrite(col, id)) return revert(col, id, base);
      const { data: r, error } = await sb.rpc('delete_doc', { p_collection: col, p_id: id, p_base: base.v });
      if (error) { if (error.code === '42501') { notice('perm', "Some changes weren't saved online because you can only view them."); return revert(col, id, base); } throw error; }
      await L.set('_base', bk, { v: r.version, del: true });
      return;
    }
    if (base && !base.del && same(local, base.data)) {
      if (!same(local, stored)) { await locked(async () => { const cur = await L.get(col, id); if (same(cur, stored)) await L.set(col, id, local); }); emit(col); }
      return;
    }
    if (!mayWrite(col, id)) return revert(col, id, base);

    const live = base && !base.del;
    // files this version adds go online first, so nobody gets a document whose file isn't there
    const [ids, models] = filesOf(col, local), had = live ? refs(base.data) : new Set();
    const added = [...ids].filter(x => !had.has(x));
    if (added.length) await sendFiles(added, models, ADMIN.includes(col));
    const ops = live ? diff(base.data, local) : [];
    let data = local, ver = base ? base.v : 0, saved = null;
    for (let i = 0; i < 5 && !saved; i++) {
      const { data: r, error } = await sb.rpc('save_doc', { p_collection: col, p_id: id, p_data: data, p_base: ver, p_ops: ops });
      if (error) {
        if (error.code === '42501') { notice('perm', "Some changes weren't saved online because you can only view them."); return revert(col, id, base); }
        throw error;
      }
      if (r.ok) { saved = r.version; break; }
      if (r.deleted && live) {   // deleted online while edited here: the delete wins
        await locked(() => L.del(col, id));
        await L.set('_base', bk, { v: r.version, del: true });
        emit(col);
        return;
      }
      ver = r.version;
      data = r.deleted ? local : live ? apply(r.data, ops) : apply(r.data, diff({}, local));
    }
    if (saved == null) { touched.add(bk); return; }
    if (col === 'tours' && !roles.has(id)) roles.set(id, 'owner');
    // the page may have saved again while this was on its way: keep those newer edits on top
    let again = false;
    await locked(async () => {
      const cur = await L.get(col, id);
      if (cur == null) { again = true; await L.set('_base', bk, { v: saved, data }); return; }
      const next = same(cur, stored) ? data : apply(data, diff(stored, cur));
      if (!same(next, cur)) await L.set(col, id, next);
      await L.set('_base', bk, { v: saved, data });
      again = !same(next, data);
    });
    if (!same(data, stored)) emit(col);
    if (again) { touched.add(bk); schedulePush(); }
  }

  // ---------- pull ----------
  let pullTimer = null, pulling = null;
  const schedulePull = (ms = 500) => { clearTimeout(pullTimer); pullTimer = setTimeout(() => pull(), ms); };
  async function pull() {
    if (!signedIn() || offline) return;
    if (pulling) return pulling;
    pulling = (async () => {
      setStatus('syncing');
      const state = (await L.get('_sync', 'state')) || {};
      let seq = state.seq || 0;
      const cols = new Set(), files = new Set();
      for (;;) {
        const { data: rows, error } = await sb.from('docs').select('collection, id, data, version, deleted, seq')
          .gt('seq', seq).order('seq').limit(500);
        if (error) throw error;
        for (const row of rows) {
          await take(row, files);
          cols.add(row.collection);
          seq = Math.max(seq, Number(row.seq));
        }
        await L.set('_sync', 'state', { userId: me.id, seq });
        if (rows.length < 500) break;
      }
      for (const c of cols) emit(c);
      if (cols.size) changed({ docs: [...cols] });
      fetchFiles(files);
    })();
    try { await pulling; setStatus('ok'); lastSync = new Date(); }
    catch (e) { setStatus(isNetwork(e) ? 'offline' : 'error'); console.warn('sync pull', e); }
    finally { pulling = null; }
    if (touched.size) schedulePush(200);
  }
  async function take(row, files) {
    const { collection: col, id } = row, bk = keyOf(col, id);
    if (!SYNCED.includes(col)) return;
    await locked(async () => {
      const stored = await L.get(col, id);
      const base = await L.get('_base', bk);
      const local = withOwner(col, stored, base);
      if (row.deleted) {
        if (local != null) await L.del(col, id);
        await L.set('_base', bk, { v: row.version, del: true });
        touched.delete(bk);
        return;
      }
      const dirty = local != null && !(base && !base.del && same(local, base.data));
      let next = row.data;
      if (dirty && mayWrite(col, id)) {
        const from = base && !base.del ? base.data : {};
        next = apply(row.data, diff(from, local));
        if (!same(next, row.data)) { touched.add(bk); }
      }
      if (stored == null || !same(stored, next)) await L.set(col, id, next);
      await L.set('_base', bk, { v: row.version, data: row.data });
      refs(row.data, files);
    });
  }

  // a full check of what this account can see: drops tours it was removed from, and queues
  // anything here that never went online (the first sign-in moves the library up this way)
  async function reconcile() {
    if (!signedIn() || offline) return;
    const visible = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('docs').select('collection, id').eq('deleted', false).range(from, from + 999);
      if (error) throw error;
      for (const r of data) visible.add(keyOf(r.collection, r.id));
      if (data.length < 1000) break;
    }
    const bases = new Map((await L.list('_base')).map(d => [d.id, d.data]));
    for (const col of SYNCED) {
      const local = new Map((await L.list(col)).map(d => [d.id, d.data]));
      let gone = false;
      for (const [id, data] of local) {
        const bk = keyOf(col, id), base = bases.get(bk);
        if (base && !base.del && !visible.has(bk)) {
          // no longer shared with this account (or removed online while this Mac was away)
          if (TOUR.includes(col) || BUILDS.includes(col) || !mayWrite(col, id) || same(data, base.data)) {
            await locked(async () => { await L.del(col, id); await L.del('_base', bk); });
            gone = true;
            continue;
          }
        }
        if (!base || base.del || !same(data, base.data)) touched.add(bk);
      }
      for (const [bk, base] of bases) {
        const [c, id] = splitKey(bk);
        if (c === col && !base.del && !local.has(id)) touched.add(bk);
      }
      if (gone) emit(col);
    }
    if (touched.size) schedulePush(200);
    checkFiles().catch(e => console.warn('file check', e));
  }

  // ---------- files (3D models, tech pack PDFs) ----------
  // Online, a file is `h/<sha-256>.va`: gzip of one JSON header line ({fit}) and the file, and
  // asset_files maps the app's asset id to it (with the filename), so a file used in several
  // places is stored once. A 3D model goes up as a lighter fit copy (see fitModel); the full
  // detail stays on the Mac it was imported on. Files from 0.3.0 are `<asset id>.va` with a
  // {filename, mime} header; they are still read, and moved over by the Mac that has them.
  function refs(x, out = new Set()) {
    if (Array.isArray(x)) { for (const e of x) refs(e, out); return out; }
    if (!isObj(x)) return out;
    if (typeof x.assetId === 'string' && ASSET_ID.test(x.assetId)) out.add(x.assetId);
    if (typeof x.id === 'string' && 'filename' in x && ASSET_ID.test(x.id)) out.add(x.id);
    if (isObj(x.bg) && typeof x.bg.img === 'string' && ASSET_ID.test(x.bg.img)) out.add(x.bg.img);   // a tour's background picture
    if (isObj(x.brand)) for (const id of [x.brand.logo, ...(Array.isArray(x.brand.imgs) ? x.brand.imgs : [])]) if (typeof id === 'string' && ASSET_ID.test(id)) out.add(id);   // a tour's logo and pictures for PDFs
    if (isObj(x.brand)) for (const id of [x.brand.logo, ...(Array.isArray(x.brand.imgs) ? x.brand.imgs : [])]) if (typeof id === 'string' && ASSET_ID.test(id)) out.add(id);   // a tour's logo and pictures for PDFs
    if (isObj(x.px) && typeof x.px.map === 'string' && ASSET_ID.test(x.px.map)) out.add(x.px.map);   // a tour model's input pixel map picture
    if (isObj(x.media) && typeof x.media.id === 'string' && ASSET_ID.test(x.media.id)) out.add(x.media.id);   // a video wall's picture or video
    if (typeof x.asset === 'string' && 'fname' in x && ASSET_ID.test(x.asset)) out.add(x.asset);   // a vendor list's file
    for (const v of Object.values(x)) if (v && typeof v === 'object') refs(v, out);
    return out;
  }
  const MODELS = ['tour_models', 'venue_models'];
  const isModel = (col, doc, id) => MODELS.includes(col) && isObj(doc) && doc.assetId === id;
  const blobUrl = id => (window.__VA_BLOB_BASE || (navigator.userAgent.includes('Windows') ? 'http://vablob.localhost/' : 'vablob://localhost/')) + id;
  const gzip = blob => new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const gunzip = blob => new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  // A model's fit copy: Stage Fit only needs the outer shape, so vertices are snapped to a grid
  // (the same simplification the page uses when a model is too big to store) until the copy is
  // under FIT_BYTES. Sizes move by at most half a grid step. Models are glTF JSON as the page
  // stores them; anything else goes up unchanged.
  const FIT_BYTES = 4e6;
  const FIT_CELLS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32];
  async function fitModel(u8) {
    const keep = { bytes: u8, cell: null };
    if (u8.byteLength <= FIT_BYTES) return keep;
    let j;
    try { j = JSON.parse(new TextDecoder().decode(u8)); } catch { return keep; }
    if (!isObj(j) || !j.asset || !Array.isArray(j.buffers) || j.buffers.length !== 1 || !/^data:[^,]*;base64,/.test(j.buffers[0].uri || '')) return keep;
    const b64 = j.buffers[0].uri, bin = atob(b64.slice(b64.indexOf(',') + 1));
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const dv = new DataView(raw.buffer);
    const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    function read(ai) {
      const a = j.accessors && j.accessors[ai];
      if (!a || a.bufferView == null || a.sparse) return null;
      const bv = j.bufferViews[a.bufferView], n = N[a.type], sz = SIZE[a.componentType];
      if (!bv || !n || !sz || (bv.buffer || 0) !== 0) return null;
      const step = bv.byteStride || n * sz, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
      if (base + step * (a.count - 1) + n * sz > raw.length) return null;
      const out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
      const get = { 5126: o => dv.getFloat32(o, true), 5125: o => dv.getUint32(o, true), 5123: o => dv.getUint16(o, true), 5121: o => dv.getUint8(o) }[a.componentType];
      if (!get) return null;
      for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = get(base + i * step + c * sz);
      return out;
    }
    // every triangle primitive as positions + triangle indices
    const prims = (j.meshes || []).map(m => (m.primitives || []).map(p => {
      if ((p.mode ?? 4) !== 4 || !p.attributes || p.attributes.POSITION == null) return null;
      const pos = read(p.attributes.POSITION);
      if (!pos || j.accessors[p.attributes.POSITION].type !== 'VEC3') return null;
      let idx = p.indices != null ? read(p.indices) : null;
      if (p.indices != null && !idx) return null;
      if (!idx) { idx = new Uint32Array(pos.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i; }
      return { pos, idx, material: p.material };
    }));
    let out = null;
    for (const cell of FIT_CELLS) {
      await new Promise(r => setTimeout(r, 0));   // let the page draw between attempts
      const chunks = [], views = [], accs = [];
      let len = 0;
      const put = (arr, target, acc) => {
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        views.push({ buffer: 0, byteOffset: len, byteLength: bytes.length, target });
        chunks.push(bytes); len += bytes.length;
        accs.push({ ...acc, bufferView: views.length - 1 });
        return accs.length - 1;
      };
      const meshMap = [], meshes = [];
      (j.meshes || []).forEach((m, mi) => {
        const ps = [];
        for (const pr of prims[mi]) {
          if (!pr) continue;
          const { pos, idx } = pr, map = new Map(), np = [], remap = new Uint32Array(pos.length / 3);
          for (let i = 0; i < remap.length; i++) {
            const x = Math.round(pos[i * 3] / cell), y = Math.round(pos[i * 3 + 1] / cell), z = Math.round(pos[i * 3 + 2] / cell);
            const k = x + ',' + y + ',' + z;
            let v = map.get(k);
            if (v === undefined) { v = np.length / 3; map.set(k, v); np.push(x * cell, y * cell, z * cell); }
            remap[i] = v;
          }
          const ni = [];
          for (let t = 0; t + 2 < idx.length; t += 3) {
            const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
            if (a !== b && b !== c && a !== c) ni.push(a, b, c);
          }
          if (!ni.length) continue;
          const P = new Float32Array(np), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < P.length; i++) { const c = i % 3; if (P[i] < min[c]) min[c] = P[i]; if (P[i] > max[c]) max[c] = P[i]; }
          const pa = put(P, 34962, { componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
          const ia = put(new Uint32Array(ni), 34963, { componentType: 5125, count: ni.length, type: 'SCALAR' });
          ps.push({ attributes: { POSITION: pa }, indices: ia, ...(pr.material != null ? { material: pr.material } : {}) });
        }
        if (ps.length) { meshMap[mi] = meshes.length; meshes.push({ ...(m.name ? { name: m.name } : {}), ...(m.extras ? { extras: m.extras } : {}), primitives: ps }); }
      });
      const all = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      let s = '';
      for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
      const nodes = (j.nodes || []).map(n => {
        const c = { ...n };
        delete c.skin; delete c.weights;
        if (n.mesh != null) { if (meshMap[n.mesh] != null) c.mesh = meshMap[n.mesh]; else delete c.mesh; }
        return c;
      });
      // plain colours only: the copy has no textures
      const materials = (j.materials || []).map(mt => {
        const pbr = mt.pbrMetallicRoughness || {}, q = {};
        for (const k of ['baseColorFactor', 'metallicFactor', 'roughnessFactor']) if (k in pbr) q[k] = pbr[k];
        return { ...(mt.name ? { name: mt.name } : {}), pbrMetallicRoughness: q, ...(mt.doubleSided ? { doubleSided: true } : {}) };
      });
      const g = { asset: j.asset, scene: j.scene, scenes: j.scenes, nodes, meshes, accessors: accs, bufferViews: views,
        buffers: [{ byteLength: len, uri: 'data:application/octet-stream;base64,' + btoa(s) }] };
      if (materials.length) g.materials = materials;
      out = { bytes: new TextEncoder().encode(JSON.stringify(g)), cell };
      if (out.bytes.byteLength <= FIT_BYTES) break;
    }
    return out && out.bytes.byteLength < u8.byteLength ? out : keep;
  }

  // ids -> those not online yet (also marks the rest in use, so tidying leaves them be)
  async function claim(ids) {
    if (!ids.length) return [];
    const { data, error } = await sb.rpc('claim_files', { p_ids: ids });
    if (error) throw error;
    return data || [];
  }
  // sends this Mac's copy of each file that isn't online; `models` are the ids that are 3D models,
  // `priv` files (the Vendors section's) go under admin/, which only admins can read
  const objectOf = (hash, priv) => (priv ? 'admin/h/' : 'h/') + hash + '.va';
  async function sendFiles(ids, models, priv = false) {
    for (const id of await claim([...ids])) {
      const info = await invoke('asset_info', { id });
      if (!info) continue;   // not on this Mac: whoever has it sends it
      let bytes = new Uint8Array(await (await fetch(blobUrl(id))).arrayBuffer()), fit = null;
      if (models.has(id)) ({ bytes, cell: fit } = await fitModel(bytes));
      const body = new Blob([JSON.stringify({ fit }) + '\n', bytes]);
      const hash = hex(await crypto.subtle.digest('SHA-256', await body.arrayBuffer()));
      const packed = await gzip(body);
      if (packed.size > MAX_FILE) {
        notice('big', `<b>${esc(info.filename)}</b> is too big to share online (over 50 MB even compressed). It stays on ${HERE}; others won't see it until it's smaller.`);
        continue;
      }
      for (let tries = 0; tries < 2; tries++) {
        const { error } = await sb.storage.from('assets').upload(objectOf(hash, priv), packed, { contentType: 'application/gzip', upsert: false });
        if (error && !/exists|duplicate/i.test(error.message || '') && String(error.statusCode) !== '409') {
          if (/quota|limit|exceed|too large|413/i.test(String(error.message) + error.statusCode)) {
            notice('full', `The online file storage is full, so some files stay on ${HERE} for now. Remove models or packs you don't need, or ask Julien.`);
            return;
          }
          throw error;
        }
        const { data: okay, error: e2 } = await sb.rpc('register_file', { p_id: id, p_hash: hash, p_bytes: packed.size, p_filename: info.filename, p_mime: info.mime, p_fit: fit, ...(priv ? { p_private: true } : {}) });
        if (e2) throw e2;
        if (okay) break;
      }
    }
  }
  // the files a document uses that this Mac would send: [ids, model ids]
  function filesOf(col, doc) {
    const ids = refs(doc), models = new Set();
    for (const id of ids) if (isModel(col, doc, id)) models.add(id);
    return [ids, models];
  }

  let fetching = Promise.resolve();
  function fetchFiles(ids) {
    if (!ids.size) return;
    fetching = fetching.then(async () => {
      let got = 0;
      const want = [];
      for (const id of ids) if (!(await invoke('asset_info', { id }).catch(() => null))) want.push(id);
      if (!want.length) return;
      const where = new Map();
      for (let i = 0; i < want.length; i += 100) {
        const { data } = await sb.from('asset_files').select('asset_id, hash, filename, mime, fit_cell, private').in('asset_id', want.slice(i, i + 100));
        for (const r of data || []) where.set(r.asset_id, r);
      }
      for (const id of want) {
        try {
          const m = where.get(id);
          const { data, error } = await sb.storage.from('assets').download(m ? objectOf(m.hash, m.private) : id + '.va');
          if (error) { console.info('file not online yet', id); continue; }
          const raw = new Uint8Array(await (await gunzip(data)).arrayBuffer());
          const nl = raw.indexOf(10);
          const head = JSON.parse(new TextDecoder().decode(raw.subarray(0, nl)));
          const filename = (m && m.filename) || head.filename || 'file', mime = (m && m.mime) || head.mime || 'application/octet-stream';
          await invoke('asset_put', raw.subarray(nl + 1), { headers: { 'x-id': id, 'x-name': encodeURIComponent(filename), 'x-type': mime } });
          const fit = head.fit || (m && m.fit_cell);
          if (fit) await L.set('_fit', id, { cell: Number(fit) });   // this Mac has the fit copy, not the original
          got++;
        } catch (e) { console.warn('file download', id, e); }
      }
      if (got) for (const c of ['venue_models', 'tour_models', 'venue_edits', 'tour_packs', 'stage_builds', 'vendor_lists', 'quotes']) emit(c);
    });
  }

  // every file this Mac has for documents it can edit, checked against what's online: sends any
  // that are missing (which also moves 0.3.0 uploads over), then asks for unused files to be removed
  let lastTidy = 0;
  async function checkFiles() {
    const ids = new Set(), models = new Set(), priv = new Set();
    for (const col of SYNCED) {
      for (const d of await L.list(col)) {
        if (!mayWrite(col, d.id)) continue;
        const [i, m] = filesOf(col, d.data);
        i.forEach(x => (ADMIN.includes(col) ? priv : ids).add(x)); m.forEach(x => models.add(x));
      }
    }
    for (const [set, p] of [[ids, false], [priv, true]]) {
      const here = [];
      for (const id of set) if ((p || !priv.has(id)) && await invoke('asset_info', { id }).catch(() => null)) here.push(id);
      for (let i = 0; i < here.length; i += 200) await sendFiles(here.slice(i, i + 200), models, p);
    }
    if (Date.now() - lastTidy > 30 * 60000) {
      lastTidy = Date.now();
      sb.functions.invoke('files', { body: {} }).catch(e => console.info('tidy files', e));
    }
  }

  // ---------- status ----------
  let status = 'idle', lastSync = null;
  function setStatus(s) { if (s !== status) { status = s; changed({ status: s }); } }

  // ---------- sign-in, start, sign-out ----------
  async function start() {
    const state = (await L.get('_sync', 'state')) || {};
    if (state.userId && state.userId !== me.id) {
      // a different account on this Mac: start its copy of the online data from scratch
      for (const col of [...SYNCED, '_base']) for (const d of await L.list(col)) await L.del(col, d.id);
      await L.set('_sync', 'state', { userId: me.id, seq: 0 });
    }
    await loadRoles();
    await pull();
    await reconcile();
    sb.channel('va-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, () => schedulePull())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tour_members' }, () => { loadRoles().then(() => { schedulePull(); reconcile().catch(() => {}); }).catch(() => {}); })
      .subscribe();
    setInterval(() => { schedulePull(0); }, 60000);
    setInterval(() => { loadRoles().then(reconcile).catch(() => {}); }, 10 * 60000);
    window.addEventListener('online', () => { schedulePull(0); schedulePush(500); });
  }

  async function signOut() {
    if (window.vaAdmin && window.vaAdmin.lock) try { window.vaAdmin.lock(); } catch {}
    try { localStorage.removeItem('va-me'); } catch {}
    await sb.auth.signOut().catch(() => {});
    location.reload();
  }

  // ---------- dialogs ----------
  const dlgCss = 'max-width:440px;width:calc(100% - 32px);border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--fg);padding:18px 20px;font:inherit';
  const inputCss = 'font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%;box-sizing:border-box';
  function dialog(html) {
    const d = document.createElement('dialog');
    d.style.cssText = dlgCss;
    d.innerHTML = html;
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    return d;
  }
  const h3 = t => `<h3 style="margin:0;font-family:var(--display);text-transform:uppercase;letter-spacing:.04em">${t}</h3>`;

  // email -> 6-digit code -> (first time) name and company
  function signInDialog(why) {
    return new Promise(resolve => {
      const d = dialog(`<form style="display:grid;gap:10px">
        ${h3('Sign in to Venue Access')}
        <p style="margin:0">${why || 'Sign in to get the shared venue library and the tours shared with you.'}</p>
        <div data-step="email" style="display:grid;gap:10px">
          <input name="email" type="email" autocomplete="email" placeholder="you@company.com" style="${inputCss}">
        </div>
        <div data-step="code" style="display:grid;gap:10px" hidden>
          <p style="margin:0;color:var(--muted);font-size:13px">We emailed a 6-digit code to <b data-to></b>. It can take a minute to arrive; check spam too.</p>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="${inputCss};letter-spacing:.3em;font-size:20px">
        </div>
        <div data-step="profile" style="display:grid;gap:10px" hidden>
          <p style="margin:0">One more thing: how should your name show on tours you share?</p>
          <input name="name" autocomplete="name" placeholder="Your name" style="${inputCss}">
          <input name="company" autocomplete="organization" placeholder="Company (optional)" style="${inputCss}">
        </div>
        <p class="err" style="margin:0;color:var(--fail)" hidden></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" data-off class="btn sm ghost" style="margin-right:auto">Browse only</button>
          <button type="button" data-back class="btn sm ghost" hidden>Use a different email</button>
          <button type="submit" class="btn sm" data-go>Email me a code</button>
        </div></form>`);
      const f = d.querySelector('form'), err = d.querySelector('.err'), go = d.querySelector('[data-go]');
      const step = s => { for (const el of d.querySelectorAll('[data-step]')) el.hidden = el.dataset.step !== s; d.querySelector('[data-back]').hidden = s !== 'code'; d.querySelector('[data-off]').hidden = s === 'profile'; go.textContent = { email: 'Email me a code', code: 'Sign in', profile: 'Done' }[s]; cur = s; const i = d.querySelector(`[data-step="${s}"] input`); if (i) i.focus(); };
      const say = t => { err.textContent = t; err.hidden = !t; };
      let cur = 'email', email = '', done = false;
      const finish = v => { if (done) return; done = true; d.close(); resolve(v); };
      d.querySelector('[data-off]').onclick = () => finish(false);
      d.querySelector('[data-back]').onclick = () => { say(''); step('email'); };
      d.addEventListener('cancel', e => { if (cur === 'profile') e.preventDefault(); else finish(false); });
      f.onsubmit = async e => {
        e.preventDefault();
        say('');
        go.disabled = true;
        try {
          if (cur === 'email') {
            email = f.email.value.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('Type your email address.');
            const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
            if (error) {
              if (/fetch/i.test(error.name || '') || error.status === 0) return say("Can't reach the internet right now. Try again, or browse only for now.");
              if (/signups? not allowed|not found|invalid login/i.test(error.message)) return say(`${email} isn't invited yet. Ask Julien to add you as a tester, then try again.`);
              if (/rate|seconds/i.test(error.message)) return say('A code was just sent. Wait a few seconds before asking for another.');
              return say(error.message);
            }
            d.querySelector('[data-to]').textContent = email;
            step('code');
          } else if (cur === 'code') {
            const token = f.code.value.replace(/\D/g, '');
            if (token.length !== 6) return say('Type the 6 digits from the email.');
            const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
            if (error && (/fetch/i.test(error.name || '') || error.status === 0)) return say("Can't reach the internet right now. Try again.");
            if (error) return say(/expired|invalid/i.test(error.message) ? "That code didn't work. Check it, or go back and ask for a new one." : error.message);
            session = data.session;
            await loadMe();
            if (!me.name) step('profile'); else finish(true);
          } else {
            const name = f.name.value.trim();
            if (!name) return say('Type your name.');
            const { error } = await sb.rpc('update_profile', { p_name: name, p_company: f.company.value.trim() });
            if (error) return say(error.message);
            me.name = name;
            finish(true);
          }
        } catch (x) { say(isNetwork(x) ? "Can't reach the internet right now. Try again, or browse only for now." : String(x.message || x)); }
        finally { go.disabled = false; }
      };
      step('email');
    });
  }

  async function accountDialog() {
    if (!signedIn()) {
      if (await signInDialog()) location.reload();
      return;
    }
    try { await loadMe(); } catch {}
    const pending = touched.size;
    const statusText = { ok: 'Up to date', syncing: 'Syncing…', offline: `Offline: changes are kept on ${HERE} and sent when you're back online`, error: "Sync hit a problem; it'll keep retrying", idle: 'Starting…' }[status];
    const d = dialog(`<form method="dialog" style="display:grid;gap:10px">
      ${h3('Your account')}
      <p style="margin:0"><b>${esc(me.email)}</b>${me.is_admin ? ' · admin' : ''}</p>
      <label style="display:grid;gap:4px;font-size:13px;color:var(--muted)">Name<input name="name" value="${esc(me.name)}" style="${inputCss}"></label>
      <label style="display:grid;gap:4px;font-size:13px;color:var(--muted)">Company<input name="company" value="${esc(me.company)}" style="${inputCss}"></label>
      <p style="margin:0;font-size:13px;color:var(--muted)">Sync: ${esc(statusText)}${pending ? ` (${pending} change${pending === 1 ? '' : 's'} waiting)` : ''}${lastSync ? `. Last synced ${lastSync.toLocaleTimeString()}` : ''}.</p>
      <p style="margin:0;font-size:13px;color:var(--muted)">Tech pack reads this month: ${me.packs_this_month}${me.is_admin ? '' : ` of ${me.pack_quota}`}.</p>
      <p class="err" style="margin:0;color:var(--fail)" hidden></p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" data-out class="btn sm danger" style="margin-right:auto">Sign out</button>
        <button value="cancel" class="btn sm ghost">Close</button><button value="save" type="submit" class="btn sm">Save</button>
      </div></form>`);
    const f = d.querySelector('form'), err = d.querySelector('.err');
    d.querySelector('[data-out]').onclick = () => {
      if (touched.size && !confirm(`Some changes haven't reached the online store yet. Sign out anyway? They stay on ${HERE} and go up the next time you sign in with this account.`)) return;
      signOut();
    };
    f.onsubmit = async e => {
      if (e.submitter && e.submitter.value !== 'save') return;
      e.preventDefault();
      const { error } = await sb.rpc('update_profile', { p_name: f.name.value, p_company: f.company.value });
      if (error) { err.textContent = error.message; err.hidden = false; return; }
      me.name = f.name.value.trim(); me.company = f.company.value.trim();
      d.close();
    };
  }

  async function adminCall(body) {
    const { data, error } = await sb.functions.invoke('admin', { body });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return data;
  }
  // the message Julien sends a new tester, filled in with their name and email
  function inviteText(name, email) {
    const first = String(name || '').trim().split(/\s+/)[0];
    return `${first ? `Hey ${first},` : 'Hi,'}

I'd love for you to try Venue Access, the app I'm building for venue specs and stage fit checks.

1. Download it here: https://github.com/blacklanterncreative/venue-access-releases/releases/latest
   Grab the .dmg with "Viewer" in the name.
2. Open the .dmg and drag Venue Access into Applications.
3. The first time you open it, macOS will say it can't check the developer. Go to System Settings > Privacy & Security, scroll down and click "Open Anyway". You only have to do this once. If a Keychain prompt appears, choose "Always Allow".
4. Sign in with ${email}. You'll get a 6-digit code from noreply@mail.blacklanterncreative.com (check spam if it doesn't show up).

It updates itself. Let me know what feels off or what you'd want it to do.

${(me && me.name) || 'Julien'}`;
  }
  function inviteDialog(name, email) {
    const d = dialog(`<div style="display:grid;gap:10px">
      ${h3('Invite ' + esc(name || email))}
      <p style="margin:0;color:var(--muted);font-size:13px">Copy this and send it to them by text or email.</p>
      <textarea readonly rows="16" style="${inputCss};resize:vertical;font-size:13px;line-height:1.45"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button data-copy class="btn sm">Copy message</button><button data-close class="btn sm ghost">Close</button>
      </div></div>`);
    d.style.maxWidth = '560px';
    const ta = d.querySelector('textarea'), copy = d.querySelector('[data-copy]');
    ta.value = inviteText(name, email);
    d.querySelector('[data-close]').onclick = () => d.close();
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(ta.value); }
      catch { ta.select(); document.execCommand('copy'); }
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy message'; }, 1600);
    };
    return d;
  }
  async function testersDialog() {
    if (!signedIn()) { if (await signInDialog('Sign in to manage testers.')) location.reload(); return; }
    if (!me.is_admin) { banner('Only an admin can manage testers.', [['OK', closeBanner, 'ghost']]); return; }
    const d = dialog(`<div style="display:grid;gap:12px">
      ${h3('Testers')}
      <p style="margin:0;color:var(--muted);font-size:13px">Only people on this list can sign in. Each one gets a monthly allowance of tech pack reads on your Claude key.</p>
      <div data-list style="display:grid;gap:6px;max-height:340px;overflow:auto">Loading…</div>
      <form style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px">
        <input name="email" type="email" placeholder="Email" style="${inputCss}">
        <input name="name" placeholder="Name (optional)" style="${inputCss}">
        <button class="btn sm">Add</button>
      </form>
      <p class="err" style="margin:0;color:var(--fail)" hidden></p>
      <div style="display:flex;justify-content:flex-end"><button data-close class="btn sm ghost">Close</button></div></div>`);
    d.style.maxWidth = '620px';
    const list = d.querySelector('[data-list]'), err = d.querySelector('.err'), f = d.querySelector('form');
    const say = t => { err.textContent = t || ''; err.hidden = !t; };
    d.querySelector('[data-close]').onclick = () => d.close();
    async function load() {
      const { data, error } = await sb.rpc('accounts');
      if (error) { list.textContent = error.message; return; }
      list.innerHTML = '';
      for (const a of data) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--line);border-radius:6px';
        row.innerHTML = `<div><b>${esc(a.name || a.email)}</b>${a.is_admin ? ' · admin' : ''}<div style="font-size:12px;color:var(--muted)">${esc(a.email)}${a.company ? ' · ' + esc(a.company) : ''} · ${a.last_sign_in_at ? 'last in ' + new Date(a.last_sign_in_at).toLocaleDateString() : 'not signed in yet'}</div></div>
          <label style="font-size:12px;color:var(--muted)">${a.packs_this_month} of <input type="number" min="0" max="1000" value="${a.pack_quota}" style="width:56px;${inputCss.replace('width:100%;', '')}" ${a.is_admin ? 'disabled title="Admins have no limit"' : ''}> packs</label>
          <button class="btn sm danger" ${a.id === me.id ? 'disabled' : ''}>Remove</button>
          ${a.last_sign_in_at || a.id === me.id ? '' : '<a href="#" data-invite style="grid-column:1/-1;font-size:12px;color:var(--fg);text-decoration:underline">Invite message</a>'}`;
        const q = row.querySelector('input');
        q.onchange = async () => { const { error } = await sb.rpc('set_pack_quota', { p_user: a.id, p_quota: Number(q.value) || 0 }); say(error ? error.message : ''); };
        const inv = row.querySelector('[data-invite]');
        if (inv) inv.onclick = e => { e.preventDefault(); inviteDialog(a.name, a.email); };
        row.querySelector('button.danger').onclick = async () => {
          if (!confirm(`Remove ${a.email}? They can't sign in any more, and tours they own are left without an owner.`)) return;
          try { await adminCall({ action: 'remove', userId: a.id }); say(''); load(); } catch (x) { say(x.message); }
        };
        list.append(row);
      }
    }
    f.onsubmit = async e => {
      e.preventDefault();
      say('');
      try {
        const r = await adminCall({ action: 'invite', email: f.email.value.trim(), name: f.name.value.trim() || undefined });
        const name = f.name.value.trim();
        f.reset();
        load();
        inviteDialog(name, r.email || '');
      } catch (x) { say(x.message); }
    };
    load();
  }

  // "Forgot the password?" in Settings > Admin: prove it's the admin by a fresh emailed code
  function adminReauth() {
    return new Promise(async resolve => {
      if (!signedIn()) { const ok = await signInDialog('Sign in with the admin account to reset the Admin password.'); return resolve(ok && !!me.is_admin); }
      if (!me.is_admin) { banner('Only an admin can reset the Admin password.', [['OK', closeBanner, 'ghost']]); return resolve(false); }
      const d = dialog(`<form style="display:grid;gap:10px">
        ${h3('Reset the Admin password')}
        <p style="margin:0">To prove it's you, we'll email a 6-digit code to <b>${esc(me.email)}</b>.</p>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="${inputCss};letter-spacing:.3em;font-size:20px" hidden>
        <p class="err" style="margin:0;color:var(--fail)" hidden></p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" data-x class="btn sm ghost">Cancel</button><button type="submit" class="btn sm" data-go>Email me a code</button>
        </div></form>`);
      const f = d.querySelector('form'), err = d.querySelector('.err'), go = d.querySelector('[data-go]');
      const say = t => { err.textContent = t; err.hidden = !t; };
      let sent = false, done = false;
      const finish = v => { if (done) return; done = true; d.close(); resolve(v); };
      d.querySelector('[data-x]').onclick = () => finish(false);
      d.addEventListener('cancel', () => finish(false));
      f.onsubmit = async e => {
        e.preventDefault(); say(''); go.disabled = true;
        try {
          if (!sent) {
            const { error } = await sb.auth.signInWithOtp({ email: me.email, options: { shouldCreateUser: false } });
            if (error) return say(/rate|seconds/i.test(error.message) ? 'A code was just sent. Wait a few seconds before asking for another.' : error.message);
            sent = true; f.code.hidden = false; f.code.focus(); go.textContent = 'Reset';
          } else {
            const token = f.code.value.replace(/\D/g, '');
            if (token.length !== 6) return say('Type the 6 digits from the email.');
            const { data, error } = await sb.auth.verifyOtp({ email: me.email, token, type: 'email' });
            if (error) return say(/expired|invalid/i.test(error.message) ? "That code didn't work. Check it, or close and ask for a new one." : error.message);
            session = data.session;
            await loadMe();
            finish(!!me.is_admin);
          }
        } catch (x) { say(isNetwork(x) ? "Can't reach the internet right now. Try again." : String(x.message || x)); }
        finally { go.disabled = false; }
      };
    });
  }
  if (window.vaDesktop) {
    window.vaDesktop.adminReauth = adminReauth;
    window.vaDesktop.manageTesters = () => testersDialog();   // the button in Settings > Admin
    window.vaDesktop.account = () => accountDialog();   // Settings' Account button (the phone has no app menu)
  }

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('va-account', () => accountDialog());
    window.__TAURI__.event.listen('va-testers', () => testersDialog());
  }

  // ---------- what the page sees ----------
  const ready = (async () => {
    try {
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((_e, s) => { session = s; });
      if (session) {
        try { await loadMe(); }
        catch (e) {
          if (isNetwork(e)) { offline = true; me = cachedMe(); setStatus('offline'); }
          else { await sb.auth.signOut().catch(() => {}); session = null; }
        }
      }
      if (!session && !sessionStorage.getItem('va-offline')) {
        if (await signInDialog()) location.reload();
        else sessionStorage.setItem('va-offline', '1');
        return;
      }
      if (session && me && !offline) start().catch(e => console.warn('sync start', e));
      if (offline) {
        // signed in but no internet at launch: work locally and connect when the network is back
        window.addEventListener('online', async () => { try { await loadMe(); offline = false; start(); } catch {} }, { once: true });
      }
    } catch (e) { console.warn('cloud', e); }
  })();

  const db = {
    collection(col) {
      const base = ctx.localDb.collection(col);
      if (!SYNCED.includes(col)) return base;
      return {
        onSnapshot: base.onSnapshot,
        doc(id) {
          const d = base.doc(id);
          const guard = () => {
            if (signedIn() && !mayWrite(col, id)) throw fail('invalid_argument', 'view only');
          };
          return {
            get: d.get,
            async set(data) {
              guard();
              await locked(() => L.set(col, id, data));
              emit(col);
              if (signedIn()) { touched.add(keyOf(col, id)); schedulePush(); }
            },
            async delete() {
              guard();
              await locked(() => L.del(col, id));
              emit(col);
              if (signedIn()) { touched.add(keyOf(col, id)); schedulePush(); }
            },
          };
        },
      };
    },
  };

  const user = {
    async id() { await ready; return signedIn() ? me.id : ctx.localUser.id(); },
    async canEdit() { await ready; return signedIn() ? !!me.is_admin : ctx.localUser.canEdit(); },
    async can(perm) { await ready; return signedIn() ? (perm === 'data.write' ? true : !!me.is_admin) : ctx.localUser.can(perm); },
    async profiles(ids) {
      await ready;
      if (!signedIn()) return ctx.localUser.profiles(ids);
      const uuids = (ids || []).filter(x => /^[0-9a-f-]{36}$/i.test(x));
      const out = {};
      if (uuids.length) {
        const { data } = await sb.from('profiles').select('id, name, company').in('id', uuids);
        for (const p of data || []) out[p.id] = { name: p.name, company: p.company };
      }
      return out;
    },
  };

  // tech packs: signed in, the server reads them with the project's key (monthly allowance);
  // signed out, the Mac's own key as before
  async function json(prompt, opts = {}) {
    await ready;
    if (!signedIn()) return ctx.localSample.json(prompt, opts);
    const sig = opts.signal;
    if (sig && sig.aborted) throw fail('cancelled');
    const b64 = async blob => {
      const s = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      return String(s).split(',')[1];
    };
    const images = [];
    for (const b of opts.images || []) images.push({ media_type: b.type || 'image/jpeg', data: await b64(b) });
    const { data: s } = await sb.auth.getSession();
    if (!s.session) throw fail('not_granted', 'Sign in again to read packs.');
    if (opts.onText) setTimeout(() => { try { opts.onText(''); } catch {} }, 1500);
    let res;
    try {
      res = await fetch(cfg.url + '/functions/v1/read-pack', {
        method: 'POST', signal: sig,
        headers: { Authorization: 'Bearer ' + s.session.access_token, apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, images }),
      });
    } catch (e) { throw sig && sig.aborted ? fail('cancelled') : fail('network', String(e)); }
    const text = await res.text().catch(() => '');
    let out = {};
    try { out = JSON.parse(text.trim().split('\n').pop() || '{}'); } catch {}
    if ('value' in out) return out.value;
    if (out.code === 'quota') banner(esc(out.message), [['OK', closeBanner, 'ghost']]);
    throw fail(out.code === 'quota' ? 'rate_limited' : out.code || 'error', out.message || `The pack reader returned ${res.status}.`);
  }
  const sample = Object.assign((...a) => json(...a), { json, limits: ctx.localSample.limits });

  // ---------- window.vaCloud: sharing and change history for the page's Sharing tab and Changes list ----------
  const rpc = async (name, args) => { const { data, error } = await sb.rpc(name, args); if (error) throw Object.assign(new Error(friendly(error)), { code: error.code }); return data; };
  const friendly = e => ({
    not_a_tester: "That person isn't a tester yet. Julien adds testers from Settings > Testers.",
    owner_only: 'Only the tour owner can change who it is shared with.',
    is_owner: "The tour owner's access can't be changed.",
    bad_role: 'Pick Editor or Viewer.',
    link_gone: 'That link was already turned off.',
    too_many_links: 'A tour can have up to 20 links. Turn one off first.',
    snapshot_too_big: 'This tour is too big for one link. Leave out some shows or the specs and try again.',
  })[(e.message || '').trim()] || e.message;
  async function online(tourId) {
    await ready;
    if (!signedIn()) throw new Error('Sign in (Settings > Account…) to share tours.');
    if (!roles.has(tourId)) {
      // a tour made before signing in: make sure it is online before sharing it
      touched.add(keyOf('tours', tourId));
      await push();
      if (!roles.has(tourId)) throw new Error("This tour hasn't reached the online store yet. Check your connection and try again.");
    }
  }
  window.vaCloud = {
    get available() { return signedIn(); },
    ready: ready.then(() => signedIn()),
    me: () => (signedIn() ? { id: me.id, email: me.email, name: me.name, company: me.company, isAdmin: !!me.is_admin } : null),
    status: () => ({ state: status, pending: touched.size, lastSync }),
    // 'owner' | 'editor' | 'viewer'; a tour that only exists on this Mac counts as yours
    myRole: tourId => (signedIn() ? roles.get(tourId) || 'owner' : 'owner'),
    async members(tourId) { await online(tourId); return (await rpc('tour_members_list', { p_tour: tourId })).map(m => ({ userId: m.user_id, name: m.name, email: m.email, company: m.company, role: m.role, addedAt: m.added_at })); },
    async share(tourId, email, role) { await online(tourId); const r = await rpc('share_tour', { p_tour: tourId, p_email: email, p_role: role }); changed({ members: tourId }); return { userId: r.user_id, name: r.name, email: r.email, role: r.role }; },
    async setRole(tourId, email, role) { return this.share(tourId, email, role); },
    async remove(tourId, userId) { await online(tourId); await rpc('unshare_tour', { p_tour: tourId, p_user: userId }); changed({ members: tourId }); },
    async leave(tourId) { await online(tourId); await rpc('unshare_tour', { p_tour: tourId, p_user: me.id }); await loadRoles(); await reconcile(); },
    // newest first: {at, userId, name, collection, docId, kind: set|remove|order|create|delete, path, old, new}
    async changes(tourId, { limit = 200 } = {}) {
      await ready;
      if (!signedIn() || !roles.has(tourId)) return [];
      return (await rpc('tour_changes', { p_tour: tourId, p_limit: limit })).map(c => ({ at: c.at, userId: c.user_id, name: c.name, collection: c.collection, docId: c.doc_id, kind: c.kind, path: c.path, old: c.old, new: c.new }));
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    // the grid (metres) a 3D model on this Mac was simplified to online, or null when this Mac
    // has the full-detail original (it was imported here)
    async fitCell(assetId) { const f = await L.get('_fit', assetId).catch(() => null); return f && f.cell > 0 ? f.cell : null; },
    // online file storage for Settings: {usedBytes, limitBytes, files}; null when signed out.
    // Everyone's files share the one free-plan allowance.
    async storage() {
      await ready;
      if (!signedIn()) return null;
      const u = await rpc('files_usage', {});
      return { usedBytes: Number(u.usedBytes) || 0, limitBytes: STORAGE_LIMIT, files: Number(u.files) || 0 };
    },
    signIn: () => accountDialog(),
    // client and artist links: a no-sign-in web page of one tour (owner only). The page builds the
    // snapshot; this stores it with its pictures. Pictures are named by content, so publishing
    // again only uploads the ones that changed.
    clientLinks: {
      url: token => (cfg.shareBase || 'https://blacklanterncreative.github.io/venue-access-releases/share/') + '#' + token,
      async list(tourId) {
        await online(tourId);
        return (await rpc('client_links_list', { p_tour: tourId })).map(l => ({ token: l.token, label: l.label, createdAt: l.created_at, publishedAt: l.published_at, views: l.views, lastViewAt: l.last_view_at, by: l.by_name, opts: l.opts || null, url: window.vaCloud.clientLinks.url(l.token) }));
      },
      async make(tourId, label) { await online(tourId); const r = await rpc('client_link_make', { p_tour: tourId, p_label: label || '' }); return { token: r.token, label: r.label, url: window.vaCloud.clientLinks.url(r.token) }; },
      async rename(token, label) { await ready; await rpc('client_link_rename', { p_token: token, p_label: label || '' }); },
      // snapshot: plain data; pictures: [{key, url (data: URL) | blob}] (JPEG, PNG, or GLB for the 3D viewer). A picture is referred to in
      // the snapshot by its key and replaced here by its stored name.
      async publish(token, snapshot, pictures = []) {
        await ready;
        if (!signedIn()) throw new Error('Sign in (Settings > Account…) to share tours.');
        const names = new Map();
        for (const p of pictures) {
          const blob = p.blob || await (await fetch(p.url)).blob();
          const kind = blob.type === 'image/png' ? ['.png', 'image/png'] : blob.type === 'model/gltf-binary' ? ['.glb', 'model/gltf-binary'] : ['.jpg', 'image/jpeg'];
          const name = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).slice(0, 32) + kind[0];
          if (![...names.values()].includes(name)) {
            const { error } = await sb.storage.from('client-links').upload(token + '/' + name, blob, { contentType: kind[1], upsert: true });
            if (error) throw new Error("A file didn't upload: " + error.message);
          }
          names.set(p.key, name);
        }
        const swap = x => Array.isArray(x) ? x.map(swap) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, (k === 'name' || k === 'logo') && names.has(v) ? names.get(v) : swap(v)])) : x;
        const snap = swap(snapshot);
        const gone = await rpc('client_link_publish', { p_token: token, p_snapshot: snap, p_pics: [...new Set(names.values())].map(n => token + '/' + n) });
        if (gone && gone.length) sb.storage.from('client-links').remove(gone).catch(e => console.info('client link pictures', e));
        return { url: window.vaCloud.clientLinks.url(token) };
      },
      // the address stops working at once; its pictures are deleted
      async off(token) {
        await ready;
        const { data } = await sb.storage.from('client-links').list(token, { limit: 1000 });
        const files = (data || []).map(f => token + '/' + f.name);
        if (files.length) await sb.storage.from('client-links').remove(files);
        await rpc('client_link_off', { p_token: token });
      },
    },
  };

  // exposed for tests
  window.__vaSync = { diff, apply, same, refs, fitModel, inviteText, async now() { await loadRoles(); await pull(); await reconcile(); await push(); } };
  return { db, user, sample };
};
