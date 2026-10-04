// ⌘K: say what you want. Plain words become edits ("warmer and a bit brighter", "moody", "blur the
// background"), previewed on the photo as you type; anything else finds the control ("vignette",
// "temperature") and takes you to it. Runs on this device: a small vocabulary, no language model.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp, clone, deepMerge, getPath } from './util.js';
import { withSettings } from './params.js';
import { icon } from './icons.js';
import { allPresets } from './panel-presets.js';
import { buildEditPanel } from './panel-edit.js';
import { buildAIPanel } from './ai/panel-ai.js';

const c100 = (v) => clamp(Math.round(v), -100, 100);
const add = (key, d, lo = -100, hi = 100) => (p, k) => ({ [key]: clamp(Math.round((p[key] + d * k) * 100) / 100, lo, hi) });
const ai = (key, field, v) => (p, k) => ({ ai: { [key]: { [field]: clamp(Math.round((p.ai[key][field] || 0) + v * k), 0, 100) } } });

// [pattern, label, change(params, strength) → patch]. Earlier entries win.
const INTENTS = [
  [/\bshadows?\b|\bdetail in the dark/, 'Shadows', (p, k) => ({ shadows: c100(p.shadows + 30 * k) })],
  [/\bhighlights?\b|\bsky\b|\bblown|\brecover/, 'Highlights', (p, k) => ({ highlights: c100(p.highlights - 30 * k) })],
  [/\bblur (the )?background|\bbokeh|\bportrait mode|\bdepth of field/, 'Lens blur', ai('blur', 'amount', 55)],
  [/\bfog|\bmist|\bhaz(e|y)\b(?! remov)|\batmospher/, 'Atmosphere', ai('atmos', 'amount', 40)],
  [/\bsun ?rays|\blight rays|\bgod rays/, 'Sunrays', ai('rays', 'amount', 55)],
  [/\bsmooth skin|\bskin\b|\bretouch/, 'Skin', ai('skin', 'amount', 45)],
  [/\benhance|\bauto\b|\bfix\b|\bimprove|\bbetter\b/, 'Enhance', ai('enhance', 'amount', 45)],
  [/\bgolden( hour)?|\bsunset/, 'Golden hour', (p, k) => ({ temp: c100(p.temp + 14 * k), ai: { sky: { warmth: clamp(Math.round(p.ai.sky.warmth + 45 * k), -100, 100) } } })],
  [/\bbright|\blight(er|en)?\b|\bexpos/, 'Exposure', add('exposure', 0.3, -5, 5)],
  [/\bdark(er|en)?\b|\bdim\b/, 'Exposure', add('exposure', -0.3, -5, 5)],
  [/\bpunch|\bpop\b|\bcontrast/, 'Contrast', (p, k) => ({ contrast: c100(p.contrast + 15 * k), clarity: c100(p.clarity + 6 * k) })],
  [/\bsoft(er)?\b|\bflat(ter)?\b|\bmatte/, 'Softer', (p, k) => ({ contrast: c100(p.contrast - 15 * k), clarity: c100(p.clarity - 8 * k) })],
  [/\bwarm/, 'Warmer', add('temp', 12)],
  [/\bcool|\bcold|\bblu(e|er)\b/, 'Cooler', add('temp', -12)],
  [/\bvivid|\bcolou?rful|\bsaturat|\bvibran/, 'Vibrance', add('vibrance', 20)],
  [/\bmuted|\bdesaturat|\bwashed/, 'Saturation', add('saturation', -20)],
  [/\bb ?& ?w\b|\bblack and white|\bmonochrome|\bgr[ae]y ?scale/, 'Black & white', () => ({ bw: true })],
  [/\bcolou?r\b(?! grad)/, 'Color', () => ({ bw: false })],
  [/\bsharp|\bcrisp/, 'Sharpen', (p, k) => ({ sharpen: { amount: clamp(Math.round(p.sharpen.amount + 30 * k), 0, 150) } })],
  [/\bclear|\bdehaze|\bhaze remov/, 'Dehaze', add('dehaze', 15)],
  [/\bvignette|\bdark(en)? (the )?(edges|corners)/, 'Vignette', (p, k) => ({ vignette: { amount: c100(p.vignette.amount - 20 * k) } })],
  [/\bgrain|\bfilm\b|\bnois(e|y)\b/, 'Grain', (p, k) => ({ grain: { amount: clamp(Math.round(p.grain.amount + 20 * k), 0, 100) } })],
];
const strength = (s) => (/\b(much|lot|very|way|really|super)\b/.test(s) ? 2 : /\b(bit|slight|little|touch|tad|hint)\b/.test(s) ? 0.5 : 1) * (/\b(less|no|remove|without|reduce)\b/.test(s) ? -1 : 1);

// Words → { patch, labels } against `p`, or null when nothing is understood.
export function interpret(text, p) {
  let next = clone(p), labels = [];
  const t = text.toLowerCase().replace(/black and white/g, 'b&w');
  for (const clause of t.split(/,|\band\b|\bthen\b|\bwith\b|\+/)) {
    const s = clause.trim();
    if (!s) continue;
    const hit = INTENTS.find(([re]) => re.test(s));
    if (!hit) continue;
    const k = strength(s);
    deepMerge(next, hit[2](next, k));
    labels.push(`${k < 0 ? 'Less ' : ''}${hit[1]}${Math.abs(k) === 2 ? ' ++' : Math.abs(k) === 0.5 ? ' (a little)' : ''}`);
  }
  return labels.length ? { next, labels } : null;
}

// What an edit changed, as [label, value] for the chat's reply.
const SHOWN = [['exposure', 'Exposure', 2], ['contrast', 'Contrast'], ['highlights', 'Highlights'], ['shadows', 'Shadows'], ['whites', 'Whites'], ['blacks', 'Blacks'],
  ['temp', 'Temperature'], ['tint', 'Tint'], ['vibrance', 'Vibrance'], ['saturation', 'Saturation'], ['texture', 'Texture'], ['clarity', 'Clarity'], ['dehaze', 'Dehaze'],
  ['vignette.amount', 'Vignette'], ['grain.amount', 'Grain'], ['sharpen.amount', 'Sharpen'], ['ai.enhance.amount', 'Enhance'], ['ai.blur.amount', 'Lens blur'],
  ['ai.atmos.amount', 'Atmosphere'], ['ai.rays.amount', 'Sunrays'], ['ai.skin.amount', 'Skin'], ['ai.sky.warmth', 'Golden sky']];
function changes(a, b) {
  if (!a || !b) return [];
  const out = SHOWN.flatMap(([path, label, dp = 0]) => {
    const d = (getPath(b, path) || 0) - (getPath(a, path) || 0);
    return Math.abs(d) < 1e-6 ? [] : [[label, `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(dp)}`]];
  });
  if (a.bw !== b.bw) out.unshift([b.bw ? 'Black & white' : 'Color', '']);
  return out;
}

// A few ideas for this photo, from its small render: exposure, clipping, cast and colour.
export function suggest(img) {
  const ideas = [];
  if (img) {
    const d = img.data, n = d.length / 4;
    let Y = 0, hi = 0, lo = 0, ch = 0, rb = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      Y += y; hi += y > 0.97; lo += y < 0.05; ch += Math.max(r, g, b) - Math.min(r, g, b); rb += r - b;
    }
    Y /= n; ch /= n; rb /= n;
    if (hi / n > 0.02) ideas.push('recover the highlights');
    if (lo / n > 0.12) ideas.push('lift the shadows');
    if (Y < 0.3) ideas.push('a bit brighter'); else if (Y > 0.68) ideas.push('a bit darker');
    if (ch < 0.12) ideas.push('more vivid');
    if (rb < -0.04) ideas.push('warmer'); else if (rb > 0.14) ideas.push('a little cooler');
  }
  for (const t of ['enhance', 'golden hour', 'b&w with grain', 'blur the background']) if (ideas.length < 4) ideas.push(t);
  return ideas.slice(0, 4);
}

// `mount`: an element to live in permanently (the left panel), as a chat; without it, a ⌘K overlay.
export function createCommandBar(app, mount = null) {
  const input = el('input', { class: 'cmd-input', type: 'text', spellcheck: 'false', placeholder: 'Say what you want — “warmer and a bit brighter”, “moody”, “blur the background”…', 'aria-label': 'Edit by description or find a control' });
  const list = el('div', { class: 'cmd-list', role: 'listbox' });
  const box = el('div', { class: 'cmd-box' }, el('div', { class: 'cmd-field' }, icon('sparkle'), input, mount ? null : el('kbd', {}, 'esc')), list);
  const log = el('div', { class: 'chat-log' });
  const send = el('button', { class: 'chat-send', type: 'button', 'aria-label': 'Apply' }, icon('send'));
  const looks = el('div', { class: 'chat-looks' });
  const root = mount
    ? el('div', { class: 'cmd inline' },
      el('div', { class: 'chat-head' }, el('img', { src: 'src/art/r-mark-halftone.svg', alt: '' }), el('span', {}, 'Rembrandt')),
      log, el('div', { class: 'chat-sub' }, 'Looks'), looks, box)
    : el('div', { class: 'cmd', hidden: true }, box);
  (mount || document.body).append(root);
  let active = false;
  if (mount) {
    box.querySelector('.cmd-field').append(send);
    send.addEventListener('pointerdown', (e) => e.preventDefault());
    send.addEventListener('click', () => run(sel));
    // Example requests take turns in the empty field.
    const EX = ['Say what you want…', 'warmer and a bit brighter', 'recover the sky', 'golden hour', 'b&w with grain', 'blur the background', 'less vignette'];
    let ex = 0;
    input.placeholder = EX[0];
    setInterval(() => { if (!active && !input.value) input.placeholder = EX[(ex = (ex + 1) % EX.length)]; }, 3200);
  }

  // A reply: typing dots, then the sentence writes itself out, then what changed, with Undo.
  function remember(q, did, was, now) {
    log.querySelector('.chat-hello')?.remove();
    log.querySelector('.chat-undo')?.remove();
    const said = el('span', { class: 'say' });
    const me = el('div', { class: 'chat-me typing' }, el('i'), el('i'), el('i'));
    log.append(el('div', { class: 'chat-you' }, q), me);
    while (log.children.length > 16) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    setTimeout(() => {
      const undo = el('button', { class: 'chat-undo', type: 'button' }, 'Undo');
      undo.addEventListener('click', () => { app.undo(); undo.remove(); me.classList.add('undone'); });
      const pills = changes(was, now);
      me.className = 'chat-me';
      me.replaceChildren(said, pills.length ? el('div', { class: 'chat-diff' }, ...pills.slice(0, 6).map(([l, v]) => el('span', {}, l, el('b', {}, v))),
        pills.length > 6 ? el('span', { class: 'more' }, `+${pills.length - 6}`) : null) : null, undo);
      let n = 0;
      const tick = () => { said.textContent = did.slice(0, (n += 2)); log.scrollTop = log.scrollHeight; if (n < did.length) requestAnimationFrame(tick); else me.classList.add('done'); };
      requestAnimationFrame(tick);
    }, 280);
  }

  // Greeting with ideas read from this photo (app.small: the small render the histogram keeps).
  function hello() {
    const ideas = suggest(app.small);
    log.replaceChildren(el('div', { class: 'chat-hello' },
      el('p', {}, 'What should this photo feel like?'),
      el('div', { class: 'chat-ideas' }, ...ideas.map((t) => {
        const b = el('button', { class: 'chat-idea', type: 'button' }, t);
        b.addEventListener('click', () => { const it = interpret(t, app.params); if (it) { const was = app.params; apply(it.next); remember(t, it.labels.join(' · '), was, it.next); } });
        return b;
      }))));
  }

  // Looks: every preset as a thumbnail of this photo. Hover previews it, a click applies it.
  let looksKey = '', looksJob = 0;
  function paintLooks() {
    if (!app.img || !app.engine?.L) return;
    const key = `${app.images[app.cur]?.id}|${JSON.stringify(app.params.geometry)}|${allPresets().length}`;
    if (key === looksKey) return;
    looksKey = key;
    const job = ++looksJob;
    const tiles = allPresets().map((p) => {
      const cv = el('canvas', { width: 1, height: 1 });
      const t = el('button', { class: 'look', type: 'button', title: `${p.name} · ${p.group}` }, cv, el('span', {}, p.name));
      t.addEventListener('mouseenter', () => app.previewSettings(p.settings));
      t.addEventListener('mouseleave', () => { if (!active) app.previewSettings(null); });
      t.addEventListener('click', () => {
        const was = app.params;
        app.previewSettings(null);
        app.applySettings(p.settings);   // no toast: the chat says it
        remember(p.name, `${p.name} applied`, was, app.params);
        t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit');
      });
      return { t, cv, p };
    });
    looks.replaceChildren(...tiles.map((x) => x.t));
    // Rendered a few at a time so the editor stays responsive.
    let k = 0;
    const step = () => {
      if (job !== looksJob || !app.img) return;
      for (const { cv, p } of tiles.slice(k, k += 3)) {
        const img = app.renderSmall(withSettings(app.params, p.settings, app.img.aspect), 96);
        if (!img) continue;
        cv.width = img.width; cv.height = img.height;
        cv.getContext('2d').putImageData(img, 0, 0);
      }
      if (k < tiles.length) setTimeout(step, 30); else app.requestRender();
    };
    setTimeout(step, 60);
  }
  looks.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { looks.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  // Called after each edit settles: a new photo starts a new conversation and new looks.
  let photo = null;
  function refresh() {
    if (!mount || !app.img) return;
    const id = app.images[app.cur]?.id;
    if (id !== photo) { photo = id; hello(); }
    else if (log.querySelector('.chat-hello')) hello();
    paintLooks();
  }

  // Every slider and section, by name, from the Edit and AI panels (built once, off screen).
  let index = null;
  const buildIndex = () => {
    index = [{ label: 'Crop & rotate', tool: 'crop' }, { label: 'Masks', tool: 'masks' }, { label: 'Remove spots', tool: 'retouch' }, { label: 'Presets', tool: 'presets' }];
    for (const [tool, build] of [['edit', buildEditPanel], ['ai', buildAIPanel]]) {
      for (const sec of build(app).el.querySelectorAll('.sec')) {
        const title = sec.querySelector('.sec-title')?.textContent || '';
        index.push({ label: title, tool, section: title });
        for (const l of sec.querySelectorAll('.ctl label')) index.push({ label: l.textContent, tool, section: title, control: l.textContent });
      }
    }
  };
  const score = (q, s) => { s = s.toLowerCase(); return s.startsWith(q) ? 3 : s.includes(q) ? 2 : 0; };

  let rows = [], sel = 0, base = null;
  function paint() {
    const q = input.value.trim();
    const it = q && base ? interpret(q, base) : null;
    const found = [];
    const lq = q.toLowerCase();
    if (lq.length > 1) {
      for (const p of allPresets()) if (score(lq, p.name)) found.push({ kind: 'preset', title: p.name, hint: `${p.group} preset`, settings: p.settings, run: () => app.applySettings(p.settings, mount ? undefined : p.name), score: score(lq, p.name) });
      if (!index) buildIndex();
      const seen = new Set();
      for (const c of index) {
        const sc = score(lq, c.label);
        const key = `${c.tool}|${c.section}|${c.control}`;
        if (sc && !seen.has(key)) { seen.add(key); found.push({ kind: 'go', title: c.label, hint: c.control ? `${c.section} · ${c.tool === 'ai' ? 'AI' : 'Edit'}` : c.tool === 'ai' ? 'AI' : c.section ? 'Edit' : 'Tool', run: () => goTo(c), score: sc }); }
      }
    }
    found.sort((a, b) => b.score - a.score);
    rows = [...(it ? [{ kind: 'do', title: it.labels.join(' · '), hint: 'Apply', run: () => apply(it.next), preview: it.next }] : []), ...found].slice(0, 8);
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    list.replaceChildren(...rows.map((r, i) => {
      const row = el('div', { class: `cmd-row is-${r.kind}${i === sel ? ' on' : ''}`, role: 'option' },
        icon(r.kind === 'do' ? 'wand' : r.kind === 'preset' ? 'presets' : 'sliders'), el('span', { class: 'cmd-title' }, r.title), el('span', { class: 'cmd-hint' }, r.hint));
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paint(); } });
      row.addEventListener('click', () => run(i));
      return row;
    }));
    if (!q) list.append(el('div', { class: 'cmd-empty' }, 'Try “brighter”, “recover the sky”, “golden hour”, “b&w with grain”, “less vignette”, or a control: “clarity”.'));
    // Show what the selected edit or preset would do, on the photo.
    const r = rows[sel];
    if (r?.settings) app.previewSettings(r.settings);
    else { app.preview = r?.preview || null; app.requestRender(); }
  }
  function apply(next) {
    const was = app.params;
    app.params = next;
    app.preview = null;
    app.commit();
    app.refreshPanel();
    app.aiEnsure();
    app.developFX?.play({ params: was, hold: new Promise((r) => setTimeout(r, 140)), minHold: 140 });
  }
  function goTo(c) {
    app.setTool(c.tool);
    if (!c.section) return;
    const sec = [...document.querySelectorAll('#panelBody .sec')].find((s) => s.querySelector('.sec-title')?.textContent === c.section);
    if (!sec) return;
    if (!sec.classList.contains('open')) sec.querySelector('.sec-head').click();
    const ctl = c.control && [...sec.querySelectorAll('.ctl')].find((x) => x.querySelector('label')?.textContent === c.control);
    const target = ctl || sec;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
    ctl?.querySelector('.val')?.focus();
  }
  function run(i) {
    const r = rows[i], q = input.value.trim(), was = app.params;
    close();
    r?.run();
    if (mount && (r?.kind === 'do' || r?.kind === 'preset')) remember(q, r.kind === 'preset' ? `${r.title} applied` : r.title, was, app.params);
  }
  function open() {
    if (!app.img) return;
    base = app.params;
    active = true;
    root.hidden = false;
    root.classList.add('active');
    if (!mount) input.value = '';
    sel = 0;
    paint();
    if (document.activeElement !== input) input.focus();
  }
  function close() {
    if (!active) return;
    active = false;
    if (mount) { input.value = ''; list.textContent = ''; root.classList.remove('active', 'typed'); } else root.hidden = true;
    input.blur();
    app.preview = null;
    app.requestRender();
  }
  if (mount) {
    input.addEventListener('focus', () => { if (!active) open(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
    list.addEventListener('pointerdown', (e) => e.preventDefault());   // keep focus while clicking a row
  }
  input.addEventListener('input', () => { if (!active) open(); sel = 0; paint(); root.classList.toggle('typed', !!input.value); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  return { open, close, refresh, get isOpen() { return active; } };
}
