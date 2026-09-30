<p align="center"><img src="brand/r-mark.svg" width="80" alt="Rembrandt"></p>
<h1 align="center">Rembrandt</h1>
<p align="center"><b>Stop paying for Adobe. Flush the incrapification.</b></p>
<p align="center">A free photo editor for macOS, Windows and Linux.<br>
No account, no subscription, no “we’ve updated our terms” emails.</p>
<p align="center">
  <a href="#download"><b>Download</b></a> ·
  <a href="#self-host-it">Self-host</a> ·
  <a href="#features">Features</a> ·
  <a href="#build">Build</a>
</p>

<p align="center"><img src="docs/screenshots/editor.jpg" alt="Editing a photo in Rembrandt" width="900"></p>

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/library.jpg" alt="The library"></td>
    <td width="33%"><img src="docs/screenshots/masks.jpg" alt="Masks, including AI subject, background, object and depth"></td>
    <td width="33%"><img src="docs/screenshots/compare.jpg" alt="Before and after, split view"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Library</b>: albums, search, sorting, one-click delete</sub></td>
    <td align="center"><sub><b>Masks</b>: brush, gradients, AI subject and depth</sub></td>
    <td align="center"><sub><b>Before / after</b>: split or side by side</sub></td>
  </tr>
</table>

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
To update, press **Update** in the browser (Settings › About); it installs the latest release,
checks it against the published SHA-256 sums, and restarts the server.

## Features

- **RAW** from 1,000+ cameras, developed on the GPU: tone, colour, curves, grading, dehaze, detail.
- **Masks**: brush, gradients, colour and tone ranges, AI subject, background, object and depth.
- **Remove**: heal and clone spots and strokes; Rembrandt picks a matching source for you.
- **Lens corrections**: the camera's built-in profile from Fujifilm and Sony RAWs (distortion,
  vignetting, chromatic aberration), plus manual distortion and vignetting for any photo.
- **On-device AI**: Refocus, Lens Blur, background replacement. Nothing is uploaded.
- **Library**: albums, ratings, flags, search, sorting, keyboard shortcuts, one-click delete with Undo.
- **Batch**: copy and paste edits to hundreds of photos, presets, batch export.
- **Bring your photos**: folders, Lightroom Classic and Lightroom, Google Photos, Google Drive,
  Dropbox, OneDrive ([setup](docs/cloud-services.md)). Export back to them too.
- **Open formats**: edits are standard XMP, readable by Lightroom and others.

## Help out

Rembrandt is free and stays free. Star the repo, tell a photographer,
[report a bug](https://github.com/thesnarkitecht/rembrandt/issues) or send a fix.

## Build

```sh
npm ci && npx http-server -c-1 .   # web app
npm run tauri dev                  # desktop app (Rust + Tauri prerequisites)
```

Details in [docs/building.md](docs/building.md). Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Free software under the [GNU General Public License v3.0 or later](LICENSE), the same licence as
darktable. Use it, study it, change it and share it; if you distribute a modified version, share its
source under the same terms. Third-party parts: [NOTICE.md](NOTICE.md).

<sub>Screenshot photos from the scikit-image sample data: espresso by Rachel Michetti and cat by
Stefan van der Walt (CC0), rocket launch by SpaceX and Hubble eXtreme Deep Field by NASA (public
domain).</sub>
