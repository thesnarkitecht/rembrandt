// RGB histogram computed from a small rendered copy of the edited photo.

export function computeHistogram(px) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i], G = px[i + 1], B = px[i + 2];
    r[R]++; g[G]++; b[B]++;
    l[(R * 54 + G * 183 + B * 19) >> 8]++;
  }
  const n = px.length / 4 || 1;
  const hi = Math.max(r[255], g[255], b[255]) / n;
  const lo = Math.min(r[0], g[0], b[0]) / n;
  return { r, g, b, l, clipHi: hi > 0.002, clipLo: lo > 0.002 };
}

export function drawHistogram(canvas, h) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * d)) { canvas.width = Math.round(W * d); canvas.height = Math.round(H * d); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!h) return;
  let max = 1;
  for (const ch of [h.r, h.g, h.b]) for (let i = 1; i < 255; i++) max = Math.max(max, ch[i]);
  const path = (bins) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      // Light smoothing avoids comb artefacts from 8-bit sources.
      const v = (bins[Math.max(0, i - 1)] + 2 * bins[i] + bins[Math.min(255, i + 1)]) / 4;
      ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(v / max)) * (H - 2));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
  };
  ctx.globalCompositeOperation = 'lighter';
  const cols = [[h.r, 'rgba(255,70,80,0.55)'], [h.g, 'rgba(60,210,110,0.5)'], [h.b, 'rgba(70,120,255,0.6)']];
  for (const [bins, col] of cols) { path(bins); ctx.fillStyle = col; ctx.fill(); }
  ctx.globalCompositeOperation = 'source-over';
  path(h.l);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim() || 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
