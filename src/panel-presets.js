// Presets: hover to preview on the photo, click to apply. Thumbnails render with the real engine.
import { el } from './util.js';
import { section, iconButton, button, popMenu } from './ui.js';
import { prefs, savePrefs } from './account.js';
import { readRecipe } from './recipe.js';
import { importPresetFiles } from './lrpresets.js';
import { PRESETS, developSettings, withSettings } from './params.js';

const KEY = 'lumen:presets';

function loadUser() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function saveUser(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full */ }
}

// Built-in presets followed by the user's own.
export const allPresets = () => [...PRESETS, ...loadUser().map((p) => ({ ...p, group: p.lr ? lrGroup(p) : 'Your presets' }))];
// Imported Lightroom presets keep their Lightroom group, in sections of their own.
const lrGroup = (p) => `Lightroom · ${p.group || 'Imported'}`;

const PRESET_BADGE = {
  Color: { icon: 'drop', color: 'linear-gradient(135deg,#ff5f9e,#a55cff)' },
  Mood: { icon: 'sun', color: 'linear-gradient(135deg,#ffc04d,#ff7a1a)' },
  Film: { icon: 'fx', color: 'linear-gradient(135deg,#c08457,#7a4b2a)' },
  'B&W': { icon: 'contrast', color: 'linear-gradient(135deg,#d4d4d8,#52525b)' },
};

export function buildPresetsPanel(app) {
  const root = el('div', { class: 'panel-view' });
  let cards = [];

  function card(p, user) {
    const cv = el('canvas', { class: 'preset-thumb', width: 1, height: 1 });
    const c = el('button', { class: 'preset', title: `Apply ${p.name}` }, cv, el('span', { class: 'preset-name' }, p.name),
      user ? iconButton('trash', 'Delete preset', (e) => {
        e.stopPropagation();
        saveUser(loadUser().filter((x) => x.id !== p.id));
        build();
      }, 'sm preset-del') : null);
    c.addEventListener('mouseenter', () => app.previewSettings(app.presetLook(p)));
    c.addEventListener('mouseleave', () => app.previewSettings(null));
    c.addEventListener('click', () => {
      app.previewSettings(null);
      app.applySettings(app.presetLook(p), p.name);
    });
    cards.push({ cv, preset: p });
    return c;
  }

  function build() {
    root.textContent = '';
    cards = [];
    const user = loadUser();
    // Lightroom .xmp / .lrtemplate presets, or zip packs of them (lrpresets.js).
    const importLr = () => {
      const input = el('input', { type: 'file', multiple: true, accept: '.xmp,.lrtemplate,.zip,application/zip' });
      input.addEventListener('change', async () => {
        if (!input.files.length) return;
        try {
          const r = await importPresetFiles([...input.files]);
          if (!r.presets.length) { app.toast('No Lightroom presets found in those files'); return; }
          // Same name in the same group: the new one replaces the old.
          const key = (p) => `${p.group || ''}|${p.name}`;
          const fresh = new Set(r.presets.map(key));
          const list = loadUser().filter((p) => !(p.lr && fresh.has(key(p))));
          let n = 0;
          for (const p of r.presets) list.push({ id: `${Date.now().toString(36)}${(n++).toString(36)}`, name: p.name, group: p.group, lr: true, partial: true, settings: p.settings });
          saveUser(list);
          build();
          const groups = new Set(r.presets.map((p) => p.group || 'Imported')).size;
          const left = r.missing.length ? ` Not brought over: ${r.missing.map(([what, c]) => `${what} (${c})`).join(', ')}.` : '';
          app.toast(`Imported ${r.presets.length} preset${r.presets.length === 1 ? '' : 's'}${groups > 1 ? ` in ${groups} groups` : ''}.${left}`, { ms: left ? 10000 : 5000 });
        } catch (err) { app.toast(`Couldn't import: ${err.message}`); }
      });
      input.click();
    };
    // Extras live in one ⋯ menu so the panel stays a grid of looks.
    const more = iconButton('more', 'Preset options', (e) => {
      e.stopPropagation();
      popMenu(e.currentTarget, [
        { label: 'Fit presets to each photo', checked: prefs.adaptivePresets !== false, onClick: () => { prefs.adaptivePresets = prefs.adaptivePresets === false; savePrefs(); cards.forEach((c) => { c.done = false; }); renderThumbs(); app.toast(prefs.adaptivePresets ? 'Presets now start from each photo’s own exposure and tones' : 'Presets apply their exact values'); } },
        { label: 'Use the look of a photo…', icon: 'photos', onClick: fromPhoto },
        { label: 'Import Lightroom presets…', icon: 'presets', onClick: importLr },
      ]);
    }, 'sm');
    const mine = section('Your presets', { id: 'presets-user', right: more, badge: { icon: 'save', color: 'linear-gradient(135deg,#34d399,#0ea5e9)' } });
    const nameInput = el('input', { class: 'text-input', id: 'presetName', value: `My preset ${user.length + 1}`, spellcheck: 'false', 'aria-label': 'Preset name' });
    const save = () => {
      const name = nameInput.value.trim();
      if (!name) return;
      saveUser([...user, { id: Date.now().toString(36), name, ...app.lookOfCurrent(developSettings(app.params)) }]);
      app.toast(`Saved “${name}”`);
      build();
    };
    const form = el('div', { class: 'preset-save', hidden: true }, nameInput, button('Save', save, 'sm primary'));
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') form.hidden = true;
    });
    const open = button('Save current look', () => {
      form.hidden = false;
      open.hidden = true;
      nameInput.focus();
      nameInput.select();
    }, 'sm ghost', 'save');
    // "How was this edited?": the recipe inside a photo exported from Rembrandt (recipe.js).
    const fromPhoto = () => {
      const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const r = await readRecipe(file);
        if (!r) { app.toast('That photo has no Rembrandt recipe. Export with “Include how it was edited” to add one.'); return; }
        app.applySettings(r.settings);
        const name = file.name.replace(/\.[^.]+$/, '');
        app.toast(`Look of “${name}”: ${r.text.slice(0, 3).join(', ')}${r.text.length > 3 ? '…' : ''}`, {
          ms: 7000,
          action: { label: 'Save as preset', onClick: () => { saveUser([...loadUser(), { id: Date.now().toString(36), name, settings: r.settings }]); build(); } },
        });
      });
      input.click();
    };
    mine.body.append(open, form);
    const own = user.filter((p) => !p.lr);
    if (own.length) mine.body.append(el('div', { class: 'preset-grid' }, own.map((p) => card(p, true))));
    root.append(mine.el);

    // Imported Lightroom presets: one collapsed section per Lightroom group.
    const imported = user.filter((p) => p.lr);
    for (const g of [...new Set(imported.map(lrGroup))]) {
      const list = imported.filter((p) => lrGroup(p) === g);
      const s = section(g, { id: 'presets-lr-' + g, open: false, badge: { icon: 'presets', color: 'linear-gradient(135deg,#31a8ff,#0a5bd6)' } });
      s.body.append(el('div', { class: 'preset-grid' }, list.map((p) => card(p, true))));
      root.append(s.el);
    }

    const groups = [...new Set(PRESETS.map((p) => p.group))];
    for (const g of groups) {
      const s = section(g, { id: 'presets-' + g, badge: PRESET_BADGE[g] || PRESET_BADGE.Color });
      s.body.append(el('div', { class: 'preset-grid' }, PRESETS.filter((p) => p.group === g).map((p) => card(p, false))));
      root.append(s.el);
    }
    renderThumbs();
  }

  let job = 0;
  function renderThumbs() {
    const my = ++job;
    let i = 0;
    const step = () => {
      if (my !== job || !app.img || !root.isConnected) return;
      let c = cards[i++];
      // Cards in collapsed sections wait until their section opens.
      while (c && (c.done || !c.cv.offsetParent)) c = cards[i++];
      if (!c) { app.requestRender(); return; }
      c.done = true;
      const params = withSettings(app.params, app.presetLook(c.preset), app.img.aspect);
      params.masks = [];
      const img = app.renderSmall(params, 144);
      if (img) {
        c.cv.width = img.width;
        c.cv.height = img.height;
        c.cv.getContext('2d').putImageData(img, 0, 0);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Opening a section renders the thumbnails it shows.
  root.addEventListener('click', (e) => { if (e.target.closest('.sec-head')) requestAnimationFrame(renderThumbs); });
  build();
  return { el: root, refresh: () => {}, rebuild: build, thumbs: () => { cards.forEach((c) => { c.done = false; }); renderThumbs(); } };
}
