// Online account & sync.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Accounts (email, Google, Apple or Microsoft) live in Supabase; originals in Backblaze B2.
// Paid plans sync edits, ratings, flags, albums and thumbnails; Cloud plans also back up originals
// so photos can be edited anywhere. Without a configured backend the app works offline.
import { isPaid } from './pricing.js';
import { begin as beginProgress } from './portrait-progress.js';
import { backendConfigured } from './config.js';
import * as sb from './backend/supabase.js';

const state = {
  provider: null,       // 'lumen' | null
  available: false,     // syncing is possible right now
  signedIn: false,
  plan: 'free',         // lumen: free | sync | cloud
  info: null,           // lumen: my_plan() result
  uid: null, me: null, db: null, status: 'offline', lastSync: 0,
};
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(state));
export const cloud = state;
export const onCloudChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

// Document ids allow only [A-Za-z0-9_-.~:@+]; photo keys contain spaces etc., so hash them.
export function docId(key) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return 'p' + h1.toString(36) + h2.toString(36);
}

// ------------------------------------------------------------------ providers

const toRow = (id, b) => ({
  user_id: state.uid, id, key: b.key, name: b.name, params: b.params, rating: b.rating, flag: b.flag, edited: b.edited,
  w: b.w, h: b.h, kind: b.kind, raw: b.raw, thumb: b.thumb, source: b.source || null, deleted: false, updated_at: new Date(b.updatedAt || Date.now()).toISOString(),
});
const fromRow = (r) => ({
  key: r.key, name: r.name, params: r.params, rating: r.rating, flag: r.flag, edited: r.edited, w: r.w, h: r.h, kind: r.kind, raw: r.raw,
  thumb: r.thumb, source: r.source || null, updatedAt: new Date(r.updated_at).getTime(), original: r.original_key ? { size: r.original_size, type: r.original_type } : null, id: r.id,
});

const albumRow = (a) => ({ user_id: state.uid, id: a.id, name: a.name, keys: a.keys, deleted: !!a.deleted, created_at: new Date(a.createdAt || Date.now()).toISOString(), updated_at: new Date(a.updatedAt || Date.now()).toISOString() });
const albumFromRow = (r) => ({ id: r.id, name: r.name, keys: r.keys || [], deleted: r.deleted, createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime() });

const lumenProvider = {
  async init() {
    state.provider = 'lumen';
    const u = sb.currentUser();
    if (!u) { Object.assign(state, { signedIn: false, available: false, plan: 'free', me: null, uid: null, status: 'offline' }); return false; }
    Object.assign(state, { signedIn: true, uid: u.id, me: { name: u.user_metadata?.name || u.email?.split('@')[0], email: u.email } });
    try {
      const prof = await sb.rest(`profiles?select=display_name&id=eq.${u.id}`);
      if (prof?.[0]?.display_name) state.me.name = prof[0].display_name;
    } catch { /* profile is optional */ }
    try {
      state.info = await sb.rpc('my_plan');
      state.plan = state.info?.plan || 'free';
    } catch (e) {
      console.warn('Could not load plan', e);
      state.plan = 'free';
    }
    state.available = isPaid(state.plan);
    state.status = state.available ? 'syncing' : 'offline';
    return state.available;
  },
  async pullAll() {
    const rows = await sb.rest(`photos?select=*&user_id=eq.${state.uid}`);
    this.since = rows.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime()), 0);
    return rows.filter((r) => !r.deleted).map(fromRow);
  },
  subscribe(onRemote) {
    const poll = async () => {
      if (!state.available || document.hidden) return;
      try {
        const rows = await sb.rest(`photos?select=*&user_id=eq.${state.uid}&updated_at=gt.${new Date(this.since || 0).toISOString()}`);
        for (const r of rows) {
          this.since = Math.max(this.since || 0, new Date(r.updated_at).getTime());
          onRemote(r.deleted ? 'removed' : 'modified', fromRow(r));
        }
        synced();
      } catch (e) { failed(e); }
    };
    const t = setInterval(poll, 45000);
    const vis = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  },
  async pullAlbums() {
    const rows = await sb.rest(`albums?select=*&user_id=eq.${state.uid}`);
    this.albumsSince = rows.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime()), 0);
    return rows.map(albumFromRow);
  },
  subscribeAlbums(onRemote) {
    const poll = async () => {
      if (!state.available || document.hidden) return;
      try {
        const rows = await sb.rest(`albums?select=*&user_id=eq.${state.uid}&updated_at=gt.${new Date(this.albumsSince || 0).toISOString()}`);
        for (const r of rows) { this.albumsSince = Math.max(this.albumsSince || 0, new Date(r.updated_at).getTime()); onRemote(albumFromRow(r)); }
      } catch (e) { failed(e); }
    };
    const t = setInterval(poll, 45000);
    return () => clearInterval(t);
  },
  writeAlbum: (a) => sb.rest('albums?on_conflict=user_id,id', { method: 'POST', body: albumRow(a), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }),
  async write(id, body) {
    if (body === null) {
      await sb.rest(`photos?user_id=eq.${state.uid}&id=eq.${id}`, { method: 'PATCH', body: { deleted: true, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=minimal' } });
    } else {
      await sb.rest('photos?on_conflict=user_id,id', { method: 'POST', body: toRow(id, body), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    }
  },
};

let P = null;
function synced() { state.status = 'synced'; state.lastSync = Date.now(); emit(); }
function failed(e) { console.warn('Sync failed', e); state.status = e?.status === 402 || e?.code === 'quota_exceeded' ? 'full' : 'error'; emit(); }

export async function initCloud() {
  P = backendConfigured() ? lumenProvider : null;
  if (P) { try { await P.init(); } catch (e) { console.warn('Sign-in check failed', e); } }
  emit();
  return state;
}
// Re-read the account after signing in/out or buying a plan.
export const refreshAccount = () => initCloud();

export async function pullAll() {
  if (!state.available) return [];
  try {
    const r = await P.pullAll();
    synced();
    return r;
  } catch (e) { failed(e); return []; }
}

export function subscribe(onRemote) {
  if (!state.available) return () => {};
  return P.subscribe(onRemote);
}

// One write at a time per document, coalesced.
const queue = new Map();
const busy = new Map();
async function flush(id) {
  if (busy.has(id)) return busy.get(id);
  const job = (async () => {
    while (queue.has(id)) {
      const body = queue.get(id);
      queue.delete(id);
      try {
        if (body?.__album) await P.writeAlbum(body.__album);
        else await P.write(id, body);
        synced();
      } catch (e) { failed(e); }
    }
  })().finally(() => busy.delete(id));
  busy.set(id, job);
  return job;
}
const timers = new Map();
function schedule(id, body) {
  queue.set(id, body);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => flush(id), 800));
}

// Nothing of a photo syncs until the on-device check (sync-check.js) clears it; photos it keeps on
// this device never sync unless the owner chooses to.
let gate = null;
export const setSyncGate = (g) => { gate = g; };
const pass = async (rec) => !gate || (await gate.check(rec)) === 'ok';

export function pushPhoto(rec, thumbDataUrl) {
  if (!state.available || !rec?.key) return;
  if (gate && !gate.cleared(rec)) { pass(rec).then((ok) => { if (ok) pushPhoto(rec, thumbDataUrl); }); return; }
  schedule(docId(rec.key), {
    key: rec.key, name: rec.name, rating: rec.rating || 0, flag: rec.flag || 0,
    edited: !!rec.edited, params: rec.params || null, updatedAt: rec.updatedAt || Date.now(),
    w: rec.w || 0, h: rec.h || 0, kind: rec.kind || '', raw: !!rec.raw,
    thumb: thumbDataUrl ?? rec.cloudThumb ?? null, source: rec.linked || null,
  });
}

export function pushAlbum(a) {
  if (!state.available || !P?.writeAlbum) return;
  schedule('album:' + a.id, { __album: { id: a.id, name: a.name, keys: a.keys, deleted: !!a.deleted, createdAt: a.createdAt, updatedAt: a.updatedAt } });
}
export async function pullAlbums() {
  if (!state.available || !P?.pullAlbums) return [];
  try { return await P.pullAlbums(); } catch (e) { failed(e); return []; }
}
export function subscribeAlbums(onRemote) {
  if (!state.available || !P?.subscribeAlbums) return () => {};
  return P.subscribeAlbums(onRemote);
}

export function deletePhoto(key) {
  if (!state.available || !key) return;
  schedule(docId(key), null);
  if (storesOriginals()) {
    sb.fn('storage', { op: 'delete', photoId: docId(key) }).catch(() => {});
  }
}

// ------------------------------------------------------------------ original files (Cloud plan)

export const storesOriginals = () => state.provider === 'lumen' && isPaid(state.plan);

// Uploads in flight, shown together on the progress card.
const ups = { job: null, started: 0, ended: 0 };
function trackUpload(p) {
  if (!ups.job) { ups.job = beginProgress('Uploading to Cloud'); ups.started = 0; ups.ended = 0; }
  ups.started++;
  ups.job.update(ups.ended, ups.started);
  return p.finally(() => {
    ups.ended++;
    if (ups.ended < ups.started) { ups.job.update(ups.ended, ups.started); return; }
    ups.job.finish(`${ups.ended} uploaded`);
    ups.job = null;
  });
}

// Resolves true when stored, false on failure, null when the photo is kept on this device.
export function uploadOriginal(rec, file) {
  if (!storesOriginals() || !rec?.key || !file) return Promise.resolve(false);
  return trackUpload(uploadOriginalNow(rec, file));
}
async function uploadOriginalNow(rec, file) {
  if (!(await pass(rec))) return null;
  const id = docId(rec.key);
  clearTimeout(timers.get(id));
  await flush(id); // the row must exist before the object is recorded
  try {
    const { url, type } = await sb.fn('storage', { op: 'put', photoId: id, size: file.size, type: file.type || 'application/octet-stream' });
    // The upload link only accepts this exact size and type.
    const r = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': type || file.type || 'application/octet-stream' } });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    // The upload lands in quarantine; the server moves it into place once it has passed its safety
    // check, which can take a few seconds for formats checked through the thumbnail.
    for (let i = 0; ; i++) {
      try { await sb.fn('storage', { op: 'commit', photoId: id }); return true; } catch (e) {
        if (e?.code !== 'checking' || i >= 8) throw e;
        await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
      }
    }
  } catch (e) {
    failed(e);
    return false;
  }
}

export async function fetchOriginal(rec) {
  if (state.provider !== 'lumen' || !state.signedIn || !rec?.key) return null;
  try {
    const { url } = await sb.fn('storage', { op: 'get', photoId: docId(rec.key) });
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return new File([blob], rec.name, { type: blob.type, lastModified: Number(rec.key.split(':').pop()) || Date.now() });
  } catch { return null; }
}
