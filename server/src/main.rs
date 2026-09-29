// rembrandt-server: serves the Rembrandt web app and one folder of photos to your browser, so you
// can edit the photos on this computer (or, if you allow it, from another device on your network).
// Edits are written next to the photos as XMP sidecars; the photos themselves are never changed.
//
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
//
// Security model
// - Every request needs the access key: it's in the link the server prints, and the browser keeps
//   it in a cookie after the first visit. Without it you get a short "ask for the link" page.
// - Only files inside the photos folder can be read (links pointing outside are refused), and only
//   .xmp sidecars can be written.
// - It listens on 127.0.0.1 unless you pass --host. On a network, put it behind HTTPS.

use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_SIDECAR: usize = 4 * 1024 * 1024;
const MAX_HEADER: usize = 16 * 1024;
const PHOTO_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "avif", "heic", "heif", "tif", "tiff", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf",
    "sr2", "raf", "orf", "rw2", "pef", "srw", "x3f", "3fr", "iiq", "mos", "erf", "kdc", "mrw", "rwl", "dcr", "mef", "raw",
];

struct Config {
    photos: PathBuf,
    web: PathBuf,
    host: String,
    port: u16,
    key: String,
    client: String, // JSON merged into window.LUMEN_CONFIG (API keys for Google etc.)
}

fn usage() -> ! {
    eprintln!(
        "rembrandt-server {VERSION}\n\
         Serves Rembrandt and a folder of photos to your browser.\n\n\
         Usage: rembrandt-server --photos <folder> [options]\n\n\
         Options:\n\
         \x20 --photos <folder>   the photos to edit (required)\n\
         \x20 --port <n>          port (default 8420)\n\
         \x20 --host <addr>       address to listen on (default 127.0.0.1; 0.0.0.0 for your network)\n\
         \x20 --web <folder>      the Rembrandt web app (default: ./web next to this program)\n\
         \x20 --config <file>     settings file (default: ~/.config/rembrandt/server.conf)\n\
         \x20 --new-key           make a new access key (old links stop working)\n\
         \x20 --print-url         print the link and exit"
    );
    std::process::exit(2)
}

fn config_dir() -> PathBuf {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return PathBuf::from(x).join("rembrandt");
        }
    }
    if let Ok(x) = std::env::var("APPDATA") {
        return PathBuf::from(x).join("Rembrandt");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("rembrandt")
}

// 256 bits from the operating system's random source (RandomState is seeded by it), hex-encoded.
fn random_key() -> String {
    let mut out = String::new();
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn load_key(dir: &Path, fresh: bool) -> String {
    let f = dir.join("access-key");
    if !fresh {
        if let Ok(k) = fs::read_to_string(&f) {
            let k = k.trim().to_string();
            if k.len() >= 32 && k.chars().all(|c| c.is_ascii_hexdigit()) {
                return k;
            }
        }
    }
    let k = random_key();
    let _ = fs::create_dir_all(dir);
    if fs::write(&f, &k).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&f, fs::Permissions::from_mode(0o600));
        }
    }
    k
}

// server.conf: `key = value` lines. Keys: photos, port, host, web, and the web app's optional
// service keys (googleClientId, googleApiKey, googleAppId, dropboxAppKey, onedriveClientId,
// adobeClientId, supportUrl, siteUrl).
fn read_conf(path: &Path) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(path) else { return vec![] };
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let (k, v) = l.split_once('=')?;
            Some((k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        })
        .collect()
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '<' => o.push_str("\\u003c"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn parse_args() -> Config {
    let mut args = std::env::args().skip(1);
    let (mut photos, mut web, mut host, mut port, mut conf) = (None, None, None, None, None);
    let (mut fresh, mut print_only) = (false, false);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--photos" => photos = args.next(),
            "--web" => web = args.next(),
            "--host" => host = args.next(),
            "--port" => port = args.next(),
            "--config" => conf = args.next(),
            "--new-key" => fresh = true,
            "--print-url" => print_only = true,
            "--version" | "-V" => { println!("rembrandt-server {VERSION}"); std::process::exit(0) }
            _ => usage(),
        }
    }
    let dir = config_dir();
    let conf_path = conf.map(PathBuf::from).unwrap_or_else(|| dir.join("server.conf"));
    let mut client = Vec::new();
    for (k, v) in read_conf(&conf_path) {
        match k.as_str() {
            "photos" => { photos.get_or_insert(v); }
            "web" => { web.get_or_insert(v); }
            "host" => { host.get_or_insert(v); }
            "port" => { port.get_or_insert(v); }
            "googleClientId" | "googleApiKey" | "googleAppId" | "dropboxAppKey" | "onedriveClientId" | "adobeClientId" | "supportUrl" | "siteUrl" => {
                client.push(format!("{}:{}", json_str(&k), json_str(&v)))
            }
            _ => eprintln!("server.conf: unknown setting {k}"),
        }
    }
    let Some(photos) = photos else { usage() };
    let photos = match PathBuf::from(&photos).canonicalize() {
        Ok(p) if p.is_dir() => p,
        _ => { eprintln!("Photos folder not found: {photos}"); std::process::exit(1) }
    };
    let web = web.map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
        exe.join("web")
    });
    let web = match web.canonicalize() {
        Ok(p) if p.join("index.html").is_file() => p,
        _ => { eprintln!("Rembrandt web app not found at {} (use --web)", web.display()); std::process::exit(1) }
    };
    let port = port.map(|p| p.parse().unwrap_or_else(|_| usage())).unwrap_or(8420);
    let key = load_key(&dir, fresh);
    let cfg = Config { photos, web, host: host.unwrap_or_else(|| "127.0.0.1".into()), port, key, client: client.join(",") };
    if print_only {
        println!("{}", link(&cfg));
        std::process::exit(0)
    }
    cfg
}

fn link(c: &Config) -> String {
    // "localhost", so every install opens Rembrandt at the same address (http://localhost:8420):
    // Google, Dropbox and Microsoft only accept addresses registered with them in advance.
    let local = matches!(c.host.as_str(), "0.0.0.0" | "::" | "127.0.0.1" | "::1");
    let h = if local { "localhost".to_string() } else { c.host.clone() };
    format!("http://{}:{}/?key={}", h, c.port, c.key)
}

// ---------------------------------------------------------------- HTTP

struct Req {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
    fn q(&self, k: &str) -> Option<&str> {
        self.query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}

// Percent-decoding; `plus` turns '+' into a space (query strings only, not paths).
fn pct_decode(s: &str, plus: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if plus && b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_req(s: &mut TcpStream) -> Option<Req> {
    let mut r = BufReader::new(s.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    let mut size = line.len();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        size += h.len();
        if size > MAX_HEADER {
            return None;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
    let query = qs.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (pct_decode(k, true), pct_decode(v, true))
    }).collect();
    let mut req = Req { method, path: pct_decode(path, false), query, headers, body: vec![] };
    let len: usize = req.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_SIDECAR {
        return Some(Req { method: "TOO_BIG".into(), ..req });
    }
    if len > 0 {
        let mut body = vec![0; len];
        r.read_exact(&mut body).ok()?;
        req.body = body;
    }
    Some(req)
}

fn send(s: &mut TcpStream, status: &str, ctype: &str, extra: &[(&str, String)], body: &[u8]) {
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
         Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\n",
        body.len()
    );
    for (k, v) in extra {
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    let _ = s.write_all(h.as_bytes());
    let _ = s.write_all(body);
}
fn text(s: &mut TcpStream, status: &str, msg: &str) {
    send(s, status, "text/plain; charset=utf-8", &[], msg.as_bytes());
}

fn ctype(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn eq_ct(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn cookie(req: &Req, name: &str) -> Option<String> {
    req.header("cookie")?.split(';').find_map(|c| {
        let (k, v) = c.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

// A path inside `root` from a client-supplied relative path, or None. Refuses "..", absolute
// paths, and anything whose real location (after following links) is outside `root`.
fn inside(root: &Path, rel: &str, must_exist: bool) -> Option<PathBuf> {
    let rel = Path::new(rel.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let p = root.join(rel);
    if must_exist {
        let c = p.canonicalize().ok()?;
        return c.starts_with(root).then_some(c);
    }
    let parent = p.parent()?.canonicalize().ok()?;
    if !parent.starts_with(root) {
        return None;
    }
    Some(parent.join(p.file_name()?))
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

fn mtime_ms(m: &fs::Metadata) -> u128 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

// ---------------------------------------------------------------- API

fn api_dirs(c: &Config, rel: &str) -> Option<String> {
    let dir = inside(&c.photos, rel, true)?;
    if !dir.is_dir() {
        return None;
    }
    let mut dirs = Vec::new();
    let mut photos = 0u64;
    for e in fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            dirs.push(json_str(&name));
        } else if is_photo(&name) {
            photos += 1;
        }
    }
    dirs.sort();
    let name = if rel.is_empty() { c.photos.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() } else { rel.rsplit('/').next().unwrap_or("").to_string() };
    Some(format!("{{\"path\":{},\"name\":{},\"dirs\":[{}],\"photos\":{}}}", json_str(&rel_of(&c.photos, &dir)), json_str(&name), dirs.join(","), photos))
}

fn is_photo(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    name.contains('.') && PHOTO_EXT.contains(&ext.as_str())
}

fn api_photos(c: &Config, rel: &str) -> Option<String> {
    let root = inside(&c.photos, rel, true)?;
    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            // Follow links only if they stay inside the photos folder.
            let Ok(real) = p.canonicalize() else { continue };
            if !real.starts_with(&c.photos) {
                continue;
            }
            let Ok(md) = fs::metadata(&real) else { continue };
            if md.is_dir() {
                if depth < 16 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            let sidecar = name.to_ascii_lowercase().ends_with(".xmp");
            if !sidecar && !is_photo(&name) {
                continue;
            }
            out.push(format!(
                "{{\"rel\":{},\"name\":{},\"size\":{},\"modified\":{},\"sidecar\":{}}}",
                json_str(&rel_of(&root, &p)), json_str(&name), md.len(), mtime_ms(&md), sidecar
            ));
            if out.len() >= 200_000 {
                break;
            }
        }
    }
    Some(format!("[{}]", out.join(",")))
}

fn handle(mut s: TcpStream, c: &Config) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    let Some(req) = read_req(&mut s) else { return };
    if req.method == "TOO_BIG" {
        return text(&mut s, "413 Payload Too Large", "Too large");
    }

    // Access key: ?key=… once (then a cookie), or the cookie.
    if let Some(k) = req.q("key") {
        if eq_ct(k, &c.key) {
            let cookie = format!("rembrandt_key={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000", c.key);
            return send(&mut s, "303 See Other", "text/plain", &[("Location", req.path.clone()), ("Set-Cookie", cookie)], b"");
        }
    }
    let authed = cookie(&req, "rembrandt_key").map(|v| eq_ct(&v, &c.key)).unwrap_or(false);
    if !authed {
        let page = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Rembrandt</title>\
            <body style='font:15px/1.5 system-ui;display:grid;place-items:center;min-height:90vh;background:#111;color:#eee'>\
            <div style='max-width:26em;text-align:center'><h1 style='font-size:20px'>Rembrandt</h1>\
            <p>Open the link that <code>rembrandt-server</code> printed (it includes an access key).</p>\
            <p style='color:#999'>Lost it? Run <code>rembrandt-server --print-url</code> on the computer with your photos.</p></div>";
        return send(&mut s, "401 Unauthorized", "text/html; charset=utf-8", &[], page.as_bytes());
    }

    let path = req.path.as_str();
    match (req.method.as_str(), path) {
        ("GET", "/api/dirs") => match api_dirs(c, req.q("path").unwrap_or("")) {
            Some(j) => send(&mut s, "200 OK", "application/json", &[("Cache-Control", "no-store".into())], j.as_bytes()),
            None => text(&mut s, "404 Not Found", "Folder not found"),
        },
        ("GET", "/api/photos") => match api_photos(c, req.q("path").unwrap_or("")) {
            Some(j) => send(&mut s, "200 OK", "application/json", &[("Cache-Control", "no-store".into())], j.as_bytes()),
            None => text(&mut s, "404 Not Found", "Folder not found"),
        },
        ("GET", "/api/file") => {
            let Some(p) = req.q("path").and_then(|r| inside(&c.photos, r, true)).filter(|p| p.is_file()) else {
                return text(&mut s, "404 Not Found", "Not found");
            };
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !(is_photo(&name) || name.to_ascii_lowercase().ends_with(".xmp")) {
                return text(&mut s, "403 Forbidden", "Only photos and sidecars");
            }
            match fs::read(&p) {
                Ok(b) => send(&mut s, "200 OK", ctype(&p), &[("Cache-Control", "no-store".into())], &b),
                Err(_) => text(&mut s, "404 Not Found", "Not found"),
            }
        }
        ("PUT", "/api/sidecar") => {
            let rel = req.q("path").unwrap_or("");
            if !rel.to_ascii_lowercase().ends_with(".xmp") {
                return text(&mut s, "403 Forbidden", "Only .xmp sidecars can be written");
            }
            // Same-origin requests only (the cookie is SameSite=Strict too).
            if let Some(o) = req.header("origin") {
                let host = req.header("host").unwrap_or("");
                if !(o.ends_with(&format!("//{host}"))) {
                    return text(&mut s, "403 Forbidden", "Cross-site request");
                }
            }
            let Some(p) = inside(&c.photos, rel, false) else { return text(&mut s, "403 Forbidden", "Outside the photos folder") };
            if fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                return text(&mut s, "403 Forbidden", "Won't write through a link");
            }
            match fs::write(&p, &req.body) {
                Ok(_) => text(&mut s, "204 No Content", ""),
                Err(e) => text(&mut s, "500 Internal Server Error", &e.to_string()),
            }
        }
        ("GET", _) => serve_static(&mut s, c, path),
        _ => text(&mut s, "405 Method Not Allowed", "Method not allowed"),
    }
}

fn serve_static(s: &mut TcpStream, c: &Config, path: &str) {
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    let Some(p) = inside(&c.web, rel, true).filter(|p| p.is_file()) else { return text(s, "404 Not Found", "Not found") };
    let Ok(mut body) = fs::read(&p) else { return text(s, "404 Not Found", "Not found") };
    if p.file_name().map(|n| n == "index.html").unwrap_or(false) {
        // The app's settings: served by this server, plus the optional service keys from server.conf.
        let cfg = format!("<script>window.LUMEN_CONFIG=Object.assign({{serverUrl:''}},{{{}}});</script>\n  <script type=\"module\"", c.client);
        let html = String::from_utf8_lossy(&body).replacen("<script type=\"module\"", &cfg, 1);
        body = html.into_bytes();
    }
    let cache = if rel.ends_with(".wasm") || rel.ends_with(".tflite") || rel.contains("/fonts/") || rel.starts_with("models/") { "public, max-age=604800" } else { "no-cache" };
    send(s, "200 OK", ctype(&p), &[("Cache-Control", cache.into())], &body);
}

fn main() {
    let c = Arc::new(parse_args());
    let addr = format!("{}:{}", c.host, c.port);
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => { eprintln!("Can't listen on {addr}: {e}"); std::process::exit(1) }
    };
    println!("Rembrandt is serving {}", c.photos.display());
    println!("Open: {}", link(&c));
    if c.host != "127.0.0.1" && c.host != "localhost" && c.host != "::1" {
        println!("Listening on your network. The connection is not encrypted: use it on a network you trust, or put it behind HTTPS (for example Caddy or Tailscale).");
    }
    for s in listener.incoming().flatten() {
        let c = Arc::clone(&c);
        std::thread::spawn(move || handle(s, &c));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("rembrandt-test-{}", random_key()));
        let root = base.join("photos");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(base.join("secret")).unwrap();
        fs::write(root.join("a/b/x.jpg"), b"jpg").unwrap();
        fs::write(base.join("secret/s.jpg"), b"secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret"), root.join("out")).unwrap();
            std::os::unix::fs::symlink(base.join("secret/s.jpg"), root.join("a/link.jpg")).unwrap();
        }
        (base, root.canonicalize().unwrap())
    }

    #[test]
    fn paths_stay_inside_the_photos_folder() {
        let (base, root) = tree();
        assert!(inside(&root, "a/b/x.jpg", true).is_some());
        assert!(inside(&root, "/a/b/x.jpg", true).is_some());
        for bad in ["../secret/s.jpg", "a/../../secret/s.jpg", "/../secret/s.jpg", "a/b/missing.jpg"] {
            assert!(inside(&root, bad, true).is_none(), "{bad}");
        }
        #[cfg(unix)]
        {
            assert!(inside(&root, "out/s.jpg", true).is_none(), "link to a folder outside");
            assert!(inside(&root, "a/link.jpg", true).is_none(), "link to a file outside");
            assert!(inside(&root, "out/new.xmp", false).is_none(), "writing through a linked folder");
        }
        assert!(inside(&root, "a/b/new.xmp", false).is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn decoding_and_keys() {
        assert_eq!(pct_decode("a%2Fb+c", true), "a/b c");
        assert_eq!(pct_decode("a+b%2", false), "a+b%2");
        assert!(eq_ct("abc", "abc") && !eq_ct("abc", "abd") && !eq_ct("abc", "abcd"));
        let (k1, k2) = (random_key(), random_key());
        assert_eq!(k1.len(), 64);
        assert_ne!(k1, k2);
        assert_eq!(json_str("a\"<\n"), "\"a\\\"\\u003c\\u000a\"");
    }

    #[test]
    fn photo_names() {
        assert!(is_photo("IMG.CR3") && is_photo("x.jpeg") && !is_photo("notes.txt") && !is_photo("jpg"));
    }
}
