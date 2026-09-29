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
            write_export, stage_export, open_in_photos
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
