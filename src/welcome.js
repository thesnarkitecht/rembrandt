// The welcome screen (no photo open): three ways in, each a small window, and a line that shows what
// Rembrandt has sent off this computer so far, which you can open and check.
//   01 Open photos           from this device (or drop them anywhere)
//   02 Bring from Lightroom  catalog, presets and edited photos, with ratings, flags and keywords
//   03 Try it with words     opens a sample photo and types an edit, so the sliders move on their own
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { icon } from './icons.js';
import { button } from './ui.js';

const SAMPLE = new URL('./art/selfportrait-1659.jpg', import.meta.url).href;
const DEMO = 'warmer, lift the shadows and a touch more contrast';

// Every request this window has made to another computer: the browser's own record of resources it
// fetched (fetch, images, fonts, scripts), so nothing here depends on Rembrandt reporting itself.
// Loopback (the desktop app's own pixel server) and this page's own address are on this computer.
const local = (u) => { try { const h = new URL(u, location.href); return h.origin === location.origin || /^(localhost|127\.0\.0\.1|\[::1\]|ipc\.localhost|asset\.localhost|tauri\.localhost)$/.test(h.hostname) || h.protocol === 'blob:' || h.protocol === 'data:'; } catch { return true; } };
const seen = new Map();   // host → { count, bytes, what }
const why = (host) => (/github\.com$|githubusercontent/.test(host) ? 'Update check (version number only)'
  : /googleapis|gstatic|jsdelivr|unpkg|cdnjs/.test(host) ? 'AI model or library download'
    : /supabase|rembrandt/.test(host) ? 'Your account or cloud sync (only when you turned it on)'
      : /adobe/.test(host) ? 'Lightroom (cloud), when you connected it' : 'Other');
let onSeen = () => {};
function note(e) {
  if (local(e.name)) return;
  const host = new URL(e.name).hostname;
  const s = seen.get(host) || { count: 0, bytes: 0, why: why(host) };
  s.count++; s.bytes += e.encodedBodySize || e.transferSize || 0;
  seen.set(host, s);
  onSeen();
}
try {
  for (const e of performance.getEntriesByType('resource')) note(e);
  new PerformanceObserver((l) => l.getEntries().forEach(note)).observe({ type: 'resource', buffered: false });
} catch { /* no resource timing: the list stays empty and says so */ }
export const contacted = () => seen;

const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : n ? `${n} B` : '—');

export function openPrivacyCheck() {
  const dlg = el('dialog', { class: 'dlg privacy-dlg' });
  const list = el('div', { class: 'pv-list' });
  const paint = () => {
    const rows = [...seen].sort((a, b) => b[1].count - a[1].count);
    list.replaceChildren(...(rows.length ? rows.map(([host, s]) => el('div', { class: 'pv-row' },
      el('span', { class: 'pv-host' }, host), el('span', { class: 'pv-dots' }), el('span', { class: 'pv-n' }, `${s.count}×`),
      el('span', { class: 'pv-why' }, s.why)))
      : [el('p', { class: 'pv-none' }, 'Nothing. This window hasn’t contacted any other computer since it opened.')]));
  };
  paint();
  const prev = onSeen;
  onSeen = () => { prev(); paint(); };
  dlg.append(
    el('div', { class: 'dlg-head' }, el('span', { class: 'kicker' }, 'Verify · this session'), el('h2', {}, 'What left this computer')),
    el('div', { class: 'dlg-body' },
      el('p', {}, 'Every connection this window made to another computer since it opened, from the browser’s own record. Photos, edits and AI work stay here: none of them appear below unless you turned on cloud sync.'),
      list,
      el('p', { class: 'hint' }, 'To check it yourself: open your browser’s developer tools (or a network monitor such as Little Snitch) and watch the Network tab while you edit.')),
    el('div', { class: 'dlg-foot' }, button('Close', () => dlg.close(), 'primary')));
  dlg.addEventListener('close', () => { onSeen = prev; dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
}

// Fills the empty viewer. api: { open(), lightroom(), sample(file) → Promise, ask(text) }.
export function mountWelcome(card, api) {
  const n = (i) => el('span', { class: 'wl-n' }, String(i).padStart(2, '0'));
  const path = (i, tag, title, text, ic, onClick, id) => el('button', { class: 'wl-card', type: 'button', id, onclick: onClick },
    el('span', { class: 'wl-tag' }, n(i), el('span', {}, tag)),
    el('span', { class: 'wl-icon' }, icon(ic)),
    el('b', { class: 'wl-title' }, title),
    el('span', { class: 'wl-text' }, text),
    el('span', { class: 'wl-go' }, icon('chevron')));
  let busy = false;
  const tryWords = async () => {
    if (busy) return;
    busy = true;
    try {
      const blob = await (await fetch(SAMPLE)).blob();
      await api.sample(new File([blob], 'Rembrandt, Self-Portrait (1659).jpg', { type: 'image/jpeg', lastModified: Date.now() }));
      await api.ask(DEMO);
    } finally { busy = false; }
  };
  const sent = el('b', { class: 'wl-sent' });
  const paintSent = () => {
    const n2 = [...seen.values()].reduce((a, s) => a + s.count, 0);
    sent.textContent = n2 ? `${n2} request${n2 === 1 ? '' : 's'}, no photos` : '0 photos · 0 requests';
  };
  paintSent();
  const prev = onSeen;
  onSeen = () => { prev(); paintSent(); };
  const paths = el('div', { class: 'wl-paths' },
    path(1, 'Start', 'Open photos', 'From this computer, or drop them anywhere. RAW, JPEG, HEIC, TIFF.', 'open', api.open, 'btnOpenEmpty'),
    path(2, 'Switch', 'Bring from Lightroom', 'Your catalog, presets and edited photos, with ratings, flags and keywords.', 'sync', api.lightroom),
    path(3, 'Try', 'Edit with words', `Opens a sample and types “${DEMO}”. Watch the sliders move.`, 'sparkle', tryWords));
  const proof = el('button', { class: 'wl-proof', type: 'button', onclick: openPrivacyCheck, title: 'See every connection this window has made' },
    el('span', {}, 'Sent from this computer'), el('i', { class: 'wl-leader', 'aria-hidden': 'true' }), sent, el('span', { class: 'wl-verify' }, 'Verify'));
  const foot = el('div', { class: 'wl-foot' },
    el('span', {}, `Version ${window.LUMEN_BUILD?.version || 'dev'}`), el('span', {}, 'Free · GPL'), el('span', {}, 'No account'), el('span', {}, `©${new Date().getFullYear()}`));
  card.append(paths, proof, foot);
}
