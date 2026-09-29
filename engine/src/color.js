// Rembrandt Engine — color science.
// Copyright © 2026 light.work. Licensed under the PolyForm Shield License 1.0.0 (see LICENSE).
// You may not sell this software or a modified version of it; see LICENSE and TRADEMARKS.md.
//
// Everything here is built from published standards and papers:
//   • sRGB (IEC 61966-2-1) and ITU-R BT.2020 primaries, D65 white
//   • CIE CAT16 chromatic adaptation (Li et al., 2017; CIE 248:2022)
//   • CIE daylight locus (CIE 15:2004) and Krystek's (1985) Planckian locus approximation in CIE 1960 UCS,
//     with tint expressed as Duv (ANSI C78.377)
//   • Oklab (B. Ottosson, 2020, public domain)
// The working space is scene-linear Rec.2020 (D65).

// ------------------------------------------------------------------ small linear algebra (row-major 3x3)

export const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
export const matmul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
export const diag = (v) => [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];
export const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// Column-major Float32Array for a GLSL mat3 uniform (so that GLSL `M * v` equals mul3(m, v)).
export const toGL = (m) => new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);

// ------------------------------------------------------------------ primaries -> XYZ

const WHITE_D65 = [0.3127, 0.329];
function rgbToXYZ(prim, white = WHITE_D65) {
  const col = ([x, y]) => [x / y, 1, (1 - x - y) / y];
  const P = [col(prim[0]), col(prim[1]), col(prim[2])];
  const Pm = [[P[0][0], P[1][0], P[2][0]], [P[0][1], P[1][1], P[2][1]], [P[0][2], P[1][2], P[2][2]]];
  const W = col(white);
  const S = mul3(inv3(Pm), W);
  return Pm.map((r) => r.map((v, j) => v * S[j]));
}

export const SRGB_TO_XYZ = rgbToXYZ([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]]);
export const REC2020_TO_XYZ = rgbToXYZ([[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]);
export const XYZ_TO_SRGB = inv3(SRGB_TO_XYZ);
export const XYZ_TO_REC2020 = inv3(REC2020_TO_XYZ);
export const SRGB_TO_REC2020 = matmul(XYZ_TO_REC2020, SRGB_TO_XYZ);
export const REC2020_TO_SRGB = matmul(XYZ_TO_SRGB, REC2020_TO_XYZ);
export const REC2020_LUMA = REC2020_TO_XYZ[1];

// ------------------------------------------------------------------ Oklab (from Rec.2020 linear)

// Ottosson's LMS matrix is defined from linear sRGB; compose it with Rec.2020 -> sRGB.
const OK_M1_SRGB = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
export const OK_M1 = matmul(OK_M1_SRGB, REC2020_TO_SRGB);
export const OK_M1_INV = inv3(OK_M1);
export const OK_M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
export const OK_M2_INV = inv3(OK_M2);

export function oklab(rgb2020) {
  const lms = mul3(OK_M1, rgb2020).map(Math.cbrt);
  return mul3(OK_M2, lms);
}
export function fromOklab(lab) {
  const lms = mul3(OK_M2_INV, lab).map((v) => v * v * v);
  return mul3(OK_M1_INV, lms);
}

// Direction of a conventional (HSL-style) hue in the Oklab a/b plane, for color wheels.
export function hueToOkDir(deg) {
  const h = ((deg % 360) + 360) % 360 / 60;
  const c = 1, x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [, A, B] = oklab(mul3(SRGB_TO_REC2020, [lin(r), lin(g), lin(b)]));
  const n = Math.hypot(A, B) || 1;
  return [A / n, B / n];
}

// ------------------------------------------------------------------ display transform (Hill curve)

// y = x^c / (x^c + k), with k chosen so scene middle grey maps to display middle grey.
// A classic photoreceptor response; `c` sets contrast around grey. The inverse is exact, which lets
// display-referred images enter the scene-referred pipeline without changing at default settings.
export const MIDDLE_GREY = 0.1845;
export const REF_CONTRAST = 1.5;
export const toneK = (c) => Math.pow(MIDDLE_GREY, c) * (1 / MIDDLE_GREY - 1);
export const toneFwd = (x, c = REF_CONTRAST) => { const p = Math.pow(Math.max(x, 0), c); return p / (p + toneK(c)); };
export function toneInv(y, c = REF_CONTRAST) {
  const t = Math.min(Math.max(y, 0), 0.9985);
  return Math.pow((toneK(c) * t) / (1 - t), 1 / c);
}

// Display-referred sRGB (linear light) -> scene-linear Rec.2020, as the GPU input stage does.
export const displayToScene = (srgbLinear) => mul3(SRGB_TO_REC2020, srgbLinear).map((v) => toneInv(v));

// ------------------------------------------------------------------ white balance: CAT16 + illuminants

const M16 = [
  [0.401288, 0.650173, -0.051461],
  [-0.250268, 1.204414, 0.045854],
  [-0.002079, 0.048952, 0.953127],
];
const M16_INV = inv3(M16);

// Krystek (1985): Planckian locus in CIE 1960 (u, v), 1000–15000 K.
export function planckUV(T) {
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
  return [u, v];
}
const uvToXY = ([u, v]) => { const d = 2 * u - 8 * v + 4; return [(3 * u) / d, (2 * v) / d]; };
const xyToUV = ([x, y]) => { const d = -2 * x + 12 * y + 3; return [(4 * x) / d, (6 * y) / d]; };

// Illuminant chromaticity for a correlated color temperature and Duv (positive Duv = above the locus, greener).
export function illuminantXY(T, duv = 0) {
  T = Math.min(Math.max(T, 1500), 15000);
  const [u, v] = planckUV(T);
  const [u2, v2] = planckUV(T * 1.001);
  const du = u2 - u, dv = v2 - v, n = Math.hypot(du, dv);
  // unit normal pointing "up" (towards green) from the locus
  const nu = -dv / n, nv = du / n;
  return uvToXY([u + nu * duv, v + nv * duv]);
}

// Full CAT16 adaptation of an illuminant (x, y) to D65, as a Rec.2020 -> Rec.2020 matrix.
function adaptToD65(x, y) {
  const src = mul3(M16, [x / y, 1, (1 - x - y) / y]);
  const dst = mul3(M16, [WHITE_D65[0] / WHITE_D65[1], 1, (1 - WHITE_D65[0] - WHITE_D65[1]) / WHITE_D65[1]]);
  const cat = matmul(M16_INV, matmul(diag([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]]), M16));
  return matmul(XYZ_TO_REC2020, matmul(cat, REC2020_TO_XYZ));
}

// Slider model: temperature ±100 ≈ 6504 K · 2^(±1.2); tint ±100 ≈ ∓0.02 Duv (positive tint = magenta).
const T0 = 6504;
export const sliderToIlluminant = (temp, tint) => ({ T: T0 * 2 ** ((temp / 100) * 1.2), duv: (-tint / 100) * 0.02 });
const REF = inv3(adaptToD65(...illuminantXY(T0, 0)));

// White balance matrix relative to the reference illuminant: identity at temp = tint = 0.
export function whiteBalance(temp, tint) {
  if (!temp && !tint) return IDENTITY;
  const { T, duv } = sliderToIlluminant(temp, tint);
  return matmul(adaptToD65(...illuminantXY(T, duv)), REF);
}

// Picker: slider values that make a scene-linear Rec.2020 sample neutral (Newton iterations).
export function solveWhiteBalance(rgb) {
  rgb = rgb.map((v) => Math.max(v, 1e-6));
  const resid = (t, n) => { const o = mul3(whiteBalance(t, n), rgb); return [o[0] / o[1] - 1, o[2] / o[1] - 1]; };
  // Start from the sample's position relative to the Planckian locus.
  const X = mul3(REC2020_TO_XYZ, rgb), s = X[0] + X[1] + X[2];
  const [u, v] = xyToUV([X[0] / s, X[1] / s]);
  const [u0, v0] = planckUV(T0);
  let temp = Math.max(-100, Math.min(100, (u0 - u) * 1500));
  let tint = Math.max(-100, Math.min(100, (v - v0) * -3000));
  for (let i = 0; i < 16; i++) {
    const r = resid(temp, tint);
    if (Math.abs(r[0]) + Math.abs(r[1]) < 1e-5) break;
    const h = 0.05;
    const a = resid(temp + h, tint), b = resid(temp, tint + h);
    const J = [[(a[0] - r[0]) / h, (b[0] - r[0]) / h], [(a[1] - r[1]) / h, (b[1] - r[1]) / h]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (!det) break;
    temp = Math.max(-150, Math.min(150, temp - (J[1][1] * r[0] - J[0][1] * r[1]) / det));
    tint = Math.max(-150, Math.min(150, tint - (-J[1][0] * r[0] + J[0][0] * r[1]) / det));
  }
  return { temp, tint };
}
