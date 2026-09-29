// Albums: named collections of photos. An album lists photo keys (name:size:mtime), not local ids,
// so an album survives re-importing its photos. Stored in the catalog on this device.
import * as catalog from './catalog.js';
import { uid } from './util.js';

let albums = [];
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(albums));
export const onAlbumsChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const allAlbums = () => albums.filter((a) => !a.deleted).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
export const albumById = (id) => albums.find((a) => a.id === id && !a.deleted) || null;

export async function loadAlbums() {
  albums = await catalog.listAlbums();
  emit();
}

async function save(a) {
  a.updatedAt = Date.now();
  if (!albums.includes(a)) albums.push(a);
  await catalog.putAlbum(a);
  emit();
  return a;
}

export function createAlbum(name, keys = []) {
  const base = (name || '').trim() || 'Untitled Album';
  let n = base, i = 2;
  while (allAlbums().some((a) => a.name === n)) n = `${base} ${i++}`;
  return save({ id: uid(), name: n, keys: [...new Set(keys)], createdAt: Date.now(), updatedAt: Date.now() });
}
export function renameAlbum(id, name) {
  const a = albumById(id);
  if (!a || !name.trim()) return null;
  a.name = name.trim();
  return save(a);
}
export function deleteAlbum(id) {
  const a = albumById(id);
  if (!a) return null;
  // Keep a tombstone so the deletion syncs to other devices.
  a.deleted = true;
  a.keys = [];
  return save(a);
}
export function addToAlbum(id, keys) {
  const a = albumById(id);
  if (!a) return null;
  const before = a.keys.length;
  a.keys = [...new Set([...a.keys, ...keys])];
  return a.keys.length === before ? a : save(a);
}
export function removeFromAlbum(id, keys) {
  const a = albumById(id);
  if (!a) return null;
  const drop = new Set(keys);
  a.keys = a.keys.filter((k) => !drop.has(k));
  return save(a);
}
// Photos removed from the library leave every album.
export async function forgetKeys(keys) {
  const drop = new Set(keys);
  for (const a of allAlbums()) {
    if (a.keys.some((k) => drop.has(k))) { a.keys = a.keys.filter((k) => !drop.has(k)); await save(a); }
  }
}

// Remote album from another device.
export async function mergeRemoteAlbum(r) {
  if (!r?.id) return;
  const cur = albums.find((a) => a.id === r.id);
  if (cur && (cur.updatedAt || 0) >= (r.updatedAt || 0)) return;
  const a = { id: r.id, name: r.name, keys: r.keys || [], createdAt: r.createdAt || Date.now(), updatedAt: r.updatedAt || Date.now(), deleted: !!r.deleted };
  if (cur) Object.assign(cur, a); else albums.push(a);
  await catalog.putAlbum(cur || a);
  emit();
}
