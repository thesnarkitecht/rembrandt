// Spot removal tool (Lightroom's Remove panel, Heal and Clone): pointer handling on the photo, the
// overlay and the panel. The rendering is in retouch.js.
//
// Click adds a spot with an automatically chosen source; a drag paints over a larger area, whose
// source is chosen when the stroke ends. Drag a spot to move it, drag its source circle to choose
// where it copies from. Delete removes the selected spot, / finds it a different source, H hides
// the spots. (Interaction after RAWmakase's retouch tool, MIT; see NOTICE.md.)
import { el, svgEl } from './util.js';
import { slider, segmented, button, toggle, section } from './ui.js';
import { A } from './geometry.js';
import { findSource, imageOf, radii, pin, makeFill, MAX_OPS } from './retouch.js';
import { findDust } from './dust.js';
import { warpActive } from './warp.js';
import { findSpots } from './blemish.js';
import { detectFaces, ai } from './ai/ai.js';
import { PORTRAIT, portraitAmount, setPortrait } from './portrait.js';
import { aiOn } from './workspace.js';

// Tool settings shared by the overlay and the panel (new spots use them; the selected spot shows them).
export const retouchState = { mode: 'fill', size: 0.02, feather: 0.5, opacity: 1, selected: -1, hide: false, spots: false, spotLevel: 50, dustSensitivity: 0.5, tried: [], keepMoles: true, sensitivity: 0.5, kept: [], keptFor: null };

const ops = (app) => app.params.retouch || (app.params.retouch = []);
const aspect = (app) => app.img?.aspect || 1.5;

// The photo's current source (after lens corrections and earlier spots) for the source search.
function sourceImage(app) {
  const E = app.engine;
  const L = E.L;
  if (!L) return null;
  E.process(app.params, null); // makes sure the base is current
  // After Reshape when it's in use (spots are placed on the reshaped photo).
  const t = (L.T.warp && warpActive(app.params.warp) && L.T.warp) || L.T.lens;
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
    // A kept mole: clicking it removes it after all.
    const km = this.keptAt(x, y);
    if (km >= 0) { healKept(this.app, km); return true; }
    const h = retouchState.hide ? null : this.hit(x, y);
    if (h) {
      S.selected = h.i; S.tried = [];
      // A fill stays where it was made (its patch belongs to that spot); clicking just selects it.
      this.drag = ops(this.app)[h.i].mode === 'fill' ? null : { kind: h.part, start: this.uv(x, y), op: structuredClone(ops(this.app)[h.i]) };
      this.app.drawOverlay();
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
      if (op.mode === 'fill') { addFill(this.app, op); this.app.drawOverlay(); return; }
      op.offset = pickSource(this.app, op);
      ops(this.app).push(op);
      S.selected = ops(this.app).length - 1; S.tried = [];
    }
    this.app.requestRender();
    this.app.commit();
    this.app.refreshPanel();
    this.app.drawOverlay();
  }

  keptAt(x, y) {
    const S = retouchState;
    if (S.hide || S.keptFor !== this.app.images[this.app.cur]?.id) return -1;
    return S.kept.findIndex((m) => { const [cx, cy] = this.css(m.u, m.v); return Math.hypot(x - cx, y - cy) <= Math.max(8, this.cssRadius(m)); });
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
          if (sel && op.mode !== 'fill') g.append(svgEl('path', { d: sd, class: 'rt-stroke src', 'stroke-width': 2 * r }));
        } else {
          g.append(svgEl('circle', { cx: dx, cy: dy, r, class: 'rt-dest' }));
          if (sel && op.mode !== 'fill') g.append(svgEl('circle', { cx: sx, cy: sy, r, class: 'rt-src' }));
        }
        if (sel && op.mode !== 'fill') g.append(svgEl('line', { x1: dx, y1: dy, x2: sx, y2: sy, class: 'rt-link' }));
        g.append(svgEl('circle', { cx: dx, cy: dy, r: 3.5, class: 'rt-pin' }));
        svg.append(g);
      });
    }
    // Moles and beauty marks that automatic removal kept: dotted; click one to remove it too.
    if (!S.hide && S.keptFor === this.app.images[this.app.cur]?.id) {
      for (const m of S.kept) {
        const [cx, cy] = this.css(m.u, m.v);
        svg.append(svgEl('circle', { cx, cy, r: Math.max(5, this.cssRadius(m)), class: 'rt-kept' }));
      }
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

// Generative Remove: the painted area is filled by the inpainting network (a few seconds), then
// becomes a normal spot. Fills are made one at a time, in the order painted.
let fillQueue = Promise.resolve();
export const fillState = { busy: 0, error: '' };
export function addFill(app, op, { quiet = false } = {}) {
  fillState.busy++; fillState.error = ''; app.refreshPanel();
  const photo = app.images[app.cur];
  const job = fillQueue.then(async () => {
    if (app.images[app.cur] !== photo) return null;   // moved on to another photo
    await makeFill(sourceImage(app), op);
    if (app.images[app.cur] !== photo) return null;
    ops(app).push(op);
    retouchState.selected = ops(app).length - 1;
    app.requestRender(); app.commit();
    return op;
  }).catch((err) => { console.error(err); fillState.error = `Couldn’t remove that: ${err.message}`; if (!quiet) app.toast(fillState.error); return null; })
    .finally(() => { fillState.busy--; app.refreshPanel(); app.drawOverlay(); });
  fillQueue = job;
  return job;
}

// A Heal spot for an automatically found spot, with its source chosen like a hand-placed one.
function healSpot(app, img, s) {
  const op = { mode: 'heal', shape: 'spot', points: [[s.u, s.v]], radius: s.radius, feather: 0.6, opacity: 1, offset: [0, 0], auto: true };
  op.offset = (img && findSource(img, op, ops(app), [])) || (() => { const [ru] = radii(op.radius, aspect(app)); return [s.u > 0.7 ? -3 * ru : 3 * ru, 0]; })();
  ops(app).push(op);
}

// Remove all dust (dust.js): heals every dust spot found, replacing earlier dust spots on this photo.
// Each one is an ordinary heal spot afterwards (move it, delete it, pick a new source). Resolves the count.
export function removeDust(app) {
  const img = sourceImage(app);
  if (!img) return 0;
  app.params.retouch = ops(app).filter((o) => !o.dust);
  const spots = findDust(img.read(0, 0, img.W, img.H), img.W, img.H, { sensitivity: retouchState.dustSensitivity });
  let n = 0;
  for (const sp of spots) {
    if (ops(app).length >= MAX_OPS) break;
    const op = { mode: 'heal', shape: 'spot', points: [[sp.u, sp.v]], radius: sp.radius, feather: 0.6, opacity: 1, offset: [0, 0], dust: true };
    op.offset = findSource(img, op, ops(app), []) || (() => { const [ru] = radii(op.radius, aspect(app)); return [sp.u > 0.7 ? -3 * ru : 3 * ru, 0]; })();
    ops(app).push(op);
    n++;
  }
  retouchState.selected = -1;
  app.requestRender(); app.commit(); app.refreshPanel(); app.drawOverlay();
  return n;
}

// Automatic blemish removal (blemish.js): replaces earlier automatic spots on this photo.
// Resolves { faces, healed, kept }.
export async function autoBlemish(app) {
  const S = retouchState, e = app.images[app.cur];
  if (!e || !app.img) return { faces: 0, healed: 0, kept: 0 };
  const faces = await detectFaces(e);
  if (!faces.length) return { faces: 0, healed: 0, kept: 0 };
  const img = sourceImage(app);
  app.params.retouch = ops(app).filter((o) => !o.auto);
  const kept = [];
  let healed = 0;
  for (const face of faces) {
    const { spots } = findSpots(img, face, { sensitivity: S.sensitivity });
    spots.sort((a, b) => b.strength - a.strength);
    for (const sp of spots) {
      if (sp.kind === 'mole' && S.keepMoles) { kept.push(sp); continue; }
      if (ops(app).length >= MAX_OPS) break;
      healSpot(app, img, sp);
      healed++;
    }
  }
  // A spot split in two (a pimple's darker core, say) shouldn't be both healed and kept.
  const auto = ops(app).filter((o) => o.auto);
  const overlaps = (m) => auto.some((o) => Math.hypot((o.points[0][0] - m.u) * aspect(app), o.points[0][1] - m.v) < (o.radius + m.radius) * Math.max(1, aspect(app)));
  const keptOnly = kept.filter((m) => !overlaps(m));
  kept.length = 0; kept.push(...keptOnly);
  S.kept = kept; S.keptFor = e.id; S.selected = -1;
  app.requestRender(); app.commit(); app.refreshPanel(); app.drawOverlay();
  return { faces: faces.length, healed, kept: kept.length };
}

function healKept(app, i) {
  const S = retouchState, m = S.kept[i];
  if (!m) return;
  healSpot(app, sourceImage(app), m);
  S.kept.splice(i, 1);
  app.requestRender(); app.commit(); app.refreshPanel(); app.drawOverlay();
}

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

// People in the background: every person the scene model finds, apart from the main subject (the
// largest), is removed with a generative fill. Each becomes a normal fill spot you can delete.
export async function removeBackgroundPeople(app) {
  const e = app.images[app.cur];
  const m = await ai.analyze(e, 'persons');
  const { w, h } = m, N = w * h, on = new Uint8Array(N);
  for (let i = 0; i < N; i++) on[i] = m.data[i] > 0.35 ? 1 : 0;
  // Connected areas (4-neighbour flood fill).
  const label = new Int32Array(N), comps = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (!on[s0] || label[s0]) continue;
    const id = comps.length + 1, stack = [s0], c = { id, n: 0, x0: w, y0: h, x1: 0, y1: 0, px: [] };
    label[s0] = id;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      c.n++; c.px.push(i); c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && on[j] && !label[j]) { label[j] = id; stack.push(j); }
    }
    comps.push(c);
  }
  comps.sort((a, b) => b.n - a.n);
  // The subject is the largest; others count when clearly smaller and not specks.
  const main = comps[0];
  // …and the model is fairly sure about them (a post or a bollard can look a bit like a person).
  const conf = (c) => c.px.reduce((t, i) => t + m.data[i], 0) / c.n;
  const others = comps.slice(1).filter((c) => c.n < main.n * 0.6 && c.n > N * 0.0004 && conf(c) > 0.6);
  if (!main || !others.length) return 0;
  // A detection can be part of a person (a torso, say): the object selector, clicked at its centre,
  // grows it to the whole figure when that stays plausibly person-sized.
  for (const c of others) {
    let sx = 0, sy = 0;
    for (const i of c.px) { sx += i % w; sy += (i / w) | 0; }
    const pt = [(sx / c.n + 0.5) / w, (sy / c.n + 0.5) / h];
    try {
      const o = await ai.analyze(e, 'object', pt);
      if (o.w !== w || o.h !== h) continue;
      const seed = Math.round(pt[1] * h - 0.5) * w + Math.round(pt[0] * w - 0.5);
      if (!(o.data[seed] > 0.5)) continue;
      const seen = new Uint8Array(N), stack = [seed], grown = [];
      seen[seed] = 1;
      while (stack.length && grown.length < c.n * 8) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        grown.push(i);
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && o.data[j] > 0.5) { seen[j] = 1; stack.push(j); }
      }
      // Accept only a figure-shaped growth: about as wide as the detection, and not swallowing the subject.
      let gx0 = w, gx1 = 0;
      for (const i of grown) { const x = i % w; if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; }
      const dw = c.x1 - c.x0 + 1;
      if (!stack.length && grown.length < main.n * 0.6 && gx1 - gx0 + 1 <= dw * 1.6 + 4) {
        const have = new Set(c.px);
        for (const i of grown) if (!have.has(i)) { c.px.push(i); c.n++; const x = i % w, y = (i / w) | 0; c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y); }
      }
    } catch { /* keep the detection as it is */ }
  }
  // Each person as a brush: points on a grid over it, the radius covering the gaps and a margin.
  const step = (c) => Math.max(2, Math.round(Math.sqrt(c.n / 600)));
  for (const c of others) {
    const st = step(c), pts = [];
    for (const i of c.px) { const x = i % w, y = (i / w) | 0; if (x % st === 0 && y % st === 0) pts.push([(x + 0.5) / w, (y + 0.5) / h]); }
    if (!pts.length) continue;
    const radius = (st * 1.2 + Math.max(2, (c.y1 - c.y0) * 0.03)) / Math.max(w, h);
    const op = { mode: 'fill', shape: 'brush', points: pts.slice(0, 4000), radius, feather: 0.3, opacity: 1, offset: [0, 0], auto: 'people' };
    addFill(app, op, { quiet: true });
  }
  await fillQueue;
  return others.length;
}

// ---------------------------------------------------------------- panel

export function buildRetouchPanel(app) {
  const S = retouchState;
  const retouch = [];   // Portrait sliders (built below; refresh reads them)
  const sel = () => ops(app)[S.selected] || null;
  // The sliders edit the selected spot, or the settings for new ones.
  const setting = (key, v) => { S[key === 'radius' ? 'size' : key] = v; const op = sel(); if (op) { op[key] = v; app.requestRender(); app.drawOverlay(); } };
  // The mode is for new spots, and switches a selected heal or clone spot; a fill stays a fill.
  if (!aiOn() && S.mode === 'fill') S.mode = 'heal';   // Generative needs AI (Settings → Workspace)
  const mode = segmented([...(aiOn() ? [{ value: 'fill', label: 'Generative' }] : []), { value: 'heal', label: 'Heal' }, { value: 'clone', label: 'Clone' }], S.mode, (v) => {
    S.mode = v;
    const op = sel();
    if (op && op.mode !== 'fill' && v !== 'fill') { op.mode = v; app.requestRender(); app.commit(); }
    else if (op) { S.selected = -1; app.drawOverlay(); }
    refresh();
  }, 'seg-sm');
  const size = slider({ label: 'Size', min: 0.2, max: 20, step: 0.1, def: 2, get: () => (sel()?.radius ?? S.size) * 100, set: (v) => setting('radius', v / 100), commit: () => app.commit() });
  const feather = slider({ label: 'Feather', min: 0, max: 100, def: 50, get: () => (sel()?.feather ?? S.feather) * 100, set: (v) => setting('feather', v / 100), commit: () => app.commit() });
  const opacity = slider({ label: 'Opacity', min: 0, max: 100, def: 100, get: () => (sel()?.opacity ?? S.opacity) * 100, set: (v) => setting('opacity', v / 100), commit: () => app.commit() });
  const hide = toggle('Show spots', () => !S.hide, (v) => { S.hide = !v; app.drawOverlay(); });
  // Visualize Spots: the photo as white specks on black, so dust and spots stand out (Detail sets how faint).
  const visualize = toggle('Visualize spots', () => S.spots, (v) => { S.spots = v; spotLevel.el.hidden = !v; app.requestRender(); });
  const spotLevel = slider({ label: 'Detail', min: 1, max: 100, def: 50, get: () => S.spotLevel, set: (v) => { S.spotLevel = v; app.requestRender(); } });
  spotLevel.el.hidden = !S.spots;
  const dust = button('Remove all dust', () => {
    const n = removeDust(app);
    app.toast(n ? `Healed ${n} dust spot${n === 1 ? '' : 's'}. Each is an ordinary spot: move or delete any you want to keep` : 'No dust spots found in the smooth areas of this photo');
  }, 'sm ghost', 'erase');
  dust.title = 'Find dust spots in smooth areas (skies, walls) and heal them all';
  const count = el('div', { class: 'hint' });
  const newSrc = button('New source', () => newSourceForSelected(app), 'sm ghost', 'swap');
  const del = button('Delete', () => deleteSelected(app), 'sm ghost', 'trash');
  const clear = button('Clear all', () => { app.params.retouch = []; S.selected = -1; app.requestRender(); app.commit(); refresh(); app.drawOverlay(); }, 'sm ghost');
  function refresh() {
    mode.set(sel()?.mode || S.mode);
    feather.el.hidden = (sel()?.mode || S.mode) === 'fill';
    size.refresh(); feather.refresh(); opacity.refresh(); hide.refresh(); visualize.refresh(); spotLevel.refresh();
    retouch.forEach((r) => r.refresh());
    const n = ops(app).length;
    count.textContent = fillState.busy ? `Removing… (${fillState.busy} left)` : fillState.error || (n ? `${n} spot${n === 1 ? '' : 's'} on this photo${sel() ? ` · spot ${S.selected + 1} selected` : ''}` : 'No spots yet.');
    del.disabled = !sel();
    newSrc.disabled = !sel() || sel().mode === 'fill';
    clear.disabled = !n;
  }
  // Automatic blemish removal for portraits.
  const keep = toggle('Keep moles and beauty marks', () => S.keepMoles, (v) => { S.keepMoles = v; });
  const sens = slider({ label: 'Sensitivity', min: 0, max: 100, def: 50, get: () => S.sensitivity * 100, set: (v) => { S.sensitivity = v / 100; } });
  const autoNote = el('div', { class: 'hint' });
  const auto = button('Remove blemishes', async () => {
    auto.disabled = true;
    autoNote.textContent = 'Finding faces and blemishes…';
    try {
      const r = await autoBlemish(app);
      autoNote.textContent = !r.faces ? 'No face found in this photo.'
        : `${r.healed} blemish${r.healed === 1 ? '' : 'es'} healed${r.kept ? ` · ${r.kept} mole${r.kept === 1 ? '' : 's'} kept (dotted circles: click one to remove it too)` : ''}. Each is a normal spot you can move or delete.`;
    } catch (err) {
      console.error(err);
      autoNote.textContent = `Couldn’t run: ${err.message}`;
    } finally { auto.disabled = false; }
  }, 'sm primary', 'sparkle');
  refresh();
  // Shortcuts live in the tooltips rather than a line of text.
  newSrc.title = 'New source (/)';
  del.title = 'Delete spot (Delete)';
  hide.el.title = 'Show or hide spots (H)';
  const spots = section('Remove spots', { id: 'rt-spots', badge: { icon: 'erase', color: 'linear-gradient(135deg,#f472b6,#db2777)' } });
  spots.body.append(
    el('p', { class: 'hint rt-intro' }, aiOn() ? 'Paint over anything to remove it. Generative fills it with what was most likely behind it; Heal and Clone copy from a matching part of the photo (drag the source circle to choose your own).' : 'Paint over anything to remove it. Heal and Clone copy from a matching part of the photo (drag the source circle to choose your own).'),
    el('div', { class: 'field' }, el('span', {}, 'Mode'), mode.el),
    size.el, feather.el, opacity.el, hide.el, visualize.el, spotLevel.el, el('div', { class: 'row-btns' }, dust),
    el('div', { class: 'row-btns rt-actions' }, newSrc, del, clear),
    count);
  const peopleNote = el('div', { class: 'hint' });
  const people = button('Remove people in the background', async () => {
    people.disabled = true;
    peopleNote.textContent = 'Finding people…';
    try {
      const n = await removeBackgroundPeople(app);
      peopleNote.textContent = n ? `${n} ${n === 1 ? 'person' : 'people'} removed. Each is a spot you can delete to bring them back.` : 'No one in the background to remove. The largest person is kept as the subject.';
    } catch (err) {
      console.error(err);
      peopleNote.textContent = `Couldn’t run: ${err.message}`;
    } finally { people.disabled = false; }
  }, 'sm primary', 'person');
  const distractions = section('Distractions', { id: 'rt-distractions', badge: { icon: 'person', color: 'linear-gradient(135deg,#60a5fa,#2563eb)' } });
  distractions.body.append(el('div', { class: 'row-btns' }, people), peopleNote);
  const portraits = section('Portraits', { id: 'rt-portraits', badge: { icon: 'sparkle', color: 'linear-gradient(135deg,#fbbf24,#f97316)' } });
  // Retouching sliders: each drives a People mask (portrait.js), editable later in Masks.
  retouch.push(...Object.entries(PORTRAIT).map(([key, [label]]) => slider({
    label, min: 0, max: 100, def: 0,
    get: () => portraitAmount(app.params, key),
    set: (v) => { if (setPortrait(app.params, key, v, aspect(app))) app.aiEnsure(); app.requestRender(); },
    commit: () => app.commit(),
  })));
  portraits.body.append(...retouch.map((r) => r.el), el('p', { class: 'hint' }, 'Found by AI on this device. Each is a mask you can fine-tune in Masks.'),
    el('div', { class: 'divider' }), el('div', { class: 'row-btns' }, auto), keep.el, sens.el, autoNote);
  const root = el('div', { class: 'panel-view retouch' }, spots.el, aiOn() ? distractions.el : null, aiOn() ? portraits.el : null);
  return { el: root, refresh };
}
