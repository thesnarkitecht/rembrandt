// Composite editors: tone curve, HSL mixer, color grading wheels.
import { el, clamp, hsl2rgb, hslCss } from './util.js';
import { slider, segmented } from './ui.js';
import { curveFn } from '../engine/src/pipeline.js';
import { cssVar, cssRGB } from './theme.js';
import { HSL_NAMES, HSL_HUES } from './params.js';

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

// ------------------------------------------------------------------ tone curve

const CH_COLOR = { master: '#e9e9ee', r: '#ff5b5b', g: '#4fd67a', b: '#5b8cff' };
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

export function curveEditor(app) {
  let ch = 'master';
  const canvas = el('canvas', { class: 'curve-canvas' });
  const tabs = segmented(
    [{ value: 'master', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }],
    ch, (v) => { ch = v; draw(); }, 'seg-sm',
  );
  const hint = el('div', { class: 'hint' }, 'Click to add a point · drag off or double-click to remove');
  const root = el('div', { class: 'curve' }, tabs.el, el('div', { class: 'curve-box' }, canvas), hint);
  const PAD = 8;
  let drag = -1;
  let removing = false;

  const pts = () => app.params.curve[ch];
  const geom = () => {
    const r = canvas.getBoundingClientRect();
    return { r, w: r.width - PAD * 2, h: r.height - PAD * 2 };
  };
  const toXY = (e) => {
    const { r, w, h } = geom();
    return [(e.clientX - r.left - PAD) / w, 1 - (e.clientY - r.top - PAD) / h];
  };
  const hit = (x, y) => {
    const { w, h } = geom();
    let best = -1, bd = 12;
    pts().forEach(([px, py], i) => {
      const d = Math.hypot((px - x) * w, (py - y) * h);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = toXY(e);
    let i = hit(x, y);
    const P = pts();
    if (i < 0) {
      const cx = clamp(x, 0.01, 0.99);
      const f = curveFn(P);
      const cy = Math.abs(f(cx) - y) < 0.08 ? f(cx) : clamp(y, 0, 1);
      P.push([cx, cy]);
      P.sort((a, b) => a[0] - b[0]);
      i = P.findIndex((p) => p[0] === cx);
      app.requestRender();
    }
    drag = i;
    removing = false;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const P = pts();
    let [x, y] = toXY(e);
    const last = P.length - 1;
    const lo = drag === 0 ? 0 : P[drag - 1][0] + 0.01;
    const hi = drag === last ? 1 : P[drag + 1][0] - 0.01;
    removing = drag !== 0 && drag !== last && (y < -0.12 || y > 1.12 || x < lo - 0.1 || x > hi + 0.1);
    P[drag] = [clamp(x, lo, hi), clamp(y, 0, 1)];
    app.requestRender();
    draw();
  });
  const end = () => {
    if (drag < 0) return;
    if (removing) pts().splice(drag, 1);
    drag = -1;
    removing = false;
    app.requestRender();
    app.commit();
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = toXY(e);
    const i = hit(x, y);
    const P = pts();
    if (i > 0 && i < P.length - 1) {
      P.splice(i, 1);
      app.requestRender();
      app.commit();
      draw();
    }
  });

  function draw() {
    const cw = canvas.clientWidth, chh = canvas.clientHeight;
    if (!cw) return;
    const d = DPR();
    if (canvas.width !== Math.round(cw * d)) { canvas.width = Math.round(cw * d); canvas.height = Math.round(chh * d); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, cw, chh);
    CH_COLOR.master = hex(cssRGB('--text'));
    const grid = cssVar('--chart-grid');
    const w = cw - PAD * 2, h = chh - PAD * 2;
    const X = (x) => PAD + x * w, Y = (y) => PAD + (1 - y) * h;

    const hist = app.hist;
    if (hist) {
      const bins = ch === 'master' ? hist.l : hist[ch];
      let max = 1;
      for (let i = 2; i < 254; i++) max = Math.max(max, bins[i]);
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      for (let i = 0; i < 256; i++) ctx.lineTo(X(i / 255), Y(Math.min(1, Math.sqrt(bins[i] / max)) * 0.85));
      ctx.lineTo(X(1), Y(0));
      ctx.closePath();
      ctx.fillStyle = grid;
      ctx.fill();
    }
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(X(i / 4), Y(0)); ctx.lineTo(X(i / 4), Y(1)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(0), Y(i / 4)); ctx.lineTo(X(1), Y(i / 4)); ctx.stroke();
    }
    ctx.strokeStyle = cssVar('--line-strong');
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
    ctx.setLineDash([]);

    const curve = (key, style, width) => {
      const f = curveFn(app.params.curve[key]);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 128; i++) {
        const x = i / 128;
        i ? ctx.lineTo(X(x), Y(f(x))) : ctx.moveTo(X(x), Y(f(x)));
      }
      ctx.stroke();
    };
    for (const k of ['master', 'r', 'g', 'b']) if (k !== ch) curve(k, CH_COLOR[k] + '40', 1);
    curve(ch, CH_COLOR[ch], 1.6);
    pts().forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(X(x), Y(y), i === drag ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === drag && removing ? '#ff5b5b' : cssVar('--panel');
      ctx.fill();
      ctx.strokeStyle = CH_COLOR[ch];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  new ResizeObserver(() => draw()).observe(canvas);
  return { el: root, refresh: draw };
}

// ------------------------------------------------------------------ HSL mixer

export function hslMixer(app, reg) {
  let mode = 'hue';
  const list = el('div', { class: 'hsl-list' });
  let ctls = [];
  const tabs = segmented(
    [{ value: 'hue', label: 'Hue' }, { value: 'sat', label: 'Saturation' }, { value: 'lum', label: 'Luminance' }],
    mode, (v) => { mode = v; build(); }, 'seg-sm',
  );
  function track(i) {
    const h = HSL_HUES[i];
    if (mode === 'hue') return `linear-gradient(90deg, ${hslCss(h - 35, 80, 55)}, ${hslCss(h, 85, 55)}, ${hslCss(h + 35, 80, 55)})`;
    if (mode === 'sat') return `linear-gradient(90deg, hsl(${h} 0% 50%), ${hslCss(h, 95, 52)})`;
    return `linear-gradient(90deg, hsl(${h} 70% 12%), ${hslCss(h, 85, 52)}, hsl(${h} 70% 90%))`;
  }
  function build() {
    list.textContent = '';
    ctls = HSL_NAMES.map((name, i) => slider({
      label: name, min: -100, max: 100, step: 1, def: 0, track: track(i),
      get: () => app.params.hsl[mode][i],
      set: (v) => { app.params.hsl[mode][i] = v; app.requestRender(); },
      commit: () => app.commit(),
    }));
    ctls.forEach((c) => list.append(c.el));
  }
  build();
  const root = el('div', { class: 'hsl' }, tabs.el, list);
  reg.push({ refresh: () => ctls.forEach((c) => c.refresh()) });
  return root;
}

// ------------------------------------------------------------------ color grading

function wheelImage(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R;
      const r = Math.hypot(dx, dy) / R;
      const i = (y * size + x) * 4;
      if (r > 1) { img.data[i + 3] = 0; continue; }
      const h = (Math.atan2(-dy, dx) * 180) / Math.PI;
      const [cr, cg, cb] = hsl2rgb(h, 1, 0.5);
      const t = Math.pow(r, 0.9);
      const g = 0.32;
      img.data[i] = (g + (cr - g) * t * 0.85) * 255;
      img.data[i + 1] = (g + (cg - g) * t * 0.85) * 255;
      img.data[i + 2] = (g + (cb - g) * t * 0.85) * 255;
      img.data[i + 3] = r > 0.985 ? (1 - (r - 0.985) / 0.015) * 255 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function gradingControl(app, reg) {
  let zone = 'midtones';
  const tabs = segmented(
    [{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }, { value: 'global', label: 'Global' }],
    zone, (v) => { zone = v; refresh(); }, 'seg-sm',
  );
  const disc = wheelImage(256);
  disc.className = 'wheel-disc';
  const puck = el('div', { class: 'wheel-puck' });
  const wheel = el('div', { class: 'wheel', title: 'Drag to tint · double-click to reset' }, disc, puck);
  const z = () => app.params.grading[zone];

  const hue = slider({
    label: 'Hue', min: 0, max: 360, step: 1, def: 0, format: (v) => `${Math.round(v)}°`,
    track: 'linear-gradient(90deg,#ff4d4d,#ffd84a,#5fd35f,#3dd6d0,#4d7dff,#ff5bd1,#ff4d4d)',
    get: () => z().h, set: (v) => { z().h = v; app.requestRender(); placePuck(); }, commit: () => app.commit(),
  });
  const sat = slider({
    label: 'Saturation', min: 0, max: 100, step: 1, def: 0,
    get: () => z().s, set: (v) => { z().s = v; app.requestRender(); placePuck(); }, commit: () => app.commit(),
  });
  const lum = slider({
    label: 'Luminance', min: -100, max: 100, step: 1, def: 0,
    track: 'linear-gradient(90deg,#111,#888,#eee)',
    get: () => z().l, set: (v) => { z().l = v; app.requestRender(); }, commit: () => app.commit(),
  });
  const blend = slider({
    label: 'Blending', min: 0, max: 100, step: 1, def: 50,
    get: () => app.params.grading.blending, set: (v) => { app.params.grading.blending = v; app.requestRender(); }, commit: () => app.commit(),
  });
  const bal = slider({
    label: 'Balance', min: -100, max: 100, step: 1, def: 0,
    get: () => app.params.grading.balance, set: (v) => { app.params.grading.balance = v; app.requestRender(); }, commit: () => app.commit(),
  });

  function placePuck() {
    const { h, s } = z();
    const r = (s / 100) * 50;
    const a = (h * Math.PI) / 180;
    puck.style.left = `${50 + Math.cos(a) * r}%`;
    puck.style.top = `${50 - Math.sin(a) * r}%`;
    const [cr, cg, cb] = hsl2rgb(h, s / 100, 0.55);
    puck.style.background = `rgb(${cr * 255},${cg * 255},${cb * 255})`;
    sat.el.classList.add('tracked');
    sat.el.style.setProperty('--track', `linear-gradient(90deg, hsl(${h} 0% 45%), ${hslCss(h, 90, 55)})`);
  }

  const fromEvent = (e) => {
    const r = wheel.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let h = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (h < 0) h += 360;
    const s = clamp((Math.hypot(dx, dy) / (r.width / 2)) * 100, 0, 100);
    z().h = Math.round(h);
    z().s = Math.round(s);
    hue.refresh(); sat.refresh(); placePuck();
    app.requestRender();
  };
  let dragging = false;
  wheel.addEventListener('pointerdown', (e) => { dragging = true; wheel.setPointerCapture(e.pointerId); fromEvent(e); });
  wheel.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const up = () => { if (dragging) { dragging = false; app.commit(); } };
  wheel.addEventListener('pointerup', up);
  wheel.addEventListener('pointercancel', up);
  wheel.addEventListener('dblclick', () => { z().s = 0; refresh(); app.requestRender(); app.commit(); });

  function refresh() {
    tabs.set(zone);
    [hue, sat, lum, blend, bal].forEach((c) => c.refresh());
    placePuck();
  }
  refresh();
  reg.push({ refresh });
  return el('div', { class: 'grading' }, tabs.el, el('div', { class: 'wheel-wrap' }, wheel), hue.el, sat.el, lum.el, el('div', { class: 'divider' }), blend.el, bal.el);
}
