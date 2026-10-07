// Adobe XMP interchange: reads Lightroom / Camera Raw develop settings (crs:*) into our edit
// settings, and writes XMP sidecars Lightroom can read. Our full settings (masks, AI) ride along in
// our own namespace; a digest of the crs values tells us whether another app changed them since.
import { clamp, deepMerge } from './util.js';
import { defaultParams, defaultGeometry } from './params.js';
import { fitCrop } from './geometry.js';
import { BRAND } from './brand.js';

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  pe: BRAND.xmpNs,
};
// Colour labels, as Lightroom writes them in xmp:Label.
export const LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];
const labelName = (v) => { const k = String(v || '').trim().toLowerCase(); return LABELS.includes(k) ? k : ''; };

const LR_HSL = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const WB_REF = 5500; // Kelvin assumed for "as shot" when converting absolute white balance

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const bool = (v) => v === true || String(v).toLowerCase() === 'true';
const has = (o, k) => o[k] !== undefined && o[k] !== null && o[k] !== '';

// ------------------------------------------------------------------ reading

// Parses an XMP packet. Returns { crs, rating, label, ours } or null when it holds nothing useful.
export function parseXmp(text) {
  if (!text || !/<x:xmpmeta|<rdf:RDF/.test(text)) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(text.slice(text.search(/<x:xmpmeta|<rdf:RDF/)), 'application/xml'); } catch { return null; }
  if (doc.getElementsByTagName('parsererror').length) return null;
  const crs = {};
  const other = {};
  for (const d of doc.getElementsByTagNameNS(NS.rdf, 'Description')) {
    for (const a of d.attributes) {
      if (a.namespaceURI === NS.crs) crs[a.localName] = a.value;
      else if (a.namespaceURI === NS.xmp || a.namespaceURI === NS.pe) other[a.namespaceURI + a.localName] = a.value;
    }
    for (const c of d.children) {
      const target = c.namespaceURI === NS.crs ? crs : c.namespaceURI === NS.xmp || c.namespaceURI === NS.pe || c.namespaceURI === NS.dc ? other : null;
      if (!target) continue;
      const key = c.namespaceURI === NS.crs ? c.localName : c.namespaceURI + c.localName;
      const items = c.getElementsByTagNameNS(NS.rdf, 'li');
      target[key] = items.length ? [...items].map((li) => li.textContent.trim()) : c.textContent.trim();
    }
  }
  let ours = null;
  const packed = other[NS.pe + 'Params'];
  if (packed) {
    try { ours = JSON.parse(decodeURIComponent(escape(atob(packed)))); } catch { ours = null; }
  }
  const rating = has(other, NS.xmp + 'Rating') ? Math.round(num(other[NS.xmp + 'Rating'])) : null;
  const label = labelName(other[NS.xmp + 'Label']) || null;
  const subj = other[NS.dc + 'subject'];
  const keywords = Array.isArray(subj) ? subj.filter(Boolean) : subj ? [subj] : [];
  const out = { crs, rating, label, keywords, ours, digest: other[NS.pe + 'Digest'] || null, flag: has(other, NS.pe + 'Flag') ? Math.round(num(other[NS.pe + 'Flag'])) : null };
  if (!Object.keys(crs).length && rating === null && !ours && !label && !keywords.length) return null;
  return out;
}

// True when the crs block holds actual develop settings (not just camera profile defaults).
export const hasDevelop = (crs) => !!crs && ['Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Temperature', 'IncrementalTemperature', 'HasCrop', 'ToneCurvePV2012', 'ConvertToGrayscale', 'Clarity2012', 'Vibrance'].some((k) => has(crs, k));

// Tone curves come as ["x, y", …] in XMP or as a flat [x, y, x, y, …] list from a catalog.
function curvePoints(v) {
  if (!v) return null;
  let flat = [];
  if (Array.isArray(v)) for (const s of v) flat.push(...String(s).split(',').map((x) => num(x)));
  else flat = String(v).split(/[,\s]+/).filter(Boolean).map((x) => num(x));
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([clamp(flat[i] / 255, 0, 1), clamp(flat[i + 1] / 255, 0, 1)]);
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}
const isIdentityCurve = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1);

// Maps Lightroom / Camera Raw develop settings to our edit settings for an image of the given aspect.
export function crsToParams(crs, aspect = 1.5) {
  const p = defaultParams(aspect);
  const n = (k, d = 0) => (has(crs, k) ? num(crs[k], d) : d);
  const s100 = (k) => clamp(Math.round(n(k)), -100, 100);

  p.exposure = clamp(n('Exposure2012', n('Exposure')), -5, 5);
  p.contrast = s100(has(crs, 'Contrast2012') ? 'Contrast2012' : 'Contrast');
  p.highlights = s100('Highlights2012');
  p.shadows = s100('Shadows2012');
  p.whites = s100('Whites2012');
  p.blacks = s100('Blacks2012');

  // White balance: our sliders are relative to the camera's white balance.
  if (has(crs, 'IncrementalTemperature') || has(crs, 'IncrementalTint')) {
    p.temp = s100('IncrementalTemperature');
    p.tint = s100('IncrementalTint');
  } else if (has(crs, 'Temperature') && !/as shot|auto/i.test(crs.WhiteBalance || 'As Shot')) {
    p.temp = clamp(Math.round((100 * Math.log2(n('Temperature', WB_REF) / WB_REF)) / 1.2), -100, 100);
    p.tint = clamp(Math.round((n('Tint') * 100) / 150), -100, 100);
  }
  p.vibrance = s100('Vibrance');
  p.saturation = s100('Saturation');
  p.bw = bool(crs.ConvertToGrayscale);

  p.texture = s100('Texture');
  p.clarity = s100(has(crs, 'Clarity2012') ? 'Clarity2012' : 'Clarity');
  p.dehaze = s100('Dehaze');

  p.vignette = {
    amount: s100('PostCropVignetteAmount'),
    midpoint: clamp(n('PostCropVignetteMidpoint', 50), 0, 100),
    roundness: s100('PostCropVignetteRoundness'),
    feather: clamp(n('PostCropVignetteFeather', 50), 0, 100),
  };
  p.grain = {
    amount: clamp(n('GrainAmount'), 0, 100),
    size: clamp(n('GrainSize', 25), 0, 100),
    roughness: clamp(n('GrainFrequency', 50), 0, 100),
  };

  const master = curvePoints(crs.ToneCurvePV2012);
  if (!isIdentityCurve(master)) p.curve.master = master;
  for (const [ch, k] of [['r', 'ToneCurvePV2012Red'], ['g', 'ToneCurvePV2012Green'], ['b', 'ToneCurvePV2012Blue']]) {
    const c = curvePoints(crs[k]);
    if (!isIdentityCurve(c)) p.curve[ch] = c;
  }

  LR_HSL.forEach((name, i) => {
    p.hsl.hue[i] = s100(`HueAdjustment${name}`);
    p.hsl.sat[i] = s100(`SaturationAdjustment${name}`);
    p.hsl.lum[i] = s100(`LuminanceAdjustment${name}`);
  });

  const g = p.grading;
  g.shadows = { h: n('SplitToningShadowHue', g.shadows.h), s: n('SplitToningShadowSaturation'), l: s100('ColorGradeShadowLum') };
  g.highlights = { h: n('SplitToningHighlightHue', g.highlights.h), s: n('SplitToningHighlightSaturation'), l: s100('ColorGradeHighlightLum') };
  g.midtones = { h: n('ColorGradeMidtoneHue', g.midtones.h), s: n('ColorGradeMidtoneSat'), l: s100('ColorGradeMidtoneLum') };
  g.global = { h: n('ColorGradeGlobalHue', g.global.h), s: n('ColorGradeGlobalSat'), l: s100('ColorGradeGlobalLum') };
  g.blending = clamp(n('ColorGradeBlending', 50), 0, 100);
  g.balance = s100('SplitToningBalance');

  p.sharpen = { amount: clamp(n('Sharpness'), 0, 150), radius: clamp(n('SharpenRadius', 1), 0.5, 3), masking: clamp(n('SharpenEdgeMasking'), 0, 100) };
  p.nr = { luma: clamp(n('LuminanceSmoothing'), 0, 100), chroma: clamp(n('ColorNoiseReduction'), 0, 100) };

  if (bool(crs.HasCrop)) {
    const L = n('CropLeft'), T = n('CropTop'), R = n('CropRight', 1), B = n('CropBottom', 1);
    const angle = clamp(n('CropAngle'), -45, 45);
    const t = (angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const rot = (x, y) => [c * x - s * y, s * x + c * y]; // P -> Q (see geometry.js)
    const [cx, cy] = rot(((L + R) / 2 - 0.5) * aspect, (T + B) / 2 - 0.5);
    const [dx, dy] = rot((R - L) * aspect, B - T);
    const geo = defaultGeometry(aspect);
    geo.angle = angle;
    geo.aspect = 'free';
    geo.cropAuto = false;
    geo.crop = fitCrop({ cx, cy, w: Math.abs(dx), h: Math.abs(dy) }, aspect, geo);
    p.geometry = geo;
  }
  return p;
}

// Lightroom settings in use that Rembrandt doesn't bring over, by name (for the import report).
const UNTRANSLATED = [
  ['Masks and local adjustments', (c) => ['MaskGroupBasedCorrections', 'PaintBasedCorrections', 'GradientBasedCorrections', 'CircularGradientBasedCorrections'].some((k) => Array.isArray(c[k]) ? c[k].length : c[k] && typeof c[k] === 'object' && Object.keys(c[k]).length)],
  ['Spot removal', (c) => Array.isArray(c.RetouchAreas) ? c.RetouchAreas.length : !!(c.RetouchAreas && Object.keys(c.RetouchAreas).length) || !!c.RetouchInfo],
  ['Upright and Transform', (c) => (c.PerspectiveUpright && c.PerspectiveUpright !== 0) || ['PerspectiveVertical', 'PerspectiveHorizontal', 'PerspectiveRotate', 'PerspectiveScale', 'PerspectiveAspect'].some((k) => num(c[k]))],
  ['Profiles and creative looks', (c) => !!(c.Look && (c.Look.Name || c.Look.name)) || (c.CameraProfile && !/^Adobe (Standard|Color)$/i.test(c.CameraProfile))],
  ['Calibration', (c) => ['RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation', 'ShadowTint'].some((k) => num(c[k]))],
  ['Lens profile corrections', (c) => num(c.LensProfileEnable) === 1],
  ['Defringe and chromatic aberration', (c) => num(c.AutoLateralCA) === 1 || ['DefringePurpleAmount', 'DefringeGreenAmount'].some((k) => num(c[k]))],
  ['AI Denoise and Super Resolution', (c) => num(c.EnhanceDenoise) === 1 || num(c.EnhanceSuperResolution) === 1 || !!c.EnhanceDetails],
  ['Point color', (c) => !!c.PointColors],
  ['Lens Blur', (c) => !!(c.LensBlur && Object.keys(c.LensBlur).length)],
];
export function untranslated(crs) {
  return UNTRANSLATED.filter(([, test]) => { try { return !!test(crs); } catch { return false; } }).map(([name]) => name);
}

// Everything an XMP packet says about a photo: { params|null, rating|null, flag|null, source }.
export function readXmpSettings(text, aspect) {
  const x = parseXmp(text);
  if (!x) return null;
  let params = null, source = null;
  if (x.ours && x.digest && x.digest === crsDigest(x.crs)) {
    params = deepMerge(defaultParams(aspect), x.ours);
    source = 'ours';
  } else if (hasDevelop(x.crs)) {
    params = crsToParams(x.crs, aspect);
    source = 'adobe';
  }
  let flag = x.flag;
  if (x.rating === -1) flag = -1;
  return { params, rating: x.rating !== null ? clamp(x.rating, 0, 5) : null, flag, label: x.label, keywords: x.keywords, source };
}

// XMP embedded in a file (DNG, TIFF, JPEG saved from Lightroom), from its first and last megabyte.
export async function embeddedXmp(file) {
  const grab = async (a, b) => new TextDecoder('latin1').decode(await file.slice(a, b).arrayBuffer());
  const find = (s) => { const i = s.indexOf('<x:xmpmeta'); if (i < 0) return null; const j = s.indexOf('</x:xmpmeta>', i); return j < 0 ? null : s.slice(i, j + 12); };
  const head = await grab(0, Math.min(file.size, 1 << 20));
  let found = find(head);
  if (!found && file.size > 1 << 20) found = find(await grab(Math.max(1 << 20, file.size - (1 << 20)), file.size));
  if (!found) return null;
  try { return decodeURIComponent(escape(found)); } catch { return found; }
}

// Sidecar file names to look for, in order. RAW files use Lightroom's "name.xmp";
// other files use "name.ext.xmp" so a RAW+JPEG pair never shares one sidecar.
export function sidecarNames(fileName, raw) {
  const base = fileName.replace(/\.[^.]+$/, '');
  return raw ? [`${base}.xmp`, `${base}.XMP`, `${fileName}.xmp`] : [`${fileName}.xmp`, `${base}.xmp`];
}

// ------------------------------------------------------------------ writing

const f = (v, d = 0) => (Math.abs(v) < 1e-9 ? '0' : (v > 0 ? '+' : '') + (+v.toFixed(d)).toString());
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The crs values we derive from our settings (Lightroom-compatible names and scales).
export function paramsToCrs(p, aspect, raw) {
  const o = {
    ProcessVersion: '11.0',
    Exposure2012: f(p.exposure, 2), Contrast2012: f(p.contrast), Highlights2012: f(p.highlights), Shadows2012: f(p.shadows),
    Whites2012: f(p.whites), Blacks2012: f(p.blacks),
    Texture: f(p.texture), Clarity2012: f(p.clarity), Dehaze: f(p.dehaze), Vibrance: f(p.vibrance), Saturation: f(p.saturation),
    ConvertToGrayscale: p.bw ? 'True' : 'False',
    Sharpness: String(Math.round(p.sharpen.amount)), SharpenRadius: f(p.sharpen.radius, 1), SharpenEdgeMasking: String(Math.round(p.sharpen.masking)),
    LuminanceSmoothing: String(Math.round(p.nr.luma)), ColorNoiseReduction: String(Math.round(p.nr.chroma)),
    PostCropVignetteAmount: f(p.vignette.amount), PostCropVignetteMidpoint: String(Math.round(p.vignette.midpoint)),
    PostCropVignetteRoundness: f(p.vignette.roundness), PostCropVignetteFeather: String(Math.round(p.vignette.feather)),
    GrainAmount: String(Math.round(p.grain.amount)), GrainSize: String(Math.round(p.grain.size)), GrainFrequency: String(Math.round(p.grain.roughness)),
    SplitToningShadowHue: String(Math.round(p.grading.shadows.h)), SplitToningShadowSaturation: String(Math.round(p.grading.shadows.s)),
    SplitToningHighlightHue: String(Math.round(p.grading.highlights.h)), SplitToningHighlightSaturation: String(Math.round(p.grading.highlights.s)),
    SplitToningBalance: f(p.grading.balance),
    ColorGradeMidtoneHue: String(Math.round(p.grading.midtones.h)), ColorGradeMidtoneSat: String(Math.round(p.grading.midtones.s)),
    ColorGradeShadowLum: f(p.grading.shadows.l), ColorGradeMidtoneLum: f(p.grading.midtones.l), ColorGradeHighlightLum: f(p.grading.highlights.l),
    ColorGradeGlobalHue: String(Math.round(p.grading.global.h)), ColorGradeGlobalSat: String(Math.round(p.grading.global.s)), ColorGradeGlobalLum: f(p.grading.global.l),
    ColorGradeBlending: String(Math.round(p.grading.blending)),
  };
  if (raw) {
    if (!p.temp && !p.tint) o.WhiteBalance = 'As Shot';
    else { o.WhiteBalance = 'Custom'; o.Temperature = String(Math.round(WB_REF * 2 ** ((p.temp * 1.2) / 100))); o.Tint = f(p.tint * 1.5); }
  } else {
    o.IncrementalTemperature = f(p.temp);
    o.IncrementalTint = f(p.tint);
  }
  LR_HSL.forEach((name, i) => {
    o[`HueAdjustment${name}`] = f(p.hsl.hue[i]);
    o[`SaturationAdjustment${name}`] = f(p.hsl.sat[i]);
    o[`LuminanceAdjustment${name}`] = f(p.hsl.lum[i]);
  });
  const g = p.geometry;
  if (g && !g.rot90 && !g.flipH && !g.flipV) {
    const t = (-(g.angle || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const rot = (x, y) => [c * x - s * y, s * x + c * y]; // Q -> P
    const [cx, cy] = rot(g.crop.cx, g.crop.cy);
    const [dx, dy] = rot(g.crop.w, g.crop.h);
    const L = (cx - dx / 2) / aspect + 0.5, R = (cx + dx / 2) / aspect + 0.5, T = cy - dy / 2 + 0.5, B = cy + dy / 2 + 0.5;
    const full = Math.abs(L) < 1e-4 && Math.abs(T) < 1e-4 && Math.abs(R - 1) < 1e-4 && Math.abs(B - 1) < 1e-4 && !g.angle;
    o.HasCrop = full ? 'False' : 'True';
    if (!full) Object.assign(o, { CropLeft: L.toFixed(6), CropTop: T.toFixed(6), CropRight: R.toFixed(6), CropBottom: B.toFixed(6), CropAngle: f(g.angle || 0, 3) });
  }
  const curve = (pts) => pts.map(([x, y]) => `${Math.round(x * 255)}, ${Math.round(y * 255)}`);
  return { attrs: o, curves: { ToneCurvePV2012: curve(p.curve.master), ToneCurvePV2012Red: curve(p.curve.r), ToneCurvePV2012Green: curve(p.curve.g), ToneCurvePV2012Blue: curve(p.curve.b) } };
}

function crsDigest(crs) {
  const keys = Object.keys(crs).filter((k) => !/^(Version|ProcessVersion|HasSettings|CameraProfile|RawFileName|AlreadyApplied)$/.test(k)).sort();
  let h = 2166136261;
  const s = keys.map((k) => `${k}=${Array.isArray(crs[k]) ? crs[k].map((v) => v.replace(/\s+/g, '')).join(';') : crs[k]}`).join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// A complete XMP sidecar for a photo.
export function buildXmp(p, { aspect = 1.5, raw = false, rating = 0, flag = 0, label = '', keywords = [] } = {}) {
  const { attrs, curves } = paramsToCrs(p, aspect, raw);
  const crsForDigest = { ...attrs };
  for (const [k, v] of Object.entries(curves)) crsForDigest[k] = v;
  const packed = btoa(unescape(encodeURIComponent(JSON.stringify(p))));
  const lines = Object.entries(attrs).map(([k, v]) => `   crs:${k}="${esc(v)}"`);
  const seq = Object.entries(curves).map(([k, pts]) => `   <crs:${k}>\n    <rdf:Seq>\n${pts.map((v) => `     <rdf:li>${v}</rdf:li>`).join('\n')}\n    </rdf:Seq>\n   </crs:${k}>`);
  if (keywords?.length) seq.push(`   <dc:subject>\n    <rdf:Bag>\n${keywords.map((k) => `     <rdf:li>${esc(k)}</rdf:li>`).join('\n')}\n    </rdf:Bag>\n   </dc:subject>`);
  const lab = labelName(label);
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${esc(BRAND.name)}">
 <rdf:RDF xmlns:rdf="${NS.rdf}">
  <rdf:Description rdf:about=""
    xmlns:xmp="${NS.xmp}"
    xmlns:crs="${NS.crs}"
    xmlns:pe="${NS.pe}"
    xmlns:dc="${NS.dc}"
   xmp:Rating="${flag === -1 ? -1 : rating || 0}"${lab ? `\n   xmp:Label="${lab[0].toUpperCase() + lab.slice(1)}"` : ''}
   xmp:MetadataDate="${new Date().toISOString()}"
   crs:Version="15.0"
   crs:HasSettings="True"
${lines.join('\n')}
   pe:Flag="${flag || 0}"
   pe:Digest="${crsDigest(crsForDigest)}"
   pe:Params="${packed}">
${seq.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}
