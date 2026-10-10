// AI worker (classic worker): runs on-device models with MediaPipe Tasks (TFLite + XNNPACK in WebAssembly).
//   depth   — monocular relative depth (MiDaS-style, near = 1)
//   subject — main subject probability (people first, then a 21-class scene segmenter)
//   object  — interactive "click to select" segmentation
//   people  — hair, skin and clothes (multiclass selfie segmenter)
//   face    — face landmarks
// All maps are refined with a fast guided filter using the photo's luminance as guide, so edges
// follow the image. Output: Float32Array in [0, 1], same size as the input bitmap.
/* global Vision */
// MediaPipe reports usage statistics to Google (odml.pa.googleapis.com) through fetch. Rembrandt keeps
// everything on the device, so those requests are answered here and never leave it.
const netFetch = self.fetch.bind(self);
self.fetch = (input, init) => (/^https:\/\/[^/]*odml\.pa\.googleapis\.com\//.test(String(input?.url ?? input))
  ? Promise.resolve(new Response('', { status: 200 })) : netFetch(input, init));
importScripts('../vendor/mediapipe/vision_bundle.js');

const BASE = new URL('../', self.location.href).href;
const MODELS = new URL('../../models/', self.location.href).href;
let fileset = null;
const tasks = {};

async function files() {
  return (fileset ||= Vision.FilesetResolver.forVisionTasks(BASE + 'vendor/mediapipe'));
}
// Models are plain .tflite files; hosts that cannot serve binaries may provide base64 text copies.
async function loadModel(name) {
  const r = await fetch(MODELS + name + '.tflite');
  if (r.ok) return new Uint8Array(await r.arrayBuffer());
  const t = await fetch(MODELS + name + '.tflite.b64.txt');
  if (!t.ok) throw new Error(`Model ${name} is not available`);
  const bin = atob((await t.text()).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Face landmarks (MediaPipe Face Landmarker, 478 points per face), for blemish removal.
let faceTask = null;
async function faceLandmarker() {
  return (faceTask ||= (async () => {
    const fs = await files();
    let buf;
    const r = await fetch(MODELS + 'face.task');
    if (r.ok) buf = new Uint8Array(await r.arrayBuffer());
    else {
      const t = await fetch(MODELS + 'face.task.b64.txt');
      if (!t.ok) throw new Error('The face model is not available');
      const bin = atob((await t.text()).trim());
      buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    }
    return Vision.FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 8, minFaceDetectionConfidence: 0.4 });
  })());
}

async function segmenter(name) {
  if (!tasks[name]) {
    tasks[name] = (async () => {
      const fs = await files();
      const base = { modelAssetBuffer: await loadModel(name), delegate: 'CPU' };
      if (name === 'object') return Vision.InteractiveSegmenterLegacy.createFromOptions(fs, { baseOptions: base, outputConfidenceMasks: true, outputCategoryMask: false });
      return Vision.ImageSegmenter.createFromOptions(fs, { baseOptions: base, outputConfidenceMasks: true, outputCategoryMask: false, runningMode: 'IMAGE' });
    })();
  }
  return tasks[name];
}

function luminance(bitmap) {
  const { width: w, height: h } = bitmap;
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0);
  const d = x.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return L;
}

// O(n) box mean with radius r (clamped edges), separable.
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Guided filter (He et al. 2010) with a grey guide I.
function guided(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

function normalize(a, lo = 0.01, hi = 0.99) {
  const s = Float32Array.from(a).sort();
  const vlo = s[Math.floor(lo * (s.length - 1))], vhi = s[Math.floor(hi * (s.length - 1))];
  const k = 1 / Math.max(vhi - vlo, 1e-6);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.min(1, Math.max(0, (a[i] - vlo) * k));
  return out;
}

// Bilinear resize of a float map.
function resize(m, mw, mh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * mh / h - 0.5)), y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * mw / w - 0.5)), x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (m[y0 * mw + x0] * (1 - tx) + m[y0 * mw + x1] * tx) * (1 - ty) + (m[y1 * mw + x0] * (1 - tx) + m[y1 * mw + x1] * tx) * ty;
    }
  }
  return out;
}

const mask0 = (r, i = 0) => { const m = r.confidenceMasks[i]; return { data: Float32Array.from(m.getAsFloat32Array()), w: m.width, h: m.height }; };
const closeAll = (r) => r.confidenceMasks?.forEach((m) => m.close());

async function run(op, bitmap, point) {
  const w = bitmap.width, h = bitmap.height;
  const L = luminance(bitmap);
  const r = Math.max(2, Math.round(Math.max(w, h) / 160));
  if (op === 'depth') {
    const seg = await segmenter('depth');
    const res = seg.segment(bitmap);
    const m = mask0(res); closeAll(res);
    return guided(L, normalize(m.data), w, h, r, 1e-3);
  }
  if (op === 'subject') {
    const person = await segmenter('subject-person');
    const pr = person.segment(bitmap);
    // The person model outputs one channel: probability of a person.
    let m = mask0(pr, pr.confidenceMasks.length - 1).data; closeAll(pr);
    let cover = 0;
    for (let i = 0; i < m.length; i++) cover += m[i] > 0.5;
    if (cover / m.length < 0.02) {
      const gen = await segmenter('subject-general');
      const gr = gen.segment(bitmap);
      const bg = mask0(gr, 0).data; closeAll(gr);
      m = bg.map((v) => 1 - v);
    }
    return guided(L, m, w, h, r, 4e-4);
  }
  if (op === 'people') {
    // Multiclass selfie segmenter: background, hair, body skin, face skin, clothes, other.
    // Out: hair, body skin, face skin, clothes, then the whole person, each w × h.
    const seg = await segmenter('people');
    const res = seg.segment(bitmap);
    const planes = [1, 2, 3, 4].map((k) => mask0(res, k).data);
    const bg = mask0(res, 0).data;
    closeAll(res);
    const mw = res.confidenceMasks?.[0]?.width ?? w;
    planes.push(bg.map((v) => 1 - v));
    const out = new Float32Array(5 * w * h);
    planes.forEach((m, k) => out.set(guided(L, m.length === w * h ? m : resize(m, mw, m.length / mw, w, h), w, h, r, 4e-4), k * w * h));
    return out;
  }
  if (op === 'face') {
    // [faces, then x, y (0–1) for each of 478 landmarks per face]
    const fl = await faceLandmarker();
    const res = fl.detect(bitmap);
    const faces = res.faceLandmarks || [];
    const out = new Float32Array(1 + faces.length * 478 * 2);
    out[0] = faces.length;
    faces.forEach((f, k) => f.slice(0, 478).forEach((p, i) => { out[1 + (k * 478 + i) * 2] = p.x; out[2 + (k * 478 + i) * 2] = p.y; }));
    return out;
  }
  if (op === 'object') {
    const seg = await segmenter('object');
    const res = seg.segment(bitmap, { keypoint: { x: point[0], y: point[1] } });
    const m = mask0(res); closeAll(res);   // model output is at input size
    return guided(L, m.data, w, h, r, 4e-4);
  }
  throw new Error('Unknown AI operation ' + op);
}

self.onmessage = async ({ data }) => {
  const { id, op, bitmap, point } = data;
  try {
    const t0 = performance.now();
    const out = await run(op, bitmap, point);
    self.postMessage({ id, ok: true, w: bitmap.width, h: bitmap.height, data: out, ms: Math.round(performance.now() - t0) }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  } finally {
    bitmap.close?.();
  }
};
