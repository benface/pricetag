#!/bin/sh
# `pnpm mac`: builds the app, opens it, and runs the server it reads from until you press Ctrl-C.
# `pnpm mac:build` stops after the build.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
port=${PORT:-8787}
build="$here/build"
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")

# Signing with a real identity keeps the sandbox from treating each rebuild as a different app.
identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)
# The Keychain ties a hot wallet's key to the signing team, so a different team can't read a key this one made. That's why
# this is pinned rather than picked from whatever's installed. It's a personal team, whose profiles last 7 days: each build renews it.
team=83535P4H56

# Packages only ever come from the committed Package.resolved.
build_app() {
  xcodebuild -quiet \
    -project "$here/App.xcodeproj" -scheme App -configuration "$configuration" \
    -derivedDataPath "$build" -destination 'platform=macOS' \
    -onlyUsePackageVersionsFromResolvedFile "$@" build
}

configuration=${CONFIGURATION:-Release}
app="$build/Build/Products/$configuration/$name.app"

# The hot wallet's key needs the device-only Keychain, and only a provisioned build can reach it. Without that team signed in to
# Xcode, this still builds a working app, which says it can't hold a key. Everything else works.
#
# Leaving out the base entitlements drops get-task-allow, so a debugger can't attach to a release build and read its memory.
if build_app -allowProvisioningUpdates \
  APP_SIGN_STYLE=Automatic APP_TEAM="$team" APP_SIGN_IDENTITY="Apple Development" \
  APP_ENTITLEMENTS=Config/HotWallet.entitlements \
  APP_INJECT_BASE_ENTITLEMENTS="$([ "$configuration" = Release ] && echo NO || echo YES)"; then
  echo "Signed for team $team, so this build can hold a hot wallet."
else
  echo "Couldn't provision this build, so it can't hold a hot wallet. To fix that, sign in to Xcode with the account for team $team." >&2
  build_app APP_SIGN_IDENTITY="${identity:--}"
fi

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
