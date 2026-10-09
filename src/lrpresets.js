// Lightroom presets: imports .xmp presets (Lightroom Classic 7.3+, Lightroom, Camera Raw), older
// .lrtemplate presets (Lightroom Classic up to 7.2), and .zip packs of either.
//
// Like in Lightroom, an imported preset changes only the settings it contains; everything else on
// the photo stays as it is. Settings Rembrandt can't reproduce (camera profiles, masks, …) are left
// out and listed in the import report.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { parseXmp, crsToParams, untranslated } from './xmp.js';

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What `full` changes compared with `base`, as a nested partial object (whole arrays when they differ).
function diff(full, base) {
  const out = {};
  for (const k of Object.keys(full)) {
    if (k === 'geometry' || k === 'masks' || k === 'retouch' || k === 'v' || k === 'off') continue;
    if (isPlain(full[k]) && isPlain(base[k])) { const d = diff(full[k], base[k]); if (Object.keys(d).length) out[k] = d; }
    else if (!same(full[k], base[k])) out[k] = full[k];
  }
  return out;
}

// Our settings for a crs: block: only what differs from an empty preset, so other settings stay.
function settingsOf(crs) {
  const s = diff(crsToParams(crs), crsToParams({}));
  // A preset that sets white balance absolutely or "As Shot" still names it; keep explicit zeros
  // for the keys it lists, so applying it resets them as Lightroom does.
  const keep = { Exposure2012: 'exposure', Contrast2012: 'contrast', Highlights2012: 'highlights', Shadows2012: 'shadows', Whites2012: 'whites', Blacks2012: 'blacks', Vibrance: 'vibrance', Saturation: 'saturation', Texture: 'texture', Clarity2012: 'clarity', Dehaze: 'dehaze', IncrementalTemperature: 'temp', IncrementalTint: 'tint' };
  for (const [k, ours] of Object.entries(keep)) if (k in crs && !(ours in s)) s[ours] = 0;
  return s;
}

const text = (v) => (Array.isArray(v) ? v[0] : v) || '';

// One .xmp preset → { name, group, settings, missing } or null.
export function presetFromXmp(xml, fileName = '') {
  const x = parseXmp(xml);
  if (!x || !Object.keys(x.crs).length) return null;
  const crs = x.crs;
  // Profiles-only presets (crs:PresetType="Look" with nothing else) still import: they just do little.
  const name = text(crs.Name) || fileName.replace(/\.xmp$/i, '');
  const group = text(crs.Group) || '';
  return { name, group, settings: settingsOf(crs), missing: untranslated(crs) };
}

// Lua-ish .lrtemplate → crs object.
export function crsFromLrtemplate(src) {
  const at = src.search(/settings\s*=\s*\{/);
  if (at < 0) return null;
  let i = src.indexOf('{', at) + 1, depth = 1;
  const start = i;
  for (; i < src.length && depth; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; else if (src[i] === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } } }
  const body = src.slice(start, i - 1);
  const crs = {};
  // Top-level `Key = value,` pairs; nested tables (tone curves) become arrays of "x, y" pairs.
  const re = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|\{[^{}]*\}|[^,\n]+)/g;
  let m, d = 0, last = 0;
  while ((m = re.exec(body))) {
    for (let j = last; j < m.index; j++) { if (body[j] === '{') d++; else if (body[j] === '}') d--; }
    last = m.index;
    if (d !== 0) continue;
    const [, k, raw] = m;
    let v = raw.trim().replace(/,$/, '');
    if (v.startsWith('{')) {
      const nums = v.slice(1, -1).split(',').map((t) => parseFloat(t)).filter(Number.isFinite);
      const pts = [];
      for (let j = 0; j + 1 < nums.length; j += 2) pts.push(`${nums[j]}, ${nums[j + 1]}`);
      crs[k] = pts;
    } else if (v.startsWith('"')) crs[k] = v.slice(1, -1).replace(/\\"/g, '"');
    else crs[k] = v === 'true' ? 'True' : v === 'false' ? 'False' : v;
  }
  return crs;
}

export function presetFromLrtemplate(src, fileName = '') {
  const crs = crsFromLrtemplate(src);
  if (!crs || !Object.keys(crs).length) return null;
  const t = /title\s*=\s*(?:ZSTR\s*)?"([^"]*)"/.exec(src);
  const name = (t ? t[1].replace(/^\$\$\$\/[^=]*=/, '') : '') || fileName.replace(/\.lrtemplate$/i, '');
  return { name, group: '', settings: settingsOf(crs), missing: untranslated(crs) };
}

// ------------------------------------------------------------------ zip packs

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Files in a zip: [{ name, data }]. Stored and deflated entries (what preset packs use).
export async function unzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < n && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const lstart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = b.subarray(lstart, lstart + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
  }
  return out;
}

// Every preset in the chosen files (and in zips among them). Returns { presets, skipped, missing }.
export async function importPresetFiles(files) {
  const presets = [], missing = new Map();
  let skipped = 0;
  const take = (p) => { if (!p) { skipped++; return; } presets.push(p); for (const m of p.missing) missing.set(m, (missing.get(m) || 0) + 1); };
  const one = (name, textOf) => {
    if (/\.xmp$/i.test(name)) take(presetFromXmp(textOf(), name.split('/').pop()));
    else if (/\.lrtemplate$/i.test(name)) take(presetFromLrtemplate(textOf(), name.split('/').pop()));
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      for (const e of await unzip(await f.arrayBuffer())) one(e.name, () => new TextDecoder().decode(e.data));
    } else {
      const t = await f.text();
      one(f.name, () => t);
    }
  }
  return { presets, skipped, missing: [...missing] };
}
