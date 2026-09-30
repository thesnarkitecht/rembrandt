// The camera's built-in lens corrections, read straight from the RAW file: Fujifilm (RAF) and Sony
// (ARW) store per-shot vignetting, distortion and lateral chromatic aberration tables, which
// Lightroom applies automatically as the "built-in" profile. The engine turns them into a lookup
// for its LENS pass (see opticsLut in engine/src/pipeline.js).
//
// Ported from RAWmakase (src/lens/embedded.rs, src/tiff.rs), MIT licence, © RAWmakase contributors;
// see NOTICE.md.
//
// Result: { source, defaultOn, vignetting, distortion, chromatic: [red, blue] } where each is a
// radial function { knots, values } over the radius (0 = centre, 1 = half the diagonal), or null.

const MAX_READ = 1 << 20;

// A minimal, bounded TIFF directory reader over a File (only the bytes it's asked for are read).
class Tiff {
  static async open(file, base) {
    const t = new Tiff(file, base);
    const h = await t.bytes(0, 8);
    if (!h) return null;
    const m = String.fromCharCode(...h.slice(0, 4));
    if (['II*\0', 'IIRO', 'IIRS', 'IIU\0'].includes(m)) t.little = true;
    else if (m === 'MM\0*') t.little = false;
    else return null;
    t.first = t.u32(h, 4);
    return t;
  }
  constructor(file, base) { this.file = file; this.base = base; }
  u16(b, o = 0) { return new DataView(b.buffer, b.byteOffset + o, 2).getUint16(0, this.little); }
  u32(b, o = 0) { return new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, this.little); }
  async bytes(offset, len) {
    if (len > MAX_READ || offset < 0) return null;
    const start = this.base + offset;
    if (start + len > this.file.size) return null;
    return new Uint8Array(await this.file.slice(start, start + len).arrayBuffer());
  }
  async ifd(offset) {
    const c = await this.bytes(offset, 2);
    if (!c) return null;
    const n = this.u16(c);
    if (!n || n > 1000) return null;
    const b = await this.bytes(offset + 2, n * 12);
    if (!b) return null;
    const m = new Map();
    for (let i = 0; i < n; i++) m.set(this.u16(b, i * 12), { kind: this.u16(b, i * 12 + 2), count: this.u32(b, i * 12 + 4), value: b.slice(i * 12 + 8, i * 12 + 12) });
    return m;
  }
  offset(e) { return e && (e.kind === 4 || e.kind === 13) ? this.u32(e.value) : null; }
  async numbers(e) {
    if (!e) return null;
    const size = { 3: 2, 8: 2, 4: 4, 9: 4, 5: 8, 10: 8 }[e.kind];
    if (!size) return null;
    const len = e.count * size;
    const b = len <= 4 ? e.value.slice(0, len) : await this.bytes(this.u32(e.value), len);
    if (!b) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), L = this.little, out = [];
    for (let i = 0; i < e.count; i++) {
      const o = i * size;
      out.push(e.kind === 3 ? dv.getUint16(o, L) : e.kind === 8 ? dv.getInt16(o, L) : e.kind === 4 ? dv.getUint32(o, L) : e.kind === 9 ? dv.getInt32(o, L)
        : e.kind === 5 ? dv.getUint32(o, L) / dv.getUint32(o + 4, L) : dv.getInt32(o, L) / dv.getInt32(o + 4, L));
    }
    return out.every(Number.isFinite) ? out : null;
  }
}

function radial(knots, values) {
  const ok = knots.length >= 2 && knots.length === values.length && knots.length <= 64
    && [...knots, ...values].every(Number.isFinite) && knots.every((k, i) => i === 0 || knots[i - 1] < k)
    && knots[0] >= 0 && values.every((v) => v >= 0.2 && v <= 5);
  return ok ? { knots, values } : null;
}
const changes = (r, eps) => r && r.values.some((v) => Math.abs(v - 1) > eps) ? r : null;

// Lightroom renders Fujifilm's vignetting table about 15 % weaker in log gain (RAWmakase matched
// Camera Raw on X100F corners at this exponent).
const FUJI_VIGNETTE_STRENGTH = 0.85;

async function fuji(t) {
  const ifd0 = await t.ifd(t.first);
  const fi = ifd0 && await t.ifd(t.offset(ifd0.get(0xf000)));
  if (!fi) return null;
  // [scale, n knots, n values]
  const pairs = (v, f) => {
    if (!v) return null;
    const n = Math.floor((v.length - 1) / 2);
    return n >= 2 && v.length === 2 * n + 1 ? radial(v.slice(1, n + 1), v.slice(n + 1).map(f)) : null;
  };
  const vignetting = changes(pairs(await t.numbers(fi.get(0xf010)), (p) => (100 / p) ** FUJI_VIGNETTE_STRENGTH), 1e-4);
  const distortion = changes(pairs(await t.numbers(fi.get(0xf00b)), (p) => 1 + p / 100), 1e-6);
  // [scale, n knots, n red, n blue]
  let chromatic = null;
  const c = await t.numbers(fi.get(0xf00f));
  if (c) {
    const n = Math.floor((c.length - 1) / 3);
    if (n >= 2 && c.length === 3 * n + 1) {
      const knots = c.slice(1, n + 1);
      const red = radial(knots, c.slice(n + 1, 2 * n + 1).map((x) => 1 + x));
      const blue = radial(knots, c.slice(2 * n + 1).map((x) => 1 + x));
      if (red && blue && (changes(red, 1e-7) || changes(blue, 1e-7))) chromatic = [red, blue];
    }
  }
  return { source: 'Fujifilm built-in', defaultOn: true, vignetting, distortion, chromatic };
}

async function sony(t) {
  const ifd0 = await t.ifd(t.first);
  const sub = ifd0 && await t.ifd(t.offset(ifd0.get(0x14a)));
  if (!sub) return null;
  const knots = (n) => Array.from({ length: n }, (_, i) => i / (n - 1));
  const single = (v, f) => {
    if (!v) return null;
    const n = v[0] | 0;
    return n >= 2 && v.length === n + 1 ? radial(knots(n), v.slice(1).map(f)) : null;
  };
  const vignetting = changes(single(await t.numbers(sub.get(0x7032)), (v) => 2 ** (2 ** (v / 8192 - 1) - 0.5)), 1e-4);
  const distortion = changes(single(await t.numbers(sub.get(0x7037)), (d) => 1 + d / 16384), 1e-6);
  let chromatic = null;
  const c = await t.numbers(sub.get(0x7035));
  if (c) {
    const n = (c[0] | 0) / 2 | 0;
    if (n >= 2 && c.length === 2 * n + 1) {
      const scale = (s) => s.map((x) => 1 + x / 2097152);
      const red = radial(knots(n), scale(c.slice(1, n + 1)));
      const blue = radial(knots(n), scale(c.slice(n + 1)));
      if (red && blue) chromatic = [red, blue];
    }
  }
  // Not yet compared with Lightroom's rendering, so it starts switched off (as in RAWmakase).
  return { source: 'Sony built-in', defaultOn: false, vignetting, distortion, chromatic };
}

// The built-in correction in a RAW file, or null (other makes, JPEGs, or nothing stored).
export async function readLensProfile(file) {
  try {
    if (!file || file.size < 128) return null;
    const head = new Uint8Array(await file.slice(0, 108).arrayBuffer());
    const magic = String.fromCharCode(...head.slice(0, 15));
    let c = null;
    if (magic === 'FUJIFILMCCD-RAW') {
      const base = new DataView(head.buffer).getUint32(100, false);
      const t = await Tiff.open(file, base);
      c = t && await fuji(t);
    } else if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)) {
      const t = await Tiff.open(file, 0);
      c = t && await sony(t);
    }
    return c && (c.vignetting || c.distortion || c.chromatic) ? c : null;
  } catch {
    return null;
  }
}
