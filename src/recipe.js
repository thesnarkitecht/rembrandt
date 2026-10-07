// "How was this edited?": an exported photo can carry its recipe, the edit settings that made it,
// inside the file's XMP metadata (JPEG, PNG and WebP). Anyone can read the plain-language summary in
// any metadata viewer, and Rembrandt can put the same look on another photo from the file alone.
//
// The recipe is the look only: no crop, no masks, no spot removal, nothing tied to one photo's
// pixels. It is written in our own namespace, never as crs: settings, so Lightroom does not re-apply
// it to the exported pixels.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { BRAND } from './brand.js';
import { developSettings, defaultParams, HSL_NAMES } from './params.js';
import { embeddedXmp } from './xmp.js';

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const pack = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unpack = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));

// The shareable part of an edit.
export function recipeOf(params) {
  const s = developSettings(params);
  delete s.retouch;
  if (s.ai) delete s.ai.bg;
  return s;
}

// ------------------------------------------------------------------ summary

const NAMES = {
  exposure: 'Exposure', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows', whites: 'Whites', blacks: 'Blacks',
  temp: 'Temperature', tint: 'Tint', vibrance: 'Vibrance', saturation: 'Saturation',
  texture: 'Texture', clarity: 'Clarity', dehaze: 'Dehaze', haze: 'Haze',
};
const AI_NAMES = {
  refocus: 'AI Refocus', blur: 'Lens blur', enhance: 'Enhance', relight: 'Relight', sky: 'Sky', atmos: 'Atmosphere',
  rays: 'Light rays', skin: 'Skin smoothing', motion: 'Motion blur',
};
const sign = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(+v.toFixed(d));
const isIdent = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;

// Plain-language lines, one per change: ["Exposure +0.4", "Contrast +12", "Black & white", …].
export function describe(s) {
  const d = defaultParams();
  const out = [];
  for (const [k, name] of Object.entries(NAMES)) {
    const v = s[k] ?? 0;
    if (Math.abs(v - d[k]) > 1e-6) out.push(`${name} ${sign(v, k === 'exposure' ? 2 : 0)}${k === 'exposure' ? ' EV' : ''}`);
  }
  if (s.bw) out.push('Black & white');
  if (s.curve && !['master', 'r', 'g', 'b'].every((c) => isIdent(s.curve[c] || [[0, 0], [1, 1]]))) out.push('Tone curve');
  if (s.hsl) {
    const parts = [];
    HSL_NAMES.forEach((n, i) => {
      const bits = [['hue', 'hue'], ['sat', 'saturation'], ['lum', 'luminance']].filter(([k]) => s.hsl[k]?.[i]).map(([k, w]) => `${w} ${sign(s.hsl[k][i])}`);
      if (bits.length) parts.push(`${n} ${bits.join(', ')}`);
    });
    if (parts.length) out.push(`Colour mixer: ${parts.join('; ')}`);
  }
  const g = s.grading;
  if (g) {
    const zones = ['shadows', 'midtones', 'highlights', 'global'].filter((z) => g[z]?.s || g[z]?.l).map((z) => `${z} ${Math.round(g[z].h)}° ${Math.round(g[z].s)}%`);
    if (zones.length) out.push(`Colour grading: ${zones.join(', ')}`);
  }
  if (s.vignette?.amount) out.push(`Vignette ${sign(s.vignette.amount)}`);
  if (s.grain?.amount) out.push(`Grain ${Math.round(s.grain.amount)}`);
  if (s.sharpen?.amount) out.push(`Sharpening ${Math.round(s.sharpen.amount)}`);
  if (s.nr?.luma || s.nr?.chroma) out.push(`Noise reduction ${Math.round(s.nr.luma || 0)} / colour ${Math.round(s.nr.chroma || 0)}`);
  if (s.ai) for (const [k, name] of Object.entries(AI_NAMES)) {
    const a = s.ai[k];
    const amt = a && (a.amount ?? Math.max(Math.abs(a.near || 0), Math.abs(a.far || 0), Math.abs(a.deepen || 0)));
    if (amt) out.push(`${name} ${Math.round(amt)}`);
  }
  return out;
}

// ------------------------------------------------------------------ writing

export function recipeXmp(settings) {
  const lines = describe(settings);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${esc(BRAND.name)}">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pe="${BRAND.xmpNs}"
   xmp:CreatorTool="${esc(BRAND.name)}"
   pe:RecipeText="${esc(lines.length ? lines.join('. ') + '.' : 'No changes.')}"
   pe:Recipe="${pack(settings)}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const utf8 = (s) => new TextEncoder().encode(s);
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function jpegWithXmp(b, xmp) {
  const body = concat([latin1(XMP_ID), utf8(xmp)]);
  if (body.length + 2 > 0xffff) return null;
  const seg = new Uint8Array(4 + body.length);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = (body.length + 2) >> 8; seg[3] = (body.length + 2) & 0xff;
  seg.set(body, 4);
  // After SOI and a JFIF APP0, where readers expect it.
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);
  return concat([b.subarray(0, at), seg, b.subarray(at)]);
}

function pngWithXmp(b, xmp) {
  const data = concat([latin1('XML:com.adobe.xmp'), new Uint8Array(5), utf8(xmp)]); // keyword, \0, no compression, lang \0, key \0
  const type = latin1('iTXt');
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(concat([type, data])));
  const at = 8 + 12 + new DataView(b.buffer, b.byteOffset).getUint32(8); // after IHDR
  return concat([b.subarray(0, at), chunk, b.subarray(at)]);
}

function webpWithXmp(b, xmp, w, h) {
  const first = String.fromCharCode(...b.subarray(12, 16));
  let chunks = b.subarray(12);
  const xmpData = utf8(xmp);
  const pad = xmpData.length & 1;
  const xmpChunk = new Uint8Array(8 + xmpData.length + pad);
  xmpChunk.set(latin1('XMP '));
  new DataView(xmpChunk.buffer).setUint32(4, xmpData.length, true);
  xmpChunk.set(xmpData, 8);
  if (first === 'VP8X') {
    chunks = chunks.slice();
    chunks[8] |= 0x04;
  } else {
    const x = new Uint8Array(18);
    x.set(latin1('VP8X'));
    const xv = new DataView(x.buffer);
    xv.setUint32(4, 10, true);
    x[8] = 0x04 | (first === 'VP8L' && (b[12 + 8 + 4] & 0x10) ? 0x10 : 0);
    xv.setUint16(12, (w - 1) & 0xffff, true); x[14] = ((w - 1) >> 16) & 0xff;
    xv.setUint16(15, (h - 1) & 0xffff, true); x[17] = ((h - 1) >> 16) & 0xff;
    chunks = concat([x, chunks]);
  }
  const out = concat([latin1('RIFF'), new Uint8Array(4), latin1('WEBP'), chunks, xmpChunk]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// The exported file with the recipe in it (or unchanged if the format can't take it).
export async function withRecipe(blob, settings, w, h) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const xmp = recipeXmp(settings);
  let out = null;
  try {
    if (blob.type === 'image/jpeg') out = jpegWithXmp(b, xmp);
    else if (blob.type === 'image/png') out = pngWithXmp(b, xmp);
    else if (blob.type === 'image/webp') out = webpWithXmp(b, xmp, w, h);
  } catch (err) { console.warn('recipe', err); }
  return out ? new Blob([out], { type: blob.type }) : blob;
}

// ------------------------------------------------------------------ reading

// The recipe in a photo file: { settings, text } or null.
export async function readRecipe(file) {
  const xmp = await embeddedXmp(file).catch(() => null);
  const m = xmp && /Recipe="([A-Za-z0-9+/=]+)"/.exec(xmp);
  if (!m) return null;
  try {
    const settings = unpack(m[1]);
    return { settings, text: describe(settings) };
  } catch { return null; }
}
