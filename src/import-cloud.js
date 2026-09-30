// Imports from cloud services through their official pickers. Each one opens the service's own
// chooser, so we only ever see the photos the user picks. The keys live in config.js; a service
// without keys is shown as unavailable.
import { CONFIG } from './config.js';
import { RAW_EXT } from './loader.js';

const EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.tif', '.tiff', ...[...RAW_EXT].map((e) => '.' + e)];
const scripts = new Map();
function loadScript(src, attrs = {}) {
  if (scripts.has(src)) return scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = () => { scripts.delete(src); reject(new Error(`Couldn't reach ${new URL(src).hostname}`)); };
    document.head.append(s);
  });
  scripts.set(src, p);
  return p;
}

// `when` is the photo's own date when the service gives one, so the same photo picked again (on
// this device or another) is recognised as the same photo.
async function download(url, name, headers = {}, onProgress, when) {
  onProgress?.(`Downloading ${name}…`);
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${name}: download failed (${r.status})`);
  const blob = await r.blob();
  return new File([blob], name, { type: blob.type, lastModified: Number.isFinite(when) ? when : Date.now() });
}

// ------------------------------------------------------------ Dropbox (Chooser)
async function dropbox(onProgress) {
  await loadScript('https://www.dropbox.com/static/api/2/dropins.js', { id: 'dropboxjs', 'data-app-key': CONFIG.dropboxAppKey });
  const picked = await new Promise((resolve) => window.Dropbox.choose({
    linkType: 'direct', multiselect: true, folderselect: false, extensions: ['images', ...EXTS],
    success: resolve, cancel: () => resolve([]),
  }));
  const out = [];
  for (const f of picked) out.push(await download(f.link, f.name, {}, onProgress));
  return out;
}

// ------------------------------------------------------------ OneDrive (File picker v7.2)
async function onedrive(onProgress) {
  await loadScript('https://js.live.net/v7.2/OneDrive.js');
  const picked = await new Promise((resolve, reject) => window.OneDrive.open({
    clientId: CONFIG.onedriveClientId,
    action: 'download',
    multiSelect: true,
    advanced: { filter: EXTS.join(','), redirectUri: location.origin + location.pathname },
    success: (res) => resolve(res.value || []),
    cancel: () => resolve([]),
    error: (e) => reject(new Error(e?.message || 'OneDrive picker failed')),
  }));
  const out = [];
  for (const f of picked) out.push(await download(f['@microsoft.graph.downloadUrl'], f.name, {}, onProgress, Date.parse(f.lastModifiedDateTime)));
  return out;
}

// ------------------------------------------------------------ Google (Drive Picker, Photos Picker)
let gToken = null; // { scope, token, exp }
export async function googleToken(scope) {
  if (gToken && gToken.scope === scope && gToken.exp > Date.now() + 60e3) return gToken.token;
  await loadScript('https://accounts.google.com/gsi/client');
  const res = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.googleClientId,
      scope,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e?.message || 'Google sign-in was closed')),
    });
    client.requestAccessToken();
  });
  gToken = { scope, token: res.access_token, exp: Date.now() + (res.expires_in || 3000) * 1000 };
  return gToken.token;
}

async function googleDrive(onProgress) {
  const token = await googleToken('https://www.googleapis.com/auth/drive.file');
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((r) => window.gapi.load('picker', r));
  const P = window.google.picker;
  const picked = await new Promise((resolve) => {
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false)
      .setMimeTypes('image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff,image/x-adobe-dng,application/octet-stream');
    new P.PickerBuilder()
      .addView(view)
      .addView(new P.DocsView(P.ViewId.DOCS_IMAGES))
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(CONFIG.googleApiKey)
      .setAppId(CONFIG.googleAppId)
      .setCallback((d) => {
        if (d.action === P.Action.PICKED) resolve(d.docs || []);
        else if (d.action === P.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
  const out = [];
  for (const d of picked) out.push(await download(`https://www.googleapis.com/drive/v3/files/${d.id}?alt=media`, d.name, { Authorization: `Bearer ${token}` }, onProgress, d.lastEditedUtc));
  return out;
}

// Google Photos Picker API: create a session, let the user pick in Google Photos, then download.
async function googlePhotos(onProgress) {
  const token = await googleToken('https://www.googleapis.com/auth/photospicker.mediaitems.readonly');
  const H = { Authorization: `Bearer ${token}` };
  const api = 'https://photospicker.googleapis.com/v1';
  const s = await (await fetch(`${api}/sessions`, { method: 'POST', headers: H })).json();
  if (!s.pickerUri) throw new Error(s.error?.message || 'Google Photos is unavailable');
  const win = window.open(`${s.pickerUri}/autoclose`, 'gphotos', 'width=1000,height=760');
  onProgress?.('Pick photos in the Google Photos window…');
  const interval = Math.max(1000, parseFloat(s.pollingConfig?.pollInterval || '2') * 1000);
  const deadline = Date.now() + 15 * 60e3;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const st = await (await fetch(`${api}/sessions/${s.id}`, { headers: H })).json();
    ready = !!st.mediaItemsSet;
    if (!ready && win?.closed) break;
  }
  const out = [];
  if (ready) {
    let page = '';
    do {
      const r = await (await fetch(`${api}/mediaItems?sessionId=${s.id}&pageSize=100${page ? `&pageToken=${page}` : ''}`, { headers: H })).json();
      for (const m of r.mediaItems || []) {
        if (m.type && m.type !== 'PHOTO') continue;
        out.push(await download(`${m.mediaFile.baseUrl}=d`, m.mediaFile.filename || `${m.id}.jpg`, H, onProgress, Date.parse(m.createTime)));
      }
      page = r.nextPageToken || '';
    } while (page);
  }
  fetch(`${api}/sessions/${s.id}`, { method: 'DELETE', headers: H }).catch(() => {});
  return out;
}

// ------------------------------------------------------------ registry
// Photos picked from these services are *linked*: the original stays in that service and never
// counts against Rembrandt cloud storage. Edits, ratings and a thumbnail sync as usual; to edit a
// linked photo on a device that doesn't have it yet, pick it again (it's matched automatically).
export const CLOUD_SOURCES = [
  { id: 'gphotos', name: 'Google Photos', icon: 'gphotos', ready: () => !!CONFIG.googleClientId, run: googlePhotos },
  { id: 'gdrive', name: 'Google Drive', icon: 'gdrive', ready: () => !!(CONFIG.googleClientId && CONFIG.googleApiKey), run: googleDrive, folder: 'Google Drive' },
  { id: 'dropbox', name: 'Dropbox', icon: 'dropbox', ready: () => !!CONFIG.dropboxAppKey, run: dropbox, folder: 'Dropbox' },
  { id: 'onedrive', name: 'OneDrive', icon: 'onedrive', ready: () => !!CONFIG.onedriveClientId, run: onedrive, folder: 'OneDrive' },
];

// Runs a source and tags each file with where it's linked from.
export async function pickLinked(source, onProgress) {
  const files = await source.run(onProgress);
  for (const f of files) f.linkedFrom = source.id;
  return files;
}
export const sourceName = (id) => CLOUD_SOURCES.find((s) => s.id === id)?.name || 'the cloud';
