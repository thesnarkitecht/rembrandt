// Rembrandt Engine — GPU shaders.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Pipeline (scene-linear Rec.2020 until the display transform):
//   PRE     input -> scene-linear, dehaze (dark channel prior, He et al. 2009, refined with a fast
//           guided filter, He & Sun 2015), exposure
//   GUIDE   edge-preserving base layer of log-luminance (guided filter, He et al. 2010) for the
//           tone zones and clarity (base/detail decomposition)
//   MAIN    tone zones, clarity, texture, white balance (CAT16 matrix), color in OkLCh:
//           mixer, vibrance, saturation, 3-way grading; B&W
//   (host)  optional local-adjustment passes supplied by the application
//   FINAL   denoise, sharpen, display transform with hue-preserving highlight path, gamut mapping in
//           OkLCh, curves, vignette, grain
// Textures keep image row 0 at v = 0; only FINAL knows screen/crop geometry (3x3 matrices).

import { OK_M1, OK_M1_INV, OK_M2, OK_M2_INV, REC2020_TO_SRGB, SRGB_TO_REC2020, REC2020_LUMA, MIDDLE_GREY } from './color.js';

// Emit a JS row-major matrix as a GLSL mat3 applied as `M * v`.
const glmat = (m) => `mat3(${[0, 1, 2].map((c) => [0, 1, 2].map((r) => m[r][c].toFixed(9)).join(', ')).join(', ')})`;
const glvec = (v) => `vec3(${v.map((x) => x.toFixed(9)).join(', ')})`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const LIB = `
const float GREY = ${MIDDLE_GREY.toFixed(6)};
const float PI = 3.14159265358979;
const mat3 TO_SRGB = ${glmat(REC2020_TO_SRGB)};
const mat3 FROM_SRGB = ${glmat(SRGB_TO_REC2020)};
const mat3 OKM1 = ${glmat(OK_M1)};
const mat3 OKM1I = ${glmat(OK_M1_INV)};
const mat3 OKM2 = ${glmat(OK_M2)};
const mat3 OKM2I = ${glmat(OK_M2_INV)};
const vec3 LUM = ${glvec(REC2020_LUMA)};

float lum(vec3 c) { return dot(c, LUM); }
vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
vec3 oklab(vec3 rgb) { return OKM2 * cbrt3(OKM1 * rgb); }
vec3 unOklab(vec3 lab) { vec3 l = OKM2I * lab; return OKM1I * (l * l * l); }

// Hill-type display curve pinned at middle grey (see color.js).
float hill(float x, float c, float k) { float p = pow(max(x, 0.0), c); return p / (p + k); }
float hillInv(float y, float c, float k) { float t = clamp(y, 0.0, 0.9985); return pow(k * t / (1.0 - t), 1.0 / c); }

// Raised-cosine window: 1 at centre, 0 beyond ±w.
float bump(float x, float c, float w) { float d = clamp((x - c) / w, -1.0, 1.0); return 0.5 + 0.5 * cos(d * PI); }
`;

// Tone zones in EV relative to middle grey. t = (blacks, shadows, highlights, whites), each in [-1, 1].
const ZONES = `
float zoneGain(float ev, vec4 t) {
  float wB = ev < -5.5 ? 1.0 : bump(ev, -5.5, 2.5);
  float wS = bump(ev, -2.5, 2.6);
  float wH = bump(ev, 1.6, 2.2);
  float wW = ev > 3.4 ? 1.0 : bump(ev, 3.4, 2.0);
  return t.x * 1.2 * wB + t.y * 1.5 * wS + t.z * 1.5 * wH + t.w * 1.2 * wW;
}
`;

const INPUT = `
uniform sampler2D uSrc;
uniform int uSrcLinear;
uniform float uSrcGain, uInC, uInK;
vec3 sceneIn(vec2 uv) {
  vec3 c = textureLod(uSrc, uv, 0.0).rgb;
  if (uSrcLinear == 1) return FROM_SRGB * (c * uSrcGain);
  c = FROM_SRGB * c;
  return vec3(hillInv(c.r, uInC, uInK), hillInv(c.g, uInC, uInK), hillInv(c.b, uInC, uInK));
}
`;

// ---------------------------------------------------------------- utility passes

export const DOWN = HEAD + `
uniform sampler2D uIn;
uniform vec2 uSrcTexel;
in vec2 vUv; out vec4 o;
void main() {
  vec2 d = uSrcTexel;
  o = 0.25 * (textureLod(uIn, vUv + vec2(-d.x, -d.y), 0.0) + textureLod(uIn, vUv + vec2(d.x, -d.y), 0.0)
            + textureLod(uIn, vUv + vec2(-d.x, d.y), 0.0) + textureLod(uIn, vUv + d, 0.0));
}`;

export const GAUSS = HEAD + `
uniform sampler2D uIn;
uniform vec2 uDir;
uniform float uSigma;
in vec2 vUv; out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  float step = uSigma * 3.0 / 7.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i) * step;
    float w = exp(-x * x / (2.0 * uSigma * uSigma));
    acc += w * textureLod(uIn, vUv + uDir * x, 0.0);
    ws += w;
  }
  o = acc / ws;
}`;

// Separable window filter: mode 0 = mean, 1 = min, 2 = max.
export const BOX = HEAD + `
uniform sampler2D uIn;
uniform vec2 uDir;
uniform int uRadius, uMode;
in vec2 vUv; out vec4 o;
void main() {
  vec4 acc = uMode == 0 ? vec4(0.0) : textureLod(uIn, vUv, 0.0);
  for (int i = -24; i <= 24; i++) {
    if (i < -uRadius || i > uRadius) continue;
    vec4 v = textureLod(uIn, vUv + uDir * float(i), 0.0);
    acc = uMode == 0 ? acc + v : uMode == 1 ? min(acc, v) : max(acc, v);
  }
  o = uMode == 0 ? acc / float(2 * uRadius + 1) : acc;
}`;

export const RESAMPLE = HEAD + `
uniform sampler2D uIn;
uniform vec2 uInSize, uOutSize;
in vec2 vUv; out vec4 o;
void main() {
  vec2 ratio = uInSize / uOutSize;
  int n = int(clamp(ceil(max(ratio.x, ratio.y)), 1.0, 8.0));
  vec2 base = vUv - 0.5 / uOutSize;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= n) break;
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      acc += textureLod(uIn, base + (vec2(float(i), float(j)) + 0.5) / float(n) / uOutSize, 0.0);
    }
  }
  o = acc / float(n * n);
}`;

export const BLIT = HEAD + `
uniform sampler2D uIn;
uniform vec2 uSize;
out vec4 o;
void main() { o = texture(uIn, gl_FragCoord.xy / uSize); }`;

// Lens corrections on the source photo, before anything else: distortion (the radius to sample
// from), lateral chromatic aberration (red and blue sampled at their own radii) and vignetting (a
// gain on the result). uLut is 33x1 RGBA32F over the output radius 0..1 (1 = half the diagonal):
// (vignette gain, green radius scale, red scale relative to green, blue scale relative to green).
// uFill scales the output so corrected corners stay inside the photo.
export const LENS = HEAD + `
uniform sampler2D uIn;
uniform sampler2D uLut;
uniform vec2 uSize;
uniform float uFill;
in vec2 vUv; out vec4 o;
vec4 lut(float r) {
  float x = clamp(r, 0.0, 1.0) * 32.0;
  int i = int(floor(x));
  int j = min(i + 1, 32);
  return mix(texelFetch(uLut, ivec2(i, 0), 0), texelFetch(uLut, ivec2(j, 0), 0), x - float(i));
}
void main() {
  float hd = 0.5 * length(uSize);
  vec2 d = (vUv - 0.5) * uSize * uFill;
  vec4 k = lut(length(d) / hd);
  vec2 dg = d * k.g;
  vec2 uvG = 0.5 + dg / uSize;
  vec2 uvR = 0.5 + dg * k.b / uSize;
  vec2 uvB = 0.5 + dg * k.a / uSize;
  float vig = lut(length(dg) / hd).r;
  vec3 c = vec3(textureLod(uIn, uvR, 0.0).r, textureLod(uIn, uvG, 0.0).g, textureLod(uIn, uvB, 0.0).b);
  o = vec4(c * vig, 1.0);
}`;

// Guided filter, step 1: per-pixel (I, p, I·p, I²) of a guide I and input p, from channels of uIn.
// mode 0: I = p = log2 luminance of scene RGB (self-guided).  mode 1: I = .x, p = .y
export const GF_STATS = HEAD + LIB + `
uniform sampler2D uIn;
uniform int uMode;
in vec2 vUv; out vec4 o;
void main() {
  vec4 t = textureLod(uIn, vUv, 0.0);
  float I, p;
  if (uMode == 0) { I = log2(max(lum(t.rgb), 1.0 / 65536.0)); p = I; }
  else { I = t.x; p = t.y; }
  o = vec4(I, p, I * p, I * I);
}`;
// Guided filter, step 2: linear coefficients from the window means (a = cov / (var + eps), b = p̄ − a·Ī).
export const GF_COEF = HEAD + `
uniform sampler2D uIn;
uniform float uEps;
in vec2 vUv; out vec4 o;
void main() {
  vec4 m = textureLod(uIn, vUv, 0.0);
  float a = (m.z - m.x * m.y) / max(m.w - m.x * m.x + uEps, 1e-9);
  o = vec4(a, m.y - a * m.x, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- dehaze (dark channel prior)

// Scene image normalised by the airlight, at low resolution: (min channel, luminance/airlight luminance)
export const HAZE_DARK = HEAD + LIB + INPUT + `
uniform vec3 uA;
uniform vec2 uSrcTexel;
in vec2 vUv; out vec4 o;
void main() {
  vec2 d = uSrcTexel;
  vec3 s = (sceneIn(vUv + vec2(-d.x, -d.y)) + sceneIn(vUv + vec2(d.x, -d.y)) + sceneIn(vUv + vec2(-d.x, d.y)) + sceneIn(vUv + d)) * 0.25;
  vec3 n = s / uA;
  o = vec4(min(n.r, min(n.g, n.b)), lum(s) / lum(uA), 0.0, 1.0);
}`;
// Transmission estimate t = 1 − ω·dark (after the min filter), with the guide carried along.
export const HAZE_T = HEAD + `
uniform sampler2D uIn, uGuide;
uniform float uOmega;
in vec2 vUv; out vec4 o;
void main() {
  o = vec4(textureLod(uGuide, vUv, 0.0).y, 1.0 - uOmega * textureLod(uIn, vUv, 0.0).x, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- PRE

export const PRE = HEAD + LIB + INPUT + `
uniform int uHaze;
uniform sampler2D uHazeAB;
uniform vec3 uA;
uniform float uExposure, uHazeAdd;
in vec2 vUv; out vec4 o;
void main() {
  vec3 I = sceneIn(vUv);
  if (uHaze == 1) {
    vec2 ab = textureLod(uHazeAB, vUv, 0.0).xy;
    float t = clamp(ab.x * (lum(I) / lum(uA)) + ab.y, 0.1, 1.0);
    I = max((I - uA) / t + uA, 0.0);
  } else if (uHaze == 2) {
    // Adding haze: blend toward the airlight, more in the distance (bright, low-contrast areas).
    vec2 ab = textureLod(uHazeAB, vUv, 0.0).xy;
    float t = clamp(ab.x * (lum(I) / lum(uA)) + ab.y, 0.0, 1.0);
    // The veil colour is the airlight's chromaticity at a moderate level (a bright sky would wash out).
    vec3 veil = uA * (min(lum(uA), 0.45) / lum(uA));
    I = mix(I, veil, uHazeAdd * (1.0 - 0.6 * t));
  }
  o = vec4(I * uExposure, 1.0);
}`;

// ---------------------------------------------------------------- MAIN

export const MAIN = HEAD + LIB + ZONES + `
uniform sampler2D uPre, uGuideAB;
uniform vec2 uTexel;
uniform int uGuideOn;
uniform vec4 uTone;           // blacks, shadows, highlights, whites
uniform float uClarity, uTexture;
uniform int uWBOn;
uniform mat3 uWB;
uniform float uVib, uSat;
uniform int uMixOn;
uniform float uMixHue[8];
uniform float uMixSat[8];
uniform float uMixLum[8];
uniform int uGradeOn;
uniform vec3 uGS, uGM, uGH, uGG;  // (a, b, EV) per zone
uniform float uGBalance, uGBlend;
uniform int uBW;
in vec2 vUv; out vec4 o;

// Oklab hue centres (degrees) for red, orange, yellow, green, cyan, blue, purple, magenta.
const float HC[8] = float[8](25.0, 58.0, 100.0, 140.0, 195.0, 258.0, 298.0, 338.0);

float mixWeight(float hDeg, int i) {
  float c = HC[i];
  float prev = HC[(i + 7) % 8], next = HC[(i + 1) % 8];
  float dl = mod(c - prev + 360.0, 360.0), dr = mod(next - c + 360.0, 360.0);
  float d = mod(hDeg - c + 540.0, 360.0) - 180.0;
  float w = d < 0.0 ? dl : dr;
  return abs(d) >= w ? 0.0 : 0.5 + 0.5 * cos(d / w * PI);
}

void main() {
  vec3 rgb = textureLod(uPre, vUv, 0.0).rgb;
  float Y = max(lum(rgb), 1.0 / 65536.0);

  // Base/detail tone zones and clarity from the edge-preserving log-luminance base layer.
  if (uGuideOn == 1) {
    float g = log2(Y);
    vec2 ab = textureLod(uGuideAB, vUv, 0.0).xy;
    float base = ab.x * g + ab.y;
    float ev = base - log2(GREY);
    float gain = zoneGain(ev, uTone);
    float detail = clamp(g - base, -3.0, 3.0);
    gain += uClarity * 0.65 * detail * exp(-ev * ev / 24.0);
    rgb *= exp2(gain);
  }
  if (uTexture != 0.0) {
    vec2 d = uTexel * 1.5;
    float yb = 0.25 * (lum(textureLod(uPre, vUv + d, 0.0).rgb) + lum(textureLod(uPre, vUv - d, 0.0).rgb)
                     + lum(textureLod(uPre, vUv + vec2(d.x, -d.y), 0.0).rgb) + lum(textureLod(uPre, vUv + vec2(-d.x, d.y), 0.0).rgb));
    rgb *= exp2(clamp(log2(Y) - log2(max(yb, 1.0 / 65536.0)), -1.0, 1.0) * uTexture * 0.8);
  }

  if (uWBOn == 1) rgb = max(uWB * rgb, 0.0);

  if (uMixOn == 1 || uVib != 0.0 || uSat != 0.0 || uGradeOn == 1 || uBW == 1) {
    vec3 lab = oklab(max(rgb, 0.0));
    float C = length(lab.yz);
    float h = atan(lab.z, lab.y);
    float chromaW = smoothstep(0.005, 0.05, C);

    if (uMixOn == 1) {
      float hd = degrees(h);
      float dh = 0.0, ds = 0.0, dl = 0.0, wsum = 0.0;
      for (int i = 0; i < 8; i++) {
        float w = mixWeight(hd, i);
        dh += w * uMixHue[i]; ds += w * uMixSat[i]; dl += w * uMixLum[i]; wsum += w;
      }
      if (wsum > 0.0) { dh /= wsum; ds /= wsum; dl /= wsum; }
      h += radians(dh * 35.0) * chromaW;
      C *= max(1.0 + ds * chromaW, 0.0);
      // Lightness change in linear light, weighted by how colourful the pixel is.
      lab.x *= exp2(dl * 0.55 * chromaW * smoothstep(0.02, 0.12, C));
    }

    // Vibrance: lift muted colours more than saturated ones, and protect skin-like hues a little.
    if (uVib != 0.0) {
      float muted = 1.0 - smoothstep(0.02, 0.25, C);
      float skin = exp(-pow((degrees(h) - 55.0) / 22.0, 2.0));
      C *= max(1.0 + uVib * muted * (1.0 - 0.45 * skin * step(0.0, uVib)), 0.0);
    }
    C *= max(1.0 + uSat, 0.0);
    lab.yz = C * vec2(cos(h), sin(h));

    if (uGradeOn == 1) {
      // Zone masks from perceptual lightness of the scene value mapped through the reference curve.
      float x = clamp(pow(hill(Y, 1.5, 0.0792), 1.0 / 2.2), 0.0, 1.0);
      float p = clamp(0.5 - uGBalance * 0.3, 0.15, 0.85);
      float xm = x < p ? 0.5 * x / p : 0.5 + 0.5 * (x - p) / (1.0 - p);
      float sharp = mix(2.2, 0.9, uGBlend);
      float wS = pow(1.0 - smoothstep(0.0, 0.62, xm), sharp);
      float wH = pow(smoothstep(0.38, 1.0, xm), sharp);
      float wM = max(1.0 - wS - wH, 0.0);
      vec3 g = wS * uGS + wM * uGM + wH * uGH + uGG;
      lab.yz += g.xy * smoothstep(0.0, 0.1, lab.x) * max(lab.x, 0.25);
      lab.x *= exp2(g.z * 0.3);
    }
    if (uBW == 1) lab.yz = vec2(0.0);
    rgb = max(unOklab(lab), 0.0);
  }
  o = vec4(rgb, 0.0);
}`;

// ---------------------------------------------------------------- FINAL

export const FINAL = HEAD + LIB + `
uniform sampler2D uIn, uCurve;
uniform mat3 uToImage, uToCrop;
uniform int uCropTest, uClip, uOverlay, uCurveOn, uPathToWhite;
uniform vec3 uBg;
uniform vec2 uInSize, uFullSize;
uniform float uLod, uSharpMask, uCropAspect, uTC, uTK;
uniform vec2 uSharp, uNR;
uniform vec4 uVig;
uniform vec3 uGrain;
in vec2 vUv; out vec4 o;

vec3 at(vec2 uv) { return textureLod(uIn, uv, uLod).rgb; }

float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + ivec2(40000));
  q *= uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 denoise(vec2 uv, vec2 tx, vec3 c0) {
  float Y0 = max(lum(c0), 1e-5);
  float l0 = log2(Y0);
  float sl = mix(0.08, 0.7, uNR.x);
  float sc = mix(0.3, 1.6, uNR.y);
  float Ys = 0.0, wYs = 0.0, wCs = 0.0;
  vec3 cs = vec3(0.0);
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 off = vec2(float(i), float(j));
      vec3 c = at(uv + off * tx * 1.25);
      float Y = max(lum(c), 1e-5);
      float dl = log2(Y) - l0;
      float ws = exp(-dot(off, off) / 4.5);
      float wy = ws * exp(-dl * dl / (2.0 * sl * sl));
      float wc = ws * exp(-dl * dl / (2.0 * sc * sc));
      Ys += wy * Y; wYs += wy;
      cs += wc * (c / Y); wCs += wc;
    }
  }
  return mix(c0 / Y0, cs / wCs, uNR.y) * mix(Y0, Ys / wYs, uNR.x);
}

// Display transform. Per-channel curves desaturate bright colours naturally but shift hues; a
// max-RGB curve keeps hue but never reaches white. Blend from the latter to the former as the
// value approaches display white ("path to white").
vec3 displayTransform(vec3 rgb) {
  rgb = max(rgb, 0.0);
  vec3 pc = vec3(hill(rgb.r, uTC, uTK), hill(rgb.g, uTC, uTK), hill(rgb.b, uTC, uTK));
  if (uPathToWhite == 0) return pc;
  float m = max(rgb.r, max(rgb.g, rgb.b));
  if (m <= 1e-7) return pc;
  float mt = hill(m, uTC, uTK);
  vec3 hp = rgb * (mt / m);
  return mix(hp, pc, smoothstep(0.55, 0.98, mt));
}

// Keep lightness and hue, reduce chroma until the colour fits in sRGB (bisection in OkLCh).
vec3 gamutMap(vec3 lin, bool soft) {
  bool outside = any(lessThan(lin, vec3(-1e-5))) || any(greaterThan(lin, vec3(1.00001)));
  if (!outside && !soft) return lin;
  vec3 lab = oklab(FROM_SRGB * lin);
  float L = clamp(lab.x, 0.0, 1.0);
  float C = length(lab.yz);
  if (C < 1e-6) return vec3(L * L * L);
  vec2 dir = lab.yz / C;
  float lo = 0.0, hi = C;
  vec3 t = TO_SRGB * unOklab(vec3(L, dir * C));
  if (all(greaterThanEqual(t, vec3(-1e-5))) && all(lessThanEqual(t, vec3(1.00001)))) lo = C;
  else {
    for (int i = 0; i < 12; i++) {
      float mid = 0.5 * (lo + hi);
      vec3 s = TO_SRGB * unOklab(vec3(L, dir * mid));
      if (all(greaterThanEqual(s, vec3(-1e-5))) && all(lessThanEqual(s, vec3(1.00001)))) lo = mid; else hi = mid;
    }
  }
  float Cm = lo;
  if (soft && C > 0.8 * Cm && Cm > 0.0) {
    // Smoothly roll chroma off above 80 % of the boundary (only for scene-referred sources).
    float k = 0.8 * Cm, r = Cm - k;
    C = min(C, k + r * (1.0 - exp(-(C - k) / r)));
  } else C = min(C, Cm);
  return clamp(TO_SRGB * unOklab(vec3(L, dir * C)), 0.0, 1.0);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (uToImage * vec3(fc, 1.0)).xy;
  vec2 cuv = (uToCrop * vec3(fc, 1.0)).xy;
  bool outside = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)));
  if (uCropTest == 1 && (any(lessThan(cuv, vec2(0.0))) || any(greaterThan(cuv, vec2(1.0))))) outside = true;
  if (outside) { o = vec4(uBg, 1.0); return; }

  vec4 base = textureLod(uIn, uv, uLod);
  vec3 rgb = base.rgb;
  vec2 tx = exp2(uLod) / uInSize;

  if (uNR.x > 0.0 || uNR.y > 0.0) rgb = denoise(uv, tx, rgb);
  if (uSharp.x > 0.0) {
    vec2 r = tx * uSharp.y;
    vec3 b = 4.0 * rgb
      + 2.0 * (at(uv + vec2(r.x, 0.0)) + at(uv - vec2(r.x, 0.0)) + at(uv + vec2(0.0, r.y)) + at(uv - vec2(0.0, r.y)))
      + at(uv + r) + at(uv - r) + at(uv + vec2(r.x, -r.y)) + at(uv + vec2(-r.x, r.y));
    b /= 16.0;
    float det = log2(max(lum(rgb), 1e-5)) - log2(max(lum(b), 1e-5));
    float edge = uSharpMask > 0.0 ? smoothstep(uSharpMask * 0.08, uSharpMask * 0.08 + 0.03, abs(det)) : 1.0;
    rgb *= exp2(clamp(det, -1.0, 1.0) * uSharp.x * 1.6 * edge);
  }

  vec3 disp = displayTransform(rgb);              // display-linear Rec.2020
  vec3 lin = gamutMap(TO_SRGB * disp, uPathToWhite == 1);
  vec3 s = encode(lin);

  if (uCurveOn == 1) {
    vec3 cx = s * (255.0 / 256.0) + 0.5 / 256.0;
    s = vec3(texture(uCurve, vec2(cx.r, 0.5)).a, texture(uCurve, vec2(cx.g, 0.5)).a, texture(uCurve, vec2(cx.b, 0.5)).a);
    cx = clamp(s, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    s = vec3(texture(uCurve, vec2(cx.r, 0.5)).r, texture(uCurve, vec2(cx.g, 0.5)).g, texture(uCurve, vec2(cx.b, 0.5)).b);
  }

  if (uVig.x != 0.0) {
    vec2 q = (cuv - 0.5) * 2.0;
    float ar = uCropAspect;
    vec2 qc = ar >= 1.0 ? vec2(q.x, q.y / ar) : vec2(q.x * ar, q.y);
    vec2 qq = mix(q, qc, max(uVig.z, 0.0));
    float n = 2.0 + max(-uVig.z, 0.0) * 6.0;
    float dist = pow(pow(abs(qq.x), n) + pow(abs(qq.y), n), 1.0 / n);
    float inner = mix(0.25, 1.25, uVig.y);
    float f = mix(0.04, 1.1, uVig.w);
    float v = smoothstep(inner - f * 0.5, inner + f * 0.5, dist);
    s = uVig.x < 0.0 ? s * (1.0 + uVig.x * v) : mix(s, vec3(1.0), uVig.x * v);
  }
  if (uGrain.x > 0.0) {
    vec2 gp = uv * uFullSize / uGrain.y;
    float n1 = vnoise(gp) - 0.5;
    float n2 = vnoise(gp * 2.3 + 17.0) - 0.5;
    float n = mix(n1, n1 * 0.6 + n2 * 0.8, uGrain.z);
    float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
    s += n * uGrain.x * 0.28 * (0.35 + 2.6 * l * (1.0 - l));
  }
  s = clamp(s, 0.0, 1.0);
  if (uClip == 1) {
    if (max(s.r, max(s.g, s.b)) >= 0.998) s = vec3(1.0, 0.18, 0.22);
    else if (max(s.r, max(s.g, s.b)) <= 0.004) s = vec3(0.2, 0.45, 1.0);
  }
  if (uOverlay == 1) s = mix(s, vec3(0.98, 0.22, 0.34), base.a * 0.55);
  o = vec4(s, 1.0);
}`;
