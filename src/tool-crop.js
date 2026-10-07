// Crop & straighten tool: panel + on-canvas overlay.
import { el, svgEl, clamp } from './util.js';
import { slider, section, iconButton, button } from './ui.js';
import { icon } from './icons.js';
import { A, maxCrop, fitCrop, constrainCrop, cropValid } from './geometry.js';
import { aspectRatioOf } from './params.js';
import { detectTilt } from './straighten.js';

// The tilt of the photo as framed now, measured with no straightening applied. null: no clear lines.
export function measureTilt(app) {
  if (!app.img) return null;
  const G = app.params.geometry;
  const geo = { ...G, angle: 0, aspect: 'original', cropAuto: true };
  geo.crop = maxCrop(app.img.aspect, geo, aspectRatioOf(geo, app.img.aspect), 0, 0);
  const img = app.renderSmall({ ...app.params, geometry: geo }, 800);
  return img ? detectTilt(img) : null;
}

// Levels the photo: sets Straighten from the detected tilt and refits the crop. Returns the result.
export function autoStraighten(app) {
  const t = measureTilt(app);
  if (!t) return null;
  const G = app.params.geometry;
  G.angle = clamp(t.angle, -45, 45);
  refitCrop(app);
  app.requestRender();
  app.commit();
  return t;
}

const ASPECTS = [
  ['original', 'Original'], ['free', 'Free'], ['1:1', '1 : 1'], ['4:5', '4 : 5'],
  ['3:2', '3 : 2'], ['16:9', '16 : 9'], ['5:7', '5 : 7'], ['2:3', '2 : 3'],
];
const MIN = 0.03;

// A copy of `geometry` straightened to `angle`, with its crop refitted inside the rotated photo.
export function straightened(app, geometry, angle) {
  const g = { ...geometry, angle: clamp(angle, -45, 45) }, a = app.img.aspect;
  const ratio = aspectRatioOf(g, a) ?? g.crop.w / g.crop.h;
  g.crop = g.cropAuto ? maxCrop(a, g, ratio, 0, 0) : fitCrop(g.crop, a, g);
  return g;
}

export function refitCrop(app, recentre = false) {
  const g = app.params.geometry, a = app.img.aspect;
  const ratio = aspectRatioOf(g, a) ?? g.crop.w / g.crop.h;
  if (g.cropAuto || recentre) g.crop = maxCrop(a, g, ratio, 0, 0);
  else g.crop = fitCrop(g.crop, a, g);
}

export function buildCropPanel(app) {
  const g = () => app.params.geometry;
  const reg = [];
  const chips = el('div', { class: 'chips' });
  const chipEls = ASPECTS.map(([v, label]) => {
    const b = el('button', { class: 'chip', onclick: () => setAspect(v) }, label);
    chips.append(b);
    return [v, b];
  });

  function setAspect(v) {
    const G = g();
    G.aspect = v;
    const ratio = aspectRatioOf(G, app.img.aspect);
    if (ratio) {
      const c = maxCrop(app.img.aspect, G, ratio, G.crop.cx, G.crop.cy);
      const centred = maxCrop(app.img.aspect, G, ratio, 0, 0);
      G.crop = c.h > centred.h * 0.7 ? c : centred;
    }
    G.cropAuto = v === 'original' && Math.abs(G.angle) < 1e-9;
    app.requestRender();
    app.commit();
    refresh();
  }

  function swap() {
    const G = g();
    const ratio = aspectRatioOf(G, app.img.aspect);
    if (!ratio) return;
    if (G.aspect === 'original') G.aspect = `1:${ratio}`;
    else if (G.aspect.includes(':')) { const [x, y] = G.aspect.split(':'); G.aspect = `${y}:${x}`; }
    G.crop = maxCrop(app.img.aspect, G, 1 / ratio, 0, 0);
    G.cropAuto = false;
    app.requestRender();
    app.commit();
    refresh();
  }

  const angle = slider({
    label: 'Straighten', min: -45, max: 45, step: 0.1, def: 0, format: (v) => `${(+v).toFixed(1)}°`,
    get: () => g().angle,
    set: (v) => { g().angle = v; refitCrop(app); app.requestRender(); },
    commit: () => app.commit(),
  });
  reg.push(angle);

  const rot = (d) => () => {
    const G = g();
    G.rot90 = (G.rot90 + d + 4) % 4;
    G.cropAuto = true;
    if (G.aspect !== 'original' && G.aspect !== 'free') { const [x, y] = G.aspect.split(':'); G.aspect = `${y}:${x}`; }
    refitCrop(app, true);
    app.fitView();
    app.commit();
    refresh();
  };
  const flip = (k) => () => { g()[k] = !g()[k]; app.requestRender(); app.commit(); refresh(); };

  // Auto: levels the horizon or verticals. A suggestion appears when the photo looks tilted.
  const tip = el('div', { class: 'tilt-tip', hidden: true });
  const auto = () => {
    const t = autoStraighten(app);
    tip.hidden = true;
    app.toast(t ? (Math.abs(t.angle) < 0.05 ? 'Already level' : `Straightened by ${Math.abs(t.angle).toFixed(1)}°`) : 'No clear horizon or straight lines to level by');
    refresh();
  };
  setTimeout(() => {
    if (Math.abs(g().angle) > 1e-6 || !app.img) return;
    const t = measureTilt(app);
    if (!t || Math.abs(t.angle) < 0.3) return;
    tip.textContent = '';
    tip.append(icon('wand'), el('span', {}, `Looks tilted ${Math.abs(t.angle).toFixed(1)}°`), button('Straighten', auto, 'sm'));
    tip.hidden = false;
  }, 60);

  const sec = section('Crop & Straighten', { id: 'crop', badge: { icon: 'crop', color: 'linear-gradient(135deg,#ffd166,#f59e0b)' } });
  sec.body.append(
    el('div', { class: 'subhead' }, el('span', {}, 'Aspect ratio'), iconButton('swap', 'Swap orientation (X)', swap, 'sm')),
    chips,
    tip,
    angle.el,
    el('div', { class: 'row-btns' }, button('Auto straighten', auto, 'sm ghost', 'wand')),
    el('div', { class: 'row-btns' },
      iconButton('rotL', 'Rotate left ([)', rot(-1)),
      iconButton('rotR', 'Rotate right (])', rot(1)),
      iconButton('flipH', 'Flip horizontal', flip('flipH')),
      iconButton('flipV', 'Flip vertical', flip('flipV')),
    ),
    el('div', { class: 'hint' }, 'Drag the corners to crop · drag outside the frame to rotate.'),
    el('div', { class: 'row-btns end' },
      button('Reset', () => {
        const G = g();
        Object.assign(G, { angle: 0, rot90: 0, flipH: false, flipV: false, aspect: 'original', cropAuto: true });
        refitCrop(app, true);
        app.fitView();
        app.commit();
        refresh();
      }, 'ghost'),
      button('Done', () => app.setTool('edit'), 'primary'),
    ),
  );

  function refresh() {
    const G = g();
    chipEls.forEach(([v, b]) => b.classList.toggle('on', v === G.aspect || (v === 'original' && !ASPECTS.some(([x]) => x === G.aspect) && G.aspect.startsWith('1:'))));
    reg.forEach((c) => c.refresh());
  }
  refresh();
  return { el: el('div', { class: 'panel-view' }, sec.el), refresh, swap, rot };
}

// ------------------------------------------------------------------ overlay

export class CropOverlay {
  constructor(app) {
    this.app = app;
    this.drag = null;
  }

  rectCss() {
    const c = this.app.params.geometry.crop;
    const m = this.app.m.qToCss;
    const [x0, y0] = A.apply(m, c.cx - c.w / 2, c.cy - c.h / 2);
    const [x1, y1] = A.apply(m, c.cx + c.w / 2, c.cy + c.h / 2);
    return { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
  }

  draw(svg, W, H) {
    const { l, t, r, b } = this.rectCss();
    const w = r - l, h = b - t;
    svg.append(svgEl('path', { d: `M0 0H${W}V${H}H0Z M${l} ${t}V${b}H${r}V${t}Z`, 'fill-rule': 'evenodd', class: 'crop-dim' }));
    const grid = svgEl('g', { class: 'crop-grid' + (this.drag ? ' active' : '') });
    const n = this.drag?.type === 'rotate' ? 8 : 3;
    for (let i = 1; i < n; i++) {
      grid.append(svgEl('line', { x1: l + (w * i) / n, y1: t, x2: l + (w * i) / n, y2: b }));
      grid.append(svgEl('line', { x1: l, y1: t + (h * i) / n, x2: r, y2: t + (h * i) / n }));
    }
    svg.append(grid);
    svg.append(svgEl('rect', { x: l, y: t, width: w, height: h, class: 'crop-frame' }));
    const L = Math.min(18, w / 3, h / 3);
    const corners = [[l, t, 1, 1], [r, t, -1, 1], [r, b, -1, -1], [l, b, 1, -1]];
    for (const [x, y, dx, dy] of corners) {
      svg.append(svgEl('path', { d: `M${x} ${y + dy * L}V${y}H${x + dx * L}`, class: 'crop-corner' }));
    }
    for (const [x, y, hor] of [[(l + r) / 2, t, 1], [(l + r) / 2, b, 1], [l, (t + b) / 2, 0], [r, (t + b) / 2, 0]]) {
      svg.append(svgEl('path', { d: hor ? `M${x - 10} ${y}H${x + 10}` : `M${x} ${y - 10}V${y + 10}`, class: 'crop-corner' }));
    }
    if (this.drag?.type === 'rotate') {
      const G = this.app.params.geometry;
      const label = svgEl('text', { x: (l + r) / 2, y: t - 12, class: 'crop-label', 'text-anchor': 'middle' });
      label.textContent = `${G.angle.toFixed(1)}°`;
      svg.append(label);
    }
  }

  hit(x, y) {
    const { l, t, r, b } = this.rectCss();
    const near = 14;
    const nx = Math.abs(x - l) < near ? -1 : Math.abs(x - r) < near ? 1 : 0;
    const ny = Math.abs(y - t) < near ? -1 : Math.abs(y - b) < near ? 1 : 0;
    const inX = x > l - near && x < r + near, inY = y > t - near && y < b + near;
    if (nx && ny) return { type: 'resize', sx: nx, sy: ny };
    if (nx && inY) return { type: 'resize', sx: nx, sy: 0 };
    if (ny && inX) return { type: 'resize', sx: 0, sy: ny };
    if (x > l && x < r && y > t && y < b) return { type: 'move' };
    return { type: 'rotate' };
  }

  cursor(x, y) {
    const h = this.hit(x, y);
    if (h.type === 'move') return 'move';
    if (h.type === 'rotate') return 'alias';
    if (h.sx && h.sy) return h.sx === h.sy ? 'nwse-resize' : 'nesw-resize';
    return h.sx ? 'ew-resize' : 'ns-resize';
  }

  down(e, x, y) {
    const G = this.app.params.geometry;
    const h = this.hit(x, y);
    const { l, t, r, b } = this.rectCss();
    this.drag = { ...h, start: this.app.cssToQ(x, y), crop: { ...G.crop }, angle: G.angle, cx: (l + r) / 2, cy: (t + b) / 2, a0: Math.atan2(y - (t + b) / 2, x - (l + r) / 2) };
    return true;
  }

  move(e, x, y) {
    const d = this.drag;
    if (!d) return;
    const app = this.app, G = app.params.geometry, a = app.img.aspect;
    const [qx, qy] = app.cssToQ(x, y);
    if (d.type === 'rotate') {
      const ang = Math.atan2(y - d.cy, x - d.cx);
      let deg = d.angle + ((ang - d.a0) * 180) / Math.PI;
      deg = ((deg + 180) % 360 + 360) % 360 - 180;
      G.angle = Math.round(clamp(deg, -45, 45) * 10) / 10;
      refitCrop(app);
      app.refreshPanel();
    } else if (d.type === 'move') {
      let c = G.crop;
      c = constrainCrop(c, { ...c, cx: d.crop.cx + qx - d.start[0] }, a, G);
      c = constrainCrop(c, { ...c, cy: d.crop.cy + qy - d.start[1] }, a, G);
      G.crop = c;
    } else {
      const c0 = d.crop;
      const ratio = aspectRatioOf(G, a);
      const l = c0.cx - c0.w / 2, r = c0.cx + c0.w / 2, t = c0.cy - c0.h / 2, b = c0.cy + c0.h / 2;
      const ax = d.sx > 0 ? l : r, ay = d.sy > 0 ? t : b;
      let w = d.sx ? Math.max(MIN, (qx - ax) * d.sx) : c0.w;
      let h = d.sy ? Math.max(MIN, (qy - ay) * d.sy) : c0.h;
      if (ratio) {
        if (d.sx && d.sy) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
        else if (d.sx) h = w / ratio;
        else w = h * ratio;
      }
      const cx = d.sx ? (d.sx > 0 ? ax + w / 2 : ax - w / 2) : c0.cx;
      const cy = d.sy ? (d.sy > 0 ? ay + h / 2 : ay - h / 2) : c0.cy;
      const next = { cx, cy, w, h };
      G.crop = cropValid(next, a, G) ? next : constrainCrop(G.crop, next, a, G);
      G.cropAuto = false;
    }
    app.requestRender();
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.app.commit();
    this.app.requestRender();
  }
}
