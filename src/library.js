// Library: a photo gallery in the spirit of Google Photos and Lightroom's grid. Photos keep their
// shape in justified rows, grouped by day; hover shows a checkbox for multi-select; a selection
// toolbar (with Share) replaces the header while photos are selected. The sidebar holds smart
// collections and albums, and an Albums overview shows album covers.
import { isNarrow } from './platform.js';
import { el, clamp } from './util.js';
import { icon } from './icons.js';
import { iconButton, button, popMenu } from './ui.js';
import * as A from './albums.js';
import * as F from './folders.js';

const PREF = 'lumen:library';
const DEF = { view: 'all', sort: 'captured', size: 200, sidebar: true };
const MIN_SIZE = 110, MAX_SIZE = 340;
const loadPrefs = () => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { ...DEF }; } };

const DAY = 864e5;
export const SMART = [
  { id: 'all', name: 'All Photos', icon: 'photos', test: () => true },
  { id: 'recent', name: 'Recently Added', icon: 'clock', test: (e) => Date.now() - (e.addedAt || 0) < 30 * DAY },
  { id: 'top', name: 'Top Rated', icon: 'heart', test: (e) => (e.rating || 0) >= 4 },
  { id: 'picks', name: 'Picks', icon: 'check', test: (e) => e.flag === 1 },
  { id: 'edited', name: 'Edited', icon: 'edit', test: (e) => !!e.edited },
  { id: 'raw', name: 'RAW', icon: 'raw', test: (e) => !!e.raw },
  { id: 'rejected', name: 'Rejected', icon: 'x', test: (e) => e.flag === -1 },
];
const SORTS = [['captured', 'Date taken (newest)'], ['captured-asc', 'Date taken (oldest)'], ['added', 'Date added'], ['name', 'File name'], ['rating', 'Rating']];

const takenAt = (e) => (e.meta?.timestamp ? e.meta.timestamp * 1000 : e.lastModified || e.addedAt || 0);
const aspectOf = (e) => e.thumbAspect || (e.w && e.h ? e.w / e.h : 1.5);

function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7 && diff > 0) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function buildLibrary(app, api) {
  const prefs = loadPrefs();
  prefs.size = clamp(Number(prefs.size) || 200, MIN_SIZE, MAX_SIZE);
  if (!SORTS.some(([v]) => v === prefs.sort)) prefs.sort = 'captured';
  const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch { /* ignore */ } };
  const selected = new Set();
  let anchor = null;
  let query = '';
  let renaming = null;
  let order = []; // photos in display order

  const albumView = () => (prefs.view.startsWith('album:') ? A.albumById(prefs.view.slice(6)) : null);
  const folderView = () => (prefs.view.startsWith('folder:') ? F.folderById(prefs.view.slice(7)) : null);
  const albumPhotos = (a) => { const keys = new Set(a.keys); return app.images.filter((e) => keys.has(e.key)); };
  function currentName() {
    const a = albumView();
    if (a) return a.name;
    const f = folderView();
    if (f) return f.name;
    if (prefs.view === 'albums') return 'Albums';
    return (SMART.find((s) => s.id === prefs.view) || SMART[0]).name;
  }
  const setView = (v) => { prefs.view = v; savePrefs(); selected.clear(); side.parentElement?.classList.remove('side-open'); refresh(); api.stripChanged(); content.scrollTop = 0; };
  const ids = () => [...selected];
  const keysOf = (list) => app.images.filter((x) => list.includes(x.id)).map((x) => x.key);

  // ---------------------------------------------------------------- sidebar
  const side = el('nav', { class: 'lib-side', 'aria-label': 'Collections' });
  const storage = el('button', { class: 'side-storage', title: 'Storage', onclick: () => api.openAccount('storage') });

  function dropTarget(node, albumId) {
    node.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-photo-ids')) { e.preventDefault(); e.stopPropagation(); node.classList.add('drop'); } });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop');
      const keys = keysOf(JSON.parse(e.dataTransfer.getData('application/x-photo-ids') || '[]'));
      let target = albumId;
      if (!target) target = (await A.createAlbum('New Album', keys)).id;
      else await A.addToAlbum(target, keys);
      app.toast(`Added ${keys.length} photo${keys.length === 1 ? '' : 's'} to “${A.albumById(target)?.name}”`);
    });
  }

  async function newAlbum(keys = []) {
    const a = await A.createAlbum('New Album', keys);
    renaming = a.id;
    setView('album:' + a.id);
    return a;
  }
  function albumMenu(a) {
    return [
      { label: 'Rename', icon: 'pencil', onClick: () => { renaming = a.id; refresh(); } },
      { label: 'Share album…', icon: 'share', onClick: () => api.share(albumPhotos(a).map((x) => x.id), a.name) },
      { label: 'Export album…', icon: 'export', onClick: () => api.exportPhotos(albumPhotos(a).map((x) => x.id)) },
      { sep: true },
      { label: 'Delete album', icon: 'trash', onClick: async () => { await A.deleteAlbum(a.id); if (prefs.view === 'album:' + a.id) setView('albums'); else refresh(); app.toast(`Deleted “${a.name}”. The photos stay in your library.`); } },
    ];
  }

  function renderSide() {
    side.textContent = '';
    const count = (t) => app.images.filter(t).length;
    const item = (id, name, ic, n, extra) => {
      const row = el('div', { class: 'side-item' + (prefs.view === id ? ' on' : ''), role: 'button', tabindex: 0, 'data-view': id },
        icon(ic), el('span', { class: 'side-name' }, name), el('span', { class: 'side-count' }, n ? String(n) : ''), extra || null);
      row.addEventListener('click', () => setView(id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') setView(id); });
      return row;
    };
    side.append(el('div', { class: 'side-head' }, 'Library'));
    for (const s of SMART) {
      const n = count(s.test);
      if (s.id !== 'all' && !n && prefs.view !== s.id) continue;
      side.append(item(s.id, s.name, s.icon, n));
    }
    const head = el('div', { class: 'side-head' }, el('span', {}, 'Albums'), iconButton('plus', 'New album', () => newAlbum(keysOf(ids())), 'sm'));
    dropTarget(head, null);
    side.append(head);
    const list = A.allAlbums();
    side.append(item('albums', 'All albums', 'album', list.length));
    for (const a of list) {
      const id = 'album:' + a.id;
      if (renaming === a.id && !albumView()) {
        const input = el('input', { class: 'rename side-rename', value: a.name });
        const done = async (ok) => { renaming = null; if (ok) await A.renameAlbum(a.id, input.value); refresh(); };
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
        side.append(el('div', { class: 'side-item on' }, icon('album'), input));
        requestAnimationFrame(() => { input.focus(); input.select(); });
        continue;
      }
      const more = iconButton('more', 'Album options', (e) => { e.stopPropagation(); popMenu(e.currentTarget, albumMenu(a)); }, 'sm side-more');
      const row = item(id, a.name, 'albumSmall', albumPhotos(a).length, more);
      dropTarget(row, a.id);
      side.append(row);
    }
    const fl = F.allFolders();
    if (fl.length || F.support()) {
      side.append(el('div', { class: 'side-head' }, el('span', {}, 'Synced folders'), iconButton('plus', 'Sync a folder', () => api.syncFolder(), 'sm')));
      for (const f of fl) {
        const n = app.images.filter((e) => e.src?.folder === f.id).length;
        const state = f.busy ? el('span', { class: 'side-sync spin', title: f.progress || 'Syncing' }, icon('sync'))
          : f.status === 'locked' ? el('button', { class: 'side-fix', title: 'Allow access again', onclick: (e) => { e.stopPropagation(); api.reconnectFolder(f); } }, 'Allow')
          : f.status === 'missing' ? el('span', { class: 'side-warn', title: 'Folder not found' }, '!') : null;
        const more = iconButton('more', 'Folder options', (e) => { e.stopPropagation(); popMenu(e.currentTarget, [
          { label: 'Sync now', icon: 'sync', onClick: () => api.syncFolder(f) },
          { label: f.sidecars ? 'Stop writing XMP sidecars' : 'Write edits as XMP sidecars', icon: 'save', onClick: () => F.updateFolder(f, { sidecars: !f.sidecars }) },
          { sep: true },
          { label: 'Stop syncing', icon: 'trash', onClick: () => api.unsyncFolder(f) },
        ]); }, 'sm side-more');
        side.append(item('folder:' + f.id, f.name, 'folder', n, el('span', { class: 'side-extra' }, state, more)));
      }
    }
    side.append(el('span', { class: 'grow' }), storage);
    api.paintStorage?.(storage);
  }

  // ---------------------------------------------------------------- header
  const header = el('div', { class: 'lib-header' });
  const search = el('input', { class: 'text-input lib-search', type: 'search', placeholder: 'Search photos', 'aria-label': 'Search photos', id: 'libSearch' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); refresh(); });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; query = ''; refresh(); search.blur(); } });
  // On a phone the sidebar is a drawer over the photos; on bigger screens it's a column you can hide.
  const sideBtn = iconButton('sidebar', 'Albums and collections', () => {
    if (isNarrow()) { root.classList.toggle('side-open'); return; }
    prefs.sidebar = !prefs.sidebar; savePrefs(); root.classList.toggle('no-side', !prefs.sidebar);
  }, 'sm');
  const sortLabel = () => (SORTS.find(([v]) => v === prefs.sort) || SORTS[0])[1];
  const sortMenu = (e) => popMenu(e.currentTarget, SORTS.map(([v, l]) => ({ label: l, checked: prefs.sort === v, onClick: () => { prefs.sort = v; savePrefs(); refresh(); api.stripChanged(); } })));
  // Zoom: a slider for thumbnail size (also ⌘+ / ⌘−).
  const zoom = el('input', { class: 'lib-zoom', type: 'range', min: MIN_SIZE, max: MAX_SIZE, step: 10, value: prefs.size, 'aria-label': 'Thumbnail size', title: 'Thumbnail size' });
  let zoomT = 0;
  zoom.addEventListener('input', () => { prefs.size = +zoom.value; cancelAnimationFrame(zoomT); zoomT = requestAnimationFrame(() => { refresh(); savePrefs(); }); });
  zoom.addEventListener('keydown', (e) => e.stopPropagation());
  const setZoom = (d) => { prefs.size = clamp(prefs.size + d, MIN_SIZE, MAX_SIZE); zoom.value = prefs.size; savePrefs(); refresh(); };

  function renderHeader(total) {
    header.textContent = '';
    const n = selected.size;
    header.classList.toggle('selecting', n > 0);
    if (n) {
      const a = albumView();
      header.append(...[
        iconButton('x', 'Clear selection (Esc)', () => { selected.clear(); refresh(); }, 'sm'),
        el('span', { class: 'sel-text' }, `${n} selected`),
        el('span', { class: 'grow' }),
        button('Share', () => api.share(ids()), 'sm primary', 'share'),
        button('Add to album', (ev) => popMenu(ev.currentTarget, [
          { label: 'New album…', icon: 'plus', onClick: () => newAlbum(keysOf(ids())) },
          A.allAlbums().length ? { sep: true } : null,
          ...A.allAlbums().map((al) => ({ label: al.name, icon: 'albumSmall', onClick: async () => { await A.addToAlbum(al.id, keysOf(ids())); app.toast(`Added to “${al.name}”`); } })),
        ]), 'sm ghost', 'albumAdd'),
        n === 1 ? button('Copy edits', () => api.copyEdits(ids()[0]), 'sm ghost', 'copy') : null,
        api.clipboard() ? (() => { const b = button(n > 1 ? `Paste to ${n}` : 'Paste edits', () => api.pasteEdits(ids()), 'sm ghost', 'paste'); b.title = `Paste ${api.describeClip()}`; return b; })() : null,
        iconButton('edit', 'Edit (Enter)', () => api.openInEditor(ids()[0]), 'sm'),
        iconButton('export', 'Export…', () => api.exportPhotos(ids()), 'sm'),
        iconButton('trash', 'Delete (⌫)', () => removeSelected(), 'sm'),
        iconButton('more', 'More', (ev) => popMenu(ev.currentTarget, [
          { head: 'Rate' },
          ...[5, 4, 3, 2, 1, 0].map((r) => ({ label: r ? '★'.repeat(r) : 'No rating', onClick: () => api.setRating(ids(), r) })),
          { sep: true },
          { label: 'Pick (P)', icon: 'check', onClick: () => api.setFlag(ids(), 1) },
          { label: 'Reject (X)', icon: 'x', onClick: () => api.setFlag(ids(), -1) },
          { label: 'Clear flag (U)', icon: 'minus', onClick: () => api.setFlag(ids(), 0) },
          { sep: true },
          n === 1 ? { label: 'Choose what to copy…', icon: 'copy', onClick: () => api.copyEdits(ids()[0], true) } : null,
          { label: 'Apply preset…', icon: 'presets', onClick: () => api.presetMenu(ids(), header.querySelector('[aria-label="More"]') || header) },
          { label: n > 1 ? `Reset edits on ${n} photos` : 'Reset edits', icon: 'reset', onClick: () => api.resetEdits(ids()) },
          a ? { label: 'Remove from album', icon: 'minus', onClick: async () => { await A.removeFromAlbum(a.id, keysOf(ids())); selected.clear(); refresh(); } } : null,
          { sep: true },
          { label: n > 1 ? `Delete ${n} photos` : 'Delete', icon: 'trash', onClick: () => removeSelected() },
        ]), 'sm'),
      ].filter(Boolean));
      return;
    }
    const a = albumView();
    const titleEl = el('h1', { class: 'lib-title' }, currentName());
    if (a && renaming === a.id) {
      const input = el('input', { class: 'text-input title-rename', value: a.name, 'aria-label': 'Album name' });
      const done = async (ok) => { if (renaming !== a.id) return; renaming = null; if (ok) await A.renameAlbum(a.id, input.value); refresh(); };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      titleEl.replaceChildren(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else if (a) titleEl.addEventListener('dblclick', () => { renaming = a.id; refresh(); });
    header.append(...[
      sideBtn,
      el('div', { class: 'lib-heading' }, titleEl, el('span', { class: 'lib-count' }, total ? `${total} ${prefs.view === 'albums' ? (total === 1 ? 'album' : 'albums') : total === 1 ? 'photo' : 'photos'}` : '')),
      el('span', { class: 'grow' }),
      prefs.view !== 'albums' ? el('span', { class: 'search-wrap' }, icon('search'), search) : null,
      a ? button('Share', () => api.share(albumPhotos(a).map((x) => x.id), a.name), 'sm ghost', 'share') : null,
      a ? iconButton('more', 'Album options', (ev) => popMenu(ev.currentTarget, albumMenu(a)), 'sm') : null,
      prefs.view === 'albums' ? button('New album', () => newAlbum(), 'sm ghost', 'plus') : null,
      prefs.view !== 'albums' && total ? button(sortLabel(), sortMenu, 'sm ghost lib-sort', 'sort') : null,
      prefs.view !== 'albums' && total ? zoom : null,
      button('Import', () => api.importFiles(), 'sm primary', 'plus'),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- content
  const content = el('div', { class: 'lib-content', tabindex: 0, 'aria-label': 'Photos' });
  const main = el('div', { class: 'lib-main' }, header, content);
  // Phone drawer: a tap beside it closes it (and doesn't also open a photo).
  main.addEventListener('click', (e) => {
    if (!main.parentElement?.classList.contains('side-open')) return;
    e.preventDefault(); e.stopPropagation();
    main.parentElement.classList.remove('side-open');
  }, true);
  const root = el('section', { class: 'library' + (prefs.sidebar ? '' : ' no-side'), id: 'library' }, side, main);

  function visible() {
    let list = app.images.slice();
    const a = albumView();
    const f = folderView();
    if (a) list = albumPhotos(a);
    else if (f) list = list.filter((e) => e.src?.folder === f.id);
    else if (prefs.view !== 'albums') list = list.filter((SMART.find((s) => s.id === prefs.view) || SMART[0]).test);
    if (prefs.view !== 'rejected' && !a && !f && prefs.view !== 'all') list = list.filter((e) => e.flag !== -1);
    if (query) list = list.filter((e) => e.name.toLowerCase().includes(query) || [e.meta?.make, e.meta?.model, e.kind].join(' ').toLowerCase().includes(query));
    if (prefs.sort === 'name') list.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    else if (prefs.sort === 'captured') list.sort((x, y) => takenAt(y) - takenAt(x));
    else if (prefs.sort === 'captured-asc') list.sort((x, y) => takenAt(x) - takenAt(y));
    else if (prefs.sort === 'rating') list.sort((x, y) => (y.rating || 0) - (x.rating || 0) || x.addedAt - y.addedAt);
    else list.sort((x, y) => y.addedAt - x.addedAt);
    return list;
  }

  function groups(list) {
    if (!prefs.sort.startsWith('captured') && prefs.sort !== 'added') return [{ label: '', items: list }];
    const at = prefs.sort === 'added' ? (e) => e.addedAt : takenAt;
    const out = [];
    for (const e of list) {
      const d = new Date(at(e));
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else out.push({ key, label: dayLabel(at(e)), items: [e] });
    }
    return out;
  }

  // Justified rows: fill the width, keep aspect ratios, last row not stretched.
  function layoutRows(items, width, target, gap) {
    const rows = [];
    let row = [], sum = 0;
    for (const e of items) {
      const ar = clamp(aspectOf(e), 0.4, 3);
      row.push([e, ar]);
      sum += ar;
      if (sum * target + gap * (row.length - 1) >= width) {
        const h = (width - gap * (row.length - 1)) / sum;
        rows.push({ h, items: row });
        row = []; sum = 0;
      }
    }
    if (row.length) rows.push({ h: Math.min(target, (width - gap * (row.length - 1)) / sum), items: row, last: true });
    return rows;
  }

  function toggle(e, ev) {
    if (ev?.shiftKey && anchor) {
      const a = order.findIndex((x) => x.id === anchor), b = order.indexOf(e);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let k = lo; k <= hi; k++) selected.add(order[k].id);
    } else if (selected.has(e.id)) selected.delete(e.id);
    else selected.add(e.id);
    anchor = e.id;
    refresh();
  }
  function removeSelected(list = ids()) {
    if (!list.length) return;
    for (const id of list) selected.delete(id);
    api.deletePhotos(list);
  }

  function tile(e, w, h) {
    const on = selected.has(e.id);
    const cur = app.images[app.cur] === e;
    const t = el('div', {
      class: 'ph' + (on ? ' sel' : '') + (cur ? ' current' : '') + (e.flag === -1 ? ' rejected' : ''),
      style: { width: `${w}px`, height: `${h}px` }, 'data-id': e.id, draggable: 'true', tabindex: -1, title: e.name,
    },
      e.thumbUrl ? el('img', { src: e.thumbUrl, alt: e.name, loading: 'lazy', draggable: 'false' }) : el('span', { class: 'thumb-ph' + (e.loading ? ' loading' : '') }),
      el('button', { class: 'ph-check', 'aria-label': on ? 'Deselect' : 'Select', 'aria-pressed': String(on), onclick: (ev) => { ev.stopPropagation(); toggle(e, ev); } }, icon('check')),
      el('button', { class: 'ph-del', 'aria-label': 'Delete', title: 'Delete', onclick: (ev) => { ev.stopPropagation(); removeSelected(selected.has(e.id) ? ids() : [e.id]); } }, icon('trash')),
      el('div', { class: 'ph-badges' },
        e.raw ? el('span', { class: 'tag' }, 'RAW') : null,
        e.edited ? el('span', { class: 'tag', title: 'Edited' }, icon('edit')) : null,
        e.offline ? el('span', { class: 'tag warn', title: 'Original not on this device' }, icon('cloud')) : null),
      el('div', { class: 'ph-foot' },
        el('span', { class: 'ph-stars' }, [1, 2, 3, 4, 5].map((i) => {
          const s = el('button', { class: 'star' + (i <= (e.rating || 0) ? ' on' : ''), 'aria-label': `${i} star${i > 1 ? 's' : ''}` }, '★');
          s.addEventListener('click', (ev) => { ev.stopPropagation(); api.setRating([e.id], e.rating === i ? 0 : i); });
          return s;
        })),
        el('span', { class: 'grow' }),
        e.flag === 1 ? el('span', { class: 'ph-flag pick', title: 'Pick' }, icon('check')) : e.flag === -1 ? el('span', { class: 'ph-flag reject', title: 'Rejected' }, icon('x')) : null),
    );
    // Like Google Photos: a click opens the photo; the checkbox, Shift or ⌘/Ctrl selects, and while
    // photos are selected a click adds or removes one.
    t.addEventListener('click', (ev) => {
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey || selected.size) { toggle(e, ev); return; }
      anchor = e.id;
      api.openInEditor(e.id);
    });
    t.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!selected.has(e.id)) { selected.clear(); selected.add(e.id); anchor = e.id; refresh(); }
      const list = ids();
      api.photoMenu(list, api.pointAnchor(ev), [
        { sep: true },
        { label: 'Pick', icon: 'check', onClick: () => api.setFlag(list, 1) },
        { label: 'Reject', icon: 'x', onClick: () => api.setFlag(list, -1) },
        { label: 'Share…', icon: 'share', onClick: () => api.share(list) },
        { label: 'Export…', icon: 'export', onClick: () => api.exportPhotos(list) },
        { sep: true },
        { label: list.length > 1 ? `Delete ${list.length} photos` : 'Delete', icon: 'trash', onClick: () => removeSelected(list) },
      ]);
    });
    t.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-photo-ids', JSON.stringify(selected.has(e.id) ? ids() : [e.id]));
      ev.dataTransfer.effectAllowed = 'copy';
      root.classList.add('dragging-photos');
    });
    t.addEventListener('dragend', () => root.classList.remove('dragging-photos'));
    return t;
  }

  function renderPhotos(list) {
    const width = Math.max(200, content.clientWidth - 32);
    const gap = 4;
    const frag = document.createDocumentFragment();
    for (const g of groups(list)) {
      const allOn = g.items.every((e) => selected.has(e.id));
      const sec = el('section', { class: 'ph-group' + (allOn ? ' all-on' : '') });
      if (g.label) {
        sec.append(el('div', { class: 'ph-group-head' },
          el('button', { class: 'ph-check group', 'aria-label': `Select ${g.label}`, onclick: () => { g.items.forEach((e) => (allOn ? selected.delete(e.id) : selected.add(e.id))); refresh(); } }, icon('check')),
          el('h2', {}, g.label), el('span', { class: 'lib-count' }, String(g.items.length))));
      }
      for (const r of layoutRows(g.items, width, prefs.size, gap)) {
        const row = el('div', { class: 'ph-row', style: { height: `${Math.round(r.h)}px` } });
        for (const [e, ar] of r.items) row.append(tile(e, Math.floor(r.h * ar), Math.round(r.h)));
        sec.append(row);
      }
      frag.append(sec);
    }
    content.append(frag);
  }

  function renderAlbums() {
    const list = A.allAlbums();
    const grid = el('div', { class: 'album-grid' });
    const add = el('button', { class: 'album-card new', onclick: () => newAlbum() }, el('div', { class: 'album-cover' }, icon('plus')), el('div', { class: 'album-name' }, 'New album'), el('div', { class: 'album-count' }, ' '));
    dropTarget(add, null);
    grid.append(add);
    for (const a of list) {
      const photos = albumPhotos(a);
      const cover = photos.find((x) => x.thumbUrl);
      const card = el('div', { class: 'album-card', role: 'button', tabindex: 0 },
        el('div', { class: 'album-cover' }, cover ? el('img', { src: cover.thumbUrl, alt: '', draggable: 'false' }) : icon('album')),
        el('div', { class: 'album-name' }, a.name),
        el('div', { class: 'album-count' }, `${photos.length} photo${photos.length === 1 ? '' : 's'}`),
        iconButton('more', 'Album options', (e) => { e.stopPropagation(); popMenu(e.currentTarget, albumMenu(a)); }, 'sm album-more'));
      card.addEventListener('click', () => setView('album:' + a.id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') setView('album:' + a.id); });
      dropTarget(card, a.id);
      grid.append(card);
    }
    content.append(grid);
    if (!list.length) content.append(el('p', { class: 'lib-hint' }, 'Albums collect photos without moving or copying them. Select photos and choose Add to album, or drag them onto an album.'));
  }

  function renderEmpty(kind) {
    const a = albumView();
    if (kind === 'library') {
      content.append(el('div', { class: 'lib-empty' },
        el('div', { class: 'empty-mark' }, icon('all')),
        el('h2', {}, 'Your library is empty'),
        el('p', {}, 'Bring photos in from this device, your phone, the cloud or Adobe Lightroom. Or sync a folder and keep your photos where they are.'),
        el('div', { class: 'row-btns center' },
          button('Import photos', () => api.importFiles(), 'primary', 'open'),
          F.support() ? button('Sync a folder', () => api.syncFolder(), 'ghost', 'folder') : null)));
    } else {
      content.append(el('div', { class: 'lib-empty' },
        el('p', {}, query ? `No photos match “${search.value}”.` : a ? 'This album is empty. Select photos in All Photos and choose Add to album, or drag them here.' : folderView() ? (folderView().busy ? 'Looking for photos in this folder…' : 'No photos in this folder yet.') : 'Nothing here yet.'),
        a ? button('Go to All Photos', () => setView('all'), 'ghost') : null));
    }
  }

  function refresh() {
    if (prefs.view.startsWith('album:') && !albumView()) prefs.view = 'all';
    for (const id of [...selected]) if (!app.images.some((e) => e.id === id)) selected.delete(id);
    const scroll = content.scrollTop;
    content.textContent = '';
    content.style.setProperty('--row', `${prefs.size}px`);
    let total;
    if (prefs.view === 'albums') { total = A.allAlbums().length; order = []; renderAlbums(); }
    else {
      order = visible();
      total = order.length;
      if (!app.images.length) renderEmpty('library');
      else if (!order.length) renderEmpty('none');
      else renderPhotos(order);
    }
    renderHeader(total);
    renderSide();
    content.scrollTop = scroll;
  }
  A.onAlbumsChange(() => refresh());
  F.onFoldersChange(() => { if (prefs.view.startsWith('folder:') && !folderView()) setView('all'); else renderSide(); });
  let lastW = 0;
  new ResizeObserver(() => { const w = content.clientWidth; if (w && Math.abs(w - lastW) > 8) { lastW = w; refresh(); } }).observe(content);

  // Keyboard: arrows move, Enter opens, 0–5 rate, P/X/U flag, Delete removes, Esc clears, ⌘A selects all.
  function onKey(ev) {
    const list = order;
    if (!list.length) return false;
    const k = ev.key;
    const cur = anchor ? list.findIndex((e) => e.id === anchor) : -1;
    const pick = (n) => {
      n = clamp(n, 0, list.length - 1);
      selected.clear();
      selected.add(list[n].id);
      anchor = list[n].id;
      refresh();
      content.querySelector(`[data-id="${anchor}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    // Up/down: the photo in the previous/next row closest horizontally.
    const vertical = (dir) => {
      const node = content.querySelector(`[data-id="${anchor}"]`);
      if (!node) return pick(0);
      const r = node.getBoundingClientRect(), cx = r.left + r.width / 2;
      let best = null, bestD = Infinity;
      for (const t of content.querySelectorAll('.ph')) {
        const q = t.getBoundingClientRect();
        if (dir > 0 ? q.top <= r.top + 2 : q.top >= r.top - 2) continue;
        const dy = Math.abs(q.top - r.top), dx = Math.abs(q.left + q.width / 2 - cx);
        const d = dy * 4 + dx;
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best) pick(list.findIndex((e) => e.id === best.dataset.id));
    };
    if ((ev.metaKey || ev.ctrlKey) && k.toLowerCase() === 'a') { list.forEach((e) => selected.add(e.id)); refresh(); return true; }
    if ((ev.metaKey || ev.ctrlKey) && k.toLowerCase() === 'f') { search.focus(); return true; }
    if ((ev.metaKey || ev.ctrlKey) && (k === '=' || k === '+')) { setZoom(30); return true; }
    if ((ev.metaKey || ev.ctrlKey) && k === '-') { setZoom(-30); return true; }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && k.toLowerCase() === 'c') { const id = anchor && selected.has(anchor) ? anchor : ids()[0]; if (id) api.copyEdits(id); return true; }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && k.toLowerCase() === 'v') { if (selected.size) api.pasteEdits(ids()); return true; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    if (k === 'ArrowRight') { pick(cur + 1); return true; }
    if (k === 'ArrowLeft') { pick(cur - 1); return true; }
    if (k === 'ArrowDown') { vertical(1); return true; }
    if (k === 'ArrowUp') { vertical(-1); return true; }
    if (k === 'Enter' && selected.size) { api.openInEditor(ids()[0]); return true; }
    if (k === 'Escape') { selected.clear(); refresh(); return true; }
    if (!selected.size) return false;
    if (/^[0-5]$/.test(k)) { api.setRating(ids(), +k); return true; }
    if (k === 'p') { api.setFlag(ids(), 1); return true; }
    if (k === 'x') { api.setFlag(ids(), -1); return true; }
    if (k === 'u') { api.setFlag(ids(), 0); return true; }
    if (k === 'Delete' || k === 'Backspace') { removeSelected(); return true; }
    return false;
  }

  refresh();
  return {
    el: root, refresh, visible: () => (prefs.view === 'albums' ? visible() : order.length ? order : visible()), onKey,
    selectOnly: (id) => { anchor = id; },
    selection: () => ids(),
    showView: (v) => setView(v),
    focusCurrent: () => { const n = content.querySelector('.ph.current'); n?.scrollIntoView({ block: 'nearest' }); },
    repaintStorage: () => api.paintStorage?.(storage),
  };
}
