// Automatic blemish removal for portraits: finds spots on the skin (pimples, redness, small marks)
// and tells them apart from moles and beauty marks, which are kept unless you say otherwise.
//
// For each face (MediaPipe Face Landmarker, ai.js) the skin is the face outline minus the eyes,
// brows, lips and nostrils, plus anything that isn't skin-coloured. On that skin, in Oklab, each
// pixel is compared with the skin around it (a broad local average): spots are small areas darker
// or redder than their surroundings by more than the skin's own texture, so pores and stubble don't
// count. Each spot is then classified:
//   • blemish: redder than the skin around it, or soft and shallow (pimples, redness, marks);
//   • mole: clearly darker, not much redder, with a defined edge (moles, beauty marks).
// The result is a list of spots; tool-retouch.js turns blemishes into ordinary Heal spots, so every
// one can be moved, removed or given a new source like a spot placed by hand.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// MediaPipe face mesh landmark indices.
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYES = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]];
const BROWS = [[46, 53, 52, 65, 55, 107, 66, 105, 63, 70], [276, 283, 282, 295, 285, 336, 296, 334, 293, 300]];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const NOSTRILS = [64, 294, 2];   // the two alae and the base of the nose

const WORK = 520;   // face width in working pixels

// Linear RGB (sRGB primaries) → Oklab (Ottosson 2020).
function oklab(r, g, b) {
  const l = Math.cbrt(Math.max(0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b));
  const m = Math.cbrt(Math.max(0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b));
  const s = Math.cbrt(Math.max(0, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b));
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[y * w + x] = s / n; s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
const blur2 = (a, w, h, r) => boxBlur(boxBlur(a, w, h, r), w, h, r);

// Fills polygon `pts` ([x, y] in working pixels) into `mask` with `value`.
function fillPoly(mask, w, h, pts, value) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y + 0.5) !== (by <= y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, Math.floor(xs[k + 1])); x++) mask[y * w + x] = value;
  }
}
// Grows a polygon about its centre by `d` working pixels.
const grow = (pts, d) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => { const l = Math.hypot(x - cx, y - cy) || 1; return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d]; });
};

// img: { W, H, read(x, y, w, h) → Float32Array RGBA, linear }. face: 478 [u, v] landmarks.
// opts.sensitivity 0–1. Returns { spots: [{ u, v, radius (long-edge fraction), kind, strength }], skin }.
export function findSpots(img, face, { sensitivity = 0.5 } = {}) {
  const { W, H } = img;
  const P = face.map(([u, v]) => [u * W, v * H]);
  const ov = OVAL.map((i) => P[i]);
  const xs = ov.map((p) => p[0]), ys = ov.map((p) => p[1]);
  const fw = Math.max(...xs) - Math.min(...xs);
  if (fw < 40) return { spots: [], skin: 0 };   // too small to work on
  // Region: the face outline with a margin, read at full resolution and reduced to WORK across.
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - fw * 0.05)), x1 = Math.min(W, Math.ceil(Math.max(...xs) + fw * 0.05));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - fw * 0.05)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + fw * 0.05));
  const rw = x1 - x0, rh = y1 - y0;
  const k = Math.max(1, fw / WORK);   // full pixels per working pixel
  const w = Math.max(8, Math.floor(rw / k)), h = Math.max(8, Math.floor(rh / k));
  const full = img.read(x0, y0, rw, rh);
  const L = new Float32Array(w * h), A = new Float32Array(w * h), B = new Float32Array(w * h);
  const taps = Math.min(3, Math.max(1, Math.round(k)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < taps; j++) for (let i = 0; i < taps; i++) {
      const sx = Math.min(rw - 1, Math.floor((x + (i + 0.5) / taps) * k)), sy = Math.min(rh - 1, Math.floor((y + (j + 0.5) / taps) * k));
      const o = (sy * rw + sx) * 4;
      r += full[o]; g += full[o + 1]; b += full[o + 2];
    }
    const lab = oklab(r / (taps * taps), g / (taps * taps), b / (taps * taps));
    L[y * w + x] = lab[0]; A[y * w + x] = lab[1]; B[y * w + x] = lab[2];
  }
  const toW = ([x, y]) => [(x - x0) / k, (y - y0) / k];
  const fwW = fw / k;
  // Skin: inside the outline (pulled in a little at the edges), minus the features.
  const skin = new Uint8Array(w * h);
  fillPoly(skin, w, h, grow(ov.map(toW), -fwW * 0.02), 1);
  for (const e of EYES) fillPoly(skin, w, h, grow(e.map((i) => toW(P[i])), fwW * 0.05), 0);
  for (const b of BROWS) fillPoly(skin, w, h, grow(b.map((i) => toW(P[i])), fwW * 0.035), 0);
  fillPoly(skin, w, h, grow(LIPS.map((i) => toW(P[i])), fwW * 0.03), 0);
  {
    const [a, b2, c] = NOSTRILS.map((i) => toW(P[i]));
    const span = Math.hypot(a[0] - b2[0], a[1] - b2[1]);
    for (const [cx, cy, r] of [[a[0], a[1], span * 0.3], [b2[0], b2[1], span * 0.3], [(a[0] + b2[0] + c[0]) / 3, (a[1] + b2[1] + c[1]) / 3, span * 0.45]]) {
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) if (Math.hypot(x - cx, y - cy) < r) skin[y * w + x] = 0;
    }
  }
  // Surroundings: broad averages of the skin only (weighted, so hair and background don't leak in).
  const R = Math.max(3, Math.round(fwW * 0.03));
  const wt = Float32Array.from(skin);
  const avg = (arr) => { const num = blur2(arr.map((v, i) => v * wt[i]), w, h, R), den = blur2(wt, w, h, R); return num.map((v, i) => v / Math.max(den[i], 1e-3)); };
  const Lb = avg(L), Ab = avg(A), Bb = avg(B);
  // Skin colour: drop what's far from the face's median skin tone (hair, beard, glasses).
  const pick = (arr) => { const v = []; for (let i = 0; i < arr.length; i += 3) if (skin[i]) v.push(arr[i]); v.sort((p, q) => p - q); return v[v.length >> 1] ?? 0; };
  const mL = pick(Lb), mA = pick(Ab), mB = pick(Bb);
  for (let i = 0; i < skin.length; i++) if (skin[i] && (Math.abs(Ab[i] - mA) > 0.05 || Math.abs(Bb[i] - mB) > 0.06 || Lb[i] < mL * 0.55)) skin[i] = 0;
  // Spot signal: darker or redder than the surroundings.
  const dL = new Float32Array(w * h), dA = new Float32Array(w * h);
  for (let i = 0; i < dL.length; i++) { dL[i] = Lb[i] - L[i]; dA[i] = A[i] - Ab[i]; }
  // The skin's own texture (pores, stubble): local spread of the darkness signal.
  const tex = blur2(dL.map((v) => v * v), w, h, R).map(Math.sqrt);
  let noise = [];
  for (let i = 0; i < dL.length; i += 2) if (skin[i]) noise.push(Math.abs(dL[i]));
  noise.sort((p, q) => p - q);
  const sigma = Math.max(0.002, (noise[noise.length >> 1] || 0.004) * 1.4826);
  // Hair, stubble and lashes are busy with fine strands; skin isn't. Texture measured with each
  // pixel capped, so a single mole doesn't make its own surroundings look like hair.
  const cap = 3 * sigma;
  const busy = blur2(dL.map((v) => Math.min(Math.abs(v), cap) ** 2), w, h, Math.max(2, R >> 1)).map(Math.sqrt);
  const smooth = (i) => skin[i] && busy[i] < 2.4 * sigma;
  const s = Math.min(1, Math.max(0, sensitivity));
  const zDark = 4.2 - 2.4 * s, minRed = 0.022 - 0.012 * s;
  const cand = new Uint8Array(w * h);
  for (let i = 0; i < cand.length; i++) {
    if (!skin[i]) continue;
    const local = Math.max(sigma, tex[i] * 0.8);
    if (dL[i] > zDark * local || (dA[i] > minRed && dL[i] > -0.5 * sigma)) cand[i] = 1;
  }
  // Connected spots.
  const label = new Int32Array(w * h).fill(-1), spots = [];
  const minR = 0.0035 * fwW, maxR = 0.03 * fwW;
  for (let i = 0; i < cand.length; i++) {
    if (!cand[i] || label[i] >= 0) continue;
    const stack = [i], px = [];
    label[i] = spots.length;
    while (stack.length) {
      const q = stack.pop(); px.push(q);
      const x = q % w, y = (q / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (cand[n] && label[n] < 0) { label[n] = spots.length; stack.push(n); }
      }
    }
    spots.push(px);
  }
  const out = [];
  const long = Math.max(W, H);
  for (const px of spots) {
    const area = px.length, r = Math.sqrt(area / Math.PI);
    if (r < minR || r > maxR) continue;
    let sx = 0, sy = 0, mx = Infinity, Mx = -Infinity, my = Infinity, My = -Infinity, depth = 0, peak = 0, red = 0;
    for (const q of px) {
      const x = q % w, y = (q / w) | 0;
      sx += x; sy += y; mx = Math.min(mx, x); Mx = Math.max(Mx, x); my = Math.min(my, y); My = Math.max(My, y);
      depth += dL[q]; peak = Math.max(peak, dL[q]); red += dA[q];
    }
    const bw = Mx - mx + 1, bh = My - my + 1;
    // Lines (wrinkles, strands of hair) and ragged shapes aren't spots.
    if (Math.max(bw, bh) / Math.min(bw, bh) > 2.6 || area / (bw * bh) < 0.4) continue;
    const cx = sx / area, cy = sy / area, ci = Math.round(cy) * w + Math.round(cx);
    // A spot is surrounded by skin; at the hairline, a brow or the edge of a beard it isn't one.
    let ring = 0, ringSkin = 0;
    const r0 = r + 2, r1 = r * 2.5 + 3;
    for (let a = 0; a < 24; a++) for (const rr of [r0, (r0 + r1) / 2, r1]) {
      const x = Math.round(cx + Math.cos((a / 24) * 2 * Math.PI) * rr), y = Math.round(cy + Math.sin((a / 24) * 2 * Math.PI) * rr);
      ring++;
      if (x >= 0 && y >= 0 && x < w && y < h && smooth(y * w + x)) ringSkin++;
    }
    if (ringSkin / ring < 0.75) continue;
    const rel = peak / Math.max(0.05, Lb[ci] || mL);   // how much darker, relative
    const meanRed = red / area;
    const sharp = depth / area / Math.max(peak, 1e-4); // flat-topped (defined edge) → closer to 1
    const mole = rel > 0.14 && meanRed < 0.012 + 0.06 * rel && sharp > 0.45;
    // A dark speck smaller than any real mole is a pore, a hair tip or noise: leave it alone.
    if (mole && r < Math.max(1.5, 0.006 * fwW)) continue;
    out.push({
      u: (x0 + (cx + 0.5) * k) / W, v: (y0 + (cy + 0.5) * k) / H,
      radius: Math.min(0.05, (r * 1.8 + 1.5) * k / long),
      kind: mole ? 'mole' : 'blemish',
      strength: Math.max(rel * 4, meanRed * 30),
    });
  }
  let skinPx = 0;
  for (let i = 0; i < skin.length; i++) skinPx += skin[i];
  return { spots: out, skin: skinPx };
}
