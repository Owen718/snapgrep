#!/bin/sh
# Install the snapgrep extension for the current platform.
#
#   curl -fsSL .../install.sh | sh              # Pi and oh-my-pi
#   curl -fsSL .../install.sh | sh -s -- --dsh  # DeepSeek Harness
#
# Downloads only the addon this machine can run (~1.2 MB rather than 6 MB).
#
# Pi mode copies the extension into Pi's global extension directory; override
# with PI_EXTENSIONS_DIR. DeepSeek Harness resolves plugins through pnpm and a
# profile bundle list instead, so --dsh keeps the package somewhere stable,
# registers it, and adds it to the profile; override the profile with
# DSH_PROFILE and the install location with SNAPGREP_HOME.

set -eu

REPO="Owen718/snapgrep"
VERSION="${SNAPGREP_VERSION:-v0.1.0}"
DEST="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
DSH_PROFILE="${DSH_PROFILE:-headless}"
SNAPGREP_HOME="${SNAPGREP_HOME:-$HOME/.snapgrep}"
MODE="pi"

for arg in "$@"; do
  case "$arg" in
    --dsh) MODE="dsh" ;;
    --pi) MODE="pi" ;;
    -h | --help)
      printf 'usage: install.sh [--pi | --dsh]\n\n'
      printf '  --pi   install into %s (default)\n' "$DEST"
      printf '  --dsh  register as a DeepSeek Harness plugin\n\n'
      printf 'env: SNAPGREP_VERSION PI_EXTENSIONS_DIR DSH_PROFILE SNAPGREP_HOME\n'
      exit 0
      ;;
    *)
      printf 'snapgrep: unknown option: %s (try --help)\n' "$arg" >&2
      exit 1
      ;;
  esac
done

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

if [ "$MODE" = "pi" ]; then
  mkdir -p "$DEST"
  # Replace any previous install rather than merging into it, so a stale addon
  # from an older release cannot be picked up.
  rm -rf "$DEST/pi-fast-grep"
  mv "$tmp/pi-fast-grep" "$DEST/pi-fast-grep"

  printf 'snapgrep: installed to %s\n' "$DEST/pi-fast-grep"
  printf 'snapgrep: start pi -- its built-in grep is replaced automatically.\n'
  printf 'snapgrep: to confirm, search for a string you know exists and look for actualBackend: kernel\n'
  exit 0
fi

# --- DeepSeek Harness ---------------------------------------------------------

command -v pnpm >/dev/null 2>&1 \
  || fail "pnpm is required by the harness plugin manager: npm i -g pnpm"
command -v node >/dev/null 2>&1 || fail "node is required"

dsh_bin=""
if command -v dsh >/dev/null 2>&1; then
  dsh_bin="dsh"
elif command -v npx >/dev/null 2>&1; then
  dsh_bin="npx --yes @deepseek-ai/dsh"
else
  fail "neither dsh nor npx was found"
fi

profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/$DSH_PROFILE"
[ -d "$profile_dir" ] \
  || fail "profile not found: $profile_dir (run dsh --profile $DSH_PROFILE once to create it, or set DSH_PROFILE)"

# pnpm links a file: dependency by copying, so the package has to live outside
# the temp directory this script cleans up on exit.
mkdir -p "$SNAPGREP_HOME"
rm -rf "$SNAPGREP_HOME/pi-fast-grep"
mv "$tmp/pi-fast-grep" "$SNAPGREP_HOME/pi-fast-grep"
printf 'snapgrep: package at %s\n' "$SNAPGREP_HOME/pi-fast-grep"

# shellcheck disable=SC2086
$dsh_bin plugin --profile "$DSH_PROFILE" add "file:$SNAPGREP_HOME/pi-fast-grep" \
  || fail "dsh plugin add failed"

# Installing the package is not enough: a bundle only loads once it is listed
# in the profile's bundles array. Without this the harness reports it as a
# plain dependency and the plugin never runs.
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  const bundles = pkg.dsh.profile.bundles ?? [];
  if (bundles.includes("pi-fast-grep-extension")) {
    console.log("snapgrep: already in the bundle list");
  } else {
    bundles.push("pi-fast-grep-extension");
    pkg.dsh.profile.bundles = bundles;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    console.log("snapgrep: added to the bundle list");
  }
' "$profile_dir/package.json" || fail "could not update $profile_dir/package.json"

printf 'snapgrep: installed into the %s profile\n' "$DSH_PROFILE"
printf 'snapgrep: verify with: dsh --profile %s --dump-config | grep snapgrep\n' "$DSH_PROFILE"
printf 'snapgrep: it replaces the built-in grep and glob tools with indexed ones.\n'
