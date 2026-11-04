#!/bin/sh
# `pnpm mac:shot`: screenshots of the Mac app from fixtures, without opening it where anyone can see, or taking focus.
# How to use it, and what it can't show, is in TESTING.md.
set -eu

usage() {
  cat >&2 <<USAGE
Usage:
  shot.sh <scene> <output.png> [--dark] [--window]
  shot.sh all <folder> [--window]    Every scene, in light and dark.
  shot.sh list                       Every scene. "window" ones always use a real window.

--window  Captures a real window behind the desktop, instead of rendering without one. Shows the toolbar, materials and glass.
USAGE
  exit 64
}

here=$(cd "$(dirname "$0")" && pwd)
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
# Debug's, from App.xcconfig. A fixture run with this in front is the one thing this must never cause.
bundle_id=$(sed -n 's/^PRODUCT_BUNDLE_IDENTIFIER\[config=Debug\] = //p' "$here/Config/App.xcconfig")
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ $# -ge 1 ] || usage
scene=$1
shift
output=
if [ "$scene" != list ]; then
  [ $# -ge 1 ] || usage
  output=$1
  shift
fi
dark=NO
window=NO
for flag in "$@"; do
  case $flag in
    --dark) dark=YES ;;
    --window) window=YES ;;
    *) usage ;;
  esac
done

# Without the sandbox, there's no container for macOS to stop the launch and ask about when a build's signature changes.
# Fixtures come from the bundle and PNGs go to the run's folder, so this reads and writes nothing it wouldn't otherwise.
xcodebuild -quiet \
  -project "$here/App.xcodeproj" -scheme App -configuration Debug \
  -derivedDataPath "$here/build/test-mode" -destination 'platform=macOS' \
  -onlyUsePackageVersionsFromResolvedFile ENABLE_APP_SANDBOX=NO build >&2

run=$(mktemp -d "${TMPDIR:-/tmp}/patina-shot.XXXXXX")
ditto "$here/build/test-mode/Build/Products/Debug/$name.app" "$run/$name.app"
binary="$run/$name.app/Contents/MacOS/$name"

started=
watcher=
cleanup() {
  for pid in $started $watcher; do kill "$pid" 2>/dev/null || true; done
  "$lsregister" -u "$run/$name.app" 2>/dev/null || true
  rm -rf "$run"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

scenes=$("$binary" --test-scenes)
if [ "$scene" = list ]; then
  printf '%s\n' "$scenes"
  exit 0
fi

# Every change of the frontmost app while this runs, whoever caused it.
lsappinfo listen +becameFrontmost forever >"$run/focus" 2>&1 &
watcher=$!

front_app() {
  lsappinfo info -only name "$(lsappinfo front)" | sed -n 's/^"\([^"]*\)".*/\1/p'
}

render() { # scene appearance output
  # Only when it fails, because macOS logs noise here that means nothing.
  "$binary" --test-scene "$1" --appearance "$2" --output "$run/shot.png" 2>"$run/stderr" || {
    cat "$run/stderr" >&2
    exit 1
  }
  mv "$run/shot.png" "$3"
}

capture_window() { # scene appearance output
  : >"$run/stdout"
  : >"$run/stderr"
  open -g -j -n --stdout "$run/stdout" --stderr "$run/stderr" "$run/$name.app" --args --test-scene "$1" --appearance "$2"
  tries=0
  until grep -q '^WINDOW ' "$run/stdout"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 100 ]; then
      echo "The test window for $1 never appeared. $(cat "$run/stderr")" >&2
      exit 1
    fi
    sleep 0.1
  done
  window_id=$(awk '/^WINDOW /{print $2}' "$run/stdout")
  pid=$(awk '/^WINDOW /{print $3}' "$run/stdout")
  started="$started $pid"
  # -o leaves out the shadow, -x the sound. This needs Screen Recording for whatever's running this script.
  screencapture -o -x -l "$window_id" "$3" || {
    echo "Couldn't capture window $window_id. Does whatever's running this have Screen Recording in System Settings?" >&2
    exit 1
  }
  kill "$pid"
  while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done
}

shoot() { # scene appearance output
  if [ "$window" = YES ] || printf '%s\n' "$scenes" | grep -qx "$1 window"; then
    capture_window "$@"
  else
    render "$@"
  fi
}

front_before=$(front_app)
if [ "$scene" = all ]; then
  mkdir -p "$output"
  for each in $(printf '%s\n' "$scenes" | cut -d ' ' -f 1); do
    for appearance in light dark; do
      shoot "$each" "$appearance" "$output/$each-$appearance.png"
    done
  done
  echo "Wrote $output"
else
  shoot "$scene" "$([ "$dark" = YES ] && echo dark || echo light)" "$output"
  echo "Wrote $output"
fi

# Lets a change caused by the last shot be delivered.
sleep 0.2
kill "$watcher"
wait "$watcher" 2>/dev/null || true
watcher=
if grep -q "\"CFBundleIdentifier\"=\"$bundle_id\"" "$run/focus"; then
  echo "This took focus, which it must never do. Don't run it again until that's fixed." >&2
  exit 1
fi
changes=$(grep -c 'kLSNotifyBecameFrontmost' "$run/focus" || true)
others=$(sed -n 's/.*"CFBundleIdentifier"="\([^"]*\)".*/\1/p' "$run/focus" | sort -u | paste -s -d ' ' -)
echo "Focus: $front_before was in front when this started, and this never took focus. Other apps' changes during the run: ${changes:-0}${others:+ ($others)}."
