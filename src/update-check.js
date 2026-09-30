// Updates. Nothing installs itself; people update when they want to.
//   Desktop app:      compare with the latest GitHub release; Update opens the release page.
//   rembrandt-server: compare the server's version with the latest release; Update asks the server
//                     to update itself (installer builds), then reloads once it's back.
// An Update button appears in the top bar when there's a newer version, and Settings › About always
// has "Check for updates".
import { el } from './util.js';
import { icon } from './icons.js';
import { CONFIG } from './config.js';

const KEY = 'lumen:update-check';
const DAY = 864e5;
const tauri = () => !!window.__TAURI_INTERNALS__;
const onServer = () => !tauri() && CONFIG.serverUrl !== undefined;
const api = (p) => `${CONFIG.serverUrl || ''}/api/${p}`;

export const newer = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

const state = { current: '', latest: '', available: false, canInstall: false, checkedAt: 0, error: '', updating: false };
const listeners = new Set();
export const updateState = () => state;
export const updatesSupported = () => tauri() || onServer();
const changed = () => { renderTopButton(); listeners.forEach((f) => f(state)); };
const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

const releases = () => `https://github.com/${CONFIG.repo}/releases/latest`;
const openUrl = (url) => (tauri() ? window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url }) : window.open(url, '_blank', 'noopener'));

async function latestRelease(force) {
  let last = {};
  try { last = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  if (!force && last.at && Date.now() - last.at < DAY && last.version) return last.version;
  const m = await (await fetch(`https://api.github.com/repos/${CONFIG.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })).json();
  const v = String(m.tag_name || '').replace(/^v/, '');
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), version: v })); } catch { /* ignore */ }
  return v;
}

async function serverInfo() {
  const r = await fetch(api('server'), { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error('This server is too old to update from here');
  return r.json();
}

export async function checkForUpdate({ force = false } = {}) {
  if (!updatesSupported()) return state;
  try {
    if (onServer()) {
      const s = await serverInfo();
      state.current = s.version;
      state.canInstall = !!s.canUpdate;
    } else {
      state.current = window.LUMEN_BUILD?.version || '';
    }
    state.latest = await latestRelease(force);
    state.available = !!(state.latest && state.current && newer(state.latest, state.current));
    state.error = '';
  } catch (e) {
    state.error = force ? (e.message.includes('too old') ? e.message : 'Couldn’t check for updates. Are you online?') : '';
  }
  state.checkedAt = Date.now();
  changed();
  return state;
}

// Asks rembrandt-server to update itself, waits for it to come back on the new version, then reloads.
async function updateServer() {
  if (!confirm(`Update Rembrandt on this server to ${state.latest}? It restarts, which takes a minute; this page reloads when it’s back.`)) return;
  state.updating = true; state.error = ''; changed();
  try {
    const r = await fetch(api('update'), { method: 'POST', credentials: 'same-origin' });
    if (!r.ok) throw new Error(await r.text() || 'The server couldn’t start the update');
    const until = Date.now() + 5 * 60e3;
    while (Date.now() < until) {
      await new Promise((ok) => setTimeout(ok, 3000));
      try { if (!newer(state.latest, (await serverInfo()).version)) { location.reload(); return; } } catch { /* restarting */ }
    }
    throw new Error('The update is taking a while. Check the server, then reload this page.');
  } catch (e) {
    state.updating = false; state.error = e.message; changed();
  }
}

export function applyUpdate() {
  if (onServer() && state.canInstall) return updateServer();
  openUrl(releases());
}
const actionLabel = () => (state.updating ? 'Updating…' : onServer() && state.canInstall ? `Update to ${state.latest}` : 'Download update');

function renderTopButton() {
  let btn = document.querySelector('.update-btn');
  if (!state.available) { btn?.remove(); return; }
  if (!btn) {
    btn = el('button', { class: 'btn sm update-btn', onclick: () => applyUpdate() }, icon('download'), el('span', {}, 'Update'));
    document.querySelector('.top-actions')?.prepend(btn);
  }
  btn.disabled = state.updating;
  btn.lastChild.textContent = state.updating ? 'Updating…' : 'Update';
  btn.title = `Version ${state.latest} is available (you have ${state.current})`;
}

export function startUpdateChecks() {
  if (!updatesSupported()) return;
  setTimeout(() => checkForUpdate(), onServer() ? 3000 : 8000);
}

// Settings › About: check now, or update.
export function updateRow() {
  const status = el('span', { class: 'hint' });
  const btn = el('button', { class: 'btn sm' });
  let busy = false;
  const render = () => {
    btn.textContent = '';
    if (state.available) {
      btn.className = 'btn sm primary';
      btn.append(icon('download'), el('span', {}, actionLabel()));
      status.textContent = state.error || (state.updating ? 'Installing and restarting…' : `Version ${state.latest} is available${state.current ? ` (you have ${state.current})` : ''}.`);
    } else {
      btn.className = 'btn sm';
      btn.append(icon('sync'), el('span', {}, 'Check for updates'));
      status.textContent = busy ? 'Checking…' : state.error || (state.checkedAt ? `You have the latest version${state.current ? ` (${state.current})` : ''}.` : '');
    }
    btn.disabled = busy || state.updating;
  };
  btn.addEventListener('click', async () => {
    if (state.available) { applyUpdate(); return; }
    busy = true; render();
    await checkForUpdate({ force: true });
    busy = false; render();
  });
  const row = el('div', { class: 'update-row' }, btn, status);
  const off = onChange(() => { if (!row.isConnected) off(); else render(); });
  render();
  return row;
}
