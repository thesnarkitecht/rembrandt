// Updates, on every platform. Nothing installs itself; people update when they want to.
//   Desktop app:      asks the native updater (latest.json on the latest GitHub release); Update
//                     downloads the new version, checks its signature, installs it and restarts, with
//                     progress in the button. Builds without an update key open the release page.
//   rembrandt-server: compare the server's version with the latest release; Update asks the server
//                     to update itself (installer builds), then reloads once it's back.
//   Web (hosted):     compare the build this page loaded with the deployed version.json; Update reloads.
//   Phone apps:       the website's version.json lists the store versions (`ios`, `android`); Update
//                     opens the store.
// An Update button appears in the top bar when there is one, and Settings always has "Check for updates".
import { el } from './util.js';
import { icon } from './icons.js';
import { CONFIG } from './config.js';
import { isTauri, isMobileApp, isIOS } from './platform.js';

const KEY = 'lumen:update-check';
const DAY = 864e5;
const WEB_EVERY = 30 * 60e3;
const onServer = () => !isTauri && CONFIG.serverUrl !== undefined;
const api = (p) => `${CONFIG.serverUrl || ''}/api/${p}`;

export const newer = (a, b) => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

const site = () => (CONFIG.siteUrl || '').replace(/\/$/, '');
const releases = () => `https://github.com/${CONFIG.repo}/releases/latest`;
const storeUrl = () => isIOS
  ? (CONFIG.appStoreId ? `itms-apps://apps.apple.com/app/id${CONFIG.appStoreId}` : 'itms-apps://apps.apple.com/')
  : `https://play.google.com/store/apps/details?id=${CONFIG.androidPackage}`;
const openUrl = (url) => (isTauri ? window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url }) : window.open(url, '_blank', 'noopener'));

// The build this page was loaded with (web): stamped by the deploy, or the first version.json seen.
let loadedBuild = window.LUMEN_BUILD?.build || null;
const state = { current: window.LUMEN_BUILD?.version || '', latest: '', available: false, canInstall: false, checkedAt: 0, error: '', updating: false, progress: 0 };
const listeners = new Set();
export const updateState = () => state;
export const onUpdateChange = (f) => { listeners.add(f); return () => listeners.delete(f); };
const changed = () => { renderTopButton(); listeners.forEach((f) => f(state)); };

// Cached once a day (the apps and the server); `force` asks again.
async function cached(name, force, get) {
  let last = {};
  try { last = JSON.parse(localStorage.getItem(`${KEY}:${name}`) || '{}'); } catch { /* ignore */ }
  if (!force && last.at && Date.now() - last.at < DAY && last.value) return last.value;
  const value = await get();
  try { localStorage.setItem(`${KEY}:${name}`, JSON.stringify({ at: Date.now(), value })); } catch { /* ignore */ }
  return value;
}
const latestRelease = (force) => cached('release', force, async () => {
  const m = await (await fetch(`https://api.github.com/repos/${CONFIG.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })).json();
  return String(m.tag_name || '').replace(/^v/, '');
});

const native = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
async function checkDesktop(force) {
  try {
    // The native updater asks every time (it also keeps the update ready to install).
    const v = await native('update_check');
    return { latest: v || state.current, available: !!v, canInstall: true };
  } catch {
    // No update key in this build, or no signed release yet: compare versions, offer the download page.
    const latest = await latestRelease(force);
    return { latest, available: !!(latest && state.current && newer(latest, state.current)), canInstall: false };
  }
}

// Downloads and installs in the app, then restarts into the new version.
async function updateDesktop() {
  if (!confirm(`Install Rembrandt ${state.latest} and restart? Your edits are saved.`)) return;
  state.updating = true; state.progress = 0; state.error = ''; changed();
  const poll = setInterval(async () => {
    try {
      const [got, total] = await native('update_progress');
      if (total) { state.progress = got / total; changed(); }
    } catch { /* ignore */ }
  }, 300);
  try {
    await native('update_install');   // restarts the app when done
  } catch (e) {
    clearInterval(poll);
    state.updating = false;
    state.error = `The update didn’t install: ${e?.message || e}. You can download it instead.`;
    state.canInstall = false;
    changed();
  }
}

async function checkPhone(force) {
  if (!site()) return { latest: state.current, available: false };
  // The stores approve builds on their own schedule, so the website says which version each has.
  const v = await cached('stores', force, async () => (await fetch(`${site()}/version.json`, { cache: 'no-cache' })).json());
  const latest = isIOS ? v.ios : v.android;
  return { latest, available: !!(latest && state.current && newer(latest, state.current)) };
}

async function serverInfo() {
  const r = await fetch(api('server'), { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error('This server is too old to update from here');
  return r.json();
}
async function checkServer(force) {
  const s = await serverInfo();
  state.current = s.version;
  const latest = await latestRelease(force);
  return { latest, canInstall: !!s.canUpdate, available: !!(latest && newer(latest, s.version)) };
}

async function checkWeb() {
  const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (r.status === 404) return { latest: state.current, available: false }; // a local copy, not a deployment
  const v = await r.json();
  if (!state.current) state.current = v.version || '';
  const build = v.build || v.version;
  if (!loadedBuild) { loadedBuild = build; return { latest: v.version, available: false }; }
  return { latest: v.version, available: !!build && build !== loadedBuild };
}

// Resolves the state; `force` skips the once-a-day cache.
export async function checkForUpdate({ force = false } = {}) {
  try {
    const r = isMobileApp ? await checkPhone(force) : isTauri ? await checkDesktop(force) : onServer() ? await checkServer(force) : await checkWeb();
    Object.assign(state, r, { checkedAt: Date.now(), error: '' });
  } catch (e) {
    // Offline, or nothing published yet: up to date, but a check the person asked for says so.
    const msg = e.message?.includes('too old') ? e.message : 'Couldn’t check for updates. Are you online?';
    Object.assign(state, { checkedAt: Date.now(), error: force ? msg : '' });
  }
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

// Desktop: the release page. Server: update itself. Phones: the store. Web: load the new version.
export function applyUpdate() {
  if (isMobileApp) return openUrl(storeUrl());
  if (isTauri) return state.canInstall ? updateDesktop() : openUrl(releases());
  if (onServer()) return state.canInstall ? updateServer() : openUrl(releases());
  location.reload();
}
const pct = () => (state.progress > 0 && state.progress < 1 ? ` ${Math.round(state.progress * 100)}%` : '');
export const updateActionLabel = () => (state.updating ? `Updating…${pct()}`
  : isMobileApp ? `Update in the ${isIOS ? 'App Store' : 'Play Store'}`
  : isTauri ? (state.canInstall ? `Update to ${state.latest}` : 'Download update')
  : onServer() ? (state.canInstall ? `Update to ${state.latest}` : 'Download update')
  : 'Reload to update');

function renderTopButton() {
  const bar = document.querySelector('.top-actions');
  let btn = document.querySelector('.update-btn');
  if (!state.available) { btn?.remove(); return; }
  if (!btn) {
    btn = el('button', { class: 'btn sm update-btn', onclick: () => applyUpdate() }, icon('download'), el('span', {}, 'Update'));
    bar?.prepend(btn);
  }
  btn.disabled = state.updating;
  btn.lastChild.textContent = state.updating ? `Updating…${pct()}` : 'Update';
  btn.title = state.latest && state.current && state.latest !== state.current
    ? `Version ${state.latest} is available (you have ${state.current})` : 'A new version of Rembrandt is available';
}

// Start-up: check once shortly after launch; the web app also re-checks every half hour and when the
// tab comes back, since a deploy can land while it's open.
export function startUpdateChecks() {
  setTimeout(() => checkForUpdate(), isTauri ? 8000 : 4000);
  if (!isTauri && !onServer()) {
    setInterval(() => checkForUpdate(), WEB_EVERY);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - state.checkedAt > 5 * 60e3) checkForUpdate();
    });
  }
}

// Settings: the version, and a button that checks now or applies the update.
export function updateRow() {
  const status = el('span', { class: 'hint' });
  const btn = el('button', { class: 'btn sm' });
  let busy = false;
  const render = () => {
    btn.textContent = '';
    if (state.available) {
      status.textContent = state.error || (state.updating ? (state.progress > 0 && state.progress < 1 ? `Downloading… ${Math.round(state.progress * 100)}%` : 'Installing and restarting…')
        : state.latest && state.latest !== state.current ? `Version ${state.latest} is available${state.current ? ` (you have ${state.current})` : ''}.` : 'A new version is available.');
      btn.className = 'btn sm primary';
      btn.append(icon('download'), el('span', {}, updateActionLabel()));
    } else {
      status.textContent = busy ? 'Checking…' : state.error || (state.checkedAt ? `You have the latest version${state.current ? ` (${state.current})` : ''}.` : '');
      btn.className = 'btn sm';
      btn.append(icon('sync'), el('span', {}, 'Check for updates'));
    }
    btn.disabled = busy || state.updating;
  };
  btn.addEventListener('click', async () => {
    if (state.available) { applyUpdate(); return; }
    busy = true; render();
    await checkForUpdate({ force: true });
    busy = false; render();
  });
  const off = onUpdateChange(() => { if (!row.isConnected) off(); else render(); });
  const row = el('div', { class: 'update-row' }, btn, status);
  render();
  return row;
}
