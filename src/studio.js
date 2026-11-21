// The studio: Edit with words in the left panel, without the chat. As you type, the edit shows on
// the photo live (command.js); Enter makes it, and the studio lists what moved (each slider's row,
// where it was and where it went) with Undo. Everything here runs on this device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp } from './util.js';
import { HSL_NAMES } from './params.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Rows the studio knows how to show: path → [label, lo, hi, decimals].
const KNOWN = {
  exposure: ['Exposure', -5, 5, 2], contrast: ['Contrast'], highlights: ['Highlights'], shadows: ['Shadows'], whites: ['Whites'], blacks: ['Blacks'],
  temp: ['Temperature'], tint: ['Tint'], vibrance: ['Vibrance'], saturation: ['Saturation'], texture: ['Texture'], clarity: ['Clarity'],
  dehaze: ['Dehaze'], haze: ['Haze'], 'vignette.amount': ['Vignette'], 'grain.amount': ['Grain', 0, 100], 'sharpen.amount': ['Sharpen', 0, 150],
  'nr.luma': ['Noise reduction', 0, 100], 'nr.chroma': ['Color noise', 0, 100], 'nr.speckle': ['Color speckles', 0, 100], 'ai.enhance.amount': ['Enhance', 0, 100], 'ai.blur.amount': ['Lens blur', 0, 100],
  'ai.atmos.amount': ['Atmosphere', 0, 100], 'ai.rays.amount': ['Sunrays', 0, 100], 'ai.skin.amount': ['Skin', 0, 100], 'ai.refocus.amount': ['Refocus', 0, 100], 'ai.sky.warmth': ['Golden sky'],
};
const HSL_PART = { hue: 'hue', sat: 'saturation', lum: 'luminance' };
function describe(path) {
  const h = path.match(/^hsl\.(hue|sat|lum)\.(\d)$/);
  if (h) return [`${HSL_NAMES[+h[2]]} ${HSL_PART[h[1]]}`, -100, 100, 0];
  const k = KNOWN[path];
  return k && [k[0], k[1] ?? -100, k[2] ?? 100, k[3] ?? 0];
}

// Every leaf that differs between two settings: numbers that a row can show become steps, the rest
// (black & white, curves, colour grading, …) is set in one go first.
function diff(a, b, path = '', out = { steps: [], rest: [] }) {
  if (typeof b === 'number' && typeof a === 'number') {
    if (Math.abs(a - b) > 1e-6) {
      const d = describe(path);
      (d ? out.steps : out.rest).push({ path, from: a, to: b, d });
    }
  } else if (b && typeof b === 'object' && a && typeof a === 'object' && !(Array.isArray(b) && Array.isArray(b[0]))) {
    for (const k of Object.keys(b)) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.rest.push({ path, to: b });
  return out;
}
const fmt = (v, dp) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}`;

// Things to try, shown while the box is empty: clicking one types it in (and the photo previews it).
const TRY = ['warmer', 'shadows +25', 'golden hour', 'more contrast', 'black and white', 'straighten', 'paste from the last photo', 'blur the background'];

export function createStudio(app, { onTry } = {}) {
  const say = el('p', { class: 'studio-say' });
  const state = el('span', { class: 'studio-state' });
  const work = el('div', { class: 'studio-work' });
  const root = el('div', { class: 'studio' },
    el('div', { class: 'studio-name' }, el('span', {}, 'Edit with words'), state),
    say, work);

  // What it's doing, as a word beside the name ("Reading", "Done"). No portrait any more: typing
  // already shows the edit on the photo, live, so the box only reports and offers Undo.
  let current = 'idle';
  const mode = (m, label) => {
    current = m;
    root.dataset.mode = m;
    state.textContent = label || '';
  };

  // The line next to the portrait writes itself out.
  let sayJob = 0;
  function speak(text, cls = '') {
    const job = ++sayJob;
    say.className = `studio-say ${cls}`;
    if (reduced()) { say.textContent = text; return; }
    let n = 0;
    const tick = () => { if (job !== sayJob) return; say.textContent = text.slice(0, (n += 2)); if (n < text.length) requestAnimationFrame(tick); };
    tick();
  }

  // One row per slider that moves: its name, a track showing where it was and where it goes, the value.
  function row(st) {
    const [label, lo, hi, dp] = st.d;
    const pct = (v) => ((clamp(v, lo, hi) - lo) / (hi - lo)) * 100;
    const fill = el('i', { class: 'sw-fill' }), knob = el('b', { class: 'sw-knob' }), val = el('span', { class: 'sw-val' }, fmt(st.from, dp));
    const track = el('span', { class: 'sw-track' }, lo < 0 ? el('i', { class: 'sw-zero', style: `left:${pct(0)}%` }) : null,
      el('i', { class: 'sw-was', style: `left:${pct(st.from)}%` }), fill, knob);
    // The fill runs from the centre (or the start, for sliders that begin at 0) to the value.
    const set = (v) => {
      const a = lo < 0 ? Math.min(0, v) : lo, b = lo < 0 ? Math.max(0, v) : v;
      fill.style.left = `${pct(a)}%`; fill.style.width = `${pct(b) - pct(a)}%`;
      knob.style.left = `${pct(v)}%`;
      val.textContent = fmt(v, dp);
    };
    set(st.from);
    return { el: el('div', { class: 'sw-row' }, el('span', { class: 'sw-label' }, label), track, val), set };
  }

  // While a request is being read (by the language model, which can take a moment).
  function thinking(q) {
    finishing?.();
    work.replaceChildren();
    mode('think', 'Reading');
    speak(`“${q}”`, 'quote');
  }

  let job = 0, finishing = null;

  // Shows a change that was already made (a Look, Auto): rows at their new values, then settle.
  function record(q, said, was, now) {
    finishing?.();
    ++job;
    const { steps } = diff(was, now);
    work.replaceChildren(...steps.slice(0, 8).map((st) => { const r = row(st); r.set(st.to); r.el.classList.add('set'); return r.el; }));
    if (steps.length > 8) work.append(el('div', { class: 'sw-more' }, `and ${steps.length - 8} more`));
    speak(said);
    settle(q, steps.length);
  }

  function settle(q, n) {
    mode('done', n ? 'Done' : '');
    const undo = el('button', { class: 'studio-undo', type: 'button' }, 'Undo');
    undo.addEventListener('click', () => {
      app.undo();
      work.classList.add('undone');
      undo.remove();
      mode('idle', 'Undone');
    });
    if (n) work.append(undo);
    work.classList.remove('undone');
    setTimeout(() => { if (current === 'done') mode('idle', state.textContent); }, 2200);
  }

  // A new photo: a fresh greeting.
  function hello() {
    finishing?.();
    ++job;
    mode('idle', '');
    speak('What should this photo feel like?', 'ask');
    work.replaceChildren(el('div', { class: 'studio-try' }, el('span', { class: 'studio-try-head' }, 'Try'),
      ...TRY.map((t) => el('button', { class: 'studio-ex', type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => onTry?.(t) }, t))));
  }

  return { el: root, record, hello, thinking };
}
