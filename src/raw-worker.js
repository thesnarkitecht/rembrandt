// Web Worker: decodes camera RAW files with LibRaw (compiled to WebAssembly from native/).
// Output: full-resolution linear RGBA half-floats for the GPU, plus a small display-referred
// 8-bit preview for thumbnails, picking and statistics.
import createModule from './vendor/libraw/lumen-raw.js';
import { toneFwd, rawLook, RAW_EV, SRGB_TO_REC2020 as A, REC2020_TO_SRGB as B } from '../engine/src/color.js';

let modPromise = null;
let halfLUT = null;

function floatToHalf(v) {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const h = sign | (exp << 10) | ((mant + 0x1000) >> 13);
  return h;
}

function lut() {
  if (halfLUT) return halfLUT;
  halfLUT = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) halfLUT[i] = floatToHalf(i / 65535);
  return halfLUT;
}

// Display preview with the same transform as the GPU pipeline at default settings:
// sRGB-linear * gain -> Rec.2020 -> RAW base look -> display curve (hue-preserving below white, per channel near it) -> sRGB.
const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055);
const TONE_MAX = 16;
const tone = new Float32Array(8192);
for (let i = 0; i < tone.length; i++) tone[i] = toneFwd((i / (tone.length - 1)) * TONE_MAX);
const toneAt = (v) => tone[Math.min(tone.length - 1, Math.max(0, Math.round((v / TONE_MAX) * (tone.length - 1))))];

function preview(src, w, h, gain, long = 1024) {
  const s = Math.min(1, long / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
  const out = new Uint8ClampedArray(pw * ph * 4);
  const step = 1 / s;
  const taps = Math.max(1, Math.min(4, Math.floor(step)));
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let r = 0, g = 0, b = 0;
      for (let ty = 0; ty < taps; ty++) {
        const sy = Math.min(h - 1, Math.floor((y + (ty + 0.5) / taps) * step));
        for (let tx = 0; tx < taps; tx++) {
          const sx = Math.min(w - 1, Math.floor((x + (tx + 0.5) / taps) * step));
          const i = (sy * w + sx) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2];
        }
      }
      const k = gain / (taps * taps * 65535);
      const R = r * k, G = g * k, Bb = b * k;
      const s = rawLook([A[0][0] * R + A[0][1] * G + A[0][2] * Bb, A[1][0] * R + A[1][1] * G + A[1][2] * Bb, A[2][0] * R + A[2][1] * G + A[2][2] * Bb].map((v) => Math.max(v, 0)));
      const pc = s.map(toneAt);
      const m = Math.max(s[0], s[1], s[2]);
      let q = pc;
      if (m > 1e-7) {
        const mt = toneAt(m), k = mt / m;
        const t = Math.min(1, Math.max(0, (mt - 0.55) / 0.43)), f = t * t * (3 - 2 * t);
        q = s.map((v, c) => v * k * (1 - f) + pc[c] * f);
      }
      const o = (y * pw + x) * 4;
      out[o] = enc(Math.max(0, B[0][0] * q[0] + B[0][1] * q[1] + B[0][2] * q[2])) * 255;
      out[o + 1] = enc(Math.max(0, B[1][0] * q[0] + B[1][1] * q[1] + B[1][2] * q[2])) * 255;
      out[o + 2] = enc(Math.max(0, B[2][0] * q[0] + B[2][1] * q[1] + B[2][2] * q[2])) * 255;
      out[o + 3] = 255;
    }
  }
  return { data: out, w: pw, h: ph };
}

self.onmessage = async ({ data: msg }) => {
  const { id, buffer, quality = 3, half = 0 } = msg;
  try {
    const M = await (modPromise ||= createModule());
    const bytes = new Uint8Array(buffer);
    const ptr = M._malloc(bytes.length);
    if (!ptr) throw new Error('Not enough memory to open this file');
    M.HEAPU8.set(bytes, ptr);
    const t0 = performance.now();
    const r = M._lr_decode(ptr, bytes.length, quality, half);
    M._free(ptr);
    if (r !== 0) throw new Error(M.UTF8ToString(M._lr_error(r)));
    const w = M._lr_width(), h = M._lr_height();
    const meta = JSON.parse(M.UTF8ToString(M._lr_meta()));
    const dp = M._lr_data();
    const src = new Uint16Array(M.HEAPU8.buffer, dp, w * h * 3);
    // Default brightening of +0.7 EV plus the camera's DNG baseline exposure.
    if (!(meta.baselineExposure > -20 && meta.baselineExposure < 20)) meta.baselineExposure = 0;
    const gain = 2 ** (RAW_EV + meta.baselineExposure);
    const pv = preview(src, w, h, gain);
    const L = lut();
    const out = new Uint16Array(w * h * 4);
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      out[j] = L[src[i]];
      out[j + 1] = L[src[i + 1]];
      out[j + 2] = L[src[i + 2]];
      out[j + 3] = 0x3c00;
    }
    M._lr_free();
    meta.decodeMs = Math.round(performance.now() - t0);
    self.postMessage({ id, ok: true, w, h, meta, gain, data: out, preview: pv }, [out.buffer, pv.data.buffer]);
  } catch (err) {
    try { (await modPromise)?._lr_free(); } catch { /* ignore */ }
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
