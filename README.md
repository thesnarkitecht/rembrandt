<p align="center"><img src="brand/r-mark.svg" width="80" alt="Rembrandt"></p>
<h1 align="center">Rembrandt</h1>
<p align="center"><b>A free photo editor. No account, no subscription, no tracking.</b><br>
RAW and JPEG · masks · on-device AI · a real library · your photos stay on your computer.</p>

## Download

| Platform | |
|---|---|
| macOS · Apple silicon | [Rembrandt-macos-arm64.dmg](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-macos-arm64.dmg) |
| macOS · Intel | [Rembrandt-macos-x64.dmg](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-macos-x64.dmg) |
| Windows · x64 | [Rembrandt-windows-x64-setup.exe](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-windows-x64-setup.exe) |
| Windows · ARM | [Rembrandt-windows-arm64-setup.exe](https://github.com/thesnarkitecht/rembrandt/releases/latest/download/Rembrandt-windows-arm64-setup.exe) |
| Linux · x86_64 / arm64 | `curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh \| bash` |

All files and checksums: [Releases](https://github.com/thesnarkitecht/rembrandt/releases).
Builds aren't code-signed yet: on macOS use System Settings → Privacy & Security → **Open Anyway**;
on Windows **More info → Run anyway**.

## Self-host it

Serve Rembrandt from the computer that holds your photos and edit them in any browser:

```sh
curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh | bash -s -- --server
```

It asks which photo folder to use, starts at login, and prints a private link. Edits are saved next
to each photo as XMP; the photos themselves are never changed. Add `--lan` to reach it from other
devices on your network. Linux and macOS; one small dependency-free binary (`server/`).

## Features

- **RAW** from 1,000+ cameras, developed on the GPU: tone, colour, curves, grading, dehaze, detail.
- **Masks**: brush, gradients, colour and tone ranges, AI subject, background, object and depth.
- **On-device AI**: Refocus, Lens Blur, background replacement. Nothing is uploaded.
- **Library**: albums, ratings, flags, search, sorting, keyboard shortcuts, one-click delete with Undo.
- **Batch**: copy and paste edits to hundreds of photos, presets, batch export.
- **Bring your photos**: folders, Lightroom Classic and Lightroom, Google Photos, Google Drive,
  Dropbox, OneDrive ([setup](docs/cloud-services.md)). Export back to them too.
- **Open formats**: edits are standard XMP, readable by Lightroom and others.

## Support

Rembrandt is free. Star the repo, tell a photographer, [report a bug](https://github.com/thesnarkitecht/rembrandt/issues),
or [sponsor it](https://github.com/sponsors/thesnarkitecht).

## Build

```sh
npm ci && npx http-server -c-1 .   # web app
npm run tauri dev                  # desktop app (Rust + Tauri prerequisites)
```

Details in [docs/building.md](docs/building.md). Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Source-available under the [PolyForm Shield License 1.0.0](LICENSE): use it for anything, including
paid work, and change it, but **don't sell it or a modified version**. The name and logo are
trademarks ([TRADEMARKS.md](TRADEMARKS.md)). Third-party parts: [NOTICE.md](NOTICE.md).
