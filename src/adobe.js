// Adobe Lightroom (cloud) import through Adobe's Lightroom API.
//
// Sign-in uses Adobe IMS (OAuth 2 with PKCE, no client secret): a pop-up on the web, the system
// browser plus our app link on desktop. The catalog is read into the same shape as a Lightroom
// Classic catalog (see lrcat.js), so matching, albums and edits share one code path.
//
// Adobe's API doesn't let other apps download original files. What it offers is each photo's
// full-size rendition with Lightroom's edits applied, plus its develop settings, rating, flag and
// albums. So there are two ways in: download the edited photos, or keep a copy of the originals on
// disk with Lightroom (Preferences › Local Storage) and sync that folder here, with edits applied.
import { CONFIG } from './config.js';
import { parseXmp } from './xmp.js';

const IMS = 'https://ims-na1.adobelogin.com/ims';
const API = 'https://lr.adobe.io';
const SCOPES = 'openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis';
const TOKEN_KEY = 'lumen:adobe';

export const adobeReady = () => !!CONFIG.adobeClientId;

// ------------------------------------------------------------ sign-in
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const siteBase = () => (CONFIG.siteUrl || location.origin).replace(/\/$/, '');
const redirectUri = () => `${siteBase()}/auth-callback.html`;

let token = null;
function loadToken() {
  if (token) return token;
  try { token = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); } catch { token = null; }
  if (token && token.exp < Date.now() + 60e3) token = null;
  return token;
}
function saveToken(t) {
  token = t;
  try { t ? sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export const adobeSignedIn = () => !!loadToken();
export const adobeSignOut = () => saveToken(null);

let pending = null; // { verifier, state, resolve, reject }

async function exchange(code, verifier) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: CONFIG.adobeClientId, code, code_verifier: verifier });
  const r = await fetch(`${IMS}/token/v3`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'Adobe sign-in failed');
  const life = Number(j.expires_in) || 86400; // seconds (older IMS versions answer in milliseconds)
  saveToken({ access: j.access_token, exp: Date.now() + (life > 1e6 ? life : life * 1000) });
}

// Completes a sign-in whose code arrived through the desktop app link.
export async function completeAdobeSignIn(code, state) {
  if (!pending || pending.state !== state) throw new Error('This Adobe sign-in has expired. Try again.');
  const p = pending;
  pending = null;
  try { await exchange(code, p.verifier); p.resolve(); } catch (e) { p.reject(e); throw e; }
}

// Opens Adobe sign-in. Resolves when the account is connected.
export async function adobeSignIn(openExternal) {
  if (loadToken()) return;
  if (!adobeReady()) throw new Error('Lightroom import isn’t available yet');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = 'adobe.' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  const url = `${IMS}/authorize/v2?` + new URLSearchParams({
    client_id: CONFIG.adobeClientId, redirect_uri: redirectUri(), scope: SCOPES, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  const done = new Promise((resolve, reject) => { pending?.reject(new Error('Cancelled')); pending = { verifier, state, resolve, reject }; });
  if (window.__TAURI_INTERNALS__) {
    await openExternal(url); // the code comes back through the app link (see main.js)
    return done;
  }
  const win = window.open(url, 'adobe-signin', 'width=520,height=720');
  if (!win) { pending = null; throw new Error('Allow pop-ups for this site to connect Adobe'); }
  const onMsg = async (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'adobe-auth') return;
    window.removeEventListener('message', onMsg);
    clearInterval(watch);
    if (e.data.error || !e.data.code) { const p = pending; pending = null; p?.reject(new Error(e.data.error || 'Adobe sign-in was cancelled')); return; }
    completeAdobeSignIn(e.data.code, e.data.state).catch(() => {});
  };
  window.addEventListener('message', onMsg);
  const watch = setInterval(() => {
    if (win.closed && pending?.state === state) {
      clearInterval(watch);
      setTimeout(() => { if (pending?.state === state) { const p = pending; pending = null; window.removeEventListener('message', onMsg); p.reject(new Error('Adobe sign-in was closed')); } }, 800);
    }
  }, 500);
  return done;
}

// ------------------------------------------------------------ API
async function raw(path, { method = 'GET', headers = {} } = {}) {
  const t = loadToken();
  if (!t) throw new Error('Connect your Adobe account first');
  let r;
  try { r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${t.access}`, 'X-API-Key': CONFIG.adobeClientId, ...headers } }); } catch {
    throw new Error('Couldn’t reach Adobe Lightroom. If this keeps happening, export from Lightroom Classic instead (its catalog imports directly).');
  }
  if (r.status === 401) { saveToken(null); throw new Error('Your Adobe sign-in expired. Connect again.'); }
  return r;
}

// Lightroom's JSON responses start with `while (1) {}` to stop them being run as scripts.
async function getJson(path) {
  const r = await raw(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Adobe Lightroom: ${r.status}`);
  const text = await r.text();
  return JSON.parse(text.replace(/^\s*while\s*\(\s*1\s*\)\s*\{\s*\}\s*/, ''));
}

// Follows `links.next` through a paged listing.
async function* pages(path) {
  let next = path;
  while (next) {
    const j = await getJson(next);
    if (!j) return;
    yield j;
    const href = j.links?.next?.href;
    if (!href) return;
    const base = (j.base || '').replace(/^https?:\/\/[^/]+/, '');
    next = href.startsWith('/') ? href : base + href;
    if (!next.startsWith('/v2/')) return;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// Develop settings from an asset payload: Lightroom keeps them as Camera Raw ("crs") values.
function developOf(payload) {
  const d = payload?.develop;
  if (!d || typeof d !== 'object') return null;
  const crs = {};
  const put = (o) => { for (const [k, v] of Object.entries(o || {})) { const key = k.replace(/^crs:/, ''); if (/^[A-Z]/.test(key)) crs[key] = v; } };
  put(d.xmpCameraRaw || d.crs || d);
  return Object.keys(crs).some((k) => !/^(Version|ProcessVersion|CameraProfile|CameraProfileDigest)$/.test(k)) ? crs : null;
}
const ratingOf = (payload) => Math.max(0, ...Object.values(payload?.ratings || {}).map((r) => Number(r?.rating) || 0));
const flagOf = (payload) => {
  const f = Object.values(payload?.reviews || {}).map((r) => r?.flag);
  return f.includes('pick') ? 1 : f.includes('reject') ? -1 : 0;
};

// Reads the account's Lightroom catalog: { photos, collections, roots, catalogId, account }.
export async function readLightroomCloud(onProgress = () => {}) {
  onProgress('Connecting to Adobe Lightroom…');
  const account = await getJson('/v2/account');
  const cat = await getJson('/v2/catalog');
  if (!cat?.id) throw new Error('No Lightroom catalog found for this Adobe account');
  const cid = cat.id;

  const photos = new Map();
  for await (const page of pages(`/v2/catalogs/${cid}/assets?subtype=image&limit=500`)) {
    for (const a of page.resources || []) {
      const p = a.payload || {};
      const src = p.importSource || {};
      if (!src.fileName) continue;
      photos.set(a.id, {
        id: a.id,
        name: src.fileName,
        rel: src.fileName,
        path: src.fileName,
        size: src.fileSize || 0,
        w: src.originalWidth || 0,
        h: src.originalHeight || 0,
        captured: p.captureDate || null,
        rating: ratingOf(p),
        flag: flagOf(p),
        crs: developOf(p),
        xmpHref: a.links?.['/rels/xmp/develop'] && !String(a.links['/rels/xmp/develop'].invalid).includes('true') ? a.links['/rels/xmp/develop'].href : null,
        collections: [],
      });
    }
    onProgress(`Reading your Lightroom library: ${photos.size.toLocaleString()} photos…`);
  }

  // Albums (collections), and which photos are in each.
  const albums = [];
  for await (const page of pages(`/v2/catalogs/${cid}/albums?subtype=collection&limit=500`)) albums.push(...(page.resources || []));
  const collections = [];
  for (const [n, al] of albums.entries()) {
    const name = al.payload?.name || 'Untitled album';
    onProgress(`Reading albums: ${n + 1} of ${albums.length}…`);
    let any = false;
    for await (const page of pages(`/v2/catalogs/${cid}/albums/${al.id}/assets?limit=500`)) {
      for (const r of page.resources || []) {
        const ph = photos.get(r.asset?.id || r.id);
        if (ph) { ph.collections.push(name); any = true; }
      }
    }
    if (any) collections.push(name);
  }

  // Develop settings saved as XMP (used when the payload doesn't carry them).
  const needXmp = [...photos.values()].filter((p) => !p.crs && p.xmpHref);
  let done = 0;
  await pool(needXmp, 6, async (p) => {
    const r = await raw(`/v2/catalogs/${cid}/${p.xmpHref.replace(/^\//, '')}`).catch(() => null);
    if (r?.ok) p.crs = parseXmp(await r.text())?.crs || null;
    if (++done % 25 === 0) onProgress(`Reading edits: ${done} of ${needXmp.length}…`);
  });

  return {
    source: 'lightroom-cloud',
    catalogId: cid,
    account: { name: account?.full_name || account?.first_name || '', email: account?.email || '' },
    photos: [...photos.values()],
    collections,
    roots: [],
  };
}

// Downloads a photo as Lightroom renders it (full size, edits applied), as a JPEG File.
export async function downloadRendition(cat, p) {
  const path = `/v2/catalogs/${cat.catalogId}/assets/${p.id}/renditions`;
  let r = await raw(`${path}/fullsize`);
  if (r.status === 404) {
    // Full-size renditions are made on request; ask for one and wait for it.
    await raw(path, { method: 'POST', headers: { 'X-Generate-Renditions': 'fullsize' } }).catch(() => null);
    for (let i = 0; i < 10 && r.status === 404; i++) {
      await new Promise((ok) => setTimeout(ok, 1500 + i * 500));
      r = await raw(`${path}/fullsize`);
    }
    if (r.status === 404) r = await raw(`${path}/2560`);
  }
  if (!r.ok) throw new Error(`${p.name}: download failed (${r.status})`);
  const blob = await r.blob();
  const name = p.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: p.captured ? Date.parse(p.captured) || Date.now() : Date.now() });
}
