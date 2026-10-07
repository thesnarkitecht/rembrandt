// ⌘K: say what you want. Plain words become edits ("warmer and a bit brighter", "moody", "blur the
// background"), previewed on the photo as you type; anything else finds the control ("vignette",
// "temperature") and takes you to it. Runs on this device: a small vocabulary, no language model.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp, clone, deepMerge, getPath, setPath } from './util.js';
import { HSL_NAMES } from './params.js';
import * as batch from './batch.js';
import { icon } from './icons.js';
import { allPresets } from './panel-presets.js';
import { buildEditPanel } from './panel-edit.js';
import { buildAIPanel } from './ai/panel-ai.js';
import { createStudio } from './studio.js';
import { measureTilt, straightened } from './tool-crop.js';

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
  [/\brefocus|\bout of focus|\bblurry|\bunblur|\bdeblur|\b(fix|sharpen) (the )?focus|\bin focus/, 'Refocus', ai('refocus', 'amount', 70)],
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

// ---- Exact requests: a control, a direction and a number. "down exposure by ten points",
// "shadows +25", "set contrast to 20", "exposure half a stop brighter", "blue saturation -30",
// "reset clarity". Slider units throughout; exposure in stops (points are hundredths of a stop).
// [words, path, label, lo, hi, decimals]. Earlier entries win, so "lens blur" beats "blur".
const CONTROLS = [
  [/\bexpos(ure|e)?\b|\bev\b/, 'exposure', 'Exposure', -5, 5, 2],
  [/\bcontrast\b/, 'contrast', 'Contrast'],
  [/\bhighlights?\b/, 'highlights', 'Highlights'],
  [/\bshadows?\b/, 'shadows', 'Shadows'],
  [/\bwhites?\b/, 'whites', 'Whites'],
  [/\bblacks?\b/, 'blacks', 'Blacks'],
  [/\btemp(erature)?\b|\bwarm(th|er)?\b|\bcool(er)?\b|\bwhite balance\b/, 'temp', 'Temperature'],
  [/\btint\b/, 'tint', 'Tint'],
  [/\bvibrance\b/, 'vibrance', 'Vibrance'],
  [/\bsaturation\b|\bsat\b/, 'saturation', 'Saturation'],
  [/\btexture\b/, 'texture', 'Texture'],
  [/\bclarity\b/, 'clarity', 'Clarity'],
  [/\bdehaze\b/, 'dehaze', 'Dehaze'],
  [/\bhaze\b/, 'haze', 'Haze'],
  [/\bvignette\b/, 'vignette.amount', 'Vignette'],
  [/\bgrain\b/, 'grain.amount', 'Grain', 0, 100],
  [/\bsharpen(ing|ness)?\b/, 'sharpen.amount', 'Sharpen', 0, 150],
  [/\bnoise( reduction)?\b|\bdenoise\b/, 'nr.luma', 'Noise reduction', 0, 100],
  [/\bcolou?r noise\b/, 'nr.chroma', 'Color noise', 0, 100],
  [/\benhance\b/, 'ai.enhance.amount', 'Enhance', 0, 100],
  [/\b(lens |background )?blur\b|\bbokeh\b/, 'ai.blur.amount', 'Lens blur', 0, 100],
  [/\batmosphere\b|\bfog\b/, 'ai.atmos.amount', 'Atmosphere', 0, 100],
  [/\bsun ?rays\b/, 'ai.rays.amount', 'Sunrays', 0, 100],
  [/\bskin\b/, 'ai.skin.amount', 'Skin', 0, 100],
  [/\brefocus\b/, 'ai.refocus.amount', 'Refocus', 0, 100],
];
const HUES = [/\breds?\b/, /\boranges?\b/, /\byellows?\b/, /\bgreens?\b/, /\b(cyans?|aquas?)\b/, /\bblues?\b/, /\b(lavenders?|purples?)\b/, /\bmagentas?\b/];
const HSL_PART = [[/\bhue\b/, 'hue', 'hue'], [/\bsat(uration)?\b/, 'sat', 'saturation'], [/\b(lum(inance)?|brightness)\b/, 'lum', 'luminance']];

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Number words → digits: "twenty-five" → 25, "one and a half" → 1.5, "half a stop" → 0.5 stop.
export function digits(t) {
  return t
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(TENS[a] + ONES.indexOf(b)))
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (w) => String(TENS[w]))
    .replace(/\b(a|one) hundred\b/g, '100')
    .replace(new RegExp(`\\b(${ONES.join('|')}) and a half\\b`, 'g'), (_, w) => String(ONES.indexOf(w) + 0.5))
    .replace(/\b(\d+) and a half\b/g, (_, n) => String(+n + 0.5))
    .replace(/\bhalf an? \b|\ba half\b|\bhalf\b/g, '0.5 ')
    .replace(/\ba (quarter|third)( of an?)?\b/g, (_, q) => (q === 'quarter' ? '0.25' : '0.33'))
    .replace(new RegExp(`\\b(${ONES.join('|')})\\b`, 'g'), (w) => String(ONES.indexOf(w)))
    .replace(/\ban? (stop|point)\b/g, '1 $1')
    .replace(/−/g, '-');
}

const UP = /\b(up|increase|raise|boost|more|add|plus|lift|brighter|higher|bump|push|warmer)\b/;
const DOWN = /\b(down|decrease|lower|reduce|drop|less|minus|subtract|cut|darker|cooler|take( off)?)\b/;
const RESET = /\b(reset|zero|clear|remove|no|none|neutral)\b/;
// One clause → { path, label, value, lo, hi, dp, says } with `value` the new slider value, or null.
function exact(s, p) {
  let path, label, lo = -100, hi = 100, dp = 0;
  const hue = HUES.findIndex((re) => re.test(s)), part = HSL_PART.find(([re]) => re.test(s));
  if (hue >= 0 && part && !/\bwhite balance\b/.test(s)) {
    path = `hsl.${part[1]}.${hue}`;
    label = `${HSL_NAMES[hue]} ${part[2]}`;
  } else {
    const c = CONTROLS.find(([re]) => re.test(s));
    if (!c) return null;
    [, path, label, lo = -100, hi = 100, dp = 0] = c;
  }
  if (path === 'temp' && /\bcool/.test(s) && !/\bwarm/.test(s)) s += ' down';
  const cur = getPath(p, path) || 0;
  const m = s.match(/([+-]?)\s*(\d+(?:\.\d+)?)\s*(%|points?|pts?|stops?|ev)?/);
  if (!m) {
    if (RESET.test(s) && !UP.test(s)) return { path, label, lo, hi, dp, value: 0 };
    // "more clarity", "a bit less texture": a step of the slider (vignette's slider runs the other way).
    if (!/\b(more|less|up|down|increase|decrease|raise|lower|reduce|boost)\b/.test(s) || /^(temp|ai\.)/.test(path)) return null;
    const k = strength(s.replace(/\b(less|reduce)\b/, '')) * (DOWN.test(s) ? -1 : 1) * (path === 'vignette.amount' ? -1 : 1);
    return { path, label, lo, hi, dp, value: clamp(+(cur + (path === 'exposure' ? 0.3 : 15) * k).toFixed(dp), lo, hi) };
  }
  let n = +m[2];
  const unit = m[3] || '';
  // Exposure is in stops; "10 points", "10%" or a number too big to be stops means hundredths.
  if (path === 'exposure' && (/^(p|%)/.test(unit) || (!/^(s|ev)/.test(unit) && n > 5))) n /= 100;
  // "by" or a sign: a change. "to", "at", "set": a value. Otherwise a direction word makes it a
  // change ("lower highlights 40"), and a bare number is the value ("contrast 20").
  const neg = /\b(minus|negative)\b/.test(s);
  const down = DOWN.test(s) && !UP.test(s.replace(DOWN, ''));
  let value;
  if (/\b(set|to|at)\b|=/.test(s) && !/\bby\b/.test(s)) value = m[1] === '-' || neg ? -n : n;
  else if (m[1]) value = cur + (m[1] === '-' ? -n : n);
  else if (/\bby\b/.test(s)) value = cur + (down || neg ? -n : n);
  else if (UP.test(s) || down) value = cur + (down ? -n : n);
  else value = neg ? -n : n;
  value = clamp(+value.toFixed(dp), lo, hi);
  return { path, label, lo, hi, dp, value };
}
const fmtV = (v, dp) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}`;

// Words → { patch, labels } against `p`, or null when nothing is understood.
export function interpret(text, p) {
  let next = clone(p), labels = [];
  const t = digits(text.toLowerCase().replace(/black and white/g, 'b&w'))
    // "exposure +0.5 contrast 20": a number followed by another control starts a new clause.
    .replace(/(\d(?:\.\d+)?\s*(?:%|points?|pts?|stops?|ev)?)\s+(?=[a-z])(?!(?:points?|pts?|stops?|ev|brighter|darker|warmer|cooler|up|down|higher|lower)\b)/g, '$1, ');
  for (const clause of t.split(/,|;|\band\b|\bthen\b|\bwith\b|\s\+\s/)) {
    const s = clause.trim();
    if (!s) continue;
    const x = exact(s, next);
    if (x) {
      setPath(next, x.path, x.value);
      labels.push(`${x.label} ${x.value === 0 && RESET.test(s) ? 'reset' : `to ${fmtV(x.value, x.dp)}`}`);
      continue;
    }
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

// ---- "Paste the edits from the previous photo", "same as photo 3", "match garden.jpg", "paste edits".
// → { clip, label } (clip as batch.pasteEdits takes it), { error } when it can't tell, or null.
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const PASTE_RE = /\b(paste|edits? from|settings from|look (from|of)|same (as|look)|match|copy (the )?(edits?|settings|look))\b/;
export function pasteSource(app, clause) {
  const t = digits(clause.toLowerCase());
  if (!PASTE_RE.test(t)) return null;
  const imgs = app.images, cur = app.cur;
  const name = (e) => e.name.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  let e, m;
  if (/\b(previous|prior|prev|last|before)\b/.test(t)) e = imgs[cur - 1];
  else if (/\bnext\b/.test(t)) e = imgs[cur + 1];
  else if ((m = t.match(/\b(?:photo|image|picture|pic|shot|number|no\.?|#)\s*#?(\d+)\b/))) e = imgs[+m[1] - 1];
  else if ((m = t.match(new RegExp(`\\b(${ORDINALS.join('|')})\\b`)))) e = imgs[ORDINALS.indexOf(m[1])];
  else e = imgs.find((x, i) => i !== cur && name(x).length > 2 && t.includes(name(x)));
  if (e && e !== imgs[cur]) {
    const { params, aspect } = app.editOfPhoto(e);
    return { clip: batch.takeEdits(params, batch.rememberedParts(), e.name, aspect), label: `Edits from ${e.name}` };
  }
  if (e === imgs[cur]) return { error: 'That’s this photo.' };
  if (/\b(previous|prior|prev|last|before|next|photo|image|picture|pic|shot|#)\b|\d/.test(t)) return { error: 'I can’t find that photo in the filmstrip.' };
  const c = batch.clipboard();
  return c ? { clip: c, label: `Pasted ${batch.describeClip(c)}` } : { error: 'Nothing copied yet. Try “paste the edits from the previous photo”.' };
}

let tiltMemo = { key: '', t: null };   // the tilt measurement is slowish; once per photo and framing

// Everything a request asks for, against `p`: pasted edits first, then the words on top.
// → { next, labels } | { error } | null.
export function understand(app, text, p) {
  const words = [];
  let next = p, labels = [];
  for (const clause of text.split(/,|;|\band\b|\bthen\b/i)) {
    // "straighten", "level the horizon", "it's crooked": measured from the photo's lines.
    if (/\bstraighten|\blevel\b|\bcrooked|\btilt(ed)?\b|\bhorizon\b/i.test(clause) && app.img) {
      const g = app.params.geometry, k = `${app.images[app.cur]?.id}|${g.rot90}|${g.flipH}|${g.flipV}`;
      if (tiltMemo.key !== k) tiltMemo = { key: k, t: measureTilt(app) };
      const t = tiltMemo.t;
      if (!t) return { error: 'I can’t find a horizon or straight lines to level this by.' };
      next = { ...next, geometry: straightened(app, next.geometry, t.angle) };
      labels.push(`Straighten ${t.angle > 0 ? '+' : ''}${t.angle.toFixed(1)}°`);
      continue;
    }
    const src = pasteSource(app, clause);
    if (!src) { words.push(clause); continue; }
    if (src.error) return { error: src.error };
    next = batch.pasteEdits(next, src.clip, app.img?.aspect || 1.5);
    labels.push(src.label);
  }
  const it = words.join(', ').trim() ? interpret(words.join(', '), next) : null;
  if (it) { next = it.next; labels = labels.concat(it.labels); }
  return labels.length ? { next, labels } : null;
}

// `mount`: an element to live in permanently (the left panel): the studio and its text box. Without
// it, a ⌘K overlay.
export function createCommandBar(app, mount = null) {
  const input = mount
    ? el('textarea', { class: 'cmd-input', rows: 1, spellcheck: 'false', enterkeyhint: 'send', 'aria-label': 'Tell Rembrandt what to change' })
    : el('input', { class: 'cmd-input', type: 'text', spellcheck: 'false', placeholder: 'Say what you want — “warmer and a bit brighter”, “shadows +25”, “paste the edits from the previous photo”…', 'aria-label': 'Edit by description or find a control' });
  const list = el('div', { class: 'cmd-list', role: 'listbox' });
  // Under the words, what Rembrandt understood, live: "Exposure to −0.10 · Shadows to +25".
  const reading = el('div', { class: 'chat-reading', 'aria-live': 'polite' });
  const send = el('button', { class: 'chat-send', type: 'button', 'aria-label': 'Do it' }, icon('send'));
  const box = mount
    ? el('div', { class: 'cmd-box' }, el('div', { class: 'cmd-field' }, input, send), reading, list)
    : el('div', { class: 'cmd-box' }, el('div', { class: 'cmd-field' }, icon('sparkle'), input, el('kbd', {}, 'esc')), list);
  // In the left panel: the studio (studio.js), a small Rembrandt that does the edits, and the box.
  const studio = mount ? createStudio(app) : null;
  const root = mount ? el('div', { class: 'cmd inline' }, studio.el, box) : el('div', { class: 'cmd', hidden: true }, box);
  (mount || document.body).append(root);
  let active = false;
  const grow = () => { if (!mount) return; input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 110)}px`; };
  if (mount) {
    send.addEventListener('pointerdown', (e) => e.preventDefault());
    send.addEventListener('click', () => run(sel));
    // Example requests take turns in the empty box.
    const EX = ['Tell me what to change…', 'exposure −0.3', 'paste from the last photo', 'shadows +25', 'set contrast to 20', 'same as photo 2', 'blue saturation −30', 'a bit warmer', 'golden hour'];
    let ex = 0;
    input.placeholder = EX[0];
    setInterval(() => { if (!active && !input.value) input.placeholder = EX[(ex = (ex + 1) % EX.length)]; }, 3200);
  }

  // Words in the studio: Rembrandt thinks, then makes each change on the photo in turn.
  function ask(q) {
    const it = understand(app, q, app.params);
    if (!it || it.error) { studio.record(q, it?.error || 'I don’t know that one yet. Try “exposure +0.3”, “warmer” or “paste the edits from the previous photo”.', app.params, app.params); return; }
    studio.perform(q, it.next, () => {
      app.preview = null;
      app.commit();
      app.rebuildPanel();
      app.aiEnsure();
    });
  }

  // Called after each edit settles: a new photo, a new greeting.
  let photo = null;
  function refresh() {
    if (!mount || !app.img) return;
    const id = app.images[app.cur]?.id;
    if (id !== photo) { photo = id; studio.hello(); }
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

  let rows = [], sel = 0, base = null, picked = false;
  function paint() {
    const q = input.value.trim();
    const it = q && base ? understand(app, q, base) : null;
    if (mount) {
      reading.textContent = it?.error || (it ? it.labels.join(' · ') : '');
      reading.className = `chat-reading${it?.error ? ' err' : it ? ' ok' : ''}`;
    }
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
    rows = [...(it && !it.error && !mount ? [{ kind: 'do', title: it.labels.join(' · '), hint: 'Apply', run: () => apply(it.next), preview: it.next }] : []), ...found].slice(0, 8);
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    list.replaceChildren(...rows.map((r, i) => {
      const row = el('div', { class: `cmd-row is-${r.kind}${i === sel ? ' on' : ''}`, role: 'option' },
        icon(r.kind === 'do' ? 'wand' : r.kind === 'preset' ? 'presets' : 'sliders'), el('span', { class: 'cmd-title' }, r.title), el('span', { class: 'cmd-hint' }, r.hint));
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paint(); } });
      row.addEventListener('click', () => { picked = true; run(i); });
      return row;
    }));
    if (!q && !mount) list.append(el('div', { class: 'cmd-empty' }, 'Try “brighter”, “shadows +25”, “golden hour”, “paste the edits from the previous photo”, or a control: “clarity”.'));
    // Show what the request, or the selected preset, would do, on the photo.
    const r = rows[sel];
    if (mount && it && !it.error && !(r?.kind === 'preset' && sel > 0)) { app.preview = it.next; app.requestRender(); }
    else if (r?.settings) app.previewSettings(r.settings);
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
    // In the studio, words always go to Rembrandt; a list row is used only when picked from the list.
    if (mount && q && (!r || !picked)) { picked = false; input.value = ''; grow(); root.classList.remove('typed'); return ask(q); }
    picked = false;
    r?.run();
    if (mount && r?.kind === 'preset') studio.record(q, `${r.title}, applied`, was, app.params);
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
    if (mount) { list.textContent = ''; reading.textContent = ''; root.classList.toggle('typed', !!input.value); root.classList.remove('active'); } else root.hidden = true;
    input.blur();
    app.preview = null;
    app.requestRender();
  }
  if (mount) {
    input.addEventListener('focus', () => { if (!active) open(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
    list.addEventListener('pointerdown', (e) => e.preventDefault());   // keep focus while clicking a row
  }
  input.addEventListener('input', () => { if (!active) open(); sel = 0; picked = false; grow(); paint(); root.classList.toggle('typed', !!input.value); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); picked = mount && rows.length > 0; paint(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(sel); }
  });
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  return { open, close, refresh, get isOpen() { return active; } };
}
