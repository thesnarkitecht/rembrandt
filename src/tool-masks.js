// Masking tool: mask list, components (add / subtract / intersect), local adjustments and
// on-canvas handles for gradients, the brush, and color / luminance range picking.
import { el, svgEl, clamp, nextVersion, linearToOklab, clone, uid } from './util.js';
import { slider, section, segmented, toggle, iconButton, button, popMenu, disclosure } from './ui.js';
import { icon } from './icons.js';
import { A } from './geometry.js';
import { newMask, newComponent, maskAdjDefaults, COMP_LABELS } from './params.js';
import { brushCanvas, brushAppend, brushForget } from './brush.js';

const TYPES = ['brush', 'linear', 'radial', 'color', 'luminance', 'all'];
const AI_TYPES = ['subject', 'background', 'object', 'depth'];
const SHORT = { brush: 'Brush', linear: 'Linear', radial: 'Radial', color: 'Color', luminance: 'Tone', all: 'Everything', subject: 'Subject', background: 'Background', object: 'Object', depth: 'Depth' };
const compLabel = (c) => (c.type === 'subject' && c.invert ? 'Background' : COMP_LABELS[c.type]);
const compIcon = (c) => (c.type === 'subject' && c.invert ? 'background' : c.type);
const MODE_ICON = { add: 'plus', subtract: 'minus', intersect: 'intersect' };
const MASK_COLORS = ['#ff5d73', '#5b8cff', '#ffb547', '#3fd08f', '#b57bff', '#3dd6d0', '#ff7ad9', '#c8d45a'];

export const brushRadius = (size) => 0.004 + Math.pow(size / 100, 1.5) * 0.35;

export function activeMask(app) {
  return app.params.masks.find((m) => m.id === app.state.activeMaskId) || null;
}
export function activeComp(app) {
  const m = activeMask(app);
  return m ? m.comps[Math.min(app.state.activeComp, m.comps.length - 1)] || null : null;
}

export function addMask(app, type) {
  const m = newMask(type, app.img.aspect, app.params.masks.length + 1);
  app.params.masks.push(m);
  app.state.activeMaskId = m.id;
  app.state.activeComp = 0;
  app.state.showOverlay = true;
  app.commit();
  app.rebuildPanel();
  app.requestRender();
  if (type === 'color') app.toast('Click the photo to pick a color');
  if (type === 'luminance') app.toast('Adjust the range, or click the photo to sample a tone');
  if (type === 'brush') app.toast('Paint on the photo · hold Alt to erase · [ ] to resize');
  if (type === 'object') app.toast('Click the object you want to select');
  if (AI_TYPES.includes(type)) app.aiEnsure();
}

function addComp(app, m, type, mode) {
  if (type === 'brush') {
    const i = m.comps.findIndex((c) => c.type === 'brush');
    if (i >= 0) { app.state.activeComp = i; app.rebuildPanel(); return; }
  }
  m.comps.push(newComponent(type, app.img.aspect, mode));
  app.state.activeComp = m.comps.length - 1;
  if (AI_TYPES.includes(type)) app.aiEnsure();
  app.commit();
  app.rebuildPanel();
  app.requestRender();
}

function removeComp(app, m, i) {
  if (m.comps.length <= 1) return removeMask(app, m);
  if (m.comps[i].type === 'brush') { m.brush.strokes = []; m.brush.v = nextVersion(); }
  m.comps.splice(i, 1);
  app.state.activeComp = Math.max(0, Math.min(app.state.activeComp, m.comps.length - 1));
  app.commit();
  app.rebuildPanel();
  app.requestRender();
}

export function removeMask(app, m) {
  const i = app.params.masks.indexOf(m);
  if (i < 0) return;
  app.params.masks.splice(i, 1);
  brushForget(m.id);
  const next = app.params.masks[Math.min(i, app.params.masks.length - 1)];
  app.state.activeMaskId = next ? next.id : null;
  app.state.activeComp = 0;
  app.commit();
  app.rebuildPanel();
  app.requestRender();
}

function duplicateMask(app, m) {
  const d = clone(m);
  d.id = uid();
  d.name = `${m.name} copy`;
  d.comps.forEach((c) => { c.id = uid(); });
  d.brush.v = nextVersion();
  app.params.masks.push(d);
  app.state.activeMaskId = d.id;
  app.commit();
  app.rebuildPanel();
  app.requestRender();
}

export function buildMaskPanel(app) {
  const root = el('div', { class: 'panel-view' });
  let reg = [];

  function rebuild() {
    root.textContent = '';
    reg = [];
    const masks = app.params.masks;

    // ---- create
    const newMenu = (e) => popMenu(e.currentTarget, [
      { head: 'Found by AI' }, ...AI_TYPES.map((t) => ({ label: COMP_LABELS[t], icon: t, onClick: () => addMask(app, t) })),
      { sep: true }, { head: 'Draw or select' }, ...TYPES.map((t) => ({ label: COMP_LABELS[t], icon: t, onClick: () => addMask(app, t) })),
    ]);
    const create = section('Masks', {
      id: 'masks', badge: { icon: 'mask' }, enabled: { get: () => !app.params.off?.masks, set: (v) => app.setGroupOn('masks', v) },
      right: masks.length ? iconButton('plus', 'New mask', (e) => { e.stopPropagation(); newMenu(e); }, 'sm') : null,
    });
    if (!masks.length) {
      // One grid: AI selections first (marked), then the manual shapes.
      const tile = (t, ai) => el('button', { class: 'tile' + (ai ? ' ai' : ''), title: ai ? `${COMP_LABELS[t]} — found by AI on this device` : COMP_LABELS[t], onclick: () => addMask(app, t) }, icon(t), el('span', {}, SHORT[t]));
      create.body.append(el('div', { class: 'tile-grid' }, AI_TYPES.map((t) => tile(t, true)), TYPES.filter((t) => t !== 'all').map((t) => tile(t, false)), tile('all', false)));
    }

    if (masks.length) {
      const list = el('div', { class: 'mask-list' });
      masks.forEach((m, i) => {
        const on = m.id === app.state.activeMaskId;
        const name = el('span', { class: 'mask-name', title: 'Double-click to rename' }, m.name);
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const input = el('input', { class: 'rename', value: m.name });
          name.replaceWith(input);
          input.focus();
          input.select();
          const done = () => { m.name = input.value.trim() || m.name; app.commit(); rebuild(); };
          input.addEventListener('blur', done);
          input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = m.name; input.blur(); } });
        });
        const row = el('div', { class: 'mask-row' + (on ? ' on' : '') + (m.visible === false ? ' hidden' : '') },
          el('span', { class: 'mask-dot', style: { background: MASK_COLORS[i % MASK_COLORS.length] } }),
          icon(m.comps[0] ? compIcon(m.comps[0]) : 'all', 'i mask-type'),
          name,
          el('span', { class: 'grow' }),
          iconButton(m.visible === false ? 'eyeOff' : 'eye', m.visible === false ? 'Show mask' : 'Hide mask', (e) => {
            e.stopPropagation(); m.visible = m.visible === false; app.commit(); rebuild(); app.requestRender();
          }, 'sm'),
          iconButton('duplicate', 'Duplicate', (e) => { e.stopPropagation(); duplicateMask(app, m); }, 'sm'),
          iconButton('trash', 'Delete mask', (e) => { e.stopPropagation(); removeMask(app, m); }, 'sm'),
        );
        row.addEventListener('click', () => {
          if (app.state.activeMaskId === m.id) return;
          app.state.activeMaskId = m.id;
          app.state.activeComp = 0;
          rebuild();
          app.requestRender();
        });
        list.append(row);
      });
      create.body.append(list);
    } else {
      create.body.append(el('div', { class: 'empty-note' }, 'Choose what to adjust. Tiles with a dot are found by AI.'));
    }
    root.append(create.el);

    const m = activeMask(app);
    if (!m) return;

    // ---- components
    const typeMenu = (mode) => (e) => { e.stopPropagation(); popMenu(e.currentTarget, [...AI_TYPES, ...TYPES].map((t) => ({ label: COMP_LABELS[t], icon: t, onClick: () => addComp(app, m, t, mode) }))); };
    const comps = section('Selection', {
      id: 'mask-comps', badge: { icon: 'intersect' },
      right: el('span', { class: 'row tight' },
        iconButton('plus', 'Add to selection', typeMenu('add'), 'sm'),
        iconButton('minus', 'Subtract from selection', typeMenu('subtract'), 'sm'),
        iconButton('intersect', 'Intersect with selection', typeMenu('intersect'), 'sm')),
    });
    const compList = el('div', { class: 'comp-list' });
    m.comps.forEach((c, i) => {
      const on = i === app.state.activeComp;
      const modeBtn = i === 0 ? el('span', { class: 'mode-chip ghost' }, icon('plus')) : el('button', {
        class: 'mode-chip', title: `${c.mode} (click to change)`,
        onclick: (e) => { e.stopPropagation(); c.mode = c.mode === 'add' ? 'subtract' : c.mode === 'subtract' ? 'intersect' : 'add'; app.commit(); rebuild(); app.requestRender(); },
      }, icon(MODE_ICON[c.mode]));
      const row = el('div', { class: 'comp-row' + (on ? ' on' : '') },
        modeBtn, icon(compIcon(c), 'i comp-type'), el('span', { class: 'comp-name' }, compLabel(c)),
        el('span', { class: 'grow' }),
        iconButton('invert', c.invert ? 'Inverted' : 'Invert', (e) => { e.stopPropagation(); c.invert = !c.invert; app.commit(); rebuild(); app.requestRender(); }, 'sm' + (c.invert ? ' on' : '')),
        iconButton('x', 'Remove component', (e) => { e.stopPropagation(); removeComp(app, m, i); }, 'sm'),
      );
      row.addEventListener('click', () => { app.state.activeComp = i; rebuild(); app.requestRender(); });
      compList.append(row);
    });
    comps.body.append(compList);

    const c = activeComp(app);
    if (c) comps.body.append(compSettings(app, m, c, reg));

    const amount = slider({ label: 'Mask amount', min: 0, max: 100, def: 100, get: () => m.amount, set: (v) => { m.amount = v; app.requestRender(); }, commit: () => app.commit() });
    const ov = toggle('Show overlay (O)', () => app.state.showOverlay, (v) => { app.state.showOverlay = v; app.requestRender(); });
    reg.push(amount, ov);
    comps.body.append(disclosure('mask-more', 'More options', amount.el, ov.el));
    root.append(comps.el);

    // ---- adjustments
    const D = maskAdjDefaults();
    const adj = section('Adjustments', {
      badge: { icon: 'edit' },
      id: 'mask-adj',
      onReset: () => { m.adj = maskAdjDefaults(); app.commit(); app.requestRender(); refresh(); },
    });
    const S = (k, label, min, max, step = 1, extra = {}) => {
      const s = slider({ label, min, max, step, def: D[k], get: () => m.adj[k], set: (v) => { m.adj[k] = v; app.requestRender(); }, commit: () => app.commit(), ...extra });
      reg.push(s);
      return s.el;
    };
    adj.body.append(
      S('exposure', 'Exposure', -4, 4, 0.01),
      S('contrast', 'Contrast', -100, 100),
      S('highlights', 'Highlights', -100, 100),
      S('shadows', 'Shadows', -100, 100),
      S('temp', 'Temperature', -100, 100, 1, { track: 'linear-gradient(90deg,#4f7dff,#9fb4d9 45%,#d9c49f 55%,#ffb53d)' }),
      S('saturation', 'Saturation', -100, 100),
      S('clarity', 'Clarity', -100, 100),
      disclosure('mask-adj-more', 'More adjustments',
        S('whites', 'Whites', -100, 100),
        S('blacks', 'Blacks', -100, 100),
        S('tint', 'Tint', -100, 100, 1, { track: 'linear-gradient(90deg,#3fcf5f,#9fcfa9 45%,#d3a5cf 55%,#e04fd8)' }),
        S('dehaze', 'Dehaze', -100, 100),
        el('div', { class: 'subhead' }, 'Color tint'),
        S('hue', 'Hue', 0, 360, 1, { format: (v) => `${Math.round(v)}°`, track: 'linear-gradient(90deg,#ff4d4d,#ffd84a,#5fd35f,#3dd6d0,#4d7dff,#ff5bd1,#ff4d4d)' }),
        S('tintAmt', 'Amount', 0, 100)),
    );
    root.append(adj.el);
  }

  function refresh() {
    reg.forEach((c) => c.refresh());
  }
  rebuild();
  return { el: root, refresh, rebuild };
}

function compSettings(app, m, c, reg) {
  const box = el('div', { class: 'comp-settings' });
  const S = (obj, k, label, min, max, def, extra = {}) => {
    const s = slider({ label, min, max, def, get: () => obj[k], set: (v) => { obj[k] = v; app.requestRender(); }, commit: () => app.commit(), ...extra });
    reg.push(s);
    return s.el;
  };
  const B = app.state.brush;
  switch (c.type) {
    case 'brush': {
      const mode = segmented([{ value: false, label: 'Paint', icon: 'brush' }, { value: true, label: 'Erase', icon: 'erase' }], B.erase, (v) => { B.erase = v; });
      reg.push({ refresh: () => mode.set(B.erase) });
      box.append(mode.el,
        S(B, 'size', 'Size', 1, 100, 25, { commit: null }),
        S(B, 'feather', 'Feather', 0, 100, 50, { commit: null }),
        S(B, 'flow', 'Flow', 1, 100, 80, { commit: null }),
        el('div', { class: 'row-btns' }, button('Clear strokes', () => { m.brush.strokes = []; m.brush.v = nextVersion(); app.commit(); app.requestRender(); }, 'sm ghost', 'trash')),
        el('div', { class: 'hint' }, 'Hold Alt to erase · [ and ] change size'));
      break;
    }
    case 'linear':
      box.append(el('div', { class: 'hint' }, 'Drag on the photo to draw a new gradient, or move its handles. The effect is full at the solid line and fades out by the thin line.'));
      break;
    case 'radial':
      box.append(S(c, 'feather', 'Feather', 0, 100, 50), el('div', { class: 'hint' }, 'Drag on the photo to draw an ellipse. Drag the side handles to resize and rotate.'));
      break;
    case 'luminance':
      box.append(
        el('div', { class: 'subhead' }, el('span', {}, 'Tone range'), iconButton('picker', 'Sample a tone from the photo', () => app.startPick('luminance'), 'sm')),
        S(c, 'lo', 'Low', 0, 100, 60, { track: 'linear-gradient(90deg,#000,#fff)' }),
        S(c, 'hi', 'High', 0, 100, 100, { track: 'linear-gradient(90deg,#000,#fff)' }),
        S(c, 'feather', 'Smoothness', 0, 50, 12),
      );
      break;
    case 'color': {
      const sw = el('span', { class: 'swatch' });
      const paint = () => {
        sw.classList.toggle('empty', !c.picked);
        sw.style.background = c.picked ? `oklab(${c.L} ${c.a} ${c.b})` : '';
      };
      paint();
      reg.push({ refresh: paint });
      box.append(
        el('div', { class: 'subhead' }, el('span', { class: 'row' }, sw, c.picked ? 'Selected color' : 'No color picked'), iconButton('picker', 'Pick a color from the photo', () => app.startPick('color'), 'sm')),
        S(c, 'tol', 'Range', 0, 100, 30),
        S(c, 'feather', 'Smoothness', 0, 100, 40),
      );
      break;
    }
    case 'subject':
      box.append(el('div', { class: 'hint' }, app.aiStatus('subject', c.invert
        ? 'Everything except the main subject, found by AI on this device.'
        : 'The main subject — people first, otherwise the most prominent object — found by AI on this device.')));
      break;
    case 'object':
      box.append(el('div', { class: 'hint' }, c.point ? app.aiStatus('object', 'Click another spot on the photo to select a different object.') : 'Click the object you want to select.'));
      break;
    case 'depth':
      box.append(
        S(c, 'near', 'Nearest', 0, 100, 100, { track: 'linear-gradient(90deg,#1b2233,#e8ecf5)' }),
        S(c, 'far', 'Farthest', 0, 100, 55, { track: 'linear-gradient(90deg,#1b2233,#e8ecf5)' }),
        S(c, 'feather', 'Smoothness', 0, 50, 15),
        el('div', { class: 'hint' }, app.aiStatus('depth', 'Selects by distance from the camera (estimated by AI). Right = close, left = far.')),
      );
      break;
    default:
      box.append(el('div', { class: 'hint' }, 'Covers the entire photo. Combine with a color or luminance range using Intersect, or subtract shapes from it.'));
  }
  return box;
}

// Apply a color/luminance sample at image uv to the active component.
export function applyPick(app, kind, uv) {
  const c = activeComp(app);
  if (!c) return;
  const [r, g, b] = app.sourceAt(uv);
  const [L, A_, B_] = linearToOklab(r, g, b);
  if (kind === 'color' && c.type === 'color') {
    Object.assign(c, { L, a: A_, b: B_, picked: true });
  } else if (kind === 'luminance' && c.type === 'luminance') {
    const v = L * 100;
    c.lo = Math.round(clamp(v - 15, 0, 100));
    c.hi = Math.round(clamp(v + 15, 0, 100));
  }
  app.commit();
  app.rebuildPanel();
  app.requestRender();
}

// ------------------------------------------------------------------ overlay

export class MaskOverlay {
  constructor(app) {
    this.app = app;
    this.drag = null;
    this.hover = null;
  }

  pcss(X, Y) { return A.apply(this.app.m.pToCss, X, Y); }
  unit() { const [x, y] = A.vec(this.app.m.pToCss, 0, 1); return Math.hypot(x, y); }

  handles(c) {
    if (c.type === 'linear') {
      return [
        { id: 'p0', pos: this.pcss(c.x0, c.y0) },
        { id: 'p1', pos: this.pcss(c.x1, c.y1) },
        { id: 'mid', pos: this.pcss((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2) },
      ];
    }
    if (c.type === 'radial') {
      const R = A.rotate(c.angle);
      const pt = (x, y) => { const [u, v] = A.apply(R, x, y); return this.pcss(c.cx + u, c.cy + v); };
      return [
        { id: 'c', pos: this.pcss(c.cx, c.cy) },
        { id: 'x+', pos: pt(c.rx, 0) }, { id: 'x-', pos: pt(-c.rx, 0) },
        { id: 'y+', pos: pt(0, c.ry) }, { id: 'y-', pos: pt(0, -c.ry) },
      ];
    }
    return [];
  }

  draw(svg) {
    const app = this.app;
    const c = activeComp(app);
    if (!c) return;
    const g = svgEl('g', { class: 'mask-ui' });
    if (c.type === 'linear') {
      const [x0, y0] = this.pcss(c.x0, c.y0), [x1, y1] = this.pcss(c.x1, c.y1);
      let dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 4000, ny = (dx / len) * 4000;
      const line = (x, y, cls) => g.append(svgEl('line', { x1: x - nx, y1: y - ny, x2: x + nx, y2: y + ny, class: cls }));
      line(x0, y0, 'g-line strong');
      line((x0 + x1) / 2, (y0 + y1) / 2, 'g-line dashed');
      line(x1, y1, 'g-line');
    } else if (c.type === 'radial') {
      const t = svgEl('g', { transform: A.css(app.m.pToCss) });
      const inner = svgEl('g', { transform: `translate(${c.cx} ${c.cy}) rotate(${(c.angle * 180) / Math.PI})` });
      inner.append(svgEl('ellipse', { rx: c.rx, ry: c.ry, class: 'g-line strong', 'vector-effect': 'non-scaling-stroke' }));
      const f = 1 - c.feather / 100;
      if (f > 0.02) inner.append(svgEl('ellipse', { rx: c.rx * f, ry: c.ry * f, class: 'g-line dashed', 'vector-effect': 'non-scaling-stroke' }));
      t.append(inner);
      g.append(t);
    } else if (c.type === 'brush' && this.hover) {
      const B = app.state.brush;
      const r = brushRadius(B.size) * this.unit();
      const [x, y] = this.hover;
      g.append(svgEl('circle', { cx: x, cy: y, r, class: 'brush-ring' + (B.erase || this.alt ? ' erase' : '') }));
      g.append(svgEl('circle', { cx: x, cy: y, r: r * (1 - B.feather / 100), class: 'brush-ring inner' }));
    }
    for (const h of this.handles(c)) {
      g.append(svgEl('circle', { cx: h.pos[0], cy: h.pos[1], r: h.id === 'c' || h.id === 'mid' ? 6 : 5, class: 'pin' + (h.id === 'c' || h.id === 'p0' ? ' main' : '') }));
    }
    svg.append(g);
  }

  cursor(x, y) {
    const c = activeComp(this.app);
    if (!c) return '';
    if (c.type === 'brush') return 'none';
    if (c.type === 'color' || c.type === 'luminance') return 'crosshair';
    if (c.type === 'all') return '';
    return this.hit(c, x, y) ? 'grab' : 'crosshair';
  }

  hit(c, x, y) {
    return this.handles(c).find((h) => Math.hypot(h.pos[0] - x, h.pos[1] - y) < 12) || null;
  }

  down(e, x, y) {
    const app = this.app;
    const m = activeMask(app), c = activeComp(app);
    if (!m || !c) return false;
    const [X, Y] = app.cssToP(x, y);
    if (c.type === 'brush') {
      const B = app.state.brush;
      brushCanvas(m, app.img.aspect);
      m.brush.strokes.push({ size: brushRadius(B.size), feather: B.feather / 100, flow: B.flow / 100, erase: B.erase || e.altKey, pts: [[X, Y]] });
      m.brush.v = nextVersion();
      brushAppend(m, app.img.aspect);
      this.drag = { type: 'paint', last: [X, Y] };
      app.requestRender();
      return true;
    }
    if (c.type === 'color' || c.type === 'luminance') {
      applyPick(app, c.type, app.cssToUV(x, y));
      return true;
    }
    if (c.type === 'object') {
      const uv = app.cssToUV(x, y);
      if (uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return false;
      c.point = [+uv[0].toFixed(4), +uv[1].toFixed(4)];
      app.commit();
      app.aiEnsure();
      app.rebuildPanel();
      return true;
    }
    if (c.type === 'all' || c.type === 'subject' || c.type === 'depth') return false;
    const h = this.hit(c, x, y);
    if (h) {
      this.drag = { type: 'handle', id: h.id, start: [X, Y], c0: { ...c } };
    } else if (c.type === 'linear') {
      Object.assign(c, { x0: X, y0: Y, x1: X, y1: Y + 0.001 });
      this.drag = { type: 'handle', id: 'p1', start: [X, Y], c0: { ...c } };
    } else if (c.type === 'radial') {
      this.drag = { type: 'new-radial', start: [X, Y], c0: { ...c }, moved: false };
    }
    return true;
  }

  move(e, x, y) {
    const d = this.drag;
    const app = this.app;
    this.hover = [x, y];
    this.alt = e.altKey;
    if (!d) return;
    const m = activeMask(app), c = activeComp(app);
    if (!m || !c) return;
    const [X, Y] = app.cssToP(x, y);
    if (d.type === 'paint') {
      const s = m.brush.strokes[m.brush.strokes.length - 1];
      if (Math.hypot(X - d.last[0], Y - d.last[1]) < s.size * 0.12) return;
      s.pts.push([X, Y]);
      d.last = [X, Y];
      m.brush.v = nextVersion();
      brushAppend(m, app.img.aspect);
    } else if (d.type === 'new-radial') {
      const dx = X - d.start[0], dy = Y - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) < 0.01) return;
      d.moved = true;
      Object.assign(c, { cx: d.start[0], cy: d.start[1], rx: Math.max(0.01, Math.abs(dx)), ry: Math.max(0.01, Math.abs(dy)), angle: 0 });
    } else if (c.type === 'linear') {
      const c0 = d.c0;
      if (d.id === 'p0') Object.assign(c, { x0: X, y0: Y });
      else if (d.id === 'p1') Object.assign(c, { x1: X, y1: Y });
      else {
        const dx = X - d.start[0], dy = Y - d.start[1];
        Object.assign(c, { x0: c0.x0 + dx, y0: c0.y0 + dy, x1: c0.x1 + dx, y1: c0.y1 + dy });
      }
    } else if (c.type === 'radial') {
      const c0 = d.c0;
      if (d.id === 'c') {
        Object.assign(c, { cx: c0.cx + X - d.start[0], cy: c0.cy + Y - d.start[1] });
      } else {
        const vx = X - c.cx, vy = Y - c.cy;
        const len = Math.max(0.01, Math.hypot(vx, vy));
        if (d.id[0] === 'x') {
          c.rx = len;
          c.angle = Math.atan2(vy, vx) + (d.id === 'x-' ? Math.PI : 0);
        } else {
          c.ry = len;
          c.angle = Math.atan2(vy, vx) - Math.PI / 2 + (d.id === 'y-' ? Math.PI : 0);
        }
      }
    }
    app.requestRender();
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.app.commit();
    this.app.requestRender();
  }

  leave() {
    this.hover = null;
  }
}
