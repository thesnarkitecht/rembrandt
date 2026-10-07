// Web Worker for merge.js: frames arrive one at a time ({ op: 'add' }), the DNG comes back at the end.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { HDRMerge, FocusStack, panorama, to16, writeDNG } from './merge.js';
import { toneFwd, RAW_EV } from '../engine/src/color.js';

let kind = null, job = null, frames = [];
const MODEL = { hdr: 'HDR', focus: 'Focus stack', pano: 'Panorama' };

const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055);

// A JPEG preview inside the DNG, so the library shows the merge before the RAW decoder runs.
async function previewJpeg(rgb, w, h, long = 1600) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const s = Math.min(1, long / Math.max(w, h)), pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
  const img = new ImageData(pw, ph), g = 2 ** RAW_EV;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = (Math.min(h - 1, Math.floor(y / s)) * w + Math.min(w - 1, Math.floor(x / s))) * 3, o = (y * pw + x) * 4;
    for (let c = 0; c < 3; c++) img.data[o + c] = enc(toneFwd(Math.max(0, rgb[i + c] * g))) * 255;
    img.data[o + 3] = 255;
  }
  const cv = new OffscreenCanvas(pw, ph);
  cv.getContext('2d').putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: pw, h: ph };
}

const progress = (id, text) => self.postMessage({ id, progress: text });

self.onmessage = async ({ data: m }) => {
  const { id } = m;
  try {
    if (m.op === 'begin') {
      kind = m.kind; frames = [];
      job = kind === 'hdr' ? new HDRMerge() : kind === 'focus' ? new FocusStack() : null;
      self.postMessage({ id, ok: true });
    } else if (m.op === 'add') {
      const info = job ? job.add(m.frame, m.meta) : (frames.push(m.frame), {});
      self.postMessage({ id, ok: true, info });
    } else if (m.op === 'finish') {
      const r = job ? job.finish() : panorama(frames, { onProgress: (t) => progress(id, t) });
      frames = []; job = null;
      progress(id, 'Writing the DNG…');
      const pv = await previewJpeg(r.rgb, r.w, r.h).catch(() => null);
      const { data, baseline } = to16(r.rgb);
      const dng = writeDNG({ w: r.w, h: r.h, data, baseline, preview: pv?.bytes, previewW: pv?.w, previewH: pv?.h, model: MODEL[kind] });
      self.postMessage({ id, ok: true, dng, w: r.w, h: r.h }, [dng.buffer]);
    }
  } catch (err) {
    frames = []; job = null;
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
