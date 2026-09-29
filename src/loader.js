// Decodes image files. Standard formats use the browser decoder; camera RAW files open through the
// full-size JPEG the camera embeds in every RAW (with the RAW's orientation applied).

export const RAW_EXT = new Set([
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl',
  'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'kdc', 'mos', 'mrw', 'dcr', 'mef', 'raw',
]);

export const ACCEPT = 'image/*,' + [...RAW_EXT].map((e) => '.' + e).join(',');

const ext = (name) => (name.split('.').pop() || '').toLowerCase();

export async function decodeFile(file) {
  if (RAW_EXT.has(ext(file.name))) return decodeRaw(file);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    return { bitmap, kind: file.type.replace('image/', '').toUpperCase() || ext(file.name).toUpperCase() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { bitmap: await createImageBitmap(img), kind: ext(file.name).toUpperCase() };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ------------------------------------------------------------------ RAW

function tiffOrientation(u8) {
  if (u8.length < 16) return 0;
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  const be = u8[0] === 0x4d && u8[1] === 0x4d;
  if (!le && !be) return 0;
  const r16 = (o) => (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]);
  const r32 = (o) => (le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0 : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0);
  const ifd = r32(4);
  if (ifd + 2 > u8.length) return 0;
  const n = r16(ifd);
  for (let i = 0; i < n && i < 500; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > u8.length) break;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 0;
}

// Walk JPEG markers from an SOI to find frame size and the end of the stream.
function probeJpeg(u8, off) {
  let pos = off + 2;
  let w = 0, h = 0, sof = 0;
  for (let guard = 0; guard < 400 && pos + 4 < u8.length; guard++) {
    if (u8[pos] !== 0xff) return null;
    const m = u8[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    const len = (u8[pos + 2] << 8) | u8[pos + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      sof = m;
      h = (u8[pos + 5] << 8) | u8[pos + 6];
      w = (u8[pos + 7] << 8) | u8[pos + 8];
    }
    if (m === 0xda) {
      if (!(sof === 0xc0 || sof === 0xc1 || sof === 0xc2) || !w || !h) return null;
      for (let i = pos + 2 + len; i < u8.length - 1; i++) {
        if (u8[i] === 0xff && u8[i + 1] === 0xd9) return { off, end: i + 2, w, h };
      }
      return { off, end: u8.length, w, h };
    }
    pos += 2 + len;
  }
  return null;
}

function findJpegs(u8) {
  const found = [];
  const n = u8.length - 3;
  for (let i = 0; i < n; i++) {
    if (u8[i] !== 0xff || u8[i + 1] !== 0xd8 || u8[i + 2] !== 0xff) continue;
    const m = u8[i + 3];
    if (!((m >= 0xe0 && m <= 0xef) || m === 0xdb || m === 0xc4 || m === 0xc0 || m === 0xfe)) continue;
    const j = probeJpeg(u8, i);
    if (j) {
      found.push(j);
      i = Math.max(i, j.end - 1);
    }
    if (found.length > 40) break;
  }
  return found.sort((a, b) => b.w * b.h - a.w * a.h);
}

async function orient(bitmap, o) {
  if (o !== 3 && o !== 6 && o !== 8) return bitmap;
  const swap = o !== 3;
  const w = swap ? bitmap.height : bitmap.width, h = swap ? bitmap.width : bitmap.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate(o === 3 ? Math.PI : o === 6 ? Math.PI / 2 : -Math.PI / 2);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close?.();
  return createImageBitmap(c);
}

async function decodeRaw(file) {
  const embedded = await decodeEmbedded(file).catch(() => null);
  if (embedded) return embedded;
  // No usable embedded preview: decode the RAW data itself right away.
  const lin = await decodeRawLinear(file);
  const c = document.createElement('canvas');
  c.width = lin.preview.w;
  c.height = lin.preview.h;
  c.getContext('2d').putImageData(new ImageData(lin.preview.data, lin.preview.w, lin.preview.h), 0, 0);
  return { bitmap: await createImageBitmap(c), kind: ext(file.name).toUpperCase(), raw: true, linear: lin };
}

async function decodeEmbedded(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  const o = tiffOrientation(u8);
  const list = findJpegs(u8);
  for (const j of list.slice(0, 4)) {
    try {
      const blob = file.slice(j.off, j.end, 'image/jpeg');
      let bitmap = await createImageBitmap(blob, { imageOrientation: o ? 'none' : 'from-image', premultiplyAlpha: 'none' });
      bitmap = await orient(bitmap, o);
      return { bitmap, kind: ext(file.name).toUpperCase(), raw: true, rawPreview: true };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`Couldn't find a usable preview inside ${file.name}.`);
}

// ------------------------------------------------------------------ LibRaw (WebAssembly)

let worker = null;
let seq = 0;
const waiting = new Map();
let queue = Promise.resolve();

function rawWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./raw-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = waiting.get(data.id);
    if (!p) return;
    waiting.delete(data.id);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    for (const p of waiting.values()) p.reject(new Error(e.message || 'RAW decoder failed to start'));
    waiting.clear();
    worker = null;
  };
  return worker;
}

// Full demosaic of a camera RAW with LibRaw. Resolves {w, h, data (RGBA half floats), gain, meta, preview}.
// Decodes run one at a time so memory stays bounded.
export function decodeRawLinear(file, { quality = 3, half = 0 } = {}) {
  const run = async () => {
    const buffer = await file.arrayBuffer();
    const w = rawWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, buffer, quality, half }, [buffer]);
    });
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export const isRaw = (name) => RAW_EXT.has(ext(name));

// Small CPU copy used for picking colors, auto tone and dehaze statistics.
export function sampleData(bitmap, long = 768) {
  const s = Math.min(1, long / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export function thumbnail(bitmap, h = 112) {
  const s = h / bitmap.height;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s));
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}
