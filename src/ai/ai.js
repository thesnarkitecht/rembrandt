// AI analysis client: runs the models in a worker, caches results per photo, and keeps GPU
// textures of the maps the engine passes need (depth, subject, clicked objects).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

import { estimateBlur } from './refocus.js';

const ANALYSIS_LONG = 1024;

let worker = null;
let seq = 0;
const waiting = new Map();
function call(op, bitmap, point) {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      waiting.delete(data.id);
      data.ok ? w.resolve(data) : w.reject(new Error(data.error));
    };
    worker.onerror = (e) => { for (const w of waiting.values()) w.reject(new Error(e.message || 'AI worker failed')); waiting.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, bitmap, point }, [bitmap]);
  });
}

// Input for the models: the developed RAW preview when there is one, else the decoded image.
async function inputBitmap(e) {
  if (e.linear?.preview) {
    const pv = e.linear.preview;
    return createImageBitmap(new ImageData(new Uint8ClampedArray(pv.data), pv.w, pv.h));
  }
  const src = e.bitmap;
  if (!src) {
    const s = e.sample;
    return createImageBitmap(new ImageData(new Uint8ClampedArray(s.data), s.w, s.h));
  }
  const k = Math.min(1, ANALYSIS_LONG / Math.max(src.width, src.height));
  return createImageBitmap(src, { resizeWidth: Math.max(1, Math.round(src.width * k)), resizeHeight: Math.max(1, Math.round(src.height * k)), resizeQuality: 'high' });
}

const toU8 = (f) => { const u = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) u[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 255); return u; };

// Which analyses the settings need.
export function aiNeeds(p) {
  const need = new Set();
  const a = p.ai;
  if (a) {
    if (a.blur.amount > 0) { need.add('depth'); if (a.blur.protect) need.add('subject'); }
    if (a.bg.mode !== 'none' || a.bg.blur > 0) need.add('subject');
    if (a.refocus?.amount > 0 && a.refocus.scope !== 'all') need.add('subject');
    const r = a.relight, sk = a.sky;
    if ((r && (r.near || r.far || r.warmth)) || (sk && (sk.deepen || sk.warmth || sk.saturation)) || a.atmos?.amount > 0 || a.rays?.amount > 0) need.add('depth');
    if (a.enhance?.amount > 0 || a.skin?.amount > 0 || (a.motion?.amount > 0 && a.motion.protect !== false) || (sk && (sk.deepen || sk.warmth || sk.saturation)) || a.atmos?.amount > 0 || a.rays?.amount > 0) need.add('subject');
  }
  for (const m of p.masks || []) {
    for (const c of m.comps) {
      if (c.type === 'subject') need.add('subject');
      if (c.type === 'depth') need.add('depth');
    }
  }
  return need;
}
export const objectComps = (m) => m.comps.filter((c) => c.type === 'object' && c.point).slice(0, 4);

// Faces in a photo: [[ [x, y] × 478 ] per face], x and y 0–1 of the photo. Uses a larger input than
// the other analyses so faces in wider shots are still found.
export async function detectFaces(e) {
  if (e.ai?.faces) return e.ai.faces;
  let bm;
  if (e.bitmap) {
    const k = Math.min(1, 2048 / Math.max(e.bitmap.width, e.bitmap.height));
    bm = await createImageBitmap(e.bitmap, { resizeWidth: Math.max(1, Math.round(e.bitmap.width * k)), resizeHeight: Math.max(1, Math.round(e.bitmap.height * k)), resizeQuality: 'high' });
  } else bm = await inputBitmap(e);
  const r = await call('face', bm);
  const d = r.data, n = d[0], faces = [];
  for (let k = 0; k < n; k++) faces.push(Array.from({ length: 478 }, (_, i) => [d[1 + (k * 478 + i) * 2], d[2 + (k * 478 + i) * 2]]));
  e.ai ||= { objects: new Map() };
  e.ai.faces = faces;
  return faces;
}

export class AI {
  constructor() {
    this.engine = null;
    this.entry = null;
    this.busy = 0;
    this.listeners = new Set();
    this.tex = { depth: null, subject: null };
    this.objTex = new Map();
  }
  onChange(f) { this.listeners.add(f); }
  emit() { this.listeners.forEach((f) => f(this)); }

  // The engine is now showing entry `e`.
  bind(engine, e) {
    this.engine = engine;
    if (this.entry === e) return;
    this.entry = e;
    this.upload();
  }

  has(e, op) { return !!e?.ai?.[op]; }
  get status() { return this.busy ? 'working' : 'idle'; }

  async analyze(e, op, point) {
    e.ai ||= { objects: new Map() };
    const key = op === 'object' ? `${point[0].toFixed(4)},${point[1].toFixed(4)}` : op;
    if (op === 'object' ? e.ai.objects.has(key) : e.ai[op]) return op === 'object' ? e.ai.objects.get(key) : e.ai[op];
    e.aiPending ||= new Map();
    if (e.aiPending.has(key)) return e.aiPending.get(key);
    const job = (async () => {
      this.busy++; this.emit();
      try {
        const r = await call(op, await inputBitmap(e), point);
        const map = { w: r.w, h: r.h, data: r.data, u8: toU8(r.data) };
        if (op === 'object') e.ai.objects.set(key, map);
        else e.ai[op] = map;
        if (op === 'depth') {
          map.subjectDepth = null;
        }
        if (e === this.entry) this.upload();
        return map;
      } finally {
        e.aiPending.delete(key);
        this.busy--; this.emit();
      }
    })();
    e.aiPending.set(key, job);
    return job;
  }

  // Run everything the settings need that is not there yet.
  async ensure(e, p) {
    const ops = [...aiNeeds(p)].filter((op) => !this.has(e, op));
    const objs = [];
    for (const m of p.masks || []) for (const c of objectComps(m)) objs.push(c.point);
    await Promise.all([...ops.map((op) => this.analyze(e, op)), ...objs.map((pt) => this.analyze(e, 'object', pt))]);
    if (p.ai?.refocus?.amount > 0 && e.sample) {
      const key = e.ai?.subject ? 'subject' : 'all';
      if (!e.ai?.blur || e.ai.blur.key !== key) {
        e.ai ||= { objects: new Map() };
        e.ai.blur = { ...estimateBlur(e.sample, e.ai.subject), key };
        this.version = (this.version || 0) + 1;
        this.emit();
      }
    }
  }

  // Median depth of the subject (for auto focus), or of the image centre.
  focusDepth(e) {
    const d = e?.ai?.depth, s = e?.ai?.subject;
    if (!d) return 0.8;
    const vals = [];
    for (let i = 0; i < d.data.length; i += 7) {
      if (s ? s.data[Math.min(s.data.length - 1, i)] > 0.5 : true) vals.push(d.data[i]);
    }
    if (!vals.length) return 0.8;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  depthAt(e, [u, v]) {
    const d = e?.ai?.depth;
    if (!d) return null;
    const x = Math.min(d.w - 1, Math.max(0, Math.floor(u * d.w))), y = Math.min(d.h - 1, Math.max(0, Math.floor(v * d.h)));
    let s = 0, n = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const xx = Math.min(d.w - 1, Math.max(0, x + i)), yy = Math.min(d.h - 1, Math.max(0, y + j));
      s += d.data[yy * d.w + xx]; n++;
    }
    return s / n;
  }

  // ------------------------------------------------------------ GPU textures

  makeTex(w, h, fmt, data) {
    const gl = this.engine.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt === 'rgba' ? gl.RGBA8 : gl.R8, w, h, 0, fmt === 'rgba' ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  upload() {
    if (!this.engine) return;
    const gl = this.engine.gl;
    for (const k of ['depth', 'subject']) {
      if (this.tex[k]) gl.deleteTexture(this.tex[k]);
      const m = this.entry?.ai?.[k];
      this.tex[k] = m ? this.makeTex(m.w, m.h, 'r', m.u8) : null;
    }
    for (const t of this.objTex.values()) gl.deleteTexture(t.tex);
    this.objTex.clear();
    this.version = (this.version || 0) + 1;
  }

  // RGBA texture with up to four clicked objects of mask `m` (one per channel).
  objectTexture(m) {
    const comps = objectComps(m);
    const maps = comps.map((c) => this.entry?.ai?.objects.get(`${c.point[0].toFixed(4)},${c.point[1].toFixed(4)}`));
    if (!maps.length || maps.some((x) => !x)) return null;
    const key = comps.map((c) => c.point.join(',')).join('|');
    const cur = this.objTex.get(m.id);
    if (cur && cur.key === key) return cur.tex;
    const { w, h } = maps[0];
    const data = new Uint8Array(w * h * 4);
    maps.forEach((mp, ch) => { for (let i = 0; i < w * h; i++) data[i * 4 + ch] = mp.u8[i]; });
    if (cur) this.engine.gl.deleteTexture(cur.tex);
    const tex = this.makeTex(w, h, 'rgba', data);
    this.objTex.set(m.id, { key, tex });
    return tex;
  }
}

export const ai = new AI();
