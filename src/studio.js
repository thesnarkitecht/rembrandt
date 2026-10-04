// The studio: Edit with words, without the chat. A small Rembrandt, in dots, thinks over what you
// asked (the dots ripple), then makes the edits one at a time while you watch: each slider moves on
// the photo and in the panel, its row counts to the new value, and the portrait fills with colour as
// the work goes on. Then it settles back to grey, with Undo. Everything here runs on this device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp, clone, getPath, setPath } from './util.js';
import { HSL_NAMES } from './params.js';
import { loadArt } from './portrait-progress.js';

const COLS = 24, ROWS = 30;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Rows the studio knows how to show: path → [label, lo, hi, decimals].
const KNOWN = {
  exposure: ['Exposure', -5, 5, 2], contrast: ['Contrast'], highlights: ['Highlights'], shadows: ['Shadows'], whites: ['Whites'], blacks: ['Blacks'],
  temp: ['Temperature'], tint: ['Tint'], vibrance: ['Vibrance'], saturation: ['Saturation'], texture: ['Texture'], clarity: ['Clarity'],
  dehaze: ['Dehaze'], haze: ['Haze'], 'vignette.amount': ['Vignette'], 'grain.amount': ['Grain', 0, 100], 'sharpen.amount': ['Sharpen', 0, 150],
  'nr.luma': ['Noise reduction', 0, 100], 'nr.chroma': ['Color noise', 0, 100], 'ai.enhance.amount': ['Enhance', 0, 100], 'ai.blur.amount': ['Lens blur', 0, 100],
  'ai.atmos.amount': ['Atmosphere', 0, 100], 'ai.rays.amount': ['Sunrays', 0, 100], 'ai.skin.amount': ['Skin', 0, 100], 'ai.sky.warmth': ['Golden sky'],
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

export function createStudio(app) {
  const art = el('canvas', { class: 'studio-art', 'aria-hidden': 'true' });
  const say = el('p', { class: 'studio-say' });
  const state = el('span', { class: 'studio-state' });
  const work = el('div', { class: 'studio-work' });
  const ideas = el('div', { class: 'studio-ideas' });
  const past = el('div', { class: 'studio-past' });
  const root = el('div', { class: 'studio' },
    el('div', { class: 'studio-top' }, art, el('div', { class: 'studio-text' }, el('div', { class: 'studio-name' }, el('span', {}, 'Rembrandt'), state), say)),
    work, ideas, past);

  // ---- The portrait. mode: idle | think | paint | done; `p` is how far the painting has got.
  const P = { cells: null, mode: 'idle', p: 0, colour: 0, t0: 0, raf: 0 };
  loadArt(COLS, ROWS).then((cells) => { P.cells = cells; draw(); });
  function draw() {
    P.raf = 0;
    if (!P.cells || !art.isConnected) return;
    const d = Math.min(2, devicePixelRatio || 1), W = art.clientWidth, H = art.clientHeight;
    if (!W) return;
    if (art.width !== Math.round(W * d)) { art.width = Math.round(W * d); art.height = Math.round(H * d); }
    const x = art.getContext('2d');
    x.setTransform(d, 0, 0, d, 0, 0);
    x.clearRect(0, 0, W, H);
    const light = getComputedStyle(document.documentElement).colorScheme.trim() === 'light';
    const t = (performance.now() - P.t0) / 1000, cw = W / COLS, ch = H / ROWS;
    // Colour: follows the painting while it runs, holds when done, then drains back to grey.
    const target = P.mode === 'paint' ? P.p : P.mode === 'done' ? 1 : 0;
    P.colour += (target - P.colour) * (P.mode === 'idle' ? 0.05 : 0.18);
    let busy = P.mode !== 'idle' || P.colour > 0.01;
    for (const s of P.cells) {
      const k = clamp((P.colour * 1.25 - s.at) / 0.25, 0, 1);
      const v = light ? 1 - s.L : s.L;
      let r = 0.16 + v * 0.86;
      if (P.mode === 'think') {
        // Ripples out from the face, like a thought going round.
        const dist = Math.hypot(s.i - COLS * 0.5, (s.j - ROWS * 0.36) * 1.1);
        r *= 1 + 0.32 * Math.max(0, Math.sin(t * 7 - dist * 0.75));
      }
      if (k > 0 && k < 1) r += Math.sin(k * Math.PI) * 0.35;
      r = Math.min(cw, ch) * 0.5 * Math.min(1.15, r);
      if (r < 0.3) continue;
      const g = light ? Math.round(120 - v * 100) : Math.round(70 + v * 180);
      const c = (ch2) => Math.round(g + (Math.min(255, ch2 * (light ? 0.9 : 1.25)) - g) * k);
      x.fillStyle = `rgb(${c(s.r)},${c(s.g)},${c(s.b)})`;
      x.beginPath();
      x.arc((s.i + 0.5 + (s.j & 1 ? 0.25 : -0.25)) * cw, (s.j + 0.5) * ch, r, 0, Math.PI * 2);
      x.fill();
    }
    if (busy && !reduced()) P.raf = requestAnimationFrame(draw);
  }
  const mode = (m, label) => {
    P.mode = m;
    if (m === 'think') P.t0 = performance.now();
    root.dataset.mode = m;
    state.textContent = label || '';
    if (!P.raf) P.raf = requestAnimationFrame(draw);
  };
  new ResizeObserver(() => { if (!P.raf) P.raf = requestAnimationFrame(draw); }).observe(art);

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

  // Runs one request: think, then make each change in turn, then settle. `commit` stores it.
  let job = 0, finishing = null;
  async function perform(q, next, commit) {
    finishing?.();                       // a new request finishes the one still painting
    const id = ++job;
    const was = app.params;
    const { steps, rest } = diff(was, next);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; finishing = null;
      app.params = next;
      commit();
    };
    finishing = finish;
    ideas.hidden = true;
    work.replaceChildren();
    mode('think', 'Thinking');
    speak(`“${q}”`, 'quote');
    await sleep(520);
    if (id !== job) return;
    mode('paint', steps.length > 1 ? `Painting · ${steps.length} changes` : 'Painting');
    const rows = steps.map((st) => { const r = row(st); work.append(r.el); return r; });
    // What has no row (black & white, curves, grading) goes first, at once.
    let cur = clone(was);
    for (const r of rest) setPath(cur, r.path, clone(r.to));
    app.params = cur; app.requestRender(); app.refreshPanel();
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i], r = rows[i];
      r.el.classList.add('on');
      const dur = reduced() ? 0 : clamp(260 + Math.abs(st.to - st.from) / (st.d[2] - st.d[1]) * 900, 280, 620);
      const t0 = performance.now();
      await new Promise((res) => {
        const f = (now) => {
          if (id !== job || done) return res();
          const k = dur ? ease(clamp((now - t0) / dur, 0, 1)) : 1;
          const v = +(st.from + (st.to - st.from) * k).toFixed(st.d[3]);
          cur = clone(cur); setPath(cur, st.path, v);
          app.params = cur; app.requestRender(); app.refreshPanel();
          r.set(v);
          P.p = (i + k) / steps.length;
          if (k < 1) requestAnimationFrame(f); else res();
        };
        requestAnimationFrame(f);
      });
      if (id !== job || done) return;
      r.el.classList.remove('on'); r.el.classList.add('set');
    }
    if (id !== job) return;
    finish();
    settle(q, steps.length || rest.length);
  }

  // Shows a change that was already made (a Look, Auto): rows at their new values, then settle.
  function record(q, said, was, now) {
    finishing?.();
    ++job;
    ideas.hidden = true;
    const { steps } = diff(was, now);
    work.replaceChildren(...steps.slice(0, 8).map((st) => { const r = row(st); r.set(st.to); r.el.classList.add('set'); return r.el; }));
    if (steps.length > 8) work.append(el('div', { class: 'sw-more' }, `and ${steps.length - 8} more`));
    speak(said);
    mode('paint', 'Painting'); P.p = 1;
    settle(q, 1);
  }

  function settle(q, n) {
    mode('done', n ? 'Done' : 'Nothing to change');
    const undo = el('button', { class: 'studio-undo', type: 'button' }, 'Undo');
    undo.addEventListener('click', () => {
      app.undo();
      work.classList.add('undone');
      undo.remove();
      mode('idle', 'Undone');
    });
    work.append(undo);
    work.classList.remove('undone');
    const item = el('button', { class: 'studio-q', type: 'button', title: 'Ask again' }, q);
    item.addEventListener('click', () => root.dispatchEvent(new CustomEvent('ask', { detail: q })));
    past.prepend(item);
    while (past.children.length > 4) past.lastChild.remove();
    setTimeout(() => { if (P.mode === 'done') mode('idle', state.textContent); }, 2200);
  }

  // A new photo: a greeting, and ideas read from it.
  function hello(list, pick) {
    finishing?.();
    ++job;
    work.replaceChildren();
    past.replaceChildren();
    mode('idle', '');
    speak('What should this photo feel like?', 'ask');
    ideas.hidden = false;
    ideas.replaceChildren(...list.map((t) => {
      const b = el('button', { class: 'chat-idea', type: 'button' }, t);
      b.addEventListener('click', () => pick(t));
      return b;
    }));
  }

  return { el: root, perform, record, hello, get greeting() { return !ideas.hidden; } };
}
