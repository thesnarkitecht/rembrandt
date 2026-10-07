// The photo's own tonal starting point, measured from its unedited preview: the exposure that puts
// its mid-tones at middle grey, and the highlight, shadow, white, black and contrast corrections that
// fit its range. Auto applies it; adaptive presets put their look on top of it, so the same preset
// lands at the same result on a dark photo and a bright one.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { clamp, srgbToLinear } from './util.js';
import { toneInv, MIDDLE_GREY as GREY } from '../engine/src/color.js';

// `sample`: { data (RGBA bytes), w, h } of the photo with no edits.
export function toneBase(sample) {
  const evs = [];
  const step = Math.max(1, Math.floor((sample.w * sample.h) / 60000)) * 4;
  for (let i = 0; i < sample.data.length; i += step) {
    const d = sample.data;
    const Y = 0.2126 * srgbToLinear(d[i] / 255) + 0.7152 * srgbToLinear(d[i + 1] / 255) + 0.0722 * srgbToLinear(d[i + 2] / 255);
    evs.push(Math.log2(Math.max(toneInv(Y), 1e-5) / GREY));
  }
  evs.sort((a, b) => a - b);
  const q = (t) => evs[Math.min(evs.length - 1, Math.floor(t * evs.length))];
  const med = q(0.5), lo = q(0.02), hi = q(0.98);
  const exposure = Math.round(clamp((-0.25 - med) * 0.75, -2.5, 2.5) * 100) / 100;
  const h2 = hi + exposure, l2 = lo + exposure;
  return {
    exposure,
    highlights: h2 > 2.8 ? -Math.round(clamp((h2 - 2.8) * 30, 0, 70)) : 0,
    whites: h2 < 1.8 ? Math.round(clamp((1.8 - h2) * 25, 0, 40)) : 0,
    shadows: l2 < -4.2 ? Math.round(clamp((-4.2 - l2) * 18, 0, 55)) : 0,
    blacks: l2 > -3.2 ? -Math.round(clamp((l2 + 3.2) * 20, 0, 40)) : 0,
    contrast: hi - lo < 5.5 ? Math.round(clamp((5.5 - (hi - lo)) * 9, 0, 30)) : 0,
  };
}

// Tone settings of a preset placed on top of the photo's base (adds; the rest of the preset as is).
export function adapt(settings, base) {
  if (!base) return settings;
  const out = { ...settings };
  out.exposure = Math.round(clamp((settings.exposure || 0) + base.exposure, -5, 5) * 100) / 100;
  for (const k of ['highlights', 'shadows', 'whites', 'blacks', 'contrast']) out[k] = clamp((settings[k] || 0) + base[k], -100, 100);
  return out;
}
