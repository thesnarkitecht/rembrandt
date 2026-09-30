// Where exported photos go: this device, any folder (including iCloud Drive / Dropbox / OneDrive /
// Google Drive folders on a computer), Apple Photos (and so iCloud Photos), Google Photos,
// Google Drive, Dropbox and OneDrive. Cloud services are uploaded to directly from the browser
// with the user's own sign-in; nothing passes through our servers.
import { saveBlob } from './util.js';
import { isMobileApp, isAndroid } from './platform.js';
import { makeZip } from './zip.js';
import { CONFIG } from './config.js';
import { googleToken } from './import-cloud.js';
import { pkceToken, forgetToken } from './oauth.js';

const tauri = () => window.__TAURI_INTERNALS__;
const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const canShareFiles = () => { try { return !!navigator.canShare?.({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; } };
const FOLDER = 'Rembrandt';

// The phone app saves to the photo library or hands photos to the share sheet (native plugin).
const PHONE = [
  { id: 'device', name: 'Save to Photos', icon: 'image', hint: isAndroid ? 'Adds the photos to your gallery, in Pictures › Rembrandt.' : 'Adds the photos to your library in Photos.', ready: () => true },
  { id: 'photos', name: 'Share…', icon: 'share', hint: 'Send to Messages, Instagram, Files, AirDrop and anything else on your phone.', ready: () => true },
];
export const DESTINATIONS = isMobileApp ? PHONE : [
  { id: 'device', name: 'This device', icon: 'download', ready: () => true },
  { id: 'folder', name: 'A folder…', icon: 'folder', hint: 'Saving into your iCloud Drive, Dropbox, OneDrive or Google Drive folder uploads the photos too.', ready: () => !!(tauri() || window.showDirectoryPicker) },
  { id: 'photos', name: tauri() ? 'Apple Photos (iCloud)' : 'Photos / iCloud (share sheet)', icon: 'image', hint: 'Photos added to Apple Photos upload to iCloud Photos when it’s turned on.', ready: () => (tauri() ? /Mac/.test(navigator.platform) : isApple && canShareFiles()) },
  { id: 'gphotos', name: 'Google Photos', icon: 'cloud', ready: () => !tauri() && !!CONFIG.googleClientId },
  { id: 'gdrive', name: 'Google Drive', icon: 'cloud', ready: () => !tauri() && !!CONFIG.googleClientId },
  { id: 'dropbox', name: 'Dropbox', icon: 'cloud', ready: () => !tauri() && !!CONFIG.dropboxAppKey },
  { id: 'onedrive', name: 'OneDrive', icon: 'cloud', ready: () => !tauri() && !!CONFIG.onedriveClientId },
];
export const destination = (id) => DESTINATIONS.find((d) => d.id === id) || DESTINATIONS[0];

async function ok(r, what) {
  if (r.ok) return r;
  let msg = '';
  try { const j = await r.clone().json(); msg = j.error?.message || j.error_summary || j.error_description || j.error || ''; } catch { /* not JSON */ }
  throw new Error(`${what}: ${typeof msg === 'string' && msg ? msg : `error ${r.status}`}`);
}

// ---- phone app: stage the files in the app's cache, then hand them to Photos or the share sheet
async function stagePhone(files, progress) {
  const paths = [];
  for (const [i, f] of files.entries()) {
    progress(`Preparing ${i + 1} of ${files.length}…`);
    paths.push(await tauri().invoke('stage_export', new Uint8Array(await f.blob.arrayBuffer()), { headers: { 'x-name': encodeURIComponent(f.name) } }));
  }
  return paths;
}
async function toPhoneLibrary(files, progress) {
  const paths = await stagePhone(files, progress);
  await tauri().invoke('plugin:mobile|save_to_photos', { paths });
}
async function toPhoneShare(files, progress) {
  const paths = await stagePhone(files, progress);
  await tauri().invoke('plugin:mobile|share', { paths });
}

// ---- this device
async function toDevice(files) {
  if (files.length === 1) return saveBlob(files[0].blob, files[0].name);
  return saveBlob(await makeZip(files), `photos-export-${new Date().toISOString().slice(0, 10)}.zip`);
}

// ---- a folder (web: File System Access; desktop: the app's folder commands)
async function toFolder(files, progress) {
  if (tauri()) {
    const dir = await tauri().invoke('pick_folder');
    if (!dir) throw Object.assign(new Error('cancelled'), { code: 'declined' });
    for (const [i, f] of files.entries()) {
      progress(`Saving ${i + 1} of ${files.length}…`);
      await tauri().invoke('write_export', new Uint8Array(await f.blob.arrayBuffer()), { headers: { 'x-dir': encodeURIComponent(dir), 'x-name': encodeURIComponent(f.name) } });
    }
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'export', mode: 'readwrite' }); } catch { throw Object.assign(new Error('cancelled'), { code: 'declined' }); }
  for (const [i, f] of files.entries()) {
    progress(`Saving ${i + 1} of ${files.length}…`);
    let handle;
    try { handle = await dir.getFileHandle(await freeName(dir, f.name), { create: true }); } catch (e) {
      // Some file systems refuse names outside ASCII; fall back to a plain version (Café → Cafe).
      if (e.name !== 'TypeMismatchError' && e.name !== 'InvalidModificationError' && e.name !== 'TypeError') throw e;
      handle = await dir.getFileHandle(await freeName(dir, asciiName(f.name)), { create: true });
    }
    const w = await handle.createWritable();
    await w.write(f.blob);
    await w.close();
  }
}
const asciiName = (n) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_');
async function freeName(dir, name) {
  const [base, ext] = [name.replace(/\.[^.]+$/, ''), name.match(/\.[^.]+$/)?.[0] || ''];
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${base} (${i})${ext}`;
    try { await dir.getFileHandle(n); } catch { return n; }
  }
}

// ---- Apple Photos: the Mac app hands files to Photos; iPhone/iPad/Safari use the share sheet
async function toApplePhotos(files, progress) {
  if (tauri()) {
    const paths = [];
    for (const [i, f] of files.entries()) {
      progress(`Preparing ${i + 1} of ${files.length}…`);
      paths.push(await tauri().invoke('stage_export', new Uint8Array(await f.blob.arrayBuffer()), { headers: { 'x-name': encodeURIComponent(f.name) } }));
    }
    await tauri().invoke('open_in_photos', { paths });
    return;
  }
  try {
    await navigator.share({ files: files.map((f) => new File([f.blob], f.name, { type: f.blob.type })) });
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('cancelled'), { code: 'declined' });
    throw e;
  }
}

// ---- Google Photos (Library API, append-only: we can add photos, never read the library)
async function toGooglePhotos(files, progress) {
  const token = await googleToken('https://www.googleapis.com/auth/photoslibrary.appendonly');
  const H = { Authorization: `Bearer ${token}` };
  const items = [];
  for (const [i, f] of files.entries()) {
    progress(`Uploading ${i + 1} of ${files.length} to Google Photos…`);
    const r = await ok(await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream', 'X-Goog-Upload-Content-Type': f.blob.type || 'image/jpeg', 'X-Goog-Upload-Protocol': 'raw' }, body: f.blob,
    }), 'Google Photos upload');
    items.push({ simpleMediaItem: { uploadToken: await r.text(), fileName: f.name } });
  }
  for (let i = 0; i < items.length; i += 50) {
    const r = await ok(await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ newMediaItems: items.slice(i, i + 50) }),
    }), 'Google Photos');
    const bad = ((await r.json()).newMediaItemResults || []).filter((x) => x.status?.code);
    if (bad.length) throw new Error(`Google Photos refused ${bad.length} photo(s): ${bad[0].status.message}`);
  }
}

// ---- Google Drive (files the app creates only; folder "Rembrandt")
async function toGoogleDrive(files, progress) {
  const token = await googleToken('https://www.googleapis.com/auth/drive.file');
  const H = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  let folder = (await (await ok(await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: H }), 'Google Drive')).json()).files?.[0]?.id;
  if (!folder) {
    folder = (await (await ok(await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) }), 'Google Drive')).json()).id;
  }
  for (const [i, f] of files.entries()) {
    progress(`Uploading ${i + 1} of ${files.length} to Google Drive…`);
    const body = new FormData();
    body.append('metadata', new Blob([JSON.stringify({ name: f.name, parents: [folder] })], { type: 'application/json' }));
    body.append('file', f.blob);
    await ok(await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: H, body }), 'Google Drive upload');
  }
}

// ---- Dropbox (app folder: Apps/Rembrandt)
const dropboxAuth = () => ({ key: 'dropbox', authorizeUrl: 'https://www.dropbox.com/oauth2/authorize', tokenUrl: 'https://api.dropboxapi.com/oauth2/token', clientId: CONFIG.dropboxAppKey, extra: { token_access_type: 'online' } });
// Dropbox-API-Arg must be ASCII: escape everything else as \uXXXX.
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function toDropbox(files, progress) {
  const token = await pkceToken(dropboxAuth());
  for (const [i, f] of files.entries()) {
    progress(`Uploading ${i + 1} of ${files.length} to Dropbox…`);
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': asciiJson({ path: `/${f.name}`, mode: 'add', autorename: true }) },
      body: f.blob,
    });
    if (r.status === 401) forgetToken('dropbox');
    await ok(r, 'Dropbox');
  }
}

// ---- OneDrive (app folder: Apps/Rembrandt)
const onedriveAuth = () => ({ key: 'onedrive', authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', clientId: CONFIG.onedriveClientId, scope: 'Files.ReadWrite.AppFolder', sendScope: true });
async function toOneDrive(files, progress) {
  const token = await pkceToken(onedriveAuth());
  for (const [i, f] of files.entries()) {
    progress(`Uploading ${i + 1} of ${files.length} to OneDrive…`);
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(f.name)}:/content?@microsoft.graph.conflictBehavior=rename`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': f.blob.type || 'application/octet-stream' }, body: f.blob,
    });
    if (r.status === 401) forgetToken('onedrive');
    await ok(r, 'OneDrive');
  }
}

const SENDERS = isMobileApp ? { device: toPhoneLibrary, photos: toPhoneShare } : { device: toDevice, folder: toFolder, photos: toApplePhotos, gphotos: toGooglePhotos, gdrive: toGoogleDrive, dropbox: toDropbox, onedrive: toOneDrive };

// Sends rendered files ({ name, blob }[]) to a destination. Throws { code: 'declined' } if the user cancels.
export async function deliver(destId, files, progress = () => {}) {
  const d = destination(destId);
  if (!d.ready()) throw new Error(`${d.name} isn’t available here`);
  await SENDERS[d.id](files, progress);
  return d;
}
