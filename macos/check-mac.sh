#!/bin/sh
# `pnpm check:mac`: the Swift tests, the app's build, and the shared packages' builds for iOS, as one turn in the Swift queue.
# It runs nothing if this exact code already passed on this Mac with these tools, unless it's given --force.
# `pnpm check:mac:quick` (--quick) is only the tests, always run, for while you're working. It never counts as a pass. See TESTING.md.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
passes=${CHECK_MAC_PASSES:-$HOME/Library/Caches/patina-check-mac}
quick=
force=
for arg in "$@"; do
  case $arg in
    --quick) quick=1 ;;
    --force) force=1 ;;
    *)
      echo "Usage: check-mac.sh [--quick | --force]" >&2
      exit 64
      ;;
  esac
done

say() { echo "[check:mac] $*" >&2; }

elapsed() { # seconds
  if [ "$1" -ge 60 ]; then echo "$(($1 / 60))m$(($1 % 60))s"; else echo "$1s"; fi
}

# What a pass depends on: what's in macos/ right now, committed or not, and the tools. Nothing outside macos/ goes into these builds, so
# merging main doesn't change it unless main changed macos/. It hashes into a throwaway index and object folder, leaving the real ones
# alone. Settings that change what runs have no fingerprint, so those runs are never skipped or remembered.
fingerprint() {
  [ -z "${ANVIL_RPC_URL:-}${BASE_READ_RPC_URL:-}" ] && [ "${CONFIGURATION:-Release}" = Release ] || return 1
  hashing=$(mktemp -d) || return 1
  mkdir "$hashing/objects"
  tree=$(
    cd "$repo" &&
      export GIT_INDEX_FILE="$hashing/index" GIT_OBJECT_DIRECTORY="$hashing/objects" &&
      git add -A -- macos >/dev/null 2>&1 &&
      git write-tree --prefix=macos/ 2>/dev/null
  ) || tree=
  rm -rf "$hashing"
  [ -n "$tree" ] || return 1
  { echo "$tree"; xcodebuild -version; swift --version 2>&1; sw_vers -buildVersion; } | shasum -a 256 | cut -d ' ' -f 1
}

already_passed() {
  [ -z "$force" ] && [ -n "$key" ] && [ -e "$passes/$key" ] || return 1
  say "Nothing ran: this exact code already passed on this Mac with these tools ($(cat "$passes/$key")). To run it again anyway, add --force."
}

if [ -z "$quick" ]; then
  key=$(fingerprint) || key=
  already_passed && exit 0
fi

[ -n "${SWIFT_QUEUE_TURN:-}" ] || exec "$here/swift-queue.sh" "$0" "$@"

step() { # name, command
  name=$1
  shift
  started=$(date +%s)
  if "$@"; then
    say "$name took $(elapsed $(($(date +%s) - started)))."
  else
    status=$?
    say "$name failed after $(elapsed $(($(date +%s) - started)))."
    exit "$status"
  fi
}

# One scratch folder for both, so HotWalletKit reuses the PricetagKit that the tests before it just compiled.
tests() { # package
  swift test --package-path "$here/$1" --scratch-path "$here/.build"
}

# A folder each, because two packages sharing one recompile everything each time, even with nothing changed.
ios() { # package
  (cd "$here/$1" && xcodebuild -quiet -scheme "$1" -destination 'generic/platform=iOS' -derivedDataPath "../build/ios/$1" build)
}

step "PricetagKit's tests" tests PricetagKit
step "HotWalletKit's tests" tests HotWalletKit
[ -z "$quick" ] || exit 0
step "The app's Release build" "$here/run.sh" --build-only
step "PricetagKit's iOS build" ios PricetagKit
step "HotWalletKit's iOS build" ios HotWalletKit

# Only remembered if what passed is still what's there.
[ -n "$key" ] || exit 0
if [ "$(fingerprint || true)" = "$key" ]; then
  mkdir -p "$passes"
  find "$passes" -type f -mtime +30 -delete
  echo "$(date '+%Y-%m-%d %H:%M'), $repo" >"$passes/$key.new"
  mv "$passes/$key.new" "$passes/$key"
else
  say "macos/ changed during this run, so this pass won't be remembered."
fi
