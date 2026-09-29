// Rasterises brush strokes (stored as vector data in image space) into per-mask canvases.

const LONG = 1536;
const cache = new Map(); // maskId -> entry
const sprites = new Map(); // hardness -> canvas

function sprite(hardness) {
  const key = Math.round(hardness * 20);
  let s = sprites.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 128;
  const ctx = s.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const inner = Math.min(0.98, key / 20);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(inner, 'rgba(255,255,255,1)');
  g.addColorStop(inner + (1 - inner) * 0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  sprites.set(key, s);
  return s;
}

const keyOf = (mask) => `${mask.brush.v}:${mask.brush.strokes.length}`;

function entry(mask, aspect) {
  const w = aspect >= 1 ? LONG : Math.round(LONG * aspect);
  const h = aspect >= 1 ? Math.round(LONG / aspect) : LONG;
  let e = cache.get(mask.id);
  if (!e || e.w !== w || e.h !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    e = { canvas, ctx: canvas.getContext('2d'), w, h, key: '', aspect, carry: 0 };
    cache.set(mask.id, e);
  }
  e.aspect = aspect;
  return e;
}

function dab(e, X, Y, stroke) {
  const x = (X / e.aspect + 0.5) * e.w;
  const y = (Y + 0.5) * e.h;
  const r = Math.max(0.5, stroke.size * e.h);
  const ctx = e.ctx;
  ctx.globalAlpha = stroke.flow;
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.drawImage(sprite(1 - stroke.feather), x - r, y - r, r * 2, r * 2);
}

function segment(e, stroke, i) {
  const pts = stroke.pts;
  if (i === 0) {
    dab(e, pts[0][0], pts[0][1], stroke);
    e.carry = 0;
    return;
  }
  const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
  const len = Math.hypot(x1 - x0, y1 - y0);
  const spacing = Math.max(stroke.size * 0.18, 0.0008);
  let d = spacing - e.carry;
  while (d <= len) {
    const t = d / len;
    dab(e, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, stroke);
    d += spacing;
  }
  e.carry = len - (d - spacing);
}

function redraw(e, mask) {
  e.ctx.globalCompositeOperation = 'source-over';
  e.ctx.globalAlpha = 1;
  e.ctx.clearRect(0, 0, e.w, e.h);
  for (const s of mask.brush.strokes) for (let i = 0; i < s.pts.length; i++) segment(e, s, i);
}

export function brushCanvas(mask, aspect) {
  const e = entry(mask, aspect);
  const key = keyOf(mask);
  if (e.key !== key) {
    redraw(e, mask);
    e.key = key;
  }
  return e;
}

// Incrementally draw the newest point of the last stroke (called while painting).
export function brushAppend(mask, aspect) {
  const e = entry(mask, aspect);
  const s = mask.brush.strokes[mask.brush.strokes.length - 1];
  if (s) segment(e, s, s.pts.length - 1);
  e.key = keyOf(mask);
  return e;
}

export function brushForget(id) {
  cache.delete(id);
}
