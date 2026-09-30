#!/usr/bin/env bash
# Rembrandt installer.
#
#   curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh | bash
#       The desktop app on Linux (x86_64 or arm64): Omarchy / Arch get a pacman package,
#       Debian / Ubuntu the .deb, Fedora / openSUSE the .rpm, anything else the AppImage in your
#       home folder (no root needed).
#
#   curl -fsSL https://raw.githubusercontent.com/thesnarkitecht/rembrandt/main/install.sh | bash -s -- --server
#       rembrandt-server on Linux or macOS: Rembrandt in your browser, editing a folder of photos on
#       this computer. Asks which folder (or pass --photos <folder>), starts at login, and prints the
#       link to open. Add --lan to reach it from other devices on your network.
#
#   ... | bash -s -- --server --update
#       Updates an installed rembrandt-server to the latest release and restarts it, keeping its
#       settings. (The Update button in Rembrandt's Settings runs this for you.)
#
# Options: --server, --update, --photos <folder>, --port <n>, --lan, --appimage, --uninstall, --version vX.Y.Z
# Every download is checked against the release's SHA-256 sums.
set -euo pipefail

REPO="${REMBRANDT_REPO:-thesnarkitecht/rembrandt}"
APP="Rembrandt"
PKG="rembrandt"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
HOME_DIR="$DATA/$PKG"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$DATA/applications"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rembrandt"

bold=$'\e[1m'; dim=$'\e[2m'; gold=$'\e[38;5;179m'; red=$'\e[31m'; off=$'\e[0m'
[ -t 1 ] || { bold=; dim=; gold=; red=; off=; }
say() { printf '%s\n' "$*"; }
step() { printf '%s•%s %s\n' "$gold" "$off" "$*"; }
die() { printf '%serror:%s %s\n' "$red" "$off" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

mode=desktop; photos=""; port=8420; lan=0; appimage=0; uninstall=0; update=0; version="latest"
while [ $# -gt 0 ]; do
  case "$1" in
    --server) mode=server ;;
    --update) mode=server; update=1 ;;
    --photos) photos="${2:-}"; shift ;;
    --port) port="${2:-}"; shift ;;
    --lan) lan=1 ;;
    --appimage) appimage=1 ;;
    --uninstall) uninstall=1 ;;
    --version) version="${2:-}"; shift ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

OS="$(uname -s)"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64; DEBARCH=amd64 ;;
  aarch64|arm64) ARCH=aarch64; DEBARCH=arm64 ;;
  *) die "$(uname -m) isn't supported. Rembrandt runs on x86_64 and arm64." ;;
esac

if [ "$version" = latest ]; then BASE="https://github.com/$REPO/releases/latest/download"; else BASE="https://github.com/$REPO/releases/download/$version"; fi
BASE="${REMBRANDT_DOWNLOADS:-$BASE}"
sudo_cmd() { if [ "$(id -u)" -eq 0 ]; then "$@"; else need sudo || die "sudo is needed for this step"; sudo "$@"; fi; }

# ---------------------------------------------------------------- uninstall
if [ "$uninstall" = 1 ]; then
  if [ "$OS" = Darwin ]; then
    launchctl unload "$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist"
  elif need systemctl; then
    systemctl --user disable --now rembrandt-server 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/rembrandt-server.service"
  fi
  rm -rf "$HOME_DIR" "${BIN_DIR:?}/$PKG" "${BIN_DIR:?}/rembrandt-server" "$DESKTOP_DIR/$PKG.desktop"
  rm -f "$DATA/icons/hicolor/512x512/apps/$PKG.png"
  if [ "$OS" = Linux ]; then
    if need pacman && pacman -Q "$PKG" >/dev/null 2>&1; then sudo_cmd pacman -R --noconfirm "$PKG"; fi
    if need dpkg && dpkg -s "$PKG" >/dev/null 2>&1; then sudo_cmd apt-get remove -y "$PKG"; fi
    if need rpm && rpm -q "$PKG" >/dev/null 2>&1; then if need dnf; then sudo_cmd dnf remove -y "$PKG"; else sudo_cmd rpm -e "$PKG"; fi; fi
  fi
  say "Removed $APP. Your photos, edits (XMP sidecars) and settings in $CONF_DIR were not touched."
  exit 0
fi

need curl || die "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
PROTO=(--proto '=https' --tlsv1.2)
case "$BASE" in http://*) PROTO=() ;; esac   # plain http only for a local test mirror
fetch() { curl -fL "${PROTO[@]}" --retry 3 --progress-bar -o "$tmp/$1" "$BASE/$1" || die "couldn't download $1"; }
sha() { if need sha256sum; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
verify() {
  local want
  want="$(grep " \*\?$1\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 | head -n1)"
  [ -n "$want" ] || die "no checksum published for $1"
  [ "$(sha "$tmp/$1")" = "$want" ] || die "checksum mismatch for $1: the download is damaged or has been tampered with"
}
curl -fsSL "${PROTO[@]}" -o "$tmp/SHA256SUMS" "$BASE/SHA256SUMS" || die "couldn't reach GitHub (https://github.com/$REPO/releases)"

printf '\n  %s%s%s  %sfree photo editing, on your own computer%s\n\n' "$bold" "$APP" "$off" "$dim" "$off"

# ---------------------------------------------------------------- server
install_server() {
  local os
  case "$OS" in Linux) os=linux ;; Darwin) os=macos ;; *) die "rembrandt-server installs on Linux and macOS. On Windows, download it from https://github.com/$REPO/releases" ;; esac
  local f="rembrandt-server-$os-$ARCH.tar.gz"
  step "Downloading $f"
  fetch "$f"; verify "$f"
  # Unpack next to the old copy and swap, so a failed download or unpack leaves it working.
  rm -rf "$HOME_DIR/server.new"; mkdir -p "$HOME_DIR/server.new" "$BIN_DIR" "$CONF_DIR"
  tar -xzf "$tmp/$f" -C "$HOME_DIR/server.new"
  [ -x "$HOME_DIR/server.new/rembrandt-server" ] || die "the download didn't contain rembrandt-server"
  [ -f "$HOME_DIR/server/server.log" ] && mv "$HOME_DIR/server/server.log" "$HOME_DIR/server.new/" 2>/dev/null
  rm -rf "$HOME_DIR/server"; mv "$HOME_DIR/server.new" "$HOME_DIR/server"
  ln -sf "$HOME_DIR/server/rembrandt-server" "$BIN_DIR/rembrandt-server"

  if [ "$update" = 1 ]; then
    [ -f "$CONF_DIR/server.conf" ] || die "rembrandt-server isn't set up yet; run the installer with --server first"
    step "Installed $("$HOME_DIR/server/rembrandt-server" --version)"
    if [ "$OS" = Darwin ] && [ -f "$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist" ]; then
      launchctl kickstart -k "gui/$(id -u)/work.light.rembrandt-server" 2>/dev/null \
        || { launchctl unload "$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist" 2>/dev/null; launchctl load "$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist"; }
      step "Restarted"
    elif need systemctl && systemctl --user is-enabled rembrandt-server >/dev/null 2>&1; then
      systemctl --user restart rembrandt-server
      step "Restarted"
    else
      say "${dim}Restart rembrandt-server to use the new version.${off}"
    fi
    return 0
  fi

  # Which photos? Remember an earlier choice; otherwise ask (the terminal, even under curl | bash).
  if [ -z "$photos" ] && [ -f "$CONF_DIR/server.conf" ]; then photos="$(sed -n 's/^photos *= *//p' "$CONF_DIR/server.conf" | head -n1)"; fi
  if [ -z "$photos" ]; then
    local def="$HOME/Pictures"
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
      printf 'Which folder of photos should Rembrandt use? [%s] ' "$def" >/dev/tty
      read -r photos </dev/tty || true
    fi
    photos="${photos:-$def}"
  fi
  photos="${photos/#\~/$HOME}"
  [ -d "$photos" ] || die "folder not found: $photos"
  photos="$(cd "$photos" && pwd)"
  local host=127.0.0.1
  if [ "$lan" = 1 ]; then host=0.0.0.0; fi
  if [ -f "$CONF_DIR/server.conf" ]; then
    # Keep other settings (service keys); update these three.
    grep -v -E '^(photos|port|host) *=' "$CONF_DIR/server.conf" > "$tmp/conf" || true
  else
    printf '# rembrandt-server settings. Optional service keys (see docs/cloud-services.md):\n# googleClientId = ...\n# dropboxAppKey = ...\n# supportUrl = ...\n' > "$tmp/conf"
  fi
  printf 'photos = %s\nport = %s\nhost = %s\n' "$photos" "$port" "$host" >> "$tmp/conf"
  mv "$tmp/conf" "$CONF_DIR/server.conf"
  chmod 600 "$CONF_DIR/server.conf"

  local exe="$HOME_DIR/server/rembrandt-server"
  if [ "$OS" = Darwin ]; then
    local plist="$HOME/Library/LaunchAgents/work.light.rembrandt-server.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>work.light.rembrandt-server</string>
  <key>ProgramArguments</key><array><string>$exe</string><string>--config</string><string>$CONF_DIR/server.conf</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME_DIR/server/server.log</string>
</dict></plist>
EOF
    xattr -dr com.apple.quarantine "$HOME_DIR/server" 2>/dev/null || true
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    step "Started; it starts again when you log in"
  elif need systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/rembrandt-server.service"
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" <<EOF
[Unit]
Description=Rembrandt photo editor server
After=network.target

[Service]
ExecStart=$exe --config $CONF_DIR/server.conf
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable rembrandt-server >/dev/null 2>&1
    systemctl --user restart rembrandt-server
    step "Started; it starts again when you log in (systemctl --user status rembrandt-server)"
    say "${dim}To keep it running while you're logged out: loginctl enable-linger $USER${off}"
  else
    say "${dim}No service manager found. Start it with: rembrandt-server --config $CONF_DIR/server.conf${off}"
  fi

  local url
  url="$("$exe" --config "$CONF_DIR/server.conf" --print-url)"
  say ""
  say "${bold}Done.${off} Rembrandt is editing ${bold}$photos${off}"
  say "Open: ${bold}$url${off}"
  say "${dim}Keep this link private: it includes the access key. Show it again with: rembrandt-server --print-url${off}"
  if [ "$lan" = 1 ]; then
    say "${dim}On your network, replace localhost with this computer's name or IP address. The connection isn't encrypted: use it on a network you trust, or put it behind HTTPS (Caddy, Tailscale).${off}"
  fi
}

# ---------------------------------------------------------------- desktop app (Linux)
install_appimage() {
  local f="$APP-linux-$ARCH.AppImage"
  step "Downloading $f"
  fetch "$f"; verify "$f"
  chmod +x "$tmp/$f"
  step "Installing into $HOME_DIR"
  (cd "$tmp" && "./$f" --appimage-extract >/dev/null) || die "couldn't unpack the AppImage"
  rm -rf "$HOME_DIR/app"; mkdir -p "$HOME_DIR" "$BIN_DIR" "$DESKTOP_DIR"
  mv "$tmp/squashfs-root" "$HOME_DIR/app"
  printf '#!/bin/sh\nexec "%s/app/AppRun" "$@"\n' "$HOME_DIR" > "$BIN_DIR/$PKG"
  chmod +x "$BIN_DIR/$PKG"
  local icon_dir="$DATA/icons/hicolor/512x512/apps" icon
  mkdir -p "$icon_dir"
  icon="$(find "$HOME_DIR/app" -maxdepth 1 -name '*.png' | head -n1)"
  if [ -n "$icon" ]; then cp "$icon" "$icon_dir/$PKG.png"; fi
  cat >"$DESKTOP_DIR/$PKG.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP
GenericName=Photo Editor
Comment=Free photo editor with on-device AI
Exec=$BIN_DIR/$PKG %U
Icon=$PKG
Terminal=false
Categories=Graphics;Photography;
MimeType=x-scheme-handler/rembrandt;image/jpeg;image/png;image/tiff;image/webp;image/heic;image/avif;image/x-adobe-dng;image/x-canon-cr2;image/x-canon-cr3;image/x-nikon-nef;image/x-sony-arw;image/x-fuji-raf;image/x-olympus-orf;image/x-panasonic-rw2;
StartupWMClass=$PKG
EOF
  if need update-desktop-database; then update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true; fi
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "${dim}Add $BIN_DIR to your PATH to start it from a terminal.${off}" ;; esac
}
install_pacman() {
  local deb="$APP-linux-amd64.deb"
  step "Downloading $deb"
  fetch "$deb"; verify "$deb"
  fetch PKGBUILD; verify PKGBUILD
  step "Building the pacman package"
  cp "$tmp/$deb" "$tmp/$PKG.deb"
  (cd "$tmp" && makepkg -f --noconfirm >/dev/null) || die "makepkg failed"
  step "Installing (sudo will ask for your password)"
  sudo_cmd pacman -U --noconfirm --needed "$tmp"/$PKG-*.pkg.tar.*
}
install_deb() {
  local f="$APP-linux-$DEBARCH.deb"
  step "Downloading $f"
  fetch "$f"; verify "$f"
  step "Installing (sudo will ask for your password)"
  sudo_cmd apt-get install -y "$tmp/$f"
}
install_rpm() {
  local f="$APP-linux-$ARCH.rpm"
  step "Downloading $f"
  fetch "$f"; verify "$f"
  step "Installing (sudo will ask for your password)"
  if need dnf; then sudo_cmd dnf install -y "$tmp/$f"; elif need zypper; then sudo_cmd zypper --non-interactive install --allow-unsigned-rpm "$tmp/$f"; else sudo_cmd rpm -U "$tmp/$f"; fi
}

if [ "$mode" = server ]; then
  install_server
  exit 0
fi

[ "$OS" = Linux ] || die "the desktop app for $OS is at https://github.com/$REPO/releases/latest (or add --server for Rembrandt in your browser)."
if [ "$appimage" = 1 ]; then install_appimage
elif [ "$ARCH" = x86_64 ] && need pacman && need makepkg && [ "$(id -u)" -ne 0 ]; then install_pacman
elif need apt-get && need dpkg; then install_deb
elif need rpm && { need dnf || need zypper; }; then install_rpm
else install_appimage
fi
say ""
say "${bold}Done.${off} Open ${bold}$APP${off} from your app launcher, or run ${bold}$PKG${off}."
say "${dim}Update by running the same command again. Remove with: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall${off}"
