// The "develop" effect: while something is being worked out (AI analysis, Super Resolution, a preset),
// a diagonal front pulls the photo into bronze halftone dots, like the paintings on the website; the
// dots breathe while the work runs, then a second front peels them away to reveal the new render.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDevelopFX(app, viewer) {
  const cv = document.createElement('canvas');
  cv.className = 'develop-fx';
  cv.setAttribute('aria-hidden', 'true');
  viewer.append(cv);
  const ctx = cv.getContext('2d');
  let run = 0;     // id of the current play; a newer play takes over
  let active = false;

  // Where the photo is on screen (css px), clipped to the viewer; and its pixels on a coarse grid.
  function snapshot(params, cell) {
    if (!app.img || !app.m) return null;
    const c = params.geometry.crop;
    const [x0, y0] = app.qToCssPoint(c.cx - c.w / 2, c.cy - c.h / 2), [x1, y1] = app.qToCssPoint(c.cx + c.w / 2, c.cy + c.h / 2);
    const R = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    const vw = viewer.clientWidth, vh = viewer.clientHeight;
    const V = { x: Math.max(0, R.x), y: Math.max(0, R.y) };
    V.w = Math.min(vw, R.x + R.w) - V.x; V.h = Math.min(vh, R.y + R.h) - V.y;
    if (V.w < 8 || V.h < 8) return null;
    const sw = Math.max(8, Math.min(480, Math.round(R.w / cell))), sh = Math.max(8, Math.min(480, Math.round(R.h / cell)));
    let px;
    try { px = app.engine.readPixels(params, sw, sh, { ...app.outputMats(params, sw, sh), scale: sh / c.h, cropTest: true }); } catch { return null; }
    return { R, V, sw, sh, px };
  }

  function grid(snap, cell, light) {
    const { R, V, sw, sh, px } = snap;
    const cols = Math.ceil(V.w / cell), rows = Math.ceil(V.h / cell);
    const lum = new Float32Array(cols * rows), col = new Uint8ClampedArray(cols * rows * 3);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = V.x + (i + 0.5) * cell, y = V.y + (j + 0.5) * cell;
      const sx = Math.min(sw - 1, Math.max(0, Math.floor(((x - R.x) / R.w) * sw)));
      const sy = Math.min(sh - 1, Math.max(0, Math.floor(((y - R.y) / R.h) * sh)));
      const k = (sy * sw + sx) * 4, n = j * cols + i;
      const L = (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]) / 255;
      lum[n] = light ? 1 - L : L;
      col.set([px[k], px[k + 1], px[k + 2]], n * 3);
    }
    // Stretch the tones so a dark or flat photo still draws a full range of dots.
    const sorted = Float32Array.from(lum).sort();
    const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
    const k = 1 / Math.max(0.05, hi - lo);
    for (let n = 0; n < lum.length; n++) lum[n] = Math.min(1, Math.max(0, (lum[n] - lo) * k));
    return { cols, rows, lum, col };
  }

  // One frame. `inP`: 0..1 progress of the pull-in front, `outP`: of the reveal front, `t`: seconds.
  function draw(snap, g, cell, inP, outP, t, light) {
    const d = window.devicePixelRatio || 1;
    const W = viewer.clientWidth, H = viewer.clientHeight;
    if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { V } = snap, { cols, rows, lum } = g;
    const diag = cols + rows, band = 9;   // width of the front, in cells
    const fIn = inP * (diag + band) - band, fOut = outP * (diag + band) - band;
    const bg = light ? '245, 245, 244' : '9, 8, 7';
    // Ground: veils the photo behind the in-front, uncovers it behind the out-front.
    ctx.save();
    ctx.beginPath(); ctx.rect(V.x, V.y, V.w, V.h); ctx.clip();
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const glints = new Path2D();
    const ground = new Path2D();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const s = i + j;
        const a = Math.min(1, Math.max(0, (fIn - s) / band));    // pulled in
        const b = Math.min(1, Math.max(0, (fOut - s) / band));   // peeled away
        const on = a * (1 - b);
        if (on <= 0.001 && b <= 0) continue;
        const y = V.y + (j + 0.5) * cell, cx = V.x + (i + 0.5) * cell;
        if (on > 0.001) ground.rect(cx - cell / 2, y - cell / 2, cell, cell);
        const x = cx + (j & 1 ? cell * 0.5 : 0);   // staggered rows, like a print screen
        let v = lum[j * cols + i];
        // Breathing while held: a slow wave runs through the dots.
        v *= 0.86 + 0.14 * Math.sin(t * 2.4 - s * 0.16);
        // Dots swell at the fronts, like the edge of the patch on the website.
        const edgeIn = a > 0 && a < 1 ? Math.sin(a * Math.PI) : 0;
        const edgeOut = b > 0 && b < 1 ? Math.sin(b * Math.PI) : 0;
        const r = cell * 0.5 * Math.min(1.08, Math.max(0, v) ** 0.8 * (0.25 + 0.75 * on) + 0.35 * (edgeIn + edgeOut));
        if (r < 0.35) continue;
        const p = edgeOut > 0.25 ? glints : paths[Math.min(3, Math.floor(v * 4))];
        p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    // The ground fades per cell with the fronts; drawn as one veil at the mean strength.
    ctx.fillStyle = `rgba(${bg}, ${0.92 * Math.min(1, inP * 1.6) * (1 - outP)})`;
    ctx.fill(ground);
    const tones = light ? ['#a8712f', '#8f6135', '#6f4520', '#4d2f14'] : ['#6f4520', '#a8712f', '#c98f4f', '#f4d292'];
    paths.forEach((p, k) => { ctx.fillStyle = tones[k]; ctx.fill(p); });
    ctx.fillStyle = light ? '#3a2410' : '#fff3dc';
    ctx.shadowColor = 'rgba(244, 210, 146, 0.8)'; ctx.shadowBlur = light ? 0 : 6;
    ctx.fill(glints);
    ctx.restore();
  }

  // Plays the effect over the photo until `hold` (a promise) settles. `params` are the settings whose
  // look is pulled into dots (default: what's on screen now).
  async function play({ hold, params, minHold = 280 } = {}) {
    if (!app.img || reduced() || app.state.tool === 'crop') { await hold; return; }
    const id = ++run;
    const light = getComputedStyle(document.documentElement).colorScheme.trim() === 'light';
    const cell = Math.max(6, Math.round(Math.min(viewer.clientWidth, viewer.clientHeight) / 90));
    const snap = snapshot(params || app.renderParams(), cell);
    app.requestRender();   // readPixels used the engine; put the view back
    if (!snap) { await hold; return; }
    const g = grid(snap, cell, light);
    active = true;
    cv.classList.add('on');
    let done = false;
    Promise.resolve(hold).catch(() => {}).finally(() => { done = true; });
    const t0 = performance.now();
    const IN = 620, OUT = 900;
    let tDone = 0;
    await new Promise((resolve) => {
      const frame = (now) => {
        if (id !== run) return resolve();
        const t = now - t0;
        const inP = ease(Math.min(1, t / IN));
        if (done && !tDone && t >= IN + minHold) tDone = now;
        const outP = tDone ? ease(Math.min(1, (now - tDone) / OUT)) : 0;
        draw(snap, g, cell, inP, outP, t / 1000, light);
        if (tDone && now - tDone >= OUT) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    if (id === run) { active = false; cv.classList.remove('on'); ctx.clearRect(0, 0, cv.width, cv.height); }
  }

  // AI analysis that takes more than a moment plays the effect until it's done.
  let watching = false;
  app.ai.onChange(() => {
    if (app.ai.busy > 0 && !watching && !active) {
      watching = true;
      sleep(140).then(() => {
        if (app.ai.busy <= 0) { watching = false; return; }
        const hold = new Promise((r) => {
          const check = () => (app.ai.busy <= 0 ? setTimeout(r, 120) : setTimeout(check, 60));
          check();
        });
        play({ hold }).finally(() => { watching = false; });
      });
    }
  });

  return { play, get active() { return active; } };
}
