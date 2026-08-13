#!/usr/bin/env bash

set -euo pipefail

readonly FAST_GREP_PI_SHA="c55ae2faa5d850e0e4650bd573f7f241b10e2e0b"
readonly FAST_GREP_PI_URL="https://github.com/earendil-works/pi.git"
readonly FAST_GREP_MIN_NODE="22.19.0"

FAST_GREP_SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly FAST_GREP_SCRIPT_DIR
FAST_GREP_PROJECT_ROOT="$(CDPATH= cd -- "$FAST_GREP_SCRIPT_DIR/.." && pwd)"
readonly FAST_GREP_PROJECT_ROOT
readonly FAST_GREP_PI_DIR="${PI_FAST_GREP_PI_SOURCE:-$FAST_GREP_PROJECT_ROOT/.deps/pi}"

fail() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

version_at_least() {
  node - "$1" "$2" <<'NODE'
const actual = process.argv[2].replace(/^v/, "").split(/[.-]/u).map(Number);
const minimum = process.argv[3].replace(/^v/, "").split(/[.-]/u).map(Number);
for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
  const left = actual[index] ?? 0;
  const right = minimum[index] ?? 0;
  if (!Number.isFinite(left) || !Number.isFinite(right)) process.exit(2);
  if (left > right) process.exit(0);
  if (left < right) process.exit(1);
}
NODE
}

need_command node
need_command npm
need_command git
need_command go
need_command rg

FAST_GREP_NODE_VERSION="$(node --version)"
readonly FAST_GREP_NODE_VERSION
version_at_least "$FAST_GREP_NODE_VERSION" "$FAST_GREP_MIN_NODE" || \
  fail "Node.js $FAST_GREP_MIN_NODE or newer is required (found $FAST_GREP_NODE_VERSION)"

printf 'Installing pinned project dependencies...\n'
(
  cd "$FAST_GREP_PROJECT_ROOT"
  npm ci --ignore-scripts
)

"$FAST_GREP_SCRIPT_DIR/build-zoekt.sh"

mkdir -p "$(dirname -- "$FAST_GREP_PI_DIR")"
if [ ! -e "$FAST_GREP_PI_DIR" ]; then
  printf 'Cloning Pi at pinned commit %s...\n' "$FAST_GREP_PI_SHA"
  git clone --filter=blob:none "$FAST_GREP_PI_URL" "$FAST_GREP_PI_DIR"
fi

git -C "$FAST_GREP_PI_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "$FAST_GREP_PI_DIR exists but is not a Git worktree"

if [ -n "$(git -C "$FAST_GREP_PI_DIR" status --porcelain --untracked-files=no)" ]; then
  fail "tracked changes exist in $FAST_GREP_PI_DIR; refusing to build a non-reproducible checkout"
fi

if ! git -C "$FAST_GREP_PI_DIR" cat-file -e "$FAST_GREP_PI_SHA^{commit}" 2>/dev/null; then
  printf 'Fetching pinned Pi commit...\n'
  git -C "$FAST_GREP_PI_DIR" fetch --depth=1 origin "$FAST_GREP_PI_SHA"
fi

if [ "$(git -C "$FAST_GREP_PI_DIR" rev-parse HEAD)" != "$FAST_GREP_PI_SHA" ]; then
  git -C "$FAST_GREP_PI_DIR" checkout --detach "$FAST_GREP_PI_SHA"
fi

[ "$(git -C "$FAST_GREP_PI_DIR" rev-parse HEAD)" = "$FAST_GREP_PI_SHA" ] || \
  fail "Pi checkout verification failed"

printf 'Installing and building pinned Pi...\n'
(
  cd "$FAST_GREP_PI_DIR"
  npm ci --ignore-scripts
  if ! npm --prefix packages/ai run check:model-data >/dev/null 2>&1; then
    printf 'Hydrating Pi model data required by the offline build...\n'
    npm run hydrate:model-data
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    fail "Pi model hydration changed tracked files; refusing to build content beyond the pinned commit"
  fi
  npm run build:offline
)

readonly FAST_GREP_PI_CLI="$FAST_GREP_PI_DIR/packages/coding-agent/dist/cli.js"
[ -f "$FAST_GREP_PI_CLI" ] || fail "Pi build did not produce $FAST_GREP_PI_CLI"
FAST_GREP_PI_VERSION="$(node "$FAST_GREP_PI_CLI" --version)"
readonly FAST_GREP_PI_VERSION
[ "$(git -C "$FAST_GREP_PI_DIR" rev-parse HEAD)" = "$FAST_GREP_PI_SHA" ] || \
  fail "Pi HEAD changed during the build"

printf 'Checking, testing, and building pi-fast-grep...\n'
(
  cd "$FAST_GREP_PROJECT_ROOT"
  npm run check
  npm test
  npm run build
)

printf '\nBootstrap complete.\n'
printf '  Pi commit:    %s (CLI version %s)\n' "$FAST_GREP_PI_SHA" "$FAST_GREP_PI_VERSION"
printf '  Pi CLI:       node %s\n' "$FAST_GREP_PI_CLI"
printf '  Zoekt commit: %s\n' "3c8b39b1ef4f8194cb912d7e6581cff9db224aa7"
printf '  Zoekt tools:  %s\n' "$FAST_GREP_PROJECT_ROOT/.tools"
printf '\nNo shell profile, Pi configuration, API key, or global executable was changed.\n'
