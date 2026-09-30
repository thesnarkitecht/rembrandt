// Share dialog: public links (rendered JPEGs uploaded to the account's storage), the system share
// sheet, copy to clipboard and export.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { button, segmented, toggle } from './ui.js';
import { icon } from './icons.js';
import { CONFIG, backendConfigured } from './config.js';
import * as sb from './backend/supabase.js';

const SHARE_LONG = 2048;

export async function createShareLink({ title, blobs, expiresDays, allowDownload, names }) {
  const r = await sb.fn('share', { op: 'create', title, count: blobs.length, sizes: blobs.map((b) => b.size), expiresDays, allowDownload, names });
  await Promise.all(r.uploads.map((u, i) => fetch(u, { method: 'PUT', body: blobs[i], headers: { 'Content-Type': 'image/jpeg' } }).then((x) => { if (!x.ok) throw new Error(`Upload failed (${x.status})`); })));
  await sb.fn('share', { op: 'finalize', token: r.token });
  return { token: r.token, url: `${(CONFIG.siteUrl || location.origin).replace(/\/$/, '')}/share.html#${r.token}` };
}

export function openShare(app, ids, { title, render, exportPhotos, signIn }) {
  const dlg = document.getElementById('shareDialog');
  const photos = app.images.filter((e) => ids.includes(e.id));
  const n = photos.length;
  dlg.textContent = '';
  if (!n) return;
  const name = title || (n === 1 ? photos[0].name.replace(/\.[^.]+$/, '') : `${n} photos`);
  const status = el('div', { class: 'export-status' });
  const setStatus = (t, cls = '') => { status.textContent = t; status.className = 'export-status ' + cls; };

  const renderAll = async () => {
    const blobs = [];
    for (let i = 0; i < photos.length; i++) {
      setStatus(`Preparing ${i + 1} of ${n}…`, 'busy');
      blobs.push(await render(photos[i].id, { format: 'jpeg', quality: 88, long: SHARE_LONG }));
    }
    return blobs;
  };

  // ---- link
  const signedIn = !!sb.currentUser();
  let expires = 30, allowDownload = true;
  const linkBox = el('div', { class: 'share-opt' });
  const paintLink = (url) => {
    linkBox.textContent = '';
    linkBox.append(el('div', { class: 'share-opt-head' }, icon('link'), el('div', {}, el('b', {}, 'Share link'), el('span', {}, 'Anyone with the link can view.'))));
    if (!backendConfigured()) {
      linkBox.append(el('p', { class: 'hint' }, 'Links need an online account, available in the full app.'));
      return;
    }
    if (!signedIn) {
      linkBox.append(el('div', { class: 'row-btns' }, button('Turn on Cloud sync to create a link', () => { dlg.close(); signIn(); }, 'sm')));
      return;
    }
    if (url) {
      const field = el('input', { class: 'text-input mono', value: url, readonly: true, id: 'shareUrl' });
      field.addEventListener('focus', () => field.select());
      const copy = button('Copy', async () => {
        try { await navigator.clipboard.writeText(url); copy.lastChild.textContent = 'Copied'; } catch { field.focus(); field.select(); }
      }, 'sm primary', 'copy');
      linkBox.append(el('div', { class: 'row' }, field, copy), el('p', { class: 'hint' }, expires ? `Expires in ${expires} days. Manage links in Account → Sharing.` : 'Never expires. Manage links in Account → Sharing.'));
      return;
    }
    const exp = segmented([{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 0, label: 'No expiry' }], expires, (v) => { expires = v; });
    const dl = toggle('Allow downloads', () => allowDownload, (v) => { allowDownload = v; });
    const make = button('Create link', async () => {
      make.disabled = true;
      try {
        const blobs = await renderAll();
        setStatus('Uploading…', 'busy');
        const r = await createShareLink({ title: name, blobs, expiresDays: expires, allowDownload, names: photos.map((p) => p.name) });
        setStatus('');
        paintLink(r.url);
      } catch (e) { setStatus(e.message, 'error'); make.disabled = false; }
    }, 'sm primary', 'link');
    linkBox.append(exp.el, dl.el, el('div', { class: 'row-btns' }, make));
  };
  paintLink(null);

  // ---- system share / copy / export
  const others = el('div', { class: 'share-list' });
  const canShareFiles = !!navigator.canShare && (() => { try { return navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; } })();
  const row = (ic, label, sub, onClick) => el('button', { class: 'share-row', onclick: onClick }, icon(ic), el('span', {}, el('b', {}, label), el('span', {}, sub)));
  if (canShareFiles) {
    others.append(row('share', 'Send…', 'Messages, Mail, AirDrop and other apps', async () => {
      try {
        const blobs = await renderAll();
        setStatus('');
        await navigator.share({ files: blobs.map((b, i) => new File([b], photos[i].name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })), title: name });
      } catch (e) { if (e.name !== 'AbortError') setStatus(e.message, 'error'); else setStatus(''); }
    }));
  }
  if (n === 1 && window.ClipboardItem) {
    others.append(row('copy', 'Copy image', 'Paste it into a message or document', async () => {
      try {
        setStatus('Preparing…', 'busy');
        const png = await render(photos[0].id, { format: 'png', quality: 100, long: SHARE_LONG });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        setStatus('Copied to the clipboard');
      } catch (e) { setStatus(`Couldn't copy: ${e.message}`, 'error'); }
    }));
  }
  others.append(row('download', 'Export files…', 'JPEG, PNG or WebP at any size', () => { dlg.close(); exportPhotos(ids); }));

  const thumbs = el('div', { class: 'share-thumbs' }, photos.slice(0, 6).map((p) => (p.thumbUrl ? el('img', { src: p.thumbUrl, alt: '' }) : el('span', { class: 'thumb-ph' }))),
    n > 6 ? el('span', { class: 'share-more' }, `+${n - 6}`) : null);
  dlg.append(
    el('div', { class: 'dlg-head row between' }, el('h2', {}, `Share ${name}`), el('button', { class: 'icon-btn dlg-x', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    el('div', { class: 'dlg-body' }, thumbs, linkBox, others, status),
  );
  if (!dlg.open) dlg.showModal();
}
