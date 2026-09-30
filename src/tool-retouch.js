// Spot removal tool (Lightroom's Remove panel, Heal and Clone): pointer handling on the photo, the
// overlay and the panel. The rendering is in retouch.js.
//
// Click adds a spot with an automatically chosen source; a drag paints over a larger area, whose
// source is chosen when the stroke ends. Drag a spot to move it, drag its source circle to choose
// where it copies from. Delete removes the selected spot, / finds it a different source, H hides
// the spots. (Interaction after RAWmakase's retouch tool, MIT; see NOTICE.md.)
import { el, svgEl } from './util.js';
import { slider, segmented, button, toggle } from './ui.js';
import { A } from './geometry.js';
import { findSource, imageOf, radii, pin, MAX_OPS } from './retouch.js';

// Tool settings shared by the overlay and the panel (new spots use them; the selected spot shows them).
export const retouchState = { mode: 'heal', size: 0.02, feather: 0.5, opacity: 1, selected: -1, hide: false, tried: [] };

const ops = (app) => app.params.retouch || (app.params.retouch = []);
const aspect = (app) => app.img?.aspect || 1.5;

// The photo's current source (after lens corrections and earlier spots) for the source search.
function sourceImage(app) {
  const E = app.engine;
  const L = E.L;
  if (!L) return null;
  E.process(app.params, null); // makes sure the base is current
  const t = L.T.lens;
  if (t) return imageOf(E, t);
  // No correction yet: copy the plain source into a float target to read from.
  const tgt = E.tgt('lens', E.gl.RGBA16F, true);
  E.draw(E.P.blit, { uIn: L.src, uSize: [L.w, L.h] }, tgt);
  L.baseKey = null;
  return imageOf(E, tgt);
}

function pickSource(app, op, avoid = []) {
  const img = sourceImage(app);
  const off = img && findSource(img, op, ops(app), avoid);
  if (off) return off;
  // Fallback: two radii to the right (or left near the edge).
  const [ru] = radii(op.radius, aspect(app));
  return [pin(op)[0] > 0.7 ? -3 * ru : 3 * ru, 0];
}

export class RetouchOverlay {
  constructor(app) { this.app = app; this.drag = null; this.hover = null; }

  uv(x, y) { return this.app.cssToUV(x, y); }
  css(u, v) { return A.apply(A.inv(this.app.m.cssToUV), u, v); }
  // Screen radius of a long-edge fraction.
  cssRadius(op) {
    const [ru] = radii(op.radius, aspect(this.app));
    const [x0, y0] = this.css(0.5, 0.5), [x1, y1] = this.css(0.5 + ru, 0.5);
    return Math.hypot(x1 - x0, y1 - y0);
  }

  hit(x, y) {
    const list = ops(this.app);
    for (let i = list.length - 1; i >= 0; i--) {
      const op = list[i], r = Math.max(8, this.cssRadius(op));
      const [px, py] = pin(op);
      const [sx, sy] = this.css(px + op.offset[0], py + op.offset[1]);
      if (Math.hypot(x - sx, y - sy) <= r) return { i, part: 'source' };
      for (const [u, v] of op.points) { const [dx, dy] = this.css(u, v); if (Math.hypot(x - dx, y - dy) <= r) return { i, part: 'dest' }; }
    }
    return null;
  }

  down(e, x, y) {
    if (e.button !== 0) return false;
    const S = retouchState;
    const h = retouchState.hide ? null : this.hit(x, y);
    if (h) {
      S.selected = h.i; S.tried = [];
      this.drag = { kind: h.part, start: this.uv(x, y), op: structuredClone(ops(this.app)[h.i]) };
      this.app.refreshPanel();
      return true;
    }
    if (ops(this.app).length >= MAX_OPS) { this.app.toast('That’s the most spots one photo can have'); return true; }
    this.drag = { kind: 'new', points: [this.uv(x, y)], x, y };
    return true;
  }

  move(e, x, y) {
    this.hover = [x, y];
    const d = this.drag;
    if (!d) { this.app.drawOverlay(); return; }
    const [u, v] = this.uv(x, y);
    if (d.kind === 'new') {
      const last = d.points[d.points.length - 1];
      const [ru] = radii(retouchState.size, aspect(this.app));
      if (Math.hypot(u - last[0], v - last[1]) > ru * 0.25 && d.points.length < 4096) d.points.push([u, v]);
      d.moved ||= Math.hypot(x - d.x, y - d.y) > 4;
      this.app.drawOverlay();
      return;
    }
    const op = ops(this.app)[retouchState.selected];
    if (!op) return;
    const du = u - d.start[0], dv = v - d.start[1];
    if (d.kind === 'source') op.offset = [d.op.offset[0] + du, d.op.offset[1] + dv];
    else { op.points = d.op.points.map(([a, b]) => [a + du, b + dv]); op.offset = [d.op.offset[0] - du, d.op.offset[1] - dv]; }
    this.app.requestRender();
    this.app.drawOverlay();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'new') {
      const S = retouchState;
      const op = { mode: S.mode, shape: d.moved ? 'brush' : 'spot', points: d.moved ? d.points : [d.points[0]], radius: S.size, feather: S.feather, opacity: S.opacity, offset: [0, 0] };
      op.offset = pickSource(this.app, op);
      ops(this.app).push(op);
      S.selected = ops(this.app).length - 1; S.tried = [];
    }
    this.app.requestRender();
    this.app.commit();
    this.app.refreshPanel();
    this.app.drawOverlay();
  }

  leave() { this.hover = null; this.app.drawOverlay(); }
  cursor(x, y) { return this.hit(x, y) ? 'move' : 'none'; }

  draw(svg) {
    const S = retouchState;
    const list = ops(this.app);
    if (!S.hide) {
      list.forEach((op, i) => {
        const r = this.cssRadius(op), sel = i === S.selected;
        const [pu, pv] = pin(op);
        const [dx, dy] = this.css(pu, pv), [sx, sy] = this.css(pu + op.offset[0], pv + op.offset[1]);
        const g = svgEl('g', { class: 'rt' + (sel ? ' sel' : '') });
        if (op.points.length > 1) {
          const d = op.points.map(([u, v], k) => { const [x, y] = this.css(u, v); return `${k ? 'L' : 'M'}${x} ${y}`; }).join('');
          g.append(svgEl('path', { d, class: 'rt-stroke', 'stroke-width': 2 * r }));
          const sd = op.points.map(([u, v], k) => { const [x, y] = this.css(u + op.offset[0], v + op.offset[1]); return `${k ? 'L' : 'M'}${x} ${y}`; }).join('');
          if (sel) g.append(svgEl('path', { d: sd, class: 'rt-stroke src', 'stroke-width': 2 * r }));
        } else {
          g.append(svgEl('circle', { cx: dx, cy: dy, r, class: 'rt-dest' }));
          if (sel) g.append(svgEl('circle', { cx: sx, cy: sy, r, class: 'rt-src' }));
        }
        if (sel) g.append(svgEl('line', { x1: dx, y1: dy, x2: sx, y2: sy, class: 'rt-link' }));
        g.append(svgEl('circle', { cx: dx, cy: dy, r: 3.5, class: 'rt-pin' }));
        svg.append(g);
      });
    }
    // The brush under the pointer, and a stroke being painted.
    const d = this.drag;
    const r = this.cssRadius({ radius: S.size });
    if (d?.kind === 'new' && d.points.length > 1) {
      const path = d.points.map(([u, v], k) => { const [x, y] = this.css(u, v); return `${k ? 'L' : 'M'}${x} ${y}`; }).join('');
      svg.append(svgEl('path', { d: path, class: 'rt-paint', 'stroke-width': 2 * r }));
    }
    if (this.hover && !d && !this.hit(...this.hover)) {
      svg.append(svgEl('circle', { cx: this.hover[0], cy: this.hover[1], r, class: 'rt-cursor' }));
      svg.append(svgEl('circle', { cx: this.hover[0], cy: this.hover[1], r: r * (1 - S.feather), class: 'rt-cursor inner' }));
    }
  }
}

// ---------------------------------------------------------------- actions

export function newSourceForSelected(app) {
  const S = retouchState, op = ops(app)[S.selected];
  if (!op) return;
  S.tried.push(op.offset);
  op.offset = pickSource(app, op, S.tried);
  app.requestRender(); app.commit(); app.drawOverlay();
}
export function deleteSelected(app) {
  const S = retouchState;
  if (!ops(app)[S.selected]) return false;
  ops(app).splice(S.selected, 1);
  S.selected = Math.min(S.selected, ops(app).length - 1);
  app.requestRender(); app.commit(); app.refreshPanel(); app.drawOverlay();
  return true;
}

// ---------------------------------------------------------------- panel

export function buildRetouchPanel(app) {
  const S = retouchState;
  const sel = () => ops(app)[S.selected] || null;
  // The sliders edit the selected spot, or the settings for new ones.
  const setting = (key, v) => { S[key === 'radius' ? 'size' : key] = v; const op = sel(); if (op) { op[key] = v; app.requestRender(); app.drawOverlay(); } };
  const mode = segmented([{ value: 'heal', label: 'Heal' }, { value: 'clone', label: 'Clone' }], sel()?.mode || S.mode, (v) => { setting('mode', v); app.commit(); }, 'seg-sm');
  const size = slider({ label: 'Size', min: 0.2, max: 20, step: 0.1, def: 2, get: () => (sel()?.radius ?? S.size) * 100, set: (v) => setting('radius', v / 100), commit: () => app.commit() });
  const feather = slider({ label: 'Feather', min: 0, max: 100, def: 50, get: () => (sel()?.feather ?? S.feather) * 100, set: (v) => setting('feather', v / 100), commit: () => app.commit() });
  const opacity = slider({ label: 'Opacity', min: 0, max: 100, def: 100, get: () => (sel()?.opacity ?? S.opacity) * 100, set: (v) => setting('opacity', v / 100), commit: () => app.commit() });
  const hide = toggle('Show spots', () => !S.hide, (v) => { S.hide = !v; app.drawOverlay(); });
  const count = el('div', { class: 'hint' });
  const newSrc = button('New source', () => newSourceForSelected(app), 'sm ghost', 'swap');
  const del = button('Delete', () => deleteSelected(app), 'sm ghost', 'trash');
  const clear = button('Clear all', () => { app.params.retouch = []; S.selected = -1; app.requestRender(); app.commit(); refresh(); app.drawOverlay(); }, 'sm ghost');
  function refresh() {
    mode.set(sel()?.mode || S.mode);
    size.refresh(); feather.refresh(); opacity.refresh(); hide.refresh();
    const n = ops(app).length;
    count.textContent = n ? `${n} spot${n === 1 ? '' : 's'} on this photo${sel() ? ` · spot ${S.selected + 1} selected` : ''}` : 'No spots yet.';
    newSrc.disabled = del.disabled = !sel();
    clear.disabled = !n;
  }
  refresh();
  const root = el('div', { class: 'panel-view retouch' },
    el('div', { class: 'panel-section' },
      el('p', { class: 'hint rt-intro' }, 'Click a spot to remove it, or drag to paint over a larger area. Rembrandt picks a matching source; drag the source circle to choose your own.'),
      el('div', { class: 'field' }, el('span', {}, 'Mode'), mode.el),
      size.el, feather.el, opacity.el, hide.el,
      el('div', { class: 'row-btns' }, newSrc, del, clear),
      count,
      el('div', { class: 'hint' }, 'Keys: / new source · Delete remove · H show or hide spots.')));
  return { el: root, refresh };
}
