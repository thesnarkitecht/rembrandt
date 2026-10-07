// AI Denoise: removes sensor noise from a photo with FFDNet (Zhang, Zuo & Zhang 2018; weights from
// KAIR, MIT, see models/README.md), on this device's GPU with the same convolution kernels as
// Super Resolution (upscale.js). Like Lightroom's Denoise, the result is a new linear DNG beside the
// original, so every edit still applies and the original is untouched.
//
// FFDNet works on the photo pixel-unshuffled by 2 (half the size, 12 channels) plus a map of the noise
// level, through 12 convolutions of 96 channels. The noise level is measured from the photo itself
// (median of the Laplacian per channel, Immerkær 1996) and the Strength slider scales it; shadows,
// where read noise dominates once the photo is encoded, get a little more.
//
// The network expects display-encoded pixels, so linear data is brightened as the RAW pipeline would
// (2^(RAW_EV + baseline)), scaled into range with its highlights kept, sRGB-encoded, denoised and
// decoded back; the DNG's BaselineExposure restores the same brightness.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { webgpu, packMats, convWGSL, convGLSL, VS, TX, TH } from './upscale.js';
import { H2F } from '../merge.js';
import { breathe, chunker, pacer, glFinished } from '../jobs.js';

const SIZES = [[13, 96], ...Array(10).fill([96, 96]), [96, 12]];
const T = 192, PAD = 14;   // tile and overlap, in half-size pixels

let raw = null;
async function loadWeights() {
  if (raw) return raw;
  const url = new URL('../../models/denoise-ffdnet-color.bin', import.meta.url);
  const r = await fetch(url);
  let buf;
  if (r.ok) buf = await r.arrayBuffer();
  else {
    // Hosts that cannot serve binaries may provide a base64 text copy.
    const t = await fetch(url.href + '.b64.txt');
    if (!t.ok) throw new Error('The AI Denoise model is not available');
    buf = Uint8Array.from(atob((await t.text()).trim()), (c) => c.charCodeAt(0)).buffer;
  }
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'RDN1') throw new Error('The AI Denoise model file is damaged');
  return (raw = new Uint16Array(buf, 4));
}

// Layers in the shape the kernels take: ReLU as a PReLU with slope 0, the last layer padded to 16
// outputs (the kernels work in groups of 16).
function layers(w16) {
  let o = 0;
  const take = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = H2F[w16[o + i]]; o += n; return a; };
  return SIZES.map(([ic, oc], l) => {
    const last = l === SIZES.length - 1, OC = last ? 16 : oc;
    const w = new Float32Array(OC * ic * 9), b = new Float32Array(OC);
    w.set(take(oc * ic * 9)); b.set(take(oc));
    return { ic, oc: OC, prelu: !last, w, b, a: last ? null : new Float32Array(OC) };
  });
}

// ------------------------------------------------------------------ runners
// Both take the 16-channel input (4 planar groups of vec4) of a w×h half-size tile and return the
// network's 16 output channels the same way, as Float32Array.

class GPUNet {
  constructor(g, L) {
    this.g = g;
    const { device } = g;
    this.layers = L.map((l, i) => {
      const IG = Math.ceil(l.ic / 4), OGT = l.oc / 4, key = `${IG}:1:${i === 0}:${l.prelu}:${OGT}`;
      let pipe = g.pipes.get(key);
      if (!pipe) { pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: convWGSL(g.f16, IG, 1, i === 0, l.prelu, OGT) }), entryPoint: 'main' } }); g.pipes.set(key, pipe); }
      const mats = packMats(l);
      const wb = device.createBuffer({ size: mats.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(wb, 0, mats);
      const ba = new Float32Array(l.oc * 2); ba.set(l.b); if (l.a) ba.set(l.a, l.oc);
      const bb = device.createBuffer({ size: ba.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(bb, 0, ba);
      return { pipe, wb, bb, OGT };
    });
    this.cap = 0;
  }
  ensure(n) {
    if (this.cap >= n) return;
    for (const b of [this.A, this.B, this.I]) b?.destroy();
    const { device } = this.g, el = this.g.f16 ? 8 : 16;
    this.A = device.createBuffer({ size: n * 24 * el, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.B = device.createBuffer({ size: n * 24 * el, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.I = device.createBuffer({ size: n * 4 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.cap = n;
  }
  async run(input, w, h, job) {
    const { device, f16 } = this.g, n = w * h;
    const step = job ? pacer(job, () => device.queue.onSubmittedWorkDone()) : null;
    this.ensure(n);
    device.queue.writeBuffer(this.I, 0, input);
    const dims = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(dims, 0, new Uint32Array([w, h, 0, 0]));
    let enc = device.createCommandEncoder();
    let src = this.I, dst = this.A;
    for (const L of this.layers) {
      // Queued work goes one layer at a time, so the editor's frames get the GPU in between.
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
    const bytes = n * 4 * (f16 ? 8 : 16);
    const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(src, 0, read, 0, bytes);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const m = read.getMappedRange();
    let out;
    if (f16) { const h16 = new Uint16Array(m); out = new Float32Array(h16.length); for (let i = 0; i < h16.length; i++) out[i] = H2F[h16[i]]; }
    else out = new Float32Array(m.slice(0));
    read.unmap();
    read.destroy(); dims.destroy();
    return out;
  }
  destroy() {
    for (const L of this.layers) { L.wb.destroy(); L.bb.destroy(); }
    for (const b of [this.A, this.B, this.I]) b?.destroy();
  }
}

class GLNet {
  constructor(L) {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('This device has no GPU support for AI Denoise');
    this.gl = gl;
    const progs = {};
    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, s] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      }
      gl.linkProgram(p);
      return p;
    };
    this.layers = L.map((l) => {
      const IG = Math.ceil(l.ic / 4), key = `${IG}:${l.prelu}`;
      progs[key] ||= prog(convGLSL(IG, l.prelu));
      const mats = packMats(l), t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, mats.length / 16, 0, gl.RGBA, gl.FLOAT, mats);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return { prog: progs[key], tex: t, l, OGT: l.oc / 4 };
    });
    this.fb = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.size = [0, 0];
  }
  arr(w, h, n, fmt) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, fmt, w, h, n);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  async run(input, w, h, job) {
    const gl = this.gl;
    const step = job ? pacer(job, () => glFinished(gl)) : null;
    // Textures only grow: tiles change size as the work adapts to the GPU.
    if (this.size[0] < w || this.size[1] < h) {
      const W = Math.max(w, this.size[0]), H = Math.max(h, this.size[1]);
      for (const t of [this.A, this.B, this.I]) if (t) gl.deleteTexture(t);
      this.A = this.arr(W, H, 24, gl.RGBA16F); this.B = this.arr(W, H, 24, gl.RGBA16F); this.I = this.arr(W, H, 4, gl.RGBA32F);
      this.size = [W, H];
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.I);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, 4, gl.RGBA, gl.FLOAT, input);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, w, h);
    let src = this.I, dst = this.A;
    for (const { prog, tex, l, OGT } of this.layers) {
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
        gl.uniform4fv(gl.getUniformLocation(prog, 'uBias'), l.b.subarray(og0 * 4, og0 * 4 + 16));
        if (l.a) gl.uniform4fv(gl.getUniformLocation(prog, 'uSlope'), l.a.subarray(og0 * 4, og0 * 4 + 16));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      src = dst; dst = dst === this.A ? this.B : this.A;
      if (step) {
        await step();
        // The editor may have drawn in between: our framebuffer, VAO and viewport are per context, so
        // they are still ours; rebind to be safe.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.bindVertexArray(this.vao); gl.viewport(0, 0, w, h);
      }
    }
    for (let k = 1; k < 4; k++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, null, 0, 0);
    const out = new Float32Array(w * h * 16), plane = new Float32Array(w * h * 4);
    for (let g = 0; g < 4; g++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, src, 0, g);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, plane);
      out.set(plane, g * w * h * 4);
    }
    return out;
  }
  destroy() {
    const gl = this.gl;
    for (const l of this.layers) gl.deleteTexture(l.tex);
    for (const t of [this.A, this.B, this.I]) if (t) gl.deleteTexture(t);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ------------------------------------------------------------------ encoding

const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const dec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const ENC = new Float32Array(65536);   // half float → encoded, filled per photo (depends on the scale)

// Noise level of encoded pixels (0..1), per channel, from the median absolute Laplacian.
function noiseLevel(Y, w, h) {
  const x0 = Math.max(1, (w >> 1) - 600), x1 = Math.min(w - 1, (w >> 1) + 600), y0 = Math.max(1, (h >> 1) - 600), y1 = Math.min(h - 1, (h >> 1) + 600);
  const est = [];
  for (let c = 0; c < 3; c++) {
    const r = [];
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const at = (dx, dy) => Y(x + dx, y + dy, c);
      r.push(Math.abs(at(-1, -1) - 2 * at(0, -1) + at(1, -1) - 2 * at(-1, 0) + 4 * at(0, 0) - 2 * at(1, 0) + at(-1, 1) - 2 * at(0, 1) + at(1, 1)));
    }
    r.sort((a, b) => a - b);
    est.push(r[r.length >> 1] / 0.6745 / 6);
  }
  return (est[0] + est[1] + est[2]) / 3;
}

// `frame`: { w, h, data (RGBA half floats, linear) }. `gain`: brightness of the photo as displayed
// (2^(RAW_EV + baseline) for RAW). Resolves { data: Uint16Array RGB, scale } where the DNG's display
// brightness is data / 65535 · scale.
export async function denoiseFrame(frame, { gain = 1, strength = 0.5, onProgress, force, job } = {}) {
  const { w: W0, h: H0, data } = frame;
  // Even size for the 2× unshuffle (the last row / column repeats).
  const W = W0 + (W0 & 1), H = H0 + (H0 & 1);
  // Scale so the brightest highlights still fit after encoding.
  const sample = [];
  for (let i = 0; i < data.length; i += 4 * 61) sample.push(Math.max(H2F[data[i]], H2F[data[i + 1]], H2F[data[i + 2]]) * gain);
  sample.sort((a, b) => a - b);
  const M = Math.max(1, sample[Math.floor(sample.length * 0.9995)] || 1);
  for (let i = 0; i < 65536; i++) ENC[i] = enc(Math.min(1, Math.max(0, H2F[i] * gain / M)));
  // Encoded value at (x, y), channel c; the last row and column repeat to make the size even.
  const Y = (x, y, c) => ENC[data[(Math.min(H0 - 1, y) * W0 + Math.min(W0 - 1, x)) * 4 + c]];
  const sigma0 = noiseLevel(Y, W0, H0) * (0.4 + 1.2 * Math.min(1, Math.max(0, strength)));
  const L = layers(await loadWeights());
  const g = force === 'webgl' ? null : await webgpu();
  const net = g ? new GPUNet(g, L) : new GLNet(L);
  const w2 = W / 2, h2 = H / 2;
  const out = new Uint16Array(W0 * H0 * 3);
  async function tile(x0, y0, x1, y1) {
    const sx0 = Math.max(0, x0 - PAD), sy0 = Math.max(0, y0 - PAD), sx1 = Math.min(w2, x1 + PAD), sy1 = Math.min(h2, y1 + PAD);
    const w = sx1 - sx0, h = sy1 - sy0, n = w * h;
    // Input: 12 unshuffled channels (channel c·4 + dy·2 + dx) and the noise map, as 4 planes of vec4.
    const inp = new Float32Array(n * 16);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let lum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const X = 2 * (sx0 + x) + dx, Yy = 2 * (sy0 + y) + dy;
        for (let c = 0; c < 3; c++) {
          const k = c * 4 + dy * 2 + dx;
          inp[((k >> 2) * n + p) * 4 + (k & 3)] = Y(X, Yy, c);
        }
        lum += Y(X, Yy, 1);
      }
      lum /= 4;
      inp[(3 * n + p) * 4] = sigma0 * (1 + 0.5 * (1 - lum) ** 3);
    }
    const res = await net.run(inp, w, h, job);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y - sy0) * w + (x - sx0);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const X = 2 * x + dx, Yy = 2 * y + dy;
        if (X >= W0 || Yy >= H0) continue;
        const o = (Yy * W0 + X) * 3;
        for (let c = 0; c < 3; c++) {
          const k = c * 4 + dy * 2 + dx;
          const v = res[((k >> 2) * n + p) * 4 + (k & 3)];
          out[o + c] = Math.round(dec(Math.min(1, Math.max(0, v))) * 65535);
        }
      }
    }
  }
  // Tiles sized so each GPU step fits the time budget (jobs.js); between tiles the editor gets the
  // GPU back, and waits while you work.
  const sizer = chunker(job ? 96 : T, 32, 256);
  let doneArea = 0;
  try {
    for (let y0 = 0; y0 < h2;) {
      const y1 = Math.min(h2, y0 + sizer.size);
      for (let x0 = 0; x0 < w2;) {
        const x1 = Math.min(w2, x0 + sizer.size);
        const t0 = performance.now();
        await tile(x0, y0, x1, y1);
        sizer.report(performance.now() - t0);
        doneArea += (x1 - x0) * (y1 - y0);
        onProgress?.(doneArea / (w2 * h2));
        x0 = x1;
        await (job ? breathe(job) : new Promise((r) => setTimeout(r, 0)));
      }
      y0 = y1;
    }
  } finally {
    net.destroy();
  }
  return { data: out, scale: M, sigma: sigma0 };
}
