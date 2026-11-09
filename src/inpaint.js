// Generative Remove: paint over something and it's gone, filled with what plausibly was behind it.
// The fill comes from MI-GAN (Sargsyan et al., ICCV 2023; Picsart, MIT licence), a small inpainting
// network made for phones. The desktop app runs it natively (src-tauri/src/inpaint.rs: every core, and
// the Neural Engine on Apple silicon); elsewhere ONNX Runtime Web (MIT) runs it on the CPU, so it works
// on any computer. See models/README.md.
//
// A fill is worked out once, when you paint it, from the photo as it is then (after lens corrections
// and earlier spots), and kept as a small image beside the photo: the patch, display-encoded, and the
// scale it was encoded at. Spot removal (retouch.js) blends it back into the linear source on every
// render, so it follows all later edits and exports. Nothing leaves the device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import * as catalog from './catalog.js';
import { assertAi } from './workspace.js';
import { nativeInpaint, nativeInpaintWarm } from './loader.js';

let session = null;
async function model() {
  if (session) return session;
  session = (async () => {
    const ort = await import('./vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    // In a worker: a fill takes a second or more, and on the page's own thread the whole app froze for it.
    ort.env.wasm.proxy = true;
    const s = await ort.InferenceSession.create(new URL('../models/inpaint-migan.onnx', import.meta.url).href, { executionProviders: ['wasm'] });
    return { ort, s };
  })();
  try { return await session; } catch (e) { session = null; throw e; }
}

// Loads the model ahead of the first fill (the Remove tool opened): natively, or the WebAssembly one.
export async function warmInpaint() {
  try { if (!(await nativeInpaintWarm())) await model(); } catch { /* the first fill loads it */ }
}

// Fills the holes of an 8-bit RGB image (`rgb` interleaved, `hole` 1 where to fill), w × h.
// Returns the filled image as interleaved RGB bytes.
export async function inpaint(rgb, hole, w, h) {
  assertAi();
  const n = w * h, img = new Uint8Array(3 * n), mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    img[i] = rgb[i * 3]; img[n + i] = rgb[i * 3 + 1]; img[2 * n + i] = rgb[i * 3 + 2];
    mask[i] = hole[i] ? 0 : 255;   // MI-GAN: 0 = fill, 255 = keep
  }
  let o = await nativeInpaint(img, mask, w, h).catch((e) => { console.warn('native fill', e); return null; });
  if (!o) {
    const { ort, s } = await model();
    o = (await s.run({ image: new ort.Tensor('uint8', img, [1, 3, h, w]), mask: new ort.Tensor('uint8', mask, [1, 1, h, w]) })).result.data;
  }
  const out = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) { out[i * 3] = o[i]; out[i * 3 + 1] = o[n + i]; out[i * 3 + 2] = o[2 * n + i]; }
  return out;
}

// ---------------------------------------------------------------- patches

// Loaded patches: key → { w, h, data (RGBA bytes) }. `onReady` is called when one arrives.
export const patches = new Map();
const loading = new Set();
export const hooks = { onReady: () => {} };

export async function savePatch(key, rgba, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  patches.set(key, { w, h, data: rgba });
  await catalog.storeFile(key, new File([blob], key + '.png', { type: 'image/png' }));
}

// Starts loading a patch that isn't in memory; false while it isn't there.
export function patchReady(key) {
  if (patches.has(key)) return true;
  if (!loading.has(key)) {
    loading.add(key);
    (async () => {
      try {
        const f = await catalog.getFile(key);
        if (!f) return;
        const bm = await createImageBitmap(f, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(bm, 0, 0);
        patches.set(key, { w: bm.width, h: bm.height, data: new Uint8Array(x.getImageData(0, 0, bm.width, bm.height).data.buffer) });
        bm.close();
        hooks.onReady(key);
      } catch (e) { console.warn('fill patch', key, e); } finally { loading.delete(key); }
    })();
  }
  return false;
}
