// Copy and paste edits between photos, like Lightroom's Copy/Paste Settings: choose which parts
// of the edit to copy, then paste onto one photo or hundreds. Crop and masks are off by default
// because they usually belong to one photo. The copied edit survives a reload.
import { el, clone, getPath, setPath, nextVersion } from './util.js';
import { button } from './ui.js';
import { icon } from './icons.js';
import { defaultParams, GROUPS } from './params.js';
import { fitCrop } from './geometry.js';

export const PARTS = [
  ['light', 'Light'], ['color', 'Color'], ['effects', 'Effects'], ['curve', 'Curve'],
  ['mixer', 'Color Mixer'], ['grading', 'Color Grading'], ['detail', 'Detail'],
  ['refocus', 'AI Refocus'], ['lens', 'AI Lens Blur'], ['background', 'AI Background'],
  ['crop', 'Crop & rotation'], ['masks', 'Masks'],
];
const DEFAULT_OFF = new Set(['crop', 'masks', 'background']);
const KEY = 'lumen:copy';
const PARTS_KEY = 'lumen:copy-parts';

let clip = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } })();
export const clipboard = () => clip;

export function rememberedParts() {
  try { const p = JSON.parse(localStorage.getItem(PARTS_KEY) || 'null'); if (Array.isArray(p) && p.length) return p; } catch { /* ignore */ }
  return PARTS.map(([k]) => k).filter((k) => !DEFAULT_OFF.has(k));
}

const pathsOf = (part) => (part === 'crop' ? ['geometry'] : GROUPS[part] || []);

// Copies the chosen parts of an edit.
export function copyEdits(params, parts, from = '', srcAspect = null) {
  clip = takeEdits(params, parts, from, srcAspect);
  try { localStorage.setItem(KEY, JSON.stringify(clip)); localStorage.setItem(PARTS_KEY, JSON.stringify(parts)); } catch { /* too big to keep across reloads */ }
  return clip;
}
// The chosen parts of an edit, ready for pasteEdits, without touching the clipboard.
export function takeEdits(params, parts, from = '', srcAspect = null) {
  const settings = {};
  for (const part of parts) for (const path of pathsOf(part)) setPath(settings, path, clone(getPath(params, path)));
  // A focus point and a background picture belong to one photo.
  if (settings.ai?.blur) settings.ai.blur.focus = -1;
  if (settings.ai?.bg?.mode === 'image') settings.ai.bg = { ...settings.ai.bg, mode: 'none', image: null };
  const off = {};
  for (const part of parts) if (params.off?.[part]) off[part] = true;
  return { parts: [...parts], settings, off, from, srcAspect, at: Date.now() };
}

// The photo's edit with the copied parts pasted in. `aspect` is the photo's width / height.
export function pasteEdits(params, c, aspect) {
  const next = params ? clone(params) : defaultParams(aspect);
  next.off = { ...(next.off || {}) };
  for (const part of c.parts) {
    if (part === 'crop') { next.geometry = fitGeometry(c.settings.geometry, aspect, c.srcAspect); continue; }
    for (const path of pathsOf(part)) {
      const v = getPath(c.settings, path);
      if (v !== undefined) setPath(next, path, clone(v));
    }
    if (part === 'masks') for (const m of next.masks || []) if (m.brush) m.brush = { ...m.brush, v: nextVersion() };
    if (c.off?.[part]) next.off[part] = true; else delete next.off[part];
  }
  return next;
}

// A crop copied from a photo with another shape keeps its ratio, position and rotation.
function fitGeometry(g, aspect, fromAspect) {
  const out = clone(g);
  if (fromAspect && Math.abs(fromAspect - aspect) > 1e-3) {
    const k = aspect / fromAspect;
    out.crop = { cx: g.crop.cx * k, cy: g.crop.cy, w: g.crop.w, h: g.crop.h };
  }
  out.crop = fitCrop(out.crop, aspect, out);
  return out;
}

// "Choose what to copy" dialog. Resolves to the chosen parts, or null if cancelled.
export function chooseParts(title = 'Copy edits') {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'dlg copy-dlg' });
    const chosen = new Set(rememberedParts());
    const boxes = PARTS.map(([k, label]) => {
      const input = el('input', { type: 'checkbox', checked: chosen.has(k) });
      input.addEventListener('change', () => { input.checked ? chosen.add(k) : chosen.delete(k); go.disabled = !chosen.size; });
      return { k, input, row: el('label', { class: 'copy-part' }, input, el('span', {}, label)) };
    });
    const setAll = (on) => { for (const b of boxes) { b.input.checked = on; on ? chosen.add(b.k) : chosen.delete(b.k); } go.disabled = !chosen.size; };
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const go = button('Copy', () => done(PARTS.map(([k]) => k).filter((k) => chosen.has(k))), 'primary', 'copy');
    dlg.append(
      el('div', { class: 'dlg-head row between' }, el('h2', {}, title), el('button', { class: 'icon-btn dlg-x', 'aria-label': 'Close', onclick: () => done(null) }, icon('x'))),
      el('div', { class: 'dlg-body' },
        el('p', { class: 'hint' }, 'Choose which parts of the edit to copy. You can paste them onto any number of photos.'),
        el('div', { class: 'copy-grid' }, boxes.map((b) => b.row)),
        el('div', { class: 'row-btns' }, button('All', () => setAll(true), 'sm ghost'), button('None', () => setAll(false), 'sm ghost'))),
      el('div', { class: 'dlg-foot' }, button('Cancel', () => done(null), 'ghost'), go));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Short description of what's on the clipboard, e.g. "Light, Color and 3 more from IMG_2041".
export function describeClip(c = clip) {
  if (!c) return '';
  const names = c.parts.map((k) => PARTS.find(([p]) => p === k)?.[1]).filter(Boolean);
  const what = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${what}${c.from ? ` from ${c.from}` : ''}`;
}
