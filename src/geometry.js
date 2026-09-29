// 2D affine helpers and crop / rotation geometry.
//
// Spaces:
//   P  image space in "height units": x in [-a/2, a/2], y in [-1/2, 1/2] (y down), unrotated, unflipped.
//   Q  rotated frame: what the user sees; the crop rect is axis-aligned here.
//   UV texture coordinates of the image, [0,1]^2.
// Affine matrices use the SVG convention [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.

export const A = {
  I: [1, 0, 0, 1, 0, 0],
  mul(m, n) {
    // m ∘ n (apply n first)
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  },
  chain(...ms) { return ms.reduce((acc, m) => A.mul(acc, m)); },
  inv(m) {
    const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  },
  apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; },
  vec(m, x, y) { return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]; },
  scale(sx, sy = sx) { return [sx, 0, 0, sy, 0, 0]; },
  translate(x, y) { return [1, 0, 0, 1, x, y]; },
  rotate(t) { const c = Math.cos(t), s = Math.sin(t); return [c, s, -s, c, 0, 0]; },
  mat3(m) { return new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]); },
  css(m) { return `matrix(${m.map((v) => +v.toFixed(6)).join(' ')})`; },
};

export const theta = (g) => (((g.rot90 || 0) * 90 + (g.angle || 0)) * Math.PI) / 180;

// Q -> P
export function qToP(g) {
  return A.mul(A.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1), A.rotate(-theta(g)));
}

export const pToUV = (a) => [1 / a, 0, 0, 1, 0.5, 0.5];

export function rotatedBounds(a, g) {
  const t = theta(g), c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return { w: a * c + s, h: a * s + c };
}

export const cropUVToQ = (c) => [c.w, 0, 0, c.h, c.cx - c.w / 2, c.cy - c.h / 2];

export function cropValid(c, a, g) {
  if (c.w <= 0 || c.h <= 0) return false;
  const m = qToP(g);
  const ex = a / 2 + 1e-6, ey = 0.5 + 1e-6;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [x, y] = A.apply(m, c.cx + (sx * c.w) / 2, c.cy + (sy * c.h) / 2);
    if (Math.abs(x) > ex || Math.abs(y) > ey) return false;
  }
  return true;
}

// Largest crop with the given aspect ratio centred at (cx, cy) that fits in the rotated image.
export function maxCrop(a, g, ratio, cx = 0, cy = 0) {
  const b = rotatedBounds(a, g);
  let lo = 0, hi = Math.max(b.w, b.h) * 2;
  for (let i = 0; i < 40; i++) {
    const s = (lo + hi) / 2;
    if (cropValid({ cx, cy, w: s * ratio, h: s }, a, g)) lo = s; else hi = s;
  }
  return { cx, cy, w: lo * ratio, h: lo };
}

// Shrinks the crop about its centre until it fits (used after rotation changes).
export function fitCrop(c, a, g) {
  if (cropValid(c, a, g)) return c;
  let lo = 0, hi = 1;
  for (let i = 0; i < 32; i++) {
    const s = (lo + hi) / 2;
    if (cropValid({ ...c, w: c.w * s, h: c.h * s }, a, g)) lo = s; else hi = s;
  }
  if (lo > 0.05) return { ...c, w: c.w * lo, h: c.h * lo };
  return maxCrop(a, g, c.w / c.h, 0, 0);
}

// Moves toward `next` from `prev` as far as possible while staying valid.
export function constrainCrop(prev, next, a, g) {
  if (cropValid(next, a, g)) return next;
  let lo = 0, hi = 1;
  const mix = (t) => ({
    cx: prev.cx + (next.cx - prev.cx) * t, cy: prev.cy + (next.cy - prev.cy) * t,
    w: prev.w + (next.w - prev.w) * t, h: prev.h + (next.h - prev.h) * t,
  });
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (cropValid(mix(t), a, g)) lo = t; else hi = t;
  }
  return mix(lo);
}
