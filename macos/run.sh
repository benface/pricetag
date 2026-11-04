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

# The running copy may be an older build.
osascript -e "tell application id \"com.benface.pricetag.mac\" to quit" >/dev/null 2>&1 || true
open "$app"

if curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/portfolio/demo"; then
  echo "$name is open. A server is already answering on port $port, so this leaves it alone."
  exit 0
fi

cd "$repo"
[ -d node_modules ] || pnpm install --frozen-lockfile
echo "$name is open. Serving it on port $port until you press Ctrl-C. It says so when the server's gone."
exec node --env-file-if-exists=.env.local server/index.ts
