// Lens profiles from the Lensfun database, for RAW files whose camera stores no correction of its
// own: distortion, lateral chromatic aberration and vignetting for about 1,500 lenses, matched by the
// lens name in the file and corrected for the camera's sensor size.
//
// The data (src/vendor/lensfun/lensfun.json) is converted from Lensfun's XML database,
// © the Lensfun contributors, CC BY-SA 3.0 (https://lensfun.github.io); see NOTICE.md. It is loaded
// only when a photo needs it.
//
// Lensfun's coefficients use Hugin's units: distortion and CA radii are 1 at half the shorter side of
// the calibration frame, vignetting radii 1 at half its diagonal. Our profiles are radial functions
// over the radius with 1 at half the photo's diagonal (see readLensProfile in lens.js).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const FF_DIAG = Math.hypot(36, 24);
let db = null;

async function load() {
  if (!db) db = fetch(new URL('./vendor/lensfun/lensfun.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return db;
}

// Names as comparable tokens: "FE 24-70mm F2.8 GM II" → ["fe", "24", "70", "f2.8", "gm", "ii"].
function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/f\s*\/\s*/g, 'f').replace(/\b(f\d+(?:\.\d+)?)\s+([a-z])\b/g, '$1$2').replace(/(\d)\s*mm\b/g, '$1').replace(/[-–/]/g, ' ')
    .replace(/\b([a-eg-z][a-z]+)(\d)/g, '$1 $2').replace(/(\d)([a-z]{2,})\b/g, '$1 $2')
    .split(/[^a-z0-9.+]+/).filter(Boolean).map((t) => t.replace(/\.0$/, ''));
}

// The Lensfun lens that names the same lens as `name`. Focal lengths, apertures and version marks
// (II, III) must all agree; the other words (series, coatings, "Asph.") only mostly, since cameras
// abbreviate them. Maker words are optional on either side.
const VER = /^(ii|iii|iv|v|vi|mark)$/;
export function matchLens(lenses, name, make = '', crop = 0) {
  const have = new Set([...tokens(name), ...tokens(make)]);
  const haveVer = [...have].filter((t) => VER.test(t));
  let best = null, bestScore = 0;
  for (const l of lenses) {
    const maker = new Set(tokens(l.k));
    const need = tokens(l.n).filter((t) => !maker.has(t));
    // Some entries end in the maker's lens ID ("… VR 170"), which no camera writes.
    if (need.length > 2 && /^\d+$/.test(need[need.length - 1]) && need.slice(0, -1).some((t) => /\d/.test(t))) need.pop();
    const core = need.filter((t) => /\d/.test(t) || VER.test(t));
    if (!core.some((t) => /^\d/.test(t)) || !core.every((t) => have.has(t))) continue;
    if (haveVer.some((v) => !need.includes(v))) continue;
    const words = need.filter((t) => !core.includes(t));
    const hit = words.filter((t) => have.has(t)).length;
    if (words.length && hit / words.length < 0.5 && hit < 3) continue;
    const score = core.length * 2 + hit - 0.25 * (words.length - hit);
    // The same lens is often calibrated on several bodies: prefer the one nearest this sensor size.
    const nearer = crop && best && Math.abs(Math.log(l.c / crop)) < Math.abs(Math.log(best.c / crop));
    if (score > bestScore || (score === bestScore && nearer)) { best = l; bestScore = score; }
  }
  return best;
}

function cameraCrop(cameras, make, model) {
  const mk = tokens(make).join(' '), md = tokens(model).join(' ');
  const c = cameras.find((x) => tokens(x[1]).join(' ') === md && (!mk || tokens(x[0]).join(' ').startsWith(mk.split(' ')[0])));
  return c ? c[2] : 0;
}

// Values of a calibration list at `focal`, interpolated between the nearest calibrated focal lengths.
function atFocal(list, focal, evalAt) {
  if (!list.length) return null;
  const fs = [...new Set(list.map((e) => e[0]))].sort((a, b) => a - b);
  const f = Math.min(fs[fs.length - 1], Math.max(fs[0], focal || fs[0]));
  let i = fs.findIndex((x) => x >= f);
  const f1 = fs[i], f0 = fs[Math.max(0, i - 1)];
  const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
  const a = evalAt(list.filter((e) => e[0] === f0)), b = evalAt(list.filter((e) => e[0] === f1));
  return a && b ? a.map((v, k) => v + (b[k] - v) * t) : a || b;
}

const KN = Array.from({ length: 17 }, (_, i) => i / 16);

// A profile for the photo, or null. meta: { make, model, lens, focal, aperture } (LibRaw's).
export async function lensfunProfile(meta) {
  if (!meta?.lens) return null;
  const d = await load();
  if (!d) return null;
  const camCrop = cameraCrop(d.cameras, meta.make, meta.model);
  const l = matchLens(d.lenses, meta.lens, meta.make, camCrop);
  if (!l) return null;
  const crop = camCrop || l.c;
  // Half the photo's diagonal in millimetres on the sensor, and the units of each model.
  const halfDiag = FF_DIAG / crop / 2;
  const unitD = FF_DIAG / l.c / Math.hypot(l.a, 1) / 2;   // half the calibration frame's shorter side
  const unitV = FF_DIAG / l.c / 2;                        // half its diagonal
  const rD = KN.map((r) => (r * halfDiag) / unitD), rV = KN.map((r) => (r * halfDiag) / unitV);

  const distortion = atFocal(l.d, meta.focal, ([e]) => {
    if (!e) return null;
    return rD.map((r) => (e[1] === 'p' ? e[2] * r ** 3 + e[3] * r * r + e[4] * r + 1 - e[2] - e[3] - e[4]
      : e[1] === '3' ? 1 - e[2] + e[2] * r * r : 1 + e[2] * r * r + e[3] * r ** 4));
  });
  const tca = (blue) => atFocal(l.t, meta.focal, ([e]) => {
    if (!e) return null;
    if (e[1] === 'l') return rD.map(() => (blue ? e[3] : e[2]));
    const [v, c, b] = blue ? [e[3], e[5], e[7]] : [e[2], e[4], e[6]];
    return rD.map((r) => b * r * r + c * r + v);
  });
  // Vignetting depends on the aperture too: interpolate in stops between the nearest two.
  const vignetting = atFocal(l.v, meta.focal, (rows) => {
    if (!rows.length) return null;
    const stops = (n) => 2 * Math.log2(n);
    const A = meta.aperture > 0 ? stops(meta.aperture) : stops(rows[0][1]);
    const sorted = rows.slice().sort((a, b) => a[1] - b[1]);
    let i = sorted.findIndex((e) => stops(e[1]) >= A);
    if (i < 0) i = sorted.length - 1;
    const e1 = sorted[i], e0 = sorted[Math.max(0, i - 1)];
    const t = e1 === e0 ? 0 : Math.min(1, Math.max(0, (A - stops(e0[1])) / (stops(e1[1]) - stops(e0[1]))));
    const gain = (e, r) => 1 / Math.max(0.2, 1 + e[2] * r * r + e[3] * r ** 4 + e[4] * r ** 6);
    return rV.map((r) => gain(e0, r) + (gain(e1, r) - gain(e0, r)) * t);
  });
  const ok = (v) => v && v.every((x) => Number.isFinite(x) && x >= 0.2 && x <= 5) ? { knots: KN, values: v } : null;
  const red = ok(tca(false)), blue = ok(tca(true));
  const prof = {
    source: `Lensfun: ${l.k ? l.k + ' ' : ''}${l.n.replace(new RegExp(`^${l.k}\\s+`, 'i'), '')}`,
    defaultOn: true,
    distortion: ok(distortion), vignetting: ok(vignetting),
    chromatic: red && blue ? [red, blue] : null,
  };
  return prof.distortion || prof.vignetting || prof.chromatic ? prof : null;
}
