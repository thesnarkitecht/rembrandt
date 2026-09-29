# Building Rembrandt

Rembrandt is plain ES modules with no build step: `index.html` loads `src/main.js`, which imports
the rest. `engine/` is the GPU processing pipeline (WebGL2), `src/` the application,
`src-tauri/` the desktop shell (Tauri 2, Rust), and `server/` rembrandt-server (Rust, no
dependencies).

## Web app
```sh
npm ci
npm run check                     # syntax and import check of every module
npx http-server -c-1 .            # http://localhost:8080
```

## Desktop app
Install Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/), then:
```sh
npm run tauri dev                 # run it
npx tauri build                   # installers in src-tauri/target/release/bundle
```
Cross-building: `npx tauri build --target aarch64-apple-darwin` (or `x86_64-apple-darwin`,
`aarch64-pc-windows-msvc`, …) after `rustup target add <target>`.

The desktop app can only read and write inside folders you pick in the system folder picker; the
list is kept by the Rust side, not the web view.

## rembrandt-server
```sh
cargo test --manifest-path server/Cargo.toml
cargo build --release --manifest-path server/Cargo.toml
node scripts/build-web.mjs        # the web app into dist/
server/target/release/rembrandt-server --photos ~/Pictures --web dist
```
Settings live in `~/.config/rembrandt/server.conf` (see `docs/cloud-services.md`) and the access key
in `~/.config/rembrandt/access-key`.

## RAW decoding
`src/vendor/libraw/` is LibRaw 0.21.4 compiled to WebAssembly; rebuild it with
`native/build-libraw.sh` (needs Emscripten).

## Releases
Push a tag like `v0.2.0`. `.github/workflows/release.yml` builds the desktop apps for macOS (Apple
silicon and Intel), Windows (x64 and ARM64) and Linux (x86_64 and arm64), rembrandt-server for each,
and publishes them with SHA-256 sums on a GitHub release. The version comes from
`src-tauri/tauri.conf.json` and `package.json`; bump both.
