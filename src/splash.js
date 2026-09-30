// Opening sequence: Rembrandt's 1659 self-portrait develops in as bronze halftone, left to right
// like a print coming up in the tray, while REMBRANDT rises letter by letter over it and a bronze
// line fills underneath; then the whole screen lifts away. About two and a half seconds. It plays every
// time the app opens or the page reloads; any key or click skips it, and it stays off for people who
// prefer reduced motion or turned it off in Preferences.
import { prefs } from './account.js';
import { BRAND } from './brand.js';

const HOLD = 2400;      // ms until it lifts
const PAINTING = 'src/art/selfportrait-1659.jpg';   // Rembrandt van Rijn, 1659, public domain
const DOTS = ['#8a5829', '#c98f4f', '#f4d292'];

function shouldPlay() {
  if (prefs.splash === false) return false;
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const clamp = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// The painting as a grid of brightness values, cropped to cover the canvas, contrast stretched.
function sample(img, cols, rows) {
  const c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const g = c.getContext('2d', { willReadFrequently: true });
  const s = Math.max(cols / img.width, rows / img.height), w = img.width * s, h = img.height * s;
  g.drawImage(img, (cols - w) / 2, (rows - h) * 0.28, w, h);
  const d = g.getImageData(0, 0, cols, rows).data, lum = new Float32Array(cols * rows);
  let lo = 1, hi = 0;
  for (let i = 0; i < lum.length; i++) { const v = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255; lum[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < lum.length; i++) lum[i] = Math.pow(clamp((lum[i] - lo) / Math.max(0.05, hi - lo)), 1.25);
  return lum;
}

function develop(canvas, img) {
  const dpr = Math.min(devicePixelRatio || 1, 2), r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const cell = 8 * dpr, cols = Math.ceil(canvas.width / cell), rows = Math.ceil(canvas.height / cell);
  const lum = sample(img, cols, rows), g = canvas.getContext('2d'), max = cell * 0.56, t0 = performance.now();
  const frame = (now) => {
    const t = clamp((now - t0) / 1500);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = lum[y * cols + x];
      const rad = max * Math.sqrt(v) * ease(clamp((t * 1.6 - (x / cols) * 0.6 - (1 - v) * 0.4) * 3));
      if (rad < 0.35) continue;
      const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell, p = paths[v < 0.38 ? 0 : v < 0.72 ? 1 : 2];
      p.moveTo(cx + rad, cy); p.arc(cx, cy, rad, 0, Math.PI * 2);
    }
    paths.forEach((p, k) => { g.fillStyle = DOTS[k]; g.fill(p); });
    if (t < 1 && canvas.isConnected) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const markup = () => `
  <canvas class="splash-art" aria-hidden="true"></canvas>
  <div class="splash-name">${BRAND.name.toUpperCase().split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
  <i class="splash-bar"></i>`;

function play() {
  const root = document.getElementById('splash');
  if (!root || !shouldPlay()) { root?.remove(); return; }
  const stage = root.querySelector('.splash-stage');
  stage.innerHTML = markup();
  stage.setAttribute('aria-label', BRAND.name);
  root.hidden = false;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    root.classList.add('out');
    setTimeout(() => root.remove(), 800);
    removeEventListener('keydown', finish, true);
  };
  root.addEventListener('pointerdown', finish);
  addEventListener('keydown', finish, true);
  // The painting develops as soon as it loads; if it's slow the name plays on its own.
  const img = new Image();
  img.onload = () => { if (!done) develop(stage.querySelector('.splash-art'), img); };
  img.src = PAINTING;
  // Start the letters once the font is in, so they don't swap mid-animation.
  const fonts = document.fonts ? Promise.race([document.fonts.load('200 64px Antonio'), new Promise((r) => setTimeout(r, 400))]) : Promise.resolve();
  fonts.then(() => requestAnimationFrame(() => root.classList.add('go')));
  setTimeout(finish, HOLD);
  setTimeout(finish, 5000); // never block the app, whatever happens to fonts
}

play();
