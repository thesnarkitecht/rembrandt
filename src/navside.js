// Left side panel in Edit (desktop): Navigator (the photo with the visible area, zoom presets, click or
// drag to move around) and a compact Presets list (hover to preview on the photo, click to apply).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp } from './util.js';
import { section } from './ui.js';
import { allPresets } from './panel-presets.js';

const ZOOMS = [{ label: 'Fit', k: 0 }, { label: '50%', k: 0.5 }, { label: '100%', k: 1 }, { label: '200%', k: 2 }, { label: '400%', k: 4 }];

export function buildNavSide(app) {
  const root = el('div', { class: 'navside-in' });

  // ---- Navigator
  const nav = section('Navigator', { id: 'side-nav', open: true });
  const zoomRow = el('div', { class: 'nav-zooms' });
  const zoomBtns = ZOOMS.map((z) => {
    const b = el('button', { class: 'nav-zoom', type: 'button' }, z.label);
    b.addEventListener('click', () => {
      if (!app.img) return;
      if (!z.k) app.fitView(); else app.zoomTo(app.engine.fullH * z.k);
    });
    zoomRow.append(b);
    return b;
  });
  const thumb = el('canvas', { class: 'nav-thumb' });
  const rect = el('div', { class: 'nav-rect' });
  const frame = el('div', { class: 'nav-frame' }, thumb, rect);
  nav.body.append(zoomRow, frame);

  // Move the view so that the clicked point is in the middle (zooming to 100% from Fit).
  const panTo = (ev) => {
    if (!app.img || app.state.tool === 'crop') return;
    const r = thumb.getBoundingClientRect();
    const u = clamp((ev.clientX - r.left) / r.width, 0, 1), v = clamp((ev.clientY - r.top) / r.height, 0, 1);
    const c = app.params.geometry.crop;
    const qx = c.cx - c.w / 2 + u * c.w, qy = c.cy - c.h / 2 + v * c.h;
    if (app.view.fit) { app.zoomTo(app.engine.fullH); app.computeView(app.params); }
    app.view.pan = [(c.cx - qx) * app.view.scale, (c.cy - qy) * app.view.scale];
    app.requestRender();
  };
  frame.addEventListener('pointerdown', (ev) => { frame.setPointerCapture(ev.pointerId); panTo(ev); });
  frame.addEventListener('pointermove', (ev) => { if (frame.hasPointerCapture(ev.pointerId)) panTo(ev); });

  // The thumbnail is the small render the histogram already made (see scheduleHisto in main.js).
  function setThumb(img) {
    if (thumb.width !== img.width || thumb.height !== img.height) { thumb.width = img.width; thumb.height = img.height; }
    thumb.getContext('2d').putImageData(img, 0, 0);
    frame.style.aspectRatio = `${img.width} / ${img.height}`;
  }

  function update() {
    root.classList.toggle('no-photo', !app.img);
    if (!app.img || !app.m) return;
    const k = app.view.fit ? 0 : app.view.scale / app.engine.fullH;
    zoomBtns.forEach((b, i) => b.classList.toggle('on', ZOOMS[i].k ? Math.abs(ZOOMS[i].k - k) < 0.01 : app.view.fit));
    // The visible part of the photo, as a rectangle on the thumbnail.
    const c = app.params.geometry.crop;
    const vw = app.view.pane ? app.view.pane.w / (window.devicePixelRatio || 1) : innerWidth;
    const viewer = document.getElementById('viewer');
    const x0 = app.view.pane ? app.view.pane.x0 / (window.devicePixelRatio || 1) : 0;
    const [ax, ay] = app.cssToQ(x0, 0), [bx, by] = app.cssToQ(x0 + vw, viewer.clientHeight);
    const l = (Math.min(ax, bx) - (c.cx - c.w / 2)) / c.w, t = (Math.min(ay, by) - (c.cy - c.h / 2)) / c.h;
    const r = (Math.max(ax, bx) - (c.cx - c.w / 2)) / c.w, b = (Math.max(ay, by) - (c.cy - c.h / 2)) / c.h;
    const whole = l <= 0.001 && t <= 0.001 && r >= 0.999 && b >= 0.999;
    rect.hidden = whole || app.state.tool === 'crop';
    const L = clamp(l, 0, 1), T = clamp(t, 0, 1), R = clamp(r, 0, 1), B = clamp(b, 0, 1);
    Object.assign(rect.style, { left: `${L * 100}%`, top: `${T * 100}%`, width: `${(R - L) * 100}%`, height: `${(B - T) * 100}%` });
  }

  // ---- Presets
  const pre = section('Presets', { id: 'side-presets', open: true });
  const list = el('div', { class: 'nav-presets' });
  pre.body.append(list);
  let active = null;
  function buildPresets() {
    list.textContent = '';
    let group = null;
    for (const p of allPresets()) {
      if (p.group !== group) { group = p.group; list.append(el('div', { class: 'np-group' }, group)); }
      const b = el('button', { class: 'np', type: 'button', title: `Apply ${p.name}` }, p.name);
      b.addEventListener('mouseenter', () => app.img && app.previewSettings(p.settings));
      b.addEventListener('mouseleave', () => app.img && app.previewSettings(null));
      b.addEventListener('click', () => {
        if (!app.img) return;
        app.previewSettings(null);
        app.applySettings(p.settings, p.name);
        active?.classList.remove('on');
        active = b; b.classList.add('on');
      });
      list.append(b);
    }
  }
  buildPresets();

  root.append(nav.el, pre.el);
  return { el: root, update, setThumb, refreshPresets: buildPresets };
}
