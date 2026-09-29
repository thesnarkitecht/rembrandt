// Import dialog: one place to bring photos in from this device, a synced folder, the cloud
// (Google Photos, Google Drive, Dropbox, OneDrive, iCloud) or Adobe Lightroom.
import { el } from './util.js';
import { button } from './ui.js';
import { icon } from './icons.js';
import { CLOUD_SOURCES, pickLinked } from './import-cloud.js';
import * as folders from './folders.js';
import { readCatalog } from './lrcat.js';
import { ACCEPT } from './loader.js';
import { adobeReady, adobeSignedIn } from './adobe.js';
import { fmtBytes } from './ring.js';

const LOGO = {
  gphotos: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FBBC04" d="M12 12V3.5A4.3 4.3 0 0 0 7.7 7.8V12z"/><path fill="#EA4335" d="M12 12h8.5a4.3 4.3 0 0 0-4.3-4.3H12z"/><path fill="#4285F4" d="M12 12v8.5a4.3 4.3 0 0 0 4.3-4.3V12z"/><path fill="#34A853" d="M12 12H3.5a4.3 4.3 0 0 0 4.3 4.3H12z"/></svg>',
  gdrive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0F9D58" d="M8.3 3.5h7.4l6.8 11.8h-7.4z"/><path fill="#4285F4" d="M22.5 15.3l-3.7 6.2H5.2l3.7-6.2z"/><path fill="#FBBC04" d="M8.3 3.5l3.7 6.3-6.8 11.7-3.7-6.2z"/></svg>',
  dropbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0061FF" d="M7 3 2 6.3l5 3.2 5-3.2zm10 0-5 3.3 5 3.2 5-3.2zM2 12.7 7 16l5-3.3-5-3.2zm15-3.2-5 3.2L17 16l5-3.3zM7 17.1l5 3.3 5-3.3-5-3.2z"/></svg>',
  onedrive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0364B8" d="M9.7 8.6A6 6 0 0 1 20 11.2a4 4 0 0 1 .3 7.8H8.5z"/><path fill="#1490DF" d="M9.7 8.6 8.5 19H5.3a4.3 4.3 0 0 1-.8-8.5 5.3 5.3 0 0 1 5.2-1.9z"/><path fill="#28A8EA" d="M20.3 19H8.5l5-6.5 6.8 6.5z" opacity=".8"/></svg>',
  icloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="icg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3E9BF7"/><stop offset="1" stop-color="#1A6FE0"/></linearGradient></defs><path fill="url(#icg)" d="M7 19a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.3-1.3A5.2 5.2 0 0 1 17.5 19z"/></svg>',
};

const platform = () => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
};
const fmt = (n) => n.toLocaleString();

// api: { chooseFiles, chooseFolder(onFiles?), openFiles(files, opts), syncFolder(folder|null, opts), applyCatalog(cat), toast }
export function openImport(app, api, page = 'home') {
  const dlg = document.getElementById('importDialog');
  const desktop = !!window.__TAURI_INTERNALS__;
  const sync = folders.support();
  const status = el('div', { class: 'export-status' });
  const setStatus = (t, cls = '') => { status.textContent = t; status.className = 'export-status ' + cls; };
  const close = () => dlg.close();
  const pick = (accept, multiple = true, dir = false) => new Promise((resolve) => {
    const i = el('input', { type: 'file', accept, multiple, hidden: true });
    if (dir) i.webkitdirectory = true;
    i.addEventListener('change', () => { resolve([...i.files]); i.remove(); });
    i.addEventListener('cancel', () => { resolve([]); i.remove(); });
    document.body.append(i);
    i.click();
  });

  const tile = (logo, name, sub, onClick, { disabled = false, cls = '' } = {}) => el('button', { class: 'src-tile ' + cls, disabled, onclick: onClick, type: 'button' },
    el('span', { class: 'src-logo' }, typeof logo === 'string' && logo.startsWith('<') ? el('span', { html: logo }) : icon(logo)),
    el('span', { class: 'src-text' }, el('b', {}, name), sub ? el('span', {}, sub) : null));
  const head = (title, back) => el('div', { class: 'dlg-head row between' },
    back ? el('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => show('home') }, el('span', { class: 'flip' }, icon('chevron'))) : null,
    el('h2', { class: 'grow' }, title),
    el('button', { class: 'icon-btn dlg-x', 'aria-label': 'Close', onclick: close }, icon('x')));

  function home() {
    // 1. From this device: a big target that also takes drops directly.
    const drop = el('div', { class: 'imp-drop', tabindex: 0, role: 'button', 'aria-label': 'Choose photos from this device' },
      el('span', { class: 'imp-drop-icon' }, icon('upload')),
      el('b', {}, 'Drag photos here'),
      el('span', { class: 'imp-drop-sub' }, 'or'),
      el('div', { class: 'row-btns center' },
        button('Choose photos', (e) => { e.stopPropagation(); close(); api.chooseFiles(); }, 'primary', 'files'),
        button('Choose a folder', (e) => { e.stopPropagation(); close(); api.chooseFolder(); }, 'ghost', 'folder')),
      el('span', { class: 'imp-drop-hint' }, 'JPEG, HEIC, PNG, TIFF and RAW from 1,000+ cameras · as many as you like'));
    drop.addEventListener('click', () => { close(); api.chooseFiles(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); api.chooseFiles(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      drop.classList.remove('over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) { close(); api.openFiles(files); }
    });

    // 2. Linked from the cloud: originals stay there.
    const clouds = el('div', { class: 'imp-clouds' },
      ...CLOUD_SOURCES.map((s, i) => {
        const cls = i === 0 ? 'big' : '';
        if (desktop) {
          if (!s.folder) return tile(LOGO[s.icon], s.name, 'In the web app', () => setStatus('Google Photos has no folder on your computer. Link photos from Rembrandt in your browser (the web version or rembrandt-server) instead.'), { cls });
          return tile(LOGO[s.icon], s.name, `Sync your ${s.folder} folder`, async () => { close(); await api.syncFolder(null); }, { cls });
        }
        const ready = s.ready();
        return tile(LOGO[s.icon], s.name, ready ? (i === 0 ? 'Choose photos to link' : 'Link photos') : 'Coming soon', () => runCloud(s), { disabled: !ready, cls });
      }),
      tile(LOGO.icloud, 'iCloud Photos', platform() === 'ios' ? 'Choose from Photos' : 'How to import', () => show('icloud')));

    // 3. More ways.
    const syncCard = el('button', { class: 'src-card', type: 'button', disabled: !sync, onclick: async () => { close(); await api.syncFolder(null); } },
      el('span', { class: 'src-logo big' }, icon('sync')),
      el('span', { class: 'src-text' },
        el('b', {}, 'Sync a folder'),
        el('span', {}, sync ? 'Photos stay in the folder; new ones appear automatically.' : 'Needs the desktop app, or Chrome or Edge.')),
      icon('chevron'));
    const lr = el('button', { class: 'src-card', type: 'button', onclick: () => show('lightroom') },
      el('span', { class: 'src-logo big lr' }, icon('sliders')),
      el('span', { class: 'src-text' }, el('b', {}, 'Adobe Lightroom'), el('span', {}, 'Photos, edits, ratings and collections.')),
      icon('chevron'));

    return [
      head('Import photos'),
      el('div', { class: 'dlg-body imp-body' },
        drop,
        el('div', { class: 'imp-section' },
          el('div', { class: 'imp-label' }, el('span', {}, 'Link from the cloud'), el('span', { class: 'imp-badge' }, 'Uses no storage')),
          clouds,
          el('p', { class: 'src-note' }, 'Linked photos stay in Google Photos, Drive, Dropbox or OneDrive. Rembrandt keeps your edits and a small preview.')),
        el('div', { class: 'imp-section' },
          el('div', { class: 'imp-label' }, el('span', {}, 'More ways')),
          el('div', { class: 'imp-more' }, syncCard, lr)),
        status),
    ];
  }

  async function runCloud(s) {
    try {
      setStatus(`Opening ${s.name}…`, 'busy');
      const files = await pickLinked(s, (t) => setStatus(t, 'busy'));
      if (!files.length) { setStatus(''); return; }
      setStatus('');
      close();
      await api.openFiles(files);
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function icloud() {
    const os = platform();
    const steps = el('div', { class: 'src-steps' });
    const step = (title, text, action) => steps.append(el('div', { class: 'src-step' }, el('b', {}, title), el('p', {}, text), action || null));
    if (os === 'ios') {
      step('From your Photos library', 'Your iCloud Photos appear in the picker, including photos stored only in iCloud.', button('Choose from Photos', async () => {
        const files = await pick('image/*');
        if (files.length) { close(); api.openFiles(files); }
      }, 'sm primary', 'phone'));
    }
    if (os === 'mac') {
      step('From the Photos app', 'Select photos in Photos and drag them onto this window. For untouched originals, use File → Export → Export Unmodified Original, then import that folder.');
    }
    if (os === 'windows') {
      step('With iCloud for Windows', 'iCloud for Windows keeps your iCloud Photos in a folder (usually Pictures › iCloud Photos). Sync that folder and new photos arrive on their own.',
        sync ? button('Sync the iCloud Photos folder', async () => { close(); await api.syncFolder(null); }, 'sm primary', 'sync') : null);
    }
    step('From iCloud Drive', 'Photos you keep in iCloud Drive can be synced like any folder. Edits are saved next to them, so they follow you to your other Apple devices.',
      sync ? button('Sync an iCloud Drive folder', async () => { close(); await api.syncFolder(null); }, 'sm ghost', 'folder') : null);
    step('From iCloud.com', 'On any computer: sign in at icloud.com/photos, select photos, download them, and drop them here.',
      el('a', { class: 'btn sm ghost', href: 'https://www.icloud.com/photos/', target: '_blank', rel: 'noopener' }, 'Open iCloud.com'));
    return [
      head('Import from iCloud', true),
      el('div', { class: 'dlg-body' }, el('p', { class: 'hint' }, 'Apple doesn’t let other apps read iCloud Photos directly, so use whichever of these fits.'), steps, status),
    ];
  }

  function lightroom() {
    const catBox = el('div', { class: 'src-step' });
    const paintCat = (cat) => {
      catBox.textContent = '';
      catBox.append(el('b', {}, 'Lightroom Classic catalog'));
      if (!cat) {
        catBox.append(
          el('p', {}, 'Brings over develop settings, ratings, picks and collections (as albums). Your catalog is only read, never changed.'),
          button('Choose catalog (.lrcat)…', async () => {
            const [file] = await pick('.lrcat', false);
            if (!file) return;
            try {
              const c = await readCatalog(file, (t) => setStatus(t, 'busy'));
              setStatus('');
              api.pendingCatalog = c;
              paintCat(c);
            } catch (e) { setStatus(e.message, 'error'); }
          }, 'sm primary', 'files'),
          el('p', { class: 'hint' }, platform() === 'mac' ? 'Usually in Pictures › Lightroom.' : 'Usually in Pictures\\Lightroom.'));
        return;
      }
      const edited = cat.photos.filter((p) => p.crs).length;
      const matches = api.catalogMatches(cat);
      catBox.append(
        el('p', {}, `${fmt(cat.photos.length)} photos, ${fmt(edited)} with edits, ${fmt(cat.collections.length)} collection${cat.collections.length === 1 ? '' : 's'}.`),
        cat.roots.length ? el('ul', { class: 'src-roots' }, cat.roots.slice(0, 4).map((r) => el('li', {}, el('code', {}, r.path || r.name), ` · ${fmt(r.count)}`))) : null,
        el('p', {}, sync ? 'Now choose the folder that holds these photos. It stays in sync, and your photos stay where they are.' : 'Now choose the folder that holds these photos.'),
        el('div', { class: 'row-btns' },
          sync ? button('Sync the photos folder', async () => { close(); await api.syncFolder(null, { catalog: cat }); }, 'sm primary', 'sync')
            : button('Choose the photos folder', async () => {
              const files = await pick(ACCEPT, true, true);
              if (files.length) { close(); await api.openFiles(files, { catalog: cat }); }
            }, 'sm primary', 'folder'),
          matches ? button(`Update ${fmt(matches)} photo${matches === 1 ? '' : 's'} already here`, async () => { const n = await api.applyCatalog(cat); setStatus(`Updated ${fmt(n)} photos from Lightroom.`); }, 'sm ghost', 'check') : null));
    };
    paintCat(api.pendingCatalog || null);

    // ---- Lightroom (cloud)
    const cloudBox = el('div', { class: 'src-step' });
    let filter = 'all';
    const paintCloud = (cat) => {
      cloudBox.textContent = '';
      cloudBox.append(el('b', {}, 'Lightroom (cloud)'));
      if (!adobeReady()) {
        cloudBox.append(el('p', {}, 'Connect your Adobe account to bring over your Lightroom photos, edits, ratings, flags and albums.'), el('p', { class: 'hint' }, 'Available at launch.'));
        return;
      }
      if (!cat) {
        const read = async () => {
          try {
            const c = await api.readLightroomCloud((t) => setStatus(t, 'busy'));
            setStatus('');
            api.pendingCloud = c;
            paintCloud(c);
          } catch (e) { setStatus(e.message, 'error'); }
        };
        cloudBox.append(
          el('p', {}, 'Bring over your Lightroom photos with their edits, ratings, flags and albums. You sign in on Adobe’s own page; we never see your password.'),
          el('div', { class: 'row-btns' }, adobeSignedIn()
            ? button('Read my Lightroom library', read, 'sm primary', 'sync')
            : button('Connect Adobe account', async () => {
              try { setStatus('Waiting for Adobe sign-in…', 'busy'); await api.adobeConnect(); await read(); } catch (e) { setStatus(e.message, 'error'); }
            }, 'sm primary', 'user')));
        return;
      }
      const edited = cat.photos.filter((p) => p.crs).length;
      const chosen = () => (filter === 'best' ? cat.photos.filter((p) => p.flag === 1 || p.rating > 0) : cat.photos.filter((p) => p.flag !== -1));
      const bytes = (list) => list.reduce((a, p) => a + (p.size || 0), 0);
      const matches = api.catalogMatches(cat);
      const count = el('span');
      const paintCount = () => { const l = chosen(); count.textContent = `${fmt(l.length)} photos · up to ${fmtBytes(bytes(l))}`; };
      const pickSeg = el('div', { class: 'seg seg-sm' }, ...[['all', 'All photos'], ['best', 'Picks and rated']].map(([v, label]) => {
        const b = el('button', { class: 'seg-btn' + (filter === v ? ' on' : ''), type: 'button' }, label);
        b.addEventListener('click', () => { filter = v; pickSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b)); paintCount(); });
        return b;
      }));
      paintCount();
      cloudBox.append(
        el('p', {}, `${cat.account.email ? cat.account.email + ': ' : ''}${fmt(cat.photos.length)} photos, ${fmt(edited)} with edits, ${fmt(cat.collections.length)} album${cat.collections.length === 1 ? '' : 's'}.`),
        el('div', { class: 'src-sub' },
          el('b', {}, 'Download the edited photos'),
          el('p', {}, 'Full-size JPEGs exactly as Lightroom shows them, with your ratings, flags and albums. Rejected photos are skipped.'),
          pickSeg, el('p', { class: 'hint' }, count),
          el('div', { class: 'row-btns' }, button('Download', async () => { close(); await api.downloadLightroom(cat, chosen()); }, 'sm primary', 'download'))),
        el('div', { class: 'src-sub' },
          el('b', {}, 'Keep editing the originals'),
          el('p', {}, 'Adobe doesn’t let other apps download your originals, but Lightroom can keep a copy on your computer: in Lightroom, open Preferences › Local Storage and turn on “Store a copy of all originals”. Then sync that folder here and your edits, ratings and albums are applied to it.'),
          el('div', { class: 'row-btns' },
            sync ? button('Sync the originals folder', async () => { close(); await api.syncFolder(null, { catalog: cat }); }, 'sm ghost', 'folder')
              : button('Choose the originals folder', async () => {
                const files = await pick(ACCEPT, true, true);
                if (files.length) { close(); await api.openFiles(files, { catalog: cat }); }
              }, 'sm ghost', 'folder'),
            matches ? button(`Update ${fmt(matches)} photo${matches === 1 ? '' : 's'} already here`, async () => { const n = await api.applyCatalog(cat); setStatus(`Updated ${fmt(n)} photos from Lightroom.`); }, 'sm ghost', 'check') : null)));
    };
    paintCloud(api.pendingCloud || null);

    const xmpBox = el('div', { class: 'src-step' },
      el('b', {}, 'Photos with Lightroom or Camera Raw edits'),
      el('p', {}, 'Choose the photos together with their .xmp sidecars, or a whole folder. Edits saved inside DNG, JPEG and TIFF files are picked up too.'),
      el('div', { class: 'row-btns' },
        button('Choose files…', async () => {
          const files = await pick(ACCEPT + ',.xmp');
          if (files.length) { close(); await api.openFiles(files, { adobe: true }); }
        }, 'sm primary', 'files'),
        button('Choose a folder…', async () => {
          const files = await pick(ACCEPT + ',.xmp', true, true);
          if (files.length) { close(); await api.openFiles(files, { adobe: true }); }
        }, 'sm ghost', 'folder')),
      el('p', { class: 'hint' }, 'Also works with Lightroom’s File › Export › Original + Settings.'));

    return [
      head('Import from Adobe Lightroom', true),
      el('div', { class: 'dlg-body' }, el('div', { class: 'src-steps' }, cloudBox, catBox, xmpBox), status),
    ];
  }

  function show(p) {
    dlg.textContent = '';
    dlg.append(...(p === 'lightroom' ? lightroom() : p === 'icloud' ? icloud() : home()));
  }
  show(page);
  if (!dlg.open) dlg.showModal();
}
