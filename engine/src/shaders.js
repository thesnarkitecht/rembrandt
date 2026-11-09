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

import { OK_M1, OK_M1_INV, OK_M2, OK_M2_INV, REC2020_TO_SRGB, SRGB_TO_REC2020, REC2020_LUMA, MIDDLE_GREY, RAW_TWIST, RAW_CHROMA, SCENE_CONTRAST, toneK, sceneWhiteGain, REC2020_TO_PRO, PRO_TO_REC2020, COLOR_BANDS, COLOR_ROLLOFF, COLOR_CURVE_LUT } from './color.js';

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

// RGB tone (as in the DNG specification): the largest and smallest channel go through the curve, the
// middle one keeps its place between them, so hue holds as values move along the curve (separate
// per-channel curves skew it: orange turns yellow as it brightens). w scales the curve to a white
// point (1 = none). The inverse is exact, so display-referred images round-trip unchanged.
vec3 rgbTone(vec3 c, float tc, float tk, float w) {
  c = max(c, 0.0);
  float hi = max(c.r, max(c.g, c.b)), lo = min(c.r, min(c.g, c.b));
  float H = min(1.0, hill(hi, tc, tk) * w), L = min(1.0, hill(lo, tc, tk) * w);
  if (hi - lo < 1e-9) return vec3(H);
  return L + (c - lo) * ((H - L) / (hi - lo));
}
vec3 rgbToneInv(vec3 d, float tc, float tk) {
  d = clamp(d, 0.0, 1.0);
  float hi = max(d.r, max(d.g, d.b)), lo = min(d.r, min(d.g, d.b));
  float H = hillInv(hi, tc, tk), L = hillInv(lo, tc, tk);
  if (hi - lo < 1e-9) return vec3(H);
  return L + (d - lo) * ((H - L) / (hi - lo));
}

// Raised-cosine window: 1 at centre, 0 beyond ±w.
float bump(float x, float c, float w) { float d = clamp((x - c) / w, -1.0, 1.0); return 0.5 + 0.5 * cos(d * PI); }
`;

// Tone zones (blacks, shadows, highlights, whites). Each zone is a soft window over the displayed
// lightness of the local base layer (x, 0–1, through the RAW display curve), wide and overlapping like
// a print's tones: a slider moves its own range most and fades out across its neighbours instead of
// stopping at an edge, so adjustments blend into the light around them. Shapes (see ZONE_SHAPES in
// pipeline.js): centre, width below, width above (negative = flat to that end), EV at +100, EV at −100.
const ZONES = `
uniform vec4 uZoneW[4];     // centre, width below, width above (raising)
uniform vec4 uZoneWn[4];    // the same, lowering
uniform vec2 uZoneA[4];     // EV at +100, at −100
float zoneWindow(float x, vec4 z) {
  float w = x < z.x ? z.y : z.z;
  if (w < 0.0) return 1.0;
  return bump(x, z.x, w);
}
float zoneGain(float x, vec4 t) {
  float g = 0.0;
  for (int i = 0; i < 4; i++) {
    float v = t[i];
    g += v > 0.0 ? v * uZoneA[i].x * zoneWindow(x, uZoneW[i]) : v * uZoneA[i].y * zoneWindow(x, uZoneWn[i]);
  }
  return g;
}
// Displayed lightness (0–1) of a scene-linear luminance, through the RAW display curve.
float shownLightness(float Y) {
  float p = pow(max(Y, 0.0), ${SCENE_CONTRAST.toFixed(3)});
  return pow(clamp(p / (p + ${toneK(SCENE_CONTRAST).toFixed(6)}) * ${sceneWhiteGain(SCENE_CONTRAST).toFixed(6)}, 0.0, 1.0), 1.0 / 2.2);
}
`;

const INPUT = `
uniform sampler2D uSrc;
uniform int uSrcLinear;
uniform float uSrcGain, uInC, uInK;
// RAW base look (see rawLook in color.js): camera-JPEG colourfulness, violet-leaning blues toward cyan.
vec3 rawLook(vec3 rgb) {
  vec3 lab = oklab(max(rgb, 0.0));
  float C = length(lab.yz);
  if (C < 0.01) return max(unOklab(vec3(lab.x, lab.yz * ${RAW_CHROMA.toFixed(3)})), 0.0);
  float h = atan(lab.z, lab.y);
  float d = clamp((degrees(h) - ${RAW_TWIST.centre.toFixed(1)}) / ${RAW_TWIST.width.toFixed(1)}, -1.0, 1.0);
  float wc = smoothstep(0.0, 1.0, clamp((C - 0.01) / 0.05, 0.0, 1.0));
  h -= radians(${RAW_TWIST.deg.toFixed(1)}) * (0.5 + 0.5 * cos(d * PI)) * wc;
  C *= ${RAW_CHROMA.toFixed(3)};
  return max(unOklab(vec3(lab.x, C * cos(h), C * sin(h))), 0.0);
}
vec3 sceneIn(vec2 uv) {
  vec3 c = textureLod(uSrc, uv, 0.0).rgb;
  if (uSrcLinear == 1) return rawLook(FROM_SRGB * (c * uSrcGain));
  return rgbToneInv(FROM_SRGB * c, uInC, uInK);
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
uniform mat3 uPersp;   // perspective on centred coordinates in half-heights (identity when unused)
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
  vec3 h = uPersp * vec3(d / (0.5 * uSize.y), 1.0);
  d = h.xy / h.z * (0.5 * uSize.y);
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
uniform int uHaze, uMap;
uniform sampler2D uHazeAB;
uniform vec3 uA;
uniform float uExposure, uOmega, uHazeAdd, uDehaze;
in vec2 vUv; out vec4 o;
void main() {
  vec3 I = sceneIn(vUv);
  if (uMap == 1) {
    // Transmission with all the haze the dark channel prior finds (ω = 1), refined by the guided filter.
    vec2 ab = textureLod(uHazeAB, vUv, 0.0).xy;
    float t1 = clamp(ab.x * (lum(I) / lum(uA)) + ab.y, 0.0, 1.0);
    // A veil in the airlight's colour at a moderate level (a bright sky would wash everything out).
    vec3 veil = uA * (min(lum(uA), 0.45) / lum(uA));
    if (uHaze == 1) {
      float t = clamp(1.0 - uOmega * (1.0 - t1), 0.1, 1.0);
      I = max((I - uA) / t + uA, 0.0);
    } else if (uHaze == 2) {
      float t = clamp(1.0 - 0.9 * (1.0 - t1), 0.0, 1.0);
      I = mix(I, veil, uHazeAdd * (1.0 - 0.6 * t));
    }
    if (uDehaze > 0.0) {
      // J = (I − A)/t + A, removing most of the haze by +60 (ω eases toward 0.95). The floor on t keeps
      // dense haze from turning to noise and darks from crushing.
      float w = 0.95 * (1.0 - (1.0 - uDehaze) * (1.0 - uDehaze));
      float t = max(1.0 - w * (1.0 - t1), 0.3);
      vec3 J = max((I - uA) / t + uA, 0.0);
      // The haze also carried light: give part of it back where it was thick, so the photo doesn't sink.
      float back = clamp(lum(I) / max(lum(J), 1e-5), 1.0, 3.0);
      I = J * mix(1.0, back, 0.5 * (1.0 - t));
    } else if (uDehaze < 0.0) {
      // Adding haze: I·t + veil·(1 − t), everywhere a little and thicker in the distance.
      float t = 1.0 - 0.8 * -uDehaze * (1.0 - 0.6 * t1);
      I = I * t + veil * (1.0 - t);
    }
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
uniform vec3 uHdr;            // shadows opened, highlights brought down, detail
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
// Point Color: up to 8 picked colours (Oklab L, a, b) and what to do to each (hue shift in degrees,
// saturation, lightness, range 0–1). uProbe: output instead the Oklab colour Point Color compares
// with at uProbeUv (picking a colour).
uniform int uPCn;
uniform vec3 uPCcol[8];
uniform vec4 uPCadj[8];
uniform int uProbe;
uniform vec2 uProbeUv;
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
  vec2 uv = uProbe == 1 ? uProbeUv : vUv;
  vec3 rgb = textureLod(uPre, uv, 0.0).rgb;
  float Y = max(lum(rgb), 1.0 / 65536.0);

  // Base/detail tone zones and clarity from the edge-preserving log-luminance base layer.
  if (uGuideOn == 1) {
    float g = log2(Y);
    vec2 ab = textureLod(uGuideAB, uv, 0.0).xy;
    float base = ab.x * g + ab.y;
    float ev = base - log2(GREY);
    float gain = zoneGain(shownLightness(exp2(base)), uTone);
    float detail = clamp(g - base, -3.0, 3.0);
    gain += uClarity * 0.65 * detail * exp(-ev * ev / 24.0);
    // HDR (after Durand and Dorsey, 2002): the base layer's distance from mid grey shrinks, so deep
    // shadows open and bright areas come down, while the detail riding on it is kept or lifted.
    // The shadow lift levels off (a black frame doesn't turn to grey noise); nothing moves near mid grey.
    if (uHdr.x + uHdr.y + uHdr.z > 0.0) {
      float e = clamp(ev, -10.0, 7.0);
      gain += e < 0.0 ? uHdr.x * 3.4 * (1.0 - exp(e / 3.4)) : -uHdr.y * e * smoothstep(0.0, 1.2, e);
      gain += uHdr.z * detail;
    }
    rgb *= exp2(gain);
  }
  if (uTexture != 0.0) {
    vec2 d = uTexel * 1.5;
    float yb = 0.25 * (lum(textureLod(uPre, uv + d, 0.0).rgb) + lum(textureLod(uPre, uv - d, 0.0).rgb)
                     + lum(textureLod(uPre, uv + vec2(d.x, -d.y), 0.0).rgb) + lum(textureLod(uPre, uv + vec2(-d.x, d.y), 0.0).rgb));
    rgb *= exp2(clamp(log2(Y) - log2(max(yb, 1.0 / 65536.0)), -1.0, 1.0) * uTexture * 0.8);
  }

  if (uWBOn == 1) rgb = max(uWB * rgb, 0.0);

  if (uMixOn == 1 || uPCn > 0 || uProbe == 1 || uVib != 0.0 || uSat != 0.0 || uGradeOn == 1 || uBW == 1) {
    vec3 lab = oklab(max(rgb, 0.0));
    if (uProbe == 1) { o = vec4(lab, 1.0); return; }
    vec3 lab0 = lab;
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

    // Point Color: each picked colour selects pixels close to it in hue, chroma and lightness (wider
    // with its range), feathered, and shifts their hue, saturation and lightness.
    if (uPCn > 0) {
      float C0 = length(lab0.yz), h0 = atan(lab0.z, lab0.y);
      for (int i = 0; i < 8; i++) {
        if (i >= uPCn) break;
        vec3 pc = uPCcol[i];
        vec4 adj = uPCadj[i];
        float pcC = length(pc.yz);
        float r = adj.w;
        float dh = abs(mod(degrees(h0 - atan(pc.z, pc.y)) + 540.0, 360.0) - 180.0);
        float wh = 1.0 - smoothstep(6.0 + 34.0 * r, 14.0 + 66.0 * r, dh);
        // Hue means little for nearly grey colours: those match on chroma and lightness only.
        wh = mix(1.0, wh, smoothstep(0.01, 0.04, min(C0, pcC)));
        float wc = 1.0 - smoothstep(0.03 + 0.09 * r, 0.06 + 0.18 * r, abs(C0 - pcC));
        float wl = 1.0 - smoothstep(0.12 + 0.28 * r, 0.25 + 0.45 * r, abs(lab0.x - pc.x));
        float w = wh * wc * wl * smoothstep(0.0, 0.02, C0);
        if (w <= 0.0) continue;
        h += radians(adj.x) * w;
        C *= max(1.0 + adj.y * w, 0.0);
        lab.x *= exp2(adj.z * 0.6 * w);
      }
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
uniform int uCropTest, uClip, uOverlay, uCurveOn, uPathToWhite, uDither;
// While a slider moves: noise reduction on 3 × 3 samples spread over the same radius instead of 5 × 5,
// no despeckle, a coarser gamut search. Sharp again, and exact, the moment the slider is let go.
uniform int uFast;
uniform vec3 uBg;
uniform vec2 uInSize, uFullSize;
uniform float uLod, uSharpMask, uCropAspect, uTC, uTK, uTW, uSpeckle, uSpots;
uniform vec2 uSharp, uNR;
uniform vec4 uVig;
uniform vec3 uGrain;
uniform int uCamOn;
uniform int uProfile;
uniform int uLutOn;
uniform highp sampler3D uLut;
uniform float uLutN, uLutAmt;
uniform float uCamL[17], uCamGain[8], uCamShift[8];
in vec2 vUv; out vec4 o;

vec3 at(vec2 uv) { return textureLod(uIn, uv, uLod).rgb; }

// The learned camera look (src/camera-match.js applyLook): a lightness curve, then saturation and
// hue per Oklab hue band, linear between band centres. On display-linear Rec.2020.
vec3 cameraLook(vec3 disp) {
  vec3 lab = oklab(max(disp, 0.0));
  float x = clamp(lab.x, 0.0, 1.0) * 16.0;
  int j = min(15, int(floor(x)));
  float L = mix(uCamL[j], uCamL[j + 1], x - float(j));
  float C = length(lab.yz);
  if (C < 1e-6) return unOklab(vec3(L, lab.yz));
  float h = atan(lab.z, lab.y);
  float t = (h + PI) / (2.0 * PI / 8.0) - 0.5, k0 = floor(t), f = t - k0;
  int i0 = int(mod(k0 + 8.0, 8.0)), i1 = (i0 + 1) % 8;
  float g = mix(uCamGain[i0], uCamGain[i1], f), sh = mix(uCamShift[i0], uCamShift[i1], f);
  return unOklab(vec3(L, C * g * cos(h + sh), C * g * sin(h + sh)));
}

// Rembrandt Color (see PROFILES in color.js): smooth hue bands in linear ProPhoto HSV, saturation
// rolling off near white, then a mild S curve that keeps hue (darkest and brightest channel through
// the curve, the middle one in proportion). On display-linear Rec.2020.
const mat3 TO_PRO = ${glmat(REC2020_TO_PRO)};
const mat3 FROM_PRO = ${glmat(PRO_TO_REC2020)};
const float PCURVE[33] = float[33](${COLOR_CURVE_LUT.map((v) => v.toFixed(5)).join(', ')});
float enc1(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float dec1(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float pcurve(float x) { float t = clamp(x, 0.0, 1.0) * 32.0; int i = min(31, int(t)); return mix(PCURVE[i], PCURVE[i + 1], t - float(i)); }
vec3 profileColor(vec3 disp) {
  vec3 p = clamp(TO_PRO * max(disp, 0.0), 0.0, 1.0);
  float mx = max(p.r, max(p.g, p.b)), mn = min(p.r, min(p.g, p.b)), d = mx - mn;
  if (mx > 1e-6 && d > 1e-6) {
    float h = mx == p.r ? mod((p.g - p.b) / d, 6.0) : mx == p.g ? (p.b - p.r) / d + 2.0 : (p.r - p.g) / d + 4.0;
    float hue = h * 60.0, sat = d / mx, v = enc1(mx);
    float shift = 0.0, sm = 1.0, vm = 1.0;
${COLOR_BANDS.map(([c, w, sh, sa, va]) => `    { float dd = mod(hue - ${c.toFixed(1)} + 180.0, 360.0) - 180.0; if (abs(dd) < ${w.toFixed(1)}) { float k = 0.5 + 0.5 * cos(PI * dd / ${w.toFixed(1)}); shift += ${sh.toFixed(2)} * k; sm *= 1.0 + ${(sa - 1).toFixed(3)} * k; vm *= 1.0 + ${(va - 1).toFixed(3)} * k; } }`).join('\n')}
    float sf = smoothstep(0.0, 0.35, sat), roll = 1.0 - ${COLOR_ROLLOFF.toFixed(2)} * smoothstep(0.7, 1.0, v);
    hue = mod(hue + shift * sf, 360.0);
    sat = clamp(sat * (1.0 + (sm - 1.0) * sf) * roll, 0.0, 1.0);
    float V = dec1(v * (1.0 + (vm - 1.0) * sf));
    float hh = hue / 60.0, c = V * sat, x = c * (1.0 - abs(mod(hh, 2.0) - 1.0));
    vec3 q = hh < 1.0 ? vec3(c, x, 0.0) : hh < 2.0 ? vec3(x, c, 0.0) : hh < 3.0 ? vec3(0.0, c, x) : hh < 4.0 ? vec3(0.0, x, c) : hh < 5.0 ? vec3(x, 0.0, c) : vec3(c, 0.0, x);
    p = q + (V - c);
  }
  vec3 e = vec3(enc1(p.r), enc1(p.g), enc1(p.b));
  float lo = min(e.r, min(e.g, e.b)), hi = max(e.r, max(e.g, e.b)), a = pcurve(lo), b = pcurve(hi);
  e = hi - lo > 1e-6 ? a + (b - a) * (e - lo) / (hi - lo) : vec3(a);
  return FROM_PRO * vec3(dec1(e.r), dec1(e.g), dec1(e.b));
}

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
  int n = uFast == 1 ? 1 : 2;
  float step_ = uFast == 1 ? 2.0 : 1.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      if (abs(i) > n || abs(j) > n) continue;
      vec2 off = vec2(float(i), float(j)) * step_;
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

// Colour speckles: single pixels (or a few) whose colour doesn't belong to their surroundings, such as
// red dots at small high-contrast points on skin in high-ISO or demosaiced detail. Colour noise
// reduction can't touch them, as it only averages with neighbours of similar brightness. Here each
// pixel's colour (as ratios to its luminance) is compared with the median of 3 × 3 samples around it
// (McGuire's min/max network, per channel) and replaced by it, luminance kept, as far as it stands out.
#define S2(a, b) { vec3 t_ = a; a = min(t_, b); b = max(t_, b); }
#define MN3(a, b, c) S2(a, b); S2(a, c);
#define MX3(a, b, c) S2(b, c); S2(a, c);
vec3 despeckle(vec2 uv, vec2 tx, vec3 c0, float amt) {
  float Y0 = max(lum(c0), 1e-5);
  vec3 v0 = c0 / Y0, v1, v2, v3, v4, v5, v6, v7, v8;
  // Neighbours two pixels out, so speckles of a few pixels don't prop each other up.
  #define R(o) (at(uv + (o) * 2.0 * tx) / max(lum(at(uv + (o) * 2.0 * tx)), 1e-5))
  v1 = R(vec2(-1.0, -1.0)); v2 = R(vec2(0.0, -1.0)); v3 = R(vec2(1.0, -1.0));
  v4 = R(vec2(-1.0, 0.0)); v5 = R(vec2(1.0, 0.0));
  v6 = R(vec2(-1.0, 1.0)); v7 = R(vec2(0.0, 1.0)); v8 = R(vec2(1.0, 1.0));
  #undef R
  vec3 a = v0, b = v1, c = v2, d = v3, e = v4, f = v5;
  S2(a, d); S2(b, e); S2(c, f); MN3(a, b, c); MX3(d, e, f);
  vec3 g = v6; S2(b, c); S2(d, e); MN3(b, d, g); MX3(c, e, g);
  vec3 h = v7; S2(c, d); S2(e, h); S2(c, e); S2(d, h);
  vec3 k = v8; MX3(d, e, k); S2(d, e);
  vec3 med = e / max(lum(e), 1e-5);
  // How far the pixel's colour stands out, against how much the neighbourhood itself varies.
  float spread = (length(v1 - med) + length(v2 - med) + length(v3 - med) + length(v4 - med)
    + length(v5 - med) + length(v6 - med) + length(v7 - med) + length(v8 - med)) / 8.0;
  float dev = length(v0 - med) / (0.03 + spread);
  // The amount mostly sets how far a colour must stand out; obvious speckles go fully from about 40.
  float w = min(1.0, amt * 2.5) * smoothstep(mix(4.0, 1.6, amt), mix(8.0, 3.0, amt), dev);
  return mix(c0, med * Y0, w);
}

// Display transform: RGB tone (see rgbTone) through the display curve. Display-referred sources (JPEG)
// entered through its exact inverse, so an untouched JPEG round-trips unchanged; scene-referred ones
// (RAW) get Camera Raw's contrast and a white point (uTW), which runs bright colours to white.
vec3 displayTransform(vec3 rgb) { return rgbTone(rgb, uTC, uTK, uTW); }

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
    int steps = uFast == 1 ? 6 : 12;
    for (int i = 0; i < 12; i++) {
      if (i >= steps) break;
      float mid = 0.5 * (lo + hi);
      vec3 s = TO_SRGB * unOklab(vec3(L, dir * mid));
      if (all(greaterThanEqual(s, vec3(-1e-5))) && all(lessThanEqual(s, vec3(1.00001)))) lo = mid; else hi = mid;
    }
  }
  float Cm = lo;
  if (soft && C > 0.95 * Cm && Cm > 0.0) {
    // Smoothly roll chroma off above 95 % of the boundary (only for scene-referred sources); a lower
    // knee visibly desaturates colours that fit (measured against Camera Raw).
    float k = 0.95 * Cm, r = Cm - k;
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

  if (uSpeckle > 0.0 && uFast == 0) rgb = despeckle(uv, tx, rgb, uSpeckle);
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
  if (uCamOn == 1) disp = cameraLook(disp);
  else if (uProfile == 1) disp = profileColor(disp);
  vec3 lin = gamutMap(TO_SRGB * disp, uPathToWhite == 1);
  vec3 s = encode(lin);

  if (uCurveOn == 1) {
    vec3 cx = s * (255.0 / 256.0) + 0.5 / 256.0;
    s = vec3(texture(uCurve, vec2(cx.r, 0.5)).a, texture(uCurve, vec2(cx.g, 0.5)).a, texture(uCurve, vec2(cx.b, 0.5)).a);
    cx = clamp(s, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    s = vec3(texture(uCurve, vec2(cx.r, 0.5)).r, texture(uCurve, vec2(cx.g, 0.5)).g, texture(uCurve, vec2(cx.b, 0.5)).b);
  }

  // Look (a film look or a .cube file): a 3D table on the display-encoded colour, blended by Amount.
  if (uLutOn == 1) {
    vec3 c = clamp(s, 0.0, 1.0) * ((uLutN - 1.0) / uLutN) + 0.5 / uLutN;
    s = mix(s, texture(uLut, c).rgb, uLutAmt);
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
  // Visualize Spots: how far each pixel's brightness stands out from a ring around it, as white on
  // black; dust on the sensor and small spots, invisible in a sky, show as rings and dots.
  if (uSpots > 0.0) {
    // Two rings (4 and 10 pixels out at this zoom), so both specks and wider dust discs stand out;
    // Detail sets the threshold on an exponential scale, from 15 % brighter or darker down to 0.4 %.
    float Y = lum(base.rgb), Y1 = 0.0, Y2 = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 dir = vec2(cos(float(i) * 0.785398), sin(float(i) * 0.785398));
      Y1 += lum(at(uv + dir * tx * 4.0)); Y2 += lum(at(uv + dir * tx * 10.0));
    }
    float d = max(abs(log2((Y + 1e-4) / (Y1 / 8.0 + 1e-4))), abs(log2((Y + 1e-4) / (Y2 / 8.0 + 1e-4))));
    float t = 0.2 * pow(0.006 / 0.2, uSpots);
    s = vec3(smoothstep(t, t * 2.0, d));
  }
  if (uClip == 1) {
    if (max(s.r, max(s.g, s.b)) >= 0.998) s = vec3(1.0, 0.18, 0.22);
    else if (max(s.r, max(s.g, s.b)) <= 0.004) s = vec3(0.2, 0.45, 1.0);
  }
  if (uOverlay == 1) s = mix(s, vec3(0.98, 0.22, 0.34), base.a * 0.55);
  // 8-bit output is dithered: triangular noise of ±1 step turns the steps of a smooth gradient (a sky,
  // a lifted shadow) into grain too fine to see, instead of bands. Float (16-bit) exports skip it.
  if (uDither == 1) s = clamp(s + (hash(fc) + hash(fc + vec2(17.3, 41.9)) - 1.0) / 255.0, 0.0, 1.0);
  o = vec4(s, 1.0);
}`;
