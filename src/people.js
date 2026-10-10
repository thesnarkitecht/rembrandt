// People masks, like Lightroom's: pick parts of the people in a photo. Hair, skin and clothes come
// from MediaPipe's multiclass selfie segmenter (models/people.tflite); eyes, irises, brows, lips and
// teeth are drawn from the face landmarks (models/face.task).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

export const PARTS = [
  ['person', 'Entire person'], ['faceSkin', 'Face skin'], ['bodySkin', 'Body skin'], ['hair', 'Hair'],
  ['brows', 'Eyebrows'], ['eyes', 'Eye whites'], ['iris', 'Iris & pupil'], ['lips', 'Lips'], ['teeth', 'Teeth'],
  ['clothes', 'Clothes'],
];
// Planes the segmenter worker returns, in order.
export const SEG_PARTS = ['hair', 'bodySkin', 'faceSkin', 'clothes', 'person'];

// Face mesh indices (MediaPipe canonical face model).
const EYES = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]];
const BROWS = [[46, 53, 52, 65, 55, 107, 66, 105, 63, 70], [276, 283, 282, 295, 285, 336, 296, 334, 293, 300]];
const LIPS_OUT = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_IN = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const IRISES = [[468, 469, 470, 471, 472], [473, 474, 475, 476, 477]];   // centre, then four points on the rim

// The landmark parts as 8-bit maps of w × h. `faces`: [[x, y] × 478] per face, 0–1 of the photo.
// `rgba`: the photo's pixels at w × h (for teeth).
export function landmarkParts(faces, w, h, rgba) {
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  const poly = (f, idx) => { x.beginPath(); idx.forEach((i, k) => (k ? x.lineTo : x.moveTo).call(x, f[i][0] * w, f[i][1] * h)); x.closePath(); };
  const eyes = (f) => { x.beginPath(); for (const e of EYES) { e.forEach((i, k) => (k ? x.lineTo : x.moveTo).call(x, f[i][0] * w, f[i][1] * h)); x.closePath(); } };
  const irises = (f) => { x.beginPath(); for (const [cI, ...rim] of IRISES) { const cx = f[cI][0] * w, cy = f[cI][1] * h; const r = rim.reduce((s, i) => s + Math.hypot(f[i][0] * w - cx, f[i][1] * h - cy), 0) / rim.length; x.moveTo(cx + r, cy); x.arc(cx, cy, r, 0, 2 * Math.PI); } };
  const draw = (paint) => {
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, w, h);
    x.fillStyle = '#fff';
    for (const f of faces) { x.save(); paint(f); x.restore(); }
    const d = x.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    return out;
  };
  const out = {
    brows: draw((f) => { for (const b of BROWS) { poly(f, b); x.fill(); } }),
    lips: draw((f) => { poly(f, LIPS_OUT); x.fill(); x.globalCompositeOperation = 'destination-out'; poly(f, LIPS_IN); x.fill(); }),
    // Irises show only where the eyelids are open; the whites are the eyes minus the irises.
    iris: draw((f) => { eyes(f); x.clip(); irises(f); x.fill(); }),
    eyes: draw((f) => { eyes(f); x.fill(); x.globalCompositeOperation = 'destination-out'; irises(f); x.fill(); }),
  };
  // Teeth: the light, low-colour pixels inside the mouth (tongue and the dark inside are left out).
  // ponytail: a brightness/colour threshold; a teeth segmenter if it misses on real photos.
  const mouth = draw((f) => { poly(f, LIPS_IN); x.fill(); });
  const v = new Float32Array(w * h), inside = [];
  for (let i = 0; i < mouth.length; i++) {
    if (mouth[i] < 128) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    v[i] = (0.3 * r + 0.59 * g + 0.11 * b - 1.2 * (Math.max(r, g, b) - Math.min(r, g, b))) / 255;
    inside.push(v[i]);
  }
  out.teeth = new Uint8Array(w * h);
  if (inside.length > 12) {
    inside.sort((a, b) => a - b);
    const t = Math.max(0.25, (inside[Math.floor(inside.length * 0.2)] + inside[Math.floor(inside.length * 0.95)]) / 2);
    for (let i = 0; i < mouth.length; i++) if (mouth[i] >= 128) out.teeth[i] = Math.round(255 * Math.min(1, Math.max(0, (v[i] - t + 0.06) / 0.12)));
  }
  return out;
}

// One map for a set of parts (their union).
export function unionOf(people, parts) {
  const out = new Uint8Array(people.w * people.h);
  for (const p of parts) { const m = people.maps[p]; if (m) for (let i = 0; i < out.length; i++) if (m[i] > out[i]) out[i] = m[i]; }
  return out;
}
