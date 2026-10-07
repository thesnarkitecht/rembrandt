// AI Refocus: brings back detail in soft or out-of-focus photos, up to heavy defocus.
//
// Defocus is modelled as a disc blur. Its size is estimated from the photo's edges (re-blur gradient
// ratio, Zhuo & Sim 2011), measured inside the subject when one is found, and can be set by hand.
// The photo is deconvolved on the GPU with Richardson–Lucy iterations regularised by total variation
// (RL-TV, Dey et al. 2006): the TV term keeps edges sharp and flat areas flat, so many iterations
// can run without the noise and ringing plain RL builds up; each step is over-relaxed (correction
// raised to a power), which roughly halves the iterations needed. The work is done on scene-linear
// luminance at a reduced scale (the blur at most MAX_R pixels across, and a pixel budget: detail
// finer than the blur isn't recoverable anyway), and applied as a luminance gain so colours don't
// fringe. In the editor it runs a few iterations per frame, so the app stays responsive while the
// photo sharpens; an export runs them all at once.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { LIB } from '../../engine/src/shaders.js';
import { ai } from './ai.js';
import { userEditing } from '../jobs.js';
import { prefs } from '../account.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + LIB;

const MAX_R = 6;          // largest blur radius deconvolved directly, in working pixels
const TAPS = 32;
const BUDGET = { view: 0.8e6, export: 4e6 };   // most pixels deconvolved
const PER_FRAME = 4;      // iterations per frame in the editor
const RELAX = 1.4;        // over-relaxation exponent on the RL correction (< 2 stays stable)

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
uniform float uLambda, uRelax;
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
  float e = c * pow(max(discAvg(uRatio, vUv), 1e-3), uRelax) / max(1.0 - uLambda * div, 0.3);
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
// luminance after white balance and dehaze) and is kept, so Light and Color sliders only re-run the
// cheap composite. Its result is a luminance gain, which doesn't depend on exposure. More amount
// means more iterations, continued from where the last ones stopped.
const iterations = (rf) => Math.round(8 + 22 * Math.min(1, rf.amount / 100));
function deconvKey(engine, p) {
  const rf = p.ai.refocus;
  return JSON.stringify([engine.token, engine.L.w, engine.L.h, refocusRadius(p, ai.entry), rf.protect, p.temp, p.tint, p.dehaze]);
}
let tick = 0;   // bumps while iterations are still to run, so the engine renders again

export const refocusPass = {
  wake: null,   // set by the app: asks for another render
  key(p) {
    if (!refocusActive(p)) return '';
    return JSON.stringify([p.ai.refocus, refocusRadius(p, ai.entry), ai.version, !!ai.tex.subject, tick]);
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
    // Deconvolve at 1/k scale: the blur at most MAX_R pixels there, and within the pixel budget.
    // Preview size follows Settings › Performance; exports always use the full budget.
    const budget = engine.exporting ? BUDGET.export : BUDGET.view * ({ smooth: 0.6, fast: 1.6 }[prefs.perf] || 1);
    const kBlur = rFull / MAX_R, kSize = Math.sqrt((L.w * L.h) / budget);
    const k = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(kBlur, kSize))));
    const r = rFull / k, dw = Math.max(1, Math.round(L.w / k)), dh = Math.max(1, Math.round(L.h / k));
    const T = L.T;
    const mk = (n) => { if (!T[n] || T[n].w !== dw || T[n].h !== dh) { engine.free(T[n]); T[n] = engine.target(dw, dh, { fmt: gl.RGBA16F }); } return T[n]; };
    const obs = mk('rfObs'), e1 = mk('rfE1'), e2 = mk('rfE2'), q = mk('rfQ');
    if (!T.rfOut || T.rfOut.mip !== input.mip) { engine.free(T.rfOut); T.rfOut = engine.target(L.w, L.h, { mip: input.mip }); }
    const rf = p.ai.refocus;
    const texel = [1 / dw, 1 / dh];
    const key = deconvKey(engine, p) + `|${k}`;
    const want = iterations(rf);
    let st = L.rf;
    if (!st || st.key !== key || st.done > want) {
      // Start over: new photo, size, blur or noise setting (or fewer iterations than already run).
      const lu = { uIn: T.pre.tex, uInTexel: [1 / L.w, 1 / L.h], uK: k };
      engine.draw(P.luma, lu, obs);
      engine.draw(P.luma, lu, e1);
      st = L.rf = { key, cur: e1, nxt: e2, done: 0 };
    }
    const protect = (rf.protect ?? 30) / 100;
    const noise = 0.003 + protect * 0.03;
    const lambda = 0.001 + protect * 0.01;
    // While you drag or type, one iteration a frame keeps the editor fluid; more when you pause.
    const per = userEditing() || prefs.perf === 'smooth' ? 1 : PER_FRAME;
    const n = engine.exporting ? want - st.done : Math.min(per, want - st.done);
    for (let i = 0; i < n; i++) {
      engine.draw(P.ratio, { uObs: obs.tex, uEst: st.cur.tex, uR: r, uTexel: texel, uNoise: noise }, q);
      engine.draw(P.update, { uEst: st.cur.tex, uRatio: q.tex, uR: r, uTexel: texel, uLambda: lambda, uRelax: RELAX }, st.nxt);
      [st.cur, st.nxt] = [st.nxt, st.cur];
    }
    st.done += n;
    if (st.done < want) { tick++; requestAnimationFrame(() => refocusPass.wake?.()); }
    const scope = { all: 0, subject: 1, background: 2 }[rf.scope] ?? 1;
    engine.draw(P.apply, {
      uIn: input.tex, uObs: obs.tex, uEst: st.cur.tex, uSubj: ai.tex.subject || engine.dummy,
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
