// Super Resolution section of the AI panel: enlarge 2× / 4×, or restore a soft photo at its own size,
// with a before/after preview of a detail and a new photo as the result.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, debounce } from '../util.js';
import { slider, section, segmented, button } from '../ui.js';
import { upscale, gpuLabel } from './upscale.js';

const KEY = 'rembrandt:sr';
const prefs = (() => {
  const d = { scale: 2, noise: 50 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return d; }
})();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

export function buildSRSection(app) {
  const sec = section('Super Resolution', { id: 'ai-sr', open: false, badge: { icon: 'enlarge' } });

  // Size of the edited photo, from the crop, without rendering it.
  const size = () => {
    const E = app.engine, c = app.params?.geometry?.crop;
    if (!E?.fullH || !c) return null;
    return { w: Math.round(c.w * E.fullH), h: Math.round(c.h * E.fullH) };
  };
  const allowed = (s) => {
    const z = size();
    return !!z && Math.max(z.w, z.h) * s <= 16384 && z.w * z.h * s * s <= app.srLimit();
  };

  const scale = segmented([
    { value: 1, label: 'Restore', title: 'Same size: sharper, cleaner detail on soft or slightly out-of-focus photos' },
    { value: 2, label: '2×' }, { value: 4, label: '4×' },
  ], prefs.scale, (v) => { prefs.scale = v; save(); paint(); schedulePreview(); }, 'seg-sm');
  const dims = el('div', { class: 'sr-dims' });
  const noise = slider({
    label: 'Noise removal', min: 0, max: 100, def: 50, get: () => prefs.noise,
    set: (v) => { prefs.noise = v; }, commit: () => { save(); schedulePreview(); },
  });

  // Before/after of a detail at the centre: drag across it to compare.
  const before = el('canvas', { class: 'sr-before' }), after = el('canvas', { class: 'sr-after' });
  const handle = el('div', { class: 'sr-handle' });
  const tagB = el('span', { class: 'sr-tag l' }, 'Before'), tagA = el('span', { class: 'sr-tag r' }, 'After');
  const stage = el('div', { class: 'sr-stage' }, after, before, handle, tagB, tagA);
  const shade = el('div', { class: 'sr-shade' });
  const view = el('div', { class: 'sr-view empty' }, stage, shade);
  let split = 0.5;
  const setSplit = (x) => { split = Math.min(1, Math.max(0, x)); view.style.setProperty('--split', `${split * 100}%`); };
  setSplit(0.5);
  const drag = (ev) => { const r = stage.getBoundingClientRect(); setSplit((ev.clientX - r.left) / r.width); };
  stage.addEventListener('pointerdown', (ev) => { stage.setPointerCapture(ev.pointerId); drag(ev); });
  stage.addEventListener('pointermove', (ev) => { if (stage.hasPointerCapture(ev.pointerId)) drag(ev); });
  const previewBtn = button('Preview detail', () => runPreview(), 'sm ghost', 'sparkle');
  shade.append(previewBtn);

  let previewOn = false, previewJob = 0, previewOf = null;
  async function runPreview() {
    previewOn = true;
    previewOf = app.images[app.cur]?.id;
    const job = ++previewJob;
    view.classList.remove('empty');
    view.classList.add('busy');
    shade.textContent = 'Rendering the detail…';
    try {
      const img = await app.srSource();
      if (job !== previewJob) return;
      const s = prefs.scale;
      // A crop that comes out about 384 px wide.
      const n = Math.max(48, Math.min(img.width, img.height, Math.round(384 / Math.max(1, s))));
      const x0 = Math.max(0, Math.round(img.width / 2 - n / 2)), y0 = Math.max(0, Math.round(img.height / 2 - n / 2));
      const crop = new ImageData(n, n);
      for (let y = 0; y < n; y++) crop.data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + n) * 4), y * n * 4);
      shade.textContent = 'Enhancing on the GPU…';
      const t0 = performance.now();
      const out = await upscale(crop, { scale: s, denoise: prefs.noise / 100 });
      if (job !== previewJob) return;
      const W = out.width;
      for (const c of [before, after]) { c.width = W; c.height = W; }
      after.getContext('2d').putImageData(out, 0, 0);
      // "Before" is the same detail enlarged the ordinary way.
      const tmp = el('canvas', { width: n, height: n });
      tmp.getContext('2d').putImageData(crop, 0, 0);
      const bx = before.getContext('2d');
      bx.imageSmoothingQuality = 'high';
      bx.drawImage(tmp, 0, 0, W, W);
      view.classList.remove('busy');
      shade.textContent = '';
      const ms = performance.now() - t0;
      timing.textContent = `Preview in ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}`;
    } catch (err) {
      if (job !== previewJob) return;
      console.warn(err);
      view.classList.remove('busy');
      view.classList.add('empty');
      shade.replaceChildren(el('span', {}, err.message || 'Preview failed'), previewBtn);
    }
  }
  const schedulePreview = debounce(() => { if (previewOn) runPreview(); }, 250);

  const timing = el('div', { class: 'sr-gpu' });
  const gpu = el('div', { class: 'sr-gpu' });
  gpuLabel().then((t) => { gpu.textContent = t ? `Runs on this device · ${t}` : 'This device has no GPU support for Super Resolution'; });

  const go = button('Create enhanced copy', async () => {
    try {
      await app.superResolution({ scale: prefs.scale, denoise: prefs.noise / 100 });
      app.toast('Added to background work: it pauses while you edit, and the copy appears in the library');
    } catch (err) { app.toast(err?.message || 'Super Resolution failed'); }
  }, 'primary sr-go', 'enlarge');

  function paint() {
    scale.set(prefs.scale);
    const z = size();
    [1, 2, 4].forEach((s, i) => { scale.el.children[i].disabled = !allowed(s); });
    if (!allowed(prefs.scale)) { const s = [4, 2, 1].find(allowed); if (s) { prefs.scale = s; scale.set(s); } }
    dims.textContent = z ? `${z.w} × ${z.h}  →  ${z.w * prefs.scale} × ${z.h * prefs.scale} px` : '';
    go.disabled = !allowed(prefs.scale);
  }
  paint();

  sec.body.append(
    el('p', { class: 'ai-lede' }, 'Real detail at a larger size, or a soft photo restored at its own.'),
    scale.el, dims, noise.el, view, el('div', { class: 'sr-actions' }, go), timing, gpu,
  );
  return {
    el: sec.el,
    refresh() {
      noise.refresh(); paint();
      // A different photo or edit: the old preview no longer applies.
      if (previewOn && previewOf !== app.images[app.cur]?.id) {
        previewOn = false; previewJob++;
        view.classList.remove('busy'); view.classList.add('empty'); shade.replaceChildren(previewBtn); timing.textContent = '';
      }
    },
  };
}

// AI Denoise: one slider and one button; the result is a new DNG beside the original (denoise.js).
export function buildDenoiseSection(app) {
  const sec = section('AI Denoise', { id: 'ai-denoise', open: false, badge: { icon: 'sparkle' } });
  const strength = slider({ label: 'Strength', min: 0, max: 100, def: 50, get: () => prefs.dn ?? 50, set: (v) => { prefs.dn = v; }, commit: save });
  const go = button('Create denoised copy', () => {
    try {
      app.denoise({ strength: denoiseStrength() });
      app.toast('Added to background work: it pauses while you edit, and the DNG appears in the library');
    } catch (err) { app.toast(err?.message || 'AI Denoise failed'); }
  }, 'primary sr-go', 'sparkle');
  sec.body.append(
    el('p', { class: 'ai-lede' }, 'Clean, detailed high-ISO shots. Makes a new DNG beside the original with the same edits; best on RAW.'),
    strength.el, el('div', { class: 'sr-actions' }, go));
  return { el: sec.el, refresh() { strength.refresh(); } };
}

// The Strength last chosen in the AI Denoise section (also used for batches from the library).
export const denoiseStrength = () => (prefs.dn ?? 50) / 100;
