// Native shell (Tauri 2): hosts the web app in the system WebView on macOS, Windows, Linux, iOS and
// Android, and adds what a browser can't do: synced folders on disk, and OAuth sign-in through the
// system browser with a deep link back.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{ipc::Response, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    /// OAuth result delivered by `rembrandt://auth?code=…&state=…`, waiting for the web app to take it.
    auth_code: Mutex<Option<(String, String)>>,
    /// Folders the user picked; file commands only work inside these.
    roots: Mutex<Vec<PathBuf>>,
}

const PHOTO_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "avif", "heic", "heif", "tif", "tiff", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf",
    "sr2", "raf", "orf", "rw2", "pef", "srw", "x3f", "3fr", "iiq", "mos", "erf", "kdc", "mrw", "rwl",
];

#[derive(Serialize)]
struct Entry {
    path: String,
    name: String,
    size: u64,
    modified: u64,
    sidecar: bool,
}

fn allowed(state: &AppState, p: &Path) -> Result<PathBuf, String> {
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let roots = state.roots.lock().unwrap();
    if roots.iter().any(|r| canon.starts_with(r)) {
        Ok(canon)
    } else {
        Err("This file is outside your synced folders".into())
    }
}

// The folders the user picked are remembered here, outside the web view, so the web side can only
// ever get back access to folders the user chose in the system folder picker.
fn picked_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("picked-folders.json"))
}

fn picked_folders(app: &tauri::AppHandle) -> Vec<PathBuf> {
    picked_file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Vec<PathBuf>>(&b).ok())
        .unwrap_or_default()
}

fn save_picked(app: &tauri::AppHandle, list: &[PathBuf]) -> Result<(), String> {
    let f = picked_file(app).ok_or("No app data folder")?;
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(f, serde_json::to_vec(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Folder picker; the chosen folder becomes a synced root.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let canon = path.canonicalize().map_err(|e| e.to_string())?;
    let mut saved = picked_folders(&app);
    if !saved.contains(&canon) {
        saved.push(canon.clone());
        save_picked(&app, &saved)?;
    }
    state.roots.lock().unwrap().push(canon.clone());
    Ok(Some(canon.to_string_lossy().into_owned()))
}

/// Re-allow folders from an earlier session: only ones the user picked, and that still exist.
#[tauri::command]
fn restore_folders(app: tauri::AppHandle, paths: Vec<String>, state: State<'_, AppState>) -> Vec<String> {
    let saved = picked_folders(&app);
    let mut ok = Vec::new();
    let mut roots = state.roots.lock().unwrap();
    for p in paths {
        if let Ok(c) = Path::new(&p).canonicalize() {
            if c.is_dir() && saved.contains(&c) {
                roots.push(c.clone());
                ok.push(c.to_string_lossy().into_owned());
            }
        }
    }
    ok
}

/// Stops syncing a folder: no more access to it, now or after a restart.
#[tauri::command]
fn forget_folder(app: tauri::AppHandle, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let c = Path::new(&path).canonicalize().unwrap_or_else(|_| PathBuf::from(&path));
    state.roots.lock().unwrap().retain(|r| r != &c);
    let mut saved = picked_folders(&app);
    saved.retain(|r| r != &c);
    save_picked(&app, &saved)
}

/// Photos (and their .xmp sidecars) under a synced folder, recursively.
#[tauri::command]
fn list_photos(root: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let root = allowed(&state, Path::new(&root))?;
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(p);
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            let sidecar = ext == "xmp";
            if !sidecar && !PHOTO_EXT.contains(&ext.as_str()) {
                continue;
            }
            let modified = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            out.push(Entry { path: p.to_string_lossy().into_owned(), name, size: md.len(), modified, sidecar });
        }
    }
    Ok(out)
}

#[tauri::command]
fn read_file(path: String, state: State<'_, AppState>) -> Result<Response, String> {
    let p = allowed(&state, Path::new(&path))?;
    std::fs::read(p).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(None);
    }
    let p = allowed(&state, p)?;
    std::fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
}

/// Writes a sidecar next to a photo (only .xmp files, only inside synced folders).
#[tauri::command]
fn write_sidecar(path: String, text: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = Path::new(&path);
    if p.extension().map(|x| x.to_string_lossy().to_lowercase()) != Some("xmp".into()) {
        return Err("Only .xmp sidecars can be written".into());
    }
    let parent = p.parent().ok_or("Bad path")?;
    let dir = allowed(&state, parent)?;
    let name = p.file_name().ok_or("Bad path")?;
    let target = dir.join(name);
    // Never follow a link: it could point outside the synced folder.
    if std::fs::symlink_metadata(&target).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err("Sidecar is a link; not writing through it".into());
    }
    std::fs::write(target, text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- export

const EXPORT_EXT: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// File name from the web app: no folders, an image extension, and not already taken.
fn export_name(dir: &Path, raw: &str) -> Result<PathBuf, String> {
    let name = Path::new(raw).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = Path::new(&name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.is_empty() || name.starts_with('.') || !EXPORT_EXT.contains(&ext.as_str()) {
        return Err("Not an image file name".into());
    }
    let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut path = dir.join(&name);
    let mut i = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
    }
    Ok(path)
}

fn header(req: &tauri::ipc::Request<'_>, key: &str) -> Result<String, String> {
    let v = req.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("missing {key}"))?;
    Ok(urlencoding_decode(v))
}

fn body(req: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected file bytes".into()),
    }
}

/// Saves an exported image into a folder the user picked. Returns the path written.
#[tauri::command]
fn write_export(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<String, String> {
    let dir = allowed(&state, Path::new(&header(&request, "x-dir")?))?;
    let path = export_name(&dir, &header(&request, "x-name")?)?;
    std::fs::write(&path, body(&request)?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// In the app's own cache folder (not the shared temp folder, where another account could plant files).
fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("export"))
}

/// Writes an exported image to a private staging folder (for handing to Apple Photos).
#[tauri::command]
fn stage_export(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let dir = staging_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = export_name(&dir, &header(&request, "x-name")?)?;
    std::fs::write(&path, body(&request)?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Adds staged images to Apple Photos (which uploads them to iCloud Photos when that's on).
#[tauri::command]
fn open_in_photos(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let dir = staging_dir(&app)?.canonicalize().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for p in &paths {
        let c = Path::new(p).canonicalize().map_err(|e| e.to_string())?;
        if !c.starts_with(&dir) {
            return Err("Only exported files can be sent to Photos".into());
        }
        files.push(c);
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open").arg("-a").arg("Photos").args(&files).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Photos couldn't open the files".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = files;
        Err("Apple Photos is only on macOS".into())
    }
}

#[tauri::command]
fn take_auth_code(state: State<'_, AppState>) -> Option<serde_json::Value> {
    state.auth_code.lock().unwrap().take().map(|(code, st)| serde_json::json!({ "code": code, "state": st }))
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

fn handle_urls(app: &tauri::AppHandle, urls: &[String]) {
    for u in urls {
        if let Some(q) = u.strip_prefix("rembrandt://auth?") {
            let (mut code, mut st) = (None, String::new());
            for pair in q.split('&') {
                if let Some(v) = pair.strip_prefix("code=") {
                    code = Some(urlencoding_decode(v));
                } else if let Some(v) = pair.strip_prefix("state=") {
                    st = urlencoding_decode(v);
                }
            }
            if let Some(c) = code {
                *app.state::<AppState>().auth_code.lock().unwrap() = Some((c, st));
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }
    }
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- In-app updates (desktop), never needing an administrator password: Windows installs per user
// (NSIS currentUser), macOS replaces the app's contents in place, Linux replaces the AppImage. Asks GitHub for the latest release of this repository, downloads
// the installer for this platform over HTTPS, checks it against the release's SHA256SUMS (a broken
// or partial download is never installed), installs it and restarts. Progress is polled by the
// web side. Phones update from their stores.

const REPO: &str = "thesnarkitecht/rembrandt";

#[derive(Default)]
struct UpdateState {
    /// The release found by `update_check`: version, installer URL and name, SHA256SUMS URL.
    pending: Mutex<Option<(String, String, String, String)>>,
    /// Bytes downloaded, and the total if the server said.
    progress: Mutex<(u64, Option<u64>)>,
}

/// The installer this copy of the app updates from, as named in the release.
#[cfg(desktop)]
fn update_asset() -> Result<String, String> {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    if cfg!(windows) {
        Ok(format!("Rembrandt-windows-{arch}-setup.exe"))
    } else if cfg!(target_os = "macos") {
        Ok(format!("Rembrandt-macos-{arch}.dmg"))
    } else if std::env::var_os("APPIMAGE").is_some() {
        Ok(format!("Rembrandt-linux-{}.AppImage", if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" }))
    } else {
        // Installed from a .deb/.rpm or the install script: the package manager or the script updates it.
        Err("Update this copy the way you installed it".into())
    }
}

fn newer(a: &str, b: &str) -> bool {
    let p = |v: &str| v.split(|c| c == '.' || c == '-').take(3).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    p(a) > p(b)
}

#[cfg(desktop)]
fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("Rembrandt-updater").build().map_err(|e| e.to_string())
}

/// Looks for a newer release. Resolves its version number, or null when this is the latest.
#[tauri::command]
async fn update_check(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let asset = update_asset()?;
        let rel: serde_json::Value = http()?
            .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
            .header("Accept", "application/vnd.github+json")
            .send().await.map_err(|e| e.to_string())?
            .error_for_status().map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        let version = rel["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
        let url_of = |name: &str| {
            rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == name)).and_then(|x| x["browser_download_url"].as_str()).map(String::from)
        };
        let current = app.package_info().version.to_string();
        match (url_of(&asset), url_of("SHA256SUMS")) {
            (Some(url), Some(sums)) if newer(&version, &current) => {
                *state.pending.lock().unwrap() = Some((version.clone(), url, asset, sums));
                Ok(Some(version))
            }
            _ => Ok(None),
        }
    }
    #[cfg(mobile)]
    {
        let _ = (app, state);
        Err("Updates come from the app store".into())
    }
}

/// Downloads and installs the release found by `update_check`, then restarts into it.
#[tauri::command]
async fn update_install(app: tauri::AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use sha2::{Digest, Sha256};
        let (_version, url, name, sums_url) = state.pending.lock().unwrap().clone().ok_or("Check for updates first")?;
        let client = http()?;
        let sums = client.get(&sums_url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?
            .text().await.map_err(|e| e.to_string())?;
        let expected = sums.lines().find_map(|l| {
            let mut it = l.split_whitespace();
            let (h, f) = (it.next()?, it.next()?);
            (f.trim_start_matches('*') == name).then(|| h.to_lowercase())
        }).ok_or("The release has no checksum for this installer")?;

        *state.progress.lock().unwrap() = (0, None);
        let mut resp = client.get(&url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
        state.progress.lock().unwrap().1 = resp.content_length();
        let dir = std::env::temp_dir().join("rembrandt-update");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(&name);
        let mut out = std::fs::File::create(&file).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            use std::io::Write;
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            state.progress.lock().unwrap().0 += chunk.len() as u64;
        }
        drop(out);
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != expected {
            let _ = std::fs::remove_file(&file);
            return Err("The download was damaged (checksum mismatch). Try again.".into());
        }
        install_and_restart(&app, &file)
    }
    #[cfg(mobile)]
    {
        let _ = (app, state);
        Err("Updates come from the app store".into())
    }
}

// Hands over to the installer and quits; the new version starts when it's done.
#[cfg(windows)]
fn install_and_restart(app: &tauri::AppHandle, setup: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let q = |p: &Path| p.to_string_lossy().replace('\'', "''");
    // Passive install (a progress bar, no questions), then open the app again.
    let script = format!(
        "Start-Process -Wait -FilePath '{}' -ArgumentList '/P','/UPDATE'; Start-Process -FilePath '{}'",
        q(setup), q(exe.as_path())
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_and_restart(app: &tauri::AppHandle, dmg: &Path) -> Result<(), String> {
    // The running app's bundle: …/Rembrandt.app/Contents/MacOS/rembrandt.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe.ancestors().nth(3).ok_or("Can't find the app")?.to_path_buf();
    let mnt = std::env::temp_dir().join("rembrandt-update-mnt");
    let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
    // After this app quits: replace what's inside the app with the new version, then open it.
    // Only the contents change (they belong to the person who installed it), so no administrator
    // password is needed, even in /Applications.
    let script = format!(
        "sleep 1; hdiutil attach -nobrowse -readonly -mountpoint {m} {d} >/dev/null && \
         src=$(ls -d {m}/*.app | head -1) && [ -d \"$src/Contents\" ] && \
         rm -rf {b}/Contents.old && mv {b}/Contents {b}/Contents.old && ditto \"$src/Contents\" {b}/Contents && rm -rf {b}/Contents.old; \
         [ -d {b}/Contents ] || mv {b}/Contents.old {b}/Contents; \
         hdiutil detach {m} -quiet; xattr -dr com.apple.quarantine {b} 2>/dev/null; touch {b}; open {b}",
        m = q(mnt.as_path()), d = q(dmg), b = q(bundle.as_path())
    );
    std::process::Command::new("/bin/sh").args(["-c", &script]).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(all(desktop, not(windows), not(target_os = "macos")))]
fn install_and_restart(app: &tauri::AppHandle, image: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    // AppImage: replace the file in place (a running AppImage can be replaced), then start it.
    let target = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("Not running as an AppImage")?);
    let tmp = target.with_extension("AppImage.new");
    std::fs::copy(image, &tmp).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    std::process::Command::new(&target).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn update_progress(state: State<'_, UpdateState>) -> (u64, Option<u64>) {
    *state.progress.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second launch (e.g. from the sign-in deep link) hands its URL to the running app.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let urls: Vec<String> = argv.into_iter().filter(|a| a.starts_with("rembrandt://")).collect();
            handle_urls(app, &urls);
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(UpdateState::default())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                handle_urls(&handle, &urls);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info, take_auth_code, pick_folder, restore_folders, forget_folder, list_photos, read_file, read_text, write_sidecar,
            write_export, stage_export, open_in_photos, update_check, update_install, update_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
