/* Okinawa Trip — shared data layer.
   Talks to the existing Supabase Edge Function "okinawa-sync".
   No passwords, password hashes or admin keys are stored here. */
(() => {
  'use strict';
  const ENDPOINT = window.OKT_ENDPOINT || 'https://plxlpuyebwijwxrnwxsn.supabase.co/functions/v1/okinawa-sync';
  const K = { session:'okt-session-v2', cache:'okt-cache-v2', outbox:'okt-outbox-v2' };
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const clone = x => JSON.parse(JSON.stringify(x));
  const uuid = () => crypto.randomUUID();

  // Older app versions kept their session under another key; reuse it so nobody has to log in again.
  let auth = read(K.session, null) || read('okinawa-sync-session-v1', null);
  if (auth && auth.expires_at && Date.parse(auth.expires_at) < Date.now()) auth = null;
  let records = new Map(), requests = [], ownLikes = new Set(), outbox = read(K.outbox, []);
  const cached = read(K.cache, null);
  if (cached) { records = new Map(cached.records.map(r => [r.id, r])); requests = cached.requests || []; ownLikes = new Set(cached.ownLikes || []); }
  let busy = false, refreshing = false, online = false, lastActivity = Date.now(), lastError = '';
  const listeners = new Set();
  const emit = (why) => listeners.forEach(fn => { try { fn(why); } catch (e) { console.error(e); } });
  const persist = () => write(K.outbox, outbox) && write(K.cache, { records:[...records.values()], requests, ownLikes:[...ownLikes] });

  async function api(body){
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), 20000);
    try {
      const r = await fetch(ENDPOINT, { method:'POST', headers:{ 'Content-Type':'application/json', ...(auth?.token ? { Authorization:'Bearer ' + auth.token } : {}) }, body:JSON.stringify(body), signal:c.signal });
      let data = {}; try { data = await r.json(); } catch {}
      if (!r.ok) {
        const e = Object.assign(new Error(data.error || 'network_error'), { status:r.status, data });
        if (r.status === 401 && body.action !== 'login') { auth = null; localStorage.removeItem(K.session); emit('signed-out'); }
        throw e;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  /* ---------- view of records with pending local edits applied ---------- */
  const merge = (base, patch) => { const out = { ...(base || {}) }; for (const [k, v] of Object.entries(patch || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = { ...out[k], ...v }; else out[k] = v; } return out; };
  function view(){
    const m = new Map([...records].map(([id, r]) => [id, { ...r, payload: clone(r.payload) }]));
    for (const op of outbox) {
      if (op.action !== 'save') continue;
      const cur = m.get(op.id) || { id:op.id, kind:op.kind, version:0, payload:{}, deleted_at:null, pending:true };
      m.set(op.id, { ...cur, kind:op.kind, payload:merge(cur.payload, op.patch), deleted_at: op.deleted ? 'pending' : cur.deleted_at, pending:true });
    }
    return m;
  }
  const list = kind => [...view().values()].filter(r => r.kind === kind && !r.deleted_at);

  /* ---------- writes ---------- */
  function enqueue(op){ outbox.push({ ...clone(op), qid:uuid() }); persist(); emit('local'); void drain(); }
  function save(kind, id, patch, opts = {}){ enqueue({ action:'save', kind, id, patch, deleted:!!opts.deleted, create:!!opts.create, imported:!!opts.imported, photoOnly:!!opts.photoOnly }); }
  async function drain(){
    if (busy || !auth) return; busy = true;
    try {
      while (outbox.length) {
        const op = outbox[0];
        if (op.action === 'save') {
          let ok = false;
          for (let attempt = 0; attempt < 4 && !ok; attempt++) {
            const cur = records.get(op.id);
            const payload = merge(cur ? cur.payload : {}, op.patch);
            const body = { action:'save', kind:op.kind, id:op.id, payload, version:cur ? cur.version : 0, ...(op.deleted ? { deleted:true } : {}), ...(op.imported ? { imported:true } : {}), ...(op.photoOnly ? { photoOnly:true } : {}) };
            if (op.deleted && !cur) { ok = true; break; }            // nothing on the server to delete
            try { const res = await api(body); if (res.record) records.set(res.record.id, res.record); ok = true; }
            catch (e) {
              if (e.status === 409) {                                 // someone else changed it: take theirs, re-apply our change
                if (e.data?.record) records.set(e.data.record.id, e.data.record); else await pull(true);
                continue;
              }
              if (e.status === 400) { console.warn('dropped invalid change', op, e.data); ok = true; lastError = 'invalid'; break; }
              throw e;
            }
          }
          if (!ok) throw Object.assign(new Error('conflict_retry_exhausted'), { status:409 });
        } else if (op.action === 'like') {
          await api({ action:'like', wishId:op.wishId, liked:op.liked });
          await pull(true);
        } else if (op.action === 'request') {
          await api({ action:'request', id:op.id, message:op.message });
          if (!requests.some(r => r.id === op.id)) requests.push({ id:op.id, message:op.message, created_at:new Date().toISOString() });
        }
        outbox.shift(); persist(); emit('saved');
      }
      online = true; lastError = '';
    } catch (e) {
      online = false; lastError = e.status === 429 ? 'busy' : 'offline'; emit('status');
    } finally { busy = false; }
  }

  /* ---------- reads ---------- */
  async function pull(force){
    if ((refreshing && !force) || !auth) return; refreshing = true;
    try {
      const data = await api({ action:'snapshot' });
      const sig = rs => rs.map(r => r.id + ':' + r.version + ':' + r.deleted_at).sort().join('|');
      const changed = sig(data.records) !== sig([...records.values()]) || JSON.stringify(data.requests) !== JSON.stringify(requests) || JSON.stringify(data.ownLikes) !== JSON.stringify([...ownLikes]);
      const before = records;
      records = new Map(data.records.map(r => [r.id, r])); requests = data.requests || []; ownLikes = new Set(data.ownLikes || []);
      online = true; lastError = '';
      persist();
      if (changed) emit({ type:'remote', before });
      else emit('status');
    } catch (e) { if (e.status !== 401) { online = false; lastError = 'offline'; emit('status'); } }
    finally { refreshing = false; }
  }

  /* ---------- media ---------- */
  const mediaUpload = (path, blob, onProgress) => new Promise((resolve, reject) => {
    if (!auth?.token) { reject(Error('sign_in_required')); return; }
    const x = new XMLHttpRequest(); x.open('POST', ENDPOINT); x.timeout = 300000;
    x.setRequestHeader('Authorization', 'Bearer ' + auth.token); x.setRequestHeader('Content-Type', blob.type); x.setRequestHeader('x-upload-path', path);
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} if (x.status >= 200 && x.status < 300) resolve(d); else reject(Object.assign(Error(d.error || 'upload_failed'), { status:x.status })); };
    x.onerror = () => reject(Error('network_error')); x.ontimeout = () => reject(Error('upload_timeout'));
    x.send(blob);
  });

  /* ---------- public API ---------- */
  window.Sync = {
    on(fn){ listeners.add(fn); return () => listeners.delete(fn); },
    get family(){ return auth?.family || ''; },
    get signedIn(){ return !!auth?.token; },
    get pending(){ return outbox.length; },
    get online(){ return online; },
    get error(){ return lastError; },
    list, get:(id) => view().get(id), records:() => view(),
    requests:() => [...requests, ...outbox.filter(o => o.action === 'request' && !requests.some(r => r.id === o.id)).map(o => ({ id:o.id, message:o.message, created_at:new Date().toISOString(), pending:true }))],
    likeCount(wishId){
      const likes = [...view().values()].filter(r => r.kind === 'like' && r.payload.wishId === wishId);
      const pend = outbox.filter(o => o.action === 'like' && o.wishId === wishId).at(-1);
      const mineNow = likes.some(l => l.payload.liked && ownLikes.has(l.id));
      const mine = pend ? pend.liked : mineNow;
      const others = likes.filter(l => l.payload.liked && !ownLikes.has(l.id)).length;
      return { mine, count: others + (mine ? 1 : 0) };
    },
    save, remove:(kind, id) => save(kind, id, {}, { deleted:true }),
    create:(kind, payload, id = uuid(), opts = {}) => { save(kind, id, payload, { create:true, ...opts }); return id; },
    like:(wishId, liked) => enqueue({ action:'like', wishId, liked }),
    request:(message) => enqueue({ action:'request', id:uuid(), message }),
    async login(family, password){
      const res = await api({ action:'login', family, password });
      auth = res; write(K.session, auth);
      await pull(true); await drain(); emit('signed-in');
      return res;
    },
    async logout(){ try { await api({ action:'logout' }); } catch {} auth = null; localStorage.removeItem(K.session); emit('signed-out'); },
    refresh:() => pull(true), drain,
    ogImage:(url) => api({ action:'og_image', url }).then(d => d.image || '').catch(() => ''),
    media:{
      list:() => api({ action:'media_list' }),
      url:(path) => api({ action:'media_get', path }).then(d => d.url),
      upload:mediaUpload
    },
    stableId: async (label) => { const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))), x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; },
    async start(){ if (!auth) { emit('signed-out'); return; } await pull(true); await drain(); emit('signed-in'); }
  };

  // Poll while the app is open and being used; pause after 10 minutes without interaction.
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { lastActivity = Date.now(); }, { passive:true });
  setInterval(() => { if (!document.hidden && auth && Date.now() - lastActivity < 600000) { if (outbox.length) void drain(); else void pull(); } }, 5000);
  addEventListener('online', () => { void drain(); void pull(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth) { lastActivity = Date.now(); void drain(); void pull(true); } });
})();
