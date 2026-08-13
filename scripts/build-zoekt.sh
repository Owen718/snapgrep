#!/usr/bin/env bash

set -euo pipefail

readonly FAST_GREP_ZOEKT_SHA="3c8b39b1ef4f8194cb912d7e6581cff9db224aa7"
readonly FAST_GREP_ZOEKT_URL="https://github.com/sourcegraph/zoekt.git"
readonly FAST_GREP_MIN_GO="1.25.9"

FAST_GREP_SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly FAST_GREP_SCRIPT_DIR
FAST_GREP_PROJECT_ROOT="$(CDPATH= cd -- "$FAST_GREP_SCRIPT_DIR/.." && pwd)"
readonly FAST_GREP_PROJECT_ROOT
readonly FAST_GREP_ZOEKT_DIR="${PI_FAST_GREP_ZOEKT_SOURCE:-$FAST_GREP_PROJECT_ROOT/.deps/zoekt}"
readonly FAST_GREP_TOOLS_DIR="${PI_FAST_GREP_TOOLS_DIR:-$FAST_GREP_PROJECT_ROOT/.tools}"

fail() {
  printf 'build-zoekt: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

version_at_least() {
  node - "$1" "$2" <<'NODE'
const actual = process.argv[2].replace(/^go/, "").split(/[.-]/u).map(Number);
const minimum = process.argv[3].replace(/^go/, "").split(/[.-]/u).map(Number);
for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
  const left = actual[index] ?? 0;
  const right = minimum[index] ?? 0;
  if (!Number.isFinite(left) || !Number.isFinite(right)) process.exit(2);
  if (left > right) process.exit(0);
  if (left < right) process.exit(1);
}
NODE
}

need_command git
need_command go
need_command node

FAST_GREP_GO_VERSION="$(go env GOVERSION)"
readonly FAST_GREP_GO_VERSION
version_at_least "$FAST_GREP_GO_VERSION" "$FAST_GREP_MIN_GO" || \
  fail "Go $FAST_GREP_MIN_GO or newer is required (found $FAST_GREP_GO_VERSION)"

mkdir -p "$(dirname -- "$FAST_GREP_ZOEKT_DIR")" "$FAST_GREP_TOOLS_DIR"

if [ ! -e "$FAST_GREP_ZOEKT_DIR" ]; then
  printf 'Cloning Zoekt at pinned commit %s...\n' "$FAST_GREP_ZOEKT_SHA"
  git clone --filter=blob:none "$FAST_GREP_ZOEKT_URL" "$FAST_GREP_ZOEKT_DIR"
fi

git -C "$FAST_GREP_ZOEKT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "$FAST_GREP_ZOEKT_DIR exists but is not a Git worktree"

if [ -n "$(git -C "$FAST_GREP_ZOEKT_DIR" status --porcelain --untracked-files=no)" ]; then
  fail "tracked changes exist in $FAST_GREP_ZOEKT_DIR; refusing to build a non-reproducible checkout"
fi

if ! git -C "$FAST_GREP_ZOEKT_DIR" cat-file -e "$FAST_GREP_ZOEKT_SHA^{commit}" 2>/dev/null; then
  printf 'Fetching pinned Zoekt commit...\n'
  git -C "$FAST_GREP_ZOEKT_DIR" fetch --depth=1 origin "$FAST_GREP_ZOEKT_SHA"
fi

if [ "$(git -C "$FAST_GREP_ZOEKT_DIR" rev-parse HEAD)" != "$FAST_GREP_ZOEKT_SHA" ]; then
  git -C "$FAST_GREP_ZOEKT_DIR" checkout --detach "$FAST_GREP_ZOEKT_SHA"
fi

[ "$(git -C "$FAST_GREP_ZOEKT_DIR" rev-parse HEAD)" = "$FAST_GREP_ZOEKT_SHA" ] || \
  fail "Zoekt checkout verification failed"

FAST_GREP_BUILD_DIR="$(mktemp -d "$FAST_GREP_TOOLS_DIR/.zoekt-build.XXXXXX")"
readonly FAST_GREP_BUILD_DIR
cleanup_build_dir() {
  rm -rf -- "$FAST_GREP_BUILD_DIR"
}
trap cleanup_build_dir EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

readonly FAST_GREP_LDFLAGS="-s -w -X github.com/sourcegraph/zoekt/index.Version=$FAST_GREP_ZOEKT_SHA"

for FAST_GREP_BINARY in zoekt zoekt-git-index zoekt-index zoekt-webserver; do
  printf 'Building %s...\n' "$FAST_GREP_BINARY"
  (
    cd "$FAST_GREP_ZOEKT_DIR"
    go build -trimpath -ldflags "$FAST_GREP_LDFLAGS" \
      -o "$FAST_GREP_BUILD_DIR/$FAST_GREP_BINARY" "./cmd/$FAST_GREP_BINARY"
  )
done

for FAST_GREP_BINARY in zoekt zoekt-git-index zoekt-index zoekt-webserver; do
  [ -x "$FAST_GREP_BUILD_DIR/$FAST_GREP_BINARY" ] || fail "missing built binary: $FAST_GREP_BINARY"
  mv -f -- "$FAST_GREP_BUILD_DIR/$FAST_GREP_BINARY" "$FAST_GREP_TOOLS_DIR/$FAST_GREP_BINARY"
done

FAST_GREP_REPORTED_VERSION="$($FAST_GREP_TOOLS_DIR/zoekt-webserver -version 2>&1)"
readonly FAST_GREP_REPORTED_VERSION
case "$FAST_GREP_REPORTED_VERSION" in
  *"$FAST_GREP_ZOEKT_SHA"*) ;;
  *) fail "zoekt-webserver does not report the pinned commit: $FAST_GREP_REPORTED_VERSION" ;;
esac

FAST_GREP_GIT_INDEX_VERSION="$($FAST_GREP_TOOLS_DIR/zoekt-git-index -version 2>&1)"
readonly FAST_GREP_GIT_INDEX_VERSION
case "$FAST_GREP_GIT_INDEX_VERSION" in
  *"$FAST_GREP_ZOEKT_SHA"*) ;;
  *) fail "zoekt-git-index does not report the pinned commit: $FAST_GREP_GIT_INDEX_VERSION" ;;
esac

printf 'Zoekt ready: %s\n' "$FAST_GREP_REPORTED_VERSION"
printf 'Binaries: %s\n' "$FAST_GREP_TOOLS_DIR"
