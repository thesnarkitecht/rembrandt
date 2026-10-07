// Edit replay: a short video of the photo developing, one step of the edit at a time (Light, then
// Colour, then Effects, …), each change named on screen. Good for showing how a photo was made.
//
// Each step is rendered once by the engine; playback cross-fades between them on a 2D canvas, which
// MediaRecorder captures in real time, so the video is smooth however long a render takes.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { BRAND } from './brand.js';
import { clone } from './util.js';
import { defaultParams, GROUPS } from './params.js';
import { describe } from './recipe.js';

const STEP_NAMES = {
  optics: 'Lens corrections', retouch: 'Spot removal', light: 'Light', color: 'Colour', effects: 'Effects', curve: 'Tone curve',
  mixer: 'Colour mixer', grading: 'Colour grading', detail: 'Detail', refocus: 'AI Refocus', lens: 'Lens blur', background: 'Background',
  enhance: 'Enhance', relight: 'Relight', sky: 'Sky', atmos: 'Atmosphere', rays: 'Light rays', skin: 'Skin', motion: 'Motion', masks: 'Masks',
};
const ORDER = ['optics', 'retouch', 'light', 'color', 'effects', 'curve', 'mixer', 'grading', 'detail', 'refocus', 'enhance', 'relight', 'sky', 'atmos', 'rays', 'skin', 'motion', 'lens', 'background', 'masks'];

const get = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
function put(o, path, v) {
  const ks = path.split('.');
  let t = o;
  for (const k of ks.slice(0, -1)) t = t[k];
  t[ks[ks.length - 1]] = clone(v);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The edit as a list of states: the original, then one more group of the edit switched on each step.
export function replaySteps(params, aspect) {
  const d = defaultParams(aspect);
  let cur = { ...clone(d), geometry: clone(params.geometry), masks: [] };
  const steps = [{ title: 'Original', lines: [], params: cur }];
  for (const g of ORDER) {
    const paths = GROUPS[g] || [];
    if (params.off?.[g]) continue;
    if (paths.every((p) => same(get(params, p), get(d, p)))) continue;
    const next = clone(cur);
    for (const p of paths) put(next, p, get(params, p));
    // What this step changed, in words.
    const only = clone(d);
    for (const p of paths) put(only, p, get(params, p));
    const lines = g === 'masks' ? params.masks.filter((m) => m.visible !== false).map((m) => m.name) : g === 'retouch' ? [`${params.retouch.length} spot${params.retouch.length === 1 ? '' : 's'}`] : describe(only);
    const title = STEP_NAMES[g] || g;
    steps.push({ title, lines: lines.map((l) => (l.startsWith(title + ': ') ? l.slice(title.length + 2) : l)), params: next });
    cur = next;
  }
  return steps;
}

export const replaySupported = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

// Renders and records the replay. `onProgress(text)`. Resolves to { blob, ext }.
export async function recordReplay(app, { long = 1080, onProgress = () => {} } = {}) {
  if (!replaySupported()) throw new Error('This browser can’t record video');
  const steps = replaySteps(app.params, app.img.aspect);
  if (steps.length < 2) throw new Error('There are no edits to replay yet');
  const frames = [];
  for (let i = 0; i < steps.length; i++) {
    onProgress(`Rendering step ${i + 1} of ${steps.length}…`);
    const img = app.renderSmall(steps[i].params, long);
    if (!img) throw new Error('The photo isn’t ready yet');
    frames.push(await createImageBitmap(img));
    await new Promise((r) => setTimeout(r, 0));
  }
  app.requestRender();
  // Even sizes keep video encoders happy.
  const w = frames[0].width & ~1, h = frames[0].height & ~1;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type || undefined, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  const font = Math.round(Math.max(16, h * 0.034));
  const caption = (step, alpha) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const lines = step.lines.slice(0, 4);
    const pad = font * 0.8, lh = font * 1.25;
    const boxH = pad * 2 + font * 1.15 + lines.length * lh * 0.82;
    const g = ctx.createLinearGradient(0, h - boxH * 1.6, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - boxH * 1.6, w, boxH * 1.6);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let y = h - pad - lines.length * lh * 0.82;
    ctx.fillText(step.title, pad, y);
    ctx.font = `400 ${Math.round(font * 0.72)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    for (const l of lines) { y += lh * 0.82; ctx.fillText(l.length > 70 ? l.slice(0, 68) + '…' : l, pad, y); }
    ctx.restore();
  };
  const mark = (alpha) => {
    ctx.save();
    ctx.globalAlpha = alpha * 0.8;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = font * 0.4;
    ctx.font = `500 ${Math.round(font * 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(BRAND.name, w - font * 0.8, font * 1.3);
    ctx.restore();
  };

  // Timeline: hold the original, then for each step a cross-fade and a hold; then hold the result.
  const HOLD = 1100, FADE = 900, END = 1800;
  const total = HOLD + (steps.length - 1) * (FADE + HOLD) + END;
  onProgress('Recording…');
  rec.start(250);
  const t0 = performance.now();
  await new Promise((done) => {
    const frame = () => {
      const t = performance.now() - t0;
      if (t >= total) { done(); return; }
      // Step j → j+1 takes FADE to cross-fade, then HOLD on the new state.
      let i = 0, k = 0;
      if (t > HOLD) {
        const u = t - HOLD, j = Math.floor(u / (FADE + HOLD)), v = u - j * (FADE + HOLD);
        if (j >= steps.length - 1) i = steps.length - 1;
        else if (v < FADE) { i = j; k = v / FADE; }
        else i = j + 1;
      }
      const ease = k * k * (3 - 2 * k);
      ctx.globalAlpha = 1;
      ctx.drawImage(frames[i], 0, 0, w, h);
      if (k > 0 && frames[i + 1]) { ctx.globalAlpha = ease; ctx.drawImage(frames[i + 1], 0, 0, w, h); ctx.globalAlpha = 1; }
      // Captions follow the step being faded in.
      const shown = k > 0 ? steps[i + 1] : steps[i];
      caption(shown, k > 0 ? Math.min(1, ease * 1.5) : 1);
      mark(1);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  frames.forEach((f) => f.close?.());
  const mime = rec.mimeType || type || 'video/webm';
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.includes('mp4') ? '.mp4' : '.webm' };
}
