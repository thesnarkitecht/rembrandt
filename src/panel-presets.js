// Presets: hover to preview on the photo, click to apply. Thumbnails render with the real engine.
import { el } from './util.js';
import { section, iconButton, button } from './ui.js';
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
    c.addEventListener('mouseenter', () => app.previewSettings(p.settings));
    c.addEventListener('mouseleave', () => app.previewSettings(null));
    c.addEventListener('click', () => {
      app.previewSettings(null);
      app.applySettings(p.settings, p.name);
    });
    cards.push({ cv, settings: p.settings });
    return c;
  }

  function build() {
    root.textContent = '';
    cards = [];
    const user = loadUser();
    const mine = section('Your presets', { id: 'presets-user', badge: { icon: 'save', color: 'linear-gradient(135deg,#34d399,#0ea5e9)' } });
    const nameInput = el('input', { class: 'text-input', id: 'presetName', value: `My preset ${user.length + 1}`, spellcheck: 'false', 'aria-label': 'Preset name' });
    const save = () => {
      const name = nameInput.value.trim();
      if (!name) return;
      saveUser([...user, { id: Date.now().toString(36), name, settings: developSettings(app.params) }]);
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
      const params = withSettings(app.params, c.settings, app.img.aspect);
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
