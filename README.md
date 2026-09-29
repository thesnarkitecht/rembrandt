<p align="center"><img src="brand/r-mark.svg" width="88" alt=""></p>
<h1 align="center">Rembrandt</h1>
<p align="center"><b>A free photo editor that stays out of your way.</b><br>RAW and JPEG, masks, presets, a real library, and AI that runs on your own computer.<br>No accounts. No subscription. No ads. No tracking.</p>

---

## Download

| | |
|---|---|
| **macOS** 12+ · Apple silicon | [Rembrandt-macos-arm64.dmg](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-macos-arm64.dmg) |
| **macOS** 12+ · Intel | [Rembrandt-macos-x64.dmg](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-macos-x64.dmg) |
| **Windows** 10/11 · x64 | [Rembrandt-windows-x64-setup.exe](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-windows-x64-setup.exe) · [.msi](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-windows-x64.msi) |
| **Windows** 11 · ARM | [Rembrandt-windows-arm64-setup.exe](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-windows-arm64-setup.exe) |
| **Linux** · x86_64 and arm64 (Omarchy, Arch, Ubuntu, Debian, Fedora, …) | `curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh \| bash` |

Every file, including the `.AppImage`, `.deb` and `.rpm` packages and their SHA-256 sums, is on the
[releases page](https://github.com/thesnarkitecht/rembrandt/releases).

> The first builds aren't code-signed yet. **macOS:** open the app, then System Settings → Privacy &
> Security → *Open Anyway*. **Windows:** *More info* → *Run anyway*.

## Rembrandt in your browser, on your own server

Run Rembrandt on the computer that holds your photos and edit them from any browser: your laptop,
or your home server from anywhere on your network.

```sh
curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh | bash -s -- --server
```

It asks which folder of photos to use, starts at login (systemd on Linux, launchd on macOS), and
prints a private link to open. Edits are saved next to each photo as an XMP sidecar, so they work in
other editors too; your photos are never changed.

- `--photos ~/Pictures` picks the folder without asking; `--port 8420` changes the port.
- `--lan` lets other devices on your network connect. The link carries an access key, and nothing is
  served without it. For anything beyond a trusted network, put it behind HTTPS (Caddy, Tailscale).
- `rembrandt-server --print-url` shows the link again; `--new-key` makes old links stop working.
- Remove it with `… | bash -s -- --uninstall` (your photos and edits stay).

The server is one small program with no dependencies (`server/`). Windows builds are on the
releases page too.

## What it does

- **Develop RAW** from 1,000+ cameras (LibRaw) through a scene-referred GPU pipeline: exposure, tone,
  colour mixer, colour grading, curves, dehaze, sharpening and noise reduction.
- **Masks**: brush, linear and radial gradients, colour and tone ranges, and AI subject, background,
  object and depth masks.
- **On-device AI**: Refocus, Lens Blur with depth, and background replacement. Your photos never
  leave your computer.
- **A library that behaves**: albums, ratings, flags, search, sorting, keyboard everything, and
  one-click delete with Undo. Sync a folder and your photos stay where they are.
- **Batch editing**: copy and paste edits across hundreds of photos, presets, and batch export.
- **Bring your photos**: from folders, Adobe Lightroom Classic catalogs, Lightroom (cloud), and
  Google Photos, Google Drive, Dropbox and OneDrive. Export back to them too.
- **Your edits are yours**: saved as standard XMP, readable by Lightroom and others.

Cloud import and export need your own free developer keys for each service; see
[docs/cloud-services.md](docs/cloud-services.md).

## Support Rembrandt

Rembrandt is free and stays free. If it's useful to you:

- ⭐ star this repository and tell a photographer friend;
- report bugs and send camera samples that don't open;
- help with code, translations or docs (see [CONTRIBUTING.md](CONTRIBUTING.md));
- or chip in with the **Support** button in the app.

## Build it yourself

```sh
npm ci
npx http-server -c-1 .          # the web app, at http://localhost:8080
npm run tauri dev               # the desktop app (needs Rust and the Tauri prerequisites)
cargo run --manifest-path server/Cargo.toml -- --photos ~/Pictures --web .   # the server
```

More in [docs/building.md](docs/building.md).

## Licence

Rembrandt is **source-available** under the [PolyForm Shield License 1.0.0](LICENSE). You can use
it for anything, including paid photography work, read the code, change it and share your changes.
You **can't sell it**, or sell a modified version, or offer it as a competing product or service.
The name and logo are trademarks of light.work ([TRADEMARKS.md](TRADEMARKS.md)): forks need a
different name. Third-party parts keep their own licences ([NOTICE.md](NOTICE.md)).
