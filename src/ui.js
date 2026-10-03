// Reusable panel controls.
import { el, clamp, fmtSigned } from './util.js';
import { icon } from './icons.js';

const decimals = (step) => (String(step).split('.')[1] || '').length;

// Global hooks so the viewer can react while a slider is being dragged (e.g. hide mask overlay).
export const sliderHooks = { start: () => {}, end: () => {} };

export function slider({ label, min, max, step = 1, def = 0, get, set, commit, format, parse, track, unit = '' }) {
  const range = el('input', { type: 'range', class: 'range', min, max, step, 'aria-label': label });
  const val = el('input', { class: 'val', type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': `${label} value` });
  const lab = el('label', { title: 'Double-click to reset' }, label);
  // Label and value on one line, a slim track below; the fill shows the change from the default.
  const root = el('div', { class: 'ctl' }, el('div', { class: 'ctl-top' }, lab, val), range);
  if (track) { root.style.setProperty('--track-custom', track); root.classList.add('tracked'); }
  const fmt = format || ((v) => (min < 0 ? fmtSigned(v, decimals(step)) : Number(v).toFixed(decimals(step))) + unit);
  const z = ((clamp(def, min, max) - min) / (max - min)) * 100;

  function paint(v) {
    range.value = v;
    if (document.activeElement !== val) val.value = fmt(v);
    const t = ((v - min) / (max - min)) * 100;
    range.style.setProperty('--a', Math.min(t, z) + '%');
    range.style.setProperty('--b', Math.max(t, z) + '%');
    root.classList.toggle('changed', Math.abs(v - def) > 1e-9);
  }
  const apply = (v, done) => {
    v = clamp(v, min, max);
    set(v);
    paint(v);
    if (done) commit?.();
  };

  range.addEventListener('input', () => apply(+range.value, false));
  range.addEventListener('change', () => commit?.());
  range.addEventListener('pointerdown', () => {
    sliderHooks.start();
    window.addEventListener('pointerup', () => sliderHooks.end(), { once: true });
  });
  const reset = () => apply(def, true);
  range.addEventListener('dblclick', reset);
  lab.addEventListener('dblclick', reset);

  val.addEventListener('focus', () => val.select());
  val.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') val.blur();
    if (e.key === 'Escape') { val.value = fmt(get()); val.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : 1;
      apply(+(get() + (e.key === 'ArrowUp' ? 1 : -1) * step * mult).toFixed(6), true);
      val.value = fmt(get());
    }
  });
  val.addEventListener('change', () => {
    const n = parse ? parse(val.value) : parseFloat(val.value.replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(n)) apply(n, true);
    val.value = fmt(get());
  });
  val.addEventListener('blur', () => { val.value = fmt(get()); });

  const refresh = () => paint(get());
  refresh();
  return { el: root, refresh };
}

const openState = (() => {
  try { return JSON.parse(localStorage.getItem('lumen:sections') || '{}'); } catch { return {}; }
})();

export function section(title, { id, open = true, onReset, right, badge, enabled } = {}) {
  const body = el('div', { class: 'sec-body' });
  const isOpen = id && id in openState ? openState[id] : open;
  const resetBtn = onReset
    ? el('button', { class: 'icon-btn sm sec-reset', title: `Reset ${title}`, onclick: (e) => { e.stopPropagation(); onReset(); } }, icon('reset'))
    : null;
  const badgeEl = badge ? el('span', { class: 'sec-icon' }, icon(badge.icon)) : null;
  let sw = null;
  if (enabled) {
    const input = el('input', { type: 'checkbox', class: 'switch-input', 'aria-label': `${title} on/off` });
    sw = el('label', { class: 'switch mini', title: `Turn ${title} on or off`, onclick: (e) => e.stopPropagation() }, input, el('span', { class: 'switch-ui' }));
    input.addEventListener('change', () => { enabled.set(input.checked); root.classList.toggle('off', !input.checked); });
    input.checked = enabled.get();
  }
  const head = el('div', { class: 'sec-head', role: 'button', tabindex: 0 },
    badgeEl, el('span', { class: 'sec-title' }, title), el('span', { class: 'grow' }), right || null, resetBtn, sw, icon('chevron', 'i chev'));
  const root = el('section', { class: 'sec' + (isOpen ? ' open' : '') + (enabled && !enabled.get() ? ' off' : ''), 'data-id': id || null }, head, body);
  const remember = (sec) => { if (sec.dataset.id) openState[sec.dataset.id] = sec.classList.contains('open'); };
  // In the editing panel one section is open at a time, so it never piles up; Shift keeps the others.
  const toggle = (e) => {
    const opening = !root.classList.contains('open');
    if (opening && !e?.shiftKey && root.closest('#panelBody')) {
      for (const s of root.parentElement.querySelectorAll(':scope > .sec.open')) { s.classList.remove('open'); remember(s); }
    }
    root.classList.toggle('open');
    remember(root);
    try { localStorage.setItem('lumen:sections', JSON.stringify(openState)); } catch { /* ignore */ }
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
  const refresh = () => { if (enabled) { const on = enabled.get(); sw.firstChild.checked = on; root.classList.toggle('off', !on); } };
  return { el: root, body, refresh, setChanged: (c) => root.classList.toggle('changed', !!c) };
}

export function segmented(items, value, onChange, cls = '') {
  const root = el('div', { class: 'seg ' + cls, role: 'tablist' });
  const btns = items.map((it) => {
    const b = el('button', { class: 'seg-btn', role: 'tab', title: it.title || null }, it.icon ? icon(it.icon) : null, it.label ? el('span', {}, it.label) : null);
    b.addEventListener('click', () => { set(it.value); onChange(it.value); });
    root.append(b);
    return b;
  });
  function set(v) {
    items.forEach((it, i) => btns[i].classList.toggle('on', it.value === v));
  }
  set(value);
  return { el: root, set };
}

export function toggle(label, get, onChange) {
  const input = el('input', { type: 'checkbox', class: 'switch-input' });
  const root = el('label', { class: 'switch' }, el('span', { class: 'switch-label' }, label), input, el('span', { class: 'switch-ui' }));
  input.addEventListener('change', () => onChange(input.checked));
  const refresh = () => { input.checked = !!get(); };
  refresh();
  return { el: root, refresh };
}

let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}
// Small popover menu anchored to a button. items: [{label, icon, onClick}]
export function popMenu(anchor, items) {
  closeMenu();
  // Items: { label, icon?, onClick, checked? } or { sep: true } or { head: 'Title' }.
  const m = el('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) =>
    it.sep ? el('div', { class: 'menu-sep', role: 'separator' })
      : it.head ? el('div', { class: 'menu-head' }, it.head)
      : el('button', { class: 'menu-item', role: it.checked === undefined ? 'menuitem' : 'menuitemradio', 'aria-checked': it.checked === undefined ? null : String(!!it.checked), onclick: () => { closeMenu(); it.onClick(); } },
        it.checked !== undefined ? el('span', { class: 'i menu-check' }, it.checked ? icon('check') : null) : it.icon ? icon(it.icon) : null, el('span', {}, it.label))));
  // Inside a modal dialog the menu must live in the dialog too, or it renders underneath it.
  (anchor.closest?.('dialog[open]') || document.body).append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  m.style.top = `${r.bottom + mh + 6 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6}px`;
  openMenu = m;
  setTimeout(() => window.addEventListener('pointerdown', (e) => { if (!m.contains(e.target)) closeMenu(); }, { once: true }), 0);
}

export function iconButton(name, title, onclick, cls = '') {
  return el('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onclick }, icon(name));
}

export function button(label, onclick, cls = '', iconName) {
  return el('button', { class: 'btn ' + cls, onclick }, iconName ? icon(iconName) : null, el('span', {}, label));
}

// "More options" disclosure: keeps rarely used controls out of the way.
const moreState = (() => { try { return JSON.parse(localStorage.getItem('lumen:more') || '{}'); } catch { return {}; } })();
export function disclosure(id, label, ...children) {
  const body = el('div', { class: 'more-body' }, ...children);
  const btn = el('button', { class: 'more-btn', type: 'button', 'aria-expanded': String(!!moreState[id]) }, icon('chevron', 'i chev'), el('span', {}, label));
  const root = el('div', { class: 'more' + (moreState[id] ? ' open' : '') }, btn, body);
  btn.addEventListener('click', () => {
    const open = root.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    moreState[id] = open;
    try { localStorage.setItem('lumen:more', JSON.stringify(moreState)); } catch { /* ignore */ }
  });
  return root;
}
