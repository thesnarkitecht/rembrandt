// Presets: hover to preview on the photo, click to apply. Thumbnails render with the real engine.
import { el } from './util.js';
import { section, iconButton, button, popMenu } from './ui.js';
import { prefs, savePrefs } from './account.js';
import { readRecipe } from './recipe.js';
import { PRESETS, developSettings, withSettings } from './params.js';

const KEY = 'lumen:presets';

function loadUser() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function saveUser(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full */ }
}

// Built-in presets followed by the user's own.
export const allPresets = () => [...PRESETS, ...loadUser().map((p) => ({ ...p, group: 'Your presets' }))];

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
    // Extras live in one ⋯ menu so the panel stays a grid of looks.
    const more = iconButton('more', 'Preset options', (e) => {
      e.stopPropagation();
      popMenu(e.currentTarget, [
        { label: 'Fit presets to each photo', checked: prefs.adaptivePresets !== false, onClick: () => { prefs.adaptivePresets = prefs.adaptivePresets === false; savePrefs(); renderThumbs(); app.toast(prefs.adaptivePresets ? 'Presets now start from each photo’s own exposure and tones' : 'Presets apply their exact values'); } },
        { label: 'Use the look of a photo…', icon: 'photos', onClick: fromPhoto },
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
    if (user.length) mine.body.append(el('div', { class: 'preset-grid' }, user.map((p) => card(p, true))));
    root.append(mine.el);

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
      const c = cards[i++];
      if (!c) { app.requestRender(); return; }
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

  build();
  return { el: root, refresh: () => {}, rebuild: build, thumbs: renderThumbs };
}
