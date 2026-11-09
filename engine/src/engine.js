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

const SOURCES = { down: DOWN, gauss: GAUSS, box: BOX, resample: RESAMPLE, blit: BLIT, lens: LENS, gfStats: GF_STATS, gfCoef: GF_COEF, hazeDark: HAZE_DARK, hazeT: HAZE_T, pre: PRE, main: MAIN, final: FINAL };
const UPLOAD_TEXELS = 4 << 20;   // per slice of a RAW upload (32 MB of half floats)

export class Engine {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    // Rendering to float textures: 32- and 16-bit (EXT_color_buffer_float), or on some older drivers
    // only 16-bit (EXT_color_buffer_half_float), which every working target already uses.
    this.fullFloat = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.fullFloat && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('This GPU/browser cannot render to floating-point textures.');
    this.gl = gl;
    this.canvas = canvas;
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    this.vao = gl.createVertexArray();
    // The built-in programs compile in the background (warm), or the first time one is used: compiling
    // all thirteen up front held the first paint back by the whole compile time.
    this.P = {};
    this.compiling = new Map();
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    for (const [name, src] of Object.entries(SOURCES)) {
      Object.defineProperty(this.P, name, { enumerable: true, configurable: true, get: () => {
        const prog = this.finish(this.compiling.get(name) || this.begin(src));
        this.compiling.delete(name);
        Object.defineProperty(this.P, name, { value: prog, enumerable: true });
        return prog;
      } });
    }
    // Guided-filter statistics need variance precision: 32-bit floats when the GPU can filter them.
    this.statFmt = this.fullFloat && gl.getExtension('OES_texture_float_linear') ? gl.RGBA32F : gl.RGBA16F;
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

  // Starts a program compiling without waiting for it: drivers that can (Chrome, Edge) compile it on
  // another thread until someone asks how it went.
  begin(fs) {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    this.vert ||= sh(gl.VERTEX_SHADER, VERT);
    const f = sh(gl.FRAGMENT_SHADER, fs), p = gl.createProgram();
    gl.attachShader(p, this.vert);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    return { p, f };
  }

  // Waits for a started program and reads its uniforms.
  finish({ p, f }) {
    const gl = this.gl;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error((!gl.getShaderParameter(f, gl.COMPILE_STATUS) && gl.getShaderInfoLog(f)) || (!gl.getShaderParameter(this.vert, gl.COMPILE_STATUS) && gl.getShaderInfoLog(this.vert)) || gl.getProgramInfoLog(p) || 'shader error');
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    return { p, u };
  }

  program(fs) { return this.finish(this.begin(fs)); }

  // Compiles every built-in program ahead of the first photo. Resolves when they are all ready, and
  // rejects if one doesn't compile on this GPU. Where the driver compiles in parallel nothing here
  // blocks; elsewhere it takes as long as compiling them always did, just not before the first paint.
  async warm() {
    const names = Object.keys(SOURCES).filter((n) => !Object.getOwnPropertyDescriptor(this.P, n).value);
    for (const n of names) if (!this.compiling.has(n)) this.compiling.set(n, this.begin(SOURCES[n]));
    if (this.parallel) {
      const gl = this.gl, done = (n) => !this.compiling.has(n) || gl.getProgramParameter(this.compiling.get(n).p, this.parallel.COMPLETION_STATUS_KHR);
      for (let i = 0; i < 400 && !names.every(done) && !gl.isContextLost(); i++) await new Promise((r) => setTimeout(r, 25));
    }
    for (const n of names) void this.P[n];
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
        case gl.SAMPLER_3D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_3D, val || this.dummy3d());
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
      } else if (u.type === gl.SAMPLER_3D && !(name in uniforms)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_3D, this.dummy3d());
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

  // How fast this GPU runs the heaviest everyday pass (MAIN with tone zones, mixer and grading on), in
  // milliseconds per megapixel, timed with a round trip to the GPU. The editor picks its working size
  // from it, so a 2010 graphics card gets a size it can keep up with.
  benchmark() {
    const gl = this.gl, w = 1024, h = 768, t = this.target(w, h), px = new Float32Array(4);
    const z = new Float32Array(8).fill(0.2);
    const u = {
      uPre: this.dummy, uGuideAB: this.dummy, uTexel: [1 / w, 1 / h], uGuideOn: 1, uTone: [0.2, 0.3, -0.3, 0.1], uClarity: 0.2,
      uWBOn: 1, uWB: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), uVib: 0.2, uSat: 0.1, uMixOn: 1, uMixHue: z, uMixSat: z, uMixLum: z, uGradeOn: 1,
      uZoneW: new Float32Array(16).fill(0.5), uZoneWn: new Float32Array(16).fill(0.5), uZoneA: new Float32Array(8).fill(1),
    };
    // A float target is read back as floats (an 8-bit read is an error and wouldn't wait for the GPU).
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); };
    this.draw(this.P.main, u, t); sync();   // compile and warm up
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) this.draw(this.P.main, u, t);
    sync();
    const ms = (performance.now() - t0) / 3;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.free(t);
    return ms / ((w * h) / 1e6);
  }

  // The main colour stage with settings `p` at w × h, timed as the GPU benchmark's native version
  // (src-tauri/src/gpubench.rs) is: the same noise input, `frames` draws, then a wait for the GPU.
  // Milliseconds per frame.
  benchmarkMain(p, w, h, frames = 10) {
    const gl = this.gl, px = new Float32Array(4);
    const noise = (seed) => {
      let s = Math.max(1, Math.imul(seed, 2654435761) >>> 0);
      const a = new Float32Array(w * h * 4);
      for (let i = 0; i < a.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; a[i] = (s % 1600) / 1000; }
      const t = this.texture(w, h, gl.RGBA16F, false);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, a);
      return t;
    };
    const pre = noise(1), guide = noise(2), t = this.target(w, h);
    const u = { ...mainUniforms(p), uGuideOn: 1, uPre: pre, uGuideAB: guide, uTexel: [1 / w, 1 / h] };
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); };
    try {
      this.draw(this.P.main, u, t); sync();   // compile and warm up
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) this.draw(this.P.main, u, t);
      sync();
      return (performance.now() - t0) / frames;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.free(t); gl.deleteTexture(pre); gl.deleteTexture(guide);
    }
  }

  levelSize(kind) {
    const long = Math.max(this.fullW, this.fullH);
    const prev = Math.min(this.maxTex, this.previewLong || PREVIEW_LONG);
    const cap = kind === 'full' ? Math.min(this.maxTex, FULL_CAP) : kind === 'drag' ? Math.round(prev / 2) : prev;
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
    const seq = (this.imageSeq = (this.imageSeq || 0) + 1);
    // Upload first, then swap, so the photo on screen stays usable while a large one arrives.
    const tex = source.kind === 'linear' ? await this.uploadLinear(source, seq) : null;
    if (seq !== this.imageSeq) { if (tex) this.gl.deleteTexture(tex); return; }
    this.freeLevels();
    this.freeLinear();
    this.token++;
    if (source.kind === 'display') source = { ...source, w: source.bitmap.width, h: source.bitmap.height };
    this.source = source;
    this.bitmap = source.bitmap || null;
    this.stats = stats || {};
    if (tex) this.fullLinear = tex;
    await this.useLevel('preview');
  }

  // RAW data to a half-float texture, in slices of rows with a frame between them: a full-size 24 MP
  // upload in one call holds the editor still for a second or more. Null if another image replaced it.
  async uploadLinear(source, seq) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, source.w, source.h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const rows = Math.max(1, Math.floor(UPLOAD_TEXELS / source.w));
    for (let y = 0; y < source.h; y += rows) {
      const n = Math.min(rows, source.h - y);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, source.w, n, gl.RGBA, gl.HALF_FLOAT, source.data.subarray(y * source.w * 4, (y + n) * source.w * 4));
      if (y + n < source.h) {
        await new Promise((r) => setTimeout(r, 0));
        if (seq !== this.imageSeq) { gl.deleteTexture(t); return null; }
      }
    }
    return t;
  }

  async setPreviewLong(v) {
    this.previewLong = v;
    if (!this.L) return;
    const kind = this.L.kind === 'drag' ? 'preview' : this.L.kind;
    this.freeLevels();
    this.token++;
    await this.useLevel(kind);
  }

  freeLinear() {
    if (this.fullLinear) { this.gl.deleteTexture(this.fullLinear); this.fullLinear = null; }
  }

  freeLevel(L = this.L) {
    if (!L) return;
    const gl = this.gl;
    if (L.ownSrc) gl.deleteTexture(L.src);
    for (const t of Object.values(L.T)) this.free(t);
    if (L === this.L) this.L = null;
    if (L === this.spare) this.spare = null;
  }
  freeLevels() { if (this.spare) this.freeLevel(this.spare); this.freeLevel(); }

  // Levels: 'preview' (what the editor shows, previewLong), 'full' (zoomed in, exports) and 'drag', half
  // the preview's size, used while a slider moves so every frame costs a quarter; on release the
  // preview catches up. Preview and drag are kept side by side, so swapping between them is free.
  async useLevel(kind) {
    if (!this.source) return;
    if (this.L && this.L.kind === kind) return;
    if (this.spare?.kind === kind) { [this.L, this.spare] = [this.spare, this.L]; return; }
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
    const pair = (a, b) => (a === 'drag' && b === 'preview') || (a === 'preview' && b === 'drag');
    if (this.L && pair(this.L.kind, kind)) { if (this.spare) this.freeLevel(this.spare); this.spare = this.L; this.L = null; } else this.freeLevels();
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
        main: this.target(w, h, { mip: kind !== 'full' }),
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
    const lens = opticsLut(p.optics, this.lensProfile, L.w / L.h);
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
      this.draw(this.P.lens, { uIn: L.src, uLut: this.lutTex, uSize: [L.w, L.h], uFill: lens.fill, uPersp: lens.persp }, cur);
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

  // 3D colour lookup tables (looks and .cube files): `data` is size³ RGB (red fastest), 0–1.
  setLut(key, size, data) {
    const gl = this.gl;
    this.luts ||= new Map();
    if (this.luts.has(key)) return;
    const rgba = new Float32Array(size * size * size * 4);
    for (let i = 0; i < size * size * size; i++) { rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    this.luts.set(key, { tex: t, size });
  }
  hasLut(key) { return !!this.luts?.has(key); }
  dummy3d() {
    if (this._dummy3d) return this._dummy3d;
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return (this._dummy3d = t);
  }

  finalUniforms(p, out, v) {
    const lut = p.look?.lut && p.look.amount ? this.luts?.get(p.look.lut) : null;
    return {
      uLutOn: lut ? 1 : 0, uLut: lut?.tex || null, uLutN: lut?.size || 2, uLutAmt: (p.look?.amount ?? 0) / 100,
      ...finalUniforms(p, this.fullW, this.fullH, this.L.h, this.linear),
      uIn: out.tex, uCurve: this.curve,
      uCurveOn: curveIsIdentity(p.curve) ? 0 : 1,
      uToImage: v.toImage, uToCrop: v.toCrop,
      uCropTest: v.cropTest ? 1 : 0,
      uClip: v.clip ? 1 : 0,
      uSpots: v.spots || 0,
      uDither: v.float ? 0 : 1,
      uFast: v.fast ? 1 : 0,
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
    // Draft (while a slider moves on a computer that can't keep up at full resolution): the final pass,
    // the most expensive per pixel, renders at `draft` × the canvas size and is stretched onto it.
    const f = v.draft && !v.scissor ? v.draft : 1;
    if (f < 1) {
      const W = this.canvas.width, H = this.canvas.height;
      const tw = Math.max(1, Math.round(W * f)), th = Math.max(1, Math.round(H * f));
      if (!this.draftT || this.draftT.w !== tw || this.draftT.h !== th) {
        this.free(this.draftT);
        this.draftT = this.target(tw, th, { fmt: gl.RGBA8 });
      }
      // The small target's pixel (x, y) is the canvas pixel (x W/tw, y H/th): scale the first two
      // columns of the screen → image and screen → crop matrices (column-major).
      const sx = W / tw, sy = H / th;
      const scale = (m) => { const r = Float32Array.from(m); r[0] *= sx; r[1] *= sx; r[2] *= sx; r[3] *= sy; r[4] *= sy; r[5] *= sy; return r; };
      const vd = { ...v, toImage: scale(v.toImage), toCrop: scale(v.toCrop), lod: lod + Math.log2(1 / f) };
      this.draw(this.P.final, this.finalUniforms(p, out, vd), this.draftT);
      this.draw(this.P.blit, { uIn: this.draftT.tex, uSize: [W, H] }, null, W, H);
      return true;
    }
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

  // The colour Point Color compares with at (u, v) of the photo (0–1, top-left origin): Oklab
  // [L, a, b], averaged over a few pixels around it.
  probeColor(p, u, v) {
    const gl = this.gl, L = this.L;
    this.process(p, null);
    const mu = mainUniforms(p);
    const t = this.target(1, 1, { fmt: this.fullFloat ? gl.RGBA32F : gl.RGBA16F });
    const px = new Float32Array(4), sum = [0, 0, 0];
    const d = [1.5 / L.w, 1.5 / L.h];
    try {
      for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const uv = [Math.min(1, Math.max(0, u + dx * d[0])), Math.min(1, Math.max(0, v + dy * d[1]))];
        this.draw(this.P.main, { ...mu, uPre: L.T.pre.tex, uGuideAB: mu.uGuideOn ? L.guideTex : this.dummy, uTexel: [1 / L.w, 1 / L.h], uProbe: 1, uProbeUv: uv }, t);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        for (let i = 0; i < 3; i++) sum[i] += px[i] / 5;
      }
    } finally { this.free(t); }
    return sum;
  }

  // Render into an offscreen RGBA8 buffer and read it back. Rows come out top-first.
  readPixels(p, w, h, v) {
    const gl = this.gl;
    const out = this.process(p, null);
    const lod = out.mip ? Math.max(0, Math.log2(this.L.h / v.scale)) : 0;
    if (v.float) {
      // 16-bit exports: the final pass into a float target, read back as floats (0–1, display-encoded).
      const t = this.target(w, h, { fmt: this.fullFloat ? gl.RGBA32F : gl.RGBA16F });
      try {
        this.draw(this.P.final, this.finalUniforms(p, out, { ...v, lod, clip: false, overlayId: null }), t);
        const px = new Float32Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return px;
      } finally { this.free(t); }
    }
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

  // readPixels (8-bit) without making the CPU wait for the GPU: the pixels come back through a pixel
  // buffer and a fence, polled once a frame, so slider frames keep flowing while the histogram updates.
  // One at a time; resolves null if another started meanwhile or the browser lacks fences.
  readPixelsAsync(p, w, h, v, slot = 'histo') {
    const gl = this.gl;
    if (!gl.fenceSync) return Promise.resolve(this.readPixels(p, w, h, v));
    const out = this.process(p, null);
    const lod = out.mip ? Math.max(0, Math.log2(this.L.h / v.scale)) : 0;
    // Each slot (the histogram, the thumbnail) has its own target, pixel buffer and turn, so one
    // kind of read never cancels another.
    const S = ((this.readSlots ||= new Map()).get(slot)) || this.readSlots.set(slot, { t: null, pbo: null, size: 0, ticket: 0 }).get(slot);
    if (!S.t || S.t.w !== w || S.t.h !== h) {
      if (S.t) this.free(S.t);
      S.t = this.target(w, h, { fmt: gl.RGBA8 });
    }
    this.draw(this.P.final, this.finalUniforms(p, out, { ...v, lod, clip: false, overlayId: null }), S.t);
    const bytes = w * h * 4;
    if (!S.pbo || S.size < bytes) {
      if (S.pbo) gl.deleteBuffer(S.pbo);
      S.pbo = gl.createBuffer();
      S.size = bytes;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, S.t.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const ticket = ++S.ticket, pbo = S.pbo;
    return new Promise((resolve) => {
      const poll = () => {
        if (ticket !== S.ticket || pbo !== S.pbo) { gl.deleteSync(sync); resolve(null); return; }
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 4); return; }
        gl.deleteSync(sync);
        if (st === gl.WAIT_FAILED) { resolve(null); return; }
        const px = new Uint8Array(bytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        resolve(px);
      };
      setTimeout(poll, 4);
    });
  }

  // Export render. `cropH` is the crop height in image-height units, `outH` the wanted pixel height.
  // Small outputs render from the mip-mapped preview level; larger ones from the full-resolution level
  // at native crop size (the caller downsizes if needed). Returns {pixels, w, h}.
  async exportPixels(p, cropW, cropH, outH, mats, { float = false } = {}) {
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
    try { px = this.readPixels(p, w, h, { ...mats(w, h), scale: h / cropH, cropTest: true, float }); } finally { this.exporting = false; }
    if (prevKind !== kind) await this.useLevel(prevKind);
    return { pixels: px, w, h };
  }
}
