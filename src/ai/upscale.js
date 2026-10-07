// Super Resolution: enlarges a photo 2× or 4×, or restores it at its own size (1×: sharper, cleaner
// detail on soft or slightly out-of-focus shots), on this device.
//
// The network is Real-ESRGAN's compact general model (SRVGGNetCompact, realesr-general-x4v3 and its
// weak-denoise twin; BSD-3-Clause, see models/README.md): 34 3×3 convolutions with PReLU, a 4× pixel
// shuffle and the nearest-upscaled input added back. The two weight sets are blended by the noise
// slider, as Real-ESRGAN does.
//
// It runs as our own GPU kernels, no ML runtime:
//   • WebGPU compute (Metal on Apple silicon, D3D12/Vulkan elsewhere). Activations are stored in
//     half precision when the GPU supports it (all Apple GPUs do), which halves memory traffic on
//     unified memory; arithmetic stays in 32-bit. Each workgroup computes a 64×8 tile for 16 output
//     channels (4 pixels per thread), with the input tile and the weights staged in threadgroup memory.
//   • WebGL2 fragment shaders where WebGPU is missing (Linux, older macOS): half-float texture
//     arrays, four output channel groups per pass.
// The image is processed in overlapping tiles so memory stays bounded at any size.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

import { breathe, chunker, pacer, glFinished } from '../jobs.js';

const LAYERS = Array.from({ length: 34 }, (_, l) => ({ oc: l === 33 ? 48 : 64, ic: l === 0 ? 3 : 64, prelu: l < 33 }));
const PAD = 24;          // tile overlap, in input pixels
const MAX_OUT = 16384;   // longest output edge

// ------------------------------------------------------------------ weights

let rawWeights = null;
async function loadRaw() {
  if (rawWeights) return rawWeights;
  const url = new URL('../../models/sr-general-x4.bin', import.meta.url);
  let buf;
  const r = await fetch(url);
  if (r.ok) buf = await r.arrayBuffer();
  else {
    // Hosts that cannot serve binaries may provide a base64 text copy.
    const t = await fetch(url.href + '.b64.txt');
    if (!t.ok) throw new Error('The Super Resolution model is not available');
    const bin = atob((await t.text()).trim());
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    buf = u.buffer;
  }
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'RSR1') throw new Error('The Super Resolution model file is damaged');
  return (rawWeights = new Uint16Array(buf, 4));
}

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// Per layer: weights [oc][ic][3][3], bias [oc], PReLU slopes [oc], blended between the two nets.
// `denoise` 1 = the general model (strongest noise removal), 0 = the weak-denoise model.
function blendedLayers(raw, denoise) {
  const per = raw.length / 2;
  const s = Math.min(1, Math.max(0, denoise));
  let o = 0;
  const take = (n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = s * halfToFloat(raw[o + i]) + (1 - s) * halfToFloat(raw[per + o + i]);
    o += n;
    return out;
  };
  return LAYERS.map(({ oc, ic, prelu }) => ({ oc, ic, prelu, w: take(oc * ic * 9), b: take(oc), a: prelu ? take(oc) : null }));
}

// Weights as 4×4 blocks: for output group og, input group ig and tap t, a column-major mat4 whose
// column c holds the weights from input channel ig*4+c to output channels og*4..og*4+3.
function packMats(L) {
  const OG = L.oc / 4, IG = Math.ceil(L.ic / 4);
  const m = new Float32Array(OG * IG * 9 * 16);
  for (let og = 0; og < OG; og++) for (let ig = 0; ig < IG; ig++) for (let t = 0; t < 9; t++) {
    const base = ((og * IG + ig) * 9 + t) * 16;
    for (let c = 0; c < 4; c++) {
      const ic = ig * 4 + c;
      if (ic >= L.ic) continue;
      for (let r = 0; r < 4; r++) m[base + c * 4 + r] = L.w[((og * 4 + r) * L.ic + ic) * 9 + t];
    }
  }
  return m;
}

// ------------------------------------------------------------------ WebGPU

let gpuPromise = null;
async function webgpu() {
  if (!navigator.gpu) return null;
  return (gpuPromise ||= (async () => {
    // Apple silicon reports one adapter; ask for the fast one where there's a choice.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const f16 = adapter.features.has('shader-f16');
    const device = await adapter.requestDevice({
      requiredFeatures: f16 ? ['shader-f16'] : [],
      requiredLimits: { maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30) },
    });
    device.lost.then(() => { gpuPromise = null; });
    const info = adapter.info || (await adapter.requestAdapterInfo?.().catch(() => null)) || null;
    return { device, f16, info, pipes: new Map() };
  })().catch(() => null));
}

// Workgroup: 16×8 threads, each computing PX pixels (strided by 16 along x) × 16 output channels, so
// every weight block read from threadgroup memory feeds PX pixels instead of one.
const TW = 16, TH = 8, PX = 4, TX = TW * PX;
function convWGSL(f16, IG, CH, srcF32, prelu, OGT) {
  const S = f16 ? 'f16' : 'f32';
  const src = srcF32 ? 'f32' : S;
  const RW = TX + 2, T = RW * (TH + 2);
  const O = [0, 1, 2, 3], K = [...Array(PX).keys()];
  const decl = O.flatMap((o) => K.map((k) => `var a${o}${k} = vec4f(0.0);`)).join(' ');
  const body = K.map((k) => `        let v${k} = tile[b + ${k * TW}u];\n`).join('')
    + O.map((o) => `        let m${o} = wsh[(${o}u * ${CH}u + g) * 9u + t];\n` + K.map((k) => `        a${o}${k} += m${o} * v${k};\n`).join('')).join('');
  let store = '';
  for (const k of K) {
    store += `  { let gx = wg.x * ${TX}u + lid.x + ${k * TW}u;\n    if (gx < p.w) {\n`;
    for (const o of O) {
      store += `      { var r = a${o}${k} + bias[og0 + ${o}u];\n`;
      if (prelu) store += `        let s = bias[${OGT}u + og0 + ${o}u]; r = select(s * r, r, r >= vec4f(0.0));\n`;
      store += `        dst[((og0 + ${o}u) * p.h + gy) * p.w + gx] = vec4<${S}>(r); }\n`;
    }
    store += '    } }\n';
  }
  return `${f16 ? 'enable f16;\n' : ''}
struct P { w: u32, h: u32 }
@group(0) @binding(0) var<storage, read> src: array<vec4<${src}>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<${S}>>;
@group(0) @binding(2) var<storage, read> wts: array<mat4x4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> tile: array<vec4f, ${CH * T}>;
var<workgroup> wsh: array<mat4x4f, ${4 * CH * 9}>;
@compute @workgroup_size(${TW}, ${TH}, 1)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let x0 = i32(wg.x * ${TX}u) - 1;
  let y0 = i32(wg.y * ${TH}u) - 1;
  let gy = wg.y * ${TH}u + lid.y;
  let og0 = wg.z * 4u;
  ${decl}
  for (var c0 = 0u; c0 < ${IG}u; c0 += ${CH}u) {
    for (var i = li; i < ${CH * T}u; i += ${TW * TH}u) {
      let g = i / ${T}u; let r = i % ${T}u;
      let sx = x0 + i32(r % ${RW}u); let sy = y0 + i32(r / ${RW}u);
      var v = vec4f(0.0);
      if (sx >= 0 && sy >= 0 && sx < i32(p.w) && sy < i32(p.h)) { v = vec4f(src[((c0 + g) * p.h + u32(sy)) * p.w + u32(sx)]); }
      tile[i] = v;
    }
    for (var i = li; i < ${4 * CH * 9}u; i += ${TW * TH}u) {
      let o = i / ${CH * 9}u; let r = i % ${CH * 9}u;
      wsh[i] = wts[((og0 + o) * ${IG}u + c0 + r / 9u) * 9u + r % 9u];
    }
    workgroupBarrier();
    for (var g = 0u; g < ${CH}u; g++) {
      for (var t = 0u; t < 9u; t++) {
        let b = g * ${T}u + (lid.y + t / 3u) * ${RW}u + lid.x + t % 3u;
${body}      }
    }
    workgroupBarrier();
  }
  if (gy >= p.h) { return; }
${store}}`;
}

// Pixel shuffle, input added back, and box-downscaled to the requested scale; packed RGBA8.
function shuffleWGSL(f16) {
  const S = f16 ? 'f16' : 'f32';
  return `${f16 ? 'enable f16;\n' : ''}
struct Q { w: u32, h: u32, vx: u32, vy: u32, ow: u32, oh: u32, f: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> net: array<vec4<${S}>>;
@group(0) @binding(1) var<storage, read> inp: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;
@group(0) @binding(3) var<uniform> q: Q;
fn ch(k: u32, x: u32, y: u32) -> f32 { return f32(net[((k / 4u) * q.h + y) * q.w + x][k % 4u]); }
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= q.ow || id.y >= q.oh) { return; }
  var c = vec3f(0.0);
  for (var j = 0u; j < q.f; j++) {
    for (var i = 0u; i < q.f; i++) {
      let X = (q.vx * 4u) + id.x * q.f + i;
      let Y = (q.vy * 4u) + id.y * q.f + j;
      let x = X / 4u; let y = Y / 4u; let sub = (Y % 4u) * 4u + (X % 4u);
      let base = inp[y * q.w + x].rgb;
      c += clamp(vec3f(ch(sub, x, y), ch(16u + sub, x, y), ch(32u + sub, x, y)) + base, vec3f(0.0), vec3f(1.0));
    }
  }
  c /= f32(q.f * q.f);
  outp[id.y * q.ow + id.x] = pack4x8unorm(vec4f(c, 1.0));
}`;
}

class GPURunner {
  constructor(g, layers) {
    this.g = g;
    const { device } = g;
    this.layers = layers.map((L, l) => {
      const IG = Math.ceil(L.ic / 4), OGT = L.oc / 4, CH = 1;
      const key = `${IG}:${CH}:${l === 0}:${L.prelu}:${OGT}`;
      let pipe = g.pipes.get(key);
      if (!pipe) {
        pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: convWGSL(g.f16, IG, CH, l === 0, L.prelu, OGT) }), entryPoint: 'main' } });
        g.pipes.set(key, pipe);
      }
      const mats = packMats(L);
      const wb = device.createBuffer({ size: mats.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(wb, 0, mats);
      const ba = new Float32Array(L.oc * 2);
      ba.set(L.b, 0); if (L.a) ba.set(L.a, L.oc);
      const bb = device.createBuffer({ size: ba.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(bb, 0, ba);
      return { pipe, wb, bb, OGT };
    });
    if (!g.pipes.has('shuffle')) g.pipes.set('shuffle', device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: shuffleWGSL(g.f16) }), entryPoint: 'main' } }));
    this.shuffle = g.pipes.get('shuffle');
    this.cap = 0;
  }
  ensure(w, h) {
    if (this.cap >= w * h) return;
    for (const b of [this.A, this.B, this.I]) b?.destroy();
    const n = w * h, el = this.g.f16 ? 8 : 16;
    const { device } = this.g;
    this.A = device.createBuffer({ size: n * 16 * el, usage: GPUBufferUsage.STORAGE });
    this.B = device.createBuffer({ size: n * 16 * el, usage: GPUBufferUsage.STORAGE });
    this.I = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.cap = n;
  }
  // `rgb`: Float32Array of vec4 for a w×h tile. Returns RGBA8 pixels of the valid region at `scale`.
  async run(rgb, w, h, vx, vy, vw, vh, scale, job) {
    const { device } = this.g;
    const step = job ? pacer(job, () => device.queue.onSubmittedWorkDone()) : null;
    this.ensure(w, h);
    device.queue.writeBuffer(this.I, 0, rgb);
    const f = 4 / scale, ow = vw * scale, oh = vh * scale;
    const out = device.createBuffer({ size: ow * oh * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: ow * oh * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const dims = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(dims, 0, new Uint32Array([w, h, 0, 0]));
    let enc = device.createCommandEncoder();
    let src = this.I, dst = this.A;
    for (const L of this.layers) {
      // Queued work goes a layer at a time, so the editor's frames get the GPU in between.
      if (step && L !== this.layers[0]) { device.queue.submit([enc.finish()]); await step(); enc = device.createCommandEncoder(); }
      const pass = enc.beginComputePass();
      pass.setPipeline(L.pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: L.pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } },
        { binding: 2, resource: { buffer: L.wb } }, { binding: 3, resource: { buffer: L.bb } }, { binding: 4, resource: { buffer: dims } }] }));
      pass.dispatchWorkgroups(Math.ceil(w / TX), Math.ceil(h / TH), L.OGT / 4);
      pass.end();
      src = dst; dst = dst === this.A ? this.B : this.A;
    }
    const qb = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(qb, 0, new Uint32Array([w, h, vx, vy, ow, oh, f, 0]));
    const pass = enc.beginComputePass();
    pass.setPipeline(this.shuffle);
    pass.setBindGroup(0, device.createBindGroup({ layout: this.shuffle.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: this.I } },
      { binding: 2, resource: { buffer: out } }, { binding: 3, resource: { buffer: qb } }] }));
    pass.dispatchWorkgroups(Math.ceil(ow / 16), Math.ceil(oh / 16));
    pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, ow * oh * 4);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const px = new Uint8ClampedArray(read.getMappedRange().slice(0));
    read.unmap();
    for (const b of [out, read, dims, qb]) b.destroy();
    return px;
  }
  destroy() {
    for (const L of this.layers) { L.wb.destroy(); L.bb.destroy(); }
    for (const b of [this.A, this.B, this.I]) b?.destroy();
  }
}

// ------------------------------------------------------------------ WebGL2 fallback

const VS = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;

function convGLSL(IG, prelu) {
  return `#version 300 es
precision highp float; precision highp int;
precision highp sampler2DArray; precision highp sampler2D;
uniform sampler2DArray uSrc;
uniform sampler2D uW;       // 4 texels per mat4, one row per (og, ig, tap)
uniform vec4 uBias[4], uSlope[4];
uniform int uOg0;
uniform ivec2 uSize;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2; layout(location = 3) out vec4 o3;
mat4 W(int og, int ig, int t) {
  int row = ((og * ${IG}) + ig) * 9 + t;
  return mat4(texelFetch(uW, ivec2(0, row), 0), texelFetch(uW, ivec2(1, row), 0), texelFetch(uW, ivec2(2, row), 0), texelFetch(uW, ivec2(3, row), 0));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a[4] = vec4[4](uBias[0], uBias[1], uBias[2], uBias[3]);
  for (int ig = 0; ig < ${IG}; ig++) {
    for (int t = 0; t < 9; t++) {
      ivec2 q = p + ivec2(t % 3 - 1, t / 3 - 1);
      if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
      vec4 v = texelFetch(uSrc, ivec3(q, ig), 0);
      for (int o = 0; o < 4; o++) a[o] += W(uOg0 + o, ig, t) * v;
    }
  }
  ${prelu ? 'for (int o = 0; o < 4; o++) a[o] = mix(uSlope[o] * a[o], a[o], step(0.0, a[o]));' : ''}
  o0 = a[0]; o1 = a[1]; o2 = a[2]; o3 = a[3];
}`;
}

const SHUFFLE_GL = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray;
uniform sampler2DArray uNet, uIn;
uniform ivec2 uV; uniform int uF;
out vec4 o;
float ch(int k, ivec2 p) { return texelFetch(uNet, ivec3(p, k / 4), 0)[k % 4]; }
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    if (i >= uF || j >= uF) continue;
    ivec2 X = uV * 4 + id * uF + ivec2(i, j);
    ivec2 p = X / 4; int sub = (X.y % 4) * 4 + (X.x % 4);
    c += clamp(vec3(ch(sub, p), ch(16 + sub, p), ch(32 + sub, p)) + texelFetch(uIn, ivec3(p, 0), 0).rgb, 0.0, 1.0);
  }
  o = vec4(c / float(uF * uF), 1.0);
}`;

class GLRunner {
  constructor(layers) {
    const c = new OffscreenCanvas(1, 1);
    const gl = c.getContext('webgl2', { antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('This device has no GPU support for Super Resolution');
    this.gl = gl;
    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, s] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    const progs = {};
    this.layers = layers.map((L) => {
      const IG = Math.ceil(L.ic / 4);
      const key = `${IG}:${L.prelu}`;
      progs[key] ||= prog(convGLSL(IG, L.prelu));
      const mats = packMats(L);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, mats.length / 16, 0, gl.RGBA, gl.FLOAT, mats);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return { prog: progs[key], tex: t, L, OGT: L.oc / 4 };
    });
    this.shuffle = prog(SHUFFLE_GL);
    this.fb = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.size = [0, 0];
  }
  arr(w, h, layers) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, w, h, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  ensure(w, h) {
    if (this.size[0] >= w && this.size[1] >= h) return;
    w = Math.max(w, this.size[0]); h = Math.max(h, this.size[1]);
    const gl = this.gl;
    for (const t of [this.A, this.B, this.I]) if (t) gl.deleteTexture(t);
    this.A = this.arr(w, h, 16); this.B = this.arr(w, h, 16);
    this.I = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.I);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, w, h, 1);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.size = [w, h];
  }
  async run(rgb, w, h, vx, vy, vw, vh, scale, job) {
    const gl = this.gl;
    const step = job ? pacer(job, () => glFinished(gl)) : null;
    this.ensure(w, h);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.I);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, 1, gl.RGBA, gl.FLOAT, rgb);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, w, h);
    let src = this.I, dst = this.A;
    for (const { prog, tex, L, OGT } of this.layers) {
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, src);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 0);
      gl.uniform1i(gl.getUniformLocation(prog, 'uW'), 1);
      gl.uniform2i(gl.getUniformLocation(prog, 'uSize'), w, h);
      for (let og0 = 0; og0 < OGT; og0 += 4) {
        for (let k = 0; k < 4; k++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, dst, 0, og0 + k);
        gl.drawBuffers([0, 1, 2, 3].map((k) => gl.COLOR_ATTACHMENT0 + k));
        gl.uniform1i(gl.getUniformLocation(prog, 'uOg0'), og0);
        gl.uniform4fv(gl.getUniformLocation(prog, 'uBias'), L.b.subarray(og0 * 4, og0 * 4 + 16));
        if (L.a) gl.uniform4fv(gl.getUniformLocation(prog, 'uSlope'), L.a.subarray(og0 * 4, og0 * 4 + 16));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      src = dst; dst = dst === this.A ? this.B : this.A;
      if (step) { await step(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.bindVertexArray(this.vao); gl.viewport(0, 0, w, h); }
    }
    for (let k = 1; k < 4; k++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, null, 0, 0);
    const f = 4 / scale, ow = vw * scale, oh = vh * scale;
    const out = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ow, oh);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, ow, oh);
    gl.useProgram(this.shuffle);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, src);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.I);
    gl.uniform1i(gl.getUniformLocation(this.shuffle, 'uNet'), 0);
    gl.uniform1i(gl.getUniformLocation(this.shuffle, 'uIn'), 1);
    gl.uniform2i(gl.getUniformLocation(this.shuffle, 'uV'), vx, vy);
    gl.uniform1i(gl.getUniformLocation(this.shuffle, 'uF'), f);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8ClampedArray(ow * oh * 4);
    gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.deleteTexture(out);
    return px;
  }
  destroy() {
    const gl = this.gl;
    for (const l of this.layers) gl.deleteTexture(l.tex);
    for (const t of [this.A, this.B, this.I]) if (t) gl.deleteTexture(t);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ------------------------------------------------------------------ public API

// Which GPU path this device will use: 'webgpu-f16', 'webgpu', 'webgl' or null.
export async function backend(force) {
  if (force !== 'webgl') {
    const g = await webgpu();
    if (g) return g.f16 ? 'webgpu-f16' : 'webgpu';
  }
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('webgl2') : null;
  return c && c.getExtension('EXT_color_buffer_float') ? 'webgl' : null;
}

// Largest scale the output size allows.
// Largest scale (4, 2 or 1) whose result fits: at most MAX_OUT px on the long edge and `maxPixels` in
// all. 0 when even 1× doesn't fit.
export const maxScale = (w, h, maxPixels = Infinity) => [4, 2, 1].find((s) => Math.max(w, h) * s <= MAX_OUT && w * h * s * s <= maxPixels) || 0;

// What the GPU path is called for people: 'Apple GPU · Metal', 'NVIDIA GPU · WebGPU', 'GPU · WebGL'...
export async function gpuLabel() {
  const g = await webgpu();
  if (!g) return (await backend('webgl')) ? 'GPU · WebGL' : null;
  const v = (g.info?.vendor || '').toLowerCase();
  const name = v === 'apple' ? 'Apple GPU' : v ? `${v[0].toUpperCase()}${v.slice(1)} GPU` : 'GPU';
  const api = v === 'apple' ? 'Metal' : 'WebGPU';
  return `${name} · ${api}${g.f16 ? ' · half precision' : ''}`;
}

// Enlarges (scale 2 or 4) or restores (scale 1) `source` (an ImageBitmap, canvas or ImageData, sRGB).
// Resolves an ImageData of the result. `onProgress(fraction)`; `signal` (AbortSignal) cancels.
export async function upscale(source, { scale = 2, denoise = 0.5, tile = 0, onProgress, signal, force, job } = {}) {
  if (![1, 2, 4].includes(scale)) throw new Error('Scale must be 1, 2 or 4');
  let img = source;
  if (!(img instanceof ImageData)) {
    const c = new OffscreenCanvas(source.width, source.height);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(source, 0, 0);
    img = x.getImageData(0, 0, c.width, c.height);
  }
  const { width: W, height: H } = img;
  if (Math.max(W, H) * scale > MAX_OUT) throw new Error(`The result would be over ${MAX_OUT} px on its long edge`);
  const layers = blendedLayers(await loadRaw(), denoise);
  const g = force === 'webgl' ? null : await webgpu();
  const runner = g ? new GPURunner(g, layers) : new GLRunner(layers);
  // Tiles sized so each GPU step fits the time budget (jobs.js), so the editor stays smooth.
  const MAXT = 384;
  const sizer = chunker(tile || (job ? 96 : g ? 256 : 192), 48, tile || MAXT);
  const out = new ImageData(W * scale, H * scale);
  const buf = new Float32Array((MAXT + 2 * PAD) ** 2 * 4);
  let doneArea = 0, alpha = false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { alpha = true; break; }
  try {
    for (let y0 = 0; y0 < H;) {
      const y1 = Math.min(H, y0 + sizer.size);
      for (let x0 = 0; x0 < W;) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const x1 = Math.min(W, x0 + sizer.size);
        const t0 = performance.now();
        const sx0 = Math.max(0, x0 - PAD), sy0 = Math.max(0, y0 - PAD), sx1 = Math.min(W, x1 + PAD), sy1 = Math.min(H, y1 + PAD);
        const w = sx1 - sx0, h = sy1 - sy0;
        const rgb = buf.subarray(0, w * h * 4);
        for (let y = 0; y < h; y++) {
          let s = ((sy0 + y) * W + sx0) * 4, d = y * w * 4;
          for (let x = 0; x < w; x++, s += 4, d += 4) { rgb[d] = img.data[s] / 255; rgb[d + 1] = img.data[s + 1] / 255; rgb[d + 2] = img.data[s + 2] / 255; rgb[d + 3] = 0; }
        }
        const vw = x1 - x0, vh = y1 - y0;
        const px = await runner.run(rgb, w, h, x0 - sx0, y0 - sy0, vw, vh, scale, job);
        const ow = vw * scale;
        for (let y = 0; y < vh * scale; y++) {
          const d = ((y0 * scale + y) * W * scale + x0 * scale) * 4;
          out.data.set(px.subarray(y * ow * 4, (y + 1) * ow * 4), d);
        }
        // Keep the original alpha (nearest).
        if (alpha) {
          for (let y = 0; y < vh * scale; y++) for (let x = 0; x < ow; x++) {
            out.data[((y0 * scale + y) * W * scale + x0 * scale + x) * 4 + 3] = img.data[((y0 + Math.floor(y / scale)) * W + x0 + Math.floor(x / scale)) * 4 + 3];
          }
        }
        sizer.report(performance.now() - t0);
        doneArea += vw * vh;
        onProgress?.(doneArea / (W * H));
        x0 = x1;
        // Let the editor have the GPU between tiles (and wait while you work, for queued jobs).
        await (job ? breathe(job) : new Promise((r) => setTimeout(r, 0)));
      }
      y0 = y1;
    }
  } finally {
    runner.destroy();
  }
  return out;
}

// For tests.
export const _internals = { GLRunner, GPURunner, webgpu, blendedLayers, loadRaw, convWGSL, shuffleWGSL };
// Shared with AI Denoise (denoise.js).
export { webgpu, packMats, convWGSL, convGLSL, VS, TX, TH };
