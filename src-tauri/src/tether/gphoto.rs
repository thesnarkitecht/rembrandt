// Tethering on Linux with libgphoto2 (LGPL), the library darktable, Entangle and digiKam use; it knows
// some 2,500 cameras. It is loaded when tethering starts, so Rembrandt runs without it; when it's
// missing, the panel says which package to install.
//
// One thread owns the camera (libgphoto2 isn't meant to be shared between threads): it looks for
// cameras every two seconds while none is connected, and while one is, waits for its events, so a
// photo taken with the camera's own shutter button arrives too. Commands reach it over a channel.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use libloading::Library;

use super::{emit, Camera, Event};

const GP_OK: c_int = 0;
const GP_CAPTURE_IMAGE: c_int = 0;
const GP_FILE_TYPE_NORMAL: c_int = 1;
const GP_EVENT_FILE_ADDED: c_int = 2;

#[repr(C)]
struct CameraFilePath {
    name: [c_char; 128],
    folder: [c_char; 1024],
}

type P = *mut c_void;

// The functions used, from libgphoto2 and libgphoto2_port.
struct Gp {
    _lib: Library,
    _port: Library,
    context_new: unsafe extern "C" fn() -> P,
    list_new: unsafe extern "C" fn(*mut P) -> c_int,
    list_free: unsafe extern "C" fn(P) -> c_int,
    list_count: unsafe extern "C" fn(P) -> c_int,
    list_get_name: unsafe extern "C" fn(P, c_int, *mut *const c_char) -> c_int,
    list_get_value: unsafe extern "C" fn(P, c_int, *mut *const c_char) -> c_int,
    autodetect: unsafe extern "C" fn(P, P) -> c_int,
    camera_new: unsafe extern "C" fn(*mut P) -> c_int,
    camera_init: unsafe extern "C" fn(P, P) -> c_int,
    camera_exit: unsafe extern "C" fn(P, P) -> c_int,
    camera_free: unsafe extern "C" fn(P) -> c_int,
    camera_set_port_info: unsafe extern "C" fn(P, P) -> c_int,
    camera_capture: unsafe extern "C" fn(P, c_int, *mut CameraFilePath, P) -> c_int,
    camera_wait_for_event: unsafe extern "C" fn(P, c_int, *mut c_int, *mut P, P) -> c_int,
    camera_file_get: unsafe extern "C" fn(P, *const c_char, *const c_char, c_int, P, P) -> c_int,
    file_new: unsafe extern "C" fn(*mut P) -> c_int,
    file_save: unsafe extern "C" fn(P, *const c_char) -> c_int,
    file_free: unsafe extern "C" fn(P) -> c_int,
    result_as_string: unsafe extern "C" fn(c_int) -> *const c_char,
    port_info_list_new: unsafe extern "C" fn(*mut P) -> c_int,
    port_info_list_load: unsafe extern "C" fn(P) -> c_int,
    port_info_list_lookup_path: unsafe extern "C" fn(P, *const c_char) -> c_int,
    port_info_list_get_info: unsafe extern "C" fn(P, c_int, *mut P) -> c_int,
    port_info_list_free: unsafe extern "C" fn(P) -> c_int,
}

unsafe impl Send for Gp {}
unsafe impl Sync for Gp {}

fn load() -> Result<Gp, String> {
    let open = |names: &[&str]| names.iter().find_map(|n| unsafe { Library::new(*n) }.ok());
    let missing = || "Tethered shooting on Linux needs libgphoto2: install the libgphoto2-6 package (libgphoto2 on Arch and Fedora), then open this again.".to_string();
    let lib = open(&["libgphoto2.so.6", "libgphoto2.so"]).ok_or_else(missing)?;
    let port = open(&["libgphoto2_port.so.12", "libgphoto2_port.so"]).ok_or_else(missing)?;
    unsafe {
        macro_rules! f {
            ($l:expr, $n:literal) => {
                *$l.get($n).map_err(|e| format!("libgphoto2: {e}"))?
            };
        }
        Ok(Gp {
            context_new: f!(lib, b"gp_context_new\0"),
            list_new: f!(lib, b"gp_list_new\0"),
            list_free: f!(lib, b"gp_list_free\0"),
            list_count: f!(lib, b"gp_list_count\0"),
            list_get_name: f!(lib, b"gp_list_get_name\0"),
            list_get_value: f!(lib, b"gp_list_get_value\0"),
            autodetect: f!(lib, b"gp_camera_autodetect\0"),
            camera_new: f!(lib, b"gp_camera_new\0"),
            camera_init: f!(lib, b"gp_camera_init\0"),
            camera_exit: f!(lib, b"gp_camera_exit\0"),
            camera_free: f!(lib, b"gp_camera_free\0"),
            camera_set_port_info: f!(lib, b"gp_camera_set_port_info\0"),
            camera_capture: f!(lib, b"gp_camera_capture\0"),
            camera_wait_for_event: f!(lib, b"gp_camera_wait_for_event\0"),
            camera_file_get: f!(lib, b"gp_camera_file_get\0"),
            file_new: f!(lib, b"gp_file_new\0"),
            file_save: f!(lib, b"gp_file_save\0"),
            file_free: f!(lib, b"gp_file_free\0"),
            result_as_string: f!(lib, b"gp_result_as_string\0"),
            port_info_list_new: f!(port, b"gp_port_info_list_new\0"),
            port_info_list_load: f!(port, b"gp_port_info_list_load\0"),
            port_info_list_lookup_path: f!(port, b"gp_port_info_list_lookup_path\0"),
            port_info_list_get_info: f!(port, b"gp_port_info_list_get_info\0"),
            port_info_list_free: f!(port, b"gp_port_info_list_free\0"),
            _lib: lib,
            _port: port,
        })
    }
}

enum Cmd {
    Connect(String),
    Capture,
    Disconnect,
}

static TX: Mutex<Option<Sender<Cmd>>> = Mutex::new(None);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn send(cmd: Cmd) -> Result<(), String> {
    TX.lock().unwrap().as_ref().ok_or("Tethering isn’t running")?.send(cmd).map_err(|e| e.to_string())
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    let mut tx = TX.lock().unwrap();
    if tx.is_some() {
        return Ok(());
    }
    let gp = load()?;
    let (s, r) = channel();
    *tx = Some(s);
    let app = app.clone();
    std::thread::Builder::new().name("tether".into()).spawn(move || Worker::new(gp, app).run(r)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn connect(_app: &tauri::AppHandle, id: String) -> Result<(), String> {
    send(Cmd::Connect(id))
}
pub fn capture(_app: &tauri::AppHandle) -> Result<(), String> {
    send(Cmd::Capture)
}
pub fn disconnect(_app: &tauri::AppHandle) -> Result<(), String> {
    send(Cmd::Disconnect)
}

struct Worker {
    gp: Gp,
    app: tauri::AppHandle,
    ctx: P,
    camera: P,
    port: String,
    name: String,
    listed: Vec<(String, String)>,
    // The last RAW brought in (its name without extension, lower case), and when: its JPEG twin
    // (RAW + JPEG shooting) stays on the card.
    last_raw: (String, std::time::Instant),
}

impl Worker {
    fn new(gp: Gp, app: tauri::AppHandle) -> Self {
        let ctx = unsafe { (gp.context_new)() };
        Worker { gp, app, ctx, camera: std::ptr::null_mut(), port: String::new(), name: String::new(), listed: Vec::new(), last_raw: (String::new(), std::time::Instant::now()) }
    }

    fn err(&self, what: &str, code: c_int) -> String {
        let s = unsafe { CStr::from_ptr((self.gp.result_as_string)(code)) }.to_string_lossy();
        format!("{what}: {s}")
    }

    // Cameras on USB now: (port, model).
    fn detect(&mut self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        unsafe {
            let mut list: P = std::ptr::null_mut();
            if (self.gp.list_new)(&mut list) != GP_OK {
                return out;
            }
            if (self.gp.autodetect)(list, self.ctx) >= GP_OK {
                for i in 0..(self.gp.list_count)(list).max(0) {
                    let (mut n, mut v): (*const c_char, *const c_char) = (std::ptr::null(), std::ptr::null());
                    if (self.gp.list_get_name)(list, i, &mut n) == GP_OK && (self.gp.list_get_value)(list, i, &mut v) == GP_OK && !n.is_null() && !v.is_null() {
                        let model = CStr::from_ptr(n).to_string_lossy().into_owned();
                        let port = CStr::from_ptr(v).to_string_lossy().into_owned();
                        if port.starts_with("usb:") && port != "usb:" {
                            out.push((port, model));
                        }
                    }
                }
            }
            (self.gp.list_free)(list);
        }
        out
    }

    fn announce(&mut self, found: Vec<(String, String)>) {
        if found != self.listed {
            self.listed = found;
            emit(&self.app, Event::Cameras { cameras: self.listed.iter().map(|(id, name)| Camera { id: id.clone(), name: name.clone() }).collect() });
        }
    }

    fn open(&mut self, port: &str) -> Result<(), String> {
        self.close(None);
        let name = self.listed.iter().find(|(p, _)| p == port).map(|(_, n)| n.clone()).unwrap_or_else(|| "Camera".into());
        unsafe {
            let mut cam: P = std::ptr::null_mut();
            let r = (self.gp.camera_new)(&mut cam);
            if r != GP_OK {
                return Err(self.err("Couldn’t start", r));
            }
            let mut infos: P = std::ptr::null_mut();
            if (self.gp.port_info_list_new)(&mut infos) == GP_OK {
                (self.gp.port_info_list_load)(infos);
                let p = CString::new(port).unwrap_or_default();
                let i = (self.gp.port_info_list_lookup_path)(infos, p.as_ptr());
                let mut info: P = std::ptr::null_mut();
                if i >= GP_OK && (self.gp.port_info_list_get_info)(infos, i, &mut info) == GP_OK {
                    (self.gp.camera_set_port_info)(cam, info);
                }
                (self.gp.port_info_list_free)(infos);
            }
            let r = (self.gp.camera_init)(cam, self.ctx);
            if r != GP_OK {
                (self.gp.camera_free)(cam);
                // Usually the desktop has mounted the camera (gvfs) and holds it.
                return Err(format!(
                    "{}. If your file manager shows the camera, unmount it there (or close that window), then switch the camera off and on.",
                    self.err("Couldn’t connect to the camera", r)
                ));
            }
            self.camera = cam;
        }
        self.port = port.to_string();
        self.name = name.clone();
        emit(&self.app, Event::Connected { id: port.to_string(), name, can_capture: true });
        Ok(())
    }

    fn close(&mut self, reason: Option<String>) {
        if self.camera.is_null() {
            return;
        }
        unsafe {
            (self.gp.camera_exit)(self.camera, self.ctx);
            (self.gp.camera_free)(self.camera);
        }
        self.camera = std::ptr::null_mut();
        emit(&self.app, Event::Disconnected { id: std::mem::take(&mut self.port), reason });
    }

    // Copies a photo off the camera into the tether folder (leaving it on the card too).
    fn download(&mut self, path: &CameraFilePath) {
        let folder = unsafe { CStr::from_ptr(path.folder.as_ptr()) };
        let name = unsafe { CStr::from_ptr(path.name.as_ptr()) }.to_string_lossy().into_owned();
        let (stem, ext) = split(&name);
        if matches!(ext.as_str(), "jpg" | "jpeg") && self.last_raw.0 == stem && self.last_raw.1.elapsed() < Duration::from_secs(10) {
            return;
        }
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "tif" | "tiff" | "heif" | "hif") {
            self.last_raw = (stem, std::time::Instant::now());
        }
        emit(&self.app, Event::Shot { name: name.clone() });
        let dir = match super::folder(&self.app) {
            Ok(d) => d,
            Err(e) => return emit(&self.app, Event::Error { message: e }),
        };
        let dest = free_name(dir.join(&name));
        unsafe {
            let mut file: P = std::ptr::null_mut();
            if (self.gp.file_new)(&mut file) != GP_OK {
                return;
            }
            let cname = CString::new(name.as_str()).unwrap_or_default();
            let r = (self.gp.camera_file_get)(self.camera, folder.as_ptr(), cname.as_ptr(), GP_FILE_TYPE_NORMAL, file, self.ctx);
            let saved = r == GP_OK && {
                let d = CString::new(dest.to_string_lossy().as_bytes()).unwrap_or_default();
                (self.gp.file_save)(file, d.as_ptr()) == GP_OK
            };
            (self.gp.file_free)(file);
            if !saved {
                return emit(&self.app, Event::Error { message: self.err(&format!("{name} couldn’t be copied from the camera"), r) });
            }
        }
        super::arrived(&self.app, dest);
    }

    fn capture(&mut self) {
        if self.camera.is_null() {
            return emit(&self.app, Event::Error { message: "Connect a camera first".into() });
        }
        let mut path = CameraFilePath { name: [0; 128], folder: [0; 1024] };
        let r = unsafe { (self.gp.camera_capture)(self.camera, GP_CAPTURE_IMAGE, &mut path, self.ctx) };
        if r != GP_OK {
            // Most often: no focus lock (autofocus couldn't find anything), or the camera is busy.
            return emit(&self.app, Event::Error { message: self.err("The camera didn’t take the photo (check focus)", r) });
        }
        self.download(&path);
    }

    // Camera events for up to `ms`: photos taken with the camera's own shutter button.
    fn poll(&mut self, ms: c_int) {
        let mut kind: c_int = 0;
        let mut data: P = std::ptr::null_mut();
        let r = unsafe { (self.gp.camera_wait_for_event)(self.camera, ms, &mut kind, &mut data, self.ctx) };
        if r != GP_OK {
            // The camera went away (switched off, cable out).
            if !self.detect().iter().any(|(p, _)| *p == self.port) {
                self.close(Some("The camera was disconnected".into()));
            }
            return;
        }
        if kind == GP_EVENT_FILE_ADDED && !data.is_null() {
            let path = unsafe { &*(data as *const CameraFilePath) };
            self.download(path);
        }
        if !data.is_null() {
            unsafe { libc_free(data) };
        }
    }

    fn run(mut self, rx: Receiver<Cmd>) {
        let found = self.detect();
        self.announce(found);
        loop {
            let wait = if self.camera.is_null() { Duration::from_secs(2) } else { Duration::from_millis(50) };
            match rx.recv_timeout(wait) {
                Ok(Cmd::Connect(port)) => {
                    if let Err(e) = self.open(&port) {
                        emit(&self.app, Event::Error { message: e });
                    }
                }
                Ok(Cmd::Capture) => self.capture(),
                Ok(Cmd::Disconnect) => self.close(None),
                Err(RecvTimeoutError::Timeout) => {
                    if self.camera.is_null() {
                        let found = self.detect();
                        self.announce(found);
                    } else {
                        self.poll(200);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        self.close(None);
    }
}

extern "C" {
    #[link_name = "free"]
    fn libc_free(p: *mut c_void);
}

fn split(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((s, e)) => (s.to_ascii_lowercase(), e.to_ascii_lowercase()),
        None => (name.to_ascii_lowercase(), String::new()),
    }
}

// Never overwrite: IMG_0001.NEF, then IMG_0001-2.NEF (the camera's counter restarts on a new card).
fn free_name(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    (2..).map(|i| p.with_file_name(format!("{stem}-{i}{ext}"))).find(|c| !c.exists()).unwrap()
}
