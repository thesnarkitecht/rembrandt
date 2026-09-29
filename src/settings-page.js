// Settings: Preferences, Storage, Backup & data, About. Everything is stored on this device;
// Rembrandt has no accounts.
import { el, saveBlob } from './util.js';
import { segmented, slider, toggle, button } from './ui.js';
import { icon } from './icons.js';
import * as catalog from './catalog.js';
import { CONFIG, supportUrl } from './config.js';
import { exportDefaults, saveExportDefaults } from './export.js';
import { prefs, savePrefs } from './account.js';
import { getAppearance, setAppearance } from './theme.js';
import { ring, fmtBytes } from './ring.js';
import { BRAND } from './brand.js';

const SECTIONS = [
  ['prefs', 'Preferences', 'gear'],
  ['storage', 'Storage', 'cloud'],
  ['data', 'Backup & data', 'save'],
  ['about', 'About', 'info'],
];

export function buildSettingsPage(app, hooks) {
  const root = el('section', { class: 'acct-page', id: 'accountPage' });
  const nav = el('nav', { class: 'acct-nav', 'aria-label': 'Settings' });
  const body = el('div', { class: 'acct-main' });
  root.append(nav, body);
  let current = 'prefs';
  const toast = (m) => app.toast(m);
  const card = (title, ...kids) => el('section', { class: 'acct-card' }, title ? el('h2', {}, title) : null, ...kids);
  const busy = async (btn, f) => { btn.disabled = true; try { await f(); } catch (e) { toast(e.message); } finally { btn.disabled = false; } };
  const field = (label, ctl, hint) => el('div', { class: 'field' }, el('span', {}, label), ctl, hint ? el('span', { class: 'hint' }, hint) : null);

  function preferences() {
    const look = segmented([{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], getAppearance(), (v) => setAppearance(v));
    const rawQ = segmented([{ value: 0, label: 'Fast' }, { value: 3, label: 'Standard' }, { value: 4, label: 'Detailed' }], prefs.rawQuality, (v) => { prefs.rawQuality = v; savePrefs(); });
    const prevQ = segmented([{ value: 1920, label: 'Fast' }, { value: 2560, label: 'Balanced' }, { value: 4096, label: 'Sharp' }], prefs.previewLong, (v) => { prefs.previewLong = v; savePrefs(); hooks.previewChanged(v); });
    const fmt = segmented([{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }], exportDefaults.format, (v) => { exportDefaults.format = v; saveExportDefaults(); });
    const q = slider({ label: 'Export quality', min: 40, max: 100, def: 92, get: () => exportDefaults.quality, set: (v) => { exportDefaults.quality = v; }, commit: saveExportDefaults });
    return [
      card('Appearance', field('Theme', look.el), toggle('Opening animation', () => prefs.splash !== false, (v) => { prefs.splash = v; savePrefs(); }).el),
      card('Editing', field('RAW development', rawQ.el, 'Detailed is slower but resolves fine texture better.'), field('Preview resolution', prevQ.el, 'Sharp uses more graphics memory.')),
      card('Linked photos', toggle('Keep linked photos on this device', () => !!prefs.keepLinked, (v) => { prefs.keepLinked = v; savePrefs(); }).el,
        el('p', { class: 'hint' }, 'Off: photos linked from Google Photos, Drive, Dropbox or OneDrive take no space here. Rembrandt keeps a small preview and your edits; after a restart you pick a photo again to keep editing it. On: they open instantly, but use space on this device.')),
      card('Export', field('Default format', fmt.el), q.el),
    ];
  }

  function storage() {
    const out = [];
    const dev = el('div', { class: 'ring-card' }, el('p', { class: 'hint' }, 'Loading…'));
    out.push(el('div', { class: 'rings' }, dev));
    catalog.storageEstimate().then((est) => {
      dev.textContent = '';
      if (!est?.quota) { dev.append(el('p', { class: 'hint' }, 'Storage details are not available here.')); return; }
      const lib = est.details?.indexedDB ?? est.used;
      dev.append(
        ring([{ value: lib, color: 'var(--good)' }], est.quota, { size: 168, stroke: 16, top: fmtBytes(est.used), bottom: `of ${fmtBytes(est.quota)}` }),
        el('div', {}, el('div', { class: 'ring-label' }, icon('laptop'), 'This device'),
          el('div', { class: 'legend' },
            el('span', {}, el('i', { style: { background: 'var(--good)' } }), `Library · ${fmtBytes(lib)} (${app.images.length} photo${app.images.length === 1 ? '' : 's'})`),
            el('span', {}, el('i', { style: { background: 'var(--track)' } }), `Free · ${fmtBytes(Math.max(0, est.quota - est.used))}`))));
    });
    const protect = button('Keep library if space runs low', () => busy(protect, async () => {
      toast((await catalog.requestPersistence()) ? 'The browser will keep your library' : 'The browser declined; save a backup to be safe');
    }), 'sm ghost', 'shield');
    const free = button('Remove local copies of linked photos', () => busy(free, async () => {
      const n = await hooks.freeDeviceSpace();
      toast(n ? `Freed ${n} photo${n === 1 ? '' : 's'}; they stay where they're linked from` : 'No linked photos are stored on this device');
      render();
    }), 'sm ghost', 'download');
    out.push(card('Manage',
      el('p', { class: 'hint' }, 'Photos in synced folders stay in their folder and are never copied. Imported photos are kept in this browser or app. Linked photos (Google Photos, Drive, Dropbox, OneDrive) can be removed from here any time; your edits and previews stay.'),
      el('div', { class: 'row-btns' }, protect, free)));
    return out;
  }

  function data() {
    const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try { const n = await hooks.restoreBackup(JSON.parse(await f.text())); toast(`Restored edits for ${n} photo${n === 1 ? '' : 's'}`); } catch (e) { toast(`Couldn't read that backup: ${e.message}`); }
    });
    const backup = button('Save backup', async () => {
      const d = {
        app: BRAND.name, version: 1, savedAt: new Date().toISOString(),
        photos: app.images.map((e) => ({ key: e.key, name: e.name, rating: e.rating || 0, flag: e.flag || 0, params: e.params || null })),
        albums: hooks.albums(),
      };
      try { await saveBlob(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' }), `rembrandt-backup-${new Date().toISOString().slice(0, 10)}.json`); } catch (e) { if (e?.code !== 'declined') toast(`Backup failed: ${e.message}`); }
    }, 'sm', 'save');
    let armed = false;
    const clear = button('Clear library…', () => {
      if (!armed) { armed = true; clear.lastChild.textContent = `Remove all ${app.images.length} photos from Rembrandt?`; return; }
      hooks.clearLibrary().then(() => { toast('Library cleared'); render(); });
    }, 'sm danger', 'trash');
    return [
      card('Backup',
        el('p', { class: 'lead' }, 'A backup holds your edits, ratings, flags and albums (not the photo files). Restore it on another computer after importing the same photos. Synced folders also keep edits next to each photo as XMP.'),
        el('div', { class: 'row-btns' }, backup, button('Restore from backup…', () => fileIn.click(), 'sm ghost'), fileIn)),
      card('Clear library',
        el('p', { class: 'lead' }, 'Removes every photo and edit from Rembrandt on this device. Photos in synced folders, Google Photos and other services are not touched.'),
        el('div', { class: 'row-btns' }, clear)),
    ];
  }

  function about() {
    const v = window.LUMEN_BUILD?.version;
    const repo = `https://github.com/${CONFIG.repo}`;
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
    return [
      card(null, el('div', { class: 'about' },
        el('p', {}, el('b', {}, BRAND.name), v ? ` ${v}` : ''),
        el('p', {}, 'A free, source-available photo editor. No accounts, no ads, no tracking. Your photos stay on your computer, and AI runs on your device.'),
        el('p', {}, link(repo, 'Source code'), ' · ', link(`${repo}/releases`, 'Downloads'), ' · ', link(`${repo}/issues`, 'Report a problem')),
        el('p', { class: 'hint' }, 'Source-available under the PolyForm Shield License 1.0.0: use it, study it, change it, but don’t sell it. Image processing: ', el('b', {}, BRAND.engine), '. On-device AI: MediaPipe models (Apache-2.0). RAW decoding: LibRaw (LGPL-2.1 / CDDL-1.0).'))),
      card('Support Rembrandt',
        el('p', { class: 'lead' }, 'Rembrandt is free and stays free. If it’s useful to you, you can help keep it going: star it on GitHub, tell a friend, report bugs, or chip in.'),
        el('div', { class: 'row-btns' },
          button('Support Rembrandt', () => hooks.openSupport(), 'sm', 'heart'),
          el('a', { class: 'btn sm ghost', href: repo, target: '_blank', rel: 'noopener' }, icon('star'), el('span', {}, 'Star on GitHub')))),
    ];
  }

  const BUILD = { prefs: preferences, storage, data, about };

  function render() {
    nav.textContent = '';
    nav.append(el('button', { class: 'acct-back', onclick: () => hooks.back() }, icon('chevron', 'i back-chev'), 'Back'));
    for (const [id, label, ic] of SECTIONS) {
      const b = el('button', { class: 'acct-nav-item' + (id === current ? ' on' : ''), 'aria-current': id === current ? 'page' : null }, icon(ic), el('span', {}, label));
      b.addEventListener('click', () => { current = id; render(); });
      nav.append(b);
    }
    body.textContent = '';
    body.append(el('div', { class: 'acct-inner' }, el('h1', { class: 'acct-title' }, SECTIONS.find((s) => s[0] === current)[1]), ...BUILD[current]()));
  }

  return {
    el: root,
    show(section) { if (section && BUILD[section]) current = section; render(); body.scrollTop = 0; },
    render,
  };
}

export { supportUrl };
