#!/bin/sh
# Install the snapgrep extension for the current platform.
#
#   curl -fsSL https://raw.githubusercontent.com/Owen718/snapgrep/main/install.sh | sh
#
# Downloads only the addon this machine can run (~1.2 MB rather than 6 MB),
# and installs into Pi's global extension directory. Override the target with
# PI_EXTENSIONS_DIR=/some/path.

set -eu

REPO="Owen718/snapgrep"
VERSION="${SNAPGREP_VERSION:-v0.1.0}"
DEST="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"

fail() {
  printf 'snapgrep: %s\n' "$1" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin)
    case "$arch" in
      arm64) target="darwin-arm64" ;;
      x86_64) target="darwin-x64" ;;
      *) fail "unsupported macOS architecture: $arch" ;;
    esac
    ;;
  Linux)
    # The published Linux addons link against glibc. musl (Alpine) needs a
    # build that does not exist yet, so say so rather than install something
    # that cannot load.
    if [ -f /etc/alpine-release ] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
      fail "musl/Alpine is not supported yet; build from source (see the README)"
    fi
    case "$arch" in
      x86_64) target="linux-x64-gnu" ;;
      aarch64 | arm64) target="linux-arm64-gnu" ;;
      *) fail "unsupported Linux architecture: $arch" ;;
    esac
    ;;
  MINGW* | MSYS* | CYGWIN*)
    target="win32-x64-msvc"
    ;;
  *)
    fail "unsupported platform: $os $arch"
    ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

url="https://github.com/$REPO/releases/download/$VERSION/snapgrep-extension-$target.tar.gz"

printf 'snapgrep: %s %s -> %s\n' "$os" "$arch" "$target"
printf 'snapgrep: downloading %s\n' "$VERSION"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL "$url" -o "$tmp/extension.tar.gz" \
  || fail "download failed: $url"
tar xzf "$tmp/extension.tar.gz" -C "$tmp" \
  || fail "the downloaded archive could not be extracted"
[ -d "$tmp/pi-fast-grep/native" ] \
  || fail "the archive is missing its native directory"

mkdir -p "$DEST"
# Replace any previous install rather than merging into it, so a stale addon
# from an older release cannot be picked up.
rm -rf "$DEST/pi-fast-grep"
mv "$tmp/pi-fast-grep" "$DEST/pi-fast-grep"

printf 'snapgrep: installed to %s\n' "$DEST/pi-fast-grep"
printf 'snapgrep: start pi -- its built-in grep is replaced automatically.\n'
printf 'snapgrep: to confirm, search for a string you know exists and look for actualBackend: kernel\n'
