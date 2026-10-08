// Export dialog and full-resolution rendering to JPEG / PNG / WebP.
import { isMobileApp } from './platform.js';
import { canSave, countSave, askToUnlock, isUnlocked, freeSavesLeft } from './unlock.js';
import { el, clamp } from './util.js';
import { segmented, slider, popMenu } from './ui.js';
import { withRecipe, recipeOf } from './recipe.js';
import { withMetadata } from './exif.js';
import { prefs } from './account.js';
import { beforeAfterPage } from './beforeafter.js';
import { recordReplay, replaySupported } from './replay.js';
import { icon } from './icons.js';
import { DESTINATIONS, destination, deliver } from './export-dest.js';

const FORMATS = { jpeg: ['image/jpeg', '.jpg'], png: ['image/png', '.png'], webp: ['image/webp', '.webp'] };
const SIZES = [
  { value: 0, label: 'Full' }, { value: 3840, label: '3840' }, { value: 2048, label: '2048' }, { value: 1080, label: '1080' },
];
const OPTS_KEY = 'lumen:export';
const opts = (() => {
  const d = { format: 'jpeg', quality: 92, long: 0, suffix: '-edit', dest: 'device', recipe: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; }
})();
export const exportDefaults = opts;
export function saveExportDefaults() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
}
export const FORMAT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp' };

const doneMessage = (d, n) => {
  const what = `${n} photo${n === 1 ? '' : 's'}`;
  if (d.id === 'device') return isMobileApp ? `Saved ${what} to Photos` : `Exported ${what}`;
  if (d.id === 'folder') return `Saved ${what} to the folder`;
  if (d.id === 'photos') return isMobileApp ? `Shared ${what}` : window.__TAURI_INTERNALS__ ? `Added ${what} to Photos` : `Shared ${what}`;
  return `Uploaded ${what} to ${d.name}`;
};

function resizeCanvas(src, w, h) {
  let cur = src;
  while (cur.width / 2 >= w * 1.2) {
    const t = el('canvas', { width: Math.round(cur.width / 2), height: Math.round(cur.height / 2) });
    const c = t.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, t.width, t.height);
    cur = t;
  }
  const out = el('canvas', { width: w, height: h });
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

// The edited photo at full resolution (`long`: at most this many pixels on its long edge), as ImageData.
export async function renderPixels(app, { long = 0 } = {}, p = app.params, mats = (pp, w, h) => app.outputMats(pp, w, h)) {
  const { crop } = p.geometry;
  const E = app.engine;
  const nativeW = Math.round(crop.w * E.fullH), nativeH = Math.round(crop.h * E.fullH);
  const k = long ? Math.min(1, long / Math.max(nativeW, nativeH)) : 1;
  const outW = Math.max(1, Math.round(nativeW * k)), outH = Math.max(1, Math.round(nativeH * k));
  const res = await E.exportPixels(p, crop.w, crop.h, outH, (w, h) => mats(p, w, h));
  return { image: new ImageData(new Uint8ClampedArray(res.pixels.buffer), res.w, res.h), outW, outH };
}

// Renders `p` (default: the photo being edited) with the engine's current image.
export async function renderExport(app, { format, quality, long, recipe, meta }, p = app.params, mats = (pp, w, h) => app.outputMats(pp, w, h)) {
  const { image, outW, outH } = await renderPixels(app, { long }, p, mats);
  let canvas = el('canvas', { width: image.width, height: image.height });
  canvas.getContext('2d').putImageData(image, 0, 0);
  if (image.width !== outW || image.height !== outH) canvas = resizeCanvas(canvas, outW, outH);
  const [mime] = FORMATS[format];
  let blob = await new Promise((r) => canvas.toBlob(r, mime, clamp(quality, 1, 100) / 100));
  if (!blob) throw new Error('The browser could not encode this format.');
  // Camera details, your name and copyright, and the sRGB profile (Settings › Export), then the recipe.
  const by = { artist: (prefs.artist || '').trim(), copyright: (prefs.copyright || '').trim() };
  blob = await withMetadata(blob, { meta: meta === undefined ? app.images?.[app.cur]?.meta : meta, ...by, exif: prefs.exportExif !== false, w: canvas.width, h: canvas.height });
  if (recipe) blob = await withRecipe(blob, recipeOf(p), canvas.width, canvas.height);
  return { blob, w: canvas.width, h: canvas.height };
}

// Export dialog. With `ids` (library selection) it exports several photos; `renderPhoto(id, opts)`
// renders one of them and resolves {blob, name}. One file is saved directly, several go into a ZIP.
export function openExport(app, ids = null, renderPhoto = null) {
  const batch = ids && ids.length > 0 && renderPhoto;
  if (!batch && !app.img) return;
  const dlg = document.getElementById('exportDialog');
  dlg.textContent = '';
  const n = batch ? ids.length : 1;
  const base = batch ? '' : app.img.name.replace(/\.[^.]+$/, '');
  const name = el('input', { class: 'text-input', value: batch ? opts.suffix : `${base}${opts.suffix}`, spellcheck: 'false' });
  const dims = el('div', { class: 'export-dims' });
  const E = app.engine;
  const custom = el('input', { class: 'text-input narrow', type: 'number', min: 64, max: 20000, placeholder: 'px' });

  function update() {
    if (batch) dims.textContent = opts.long ? `Long edge up to ${opts.long} px` : 'Full resolution';
    else {
      const { crop } = app.params.geometry;
      const nativeW = Math.round(crop.w * E.fullH), nativeH = Math.round(crop.h * E.fullH);
      const k = opts.long ? Math.min(1, opts.long / Math.max(nativeW, nativeH)) : 1;
      dims.textContent = `${Math.round(nativeW * k)} × ${Math.round(nativeH * k)} px`;
    }
    const special = opts.format === 'compare' || opts.format === 'replay';
    // A chip names a choice made in the ⋯ menu, so it's never hidden state.
    chip.textContent = [SPECIAL[opts.format], opts.recipe && opts.format !== 'replay' ? 'with recipe' : ''].filter(Boolean).join(' · ');
    chip.hidden = !chip.textContent;
    q.el.style.display = opts.format === 'png' || special ? 'none' : '';
    size.el.closest('.field').style.display = opts.format === 'replay' ? 'none' : '';
    if (opts.format === 'compare') dims.textContent = 'A web page with the original and the edit, and a slider between them. Opens in any browser; nothing to upload.';
    if (opts.format === 'replay') dims.textContent = 'A short video of the photo developing, one step of the edit at a time, each named on screen. It plays as it records, so keep this window open.';
  }
  if ((batch || (opts.format === 'replay' && !replaySupported())) && !FORMAT_EXT[opts.format]) opts.format = 'jpeg';
  const fmt = segmented([{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }], opts.format, (v) => { opts.format = v; update(); });
  // Less common outputs and the recipe option sit behind one ⋯ so the dialog stays short.
  const SPECIAL = { compare: 'Before/after page', replay: 'Replay video' };
  const extras = el('button', { class: 'icon-btn sm', type: 'button', title: 'More formats and options', 'aria-label': 'More formats and options' }, icon('more'));
  extras.addEventListener('click', () => popMenu(extras, [
    ...(batch ? [] : [
      { label: 'Before/after page (HTML)', checked: opts.format === 'compare', onClick: () => { opts.format = 'compare'; fmt.set(null); update(); } },
      replaySupported() ? { label: 'Replay video', checked: opts.format === 'replay', onClick: () => { opts.format = 'replay'; fmt.set(null); update(); } } : null,
      { sep: true },
    ]),
    { label: 'Include how it was edited', checked: !!opts.recipe, onClick: () => { opts.recipe = !opts.recipe; update(); } },
  ]));
  const chip = el('span', { class: 'export-chip' });
  const size = segmented(SIZES, SIZES.some((s) => s.value === opts.long) ? opts.long : -1, (v) => { opts.long = v; custom.value = ''; update(); });
  if (!SIZES.some((s) => s.value === opts.long)) custom.value = opts.long;
  custom.addEventListener('input', () => { const v = parseInt(custom.value, 10); if (v >= 64) { opts.long = v; size.set(-1); update(); } });
  custom.addEventListener('keydown', (e) => e.stopPropagation());
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const q = slider({ label: 'Quality', min: 40, max: 100, def: 92, get: () => opts.quality, set: (v) => { opts.quality = v; } });

  // Where the photos go.
  if (!destination(opts.dest).ready()) opts.dest = 'device';
  const destBtn = el('button', { class: 'btn dest-btn', type: 'button' });
  const destHint = el('div', { class: 'hint' });
  const paintDest = () => {
    const d = destination(opts.dest);
    destBtn.replaceChildren(icon(d.icon), el('span', {}, d.name), icon('chevron', 'i chev'));
    destHint.textContent = d.hint || (d.id === 'device' ? (batch && n > 1 ? 'Photos are rendered at full quality one by one and saved together as a ZIP file.' : (prefs.exportExif !== false ? 'Full resolution, with the camera details, your name and copyright (Settings › Export) and an sRGB colour profile. Location is never included.' : 'Full resolution, with an sRGB colour profile. Camera details are off (Settings › Export).')) : `Each photo is uploaded to ${d.name}${['dropbox', 'onedrive', 'gdrive'].includes(d.id) ? ' in a “Rembrandt” folder' : ''}.`);
    go.textContent = d.id === 'device' ? (batch ? `Export ${n}` : 'Export') : d.id === 'folder' ? 'Choose folder & save' : `Send to ${d.name.replace(/ \(.*\)$/, '')}`;
  };
  destBtn.addEventListener('click', () => popMenu(destBtn, DESTINATIONS.map((d) => ({
    label: d.ready() ? d.name : `${d.name} · available at launch`,
    icon: d.icon,
    checked: undefined,
    onClick: () => {
      if (!d.ready()) { status.textContent = `${d.name} isn’t set up yet${window.__TAURI_INTERNALS__ && ['gphotos', 'gdrive', 'dropbox', 'onedrive'].includes(d.id) ? '. In the desktop app, save into its folder on this computer instead.' : '.'}`; status.className = 'export-status'; return; }
      opts.dest = d.id; saveExportDefaults(); paintDest();
    },
  }))));

  const status = el('div', { class: 'export-status' });
  const bar = el('div', { class: 'progress', hidden: true }, el('span'));
  const go = el('button', { class: 'btn primary', type: 'button' }, batch ? `Export ${n}` : 'Export');
  let cancelled = false;
  const cancel = el('button', { class: 'btn ghost', type: 'button', onclick: () => { cancelled = true; dlg.close(); } }, 'Cancel');
  go.addEventListener('click', async () => {
    // Phone app: saving needs the one-time unlock after the free saves are used.
    if (!canSave(n) && !(await askToUnlock(app))) return;
    go.disabled = true;
    cancelled = false;
    status.className = 'export-status busy';
    saveExportDefaults();
    try {
      await new Promise((r) => setTimeout(r, 30));
      const ext = FORMAT_EXT[opts.format];
      const progress = (t) => { status.textContent = t; };
      if (!batch && opts.format === 'replay') {
        const { blob, ext: vext } = await recordReplay(app, { onProgress: (t) => { status.textContent = t; } });
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + '-replay' + vext, blob }], progress);
        app.toast(d.id === 'device' && !isMobileApp ? `Saved the replay · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else if (!batch && opts.format === 'compare') {
        status.textContent = 'Rendering before and after…';
        const blob = await beforeAfterPage(app, { title: name.value.trim() || base, recipe: opts.recipe, long: Math.min(opts.long || 2560, 2560) });
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + '-before-after.html', blob }], progress);
        app.toast(d.id === 'device' && !isMobileApp ? `Saved a before/after page · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else if (!batch) {
        status.textContent = 'Rendering at full resolution…';
        const { blob, w, h } = await renderExport(app, opts);
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + ext, blob }], progress);
        countSave();
        app.toast(d.id === 'device' && !isMobileApp ? `Exported ${w} × ${h} · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else {
        opts.suffix = name.value;
        saveExportDefaults();
        bar.hidden = false;
        const files = [];
        for (let i = 0; i < ids.length; i++) {
          if (cancelled) return;
          status.textContent = `Rendering ${i + 1} of ${ids.length}…`;
          bar.firstChild.style.width = `${(i / ids.length) * 100}%`;
          const r = await renderPhoto(ids[i], opts);
          if (r) files.push({ name: r.base + opts.suffix + ext, blob: r.blob });
        }
        bar.firstChild.style.width = '100%';
        if (!files.length) throw new Error('Nothing could be exported (originals missing?)');
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, files, progress);
        app.toast(doneMessage(d, files.length));
      }
      dlg.close();
    } catch (err) {
      if (err?.code === 'declined') {
        status.textContent = 'Save cancelled.';
        status.className = 'export-status';
        return;
      }
      console.error(err);
      status.textContent = `Export failed: ${err.message}`;
      status.className = 'export-status error';
    } finally {
      go.disabled = false;
      app.requestRender();
    }
  });

  dlg.append(
    el('div', { class: 'dlg-head' }, el('h2', {}, batch ? `Export ${n} photo${n > 1 ? 's' : ''}` : 'Export photo')),
    el('div', { class: 'dlg-body' },
      el('label', { class: 'field' }, el('span', {}, batch ? 'Add to file names' : 'File name'), name),
      el('div', { class: 'field' }, el('span', {}, 'Format'), el('div', { class: 'row' }, fmt.el, chip, extras)),
      q.el,
      el('div', { class: 'field' }, el('span', {}, 'Long edge'), el('div', { class: 'row' }, size.el, custom)),
      dims,
      el('div', { class: 'field' }, el('span', {}, 'Save to'), destBtn),
      destHint,
      bar,
      status,
    ),
    el('div', { class: 'dlg-foot' }, cancel, go),
  );
  update();
  paintDest();
  if (isMobileApp && !isUnlocked()) {
    const left = freeSavesLeft();
    status.textContent = left ? `${left} free save${left === 1 ? '' : 's'} left. Unlock Rembrandt once for unlimited saving.` : 'Saving and sharing need the one-time unlock.';
  }
  dlg.showModal();
}
