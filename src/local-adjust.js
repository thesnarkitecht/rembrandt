// Local adjustments (masks): brush, linear/radial gradients, color and luminance ranges, combined
// with add/subtract/intersect, each carrying its own exposure, tone, color and detail settings.
// Runs as host passes inside the engine, on scene-linear data between MAIN and FINAL.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { LIB } from '../engine/src/shaders.js';
import { whiteBalance, toGL, hueToOkDir, toneK, REF_CONTRAST } from '../engine/src/color.js';
import { maskHasEffect } from './params.js';
import { brushCanvas } from './brush.js';
import { ai, objectComps } from './ai/ai.js';

const MASK = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
` + LIB + `
uniform sampler2D uIn, uBlurM, uSrc, uBrush, uSubj, uDepth, uObj;
uniform float uAspect, uAmount, uSrcGain, uInC, uInK;
uniform int uSrcLinear;
uniform int uNComp, uShowOverlay;
uniform int uCType[6];
uniform int uCMode[6];
uniform int uCInv[6];
uniform vec4 uCP[6];
uniform vec4 uCQ[6];
uniform mat3 uMWB;
uniform vec4 uMTone;
uniform float uMContrast, uMClarity, uMSat, uMDehaze;
uniform vec3 uMTint;
in vec2 vUv; out vec4 o;

float toneGain(float ev, vec4 t) {
  float gB = 1.0 - smoothstep(-5.2, -2.4, ev);
  float gS = exp(-pow((ev + 1.9) / 1.5, 2.0));
  float gH = exp(-pow((ev - 1.7) / 1.3, 2.0));
  float gW = smoothstep(1.9, 3.9, ev);
  return t.x * 1.3 * gB + t.y * 1.6 * gS + t.z * 1.7 * gH + t.w * 1.3 * gW;
}

float compW(int i, vec2 H, vec3 lab) {
  int t = uCType[i];
  vec4 P = uCP[i];
  vec4 Q = uCQ[i];
  float w = 1.0;
  if (t == 1) {
    vec2 d = P.zw - P.xy;
    float tt = dot(H - P.xy, d) / max(dot(d, d), 1e-8);
    w = 1.0 - smoothstep(0.0, 1.0, tt);
  } else if (t == 2) {
    float c = cos(Q.x), s = sin(Q.x);
    vec2 v = H - P.xy;
    vec2 l = vec2(c * v.x + s * v.y, -s * v.x + c * v.y);
    float r = length(l / max(P.zw, vec2(1e-4)));
    float f = clamp(Q.y, 0.0, 1.0);
    w = 1.0 - smoothstep(1.0 - f - 1e-4, 1.0, r);
  } else if (t == 3) {
    w = textureLod(uBrush, vUv, 0.0).a;
  } else if (t == 4) {
    float f = max(P.z, 1e-3);
    w = smoothstep(P.x - f, P.x, lab.x) * (1.0 - smoothstep(P.y, P.y + f, lab.x));
  } else if (t == 5) {
    float d = length(lab.yz - P.xy) + 0.35 * abs(lab.x - Q.x);
    w = 1.0 - smoothstep(P.z, P.z + max(P.w, 1e-3), d);
  } else if (t == 6) {
    w = P.x > 0.5 ? textureLod(uSubj, vUv, 0.0).r : 0.0;
  } else if (t == 7) {
    float d = textureLod(uDepth, vUv, 0.0).r;
    float f = max(P.z, 1e-3);
    w = P.w > 0.5 ? smoothstep(P.x - f, P.x, d) * (1.0 - smoothstep(P.y, P.y + f, d)) : 0.0;
  } else if (t == 8) {
    int ch = int(P.x + 0.5);
    vec4 ob = textureLod(uObj, vUv, 0.0);
    w = P.y > 0.5 ? (ch == 0 ? ob.r : ch == 1 ? ob.g : ch == 2 ? ob.b : ob.a) : 0.0;
  }
  if (uCInv[i] == 1) w = 1.0 - w;
  return w;
}

void main() {
  vec4 inC = textureLod(uIn, vUv, 0.0);
  vec2 H = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  // Ranges are selected on the photo as it looks by default (display-referred), like the picker.
  vec3 sc = textureLod(uSrc, vUv, 0.0).rgb;
  if (uSrcLinear == 1) {
    vec3 r = FROM_SRGB * (sc * uSrcGain);
    sc = TO_SRGB * vec3(hill(r.r, uInC, uInK), hill(r.g, uInC, uInK), hill(r.b, uInC, uInK));
  }
  vec3 lab = oklab(FROM_SRGB * max(sc, 0.0));
  float w = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= uNComp) break;
    float c = compW(i, H, lab);
    int m = uCMode[i];
    if (i == 0 || m == 0) w = max(w, c);
    else if (m == 1) w *= (1.0 - c);
    else w *= c;
  }
  w = clamp(w * uAmount, 0.0, 1.0);

  vec3 rgb = inC.rgb;
  vec3 res = rgb;
  if (w > 0.0005) {
    vec3 a = uMWB * rgb;
    vec3 bl = uMWB * textureLod(uBlurM, vUv, 0.0).rgb;
    float Yb = max(lum(bl), 1e-6);
    if (uMDehaze > 0.0) {
      // Remove a veil proportional to the local dark level, then restore the local mean.
      float k = 0.85 * uMDehaze * min(bl.r, min(bl.g, bl.b));
      a = max(a - k, 0.0) * (Yb / max(Yb - k, 1e-6));
    } else if (uMDehaze < 0.0) {
      a = mix(a, vec3(Yb), -uMDehaze * 0.5);
    }
    float lg = log2(max(lum(a), 1e-6)), lb = log2(Yb);
    float diff = lg - lb;
    float guide = mix(lg, lb, exp(-diff * diff / 0.5) * 0.8);
    float ev = guide - log2(GREY);
    float gain = toneGain(ev, uMTone)
               + (lg - log2(GREY)) * uMContrast * 0.35
               + uMClarity * clamp(diff, -2.0, 2.0) * 0.75 * exp(-ev * ev / 18.0);
    a *= exp2(gain);
    if (uMSat != 0.0 || uMTint.z != 0.0 || uMDehaze > 0.0) {
      vec3 l = oklab(max(a, 0.0));
      l.yz *= max(1.0 + uMSat + 0.25 * max(uMDehaze, 0.0), 0.0);
      l.yz += uMTint.xy * uMTint.z * smoothstep(0.0, 0.1, l.x) * max(l.x, 0.25);
      a = unOklab(l);
    }
    res = mix(rgb, max(a, 0.0), w);
  }
  o = vec4(res, uShowOverlay == 1 ? w : inC.a);
}`;

const TYPE = { all: 0, linear: 1, radial: 2, brush: 3, luminance: 4, color: 5, subject: 6, depth: 7, object: 8 };
const MODE = { add: 0, subtract: 1, intersect: 2 };

function compPQ(c) {
  switch (c.type) {
    case 'linear': return [[c.x0, c.y0, c.x1, c.y1], [0, 0, 0, 0]];
    case 'radial': return [[c.cx, c.cy, c.rx, c.ry], [c.angle, c.feather / 100, 0, 0]];
    case 'luminance': return [[c.lo / 100, c.hi / 100, c.feather / 100, 0], [0, 0, 0, 0]];
    case 'color': return [[c.a, c.b, 0.01 + (c.tol / 100) * 0.16, 0.005 + (c.feather / 100) * 0.12], [c.L, 0, 0, 0]];
    case 'subject': return [[ai.tex.subject ? 1 : 0, 0, 0, 0], [0, 0, 0, 0]];
    case 'depth': return [[c.far / 100, c.near / 100, c.feather / 100, ai.tex.depth ? 1 : 0], [0, 0, 0, 0]];
    default: return [[0, 0, 0, 0], [0, 0, 0, 0]];
  }
}

export function maskUniforms(m, aspect) {
  const comps = m.comps.slice(0, 6);
  const type = new Int32Array(6), mode = new Int32Array(6), inv = new Int32Array(6);
  const P = new Float32Array(24), Q = new Float32Array(24);
  const objs = objectComps(m);
  const objTex = objs.length ? ai.objectTexture(m) : null;
  comps.forEach((c, i) => {
    // An un-picked color range selects nothing rather than every neutral.
    const unpicked = c.type === 'color' && !c.picked;
    type[i] = unpicked ? 5 : TYPE[c.type] ?? 0;
    mode[i] = i === 0 ? 0 : MODE[c.mode] ?? 0;
    inv[i] = c.invert ? 1 : 0;
    let [p, q] = unpicked ? [[9, 9, 0, 0.001], [0, 0, 0, 0]] : compPQ(c);
    if (c.type === 'object') p = [Math.max(0, objs.indexOf(c)), objTex && objs.includes(c) ? 1 : 0, 0, 0];
    P.set(p, i * 4);
    Q.set(q, i * 4);
  });
  const a = m.adj;
  const e = 2 ** a.exposure;
  const wb = whiteBalance(a.temp, a.tint).map((r) => r.map((v) => v * e));
  const [tx, ty] = hueToOkDir(a.hue);
  return {
    uAspect: aspect,
    uAmount: m.amount / 100,
    uNComp: comps.length,
    uCType: type, uCMode: mode, uCInv: inv, uCP: P, uCQ: Q,
    uMWB: toGL(wb),
    uMTone: [a.blacks / 100, a.shadows / 100, a.highlights / 100, a.whites / 100],
    uMContrast: a.contrast / 100,
    uMClarity: a.clarity / 100,
    uMSat: a.saturation / 100,
    uMDehaze: (a.dehaze || 0) / 100,
    uMTint: [tx, ty, (a.tintAmt / 100) * 0.06],
    uObjTex: objTex,
  };
}

export function activeMasks(p, overlayId) {
  return p.masks.filter((m) => m.visible !== false && m.comps.length && (maskHasEffect(m) || m.id === overlayId));
}

const brushTex = new Map();
function brushFor(engine, mask, aspect) {
  if (!mask.comps.some((c) => c.type === 'brush')) return engine.dummy;
  const e = brushCanvas(mask, aspect);
  const gl = engine.gl;
  let t = brushTex.get(mask.id);
  if (!t || t.gl !== gl) {
    t = { gl, tex: gl.createTexture(), key: null };
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    brushTex.set(mask.id, t);
  }
  if (t.key !== e.key) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, e.canvas);
    t.key = e.key;
  }
  return t.tex;
}

const programs = new WeakMap();

// Engine host-pass hook.
export const localAdjustments = {
  key(p, { overlayId, aspect }) {
    const masks = activeMasks(p, overlayId);
    if (!masks.length) return '';
    const bk = masks.map((m) => (m.comps.some((c) => c.type === 'brush') ? brushCanvas(m, aspect).key : ''));
    return overlayId + '|' + ai.version + '|' + JSON.stringify(masks.map((m, i) => [m.id, m.amount, m.comps, m.adj, bk[i]]));
  },
  run(engine, p, { overlayId, aspect }, input) {
    const masks = activeMasks(p, overlayId);
    if (!masks.length) return input;
    let prog = programs.get(engine);
    if (!prog) { prog = engine.program(MASK); programs.set(engine, prog); }
    const L = engine.L;
    const m1 = engine.tgt('lm1'), m2 = engine.tgt('lm2');
    engine.draw(engine.P.down, { uIn: input.tex, uSrcTexel: [1 / L.w, 1 / L.h] }, m1);
    engine.blur(m1, m2, Math.max(1, (Math.max(L.w, L.h) * 0.012) / 4));
    if (!L.T.la) L.T.la = engine.target(L.w, L.h, { mip: input.mip });
    if (masks.length > 1 && !L.T.lb) L.T.lb = engine.target(L.w, L.h, { mip: input.mip });
    let cur = input;
    masks.forEach((m, i) => {
      const tgt = i % 2 === 0 ? L.T.la : L.T.lb;
      const mu = maskUniforms(m, aspect);
      engine.draw(prog, {
        ...mu,
        uSubj: ai.tex.subject || engine.dummy, uDepth: ai.tex.depth || engine.dummy, uObj: mu.uObjTex || engine.dummy,
        uIn: cur.tex, uBlurM: m1.tex, uSrc: engine.baseSource(), uBrush: brushFor(engine, m, aspect),
        uShowOverlay: m.id === overlayId ? 1 : 0,
        uSrcLinear: engine.linear ? 1 : 0, uSrcGain: engine.srcGain,
        uInC: REF_CONTRAST, uInK: toneK(REF_CONTRAST),
      }, tgt);
      cur = tgt;
    });
    return cur;
  },
};
