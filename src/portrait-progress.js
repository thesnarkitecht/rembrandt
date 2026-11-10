// Progress card for imports and uploads: Rembrandt's 1659 self-portrait drawn in dots, in black and
// white, that comes into colour as the work completes (colour rises from the bottom, dot by dot, with
// the dots swelling as they turn). One card serves every long job; `begin` returns a handle.
//
// Background jobs (Generative Expand, Remove, Super Resolution, HDR, Denoise…) get a card of their own,
// opened from the background-work list: the same dots, drawn from the job's own photo (`showJob`).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { icon } from './icons.js';
import { allJobs, onJobsChange, cancelJob, pauseJob, runNow, nightLabel } from './jobs.js';

const COLS = 46, ROWS = 57;
const PAINTING = new URL('./art/selfportrait-1659.jpg', import.meta.url).href;
const arts = new Map();
// A picture as a grid of cells (luminance, colour, and when each cell takes colour). Also used,
// smaller, by the studio in the left panel (command.js). `zoom` > 1 crops in on the face. With
// `fit`, the grid follows the picture's own shape (about `cells` dots) instead of COLS × ROWS.
export function loadArt(COLS = 46, ROWS = 57, zoom = 1, src = PAINTING, fit = 0) {
  const key = `${COLS}x${ROWS}x${zoom}|${fit}|${src}`;
  if (!arts.has(key)) arts.set(key, new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (fit) {
        const a = Math.min(2.2, Math.max(0.45, img.width / img.height));
        COLS = Math.max(12, Math.round(Math.sqrt(fit * a))); ROWS = Math.max(12, Math.round(fit / COLS));
      }
      const c = document.createElement('canvas');
      c.width = COLS; c.height = ROWS;
      const x = c.getContext('2d', { willReadFrequently: true });
      // Cover-fit, keeping the face (upper middle) in frame.
      const s = Math.max(COLS / img.width, ROWS / img.height) * zoom;
      const w = img.width * s, h = img.height * s;
      x.drawImage(img, (COLS - w) * (zoom > 1 ? 0.56 : 0.5), (ROWS - h) * (zoom > 1 ? 0.2 : fit ? 0.5 : 0.3), w, h);
      const d = x.getImageData(0, 0, COLS, ROWS).data;
      const cells = [];
      let lo = 1, hi = 0;
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const k = (j * COLS + i) * 4;
        const L = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255;
        lo = Math.min(lo, L); hi = Math.max(hi, L);
        // Colour arrives bottom first, with some grain so it reads as paint, not a wipe.
        const seed = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
        cells.push({ i, j, L, r: d[k], g: d[k + 1], b: d[k + 2], at: 0.72 * (1 - j / (ROWS - 1)) + 0.28 * (seed - Math.floor(seed)) });
      }
      for (const c of cells) c.L = Math.pow((c.L - lo) / Math.max(0.05, hi - lo), 0.55);
      cells.cols = COLS; cells.rows = ROWS;
      resolve(cells);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  }));
  return arts.get(key);
}

let card = null;
function ensureCard() {
  if (card) return card;
  const cv = el('canvas', { class: 'pp-art', 'aria-hidden': 'true' });
  const label = el('div', { class: 'pp-label' });
  const count = el('div', { class: 'pp-count' });
  const pct = el('div', { class: 'pp-pct' });
  const root = el('div', { class: 'pp-card', role: 'status', 'aria-live': 'polite' }, cv, el('div', { class: 'pp-text' }, label, el('div', { class: 'pp-row' }, count, pct)));
  document.body.append(root);
  card = { root, cv, label, count, pct, shown: 0, target: 0, raf: 0, jobs: new Set(), hideTimer: 0 };
  return card;
}

// Drawn at 30 fps from per-dot values computed once: the import it decorates shares the main thread.
function frame(now) { paintCard(card, now); }
function paintCard(c, now) {
  const again = () => (c.raf = requestAnimationFrame((t) => paintCard(c, t)));
  c.raf = 0;
  if (now - (c.last || 0) < 32) { again(); return; }
  c.last = now;
  const d = Math.min(2, window.devicePixelRatio || 1);
  const W = c.cv.clientWidth, H = c.cv.clientHeight;
  if (c.cv.width !== Math.round(W * d)) { c.cv.width = Math.round(W * d); c.cv.height = Math.round(H * d); c.dots = null; }
  const x = c.cv.getContext('2d');
  x.setTransform(d, 0, 0, d, 0, 0);
  x.clearRect(0, 0, W, H);
  c.shown += (c.target - c.shown) * 0.12;
  if (Math.abs(c.target - c.shown) < 0.002) c.shown = c.target;
  const p = c.shown;
  const cols = c.cells?.cols || COLS, rows = c.cells?.rows || ROWS;
  const cw = W / cols, ch = H / rows, t = now / 1000, unit = Math.min(cw, ch) * 0.5;
  // Per dot, once: centre, size, and the grey and full-colour fills (the in-between ones are mixed live).
  c.dots ||= (c.cells || []).map((s) => {
    const g = Math.round(60 + s.L * 190), col = [s.r, s.g, s.b].map((v) => Math.min(255, v * 1.25));
    return { s, cx: (s.i + 0.5 + (s.j & 1 ? 0.25 : -0.25)) * cw, cy: (s.j + 0.5) * ch, base: 0.16 + s.L * 0.9, g, col, grey: `rgb(${g},${g},${g})`, full: `rgb(${col.map(Math.round).join(',')})` };
  });
  for (const o of c.dots) {
    const s = o.s;
    // 0 = grey, 1 = full colour; the dot swells while it turns.
    const k = Math.min(1, Math.max(0, (p * 1.18 - s.at) / 0.18));
    const swell = k > 0 && k < 1 ? Math.sin(k * Math.PI) * 0.35 : 0;
    // Waiting (queued) breathes deeper, so a job that hasn't started still looks alive.
    const breathe = p < 1 ? (c.waiting ? 0.11 : 0.04) * Math.sin(t * (c.waiting ? 1.4 : 2) - s.j * 0.3 + s.i * 0.1) : 0;
    const r = unit * Math.min(1.1, o.base + swell + breathe);
    if (r < 0.3) continue;
    x.fillStyle = k === 0 ? o.grey : k === 1 ? o.full : `rgb(${Math.round(o.g + (o.col[0] - o.g) * k)},${Math.round(o.g + (o.col[1] - o.g) * k)},${Math.round(o.g + (o.col[2] - o.g) * k)})`;
    x.beginPath();
    x.arc(o.cx, o.cy, r, 0, Math.PI * 2);
    x.fill();
  }
  if (!c.job) c.pct.textContent = `${Math.round(c.target * 100)}%`;
  // A finished job keeps one slow glint crossing it, then rests.
  if (c.root.classList.contains('on') && (c.shown !== c.target || p < 1 || !c.settled)) { c.settled = p >= 1 && c.shown === c.target; again(); }
}

// Starts a job: `begin('Importing')` → { update(done, total, text?), finish(text?) }.
export function begin(title) {
  const c = ensureCard();
  clearTimeout(c.hideTimer);
  const job = { done: 0, total: 1 };
  c.jobs.add(job);
  const sum = () => {
    let d = 0, t = 0;
    for (const j of c.jobs) { d += j.done; t += j.total; }
    c.target = t ? Math.min(1, d / t) : 0;
  };
  c.label.textContent = title;
  c.count.textContent = '';
  if (!c.root.classList.contains('on')) { c.shown = 0; c.target = 0; }
  loadArt().then((cells) => {
    if (!cells) return;
    if (c.cells !== cells) { c.cells = cells; c.dots = null; }
    c.root.classList.add('on');
    if (!c.raf) c.raf = requestAnimationFrame(frame);
  });
  return {
    update(done, total, text) {
      job.done = done; job.total = Math.max(1, total);
      if (text) c.label.textContent = text;
      c.count.textContent = `${done} of ${total}`;
      sum();
    },
    finish(text) {
      job.done = job.total;
      sum();
      if (text) c.label.textContent = text;
      c.count.textContent = '';
      c.jobs.delete(job);
      if (c.jobs.size) return;
      c.target = 1;
      c.root.classList.add('done');
      c.hideTimer = setTimeout(() => { c.root.classList.remove('on', 'done'); }, 2200);
    },
  };
}

// ------------------------------------------------------------------ one background job, in its photo

// The card for a background job: its photo in dots, grey while it waits (breathing), colouring in
// from the bottom as the job works, a glint across it when it's done. Opened by clicking a job in the
// background-work list; the other jobs sit underneath as small thumbnails to switch to. `photo(job)`
// gives a job's preview (an image URL) or null.
let jc = null, photoOf = () => null, openPhoto = null;
export function setJobPhotos(fn, open) { photoOf = fn; openPhoto = open; }
export const jobPhoto = (j) => photoOf(j);

const live = (j) => j.state === 'running' || j.state === 'queued';
const whenText = (j) => (j.when === 'tonight' ? `Tonight, ${nightLabel()}` : j.when === 'away' ? 'When you’re away' : 'Up next');

function ensureJobCard() {
  if (jc) return jc;
  const cv = el('canvas', { class: 'pp-art', 'aria-hidden': 'true' });
  const kind = el('div', { class: 'pp-kind' });
  const label = el('div', { class: 'pp-label' });
  const count = el('div', { class: 'pp-count' });
  const pct = el('div', { class: 'pp-pct' });
  const bar = el('div', { class: 'pp-bar' }, el('span'));
  const acts = el('div', { class: 'pp-acts' });
  const queue = el('div', { class: 'pp-queue' });
  const close = el('button', { class: 'pp-close', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, icon('x'));
  const art = el('button', { class: 'pp-frame', type: 'button', title: 'Open' }, cv, el('i', { class: 'pp-glint' }));
  const root = el('div', { class: 'pp-card pp-job', role: 'dialog', 'aria-label': 'Background job' }, close, art,
    el('div', { class: 'pp-text' }, kind, label, el('div', { class: 'pp-row' }, count, pct), bar, acts, queue));
  document.body.append(root);
  jc = { root, cv, kind, label, count, pct, bar, acts, queue, art, shown: 0, target: 0, raf: 0, job: null, src: '' };
  close.addEventListener('click', hideJob);
  art.addEventListener('click', () => { const j = jc.job; if (j?.state === 'done' && j.open) { j.open(); hideJob(); } else if (j?.photoId && openPhoto) openPhoto(j.photoId); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('on')) hideJob(); });
  document.addEventListener('pointerdown', (e) => { if (root.classList.contains('on') && !root.contains(e.target) && !e.target.closest?.('.jobs-panel, .jobs-btn')) hideJob(); });
  onJobsChange(() => { if (root.classList.contains('on')) paintJob(); });
  return jc;
}

export function hideJob() { if (jc) { jc.root.classList.remove('on', 'done'); jc.job = null; } }

export function showJob(job) {
  const c = ensureJobCard();
  const changed = c.job !== job;
  c.job = job;
  if (changed) { c.shown = live(job) ? 0 : job.progress; c.settled = false; c.root.classList.remove('done'); }
  paintJob();
}

// Draws the job's photo: the original while it works, the result (if it has its own preview, say a
// wider Expand) once it's done: the frame reshapes and the result's dots come in from the bottom.
function jobArt() {
  const c = jc, src = photoOf(c.job) || PAINTING;
  const wake = () => { c.root.classList.add('on'); c.settled = false; if (!c.raf) c.raf = requestAnimationFrame((t) => paintCard(c, t)); };
  if (src === c.src && c.cells) { wake(); return; }
  const swap = !!c.cells && c.job?.state === 'done';
  c.src = src;
  loadArt(0, 0, 1, src, 1500).then((cells) => {
    if (c.src !== src || !cells) return;
    c.cells = cells; c.dots = null;
    if (swap) c.shown = 0.35;
    // The frame takes the photo's shape, inside a box of the same area as the portrait's.
    const a = cells.cols / cells.rows, area = 128 * 158;
    c.cv.style.width = `${Math.round(Math.min(200, Math.sqrt(area * a)))}px`;
    c.cv.style.height = `${Math.round(Math.min(200, Math.sqrt(area / a)))}px`;
    wake();
  });
}

function paintJob() {
  const c = jc, j = c.job;
  if (!j) return;
  // The title says what and which photo ("Generative Expand · IMG_2041.CR3"): the two halves get
  // their own lines.
  const [what, ...rest] = j.title.split(' · ');
  c.kind.textContent = what;
  c.label.textContent = rest.join(' · ') || what;
  const pct = Math.round(j.progress * 100);
  c.waiting = j.state === 'queued' || !!j.paused;
  c.target = j.state === 'done' ? 1 : j.progress;
  c.count.textContent = j.state === 'running' ? (j.paused ? 'Paused' : j.note || 'Working')
    : j.state === 'queued' ? whenText(j) : j.state === 'done' ? 'Done' : j.state === 'failed' ? 'Couldn’t finish' : 'Cancelled';
  c.pct.textContent = j.state === 'queued' ? '' : j.state === 'done' ? '100%' : j.state === 'running' ? `${pct}%` : '';
  c.bar.firstChild.style.width = `${j.state === 'done' ? 100 : pct}%`;
  c.root.classList.toggle('waiting', c.waiting);
  c.root.classList.toggle('failed', j.state === 'failed');
  if (j.state === 'done' && !c.root.classList.contains('done')) c.root.classList.add('done');
  c.root.dataset.state = j.state;
  c.art.title = j.state === 'done' && j.open ? 'Open the result' : 'Show the photo';
  const act = (name, label, fn, cls = '') => el('button', { class: `btn sm ${cls}`, type: 'button', onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name), el('span', {}, label));
  c.acts.replaceChildren(...[
    j.state === 'done' && j.open ? act('edit', 'Open', () => { j.open(); hideJob(); }, 'primary') : null,
    j.state === 'running' && !j.external ? act(j.paused ? 'redo' : 'minus', j.paused ? 'Resume' : 'Pause', () => pauseJob(j.id, !j.paused)) : null,
    j.state === 'queued' && j.when !== 'now' ? act('redo', 'Run now', () => runNow(j.id)) : null,
    live(j) ? act('x', 'Cancel', () => cancelJob(j.id), 'ghost') : null,
    j.state === 'failed' ? el('p', { class: 'pp-error' }, j.error || 'Something went wrong.') : null,
  ].filter(Boolean));
  // The rest of the queue, newest last, as thumbnails to switch to.
  const others = allJobs().filter((x) => x !== j && (live(x) || (x.state === 'done' && Date.now() - (x.finished || 0) < 120e3))).slice(-6);
  c.queue.replaceChildren(...others.map((x) => {
    const src = photoOf(x);
    const p = x.state === 'done' ? 100 : Math.round(x.progress * 100);
    return el('button', { class: `pp-q is-${x.state}`, type: 'button', title: x.title, style: `--p:${p}%`, onclick: (e) => { e.stopPropagation(); showJob(x); } },
      src ? el('img', { src, alt: '' }) : el('span', { class: 'pp-q-ph' }));
  }));
  c.queue.hidden = !others.length;
  jobArt();
}
