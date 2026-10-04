// Rembrandt Engine — develop settings -> shader uniforms.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// `p` is a plain settings object (see README): exposure (EV), contrast, highlights, shadows, whites,
// blacks, temp, tint, vibrance, saturation, texture, clarity, dehaze, haze (all −100…100), bw,
// hsl {hue,sat,lum}[8], grading {shadows,midtones,highlights,global: {h,s,l}, blending, balance},
// sharpen {amount,radius,masking}, nr {luma,chroma}, vignette {amount,midpoint,roundness,feather},
// grain {amount,size,roughness}, curve {master,r,g,b: [[x,y],…]}.

import { whiteBalance, toGL, hueToOkDir, toneK, REF_CONTRAST } from './color.js';

export const INPUT_UNIFORMS = { uInC: REF_CONTRAST, uInK: toneK(REF_CONTRAST) };

// ------------------------------------------------------------------ PRE / dehaze

export function preUniforms(p, stats) {
  const h = (p.haze || 0) / 100, s = (p.dehaze || 0) / 100;
  const A = stats?.airlight || [1, 1, 1];
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

export const toneActive = (p) => !!(p.blacks || p.shadows || p.highlights || p.whites || p.clarity);

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
    uClarity: p.clarity / 100,
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
  };
}

// ------------------------------------------------------------------ FINAL

export function finalUniforms(p, fullW, fullH, workH, sceneSource) {
  const c = REF_CONTRAST * 2 ** ((p.contrast / 100) * 0.6);
  const ws = workH / fullH;
  return {
    uTC: c,
    uTK: toneK(c),
    // Scene-referred sources get the hue-preserving highlight path; display-referred sources use the
    // exact per-channel inverse, so an untouched JPEG round-trips unchanged.
    uPathToWhite: sceneSource ? 1 : 0,
    uSharp: [p.sharpen.amount / 100, Math.max(0.6, p.sharpen.radius * ws)],
    uSharpMask: p.sharpen.masking / 100,
    uNR: [p.nr.luma / 100, p.nr.chroma / 100],
    uVig: [p.vignette.amount / 100, p.vignette.midpoint / 100, p.vignette.roundness / 100, p.vignette.feather / 100],
    uGrain: [p.grain.amount / 100, (0.5 + (p.grain.size / 100) * 3.5) * Math.max(1, fullH / 4000), p.grain.roughness / 100],
    uFullSize: [fullW, fullH],
    uCropAspect: p.geometry ? p.geometry.crop.w / p.geometry.crop.h : fullW / fullH,
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
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => dark[b] - dark[a]);
  const top = idx.slice(0, Math.max(1, Math.floor(n * 0.001)));
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
export function opticsLut(o, profile) {
  if (!o) return null;
  const use = !!(profile && (o.profile === true || (o.profile === 'auto' && profile.defaultOn)));
  const dAmt = (o.distortion ?? 100) / 100, vAmt = (o.vignetting ?? 100) / 100;
  const md = (o.manualDistortion || 0) / 100, mv = (o.manualVignette || 0) / 100;
  const mid = Math.min(0.9, Math.max(0, (o.manualMidpoint ?? 50) / 100 * 0.8));
  const prof = use ? profile : {};
  const ca = use && o.ca !== false && prof.chromatic;
  if (!(use && (prof.distortion || prof.vignetting || ca)) && !md && !mv) return null;
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
  const fill = 1 / widest;
  return { data, fill, key: `${use ? 1 : 0}|${dAmt}|${vAmt}|${ca ? 1 : 0}|${md}|${mv}|${mid}` };
}
