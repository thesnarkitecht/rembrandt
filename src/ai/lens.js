// AI lens effects, as engine host passes on scene-linear data:
//   • Lens blur from the depth map — refocus anywhere, adjustable depth of field, bokeh highlights
//   • Background blur / replacement (colour or picture) from the subject mask
//   • Focus sharpening on the in-focus plane
// Blur is a disc gather at half resolution with depth-aware occlusion (a farther pixel never spreads
// over a nearer one by more than the nearer pixel's own blur), then composited at full resolution.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { LIB } from '../../engine/src/shaders.js';
import { toneK, toneInv, mul3, SRGB_TO_REC2020, REF_CONTRAST } from '../../engine/src/color.js';
import { ai } from './ai.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + LIB;

const COMMON = `
uniform sampler2D uDepth, uSubj, uBgImg, uFg;
uniform int uHasDepth, uHasSubj, uBgMode;   // 0 none, 1 blur only, 2 colour, 3 picture
uniform vec3 uBgColor;
uniform vec4 uLens;     // amount·maxR (texels of the current target), focus, half range, protect
uniform float uBgBlur;  // maxR for background blur
uniform float uBgAspect, uImgAspect, uInC, uInK;
float depthAt(vec2 uv) { return uHasDepth == 1 ? textureLod(uDepth, uv, 0.0).r : 0.5; }
float subjAt(vec2 uv) { return uHasSubj == 1 ? textureLod(uSubj, uv, 0.0).r : 0.0; }
vec3 background(vec2 uv, vec3 rgb) {
  if (uBgMode == 2) return uBgColor;
  if (uBgMode == 3) {
    // cover-fit the picture
    vec2 q = uv - 0.5;
    if (uBgAspect > uImgAspect) q.x *= uImgAspect / uBgAspect; else q.y *= uBgAspect / uImgAspect;
    vec3 c = FROM_SRGB * textureLod(uBgImg, q + 0.5, 0.0).rgb;
    return vec3(hillInv(c.r, uInC, uInK), hillInv(c.g, uInC, uInK), hillInv(c.b, uInC, uInK));
  }
  return rgb;
}
vec3 replaced(vec2 uv, vec3 rgb) {
  if (uBgMode < 2) return rgb;
  float s = subjAt(uv);
  float a = smoothstep(0.08, 0.92, s);
  if (a > 0.0 && a < 1.0) {
    // Edge decontamination: replace the old background's colour spill with the nearby subject colour,
    // keeping the pixel's own brightness.
    vec4 f = textureLod(uFg, uv, 0.0);
    vec3 F = f.rgb / max(f.a, 1e-3);
    vec3 Fc = F * (lum(rgb) / max(lum(F), 1e-5));
    rgb = mix(Fc, rgb, a * a);
  }
  return mix(background(uv, rgb), rgb, a);
}
// Circle of confusion radius. Inverse depth makes it linear in the distance from the focal plane.
float coc(vec2 uv) {
  float d = depthAt(uv), s = subjAt(uv);
  float c = 0.0;
  if (uLens.x > 0.0 && uHasDepth == 1) c = uLens.x * clamp((abs(d - uLens.y) - uLens.z) * 2.2, 0.0, 1.0);
  c *= 1.0 - s * uLens.w;
  if (uBgBlur > 0.0) c = max(c, uBgBlur * (1.0 - s));
  return c;
}
`;

// Half-resolution prepass: replaced colour with boosted highlights, and the CoC in half-res texels.
const PREP = HEAD + COMMON + `
uniform sampler2D uIn;
uniform vec2 uSrcTexel;
uniform float uBokeh;
in vec2 vUv; out vec4 o;
void main() {
  vec2 d = uSrcTexel * 0.5;
  vec3 c = 0.25 * (textureLod(uIn, vUv + vec2(-d.x, -d.y), 0.0).rgb + textureLod(uIn, vUv + vec2(d.x, -d.y), 0.0).rgb
                 + textureLod(uIn, vUv + vec2(-d.x, d.y), 0.0).rgb + textureLod(uIn, vUv + d, 0.0).rgb);
  c = replaced(vUv, c);
  float Y = lum(c);
  // Bokeh boost: specular highlights carry more energy than an 8-bit capture recorded.
  c *= 1.0 + uBokeh * 3.0 * smoothstep(1.0, 4.0, Y / GREY);
  o = vec4(c, coc(vUv));
}`;

const GATHER = HEAD + COMMON + `
uniform sampler2D uIn;
uniform vec2 uTexel;
uniform int uTaps; // 96, or fewer for a quick draft while a slider moves
in vec2 vUv; out vec4 o;
const int N = 96;
void main() {
  vec4 c0 = textureLod(uIn, vUv, 0.0);
  float r0 = c0.a, d0 = depthAt(vUv);
  if (r0 < 0.5) { o = c0; return; }
  vec3 acc = c0.rgb; float ws = 1.0;
  float R = r0;
  // Golden-angle spiral; samples beyond R are skipped.
  float n = float(uTaps);
  for (int i = 1; i < N; i++) {
    if (i >= uTaps) break;
    float fi = float(i);
    float rr = sqrt(fi / n) * R;
    float a = fi * 2.39996323;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
    vec4 s = textureLod(uIn, uv, 0.0);
    float rs = s.a;
    // A sample behind this pixel may not spread over it further than this pixel's own blur.
    if (depthAt(uv) < d0 - 0.02) rs = min(rs, r0);
    float w = clamp(rs - rr + 1.0, 0.0, 1.0);
    acc += s.rgb * w; ws += w;
  }
  o = vec4(acc / ws, r0);
}`;

// Subject-weighted colour (premultiplied), blurred afterwards, for edge decontamination.
const FG = HEAD + COMMON + `
uniform sampler2D uIn;
in vec2 vUv; out vec4 o;
void main() {
  float s = smoothstep(0.6, 1.0, subjAt(vUv));
  o = vec4(textureLod(uIn, vUv, 0.0).rgb * s, s);
}`;

const COMPOSE = HEAD + COMMON + `
uniform sampler2D uIn, uBlur;
uniform vec2 uTexel;
uniform float uHalfScale, uFocusSharp;
uniform int uDepthView;
in vec2 vUv; out vec4 o;
void main() {
  vec4 src = textureLod(uIn, vUv, 0.0);
  vec3 c = replaced(vUv, src.rgb);
  vec4 b = textureLod(uBlur, vUv, 0.0);
  float r = coc(vUv) * uHalfScale;        // full-res texels
  if (uFocusSharp > 0.0) {
    vec2 d = uTexel;
    vec3 m = 0.25 * (textureLod(uIn, vUv + vec2(d.x, 0.0), 0.0).rgb + textureLod(uIn, vUv - vec2(d.x, 0.0), 0.0).rgb
                   + textureLod(uIn, vUv + vec2(0.0, d.y), 0.0).rgb + textureLod(uIn, vUv - vec2(0.0, d.y), 0.0).rgb);
    float det = clamp(log2(max(lum(src.rgb), 1e-5)) - log2(max(lum(m), 1e-5)), -0.7, 0.7);
    float inFocus = 1.0 - smoothstep(0.5, 3.0, r);
    c *= exp2(det * uFocusSharp * 1.8 * inFocus);
  }
  o = vec4(mix(c, b.rgb, smoothstep(0.6, 2.2, r)), src.a);
  if (uDepthView == 1) {
    // Show the depth map (near = light) through the display transform.
    float d = depthAt(vUv);
    o = vec4(vec3(hillInv(pow(0.08 + 0.84 * d, 2.2), uInC, uInK)), src.a);
  }
}`;

const programs = new WeakMap();
const bgImages = new Map(); // key -> {tex, aspect}

export async function setBackgroundImage(engine, key, blob) {
  if (!key || bgImages.has(key)) return;
  const bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const gl = engine.gl;
  const k = Math.min(1, 3072 / Math.max(bm.width, bm.height));
  const c = new OffscreenCanvas(Math.round(bm.width * k), Math.round(bm.height * k));
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  for (const [kk, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, kk, v);
  bgImages.set(key, { tex, aspect: bm.width / bm.height });
  bm.close();
}
export const hasBackgroundImage = (key) => bgImages.has(key);

const hexToLinear = (hex) => {
  const n = parseInt((hex || '#808080').slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255)];
};

export function lensActive(p) {
  const a = p.ai;
  if (p._depthView) return true;
  return !!a && (a.blur.amount > 0 || a.blur.sharpen > 0 || a.bg.mode !== 'none' || a.bg.blur > 0);
}

function uniformsFor(engine, p) {
  const a = p.ai, L = engine.L;
  const hh = Math.max(1, Math.round(L.h / 2));
  const maxR = 0.028 * hh;   // half-res texels at amount 100
  let mode = { none: 0, blur: 1, color: 2, image: 3 }[a.bg.mode] || 0;
  const img = mode === 3 ? bgImages.get(a.bg.image) : null;
  if (mode === 3 && !img) mode = 0;
  const hasS = !!ai.tex.subject, hasD = !!ai.tex.depth;
  // Colour lives in scene-linear Rec.2020; picker colours are display sRGB -> invert the display curve.
  const k = toneK(REF_CONTRAST);
  const bgc = mul3(SRGB_TO_REC2020, hexToLinear(a.bg.color)).map((v) => toneInv(v));
  return {
    uDepth: ai.tex.depth || engine.dummy, uSubj: ai.tex.subject || engine.dummy, uBgImg: img ? img.tex : engine.dummy,
    uHasDepth: hasD ? 1 : 0, uHasSubj: hasS && (a.blur.protect || a.bg.mode !== 'none' || a.bg.blur > 0) ? 1 : 0,
    uBgMode: hasS ? mode : 0, uBgColor: bgc,
    uLens: [(a.blur.amount / 100) * maxR, a.blur.focus < 0 ? ai.focusDepth(ai.entry) : a.blur.focus, (a.blur.range / 100) * 0.5, a.blur.protect && hasS ? 1 : 0],
    uBgBlur: hasS && (a.bg.mode === 'blur' || a.bg.blur > 0) ? (Math.max(a.bg.blur, a.bg.mode === 'blur' ? 1 : 0) / 100) * maxR : 0,
    uBgAspect: img ? img.aspect : 1, uImgAspect: engine.fullW / engine.fullH,
    uInC: REF_CONTRAST, uInK: k,
    uBokeh: a.blur.bokeh / 100,
    uFocusSharp: (a.blur.sharpen || 0) / 100,
    uDepthView: p._depthView && hasD ? 1 : 0,
    maxR,
  };
}

// Draft quality while a slider is being dragged: fewer samples, then full quality on release.
export const quality = { draft: false };

export const lensPass = {
  key(p) {
    if (!lensActive(p)) return '';
    return JSON.stringify([p.ai, quality.draft, !!p._depthView, ai.version, !!ai.tex.depth, !!ai.tex.subject, p.ai.bg.image && hasBackgroundImage(p.ai.bg.image)]);
  },
  run(engine, p, ctx, input) {
    if (!lensActive(p)) return input;
    let P = programs.get(engine);
    if (!P) { P = { fg: engine.program(FG), prep: engine.program(PREP), gather: engine.program(GATHER), compose: engine.program(COMPOSE) }; programs.set(engine, P); }
    const L = engine.L;
    const hw = Math.max(1, Math.round(L.w / 2)), hh = Math.max(1, Math.round(L.h / 2));
    if (!L.T.lensA || L.T.lensA.w !== hw) {
      engine.free(L.T.lensA); engine.free(L.T.lensB);
      L.T.lensA = engine.target(hw, hh); L.T.lensB = engine.target(hw, hh);
    }
    if (!L.T.lensOut) L.T.lensOut = engine.target(L.w, L.h, { mip: input.mip });
    const u = uniformsFor(engine, p);
    if (u.uBgMode >= 2) {
      const f1 = engine.tgt('lensF1'), f2 = engine.tgt('lensF2');
      engine.draw(P.fg, { ...u, uIn: input.tex }, f1);
      engine.blur(f1, f2, Math.max(2, 0.012 * Math.max(L.qw, L.qh)));
      u.uFg = f1.tex;
    }
    engine.draw(P.prep, { ...u, uIn: input.tex, uSrcTexel: [1 / L.w, 1 / L.h] }, L.T.lensA);
    engine.draw(P.gather, { ...u, uIn: L.T.lensA.tex, uTexel: [1 / hw, 1 / hh], uTaps: quality.draft ? 32 : 96 }, L.T.lensB);
    engine.draw(P.compose, { ...u, uIn: input.tex, uBlur: L.T.lensB.tex, uTexel: [1 / L.w, 1 / L.h], uHalfScale: L.w / hw }, L.T.lensOut);
    return L.T.lensOut;
  },
};

// Several host passes in order.
export function chain(...passes) {
  return {
    key: (p, ctx) => passes.map((x) => x.key(p, ctx)).join('#'),
    run(engine, p, ctx, input) {
      let cur = input;
      for (const x of passes) if (x.key(p, ctx)) cur = x.run(engine, p, ctx, cur) || cur;
      return cur;
    },
  };
}
