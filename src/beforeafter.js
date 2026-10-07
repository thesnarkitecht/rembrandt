// Before / after page: one self-contained HTML file with the original and the edit, and a slider to
// wipe between them. Nothing to host: it opens in any browser, can be emailed, posted, or dropped on
// any web host as is. The recipe of the edit can ride along as a "How was this edited?" list.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { BRAND } from './brand.js';
import { clone } from './util.js';
import { defaultParams } from './params.js';
import { renderExport } from './export.js';
import { describe, recipeOf } from './recipe.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

// The open photo before and after, framed the same way.
export async function renderBeforeAfter(app, { long = 2048, quality = 88 } = {}) {
  const p = app.params;
  const before = { ...defaultParams(app.img.aspect), geometry: clone(p.geometry), masks: [] };
  const opts = { format: 'jpeg', quality, long };
  const a = await renderExport(app, opts, before);
  const b = await renderExport(app, opts, p);
  return { before: a.blob, after: b.blob, w: b.w, h: b.h };
}

export async function beforeAfterPage(app, { title, recipe = true, long } = {}) {
  const r = await renderBeforeAfter(app, { long });
  const [before, after] = await Promise.all([dataUrl(r.before), dataUrl(r.after)]);
  const steps = recipe ? describe(recipeOf(app.params)) : [];
  const html = page({ title: title || app.img.name.replace(/\.[^.]+$/, ''), before, after, w: r.w, h: r.h, steps });
  return new Blob([html], { type: 'text/html' });
}

function page({ title, before, after, w, h, steps }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · before and after</title>
<meta name="generator" content="${esc(BRAND.name)}">
<style>
  :root { color-scheme: dark; --bg: #111; --fg: #eee; --muted: #999; --line: #fff; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; --bg: #f6f6f4; --fg: #1b1b1b; --muted: #666; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: min(1400px, 100%); margin: 0 auto; padding: 24px 16px 40px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 14px; }
  .ba { position: relative; width: 100%; aspect-ratio: ${w} / ${h}; max-height: 82vh; margin: 0 auto; overflow: hidden; border-radius: 10px; touch-action: none; user-select: none; cursor: ew-resize; background: #000; }
  .ba img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  .ba .after { clip-path: inset(0 0 0 var(--x, 50%)); }
  .bar { position: absolute; top: 0; bottom: 0; left: var(--x, 50%); width: 2px; margin-left: -1px; background: var(--line); box-shadow: 0 0 6px #0008; }
  .knob { position: absolute; top: 50%; left: 50%; width: 38px; height: 38px; margin: -19px; border-radius: 50%; background: var(--line); box-shadow: 0 1px 8px #0008; display: grid; place-items: center; color: #222; font-size: 14px; }
  .tag { position: absolute; top: 12px; padding: 3px 9px; border-radius: 99px; background: #000a; color: #fff; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
  .tag.l { left: 12px; } .tag.r { right: 12px; }
  .ba:focus-visible { outline: 2px solid var(--line); outline-offset: 3px; }
  details { margin-top: 18px; color: var(--muted); }
  summary { cursor: pointer; color: var(--fg); }
  ul { margin: 8px 0 0; padding-left: 20px; }
  footer { margin-top: 22px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <div class="ba" tabindex="0" role="slider" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
    <img src="${before}" alt="Before">
    <img class="after" src="${after}" alt="After">
    <span class="tag l">Before</span><span class="tag r">After</span>
    <div class="bar"><div class="knob">⟷</div></div>
  </div>
  ${steps.length ? `<details><summary>How was this edited?</summary><ul>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
  <footer>Edited with ${esc(BRAND.name)}. Drag across the photo, or use the arrow keys.</footer>
</main>
<script>
  const ba = document.querySelector('.ba');
  const set = (t) => { t = Math.max(0, Math.min(100, t)); ba.style.setProperty('--x', t + '%'); ba.setAttribute('aria-valuenow', Math.round(t)); };
  const at = (e) => { const r = ba.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
  let down = false;
  ba.addEventListener('pointerdown', (e) => { down = true; ba.setPointerCapture(e.pointerId); at(e); });
  ba.addEventListener('pointermove', (e) => { if (down) at(e); });
  ba.addEventListener('pointerup', () => { down = false; });
  ba.addEventListener('keydown', (e) => {
    const v = +ba.getAttribute('aria-valuenow');
    if (e.key === 'ArrowLeft') { set(v - 5); e.preventDefault(); }
    if (e.key === 'ArrowRight') { set(v + 5); e.preventDefault(); }
  });
</script>
</body>
</html>
`;
}
