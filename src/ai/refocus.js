// AI Refocus: brings back detail in soft or out-of-focus photos, up to heavy defocus.
//
// Defocus is modelled as a disc blur. Its size is estimated from the photo's edges (re-blur gradient
// ratio, Zhuo & Sim 2011), measured inside the subject when one is found, and can be set by hand.
// The photo is deconvolved on the GPU with Richardson–Lucy iterations regularised by total variation
// (RL-TV, Dey et al. 2006): the TV term keeps edges sharp and flat areas flat, so many iterations
// can run without the noise and ringing plain RL builds up. The work is done at a scale where the
// blur is at most MAX_R pixels across (a heavily defocused photo has no finer detail to recover), on
// scene-linear luminance, and applied to the photo as a luminance gain so colours don't fringe.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { LIB } from '../../engine/src/shaders.js';
import { ai } from './ai.js';
import { quality } from './lens.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + LIB;

const MAX_R = 12;   // largest blur radius deconvolved directly, in working pixels
const TAPS = 64;

// Uniform disc of radius uR texels, on a golden-angle spiral (equal-area rings).
const DISC = `
uniform float uR;
uniform vec2 uTexel;
float discAvg(sampler2D t, vec2 uv) {
  float acc = 0.0;
  for (int i = 0; i < ${TAPS}; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / ${TAPS}.0) * uR;
    float a = fi * 2.39996323;
    acc += textureLod(t, uv + vec2(cos(a), sin(a)) * rr * uTexel, 0.0).r;
  }
  return acc / ${TAPS}.0;
}
`;

// Scene luminance of the input, box-averaged down by uK (1, 2, 4…) -> r.
const LUMA = HEAD + `
uniform sampler2D uIn;
uniform vec2 uInTexel;
uniform int uK;
in vec2 vUv; out vec4 o;
void main() {
  float acc = 0.0;
  for (int y = 0; y < uK; y++) for (int x = 0; x < uK; x++) {
    vec2 off = (vec2(float(x), float(y)) - 0.5 * float(uK - 1)) * uInTexel;
    acc += lum(textureLod(uIn, vUv + off, 0.0).rgb);
  }
  o = vec4(max(acc / float(uK * uK), 1e-5), 0.0, 0.0, 1.0);
}`;

// ratio = observed / (estimate ⊗ disc). Differences below the noise level count as noise.
const RATIO = HEAD + DISC + `
uniform sampler2D uObs, uEst;
uniform float uNoise;
in vec2 vUv; out vec4 o;
void main() {
  float obs = textureLod(uObs, vUv, 0.0).r;
  float c = max(discAvg(uEst, vUv), 1e-5);
  float d = obs / c - 1.0;
  float w = smoothstep(uNoise * 0.5, uNoise * 1.5, abs(d));
  o = vec4(1.0 + clamp(d, -0.8, 3.0) * w, 0.0, 0.0, 1.0);
}`;

// estimate *= (ratio ⊗ disc) / (1 − λ·div(∇e / |∇e|)), the RL-TV update.
const UPDATE = HEAD + DISC + `
uniform sampler2D uEst, uRatio;
uniform float uLambda;
in vec2 vUv; out vec4 o;
float E(vec2 d) { return textureLod(uEst, vUv + d * uTexel, 0.0).r; }
vec2 nrm(vec2 g, float e) { return g / sqrt(dot(g, g) + (0.002 + 0.03 * e) * (0.002 + 0.03 * e)); }
void main() {
  float c = E(vec2(0)), r = E(vec2(1, 0)), l = E(vec2(-1, 0)), u = E(vec2(0, 1)), d = E(vec2(0, -1));
  float lu = E(vec2(-1, 1)), rd = E(vec2(1, -1));
  vec2 nC = nrm(vec2(r - c, u - c), c);
  vec2 nL = nrm(vec2(c - l, lu - l), l);
  vec2 nD = nrm(vec2(rd - d, c - d), d);
  float div = (nC.x - nL.x) + (nC.y - nD.y);
  float e = c * discAvg(uRatio, vUv) / max(1.0 - uLambda * div, 0.3);
  o = vec4(clamp(e, 1e-5, 64.0), 0.0, 0.0, 1.0);
}`;

// Composite: the gain estimate / observation (bilinear from the deconvolution scale), kept within a
// loose band around the local range so nothing overshoots into halos, applied where the mask says.
const APPLY = HEAD + `
uniform sampler2D uIn, uObs, uEst, uSubj;
uniform vec2 uTexel;
uniform float uR, uAmount;
uniform int uScope; // 0 whole photo, 1 subject, 2 background
in vec2 vUv; out vec4 o;
void main() {
  vec4 src = textureLod(uIn, vUv, 0.0);
  float obs = textureLod(uObs, vUv, 0.0).r;
  float lo = obs, hi = obs;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    float v = textureLod(uObs, vUv + vec2(cos(a), sin(a)) * uR * uTexel, 0.0).r;
    lo = min(lo, v); hi = max(hi, v);
  }
  float e = clamp(textureLod(uEst, vUv, 0.0).r, lo * 0.55, hi * 1.6);
  float m = 1.0;
  if (uScope != 0) {
    float s = textureLod(uSubj, vUv, 0.0).r;
    m = uScope == 1 ? s : 1.0 - s;
  }
  float g = mix(1.0, clamp(e / obs, 0.15, 6.0), uAmount * m);
  o = vec4(src.rgb * g, src.a);
}`;

const programs = new WeakMap();

export const refocusActive = (p) => (p.ai?.refocus?.amount || 0) > 0;

// Blur radius (disc) as a fraction of image height: from settings, or estimated from the photo.
export function refocusRadius(p, entry) {
  const r = p.ai?.refocus?.radius;
  if (r > 0) return r;
  return entry?.ai?.blur?.radiusH || 0.002;
}

// The deconvolution is the expensive part. It runs on the photo before tone edits (scene-linear
// luminance after white balance and dehaze) and is cached, so Light and Color sliders only re-run the
// cheap composite. Its result is a luminance gain, which doesn't depend on exposure. More amount
// means more iterations: heavy defocus needs many.
const iterations = (rf) => (quality.draft ? 6 : Math.round(12 + 48 * Math.min(1, rf.amount / 100)));
function deconvKey(engine, p) {
  const rf = p.ai.refocus;
  return JSON.stringify([engine.token, engine.L.w, engine.L.h, refocusRadius(p, ai.entry), iterations(rf), rf.protect, p.temp, p.tint, p.dehaze]);
}

export const refocusPass = {
  key(p) {
    if (!refocusActive(p)) return '';
    return JSON.stringify([p.ai.refocus, refocusRadius(p, ai.entry), quality.draft, ai.version, !!ai.tex.subject]);
  },
  run(engine, p, ctx, input) {
    if (!refocusActive(p)) return input;
    let P = programs.get(engine);
    if (!P) {
      P = { luma: engine.program(LUMA), ratio: engine.program(RATIO), update: engine.program(UPDATE), apply: engine.program(APPLY) };
      programs.set(engine, P);
    }
    const L = engine.L, gl = engine.gl;
    const rFull = refocusRadius(p, ai.entry) * L.h;
    if (rFull < 0.6) return input;
    // Deconvolve at 1/k scale so the blur is at most MAX_R pixels there.
    const k = 2 ** Math.max(0, Math.ceil(Math.log2(rFull / MAX_R)));
    const r = rFull / k, dw = Math.max(1, Math.round(L.w / k)), dh = Math.max(1, Math.round(L.h / k));
    const T = L.T;
    const mk = (n) => { if (!T[n] || T[n].w !== dw || T[n].h !== dh) { engine.free(T[n]); T[n] = engine.target(dw, dh, { fmt: gl.RGBA16F }); } return T[n]; };
    const obs = mk('rfObs'), e1 = mk('rfE1'), e2 = mk('rfE2'), q = mk('rfQ');
    if (!T.rfOut || T.rfOut.mip !== input.mip) { engine.free(T.rfOut); T.rfOut = engine.target(L.w, L.h, { mip: input.mip }); }
    const rf = p.ai.refocus;
    const texel = [1 / dw, 1 / dh];
    const key = deconvKey(engine, p);
    if (L.rfKey !== key || !L.rfEst) {
      const lu = { uIn: T.pre.tex, uInTexel: [1 / L.w, 1 / L.h], uK: k };
      engine.draw(P.luma, lu, obs);
      engine.draw(P.luma, lu, e1);
      const protect = (rf.protect ?? 30) / 100;
      const noise = 0.003 + protect * 0.03;
      const lambda = 0.001 + protect * 0.01;
      let cur = e1, nxt = e2;
      for (let i = 0, n = iterations(rf); i < n; i++) {
        engine.draw(P.ratio, { uObs: obs.tex, uEst: cur.tex, uR: r, uTexel: texel, uNoise: noise }, q);
        engine.draw(P.update, { uEst: cur.tex, uRatio: q.tex, uR: r, uTexel: texel, uLambda: lambda }, nxt);
        [cur, nxt] = [nxt, cur];
      }
      L.rfEst = cur;
      L.rfKey = key;
    }
    const scope = { all: 0, subject: 1, background: 2 }[rf.scope] ?? 1;
    engine.draw(P.apply, {
      uIn: input.tex, uObs: obs.tex, uEst: L.rfEst.tex, uSubj: ai.tex.subject || engine.dummy,
      uTexel: texel, uR: r, uAmount: Math.min(1, 0.35 + rf.amount / 100), uScope: ai.tex.subject ? scope : 0,
    }, T.rfOut);
    return T.rfOut;
  },
};

// ------------------------------------------------------------------ blur estimation (CPU)

function gray(sample) {
  const { data, w, h } = sample;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4] / 255, gg = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    g[i] = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  }
  return g;
}
function gaussBlur(src, w, h, s) {
  const rad = Math.ceil(s * 3), k = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += k[i + rad] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -rad; i <= rad; i++) a += k[i + rad] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}
const gradMag = (g, w, h, x, y) => {
  const i = y * w + x;
  const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
  return Math.hypot(gx, gy) * 0.5;
};

// Estimates the defocus of the sharpest meaningful edges in the subject (or the whole image).
// Returns { sigma (sample px), radiusH (disc radius as a fraction of image height), edges }.
export function estimateBlur(sample, subject) {
  const { w, h } = sample;
  const g = gray(sample);
  // Re-blur at 2.5 px: large enough that heavy defocus still changes the gradients measurably.
  const s0 = 2.5;
  const gb = gaussBlur(g, w, h, s0);
  const sub = subject ? (x, y) => subject.data[Math.min(subject.h - 1, Math.floor((y / h) * subject.h)) * subject.w + Math.min(subject.w - 1, Math.floor((x / w) * subject.w))] : () => 1;
  const cand = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const m = gradMag(g, w, h, x, y);
      if (m < 0.02 || sub(x, y) < 0.5) continue;
      // non-maximum along the gradient: keep local maxima only
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      const n = Math.hypot(gx, gy) || 1;
      const dx = Math.round(gx / n), dy = Math.round(gy / n);
      if (gradMag(g, w, h, x + dx, y + dy) > m || gradMag(g, w, h, x - dx, y - dy) > m) continue;
      const mb = gradMag(gb, w, h, x, y);
      const R = m / Math.max(mb, 1e-6);
      if (R <= 1.002) continue;
      cand.push({ m, sigma: s0 / Math.sqrt(R * R - 1) });
    }
  }
  if (cand.length < 30) return { sigma: 0.8, radiusH: (2 * 0.8) / h, edges: cand.length };
  // The gradient ratio assumes Gaussian blur; for a disc (real defocus) it reads about 0.67× the radius
  // as 2σ. Calibrated on disc-blurred photos to land at ~0.92× the true radius: a disc that is too
  // large rings, one a little too small is only less sharp.
  // The strongest edges are the most reliable; the lower quartile of their blur is the in-focus part.
  cand.sort((a, b) => b.m - a.m);
  const top = cand.slice(0, Math.max(30, Math.floor(cand.length * 0.2))).map((c) => c.sigma).sort((a, b) => a - b);
  const sigma = Math.min(24, Math.max(0.4, top[Math.floor(top.length * 0.3)]));
  return { sigma, radiusH: (2.45 * sigma) / h, edges: cand.length };
}
