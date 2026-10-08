// Photo metadata in and out.
//
// Reading: the EXIF block of JPEG (and TIFF-based) files, for the camera, lens, exposure and the time
// the photo was taken (RAW files get the same from LibRaw).
// Writing: exported JPEG, PNG and WebP files carry that metadata again, plus the photographer's name
// and copyright from Settings, and an sRGB colour profile so colour-managed apps show them as
// intended. Location (GPS) is never written.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// ------------------------------------------------------------------ reading

// { make, model, lens, iso, shutter (s), aperture, focal, timestamp (s) } or null.
export async function readExif(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    let tiff = null;
    if (head[0] === 0xff && head[1] === 0xd8) {
      for (let p = 2; p + 4 < head.length;) {
        if (head[p] !== 0xff) break;
        const m = head[p + 1], len = (head[p + 2] << 8) | head[p + 3];
        if (m === 0xe1 && String.fromCharCode(...head.subarray(p + 4, p + 10)) === 'Exif\0\0') { tiff = head.subarray(p + 10, p + 2 + len); break; }
        if (m === 0xda) break;
        p += 2 + len;
      }
    } else if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) tiff = head;
    return tiff ? parseTiff(tiff) : null;
  } catch { return null; }
}

function parseTiff(b) {
  const le = b[0] === 0x49, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
  const ifd = (off) => {
    const out = new Map();
    if (!off || off + 2 > b.length) return out;
    const n = u16(off);
    for (let i = 0; i < n && i < 400; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4), size = (SIZE[type] || 1) * count;
      const at = size > 4 ? u32(e + 8) : e + 8;
      if (at + size > b.length) continue;
      let v;
      if (type === 2) v = new TextDecoder().decode(b.subarray(at, at + count)).replace(/\0.*$/s, '').trim();
      else if (type === 3) v = u16(at);
      else if (type === 4) v = u32(at);
      else if (type === 5) v = u32(at) / (u32(at + 4) || 1);
      else if (type === 10) v = dv.getInt32(at, le) / (dv.getInt32(at + 4, le) || 1);
      else if (type === 11) v = dv.getFloat32(at, le);
      else if (type === 12) v = dv.getFloat64(at, le);
      out.set(tag, v);
    }
    return out;
  };
  const i0 = ifd(u32(4)), ex = ifd(i0.get(0x8769));
  const date = ex.get(0x9003) || i0.get(0x0132);
  let timestamp = 0;
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(date || '');
  if (m) timestamp = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000;
  const meta = {
    make: i0.get(0x010f) || '', model: i0.get(0x0110) || '', lens: ex.get(0xa434) || '',
    iso: ex.get(0x8827) || 0, shutter: ex.get(0x829a) || 0, aperture: ex.get(0x829d) || 0, focal: ex.get(0x920a) || 0, timestamp,
  };
  return meta.make || meta.model || meta.timestamp ? meta : null;
}

// ------------------------------------------------------------------ writing EXIF

// EXIF text is ASCII: © becomes (c), other characters ?.
const ascii = (s) => [...String(s).replace(/©/g, '(c)')].map((c) => { const k = c.charCodeAt(0); return k < 128 ? k : 63; }).concat(0);
const rational = (v, den = 10000) => {
  if (v > 0 && v < 1) { const d = Math.round(1 / v); if (Math.abs(1 / d - v) < v * 0.01) return [1, d]; }
  return [Math.round(v * den), den];
};
const exifDate = (t) => {
  const d = new Date(t * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// A little-endian TIFF block: IFD0 (+ Exif IFD) from the photo's metadata and the photographer.
export function exifTiff(meta = {}, { artist = '', copyright = '', software = 'Rembrandt' } = {}) {
  const T = { ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
  const i0 = [];
  if (meta.make) i0.push([0x010f, T.ASCII, ascii(meta.make)]);
  if (meta.model) i0.push([0x0110, T.ASCII, ascii(meta.model)]);
  i0.push([0x0112, T.SHORT, [1]]);   // exported pixels are already upright
  i0.push([0x0131, T.ASCII, ascii(software)]);
  i0.push([0x0132, T.ASCII, ascii(exifDate(Date.now() / 1000))]);
  if (artist) i0.push([0x013b, T.ASCII, ascii(artist)]);
  if (copyright) i0.push([0x8298, T.ASCII, ascii(copyright)]);
  const ex = [];
  if (meta.shutter > 0) ex.push([0x829a, T.RATIONAL, rational(meta.shutter, 1e6)]);
  if (meta.aperture > 0) ex.push([0x829d, T.RATIONAL, rational(meta.aperture, 10)]);
  if (meta.iso > 0) ex.push([0x8827, T.SHORT, [Math.min(65535, Math.round(meta.iso))]]);
  if (meta.timestamp > 0) ex.push([0x9003, T.ASCII, ascii(exifDate(meta.timestamp))]);
  if (meta.focal > 0) ex.push([0x920a, T.RATIONAL, rational(meta.focal, 10)]);
  if (meta.lens) ex.push([0xa434, T.ASCII, ascii(meta.lens)]);
  if (ex.length) i0.push([0x8769, T.LONG, [0]]);
  i0.sort((a, b) => a[0] - b[0]);
  const SZ = { 2: 1, 3: 2, 4: 4, 5: 8 };
  const count = (t, v) => (t === T.RATIONAL ? v.length / 2 : v.length);
  const extra = (list) => list.reduce((s, [, t, v]) => { const n = count(t, v) * SZ[t]; return s + (n > 4 ? n + (n & 1) : 0); }, 0);
  const size = (list) => 2 + 12 * list.length + 4;
  const exOff = 8 + size(i0) + extra(i0);
  if (ex.length) i0.find((e) => e[0] === 0x8769)[2] = [exOff];
  const total = exOff + (ex.length ? size(ex) + extra(ex) : 0);
  const buf = new Uint8Array(total), dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
  const write = (list, at) => {
    let over = at + size(list);
    dv.setUint16(at, list.length, true);
    list.forEach(([tag, type, vals], k) => {
      const e = at + 2 + 12 * k, n = count(type, vals), bytes = n * SZ[type];
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, n, true);
      let p = e + 8;
      if (bytes > 4) { dv.setUint32(e + 8, over, true); p = over; over += bytes + (bytes & 1); }
      vals.forEach((v, j) => {
        if (type === T.ASCII) dv.setUint8(p + j, v);
        else if (type === T.SHORT) dv.setUint16(p + 2 * j, v, true);
        else dv.setUint32(p + 4 * j, v, true);
      });
    });
    dv.setUint32(at + size(list) - 4, 0, true);
  };
  write(i0, 8);
  if (ex.length) write(ex, exOff);
  return buf;
}

// ------------------------------------------------------------------ the sRGB profile

let icc = null;
// A compact ICC v4 sRGB display profile: D50-adapted primaries, the exact sRGB tone curve as a
// parametric curve, and the D65 → D50 adaptation matrix.
export function srgbProfile() {
  if (icc) return icc;
  const s15 = (v) => Math.round(v * 65536) | 0;
  const tags = [];
  const mluc = (text) => {
    const u = [...text].flatMap((c) => [0, c.charCodeAt(0)]);
    const b = [...'mluc'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], be32(1), be32(12), [101, 110, 85, 83], be32(u.length), be32(28), u);
    return b;
  };
  const xyz = (x, y, z) => [...'XYZ '].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], be32(s15(x)), be32(s15(y)), be32(s15(z)));
  const para = [...'para'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [0, 3, 0, 0],
    be32(s15(2.4)), be32(s15(1 / 1.055)), be32(s15(0.055 / 1.055)), be32(s15(1 / 12.92)), be32(s15(0.04045)));
  const sf32 = (vals) => [...'sf32'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], ...vals.map((v) => be32(s15(v))));
  tags.push(['desc', mluc('sRGB (Rembrandt)')]);
  tags.push(['cprt', mluc('No copyright, use freely')]);
  tags.push(['wtpt', xyz(0.9642, 1.0, 0.8249)]);
  tags.push(['chad', sf32([1.0478, 0.0229, -0.0502, 0.0295, 0.9905, -0.0171, -0.0092, 0.0151, 0.7517])]);
  tags.push(['rXYZ', xyz(0.4361, 0.2225, 0.0139)]);
  tags.push(['gXYZ', xyz(0.3851, 0.7169, 0.0971)]);
  tags.push(['bXYZ', xyz(0.1431, 0.0606, 0.7139)]);
  tags.push(['rTRC', para]);
  // g and b share the r curve's data (allowed: same offset).
  const table = [];
  let off = 128 + 4 + 12 * (tags.length + 2);
  const data = [];
  for (const [sig, bytes] of tags) {
    while (off % 4) { data.push(0); off++; }
    table.push([sig, off, bytes.length]);
    if (sig === 'rTRC') { table.push(['gTRC', off, bytes.length]); table.push(['bTRC', off, bytes.length]); }
    data.push(...bytes); off += bytes.length;
  }
  while (off % 4) { data.push(0); off++; }
  const head = new Array(128).fill(0);
  const put = (at, arr) => arr.forEach((v, i) => { head[at + i] = v; });
  put(0, be32(off)); put(8, [4, 0x30, 0, 0]);
  put(12, [...'mntrRGB XYZ '].map((c) => c.charCodeAt(0)));
  put(24, [0x07, 0xea, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]);   // 2026-01-01
  put(36, [...'acsp'].map((c) => c.charCodeAt(0)));
  put(68, [...be32(s15(0.9642)), ...be32(s15(1.0)), ...be32(s15(0.8249))]);   // PCS illuminant D50
  const tt = [...be32(table.length), ...table.flatMap(([sig, o, n]) => [...[...sig].map((c) => c.charCodeAt(0)), ...be32(o), ...be32(n)])];
  icc = new Uint8Array([...head, ...tt, ...data]);
  return icc;
}
function be32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

// ------------------------------------------------------------------ embedding

const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function jpegWith(b, tiff, profile) {
  const seg = (marker, body) => { const s = new Uint8Array(4 + body.length); s[0] = 0xff; s[1] = marker; s[2] = (body.length + 2) >> 8; s[3] = (body.length + 2) & 255; s.set(body, 4); return s; };
  const parts = [];
  if (tiff) parts.push(seg(0xe1, concat([latin1('Exif\0\0'), tiff])));
  // Some encoders (Chrome's) already embed an sRGB profile: never add a second one.
  const hasIcc = (() => { for (let p = 2; p + 4 < b.length && b[p] === 0xff && b[p + 1] !== 0xda;) { if (b[p + 1] === 0xe2 && String.fromCharCode(...b.subarray(p + 4, p + 15)) === 'ICC_PROFILE') return true; p += 2 + ((b[p + 2] << 8) | b[p + 3]); } return false; })();
  if (profile && !hasIcc && profile.length + 16 < 65533) parts.push(seg(0xe2, concat([latin1('ICC_PROFILE\0'), new Uint8Array([1, 1]), profile])));
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);
  return concat([b.subarray(0, at), ...parts, b.subarray(at)]);
}

async function pngWith(b, tiff, profile) {
  const chunk = (type, data) => { const t = latin1(type), c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer); dv.setUint32(0, data.length); c.set(t, 4); c.set(data, 8); dv.setUint32(8 + data.length, crc32(concat([t, data]))); return c; };
  const parts = [];
  if (profile) parts.push(chunk('iCCP', concat([latin1('sRGB\0'), new Uint8Array([0]), await deflate(profile)])));
  if (tiff) parts.push(chunk('eXIf', tiff));
  const at = 8 + 12 + new DataView(b.buffer, b.byteOffset).getUint32(8);   // after IHDR
  return concat([b.subarray(0, at), ...parts, b.subarray(at)]);
}

function webpWith(b, tiff, profile, w, h) {
  const chunk = (fourcc, data) => { const c = new Uint8Array(8 + data.length + (data.length & 1)); c.set(latin1(fourcc)); new DataView(c.buffer).setUint32(4, data.length, true); c.set(data, 8); return c; };
  const first = String.fromCharCode(...b.subarray(12, 16));
  let vp8x, rest;
  if (first === 'VP8X') { vp8x = b.slice(12, 30); rest = b.subarray(30); }
  else {
    vp8x = new Uint8Array(18); vp8x.set(latin1('VP8X')); const xv = new DataView(vp8x.buffer); xv.setUint32(4, 10, true);
    if (first === 'VP8L' && (b[24] & 0x10)) vp8x[8] |= 0x10;
    xv.setUint16(12, (w - 1) & 0xffff, true); vp8x[14] = ((w - 1) >> 16) & 0xff;
    xv.setUint16(15, (h - 1) & 0xffff, true); vp8x[17] = ((h - 1) >> 16) & 0xff;
    rest = b.subarray(12);
  }
  if (profile) vp8x[8] |= 0x20;
  if (tiff) vp8x[8] |= 0x08;
  const out = concat([latin1('RIFF'), new Uint8Array(4), latin1('WEBP'), vp8x, profile ? chunk('ICCP', profile) : new Uint8Array(0), rest, tiff ? chunk('EXIF', tiff) : new Uint8Array(0)]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// The exported file with its metadata and colour profile (or unchanged if anything goes wrong).
export async function withMetadata(blob, { meta, artist, copyright, w, h, exif = true, profile = true } = {}) {
  try {
    const b = new Uint8Array(await blob.arrayBuffer());
    const tiff = exif ? exifTiff(meta || {}, { artist, copyright }) : null;
    const p = profile ? srgbProfile() : null;
    let out = null;
    if (blob.type === 'image/jpeg') out = jpegWith(b, tiff, p);
    else if (blob.type === 'image/png') out = await pngWith(b, tiff, p);
    else if (blob.type === 'image/webp') out = webpWith(b, tiff, p, w, h);
    return out ? new Blob([out], { type: blob.type }) : blob;
  } catch (err) {
    console.warn('metadata', err);
    return blob;
  }
}
