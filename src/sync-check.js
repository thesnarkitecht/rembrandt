// On-device check before Cloud sync.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Each photo is checked on this device before anything of it (thumbnail, edits or original) is synced.
// Photos that look sexually explicit stay on this device ("On this device only") unless the owner
// chooses to sync them anyway, after a warning. The check is a convenience and a first line, not the
// enforcement: Cloud checks everything it receives against known child sexual abuse images on the
// server, whatever the client does.
import * as catalog from './catalog.js';
import { el } from './util.js';

const LIMIT = 0.6;   // porn + hentai score at or above this keeps a photo here
export const flagged = (s) => (s.porn || 0) + (s.hentai || 0) >= LIMIT;

// Cleared to sync without waiting.
export const cleared = (e) => !!e && (e.syncAnyway || (!e.localOnly && e.screen === 'ok'));
export const localOnly = (e) => !!e?.localOnly && !e.syncAnyway;

let worker = null, seq = 0;
const waiting = new Map();
function classify(bitmap) {
  if (!worker) {
    worker = new Worker(new URL('./screen-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); data.error ? w?.reject(new Error(data.error)) : w?.resolve(data.scores); };
    worker.onerror = (ev) => { for (const w of waiting.values()) w.reject(new Error(ev.message || 'Image check failed')); waiting.clear(); worker = null; };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, bitmap }, [bitmap]);
  });
}

// Is this rendered image sexually explicit? Throws if the check can't run.
export async function explicitBlob(blob) {
  return flagged(await classify(await createImageBitmap(blob)));
}

async function source(e) {
  try { if (e.thumbUrl) return await createImageBitmap(await (await fetch(e.thumbUrl)).blob()); } catch { /* try the stored copy */ }
  const b = await catalog.getThumb(e.id);
  return b ? createImageBitmap(b) : null;
}

const listeners = new Set();
export const onFlagged = (f) => { listeners.add(f); return () => listeners.delete(f); };

// One photo at a time, one check per photo. Resolves 'ok', 'local' or 'later' (couldn't check yet;
// nothing is synced until it can).
const jobs = new Map();
let chain = Promise.resolve();
export function check(e) {
  if (!e) return Promise.resolve('later');
  if (cleared(e)) return Promise.resolve('ok');
  if (e.localOnly) return Promise.resolve('local');
  // A photo with no original here came from Cloud and was checked there.
  if (e.offline && !e.stored) return Promise.resolve('ok');
  if (jobs.has(e.id)) return jobs.get(e.id);
  const job = chain = chain.then(async () => {
    const bitmap = await source(e);
    if (!bitmap) return 'later';
    const scores = await classify(bitmap);
    const patch = flagged(scores) ? { screen: 'flag', localOnly: true } : { screen: 'ok' };
    Object.assign(e, patch);
    await catalog.updatePhoto(e.id, patch).catch(() => {});
    if (patch.localOnly) listeners.forEach((f) => f(e));
    return patch.localOnly ? 'local' : 'ok';
  }).catch((err) => { console.warn('Image check failed', err); return 'later'; });
  jobs.set(e.id, job);
  job.then((r) => { if (r === 'later') jobs.delete(e.id); });
  return job;
}

// Keep photos on this device only, or let them sync after all.
export async function keepLocal(list) {
  for (const e of list) {
    Object.assign(e, { localOnly: true, syncAnyway: false });
    await catalog.updatePhoto(e.id, { localOnly: true, syncAnyway: false }).catch(() => {});
  }
}
export async function allowSync(list) {
  for (const e of list) {
    Object.assign(e, { localOnly: false, syncAnyway: true });
    await catalog.updatePhoto(e.id, { localOnly: false, syncAnyway: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ warnings

const WARNING = 'Every photo synced to Rembrandt Cloud is checked against known child sexual abuse images. '
  + 'A match is reported to the National Center for Missing & Exploited Children immediately, and the account is frozen.';

function ask({ title, text, ok, cancel, danger }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'dlg confirm-sync' });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const go = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => done(true) }, ok);
    dlg.append(
      el('div', { class: 'dlg-head' }, el('h2', {}, title)),
      el('div', { class: 'dlg-body' }, ...text.map((t) => el('p', { class: 'hint' }, t))),
      el('div', { class: 'dlg-foot' }, cancel ? el('button', { class: 'btn ghost', type: 'button', onclick: () => done(false) }, cancel) : '', go),
    );
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); if (cancel) done(false); });
    if (cancel) dlg.addEventListener('click', (ev) => { if (ev.target === dlg) done(false); });
    document.body.append(dlg);
    dlg.showModal();
    go.focus();
  });
}

// Shown once per account on each device before anything syncs.
const ackKey = (uid) => `rembrandt:sync-warning:${uid}`;
export async function acknowledgeSync(uid) {
  try { if (localStorage.getItem(ackKey(uid))) return; } catch { /* ask again */ }
  await ask({
    title: 'Before you sync',
    text: [WARNING, 'Photos that look sexually explicit stay on this device, under On this device only. You can still choose to sync them.'],
    ok: 'I understand',
  });
  try { localStorage.setItem(ackKey(uid), String(Date.now())); } catch { /* ignore */ }
}

export function confirmSyncAnyway(n) {
  return ask({
    title: n === 1 ? 'Sync this photo anyway?' : `Sync ${n} photos anyway?`,
    text: [
      `This device flagged ${n === 1 ? 'it' : 'them'} as explicit, so ${n === 1 ? 'it has' : 'they have'} stayed here.`,
      WARNING,
      'Only sync photos that are legal and that you have the right to store.',
    ],
    ok: 'Sync anyway', cancel: 'Cancel', danger: true,
  });
}
