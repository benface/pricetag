#!/bin/sh
# `pnpm check:mac`: the Swift tests, the app's build, and the shared packages' builds for iOS, as one turn in the Swift queue.
# It runs nothing if this exact code already passed on this Mac with these tools, unless it's given --force.
# `pnpm check:mac:quick` (--quick) is only the tests, always run, for while you're working. It never counts as a pass. See TESTING.md.
# A pass is only remembered once the queue has verified that the whole turn is over, and any run that fails forgets one for its code.
# Each full run that starts claims its code in <key>.latest, and a pass only counts if it's from the run named there. So a run's slow
# publication can't undo what a newer run found, with no lock for it to hold up, and being wrong about it only means running again.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
passes=${CHECK_MAC_PASSES:-$HOME/Library/Caches/patina-check-mac}
quick=
force=

# What the queue runs after a turn passes and everything it started is verified gone: records what that turn says passed, if anything.
if [ "${1:-}" = --remember ]; then
  key=$(cat "${CHECK_MAC_PASSED:-/nonexistent}" 2>/dev/null) || exit 0
  rm -f "$CHECK_MAC_PASSED"
  find "$passes" -type f -mtime +30 -delete || true
  run=$(basename "$CHECK_MAC_PASSED")
  printf '%s\n' "$run" "$(date '+%Y-%m-%d %H:%M'), $repo" >"$passes/$key.$run.new"
  mv "$passes/$key.$run.new" "$passes/$key"
  exit 0
fi

# What the queue runs when a run's stopped, even if it had already got as far as --remember: that run's pass no longer counts.
if [ "${1:-}" = --withdraw ]; then
  [ -n "${CHECK_MAC_PASSED:-}" ] || exit 0
  rm -f "$CHECK_MAC_PASSED"
  run=$(basename "$CHECK_MAC_PASSED")
  for latest in "$passes"/*.latest; do
    [ "$(cat "$latest" 2>/dev/null)" != "$run" ] || rm -f "$latest"
  done
  exit 0
fi

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
  { read -r run && read -r when; } <"$passes/$key" || return 1
  [ "$run" = "$(cat "$passes/$key.latest" 2>/dev/null)" ] || return 1
  say "Nothing ran: this exact code already passed on this Mac with these tools ($when). To run it again anyway, add --force."
}

forget() {
  [ -z "$key" ] || rm -f "$passes/$key" "$passes/$key.latest"
}

if [ -z "${SWIFT_QUEUE_TURN:-}" ]; then
  [ -z "$quick" ] || exec "$here/swift-queue.sh" "$0" "$@"
  key=$(fingerprint) || key=
  already_passed && exit 0
  # Where the turn says what passed, named for this run alone. It's only there if the turn got to the end.
  if [ -n "$key" ]; then
    CHECK_MAC_PASSED="$passes/running.$$.$(date +%s)"
    SWIFT_QUEUE_ON_PASS="\"$here/check-mac.sh\" --remember"
    SWIFT_QUEUE_ON_STOP="\"$here/check-mac.sh\" --withdraw"
    export CHECK_MAC_PASSED SWIFT_QUEUE_ON_PASS SWIFT_QUEUE_ON_STOP
  fi
  exec "$here/swift-queue.sh" "$0" "$@"
fi

# Its turn may have come after another worktree passed this same code. If not, this run is what says whether it passes now, so an
# earlier pass doesn't outlive a run that's stopped partway. --quick can't pass it again, so it only forgets one when it fails.
key=$(fingerprint) || key=
if [ -z "$quick" ]; then
  already_passed && exit 0
  forget
  if [ -n "$key" ] && [ -n "${CHECK_MAC_PASSED:-}" ]; then
    mkdir -p "$passes"
    basename "$CHECK_MAC_PASSED" >"$passes/$key.latest"
  fi
fi

step() { # name, command
  name=$1
  shift
  started=$(date +%s)
  if "$@"; then
    say "$name took $(elapsed $(($(date +%s) - started)))."
  else
    status=$?
    say "$name failed after $(elapsed $(($(date +%s) - started)))."
    forget
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
step "The watch-only build" "$here/watch-only.sh" --build-only
step "PricetagKit's iOS build" ios PricetagKit
step "HotWalletKit's iOS build" ios HotWalletKit

# Only remembered if what passed is still what's there.
[ -n "$key" ] || exit 0
if [ "$(fingerprint || true)" = "$key" ]; then
  [ -z "${CHECK_MAC_PASSED:-}" ] || echo "$key" >"$CHECK_MAC_PASSED"
else
  say "macos/ changed during this run, so this pass won't be remembered."
fi
