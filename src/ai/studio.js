// AI studio effects, as engine host passes on scene-linear data, driven by the on-device depth map
// and subject mask:
//   • Enhance   one slider: local contrast, lifted shadows and vibrance, a bit more on the subject
//   • Relight   brighten or darken near and far separately, with a warmth shift on the near plane
//   • Sky       deepen, warm and saturate the sky (far, high, bright and not the subject)
//   • Atmosphere haze or fog that thickens with distance
//   • Sunrays   light shafts streaming from a sun point through the bright, far parts of the photo
//   • Skin      smooths skin tones on people, keeping their pores and edges
//   • Motion    directional motion blur on the background (after Lens Blur), the subject kept sharp
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { LIB } from '../../engine/src/shaders.js';
import { ai } from './ai.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + LIB;

const MAPS = `
uniform sampler2D uDepth, uSubj;
uniform int uHasDepth, uHasSubj;
float depthAt(vec2 uv) { return uHasDepth == 1 ? textureLod(uDepth, uv, 0.0).r : 0.5; }
float subjAt(vec2 uv) { return uHasSubj == 1 ? textureLod(uSubj, uv, 0.0).r : 0.0; }
// How much of the sky this pixel is: far, toward the top, brighter than mid grey, not the subject.
float skyAt(vec2 uv, vec3 c) {
  // The depth map is coarse around thin things (masts, branches): take the farthest nearby depth,
  // so the sky right next to them still counts as sky and no halo is left around them.
  float dm = depthAt(uv);
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; dm = min(dm, depthAt(uv + vec2(cos(a), sin(a)) * 0.018)); }
  float far = uHasDepth == 1 ? 1.0 - smoothstep(0.06, 0.22, dm) : 0.0;
  float top = 1.0 - smoothstep(0.35, 0.8, uv.y);
  float lit = smoothstep(0.02, 0.25, lum(c) / GREY);   // not black: dusk skies count too
  return far * top * lit * (1.0 - subjAt(uv));
}
`;

// Quarter-resolution helpers: [0] the image (for skin and local contrast), [1] the bright, far
// light that sunrays carry.
const PREP = HEAD + MAPS + `
uniform sampler2D uIn;
uniform int uMode;
uniform vec2 uSun;
uniform float uAspect;
in vec2 vUv; out vec4 o;
void main() {
  vec3 c = textureLod(uIn, vUv, 0.0).rgb;
  if (uMode == 0) { o = vec4(c, log2(max(lum(c), 1e-5))); return; }
  // Light that can stream: a sun at uSun plus the photo's own bright highlights, only where the
  // far scene or sky shows through. Anything nearer blocks it, which is what draws the shafts.
  float open = uHasDepth == 1 ? 1.0 - smoothstep(0.12, 0.42, depthAt(vUv)) : 1.0;
  open *= 1.0 - subjAt(vUv);
  vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
  float r = length(dv);
  // A small hot core and a wide halo broken into streaks around the sun, so the shafts show even
  // in an open sky; occluders break them up further.
  float ang = atan(dv.y, dv.x);
  float streak = 0.5 + 0.5 * sin(ang * 23.0 + 1.7 * sin(ang * 7.0)) * sin(ang * 11.0 + 0.6);
  streak = 0.12 + 0.88 * streak * streak * streak;
  float sun = exp(-r * r * 2500.0) * 6.0 + exp(-r * 5.0) * 2.6 * streak;
  vec3 hi = c * min(max(lum(c) / GREY - 2.0, 0.0), 6.0) / max(lum(c) / GREY, 1e-3);
  o = vec4((hi + vec3(sun * GREY)) * open, 1.0);
}`;

const MAIN = HEAD + MAPS + `
uniform sampler2D uIn, uSoft, uSoftWide, uLight;
uniform float uEnhance;
uniform vec4 uRelight;      // near EV, far EV, boundary (depth), near warmth
uniform vec3 uSky;          // deepen, warmth, saturation
uniform vec4 uAtmos;        // amount, warmth, lift, density curve
uniform vec4 uRays;         // amount, sun x, sun y, length
uniform float uRayWarm;
uniform float uSkin;
in vec2 vUv; out vec4 o;

vec3 warm(vec3 c, float w) { return c * vec3(1.0 + 0.18 * w, 1.0 + 0.02 * w, 1.0 - 0.2 * w); }
vec3 saturate3(vec3 c, float s) { float Y = lum(c); return max(vec3(0.0), Y + (c - Y) * s); }

void main() {
  vec4 src = textureLod(uIn, vUv, 0.0);
  vec3 c = src.rgb;
  float d = depthAt(vUv), s = subjAt(vUv);

  // Skin: on people, pull skin tones toward their smoothed version, keeping fine texture.
  if (uSkin > 0.0) {
    vec3 sm = textureLod(uSoft, vUv, 0.0).rgb;
    float r = c.r, g = c.g, b = c.b;
    float skin = smoothstep(0.02, 0.12, (r - g) / max(r, 1e-4)) * (1.0 - smoothstep(0.45, 0.7, (r - b) / max(r, 1e-4))) * step(b, g * 1.25);
    float k = uSkin * smoothstep(0.4, 0.9, s) * skin;
    float Y = lum(c), Ys = lum(sm);
    // Low frequencies from the smoothed copy, a quarter of the original's detail kept.
    vec3 smooth3 = sm * pow(max(Y, 1e-5) / max(Ys, 1e-5), 0.25);
    c = mix(c, smooth3, clamp(k * 0.85, 0.0, 0.85));
  }

  // Enhance: local contrast, lifted shadows and vibrance, a little stronger on the subject.
  if (uEnhance > 0.0) {
    float e = uEnhance * (1.0 + 0.3 * s);
    float Y = max(lum(c), 1e-5);
    float detail = clamp(log2(Y) - textureLod(uSoftWide, vUv, 0.0).a, -2.0, 2.0);
    c *= exp2(detail * 0.35 * e);
    Y = max(lum(c), 1e-5);
    c *= exp2(0.7 * e * (1.0 - smoothstep(0.02, 1.0, Y / GREY)));
    float sat = length(c - lum(c)) / max(lum(c), 1e-4);
    c = saturate3(c, 1.0 + 0.45 * e * (1.0 - smoothstep(0.0, 0.8, sat)));
  }

  // Relight: exposure by depth, near and far separately.
  if (uHasDepth == 1 && (uRelight.x != 0.0 || uRelight.y != 0.0 || uRelight.w != 0.0)) {
    float n = smoothstep(uRelight.z - 0.18, uRelight.z + 0.18, d);
    c *= exp2(mix(uRelight.y, uRelight.x, n));
    if (uRelight.w != 0.0) c = warm(c, uRelight.w * n);
  }

  // Sky: deepen (darker, richer), warm, saturate.
  if (uSky.x != 0.0 || uSky.y != 0.0 || uSky.z != 0.0) {
    float m = skyAt(vUv, c);
    if (m > 0.0) {
      vec3 k = c * exp2(-1.1 * uSky.x * m);
      k = saturate3(k, 1.0 + (0.6 * uSky.x + uSky.z) * m);
      if (uSky.y != 0.0) k = warm(k, uSky.y * m);
      c = k;
    }
  }

  // Atmosphere: haze that thickens with distance.
  if (uAtmos.x > 0.0 && uHasDepth == 1) {
    // Beer–Lambert: light fades with distance; the air glows with the scene's
    // own ambient colour, lifted toward white.
    // Depth smoothed widely: haze changes slowly, and the map's coarse edges shouldn't show in it.
    float ds = d * 2.0;
    for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398 + 0.39; ds += depthAt(vUv + vec2(cos(a), sin(a)) * 0.035); }
    ds = mix(ds / 10.0, d, 0.25);
    float T = exp(-uAtmos.x * 2.4 * pow(clamp(1.0 - ds, 0.0, 1.0), uAtmos.w));
    T = mix(T, 1.0, 0.75 * s);
    // The air takes the colour of the light around it, averaged widely so it reads as a veil,
    // never as smudges of the scene.
    vec3 ambient = vec3(0.0);
    for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; ambient += textureLod(uSoftWide, clamp(vUv + vec2(cos(a), sin(a)) * 0.22, 0.0, 1.0), 0.0).rgb; }
    ambient = max(ambient / 8.0, vec3(1e-4));
    vec3 air = mix(vec3(lum(ambient)), ambient, 0.35) * (1.4 + 2.6 * uAtmos.z) + vec3(GREY * 0.6 * uAtmos.z);
    air = warm(air, uAtmos.y);
    c = c * T + air * (1.0 - T);
  }

  // Sunrays: march from this pixel toward the sun through the bright, far light.
  if (uRays.x > 0.0) {
    vec2 sun = uRays.yz;
    vec2 step = (sun - vUv) * uRays.w / 48.0;
    vec2 p = vUv; vec3 acc = vec3(0.0); float w = 1.0;
    for (int i = 0; i < 48; i++) {
      p += step;
      acc += textureLod(uLight, p, 0.0).rgb * w;
      w *= 0.955;
    }
    float fall = 1.0 - smoothstep(0.0, 1.3, distance(vUv, sun));
    c += warm(acc / 48.0, uRayWarm) * uRays.x * 2.2 * (0.35 + 0.65 * fall);
  }
  o = vec4(c, src.a);
}`;

// After Lens Blur: directional motion blur on the background.
const MOTION = HEAD + MAPS + `
uniform sampler2D uIn;
uniform vec2 uDir;      // full blur length in uv, along the chosen angle
uniform float uProtect;
in vec2 vUv; out vec4 o;
void main() {
  vec4 src = textureLod(uIn, vUv, 0.0);
  float keep = uProtect > 0.5 ? smoothstep(0.3, 0.85, subjAt(vUv)) : 0.0;
  if (keep > 0.98) { o = src; return; }
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    vec2 uv = vUv + uDir * (float(i) / 48.0);
    // The subject doesn't smear into the background.
    float w = 1.0 - (uProtect > 0.5 ? smoothstep(0.3, 0.85, subjAt(uv)) : 0.0) * 0.9;
    acc += textureLod(uIn, uv, 0.0).rgb * w; ws += w;
  }
  o = vec4(mix(acc / max(ws, 1e-4), src.rgb, keep), src.a);
}`;

const programs = new WeakMap();
const progs = (engine) => {
  let P = programs.get(engine);
  if (!P) { P = { prep: engine.program(PREP), main: engine.program(MAIN), motion: engine.program(MOTION) }; programs.set(engine, P); }
  return P;
};

const S = (p) => p.ai || {};
export function studioActive(p) {
  const a = S(p);
  return (a.enhance?.amount > 0) || (a.skin?.amount > 0) || (a.sky && (a.sky.deepen || a.sky.warmth || a.sky.saturation))
    || (a.relight && (a.relight.near || a.relight.far || a.relight.warmth)) || (a.atmos?.amount > 0) || (a.rays?.amount > 0);
}
export const motionActive = (p) => S(p).motion?.amount > 0;

function maps() {
  return { uDepth: ai.tex.depth || ai.engine?.dummy, uSubj: ai.tex.subject || ai.engine?.dummy, uHasDepth: ai.tex.depth ? 1 : 0, uHasSubj: ai.tex.subject ? 1 : 0 };
}

export const studioPass = {
  key(p) { return studioActive(p) ? JSON.stringify([S(p).enhance, S(p).relight, S(p).sky, S(p).atmos, S(p).rays, S(p).skin, ai.version, !!ai.tex.depth, !!ai.tex.subject]) : ''; },
  run(engine, p, ctx, input) {
    if (!studioActive(p)) return input;
    const P = progs(engine), L = engine.L, a = S(p), m = maps();
    m.uDepth ||= engine.dummy; m.uSubj ||= engine.dummy;
    const u = { ...m, uIn: input.tex };
    // Smoothed copies at quarter resolution.
    if (a.skin?.amount > 0) {
      const t = engine.tgt('stSoft'), s = engine.tgt('stSoft2');
      engine.draw(P.prep, { ...u, uMode: 0 }, t);
      engine.blur(t, s, Math.max(1.5, 0.0035 * Math.max(L.qw, L.qh)));
      u.uSoft = t.tex;
    }
    if (a.enhance?.amount > 0 || a.atmos?.amount > 0) {
      const t = engine.tgt('stWide'), s = engine.tgt('stWide2');
      engine.draw(P.prep, { ...u, uMode: 0 }, t);
      engine.blur(t, s, Math.max(3, 0.02 * Math.max(L.qw, L.qh)));
      u.uSoftWide = t.tex;
    }
    if (a.rays?.amount > 0) {
      const t = engine.tgt('stLight'), s = engine.tgt('stLight2');
      engine.draw(P.prep, { ...u, uMode: 1, uSun: [a.rays.x ?? 0.72, a.rays.y ?? 0.18], uAspect: L.w / L.h }, t);
      engine.blur(t, s, 1.2);
      u.uLight = t.tex;
    }
    const r = a.relight || {}, sky = a.sky || {}, at = a.atmos || {}, ray = a.rays || {};
    Object.assign(u, {
      uEnhance: (a.enhance?.amount || 0) / 100,
      uRelight: [(r.near || 0) / 50, (r.far || 0) / 50, (r.boundary ?? 50) / 100, (r.warmth || 0) / 100],
      uSky: [(sky.deepen || 0) / 100, (sky.warmth || 0) / 100, (sky.saturation || 0) / 100],
      uAtmos: [(at.amount || 0) / 100, (at.warmth || 0) / 100, (at.lift ?? 30) / 100, 3.0 - 2.2 * (at.depth ?? 50) / 100],
      uRays: [(ray.amount || 0) / 100, ray.x ?? 0.72, ray.y ?? 0.18, 0.2 + (ray.length ?? 50) / 125],
      uRayWarm: (ray.warmth ?? 40) / 100,
      uSkin: (a.skin?.amount || 0) / 100,
    });
    if (!L.T.studioOut) L.T.studioOut = engine.target(L.w, L.h, { mip: input.mip });
    engine.draw(P.main, u, L.T.studioOut);
    return L.T.studioOut;
  },
};

export const motionPass = {
  key(p) { return motionActive(p) ? JSON.stringify([S(p).motion, ai.version, !!ai.tex.subject]) : ''; },
  run(engine, p, ctx, input) {
    if (!motionActive(p)) return input;
    const P = progs(engine), L = engine.L, m = S(p).motion, aspect = L.w / L.h;
    const len = (m.amount / 100) * 0.12, ang = (m.angle || 0) * Math.PI / 180;
    const mm = maps();
    if (!L.T.motionOut) L.T.motionOut = engine.target(L.w, L.h, { mip: input.mip });
    engine.draw(P.motion, { ...mm, uDepth: mm.uDepth || engine.dummy, uSubj: mm.uSubj || engine.dummy, uIn: input.tex,
      uDir: [Math.cos(ang) * len / aspect, -Math.sin(ang) * len], uProtect: m.protect === false ? 0 : 1 }, L.T.motionOut);
    return L.T.motionOut;
  },
};
