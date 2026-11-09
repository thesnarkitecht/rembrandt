// Rembrandt Engine — develop settings -> shader uniforms.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// `p` is a plain settings object (see README): exposure (EV), contrast, highlights, shadows, whites,
// blacks, temp, tint, vibrance, saturation, texture, clarity, dehaze, haze (all −100…100), bw,
// hsl {hue,sat,lum}[8], grading {shadows,midtones,highlights,global: {h,s,l}, blending, balance},
// sharpen {amount,radius,masking}, nr {luma,chroma}, vignette {amount,midpoint,roundness,feather},
// grain {amount,size,roughness}, curve {master,r,g,b: [[x,y],…]}.

import { whiteBalance, toGL, hueToOkDir, toneK, REF_CONTRAST, SCENE_CONTRAST, sceneWhiteGain } from './color.js';

export const INPUT_UNIFORMS = { uInC: REF_CONTRAST, uInK: toneK(REF_CONTRAST) };

// ------------------------------------------------------------------ PRE / dehaze

export function preUniforms(p, stats) {
  const h = (p.haze || 0) / 100, s = (p.dehaze || 0) / 100;
  const A = ((h || s) && stats?.airlight) || [1, 1, 1];   // read only when dehaze is on (the host works it out lazily)
  return {
    uExposure: 2 ** (p.exposure || 0),
    uMap: h || s ? 1 : 0,   // both read one transmission map, estimated at full strength
    uA: A,
    // Haze (the first dehaze, kept for its look): ω in He et al. scaled from 0.25, or a veil added.
    uHaze: h > 0 ? 1 : h < 0 ? 2 : 0,
    uOmega: h > 0 ? 0.25 + 0.7 * h : 0.9,
    uHazeAdd: Math.max(0, -h) * 0.55,
    // Dehaze: removes the haze the model finds (most of it by +60), keeping the photo's brightness.
    uDehaze: s,
  };
}

// ------------------------------------------------------------------ MAIN

export const hdrActive = (p) => !!(p.hdr && (p.hdr.amount || p.hdr.detail));
export const toneActive = (p) => !!(p.blacks || p.shadows || p.highlights || p.whites || p.clarity) || hdrActive(p);

// Tone zone shapes over displayed lightness (see ZONES in shaders.js): [centre, width below, width
// above (−1 = flat to that end)] for raising, [EV at +100, EV at −100], and the window for lowering
// (Camera Raw moves different tones up than down: Shadows +100 opens the deepest shadows, −100 sinks
// the lower mid-tones). Fitted to Camera Raw's renders of the test charts (how far each slider moves
// each tone), then checked for smooth, never-reversing ramps.
export const ZONE_SHAPES = {
  blacks: [[0.125, -1, 0.56], [0.75, 2.075], [0.142, -1, 0.376]],
  // Shadows and Highlights stop short of the closest fit (centre 0.02, 1.9 EV; lowering centre 0.97),
  // which made steps in smooth gradients and hue drift at ±100.
  shadows: [[0.18, -1, 0.8], [1.45, 1.15], [0.215, -1, 0.891]],
  highlights: [[0.73, 0.855, -1], [1.275, 1.625], [0.715, 0.72, -1]],
  whites: [[0.723, 0.503, -1], [0.875, 0.562], [0.65, 0.406, -1]],
};
const ZONE_ORDER = ['blacks', 'shadows', 'highlights', 'whites'];

// HDR: [how much the shadows open, how much the highlights come down, detail kept on top]. Balance
// leans the strength toward the shadows (−100) or the highlights (+100).
function hdrUniform(h) {
  if (!h) return [0, 0, 0];
  const a = (h.amount || 0) / 100, b = (h.balance || 0) / 100;
  return [a * 0.62 * (1 - Math.max(0, b)), a * 0.55 * (1 + Math.min(0, b)), (h.detail || 0) / 100 * 0.55];
}

export function mainUniforms(p) {
  const hsl = p.hsl || { hue: [], sat: [], lum: [] };
  const mixOn = [hsl.hue, hsl.sat, hsl.lum].some((a) => a.some(Boolean));
  const g = p.grading;
  const zone = (z) => {
    const [a, b] = hueToOkDir(z.h);
    const c = (z.s / 100) * 0.1;
    return [a * c, b * c, z.l / 100];
  };
  const gradeOn = ['shadows', 'midtones', 'highlights', 'global'].some((k) => g[k].s || g[k].l);
  return {
    uGuideOn: toneActive(p) ? 1 : 0,
    uTone: [p.blacks / 100, p.shadows / 100, p.highlights / 100, p.whites / 100],
    uZoneW: new Float32Array(ZONE_ORDER.flatMap((k) => [...ZONE_SHAPES[k][0], 0])),
    uZoneWn: new Float32Array(ZONE_ORDER.flatMap((k) => [...(ZONE_SHAPES[k][2] || ZONE_SHAPES[k][0]), 0])),
    uZoneA: new Float32Array(ZONE_ORDER.flatMap((k) => ZONE_SHAPES[k][1])),
    uClarity: p.clarity / 100,
    uHdr: hdrUniform(p.hdr),
    uTexture: p.texture / 100,
    uWBOn: p.temp || p.tint ? 1 : 0,
    uWB: toGL(whiteBalance(p.temp, p.tint)),
    uVib: p.vibrance / 100,
    uSat: p.saturation / 100,
    uMixOn: mixOn ? 1 : 0,
    uMixHue: new Float32Array(hsl.hue.map((v) => v / 100)),
    uMixSat: new Float32Array(hsl.sat.map((v) => v / 100)),
    uMixLum: new Float32Array(hsl.lum.map((v) => v / 100)),
    uGradeOn: gradeOn ? 1 : 0,
    uGS: zone(g.shadows), uGM: zone(g.midtones), uGH: zone(g.highlights), uGG: zone(g.global),
    uGBalance: g.balance / 100,
    uGBlend: g.blending / 100,
    uBW: p.bw ? 1 : 0,
    ...pointColorUniforms(p.pointColor),
    uProbe: 0,
  };
}

// Point Color: [{ L, a, b (the picked Oklab colour), hue (−100…100: ±30°), sat, lum (−100…100),
// range (0…100) }], at most 8; points that change nothing are left out.
export const POINT_COLORS_MAX = 8;
function pointColorUniforms(list) {
  const pts = (list || []).filter((c) => c.hue || c.sat || c.lum).slice(0, POINT_COLORS_MAX);
  const col = new Float32Array(24), adj = new Float32Array(32);
  pts.forEach((c, i) => {
    col.set([c.L, c.a, c.b], i * 3);
    adj.set([(c.hue / 100) * 30, c.sat / 100, c.lum / 100, (c.range ?? 50) / 100], i * 4);
  });
  return { uPCn: pts.length, uPCcol: col, uPCadj: adj };
}

// ------------------------------------------------------------------ FINAL

export function finalUniforms(p, fullW, fullH, workH, sceneSource) {
  // Negative contrast flattens less steeply: below c ≈ 1 the curve's slope at black is unbounded, and
  // near-black then jumps (a visible step at the foot of dark gradients).
  const c = (sceneSource ? SCENE_CONTRAST : REF_CONTRAST) * 2 ** ((p.contrast / 100) * (p.contrast < 0 ? 0.48 : 0.6));
  const ws = workH / fullH;
  return {
    uTC: c,
    uTK: toneK(c),
    uTW: sceneSource ? sceneWhiteGain(c) : 1,
    // Scene-referred sources get the hue-preserving highlight path; display-referred sources use the
    // exact per-channel inverse, so an untouched JPEG round-trips unchanged.
    uPathToWhite: sceneSource ? 1 : 0,
    uSharp: [p.sharpen.amount / 100, Math.max(0.6, p.sharpen.radius * ws)],
    uSharpMask: p.sharpen.masking / 100,
    uNR: [p.nr.luma / 100, p.nr.chroma / 100],
    uSpeckle: (p.nr.speckle || 0) / 100,
    uVig: [p.vignette.amount / 100, p.vignette.midpoint / 100, p.vignette.roundness / 100, p.vignette.feather / 100],
    uGrain: [p.grain.amount / 100, (0.5 + (p.grain.size / 100) * 3.5) * Math.max(1, fullH / 4000), p.grain.roughness / 100],
    uFullSize: [fullW, fullH],
    uCropAspect: p.geometry ? p.geometry.crop.w / p.geometry.crop.h : fullW / fullH,
    // The learned camera look (Match my camera), RAWs only; `_camLook` is set by the app.
    ...(sceneSource && p._camLook ? { uCamOn: 1, uCamL: p._camLook.L, uCamGain: p._camLook.gain, uCamShift: p._camLook.shift } : { uCamOn: 0 }),
    // The profile (RAWs): Rembrandt Color unless Standard is chosen; Match my camera takes its place.
    uProfile: sceneSource && p.profile !== 'standard' ? 1 : 0,
  };
}

// ------------------------------------------------------------------ tone curve

export function curveIsIdentity(curve) {
  return ['master', 'r', 'g', 'b'].every((k) => {
    const c = curve[k];
    return c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
  });
}

// Fritsch–Carlson monotone cubic interpolation.
export function curveFn(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  if (n === 2) {
    return (x) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[1]) return ys[1];
      return ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / Math.max(xs[1] - xs[0], 1e-6);
    };
  }
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(xs[i + 1] - xs[i], 1e-6);
    m[i] = (ys[i + 1] - ys[i]) / dx[i];
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i], u = (x - xs[i]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * t[i + 1];
  };
}

// 256 x 1 RGBA: r, g, b channel curves and the master curve in alpha.
export function curveLUT(curve) {
  const out = new Float32Array(256 * 4);
  const fs = ['r', 'g', 'b', 'master'].map((k) => curveFn(curve[k]));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.min(1, Math.max(0, fs[c](x)));
  }
  return out;
}

// ------------------------------------------------------------------ image statistics

// Airlight for dehazing (He et al. 2009): among the 0.1 % pixels with the brightest dark channel
// (after a small min filter), take the brightest. `rgb` is scene-linear Rec.2020, interleaved.
export function estimateAirlight(rgb, w, h, radius = 2) {
  const n = w * h;
  const dark = new Float32Array(n), tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) dark[i] = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let k = -radius; k <= radius; k++) m = Math.min(m, dark[y * w + cl(x + k, w - 1)]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let k = -radius; k <= radius; k++) m = Math.min(m, tmp[cl(y + k, h - 1) * w + x]);
    dark[y * w + x] = m;
  }
  // The 0.1 % brightest: threshold from a native typed-array sort, no index array or comparator.
  const k = Math.max(1, Math.floor(n * 0.001));
  const t = Float32Array.from(dark).sort()[n - k];
  const top = [];
  for (let i = 0; i < n && top.length < k; i++) if (dark[i] >= t) top.push(i);
  let best = top[0], bestSum = -1;
  for (const i of top) {
    const s = rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2];
    if (s > bestSum) { bestSum = s; best = i; }
  }
  // Average a little around the choice to avoid a single noisy pixel.
  const A = [0, 0, 0];
  let cnt = 0;
  for (const i of top) {
    const s = rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2];
    if (s >= bestSum * 0.9) { A[0] += rgb[i * 3]; A[1] += rgb[i * 3 + 1]; A[2] += rgb[i * 3 + 2]; cnt++; }
  }
  return A.map((v) => Math.max(cnt ? v / cnt : rgb[best * 3], 1e-3));
}

// ---------------------------------------------------------------- lens corrections
// A radial function sampled at increasing radii (0 = centre, 1 = half the diagonal); linear in
// between, constant beyond the ends. (Model after RAWmakase, MIT; see NOTICE.md.)
export function radialEval(f, r) {
  const k = f.knots, v = f.values;
  if (r <= k[0]) return v[0];
  for (let i = 1; i < k.length; i++) if (r < k[i]) return v[i - 1] + (v[i] - v[i - 1]) * ((r - k[i - 1]) / (k[i] - k[i - 1]));
  return v[v.length - 1];
}

// The lens-correction lookup for the LENS pass, or null when nothing changes the photo.
// o: p.optics = { profile: 'auto' | true | false, distortion, vignetting, ca, manualDistortion, manualVignette, manualMidpoint }
// profile: the camera's built-in correction { vignetting, distortion, chromatic: [red, blue] } or null.
// Returns { data: Float32Array(33 * 4), fill, key }.
// Full Vertical / Horizontal (±100): how strong the keystone is, in the homography's units.
export const PERSP = 0.5;

export function opticsLut(o, profile, aspect = 1.5) {
  if (!o) return null;
  const use = !!(profile && (o.profile === true || (o.profile === 'auto' && profile.defaultOn)));
  const dAmt = (o.distortion ?? 100) / 100, vAmt = (o.vignetting ?? 100) / 100;
  const md = (o.manualDistortion || 0) / 100, mv = (o.manualVignette || 0) / 100;
  const mid = Math.min(0.9, Math.max(0, (o.manualMidpoint ?? 50) / 100 * 0.8));
  const prof = use ? profile : {};
  const ca = use && o.ca !== false && prof.chromatic;
  // Perspective (Transform › Vertical / Horizontal): keystone as a homography on centred coordinates
  // in half-heights, applied before the lens correction. Positive Vertical straightens verticals that
  // lean in towards the top (camera tilted up).
  const kv = -(o.vertical || 0) / 100 * PERSP, kh = -(o.horizontal || 0) / 100 * PERSP;
  if (!(use && (prof.distortion || prof.vignetting || ca)) && !md && !mv && !kv && !kh) return null;
  const data = new Float32Array(33 * 4);
  let widest = 1;
  for (let i = 0; i <= 32; i++) {
    const r = i / 32;
    // Vignetting: the camera's gain (scaled in stops by its amount) times the manual gain.
    const pg = use && prof.vignetting ? radialEval(prof.vignetting, r) : 1;
    const ramp = Math.min(1, Math.max(0, (r - mid) / (1 - mid))) ** 2;
    const vig = pg ** vAmt * 2 ** (mv * 1.2 * ramp);
    // Distortion: sample farther out (> 1) to correct barrel, closer in (< 1) for pincushion.
    const pd = use && prof.distortion ? 1 + (radialEval(prof.distortion, r) - 1) * dAmt : 1;
    const g = pd * (1 + md * 0.15 * r * r);
    const red = ca ? radialEval(prof.chromatic[0], r) : 1;
    const blue = ca ? radialEval(prof.chromatic[1], r) : 1;
    data.set([vig, g, red, blue], i * 4);
    widest = Math.max(widest, g * red, g, g * blue);
  }
  // Fill: scale the output so every corrected corner samples inside the photo (Lightroom crops the
  // empty border the same way).
  let fill = 1 / widest;
  const persp = [1, 0, kh, 0, 1, kv, 0, 0, 1];   // GLSL mat3, column by column: w = kh·x + kv·y + 1
  if (kv || kh) {
    // The largest fill whose frame corners and edge midpoints, through the perspective and the lens
    // correction, still sample inside the photo.
    const reach = (r) => { const i = Math.min(32, Math.max(0, r * 32)), j = Math.floor(i), k = Math.min(32, j + 1), t = i - j; const at = (n, c) => data[n * 4 + c]; const g = at(j, 1) * (1 - t) + at(k, 1) * t; return g * Math.max(1, at(j, 2), at(j, 3)); };
    const ok = (f) => [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].every(([cx, cy]) => {
      const x = cx * aspect * f, y = cy * f, w = kh * x + kv * y + 1;
      if (w <= 0.05) return false;
      const sx = x / w, sy = y / w, g = reach(Math.hypot(sx, sy) / Math.hypot(aspect, 1));
      return Math.abs(sx * g) <= aspect + 1e-6 && Math.abs(sy * g) <= 1 + 1e-6;
    });
    let lo = 0.2, hi = 1;
    for (let n = 0; n < 30; n++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    fill = lo;
  }
  return { data, fill, persp, key: `${use ? 1 : 0}|${dAmt}|${vAmt}|${ca ? 1 : 0}|${md}|${mv}|${mid}|${kv}|${kh}|${aspect.toFixed(4)}` };
}
