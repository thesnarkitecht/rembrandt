// Rembrandt Engine — WebGL2 runner.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Keeps GPU resources for one photo and runs PRE -> GUIDE -> MAIN -> (host passes) -> FINAL.
// Intermediate results are cached by the JSON of their inputs, so moving a FINAL-only slider
// (sharpen, vignette, grain, curves, crop) re-runs only the last pass.
//
// Host applications can insert their own scene-linear passes between MAIN and FINAL (for example
// local adjustments) by assigning `engine.hostPasses = { key(p, ctx), run(engine, p, ctx, input) }`;
// `run` returns the render target to feed into FINAL.
//
// Before PRE, the source can be corrected: lens corrections (setLensProfile + p.optics) and then
// `engine.sourcePasses = { key(p), run(engine, p, input) }` (e.g. spot removal), which returns the
// target to use as the source. Both run once per change and are cached.

import { VERT, DOWN, GAUSS, BOX, RESAMPLE, BLIT, LENS, GF_STATS, GF_COEF, HAZE_DARK, HAZE_T, PRE, MAIN, FINAL } from './shaders.js';
import { INPUT_UNIFORMS, preUniforms, mainUniforms, finalUniforms, curveIsIdentity, curveLUT, opticsLut } from './pipeline.js';

export const PREVIEW_LONG = 2560;
const FULL_CAP = 8192;

function canvasOf(w, h) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function resizeTo(bitmap, w, h) {
  if (bitmap.width === w && bitmap.height === h) return bitmap;
  // Step down in halves for better quality on big reductions.
  let src = bitmap, sw = bitmap.width, sh = bitmap.height;
  while (sw / 2 >= w * 1.2 && sh / 2 >= h * 1.2) {
    const nw = Math.round(sw / 2), nh = Math.round(sh / 2);
    const t = canvasOf(nw, nh);
    const tc = t.getContext('2d');
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(src, 0, 0, nw, nh);
    src = t; sw = nw; sh = nh;
  }
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

export class Engine {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser cannot render to floating-point textures (EXT_color_buffer_float).');
    this.gl = gl;
    this.canvas = canvas;
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    this.vao = gl.createVertexArray();
    this.P = {
      down: this.program(DOWN), gauss: this.program(GAUSS), box: this.program(BOX), resample: this.program(RESAMPLE), blit: this.program(BLIT), lens: this.program(LENS),
      gfStats: this.program(GF_STATS), gfCoef: this.program(GF_COEF), hazeDark: this.program(HAZE_DARK), hazeT: this.program(HAZE_T),
      pre: this.program(PRE), main: this.program(MAIN), final: this.program(FINAL),
    };
    // Guided-filter statistics need variance precision: 32-bit floats when the GPU can filter them.
    this.statFmt = gl.getExtension('OES_texture_float_linear') ? gl.RGBA32F : gl.RGBA16F;
    this.curve = this.texture(256, 1, gl.RGBA16F, false);
    this.curveKey = '';
    this.dummy = this.texture(1, 1, gl.RGBA8, false);
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.L = null;
    this.bitmap = null;
    this.stats = {};
    this.token = 0;
    this.small = null;
    this.hostPasses = null;
  }

  // ------------------------------------------------------------ GL plumbing

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    return { p, u };
  }

  texture(w, h, fmt, mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  target(w, h, { mip = false, fmt } = {}) {
    const gl = this.gl;
    const tex = this.texture(w, h, fmt || gl.RGBA16F, mip);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: ' + st);
    return { tex, fbo, w, h, mip };
  }

  free(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  draw(prog, uniforms, tgt, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fbo : null);
    gl.viewport(0, 0, tgt ? tgt.w : w, tgt ? tgt.h : h);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, val] of Object.entries(uniforms)) {
      const u = prog.u[name];
      if (!u) continue;
      switch (u.type) {
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, val);
          gl.uniform1i(u.loc, unit++);
          break;
        case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, val) : gl.uniform1f(u.loc, val); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, val); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, val); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, val); break;
        case gl.INT: case gl.BOOL: u.size > 1 ? gl.uniform1iv(u.loc, val) : gl.uniform1i(u.loc, +val); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, val); break;
      }
    }
    // Unset samplers must not alias a texture that is also the render target.
    for (const [name, u] of Object.entries(prog.u)) {
      if (u.type === gl.SAMPLER_2D && !(name in uniforms)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.dummy);
        gl.uniform1i(u.loc, unit++);
      }
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Gaussian blur of `a` in place (b is scratch of the same size), sigma in texels of `a`.
  blur(a, b, sigma) {
    const s = sigma / Math.SQRT2;
    for (let i = 0; i < 2; i++) {
      this.draw(this.P.gauss, { uIn: a.tex, uDir: [1 / a.w, 0], uSigma: s }, b);
      this.draw(this.P.gauss, { uIn: b.tex, uDir: [0, 1 / a.h], uSigma: s }, a);
    }
  }

  // Separable window filter from `src` into `dst` (tmp is scratch). mode 0 mean, 1 min, 2 max.
  boxFilter(src, tmp, dst, radius, mode) {
    this.draw(this.P.box, { uIn: src.tex, uDir: [1 / src.w, 0], uRadius: radius, uMode: mode }, tmp);
    this.draw(this.P.box, { uIn: tmp.tex, uDir: [0, 1 / src.h], uRadius: radius, uMode: mode }, dst);
  }

  // ------------------------------------------------------------ image / levels

  get fullW() { return this.source?.w || 1; }
  get fullH() { return this.source?.h || 1; }
  get srcGain() { return this.source?.gain || 1; }
  get linear() { return this.source?.kind === 'linear'; }
  get workH() { return this.L?.h || 1; }

  levelSize(kind) {
    const long = Math.max(this.fullW, this.fullH);
    const cap = kind === 'full' ? Math.min(this.maxTex, FULL_CAP) : Math.min(this.maxTex, this.previewLong || PREVIEW_LONG);
    const s = Math.min(1, cap / long);
    return { w: Math.max(1, Math.round(this.fullW * s)), h: Math.max(1, Math.round(this.fullH * s)) };
  }

  hasFullLevel() {
    const p = this.levelSize('preview'), f = this.levelSize('full');
    return f.h > p.h;
  }

  // source: {kind: 'display', bitmap} for 8-bit sRGB images, or
  //         {kind: 'linear', data: Uint16Array (RGBA half floats, linear sRGB), w, h, gain} for RAW.
  // stats:  {airlight: [r, g, b]} scene-linear Rec.2020 (see estimateAirlight), used for dehaze.
  async setImage(source, stats) {
    this.freeLevel();
    this.freeLinear();
    this.token++;
    if (source.kind === 'display') source = { ...source, w: source.bitmap.width, h: source.bitmap.height };
    this.source = source;
    this.bitmap = source.bitmap || null;
    this.stats = stats || {};
    if (source.kind === 'linear') {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, source.w, source.h);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, source.w, source.h, gl.RGBA, gl.HALF_FLOAT, source.data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      this.fullLinear = t;
    }
    await this.useLevel('preview');
  }

  async setPreviewLong(v) {
    this.previewLong = v;
    if (!this.L) return;
    const kind = this.L.kind;
    this.freeLevel();
    this.token++;
    await this.useLevel(kind);
  }

  freeLinear() {
    if (this.fullLinear) { this.gl.deleteTexture(this.fullLinear); this.fullLinear = null; }
  }

  freeLevel() {
    const L = this.L;
    if (!L) return;
    const gl = this.gl;
    if (L.ownSrc) gl.deleteTexture(L.src);
    for (const t of Object.values(L.T)) this.free(t);
    this.L = null;
  }

  async useLevel(kind) {
    if (!this.source) return;
    if (this.L && this.L.kind === kind) return;
    const { w, h } = this.levelSize(kind);
    if (this.L && this.L.w === w && this.L.h === h) { this.L.kind = kind; return; }
    if (this.pending === kind) return this.pendingPromise;
    const token = this.token;
    this.pending = kind;
    this.pendingPromise = (async () => {
      if (this.linear) { this.buildLevel(kind, null, w, h); return; }
      const img = resizeTo(this.bitmap, w, h);
      await null;
      if (token !== this.token) return;
      this.buildLevel(kind, img, w, h);
    })().finally(() => { if (this.pending === kind) this.pending = null; });
    return this.pendingPromise;
  }

  buildLevel(kind, img, w, h) {
    const gl = this.gl;
    this.freeLevel();
    let src, ownSrc = true;
    if (this.linear) {
      if (w === this.fullW && h === this.fullH) { src = this.fullLinear; ownSrc = false; }
      else {
        const r = this.target(w, h);
        this.draw(this.P.resample, { uIn: this.fullLinear, uInSize: [this.fullW, this.fullH], uOutSize: [w, h] }, r);
        src = r.tex;
        gl.deleteFramebuffer(r.fbo);
      }
    } else {
      src = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    const qlong = Math.max(qw, qh);
    this.L = {
      kind, w, h, qw, qh, src, ownSrc,
      T: {
        pre: this.target(w, h),
        main: this.target(w, h, { mip: kind === 'preview' }),
        q1: this.target(qw, qh), q2: this.target(qw, qh),
      },
      // Guided-filter window (Gaussian sigma, quarter-res texels): ~2.5 % of the long edge.
      guideSigma: Math.max(1, 0.025 * qlong),
      hazeRadius: Math.max(1, Math.min(24, Math.round(0.011 * qlong))),
      hazeSigma: Math.max(1, 0.03 * qlong),
      wscale: w / this.fullW,
      keys: {},
      out: null,
    };
  }

  // Lazily allocated per-level target.
  tgt(name, fmt, full = false) {
    const L = this.L;
    if (!L.T[name]) L.T[name] = this.target(full ? L.w : L.qw, full ? L.h : L.qh, { fmt });
    return L.T[name];
  }

  // ------------------------------------------------------------ passes

  inputUniforms() {
    return { ...INPUT_UNIFORMS, uSrc: this.baseSource(), uSrcLinear: this.linear ? 1 : 0, uSrcGain: this.srcGain };
  }

  // The source after lens corrections and source passes (or the plain source).
  baseSource() { return this.L.base || this.L.src; }

  // The camera's built-in lens correction for the current photo (see opticsLut), or null.
  setLensProfile(profile) {
    this.lensProfile = profile || null;
    if (this.L) this.L.baseKey = null;
  }

  // Lens corrections, then source passes, into L.base. Returns a key that changes with the result.
  baseStage(p) {
    const L = this.L, gl = this.gl;
    const lens = opticsLut(p.optics, this.lensProfile);
    const sk = this.sourcePasses ? this.sourcePasses.key(p) : '';
    const key = `${lens ? lens.key : '-'}|${sk}|${L.w}x${L.h}|${this.token}`;
    if (L.baseKey === key) return key;
    let cur = null;
    if (lens) {
      if (!this.lutTex) {
        this.lutTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 33, 1);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 33, 1, gl.RGBA, gl.FLOAT, lens.data);
      cur = this.tgt('lens', gl.RGBA16F, true);
      this.draw(this.P.lens, { uIn: L.src, uLut: this.lutTex, uSize: [L.w, L.h], uFill: lens.fill }, cur);
    }
    if (this.sourcePasses && sk) {
      // Source passes work on a float copy they may change in place.
      if (!cur) { cur = this.tgt('lens', gl.RGBA16F, true); this.draw(this.P.blit, { uIn: L.src, uSize: [L.w, L.h] }, cur); }
      cur = this.sourcePasses.run(this, p, cur) || cur;
    }
    L.base = cur ? cur.tex : null;
    L.baseKey = key;
    return key;
  }

  // Pixels of a float target, rows from y (texture rows = photo rows, top first), as RGBA floats.
  readRect(t, x, y, w, h) {
    const gl = this.gl;
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  writeRect(t, x, y, w, h, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.FLOAT, data);
  }

  // Guided filter on quarter-res statistics. `stats` holds (I, p, Ip, I²) and is consumed.
  // Returns a quarter-res target with the smoothed linear coefficients (a, b).
  guided(stats, scratch, out, sigma, eps) {
    this.blur(stats, scratch, sigma);
    this.draw(this.P.gfCoef, { uIn: stats.tex, uEps: eps }, out);
    this.blur(out, this.tgt('q3'), sigma);
    return out;
  }

  // Dark channel prior transmission, refined by a guided filter with the normalised luminance as guide.
  hazeMap(pu) {
    const L = this.L, P = this.P;
    const d = this.tgt('hd'), dm = this.tgt('hm'), tmp = this.tgt('q3');
    this.draw(P.hazeDark, { ...this.inputUniforms(), uA: pu.uA, uSrcTexel: [1 / L.w, 1 / L.h] }, d);
    this.boxFilter(d, tmp, dm, L.hazeRadius, 1);
    this.draw(P.hazeT, { uIn: dm.tex, uGuide: d.tex, uOmega: 1 }, tmp);
    const s1 = this.tgt('s1', this.statFmt), s2 = this.tgt('s2', this.statFmt);
    this.draw(P.gfStats, { uIn: tmp.tex, uMode: 1 }, s1);
    return this.guided(s1, s2, this.tgt('hab'), L.hazeSigma, 1e-3).tex;
  }

  // Edge-preserving base layer of log2 luminance: coefficients (a, b) so that base = a·log2(Y) + b.
  guideMap() {
    const L = this.L, P = this.P;
    this.draw(P.down, { uIn: L.T.pre.tex, uSrcTexel: [1 / L.w, 1 / L.h] }, L.T.q1);
    const s1 = this.tgt('s1', this.statFmt), s2 = this.tgt('s2', this.statFmt);
    this.draw(P.gfStats, { uIn: L.T.q1.tex, uMode: 0 }, s1);
    return this.guided(s1, s2, this.tgt('gab'), L.guideSigma, 0.25).tex;
  }

  updateCurve(curve) {
    const key = JSON.stringify(curve);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curve);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, curveLUT(curve));
  }

  process(p, overlayId) {
    const L = this.L, P = this.P, K = L.keys;

    // PRE: input -> scene-linear Rec.2020, dehaze, exposure
    const bk = this.baseStage(p);
    const pu = preUniforms(p, this.stats);
    const pk = JSON.stringify(pu) + bk;
    if (K.pre !== pk) {
      const hazeAB = pu.uMap ? this.hazeMap(pu) : this.dummy;
      this.draw(P.pre, { ...this.inputUniforms(), ...pu, uHazeAB: hazeAB }, L.T.pre);
      K.pre = pk;
      K.guide = null;
      K.main = null;
    }

    // GUIDE (only when a tone-zone slider or clarity is used)
    const mu = mainUniforms(p);
    if (mu.uGuideOn && K.guide !== pk) {
      L.guideTex = this.guideMap();
      K.guide = pk;
    }

    // MAIN
    const mk = pk + JSON.stringify(mu, (k, v) => (v instanceof Float32Array ? Array.from(v) : v));
    if (K.main !== mk) {
      this.draw(P.main, { ...mu, uPre: L.T.pre.tex, uGuideAB: mu.uGuideOn ? L.guideTex : this.dummy, uTexel: [1 / L.w, 1 / L.h] }, L.T.main);
      K.main = mk;
      K.host = null;
    }

    // Host passes (local adjustments etc.)
    const ctx = { overlayId, aspect: this.fullW / this.fullH };
    const hk = mk + '|' + (this.hostPasses ? this.hostPasses.key(p, ctx) : '');
    if (K.host !== hk) {
      let cur = L.T.main;
      if (this.hostPasses) cur = this.hostPasses.run(this, p, ctx, cur) || cur;
      if (cur.mip) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, cur.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      L.out = cur;
      K.host = hk;
    }
    this.updateCurve(p.curve);
    return L.out;
  }

  finalUniforms(p, out, v) {
    return {
      ...finalUniforms(p, this.fullW, this.fullH, this.L.h, this.linear),
      uIn: out.tex, uCurve: this.curve,
      uCurveOn: curveIsIdentity(p.curve) ? 0 : 1,
      uToImage: v.toImage, uToCrop: v.toCrop,
      uCropTest: v.cropTest ? 1 : 0,
      uClip: v.clip ? 1 : 0,
      uOverlay: v.overlayId ? 1 : 0,
      uBg: v.bg || [0.07, 0.075, 0.085],
      uInSize: [this.L.w, this.L.h],
      uLod: v.lod || 0,
    };
  }

  // Render the edited photo to the on-screen canvas. v: {toImage, toCrop, cropTest, scale, clip, overlayId, bg, scissor}
  render(p, v) {
    if (!this.L) return false;
    const gl = this.gl;
    const out = this.process(p, v.overlayId || null);
    const lod = out.mip ? Math.max(0, Math.log2(this.L.h / v.scale)) : 0;
    if (v.scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...v.scissor); }
    this.draw(this.P.final, this.finalUniforms(p, out, { ...v, lod }), null, this.canvas.width, this.canvas.height);
    if (v.scissor) gl.disable(gl.SCISSOR_TEST);
    return true;
  }

  // Renders the "before" version into a canvas-sized texture, cached until its inputs change.
  renderBefore(p, v) {
    if (!this.L) return;
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const key = JSON.stringify([p, Array.from(v.toImage), Array.from(v.toCrop), W, H, this.L.w, this.token]);
    if (this.beforeKey === key && this.before) return;
    if (!this.before || this.before.w !== W || this.before.h !== H) {
      this.free(this.before);
      this.before = this.target(W, H, { fmt: gl.RGBA8 });
    }
    const out = this.process(p, null);
    const lod = out.mip ? Math.max(0, Math.log2(this.L.h / v.scale)) : 0;
    this.draw(this.P.final, this.finalUniforms(p, out, { ...v, lod, clip: false, overlayId: null }), this.before);
    this.beforeKey = key;
  }

  blitBefore(scissor) {
    const gl = this.gl;
    if (!this.before) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...scissor);
    this.draw(this.P.blit, { uIn: this.before.tex, uSize: [this.canvas.width, this.canvas.height] }, null, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
  }

  // Render into an offscreen RGBA8 buffer and read it back. Rows come out top-first.
  readPixels(p, w, h, v) {
    const gl = this.gl;
    const out = this.process(p, null);
    const lod = out.mip ? Math.max(0, Math.log2(this.L.h / v.scale)) : 0;
    let t = this.small;
    const reuse = w * h <= 512 * 512;
    if (!reuse || !t || t.w !== w || t.h !== h) {
      if (reuse && t) this.free(t);
      t = this.target(w, h, { fmt: gl.RGBA8 });
      if (reuse) this.small = t;
    }
    this.draw(this.P.final, this.finalUniforms(p, out, { ...v, lod, clip: false, overlayId: null }), t);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!reuse) this.free(t);
    return px;
  }

  // Export render. `cropH` is the crop height in image-height units, `outH` the wanted pixel height.
  // Small outputs render from the mip-mapped preview level; larger ones from the full-resolution level
  // at native crop size (the caller downsizes if needed). Returns {pixels, w, h}.
  async exportPixels(p, cropW, cropH, outH, mats) {
    const prevKind = this.L?.kind || 'preview';
    const kind = outH <= this.levelSize('preview').h * cropH ? 'preview' : 'full';
    await this.useLevel(kind);
    let h = kind === 'preview' ? outH : Math.round(this.L.h * cropH);
    let w = Math.round((h * cropW) / cropH);
    const k = Math.min(1, this.maxTex / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    // Host passes that spread their work over frames (Refocus) finish it in one go for an export.
    this.exporting = true;
    let px;
    try { px = this.readPixels(p, w, h, { ...mats(w, h), scale: h / cropH, cropTest: true }); } finally { this.exporting = false; }
    if (prevKind !== kind) await this.useLevel(prevKind);
    return { pixels: px, w, h };
  }
}
