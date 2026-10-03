// Direct editing: the photo is the control. In Edit, with the photo fitted, drag on it: up and down
// lightens or darkens that tone (blacks, shadows, highlights or whites, picked from the pixel under
// the pointer), left and right changes the saturation of that colour. A chip by the pointer says
// what a drag will do before you start, and the panel's sliders follow.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp } from './util.js';
import { HSL_NAMES, HSL_HUES } from './params.js';
import { sliderHooks } from './ui.js';

const TONES = [[0.16, 'blacks', 'Blacks'], [0.42, 'shadows', 'Shadows'], [0.75, 'highlights', 'Highlights'], [2, 'whites', 'Whites']];

export function createDirect(app, viewer) {
  const chip = el('div', { class: 'direct-chip', hidden: true });
  viewer.append(chip);
  let drag = null;

  // What's under the pointer, from the small render the histogram keeps (app.small).
  function targets(x, y) {
    const img = app.small, c = app.params?.geometry.crop;
    if (!img || !c || !app.m) return null;
    const [qx, qy] = app.cssToQ(x, y);
    const u = (qx - (c.cx - c.w / 2)) / c.w, v = (qy - (c.cy - c.h / 2)) / c.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const i = (Math.min(img.height - 1, Math.floor(v * img.height)) * img.width + Math.min(img.width - 1, Math.floor(u * img.width))) * 4;
    const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const [, key, label] = TONES.find(([t]) => Y < t);
    const tone = { get: () => app.params[key], set: (n) => { app.params[key] = n; }, label };
    // Hue of the pixel; only colours that are actually coloured get a horizontal control.
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn;
    let color = null;
    if (ch > 0.1) {
      const h = (mx === r ? ((g - b) / ch + 6) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4) * 60;
      const k = HSL_HUES.reduce((best, hh, n) => (Math.min(Math.abs(h - hh), 360 - Math.abs(h - hh)) < Math.min(Math.abs(h - HSL_HUES[best]), 360 - Math.abs(h - HSL_HUES[best])) ? n : best), 0);
      color = { get: () => app.params.hsl.sat[k], set: (n) => { app.params.hsl.sat[k] = n; }, label: `${HSL_NAMES[k]} saturation` };
    }
    return { tone, color, swatch: `rgb(${img.data[i]},${img.data[i + 1]},${img.data[i + 2]})` };
  }

  const show = (x, y, html, swatch) => {
    chip.hidden = false;
    chip.innerHTML = html;
    chip.style.setProperty('--sw', swatch);
    chip.style.transform = `translate(${Math.round(x + 16)}px, ${Math.round(y + 18)}px)`;
  };
  const signed = (n) => (n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`);

  return {
    hover(x, y) {
      const t = targets(x, y);
      if (!t) return this.hide();
      show(x, y, `<i></i><b>↕</b> ${t.tone.label}${t.color ? ` <b>↔</b> ${t.color.label.replace(' saturation', '')}` : ''}`, t.swatch);
    },
    hide() { if (!drag) chip.hidden = true; },
    down(x, y) {
      const t = targets(x, y);
      if (!t) return false;
      drag = { x, y, t, axis: null, start: 0, changed: false };
      sliderHooks.start();
      return true;
    },
    move(x, y) {
      if (!drag) return;
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.axis) {
        if (Math.hypot(dx, dy) < 5) return;
        drag.axis = Math.abs(dx) > Math.abs(dy) && drag.t.color ? 'color' : 'tone';
        drag.start = drag.t[drag.axis].get();
      }
      const target = drag.t[drag.axis];
      const n = clamp(Math.round(drag.start + (drag.axis === 'tone' ? -dy : dx) * 0.4), -100, 100);
      if (n !== target.get()) { target.set(n); drag.changed = true; app.requestRender(); app.refreshPanel(); }
      show(x, y, `<i></i>${target.label} <em>${signed(n)}</em>`, drag.t.swatch);
    },
    up() {
      if (!drag) return;
      const changed = drag.changed;
      drag = null;
      sliderHooks.end();
      chip.hidden = true;
      if (changed) app.commit();
    },
  };
}
