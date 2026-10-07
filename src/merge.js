// Merging several photos into one: HDR (brackets of exposure), focus stacking (frames focused at
// different distances) and panoramas. Pure functions over linear frames, run in merge-worker.js.
//
// Frames are { w, h, data: Uint16Array RGBA half floats, linear, sRGB primaries } as the RAW decoder
// makes them. The result is a linear 16-bit DNG (writeDNG), which opens like any RAW: every edit,
// highlight recovery and the full latitude of the merge stay available.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// ------------------------------------------------------------------ basics

export const H2F = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? 0 : s * 65504) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Linear luminance on a grid `f` times smaller than the frame.
export function luma(frame, f = 1) {
  const { w, h, data } = frame;
  const gw = Math.floor(w / f), gh = Math.floor(h / f);
  const g = new Float32Array(gw * gh);
  const st = Math.max(1, f >> 1);
  let n = 0;
  for (let yy = 0; yy < f; yy += st) for (let xx = 0; xx < f; xx += st) n++;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy += st) {
        const row = (y * f + yy) * w + x * f;
        for (let xx = 0; xx < f; xx += st) {
          const i = (row + xx) * 4;
          s += 0.2126 * H2F[data[i]] + 0.7152 * H2F[data[i + 1]] + 0.0722 * H2F[data[i + 2]];
        }
      }
      g[y * gw + x] = s / n;
    }
  }
  return { g, w: gw, h: gh };
}

function halve({ g, w, h }) {
  const W = w >> 1, H = h >> 1, o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * W + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
  }
  return { g: o, w: W, h: H };
}

function boxBlur(g, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += g[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[row + x] = s / (2 * r + 1);
      s += g[row + Math.min(w - 1, x + r + 1)] - g[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / (2 * r + 1);
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

// ------------------------------------------------------------------ alignment
// Median threshold bitmaps (Ward 2003): each picture split at its own median, so frames of very
// different exposure still line up. Searched coarse to fine over a pyramid.

function mtb({ g, w, h }) {
  const s = Float32Array.from(g).sort();
  const med = s[s.length >> 1] || 1e-6;
  const t = new Uint8Array(w * h), e = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) {
    t[i] = g[i] > med ? 1 : 0;
    e[i] = Math.abs(Math.log((g[i] + 1e-6) / (med + 1e-6))) > 0.08 ? 1 : 0;
  }
  return { t, e, w, h };
}

function mtbError(A, B, dx, dy) {
  const { w, h } = A;
  let err = 0, n = 0;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx), y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y++) {
    const ra = y * w, rb = (y + dy) * w + dx;
    for (let x = x0; x < x1; x++) {
      const i = ra + x, j = rb + x;
      if (A.e[i] & B.e[j]) { err += A.t[i] ^ B.t[j]; n++; }
    }
  }
  return n ? err / n : 1;
}

// Shift (dx, dy) such that b(x + dx, y + dy) ≈ a(x, y), in pixels of these grids.
export function alignShift(a, b, levels = 6) {
  let sx = 0, sy = 0;
  if (levels > 0 && a.w > 96 && a.h > 96) {
    [sx, sy] = alignShift(halve(a), halve(b), levels - 1);
    sx *= 2; sy *= 2;
  }
  const A = mtb(a), B = mtb(b);
  let best = Infinity, bx = sx, by = sy;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const e = mtbError(A, B, sx + dx, sy + dy);
    if (e < best) { best = e; bx = sx + dx; by = sy + dy; }
  }
  return [bx, by];
}

// Resamples a grey grid by `s` about its centre (focus breathing) and shifts it.
function scaled({ g, w, h }, s) {
  const o = new Float32Array(w * h), cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = Math.min(w - 1.001, Math.max(0, cx + (x - cx) * s)), Y = Math.min(h - 1.001, Math.max(0, cy + (y - cy) * s));
    const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0, i = y0 * w + x0;
    o[y * w + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }
  return { g: o, w, h };
}

// ------------------------------------------------------------------ accumulating
// Merges add one frame at a time into running sums, so only one full frame is in memory at once.

export class Accumulator {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.sum = new Float32Array(w * h * 3);
    this.wt = new Float32Array(w * h);
  }
  // `map(x, y)` → source position, `weight(r, g, b, x, y)` → weight, `k` scales the values.
  add(frame, { dx = 0, dy = 0, scale = 1, k = 1, weight }) {
    const { w, h, sum, wt } = this, d = frame.data, fw = frame.w, fh = frame.h, cx = w / 2, cy = h / 2;
    const bil = scale !== 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r, g, b;
        if (!bil) {
          const xs = x + dx, ys = y + dy;
          if (xs < 0 || ys < 0 || xs >= fw || ys >= fh) continue;
          const i = (ys * fw + xs) * 4;
          r = H2F[d[i]]; g = H2F[d[i + 1]]; b = H2F[d[i + 2]];
        } else {
          const X = cx + (x - cx) * scale + dx, Y = cy + (y - cy) * scale + dy;
          if (X < 0 || Y < 0 || X >= fw - 1 || Y >= fh - 1) continue;
          const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0;
          const i = (y0 * fw + x0) * 4, j = i + fw * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          r = H2F[d[i]] * w00 + H2F[d[i + 4]] * w10 + H2F[d[j]] * w01 + H2F[d[j + 4]] * w11;
          g = H2F[d[i + 1]] * w00 + H2F[d[i + 5]] * w10 + H2F[d[j + 1]] * w01 + H2F[d[j + 5]] * w11;
          b = H2F[d[i + 2]] * w00 + H2F[d[i + 6]] * w10 + H2F[d[j + 2]] * w01 + H2F[d[j + 6]] * w11;
        }
        const wgt = weight(r, g, b, x, y);
        if (!(wgt > 0)) continue;
        const o = y * w + x;
        sum[o * 3] += wgt * r * k; sum[o * 3 + 1] += wgt * g * k; sum[o * 3 + 2] += wgt * b * k;
        wt[o] += wgt;
      }
    }
  }
  // Linear RGB, scaled by `k`.
  result(k = 1) {
    const { sum, wt } = this, out = new Float32Array(this.w * this.h * 3);
    for (let o = 0; o < wt.length; o++) {
      const s = wt[o] > 0 ? k / wt[o] : 0;
      out[o * 3] = sum[o * 3] * s; out[o * 3 + 1] = sum[o * 3 + 1] * s; out[o * 3 + 2] = sum[o * 3 + 2] * s;
    }
    return out;
  }
}

// ------------------------------------------------------------------ HDR

const ALIGN_F = 2;   // alignment grid: half size

export class HDRMerge {
  constructor() { this.ref = null; this.frames = []; }
  // Frames can come in any order; `meta` (shutter, iso, aperture) helps when brackets barely overlap.
  add(frame, meta = {}) {
    const grid = luma(frame, ALIGN_F);
    if (!this.ref) {
      this.ref = { grid, meta, w: frame.w, h: frame.h };
      this.acc = new Accumulator(frame.w, frame.h);
      this.addTo(frame, 0, 0, 1);
      this.frames.push({ k: 1, grid, gx: 0, gy: 0 });
      return { dx: 0, dy: 0, k: 1 };
    }
    if (frame.w !== this.ref.w || frame.h !== this.ref.h) throw new Error('The photos have different sizes');
    const [gx, gy] = alignShift(this.ref.grid, grid);
    // Brightness relative to the reference, measured against whichever frame so far shares the most
    // well-exposed pixels with this one (the darkest and brightest brackets may share none).
    let best = null;
    for (const f of this.frames) {
      const r = ratio(f.grid.g, grid.g, grid.w, grid.h, gx - f.gx, gy - f.gy);
      if (r.n && (!best || r.n > best.n)) best = { k: f.k * r.r, n: r.n };
    }
    const k = best?.k || exposureRatio(this.ref.meta, meta) || 1;
    const dx = gx * ALIGN_F, dy = gy * ALIGN_F;
    this.addTo(frame, dx, dy, k);
    this.frames.push({ k, grid, gx, gy });
    return { dx, dy, k };
  }
  addTo(frame, dx, dy, k) {
    // Mid-tones count most; clipped highlights not at all; the noise floor little. Brighter frames
    // (smaller k) have less noise, so they weigh more. Where every frame is clipped the darkest wins.
    this.acc.add(frame, {
      dx, dy, k,
      weight: (r, g, b) => {
        const m = Math.max(r, g, b);
        return (smooth(0.001, 0.02, m) * (1 - smooth(0.8, 0.95, m))) / k + 1e-7 * k * k;
      },
    });
  }
  // Brightness as the middle bracket was shot; the extra range goes into the DNG's headroom.
  finish() {
    const ks = this.frames.map((f) => f.k).sort((a, b) => a - b);
    const km = ks[ks.length >> 1];
    return { w: this.acc.w, h: this.acc.h, rgb: this.acc.result(1 / km) };
  }
}

function ratio(a, b, w, h, dx, dy) {
  const rs = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 120000)));
  for (let y = 0; y < h; y += step) {
    const yb = y + dy;
    if (yb < 0 || yb >= h) continue;
    for (let x = 0; x < w; x += step) {
      const xb = x + dx;
      if (xb < 0 || xb >= w) continue;
      const p = a[y * w + x], q = b[yb * w + xb];
      if (p > 0.01 && p < 0.75 && q > 0.01 && q < 0.75) rs.push(p / q);
    }
  }
  if (rs.length < 400) return { r: 0, n: 0 };
  rs.sort((x, y) => x - y);
  return { r: rs[rs.length >> 1], n: rs.length };
}

// Light reaching the sensor, reference over frame, from shutter, ISO and aperture.
function exposureRatio(a, b) {
  const ev = (m) => (m && m.shutter > 0 ? (m.shutter * (m.iso || 100)) / (m.aperture > 0 ? m.aperture ** 2 : 1) : 0);
  const A = ev(a), B = ev(b);
  return A && B ? A / B : 0;
}

// ------------------------------------------------------------------ focus stacking

export class FocusStack {
  constructor() { this.ref = null; }
  add(frame) {
    const grid = luma(frame, ALIGN_F);
    let dx = 0, dy = 0, scale = 1;
    if (!this.ref) {
      this.ref = { grid, w: frame.w, h: frame.h };
      this.acc = new Accumulator(frame.w, frame.h);
    } else {
      if (frame.w !== this.ref.w || frame.h !== this.ref.h) throw new Error('The photos have different sizes');
      // Focusing changes the magnification a little: try scales, keep the best fit.
      const small = (gr) => { let s = gr; while (s.w > 700) s = halve(s); return s; };
      const A = small(this.ref.grid), Bs = small(grid);
      let best = Infinity;
      for (let s = 0.97; s <= 1.0301; s += 0.0025) {
        const B = scaled(Bs, s);
        const [sx, sy] = alignShift(A, B, 4);
        const e = mtbError(mtb(A), mtb(B), sx, sy);
        if (e < best) { best = e; scale = s; dx = sx * (grid.w / A.w); dy = sy * (grid.h / A.h); }
      }
      // Refine the shift at the alignment grid.
      const B = scaled(grid, scale), MA = mtb(this.ref.grid), MB = mtb(B);
      let bx = Math.round(dx), by = Math.round(dy), be = Infinity;
      for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) {
        const e = mtbError(MA, MB, Math.round(dx) + xx, Math.round(dy) + yy);
        if (e < be) { be = e; bx = Math.round(dx) + xx; by = Math.round(dy) + yy; }
      }
      dx = bx * ALIGN_F; dy = by * ALIGN_F;
    }
    // Sharpness: local contrast of the frame's detail, measured on the alignment grid in the
    // reference's coordinates, so the weights line up with the pixels they choose.
    const sharp = sharpness(grid);
    const gw = grid.w, gh = grid.h, cx = this.acc.w / 2, cy = this.acc.h / 2;
    this.acc.add(frame, {
      dx, dy, scale,
      weight: (r, g, b, x, y) => {
        const X = (cx + (x - cx) * scale + dx) / ALIGN_F, Y = (cy + (y - cy) * scale + dy) / ALIGN_F;
        const v = sharp[Math.min(gh - 1, Math.max(0, Y | 0)) * gw + Math.min(gw - 1, Math.max(0, X | 0))];
        return v * v * v * v + 1e-30;
      },
    });
    return { dx, dy, scale };
  }
  finish() { return { w: this.acc.w, h: this.acc.h, rgb: this.acc.result(1) }; }
}

function sharpness({ g, w, h }) {
  // Laplacian of the log image (so dark and bright areas count alike), then its local energy.
  const L = new Float32Array(w * h), lg = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) lg[i] = Math.log(g[i] + 1e-4);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * lg[i] - lg[i - 1] - lg[i + 1] - lg[i - w] - lg[i + w];
    L[i] = v * v;
  }
  return boxBlur(boxBlur(L, w, h, 4), w, h, 4).map(Math.sqrt);
}

// ------------------------------------------------------------------ panorama

function harris({ g, w, h }, max = 1500) {
  const ix = new Float32Array(w * h), iy = new Float32Array(w * h);
  const lg = g.map((v) => Math.sqrt(v));   // perceptual-ish, so shadows give corners too
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    ix[i] = (lg[i - w + 1] + 2 * lg[i + 1] + lg[i + w + 1] - lg[i - w - 1] - 2 * lg[i - 1] - lg[i + w - 1]) / 8;
    iy[i] = (lg[i + w - 1] + 2 * lg[i + w] + lg[i + w + 1] - lg[i - w - 1] - 2 * lg[i - w] - lg[i - w + 1]) / 8;
  }
  const xx = boxBlur(ix.map((v) => v * v), w, h, 2), yy = boxBlur(iy.map((v) => v * v), w, h, 2), xy = boxBlur(ix.map((v, i) => v * iy[i]), w, h, 2);
  const R = new Float32Array(w * h);
  for (let i = 0; i < R.length; i++) R[i] = xx[i] * yy[i] - xy[i] * xy[i] - 0.04 * (xx[i] + yy[i]) ** 2;
  // Strongest corners per cell, so they spread over the picture.
  const CX = 12, CY = 8, per = Math.ceil(max / (CX * CY)), pts = [];
  const B = 20;
  for (let cyI = 0; cyI < CY; cyI++) for (let cxI = 0; cxI < CX; cxI++) {
    const cand = [];
    const x0 = Math.max(B, Math.floor((cxI * w) / CX)), x1 = Math.min(w - B, Math.floor(((cxI + 1) * w) / CX));
    const y0 = Math.max(B, Math.floor((cyI * h) / CY)), y1 = Math.min(h - B, Math.floor(((cyI + 1) * h) / CY));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x, v = R[i];
      if (v <= 1e-10) continue;
      let peak = true;
      for (let dy = -3; dy <= 3 && peak; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && R[i + dy * w + dx] > v) { peak = false; break; }
      if (peak) cand.push([v, x, y]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    for (const c of cand.slice(0, per)) pts.push({ x: c[1], y: c[2] });
  }
  return pts;
}

function describePts({ g, w, h }, pts) {
  const bl = boxBlur(boxBlur(g.map((v) => Math.sqrt(v)), w, h, 1), w, h, 1);
  return pts.map((p) => {
    const d = new Float32Array(64);
    let m = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const v = bl[(p.y + (j - 3.5) * 4 | 0) * w + (p.x + (i - 3.5) * 4 | 0)]; d[j * 8 + i] = v; m += v; }
    m /= 64;
    let s = 0;
    for (let i = 0; i < 64; i++) { d[i] -= m; s += d[i] * d[i]; }
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < 64; i++) d[i] /= s;
    return { ...p, d };
  });
}

function matchPts(A, B) {
  const out = [];
  for (const a of A) {
    let b1 = Infinity, b2 = Infinity, bi = null;
    for (const b of B) {
      let s = 0;
      for (let i = 0; i < 64; i++) { const t = a.d[i] - b.d[i]; s += t * t; if (s > b2) break; }
      if (s < b1) { b2 = b1; b1 = s; bi = b; } else if (s < b2) b2 = s;
    }
    if (bi && b1 < 0.64 * b2) out.push([a.x, a.y, bi.x, bi.y]);
  }
  return out;
}

// Solves the 8×8 system for a homography from ≥ 4 correspondences (least squares).
function homography(ms) {
  const A = Array.from({ length: 8 }, () => new Float64Array(9));
  for (const [x, y, u, v] of ms) {
    const rows = [[x, y, 1, 0, 0, 0, -x * u, -y * u, u], [0, 0, 0, x, y, 1, -x * v, -y * v, v]];
    for (const r of rows) for (let i = 0; i < 8; i++) for (let j = 0; j < 9; j++) A[i][j] += r[i] * r[j];
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j < 9; j++) A[r][j] -= f * A[c][j]; }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
const apply = (H, x, y) => { const z = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z, z]; };
const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function ransac(ms, thr, iters = 2000) {
  if (ms.length < 8) return null;
  // Normalised coordinates keep the solve well conditioned.
  let best = null, bestN = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    const pick = [];
    while (pick.length < 4) { const m = ms[(rnd() * ms.length) | 0]; if (!pick.includes(m)) pick.push(m); }
    const H = homography(pick);
    if (!H) continue;
    let n = 0;
    for (const [x, y, u, v] of ms) { const [px, py, z] = apply(H, x, y); if (z > 0 && (px - u) ** 2 + (py - v) ** 2 < thr * thr) n++; }
    if (n > bestN) { bestN = n; best = H; }
  }
  if (!best) return null;
  const inl = ms.filter(([x, y, u, v]) => { const [px, py] = apply(best, x, y); return (px - u) ** 2 + (py - v) ** 2 < thr * thr; });
  const H = homography(inl) || best;
  return { H, inliers: inl };
}

// `frames` in order across the scene. Returns { w, h, rgb } or throws with a reason.
export function panorama(frames, { maxPixels = 40e6, onProgress = () => {} } = {}) {
  const n = frames.length, fw = frames[0].w, fh = frames[0].h;
  const F = Math.max(1, Math.round(Math.max(fw, fh) / 1400));
  onProgress('Finding matching points…');
  const grids = frames.map((f) => luma(f, F));
  const feats = grids.map((g) => describePts(g, harris(g)));
  // Pairwise homographies between neighbours, at full frame scale.
  const S = [F, 0, 0, 0, F, 0, 0, 0, 1], Si = [1 / F, 0, 0, 0, 1 / F, 0, 0, 0, 1];
  const pair = [], gains = [];
  for (let i = 0; i < n - 1; i++) {
    const ms = matchPts(feats[i], feats[i + 1]);
    const r = ransac(ms, 2.5);
    if (!r || r.inliers.length < 15) throw new Error(`Photos ${i + 1} and ${i + 2} don't overlap enough to join. Pick them in order across the scene, overlapping by about a third.`);
    pair.push(mul(S, mul(r.H, Si)));   // frame i → frame i+1
    // Exposure difference from the brightness around matched points.
    const ratios = r.inliers.map(([x, y, u, v]) => (grids[i].g[(y | 0) * grids[i].w + (x | 0)] + 1e-4) / (grids[i + 1].g[(v | 0) * grids[i + 1].w + (u | 0)] + 1e-4)).sort((a, b) => a - b);
    gains.push(ratios[ratios.length >> 1]);
  }
  // Everything relative to the middle frame.
  const c = n >> 1, G = new Array(n), gain = new Array(n);
  G[c] = I3; gain[c] = 1;
  for (let i = c - 1; i >= 0; i--) { G[i] = mul(G[i + 1], pair[i]); gain[i] = gain[i + 1] / gains[i]; }
  for (let i = c + 1; i < n; i++) { G[i] = mul(G[i - 1], inv(pair[i - 1])); gain[i] = gain[i - 1] * gains[i - 1]; }
  // Bounds of the warped frames.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const boxes = G.map((H) => {
    const cs = [[0, 0], [fw, 0], [0, fh], [fw, fh]].map(([x, y]) => apply(H, x, y));
    if (cs.some((p) => p[2] <= 0.05)) throw new Error('These photos cover too wide a view to join flat. Try fewer photos.');
    const bx = [Math.min(...cs.map((p) => p[0])), Math.min(...cs.map((p) => p[1])), Math.max(...cs.map((p) => p[0])), Math.max(...cs.map((p) => p[1]))];
    x0 = Math.min(x0, bx[0]); y0 = Math.min(y0, bx[1]); x1 = Math.max(x1, bx[2]); y1 = Math.max(y1, bx[3]);
    return bx;
  });
  if (x1 - x0 > fw * (n + 1) || y1 - y0 > fh * (n + 1)) throw new Error('The photos didn’t line up into a panorama. Pick them in order across the scene.');
  const sc = Math.min(1, Math.sqrt(maxPixels / ((x1 - x0) * (y1 - y0))));
  const W = Math.round((x1 - x0) * sc), H = Math.round((y1 - y0) * sc);
  const Gi = G.map(inv);
  const out = new Float32Array(W * H * 3);
  const bb = boxes.map(([a, b, c2, d]) => [(a - x0) * sc, (b - y0) * sc, (c2 - x0) * sc, (d - y0) * sc]);
  for (let Y = 0; Y < H; Y++) {
    if (Y % 64 === 0) onProgress(`Blending… ${Math.round((Y / H) * 100)}%`);
    const yr = Y / sc + y0;
    for (let X = 0; X < W; X++) {
      const xr = X / sc + x0;
      let r = 0, g = 0, b = 0, ws = 0;
      for (let i = 0; i < n; i++) {
        const q = bb[i];
        if (X < q[0] || X > q[2] || Y < q[1] || Y > q[3]) continue;
        const [x, y] = apply(Gi[i], xr, yr);
        if (x < 0 || y < 0 || x >= fw - 1 || y >= fh - 1) continue;
        // Feathered: frames fade out towards their edges.
        const wgt = (Math.min(x, fw - 1 - x) / fw) * (Math.min(y, fh - 1 - y) / fh);
        const d = frames[i].data, x0i = x | 0, y0i = y | 0, fx = x - x0i, fy = y - y0i;
        const p = (y0i * fw + x0i) * 4, q2 = p + fw * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, k = gain[i] * wgt;
        r += k * (H2F[d[p]] * w00 + H2F[d[p + 4]] * w10 + H2F[d[q2]] * w01 + H2F[d[q2 + 4]] * w11);
        g += k * (H2F[d[p + 1]] * w00 + H2F[d[p + 5]] * w10 + H2F[d[q2 + 1]] * w01 + H2F[d[q2 + 5]] * w11);
        b += k * (H2F[d[p + 2]] * w00 + H2F[d[p + 6]] * w10 + H2F[d[q2 + 2]] * w01 + H2F[d[q2 + 6]] * w11);
        ws += wgt;
      }
      if (ws > 0) { const o = (Y * W + X) * 3; out[o] = r / ws; out[o + 1] = g / ws; out[o + 2] = b / ws; }
    }
  }
  return { w: W, h: H, rgb: out };
}

// ------------------------------------------------------------------ DNG

const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];

// Linear float RGB → 16-bit, with the headroom above 1 kept through BaselineExposure.
export function to16(rgb) {
  let max = 0;
  // 99.99th percentile, so a few hot pixels don't darken everything.
  const sample = [];
  for (let i = 0; i < rgb.length; i += 97) sample.push(rgb[i]);
  sample.sort((a, b) => a - b);
  max = Math.max(1, sample[Math.floor(sample.length * 0.9999)] || 1);
  const k = 65535 / max, out = new Uint16Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = Math.max(0, Math.min(65535, Math.round(rgb[i] * k)));
  return { data: out, baseline: Math.log2(max) };
}

// Uncompressed LinearRaw DNG with sRGB-primaries data, plus an optional JPEG preview.
export function writeDNG({ w, h, data, baseline = 0, preview = null, previewW = 0, previewH = 0, model = 'Merge' }) {
  const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 };
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const str = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const imageBytes = w * h * 6;
  const ifd0 = [
    [254, T.LONG, [0]], [256, T.LONG, [w]], [257, T.LONG, [h]], [258, T.SHORT, [16, 16, 16]], [259, T.SHORT, [1]],
    [262, T.SHORT, [34892]], [271, T.ASCII, str('Rembrandt')], [272, T.ASCII, str(model)], [273, T.LONG, [0]],
    [274, T.SHORT, [1]], [277, T.SHORT, [3]], [278, T.LONG, [h]], [279, T.LONG, [imageBytes]], [284, T.SHORT, [1]],
    [305, T.ASCII, str('Rembrandt')],
    [50706, T.BYTE, [1, 4, 0, 0]], [50707, T.BYTE, [1, 1, 0, 0]], [50708, T.ASCII, str(`Rembrandt ${model}`)],
    [50714, T.LONG, [0, 0, 0]], [50717, T.LONG, [65535, 65535, 65535]],
    [50721, T.SRATIONAL, XYZ_TO_SRGB.flatMap((v) => [Math.round(v * 10000), 10000])],
    [50728, T.RATIONAL, [1, 1, 1, 1, 1, 1]], [50730, T.SRATIONAL, [Math.round(baseline * 1000), 1000]],
    [50778, T.SHORT, [21]],
  ];
  const ifd1 = preview ? [
    [254, T.LONG, [1]], [256, T.LONG, [previewW]], [257, T.LONG, [previewH]], [259, T.SHORT, [6]], [262, T.SHORT, [6]],
    [513, T.LONG, [0]], [514, T.LONG, [preview.length]],
  ] : null;
  const count = (type, vals) => (type === T.RATIONAL || type === T.SRATIONAL ? vals.length / 2 : vals.length);
  const extra = (list) => list.reduce((s, [, t, v]) => { const n = count(t, v) * SZ[t]; return s + (n > 4 ? n + (n & 1) : 0); }, 0);
  const size0 = 2 + 12 * ifd0.length + 4, size1 = ifd1 ? 2 + 12 * ifd1.length + 4 : 0;
  const off1 = 8 + size0 + extra(ifd0);
  let imgOff = off1 + size1 + (ifd1 ? extra(ifd1) : 0);
  imgOff += imgOff & 1;
  const prevOff = imgOff + imageBytes;
  ifd0.find((e) => e[0] === 273)[2] = [imgOff];
  if (ifd1) ifd1.find((e) => e[0] === 513)[2] = [prevOff];
  const buf = new Uint8Array(prevOff + (preview ? preview.length : 0));
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  const writeIfd = (list, at, next) => {
    let over = at + 2 + 12 * list.length + 4;
    dv.setUint16(at, list.length, true);
    list.forEach(([tag, type, vals], k) => {
      const e = at + 2 + 12 * k, n = count(type, vals), bytes = n * SZ[type];
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, n, true);
      let p = e + 8;
      if (bytes > 4) { dv.setUint32(e + 8, over, true); p = over; over += bytes + (bytes & 1); }
      vals.forEach((v, j) => {
        if (type === T.BYTE || type === T.ASCII) dv.setUint8(p + j, v);
        else if (type === T.SHORT) dv.setUint16(p + 2 * j, v, true);
        else if (type === T.LONG || type === T.RATIONAL) dv.setUint32(p + 4 * j, v, true);
        else if (type === T.SRATIONAL) dv.setInt32(p + 4 * j, v, true);
      });
    });
    dv.setUint32(at + 2 + 12 * list.length, next, true);
  };
  writeIfd(ifd0, 8, ifd1 ? off1 : 0);
  if (ifd1) writeIfd(ifd1, off1, 0);
  buf.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), imgOff);
  if (preview) buf.set(preview, prevOff);
  return buf;
}
