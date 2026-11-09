// Smart search: find photos by what's in them ("dog on the beach", "red car", "sunset"), on this
// device. OpenAI's CLIP ViT-B/32 (MIT; ONNX conversion by Xenova, quantized) turns each photo's
// thumbnail and each search into 512 numbers that are close when they mean the same thing. The model
// (about 155 MB) is downloaded once, when Smart search is turned on, from a pinned revision and
// checked against its SHA-256; photos and searches never leave the device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { CONFIG } from '../config.js';
import { assertAi } from '../workspace.js';

const REV = 'd15189d7028b43f1d3e65039190477f6af591c2a';
const FILES = {
  vision: { path: 'onnx/vision_model_quantized.onnx', size: 89117001, sha: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' },
  text: { path: 'onnx/text_model_int8.onnx', size: 64070791, sha: '18845f2ccc35223bb7fec403383a131154b11ac0918df25cf51986df5efd3a21' },
  tok: { path: 'tokenizer.json', size: 2224119, sha: 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd' },
};
export const DOWNLOAD_MB = Math.round(Object.values(FILES).reduce((s, f) => s + f.size, 0) / 1e6);
const base = () => CONFIG.clipBase || `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/${REV}/`;
const CACHE = 'rembrandt-models-v1';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// One model file: from the cache, or downloaded (with progress) and checked.
async function file(name, onBytes) {
  const f = FILES[name], url = base() + f.path;
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return hit.arrayBuffer();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn’t download the search model (${r.status})`);
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes?.(value.length);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  const sha = hex(await crypto.subtle.digest('SHA-256', buf));
  if (sha !== f.sha) throw new Error('The search model download was damaged; try again');
  await cache?.put(url, new Response(buf)).catch(() => {});
  return buf.buffer;
}

// Whether everything is downloaded already.
export async function downloaded() {
  try {
    const cache = await caches.open(CACHE);
    for (const f of Object.values(FILES)) if (!(await cache.match(base() + f.path))) return false;
    return true;
  } catch { return false; }
}

let loaded = null;
// Loads (downloading if needed) both networks and the tokenizer. `onProgress(0–1)`.
export function load(onProgress = () => {}) {
  assertAi();
  if (loaded) return loaded;
  loaded = (async () => {
    const total = Object.values(FILES).reduce((s, f) => s + f.size, 0);
    let got = 0;
    const tick = (n) => { got += n; onProgress(Math.min(1, got / total)); };
    const ort = await import('../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.proxy = true;   // in a worker, so indexing and searching photos never freeze the app
    const [v, t, k] = [await file('vision', tick), await file('text', tick), await file('tok', tick)];
    onProgress(1);
    const vision = await ort.InferenceSession.create(new Uint8Array(v));
    const text = await ort.InferenceSession.create(new Uint8Array(t));
    return { ort, vision, text, tok: tokenizer(JSON.parse(new TextDecoder().decode(k))) };
  })();
  loaded.catch(() => { loaded = null; });
  return loaded;
}

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };

// ---------------------------------------------------------------- images

const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711];
// CLIP's input: the shorter side to 224, centre-cropped to 224 × 224, normalised.
export async function imageEmbedding(bitmap) {
  const { ort, vision } = await load();
  const S = 224, k = S / Math.min(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * k), h = Math.round(bitmap.height * k);
  const c = new OffscreenCanvas(S, S), x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, (S - w) / 2, (S - h) / 2, w, h);
  const d = x.getImageData(0, 0, S, S).data, n = S * S, px = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) px[ch * n + i] = (d[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  const r = await vision.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, S, S]) });
  return norm(r.image_embeds.data);
}

// ---------------------------------------------------------------- text

export async function textEmbedding(q) {
  const { ort, text, tok } = await load();
  const ids = tok(q);
  const r = await text.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]) });
  return norm(r.text_embeds.data);
}

// CLIP's byte-level BPE tokenizer: lower case, words split as CLIP splits them, each word's bytes
// merged pairwise by rank, the last piece of a word marked "</w>". Returns ids with the start and end
// tokens, at most 77.
export function tokenizer(json) {
  const vocab = json.model.vocab;
  const ranks = new Map(json.model.merges.map((m, i) => [Array.isArray(m) ? m.join(' ') : m, i]));
  const bytes = [];
  for (let b = 33; b <= 126; b++) bytes.push(b);
  for (let b = 161; b <= 172; b++) bytes.push(b);
  for (let b = 174; b <= 255; b++) bytes.push(b);
  const chars = bytes.slice();
  let extra = 0;
  for (let b = 0; b < 256; b++) if (!bytes.includes(b)) { bytes.push(b); chars.push(256 + extra++); }
  const byteChar = new Map(bytes.map((b, i) => [b, String.fromCharCode(chars[i])]));
  const cache = new Map();
  const bpe = (word) => {
    if (cache.has(word)) return cache.get(word);
    let parts = [...word]; parts[parts.length - 1] += '</w>';
    for (;;) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) { const r = ranks.get(parts[i] + ' ' + parts[i + 1]); if (r !== undefined && r < bestRank) { bestRank = r; best = i; } }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
    cache.set(word, parts);
    return parts;
  };
  const enc = new TextEncoder();
  const PAT = /'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
  const BOS = vocab['<|startoftext|>'], EOS = vocab['<|endoftext|>'];
  return (text) => {
    const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    const ids = [BOS];
    for (const m of clean.matchAll(PAT)) {
      const word = [...enc.encode(m[0])].map((b) => byteChar.get(b)).join('');
      for (const piece of bpe(word)) { const id = vocab[piece]; if (id !== undefined) ids.push(id); }
    }
    ids.length = Math.min(ids.length, 76);
    ids.push(EOS);
    return ids;
  };
}

// ---------------------------------------------------------------- stored form

// Embeddings are kept with each photo as 512 signed bytes plus a scale (2 KB → 0.5 KB).
export function pack(v) {
  let m = 0; for (const x of v) m = Math.max(m, Math.abs(x));
  const s = m / 127 || 1, q = Int8Array.from(v, (x) => Math.round(x / s));
  return { v: 1, s, q };
}
export function similarity(textVec, packed) {
  let dot = 0; const q = packed.q;
  for (let i = 0; i < q.length; i++) dot += textVec[i] * q[i];
  return dot * packed.s;
}
