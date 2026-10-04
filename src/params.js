// Edit settings model, defaults and built-in presets.
import { uid, clone, deepMerge, nextVersion } from './util.js';

export const HSL_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Lavender', 'Magenta'];
export const HSL_HUES = [0, 30, 55, 120, 180, 225, 270, 315];

export const ident = () => [[0, 0], [1, 1]];

export function defaultGeometry(aspect = 1.5) {
  return {
    angle: 0, rot90: 0, flipH: false, flipV: false,
    aspect: 'original',
    crop: { cx: 0, cy: 0, w: aspect, h: 1 },
    cropAuto: true,
  };
}

export function defaultParams(aspect = 1.5) {
  return {
    v: 1,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temp: 0, tint: 0, vibrance: 0, saturation: 0, bw: false,
    texture: 0, clarity: 0, dehaze: 0, haze: 0,
    vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50 },
    grain: { amount: 0, size: 25, roughness: 50 },
    curve: { master: ident(), r: ident(), g: ident(), b: ident() },
    hsl: { hue: Array(8).fill(0), sat: Array(8).fill(0), lum: Array(8).fill(0) },
    grading: {
      shadows: { h: 220, s: 0, l: 0 },
      midtones: { h: 30, s: 0, l: 0 },
      highlights: { h: 45, s: 0, l: 0 },
      global: { h: 30, s: 0, l: 0 },
      blending: 50, balance: 0,
    },
    sharpen: { amount: 0, radius: 1.0, masking: 0 },
    nr: { luma: 0, chroma: 0 },
    // Lens corrections. profile: 'auto' (the camera's built-in table where Lightroom uses it), true, false.
    optics: { profile: 'auto', distortion: 100, vignetting: 100, ca: true, manualDistortion: 0, manualVignette: 0, manualMidpoint: 50 },
    // Spot removal (Heal / Clone), applied to the source in order; see src/retouch.js.
    retouch: [],
    ai: {
      refocus: { amount: 0, radius: -1, scope: 'subject', protect: 30 },
      blur: { amount: 0, focus: -1, range: 12, bokeh: 0, protect: true, sharpen: 0, blades: 0, catseye: 0 },
      enhance: { amount: 0 },
      relight: { near: 0, far: 0, boundary: 50, warmth: 0 },
      sky: { deepen: 0, warmth: 0, saturation: 0 },
      atmos: { amount: 0, warmth: 0, lift: 30, depth: 50 },
      rays: { amount: 0, x: 0.72, y: 0.18, length: 50, warmth: 40 },
      skin: { amount: 0 },
      motion: { amount: 0, angle: 0, protect: true },
      bg: { mode: 'none', color: '#e9e6e1', image: null, blur: 0 },
    },
    off: {},  // adjustment groups switched off (see GROUPS)
    geometry: defaultGeometry(aspect),
    masks: [],
  };
}

// Adjustment groups that can be switched off as a whole from their section header.
export const GROUPS = {
  light: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  color: ['temp', 'tint', 'vibrance', 'saturation', 'bw'],
  effects: ['texture', 'clarity', 'dehaze', 'haze', 'vignette', 'grain'],
  curve: ['curve'],
  mixer: ['hsl'],
  grading: ['grading'],
  detail: ['sharpen', 'nr'],
  optics: ['optics'],
  retouch: ['retouch'],
  refocus: ['ai.refocus'],
  lens: ['ai.blur'],
  background: ['ai.bg'],
  enhance: ['ai.enhance'], relight: ['ai.relight'], sky: ['ai.sky'], atmos: ['ai.atmos'], rays: ['ai.rays'], skin: ['ai.skin'], motion: ['ai.motion'],
  masks: ['masks'],
};

// The settings as rendered: groups that are switched off fall back to their defaults.
const effCache = new WeakMap();
export function effectiveParams(p) {
  if (!p?.off || !Object.values(p.off).some(Boolean)) return p;
  const hit = effCache.get(p);
  if (hit && hit.key === JSON.stringify(p)) return hit.value;
  const d = defaultParams();
  const out = { ...p, ai: p.ai ? { ...p.ai } : p.ai };
  for (const [g, paths] of Object.entries(GROUPS)) {
    if (!p.off[g]) continue;
    for (const path of paths) {
      const [a, b] = path.split('.');
      if (b) out[a] = { ...out[a], [b]: clone(d[a][b]) };
      else out[a] = clone(d[a]);
    }
  }
  effCache.set(p, { key: JSON.stringify(p), value: out });
  return out;
}

export function maskAdjDefaults() {
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temp: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0, hue: 30, tintAmt: 0,
  };
}

export const COMP_LABELS = {
  brush: 'Brush', linear: 'Linear gradient', radial: 'Radial gradient',
  color: 'Color range', luminance: 'Luminance range', all: 'Entire image',
  subject: 'Subject', background: 'Background', object: 'Object', depth: 'Depth range',
};

export function newComponent(type, aspect = 1.5, mode = 'add') {
  const base = { id: uid(), type, mode, invert: false };
  switch (type) {
    case 'linear': return { ...base, x0: 0, y0: -0.42, x1: 0, y1: -0.05 };
    case 'radial': return { ...base, cx: 0, cy: 0, rx: Math.min(0.32, aspect * 0.28), ry: 0.24, angle: 0, feather: 50 };
    case 'luminance': return { ...base, lo: 60, hi: 100, feather: 12 };
    case 'color': return { ...base, a: 0, b: 0, L: 0.6, tol: 30, feather: 40, picked: false };
    case 'subject': return base;
    case 'background': return { ...base, type: 'subject', invert: true };
    case 'object': return { ...base, point: null };
    case 'depth': return { ...base, near: 100, far: 55, feather: 15 };
    default: return base;
  }
}

export function newMask(type, aspect, index) {
  return {
    id: uid(),
    name: `Mask ${index}`,
    visible: true,
    amount: 100,
    comps: [newComponent(type, aspect)],
    brush: { strokes: [], v: nextVersion() },
    adj: maskAdjDefaults(),
  };
}

export function maskHasEffect(m) {
  const d = maskAdjDefaults();
  return Object.keys(d).some((k) => k !== 'hue' && m.adj[k] !== d[k]);
}

// Everything that is not geometry / masks.
export function developSettings(p) {
  const s = clone(p);
  delete s.off;
  // Focus point and background picture belong to one photo.
  if (s.ai) { s.ai.blur.focus = -1; if (s.ai.bg.mode === 'image') s.ai.bg = { ...s.ai.bg, mode: 'none', image: null }; }
  delete s.geometry;
  delete s.masks;
  return s;
}

export function withSettings(p, settings, aspect) {
  const next = deepMerge(defaultParams(aspect), settings);
  next.geometry = clone(p.geometry);
  next.masks = clone(p.masks);
  return next;
}

const C = (pts) => pts;

export const PRESETS = [
  { group: 'Color', name: 'Natural', settings: { contrast: 8, highlights: -12, shadows: 12, vibrance: 14, clarity: 6 } },
  { group: 'Color', name: 'Vivid', settings: { contrast: 18, vibrance: 34, saturation: 6, clarity: 12, dehaze: 6, highlights: -10 } },
  { group: 'Color', name: 'Landscape Pop', settings: { highlights: -35, shadows: 28, clarity: 22, dehaze: 14, vibrance: 26, hsl: { sat: [0, 0, 6, 12, 10, 14, 0, 0], lum: [0, 0, 0, 0, 0, -12, 0, 0] } } },
  { group: 'Color', name: 'Portrait Glow', settings: { exposure: 0.1, highlights: -14, shadows: 16, texture: -22, clarity: -10, vibrance: 8, temp: 4, hsl: { lum: [0, 10, 0, 0, 0, 0, 0, 0], sat: [0, -6, 0, 0, 0, 0, 0, 0] } } },
  { group: 'Mood', name: 'Golden Hour', settings: { temp: 22, tint: 4, vibrance: 12, highlights: -15, grading: { highlights: { h: 40, s: 24, l: 0 }, shadows: { h: 15, s: 10, l: 0 } }, vignette: { amount: -12 } } },
  { group: 'Mood', name: 'Cool Morning', settings: { temp: -16, tint: -2, highlights: -18, shadows: 10, grading: { shadows: { h: 205, s: 18, l: 0 }, highlights: { h: 50, s: 6, l: 0 } } } },
  { group: 'Mood', name: 'Moody', settings: { exposure: -0.25, contrast: 22, highlights: -32, shadows: -8, saturation: -16, clarity: 14, vignette: { amount: -28 }, grading: { shadows: { h: 200, s: 18, l: -6 }, highlights: { h: 38, s: 8, l: 0 } } } },
  { group: 'Mood', name: 'Teal & Orange', settings: { contrast: 12, vibrance: 10, grading: { shadows: { h: 190, s: 32, l: 0 }, highlights: { h: 32, s: 26, l: 0 }, balance: 10 }, hsl: { hue: [0, -8, 0, 30, 0, -10, 0, 0], sat: [0, 10, -10, -30, 10, 10, 0, 0] } } },
  { group: 'Film', name: 'Soft Matte', settings: { contrast: -12, highlights: -10, saturation: -10, curve: { master: C([[0, 0.07], [0.28, 0.26], [0.75, 0.78], [1, 0.95]]) }, grain: { amount: 12 } } },
  { group: 'Film', name: 'Faded Film', settings: { contrast: -6, temp: 6, saturation: -14, curve: { master: C([[0, 0.1], [0.5, 0.5], [1, 0.92]]), b: C([[0, 0.06], [1, 0.95]]) }, grading: { shadows: { h: 200, s: 12, l: 0 } }, grain: { amount: 26, size: 30 }, vignette: { amount: -10 } } },
  { group: 'Film', name: 'Chrome', settings: { contrast: 24, saturation: -8, vibrance: 10, highlights: -20, hsl: { sat: [10, -10, -12, -10, 0, 12, 0, 0], lum: [-6, 0, 0, -8, 0, -10, 0, 0] }, grain: { amount: 10 } } },
  { group: 'B&W', name: 'B&W Classic', settings: { bw: true, contrast: 14, clarity: 8 } },
  { group: 'B&W', name: 'B&W High Contrast', settings: { bw: true, contrast: 46, clarity: 26, blacks: -22, whites: 18, hsl: { lum: [0, 0, 0, 0, 0, -45, 0, 0] }, grain: { amount: 14 } } },
  { group: 'B&W', name: 'B&W Soft', settings: { bw: true, contrast: -12, highlights: -22, shadows: 22, curve: { master: C([[0, 0.05], [1, 0.97]]) }, grain: { amount: 10 } } },
];

export function aspectRatioOf(g, imgAspect) {
  const natural = g.rot90 % 2 ? 1 / imgAspect : imgAspect;
  if (g.aspect === 'original') return natural;
  if (g.aspect === 'free') return null;
  const [a, b] = g.aspect.split(':').map(Number);
  return a / b;
}
