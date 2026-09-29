// Photo catalog persisted on this device (IndexedDB): photo records, original files and thumbnails.
// Original files are stored when the browser allows it; if storage is full the record is kept and the
// photo is marked "offline" until it is imported again.

const DB_NAME = 'lumen-catalog';
const VERSION = 2;
let dbp = null;
// id -> File for this session. Kept even after the original is stored: files picked this session
// are backed by the disk, so this costs no memory, and Safari sometimes can't read back a file it
// stored in IndexedDB (notably inside embedded pages).
const memFiles = new Map();

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
      if (!d.objectStoreNames.contains('albums')) d.createObjectStore('albums', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    console.warn('Catalog storage unavailable; photos stay in memory for this session.', e);
    return null;
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => {
    if (!d) return undefined;
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  });
}

export const photoKey = (file) => `${file.name}:${file.size}:${file.lastModified}`;

export async function listAlbums() {
  return (await tx('albums', 'readonly', (s) => s.getAll())) || [];
}
export const putAlbum = (a) => tx('albums', 'readwrite', (s) => s.put(a));
export const removeAlbum = (id) => tx('albums', 'readwrite', (s) => s.delete(id));

export async function listPhotos() {
  const all = (await tx('photos', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export async function putPhoto(rec) {
  await tx('photos', 'readwrite', (s) => s.put(rec));
}

export async function updatePhoto(id, patch) {
  const d = await db();
  if (!d) return;
  await new Promise((resolve, reject) => {
    const t = d.transaction('photos', 'readwrite');
    const s = t.objectStore('photos');
    const g = s.get(id);
    g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function storeFile(id, file) {
  memFiles.set(id, file);
  try {
    await tx('files', 'readwrite', (s) => s.put(file, id));
    return true;
  } catch (e) {
    console.warn('Could not store original (storage full?)', e);
    return false;
  }
}

export async function deleteFile(id) {
  memFiles.delete(id);
  await tx('files', 'readwrite', (s) => s.delete(id));
}

export async function getFile(id) {
  if (memFiles.has(id)) return memFiles.get(id);
  return (await tx('files', 'readonly', (s) => s.get(id))) || null;
}

export function rememberFile(id, file) {
  memFiles.set(id, file);
}

export async function putThumb(id, blob) {
  try { await tx('thumbs', 'readwrite', (s) => s.put(blob, id)); } catch { /* ignore */ }
}

export async function getThumb(id) {
  try { return (await tx('thumbs', 'readonly', (s) => s.get(id))) || null; } catch { return null; }
}

export async function removePhotos(ids) {
  for (const id of ids) memFiles.delete(id);
  const d = await db();
  if (!d) return;
  await new Promise((resolve, reject) => {
    const t = d.transaction(['photos', 'files', 'thumbs', 'albums'], 'readwrite');
    for (const id of ids) {
      t.objectStore('photos').delete(id);
      t.objectStore('files').delete(id);
      t.objectStore('thumbs').delete(id);
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function clearCatalog() {
  memFiles.clear();
  const d = await db();
  if (!d) return;
  await new Promise((resolve, reject) => {
    const t = d.transaction(['photos', 'files', 'thumbs', 'albums'], 'readwrite');
    for (const n of ['photos', 'files', 'thumbs', 'albums']) t.objectStore(n).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage || 0, quota: e.quota || 0, details: e.usageDetails || null } : null;
  } catch { return null; }
}

export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
