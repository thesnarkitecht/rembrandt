// Auto straighten: finds how far a photo is tilted from its long straight lines (a horizon, the
// edges of buildings, door frames) and suggests the Straighten angle that levels it.
//
// Edges come from a Sobel filter with non-maximum suppression; a Hough transform restricted to
// lines within ±20° of horizontal or vertical collects them, and the strongest long lines vote for
// the tilt, weighted by their length (a horizon counts more than a window sill). Photos without
// clear lines (portraits, foliage) get no suggestion rather than a guess.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const RANGE = 20;     // degrees either side of horizontal / vertical
const STEP = 0.1;     // degrees per Hough bin

// `img`: ImageData (any size; ~800 px across is plenty) of the photo as framed, before straightening.
// Returns { angle (degrees to rotate by, positive = clockwise), confidence 0..1, lines } or null.
export function detectTilt(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  // Sobel gradients.
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const sx = c + 2 * f + r - a - 2 * d - p, sy = p + 2 * q + r - a - 2 * b - c;
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
    }
  }
  // Strong edges only: above the 90th percentile of gradient, thinned to their ridge.
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(40, sorted[Math.floor(sorted.length * 0.9)]);
  const pts = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, m = mag[i];
      if (m < thr) continue;
      const nx = gx[i] / m, ny = gy[i] / m;
      const dx = Math.round(nx), dy = Math.round(ny);
      if (mag[i + dy * w + dx] > m || mag[i - dy * w - dx] > m) continue;
      // Edge direction is perpendicular to the gradient; keep near-horizontal and near-vertical ones.
      const edgeDeg = (Math.atan2(nx, -ny) * 180) / Math.PI;       // along the edge, -180..180
      const e = ((edgeDeg % 180) + 180) % 180;                      // 0..180
      const offH = e > 90 ? e - 180 : e;                            // vs horizontal
      const offV = e - 90;                                          // vs vertical
      if (Math.abs(offH) <= RANGE + 2 || Math.abs(offV) <= RANGE + 2) pts.push(x, y);
    }
  }
  if (pts.length < 200) return null;
  // Hough over the two bands of angles. A line at tilt t (degrees) from horizontal has normal angle
  // 90 + t; from vertical, normal angle t.
  const nT = Math.round((2 * RANGE) / STEP) + 1;
  const diag = Math.ceil(Math.hypot(w, h));
  const best = [];
  for (const band of [0, 1]) {
    const acc = new Uint16Array(nT * (2 * diag + 1));
    const cs = new Float32Array(nT), sn = new Float32Array(nT);
    for (let k = 0; k < nT; k++) {
      const t = -RANGE + k * STEP;
      const th = ((band === 0 ? 90 + t : t) * Math.PI) / 180;
      cs[k] = Math.cos(th); sn[k] = Math.sin(th);
    }
    for (let j = 0; j < pts.length; j += 2) {
      const x = pts[j] - w / 2, y = pts[j + 1] - h / 2;
      for (let k = 0; k < nT; k++) {
        const r = Math.round(x * cs[k] + y * sn[k]) + diag;
        acc[k * (2 * diag + 1) + r]++;
      }
    }
    // Peaks: the strongest bins, each suppressing its neighbourhood.
    const span = band === 0 ? w : h;
    const minVotes = Math.max(30, span * 0.18);
    for (let n = 0; n < 6; n++) {
      let bi = -1, bv = minVotes;
      for (let i = 0; i < acc.length; i++) if (acc[i] > bv) { bv = acc[i]; bi = i; }
      if (bi < 0) break;
      const k = Math.floor(bi / (2 * diag + 1)), r = bi % (2 * diag + 1);
      const tilt = -RANGE + k * STEP, th = ((band === 0 ? 90 + tilt : tilt) * Math.PI) / 180;
      // Where the line crosses the middle of the frame, from -0.5 to 0.5 across it.
      const pos = band === 0 ? (r - diag) / Math.sin(th) / h : (r - diag) / Math.cos(th) / w;
      best.push({ tilt, votes: bv, band, pos });
      for (let kk = Math.max(0, k - 30); kk < Math.min(nT, k + 31); kk++) {
        for (let rr = Math.max(0, r - 12); rr < Math.min(2 * diag + 1, r + 13); rr++) acc[kk * (2 * diag + 1) + rr] = 0;
      }
    }
  }
  if (!best.length) return null;
  // Lines converge with perspective: verticals left of centre lean one way, right of centre the
  // other (and horizontals above and below the horizon likewise). So within each band the tilt is
  // fitted against the line's position, and the tilt at the centre of the frame is the camera's.
  const fit = (lines) => {
    let use = lines;
    for (let pass = 0; pass < 2; pass++) {
      const W = use.reduce((s2, l) => s2 + l.votes, 0);
      const mp = use.reduce((s2, l) => s2 + l.votes * l.pos, 0) / W, mt = use.reduce((s2, l) => s2 + l.votes * l.tilt, 0) / W;
      const vp = use.reduce((s2, l) => s2 + l.votes * (l.pos - mp) ** 2, 0) / W;
      const slope = use.length >= 3 && vp > 0.01 ? use.reduce((s2, l) => s2 + l.votes * (l.pos - mp) * (l.tilt - mt), 0) / W / vp : 0;
      const at = (l) => mt + slope * (l.pos - mp);
      const keep = use.filter((l) => Math.abs(l.tilt - at(l)) <= 1.5);
      if (pass === 1 || keep.length < 2 || keep.length === use.length) return { tilt: mt - slope * mp, votes: use.reduce((s2, l) => s2 + l.votes, 0), lines: use.length };
      use = keep;
    }
  };
  const bands = [0, 1].map((band) => best.filter((l) => l.band === band)).filter((l) => l.length).map(fit);
  // Bands that agree are averaged; otherwise the stronger one wins.
  bands.sort((x, y) => y.votes - x.votes);
  let res = bands[0];
  if (bands[1] && Math.abs(bands[1].tilt - res.tilt) < 1) {
    const v = res.votes + bands[1].votes;
    res = { tilt: (res.tilt * res.votes + bands[1].tilt * bands[1].votes) / v, votes: v, lines: res.lines + bands[1].lines };
  }
  const all = best.reduce((s2, l) => s2 + l.votes, 0);
  const confidence = Math.min(1, (res.votes / all) * Math.min(1, res.votes / (Math.max(w, h) * 0.8)));
  if (confidence < 0.25 || Math.abs(res.tilt) > RANGE - 1) return null;
  return { angle: -Math.round(res.tilt * 10) / 10, confidence, lines: res.lines };
}
