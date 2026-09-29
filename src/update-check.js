// Desktop apps: once a day, see whether a newer release is on GitHub and, if so, show an Update
// button that opens the release page. Nothing installs itself; people update when they want to.
import { el } from './util.js';
import { icon } from './icons.js';
import { CONFIG } from './config.js';

const KEY = 'lumen:update-check';
const newer = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

export async function checkForUpdate(openExternal) {
  const t = window.__TAURI_INTERNALS__;
  const current = window.LUMEN_BUILD?.version;
  if (!t || !current) return;
  let last = {};
  try { last = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  let latest = last.version;
  if (!last.at || Date.now() - last.at > 864e5) {
    try {
      const m = await (await fetch(`https://api.github.com/repos/${CONFIG.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })).json();
      latest = String(m.tag_name || '').replace(/^v/, '');
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), version: latest }));
    } catch { return; }
  }
  if (!latest || !newer(latest, current)) return;
  const btn = el('button', { class: 'btn sm update-btn', title: `Version ${latest} is available (you have ${current})`, onclick: () => openExternal?.(`https://github.com/${CONFIG.repo}/releases/latest`) }, icon('download'), el('span', {}, 'Update'));
  document.querySelector('.top-actions')?.prepend(btn);
}
