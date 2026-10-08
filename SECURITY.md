# Security

## Reporting a problem

Please report security issues privately through GitHub: **Security › Report a vulnerability** on this
repository. Don't open a public issue for them. You'll get a reply within a few days.

## Checking a download

Every installer is built from this repository's public source by GitHub Actions, never on a personal
computer.

- **Checksums**: each release has a `SHA256SUMS` file. Compare it with `sha256sum <file>`
  (macOS: `shasum -a 256 <file>`; Windows: `Get-FileHash <file>`).
- **Build provenance** (from 0.3.8): each file carries a signed record of the workflow run and commit
  that built it. With the GitHub CLI:

  ```
  gh attestation verify Rembrandt-windows-x64-setup.exe --repo thesnarkitecht/rembrandt
  ```

Downloads from GitHub releases are served from GitHub's shared download servers
(`objects.githubusercontent.com`, `release-assets.githubusercontent.com`). Reputation services sometimes
tag those domains because other people have hosted malware on GitHub; that says nothing about a
particular file. Check the file itself (its SHA-256 on VirusTotal, or the attestation above).

## The in-app updater

It only installs files attached to this repository's own releases, downloads them over HTTPS only,
and refuses any file whose SHA-256 doesn't match the release's `SHA256SUMS`. It never asks for
administrator rights.

## Signing

The installers are not yet code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first
launch. Free signing for open-source projects (SignPath Foundation) is being set up for Windows.
