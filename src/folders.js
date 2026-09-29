// Synced folders: photos stay where they are on disk (or in an iCloud Drive / Dropbox / OneDrive /
// Google Drive folder) and the library references them. New photos are picked up automatically and
// edits are written next to each photo as an XMP sidecar, so they travel with the files.
//
// Desktop apps use the native commands in src-tauri; when Rembrandt is served by rembrandt-server,
// folders are inside the server's photos folder; other browsers use the File System Access API
// (Chrome, Edge, Opera), and the rest can still import a folder once.
import { RAW_EXT } from './loader.js';
import { uid, el } from './util.js';
import { button } from './ui.js';
import { icon } from './icons.js';
import { CONFIG } from './config.js';

const tauri = () => window.__TAURI_INTERNALS__;
const invoke = (cmd, args) => tauri().invoke(cmd, args);
const PHOTO_RE = new RegExp(`\\.(jpe?g|png|webp|avif|heic|heif|tiff?|${[...RAW_EXT].join('|')})$`, 'i');
export const isPhotoName = (n) => PHOTO_RE.test(n) && !n.startsWith('.');

// rembrandt-server: same origin, authenticated by its cookie.
const onServer = () => !tauri() && CONFIG.serverUrl !== undefined;
const api = async (path, opts = {}) => {
  const r = await fetch(`${CONFIG.serverUrl}/api/${path}`, { credentials: 'same-origin', ...opts });
  if (!r.ok) throw Object.assign(new Error((await r.text().catch(() => '')) || `Server error ${r.status}`), { status: r.status });
  return r;
};
const q = (rel) => encodeURIComponent(rel || '');
const join = (a, b) => (a ? `${a}/${b}` : b);

export function support() {
  if (tauri()) return 'desktop';
  if (onServer()) return 'server';
  if (typeof window.showDirectoryPicker === 'function') return 'web';
  return null;
}

// ------------------------------------------------------------ persistence
let dbp = null;
function db() {
  dbp ||= new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('lumen-folders', 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('folders', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}
async function store(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve, reject) => {
    const t = d.transaction('folders', mode);
    const r = fn(t.objectStore('folders'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

let folders = [];
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(folders));
export const onFoldersChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const allFolders = () => folders;
export const folderById = (id) => folders.find((f) => f.id === id) || null;
const save = (f) => store('readwrite', (s) => s.put(strip(f)));
// Runtime-only fields are not stored.
const strip = ({ status, busy, progress, ...rest }) => rest;

export async function loadFolders() {
  const kind = tauri() ? 'desktop' : onServer() ? 'server' : 'web';
  folders = ((await store('readonly', (s) => s.getAll())) || []).filter((f) => f.kind === kind);
  if (kind === 'server') {
    for (const f of folders) f.status = (await api(`dirs?path=${q(f.path)}`).then(() => true, () => false)) ? 'ok' : 'missing';
  } else if (tauri()) {
    const ok = new Set(await invoke('restore_folders', { paths: folders.map((f) => f.path) }).catch(() => []));
    for (const f of folders) f.status = ok.has(f.path) ? 'ok' : 'missing';
  } else {
    for (const f of folders) f.status = (await permission(f, false)) ? 'ok' : 'locked';
  }
  emit();
  return folders;
}

async function permission(f, ask) {
  if (!f.handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  let st = await f.handle.queryPermission(opts).catch(() => 'denied');
  if (st === 'prompt' && ask) st = await f.handle.requestPermission(opts).catch(() => 'denied');
  return st === 'granted';
}

// Asks the browser for access again (must run from a click).
export async function reconnect(f) {
  if (f.kind === 'desktop' || f.kind === 'server') return f.status === 'ok';
  const ok = await permission(f, true);
  f.status = ok ? 'ok' : 'locked';
  emit();
  return ok;
}

// Lets the user choose a folder to keep in sync. Resolves to the folder, or null if cancelled.
export async function addFolder() {
  let f;
  if (onServer()) {
    const path = await pickServerFolder();
    if (path == null) return null;
    const existing = folders.find((x) => x.kind === 'server' && x.path === path);
    if (existing) return existing;
    f = { id: uid(), kind: 'server', path, name: path.split('/').filter(Boolean).pop() || (await api('dirs?path=').then((r) => r.json())).name || 'Photos' };
  } else if (tauri()) {
    const path = await invoke('pick_folder');
    if (!path) return null;
    const existing = folders.find((x) => x.path === path);
    if (existing) return existing;
    f = { id: uid(), kind: 'desktop', path, name: path.split(/[\\/]/).filter(Boolean).pop() || path };
  } else {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'sync-folder', mode: 'readwrite' }); } catch { return null; }
    for (const x of folders) if (x.handle && (await x.handle.isSameEntry(handle).catch(() => false))) return x;
    f = { id: uid(), kind: 'web', handle, name: handle.name };
  }
  Object.assign(f, { addedAt: Date.now(), sidecars: true, count: 0, lastScan: 0, status: 'ok' });
  folders.push(f);
  await save(f);
  emit();
  return f;
}

export async function removeFolder(id) {
  const f = folders.find((x) => x.id === id);
  if (f?.kind === 'desktop' && tauri()) await invoke('forget_folder', { path: f.path }).catch(() => {});
  folders = folders.filter((x) => x.id !== id);
  await store('readwrite', (s) => s.delete(id));
  emit();
}

export async function updateFolder(f, patch) {
  Object.assign(f, patch);
  await save(f);
  emit();
}

export function setBusy(f, busy, progress = '') {
  f.busy = busy;
  f.progress = progress;
  emit();
}

// ------------------------------------------------------------ scanning
// Lists photos in a folder: [{ rel, name, size, lastModified, sidecars: Map(lowercase name -> { rel, lastModified }) }].
export async function scan(f) {
  if (f.kind === 'server') {
    const list = await (await api(`photos?path=${q(f.path)}`)).json();
    return group(list.map((e) => ({ rel: e.rel, name: e.name, size: e.size, lastModified: e.modified, sidecar: e.sidecar })));
  }
  if (f.kind === 'desktop') {
    const list = await invoke('list_photos', { root: f.path });
    const sep = f.path.includes('\\') ? '\\' : '/';
    const relOf = (p) => p.slice(f.path.length).replace(/^[\\/]+/, '').split(sep).join('/');
    return group(list.map((e) => ({ rel: relOf(e.path), name: e.name, size: e.size, lastModified: e.modified, sidecar: e.sidecar })));
  }
  if (!(await permission(f, false))) { f.status = 'locked'; emit(); throw new Error(`Access to “${f.name}” needs to be allowed again`); }
  const out = [];
  const walk = async (dir, prefix, depth) => {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (depth < 12) await walk(h, `${prefix}${name}/`, depth + 1); continue; }
      const sidecar = /\.xmp$/i.test(name);
      if (!sidecar && !isPhotoName(name)) continue;
      const file = await h.getFile().catch(() => null);
      if (file) out.push({ rel: prefix + name, name, size: file.size, lastModified: file.lastModified, sidecar });
    }
  };
  await walk(f.handle, '', 0);
  return group(out);
}

function group(entries) {
  const side = new Map();
  for (const e of entries) if (e.sidecar) side.set(e.rel.toLowerCase(), e);
  return entries.filter((e) => !e.sidecar).map((e) => {
    const dir = e.rel.slice(0, e.rel.length - e.name.length);
    const sidecars = new Map();
    for (const [k, v] of side) if (k.startsWith(dir.toLowerCase()) && !k.slice(dir.length).includes('/')) sidecars.set(k.slice(dir.length), v);
    return { ...e, sidecars };
  });
}

// ------------------------------------------------------------ files
const abs = (f, rel) => f.path + (f.path.includes('\\') ? '\\' : '/') + rel.split('/').join(f.path.includes('\\') ? '\\' : '/');

async function dirHandle(f, relDir, create = false) {
  let d = f.handle;
  for (const part of relDir.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}
const splitRel = (rel) => { const i = rel.lastIndexOf('/'); return [i < 0 ? '' : rel.slice(0, i), rel.slice(i + 1)]; };

// The File for a photo in a synced folder (`src` = { folder, rel }), or null if it isn't reachable.
export async function fileFor(src, { ask = true } = {}) {
  const f = folderById(src?.folder);
  if (!f) return null;
  if (f.kind === 'server') {
    const blob = await api(`file?path=${q(join(f.path, src.rel))}`).then((r) => r.blob(), () => null);
    return blob ? new File([blob], splitRel(src.rel)[1], { type: blob.type, lastModified: src.lastModified || Date.now() }) : null;
  }
  if (f.kind === 'desktop') {
    const buf = await invoke('read_file', { path: abs(f, src.rel) }).catch(() => null);
    if (!buf) return null;
    return new File([buf], splitRel(src.rel)[1], { lastModified: src.lastModified || Date.now() });
  }
  if (!(await permission(f, ask))) { f.status = 'locked'; emit(); return null; }
  try {
    const [dir, name] = splitRel(src.rel);
    return await (await (await dirHandle(f, dir)).getFileHandle(name)).getFile();
  } catch { return null; }
}

export async function readText(folderId, rel) {
  const f = folderById(folderId);
  if (!f) return null;
  if (f.kind === 'server') return api(`file?path=${q(join(f.path, rel))}`).then((r) => r.text(), () => null);
  if (f.kind === 'desktop') return invoke('read_text', { path: abs(f, rel) }).catch(() => null);
  try {
    const [dir, name] = splitRel(rel);
    return await (await (await (await dirHandle(f, dir)).getFileHandle(name)).getFile()).text();
  } catch { return null; }
}

// Writes an XMP sidecar next to a photo. Returns the sidecar's modified time, or 0 if it couldn't be written.
export async function writeSidecar(src, sidecarName, text) {
  const f = folderById(src?.folder);
  if (!f || !f.sidecars || f.status !== 'ok') return 0;
  const [dir] = splitRel(src.rel);
  const rel = dir ? `${dir}/${sidecarName}` : sidecarName;
  try {
    if (f.kind === 'desktop') { await invoke('write_sidecar', { path: abs(f, rel), text }); return Date.now(); }
    if (f.kind === 'server') { await api(`sidecar?path=${q(join(f.path, rel))}`, { method: 'PUT', body: text, headers: { 'Content-Type': 'application/rdf+xml' } }); return Date.now(); }
    const h = await (await dirHandle(f, dir)).getFileHandle(sidecarName, { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    return (await h.getFile()).lastModified;
  } catch (e) {
    console.warn('sidecar write failed', e);
    return 0;
  }
}

// ------------------------------------------------------------ server folder picker
// Browses the photos folder rembrandt-server was started with. Resolves to a path relative to it
// ('' = the whole folder), or null if cancelled.
function pickServerFolder() {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'dlg folder-pick' });
    const list = el('div', { class: 'folder-list' });
    const crumbs = el('div', { class: 'folder-crumbs' });
    const info = el('p', { class: 'hint' });
    let cur = '';
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const use = button('Use this folder', () => done(cur), 'primary', 'check');
    async function show(path) {
      list.textContent = '';
      let d;
      try { d = await (await api(`dirs?path=${encodeURIComponent(path)}`)).json(); } catch (e) { info.textContent = e.message; return; }
      cur = d.path;
      crumbs.textContent = '';
      const parts = cur ? cur.split('/') : [];
      crumbs.append(el('button', { class: 'link-btn', type: 'button', onclick: () => show('') }, 'Photos'));
      parts.forEach((p, i) => crumbs.append(el('span', {}, ' / '), el('button', { class: 'link-btn', type: 'button', onclick: () => show(parts.slice(0, i + 1).join('/')) }, p)));
      for (const name of d.dirs) list.append(el('button', { class: 'folder-row', type: 'button', onclick: () => show(join(cur, name)) }, icon('folder'), el('span', {}, name), icon('chevron')));
      if (!d.dirs.length) list.append(el('p', { class: 'hint' }, 'No folders inside.'));
      info.textContent = `${d.photos} photo${d.photos === 1 ? '' : 's'} directly in this folder; photos in the folders inside it are included too.`;
    }
    dlg.append(
      el('div', { class: 'dlg-head row between' }, el('h2', {}, 'Choose a folder'), el('button', { class: 'icon-btn dlg-x', 'aria-label': 'Close', onclick: () => done(null) }, icon('x'))),
      el('div', { class: 'dlg-body' }, crumbs, list, info),
      el('div', { class: 'dlg-foot' }, button('Cancel', () => done(null), 'ghost'), use));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    show('');
  });
}
