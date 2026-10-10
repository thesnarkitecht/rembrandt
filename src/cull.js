// Culling: after a shoot, find the keepers. Frames of a burst (shot within seconds, looking alike)
// form a group; in each, the sharpest frame with open eyes is picked, and frames that are clearly
// blurrier or have closed eyes are rejected. Photos you flagged yourself are left alone.
// Runs on this device: sharpness from the pixels, eyes from the face landmarks (models/face.task).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// Eye openness: lid gap over eye width (the "eye aspect ratio"), the lower of the two eyes.
// About 0.25–0.35 open, under 0.12 closed.
const EYES = [[33, 133, 159, 145, 158, 153], [362, 263, 386, 374, 385, 380]];   // corners, then two lid pairs
// Landmarks are 0–1 of width and height; `aspect` (width / height) makes the distances true.
export function eyeOpenness(face, aspect = 1) {
  const d = (a, b) => Math.hypot((face[a][0] - face[b][0]) * aspect, face[a][1] - face[b][1]);
  return Math.min(...EYES.map(([c0, c1, u1, l1, u2, l2]) => (d(u1, l1) + d(u2, l2)) / (2 * Math.max(d(c0, c1), 1e-6))));
}
export const EYES_CLOSED = 0.12;

// Focus: variance of the Laplacian of grey `g` (w × h) inside [x0, y0, x1, y1] (pixels).
export function sharpness(g, w, h, [x0, y0, x1, y1] = [0, 0, w, h]) {
  x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0));
  x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    s += l; s2 += l * l; n++;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

// Where to judge focus, and the eyes: the largest face when there is one (that is what has to be
// sharp), else the middle of the frame. `faces` [[x, y] × 478] (0–1), `aspect` width / height;
// returns { box (0–1), eyes }.
export function focusOf(faces, aspect = 1) {
  if (!faces.length) return { box: [0.2, 0.2, 0.8, 0.8], eyes: null };
  const ext = (f) => [Math.min(...f.map((p) => p[0])), Math.min(...f.map((p) => p[1])), Math.max(...f.map((p) => p[0])), Math.max(...f.map((p) => p[1]))];
  const boxes = faces.map(ext), area = (q) => (q[2] - q[0]) * (q[3] - q[1]);
  const box = boxes.reduce((x, y) => (area(y) > area(x) ? y : x));
  const eyes = Math.min(...faces.filter((_, i) => area(boxes[i]) > area(box) * 0.25).map((f) => eyeOpenness(f, aspect)));
  return { box, eyes };
}

// Sharpness of RGBA pixels. Callers resample the focus box to the same size (FOCUS_PX wide) for
// every photo, so scores compare across resolutions.
export const FOCUS_PX = 320;
export function sharpOf(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return sharpness(g, w, h);
}

// items: [{ id, at (ms, 0 unknown), sig, sharp, eyes (null: no face), flag }], `alike(sigA, sigB)` → 0–1.
// Returns { pick: [id], reject: [id], groups: n }.
export function decide(items, alike, threshold) {
  const list = [...items].sort((a, b) => a.at - b.at);
  const groups = [];
  for (const it of list) {
    const g = groups[groups.length - 1], last = g?.[g.length - 1];
    const burst = last && it.at && last.at && it.at - last.at < 4000;
    if (last && (burst ? alike(last.sig, it.sig) >= threshold - 0.1 : alike(last.sig, it.sig) >= threshold + 0.05)) g.push(it);
    else groups.push([it]);
  }
  const closed = (it) => it.eyes != null && it.eyes < EYES_CLOSED;
  const sharps = items.map((it) => it.sharp).sort((a, b) => a - b), median = sharps[sharps.length >> 1] || 0;
  const pick = [], reject = [];
  for (const g of groups) {
    const free = g.filter((it) => !it.flag);
    if (g.length === 1) {
      // ponytail: a lone photo is judged against the shoot's median sharpness; tune if it rejects soft-but-good frames.
      if (free.length && (closed(g[0]) || g[0].sharp < median * 0.2)) reject.push(g[0].id);
      continue;
    }
    const best = [...g].sort((a, b) => closed(a) - closed(b) || b.sharp - a.sharp)[0];
    const picked = g.some((it) => it.flag === 1);   // you already chose this burst's keeper
    for (const it of free) {
      if (it === best) { if (!picked) pick.push(it.id); }
      else if (closed(it) || it.sharp < best.sharp * 0.5) reject.push(it.id);
    }
  }
  return { pick, reject, groups: groups.length };
}

// Self-check: node src/cull.js
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('cull.js')) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const same = () => 1;
  // a burst of three (one blurry, one eyes closed) and a lone sharp photo much later
  const r = decide([
    { id: 'a', at: 1000, sig: 0, sharp: 100, eyes: 0.3 }, { id: 'b', at: 1500, sig: 0, sharp: 30, eyes: 0.3 },
    { id: 'c', at: 2000, sig: 0, sharp: 140, eyes: 0.05 }, { id: 'd', at: 90000, sig: 1, sharp: 120, eyes: null },
  ], (x, y) => (x === y ? 1 : 0), 0.8);
  assert(r.groups === 2, 'groups'); assert(r.pick.join() === 'a', 'pick ' + r.pick); assert(r.reject.sort().join() === 'b,c', 'reject ' + r.reject);
  // user flags are kept
  const k = decide([{ id: 'a', at: 1, sig: 0, sharp: 1, eyes: 0.3, flag: 1 }, { id: 'b', at: 2, sig: 0, sharp: 100, eyes: 0.3 }], same, 0.8);
  assert(!k.pick.length && !k.reject.length, 'flags');
  // sharpness: a checkerboard beats a flat field
  const w = 16, flat = new Float32Array(w * w), chk = flat.map((_, i) => ((i % w) + ((i / w) | 0)) % 2 * 255);
  assert(sharpness(chk, w, w) > sharpness(flat, w, w), 'sharpness');
  console.log('cull.js ok');
}
