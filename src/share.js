// Share dialog: the system share sheet, copy to clipboard, and export.
import { el } from './util.js';
import { button, segmented, toggle } from './ui.js';
import { icon } from './icons.js';

const SHARE_LONG = 2048;

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
    el('div', { class: 'dlg-body' }, thumbs, others, status),
  );
  if (!dlg.open) dlg.showModal();
}
