#!/bin/sh
# `pnpm mac`: builds the app, opens it, and runs the server it reads from until you press Ctrl-C.
# `pnpm mac:build` stops after the build.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
port=${PORT:-8787}
build="$here/build"
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
app="$build/Build/Products/Release/$name.app"

# Signing with a real identity keeps the sandbox from treating each rebuild as a different app.
identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)

xcodebuild -quiet \
  -project "$here/App.xcodeproj" -scheme App -configuration Release \
  -derivedDataPath "$build" -destination 'platform=macOS' \
  CODE_SIGN_IDENTITY="${identity:--}" build

[ "${1:-}" = "--build-only" ] && { echo "Built $app"; exit 0; }

# The running copy may be an older build. Opening it while it's still quitting would do nothing.
pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
while pgrep -f "$app/Contents/MacOS/" >/dev/null; do sleep 0.2; done

is_serving() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/portfolio/demo"; }

if is_serving; then
  open "$app"
  echo "$name is open. A server is already answering on port $port, so this leaves it alone."
  exit 0
fi

cd "$repo"
[ -d node_modules ] || pnpm install --frozen-lockfile
PORT=$port node --env-file-if-exists=.env.local server/index.ts &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT INT TERM

# The app says the server's gone if it opens first.
tries=0
until is_serving || [ "$tries" -ge 25 ]; do
  sleep 0.2
  tries=$((tries + 1))
done

open "$app"
echo "$name is open. Serving it on port $port until you press Ctrl-C. It says so when the server's gone."
wait "$server"
