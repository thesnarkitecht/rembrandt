// Find similar: a small fingerprint per photo, made on this device from its thumbnail, and a score
// for how alike two photos are. It finds the other frames of a burst, the same scene shot again, and
// photos with the same light and colours, without sending anything anywhere.
//
// The fingerprint has three parts: the low frequencies of the picture's brightness (its shape, from
// an 8×8 DCT of a 32×32 grey version), a 4×4 grid of average colours (where things are), and a colour
// histogram (what colours are there, wherever they are).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const N = 32, K = 8, BINS = 4;
let canvas = null;

// `src`: anything drawImage takes (an <img>, ImageBitmap, canvas). Returns the fingerprint.
export function signature(src) {
  if (!canvas) canvas = Object.assign(document.createElement('canvas'), { width: N, height: N });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, N, N);
  return signatureOf(ctx.getImageData(0, 0, N, N).data);
}

// From 32×32 RGBA bytes (also used by the tests, without a DOM).
export function signatureOf(d) {
  const grey = new Float32Array(N * N), grid = new Float32Array(4 * 4 * 3), hist = new Float32Array(BINS ** 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      grey[y * N + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      const c = ((y >> 3) * 4 + (x >> 3)) * 3;
      grid[c] += r; grid[c + 1] += g; grid[c + 2] += b;
      hist[((r * BINS) >> 8) * BINS * BINS + ((g * BINS) >> 8) * BINS + ((b * BINS) >> 8)]++;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= 64 * 255;
  for (let i = 0; i < hist.length; i++) hist[i] /= N * N;
  // 8×8 low-frequency DCT of the grey picture, without the average (brightness is the grid's job).
  const dct = new Float32Array(K * K - 1);
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      if (!u && !v) continue;
      let s = 0;
      for (let y = 0; y < N; y++) {
        const cy = Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
        for (let x = 0; x < N; x++) s += grey[y * N + x] * cy * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
      }
      dct[v * K + u - 1] = s;
    }
  }
  return { dct, grid, hist };
}

// 0 (nothing alike) … 1 (the same picture).
export function similarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.dct.length; i++) { dot += a.dct[i] * b.dct[i]; na += a.dct[i] ** 2; nb += b.dct[i] ** 2; }
  const shape = na && nb ? Math.max(0, dot / Math.sqrt(na * nb)) : 0;
  let diff = 0;
  for (let i = 0; i < a.grid.length; i++) diff += Math.abs(a.grid[i] - b.grid[i]);
  const layout = Math.max(0, 1 - (diff / a.grid.length) * 4);
  let inter = 0;
  for (let i = 0; i < a.hist.length; i++) inter += Math.min(a.hist[i], b.hist[i]);
  return 0.45 * shape + 0.3 * layout + 0.25 * inter;
}

// How alike a photo has to be to count, and how many to show at most.
export const THRESHOLD = 0.62;
export const MAX_RESULTS = 120;
