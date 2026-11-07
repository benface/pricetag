#!/bin/sh
# `pnpm mac`: builds the app, opens it, and runs the server it reads from until you press Ctrl-C.
# `pnpm mac:build` stops after the build, and takes its turn with everything else that compiles Swift. `pnpm mac` doesn't wait for anyone.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--build-only" ] && [ -z "${SWIFT_QUEUE_TURN:-}" ]; then exec "$here/swift-queue.sh" "$0" "$@"; fi
repo=$(dirname "$here")
port=${PORT:-8787}
build="$here/build"
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")

# Signing with a real identity keeps the sandbox from treating each rebuild as a different app.
identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)
# The Keychain ties a hot wallet's key to the signing team, so a different team can't read a key this one made. That's why
# this is pinned rather than picked from whatever's installed. It's Benface Inc., a paid team, so a profile lasts a year and doesn't hold up a launch.
team=R7TNNTC382

# Packages only ever come from the committed Package.resolved.
build_app() {
  xcodebuild -quiet \
    -project "$here/App.xcodeproj" -scheme App -configuration "$configuration" \
    -derivedDataPath "$build" -destination 'platform=macOS' \
    -onlyUsePackageVersionsFromResolvedFile "$@" build
}

configuration=${CONFIGURATION:-Release}
app="$build/Build/Products/$configuration/$name.app"

# What Xcode says when this Mac can't provision the build. It puts these on the project or on no file at all, so a compile error can't match,
# whatever it says.
provisioning_error='^(.*\.xcodeproj: )?error: (No Accounts?[: ]|No profiles for |No signing certificate |Signing for .* requires a development team|Provisioning profile |Unable to log in with account )'

# Xcode stops at these errors before it runs any build command, and exits 65. So a kill or a crash (any other exit code), another error alongside them,
# or a command that failed means something else went wrong too. So does not reaching Apple, which can come with the same errors.
cant_provision() { # build's exit code, build's output
  [ "$1" -eq 65 ] &&
    grep -Eq "$provisioning_error" "$2" &&
    ! grep -E '(^|[[:space:]])error:' "$2" | grep -Evq "$provisioning_error" &&
    ! grep -Eq 'The following build commands failed:|Communication with Apple failed|timed out|appears to be offline|hostname could not be found' "$2"
}

# The hot wallet's key needs the device-only Keychain, and only a provisioned build can reach it. Without that team signed in to
# Xcode, this still builds a working app, which says it can't hold a key. Everything else works. Any other failure stops here, so
# something that only hit this one build can't end with an app that can't hold a key.
#
# Leaving out the base entitlements drops get-task-allow, so a debugger can't attach to a release build and read its memory.
mkdir -p "$build"
output="$build/provisioned-build.log"
if build_app -allowProvisioningUpdates \
  APP_SIGN_STYLE=Automatic APP_TEAM="$team" APP_SIGN_IDENTITY="Apple Development" \
  APP_ENTITLEMENTS=Config/HotWallet.entitlements BRIDGE_ENTITLEMENTS=Config/BridgeHost.entitlements \
  APP_INJECT_BASE_ENTITLEMENTS="$([ "$configuration" = Release ] && echo NO || echo YES)" >"$output" 2>&1; then
  cat "$output"
  echo "Signed for team $team, so this build can hold a hot wallet."
else
  status=$?
  cat "$output"
  cant_provision "$status" "$output" || exit "$status"
  echo "Couldn't provision this build, so it can't hold a hot wallet. To fix that, sign in to Xcode with the account for team $team." >&2
  build_app APP_SIGN_IDENTITY="${identity:--}"
fi

[ "${1:-}" = "--build-only" ] && { echo "Built $app"; exit 0; }

# So the browser extension can reach this build.
"$here/install-bridge.sh" "$app"

# The running copy may be an older build. Opening it while it's still quitting would do nothing.
pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
while pgrep -f "$app/Contents/MacOS/" >/dev/null; do sleep 0.2; done
# The copy `pnpm mac:install` keeps is the same app, and two of it can't both hold the wallet. Its server can stay: it's this folder's too.
installed="$HOME/Applications/$name.app"
pkill -f "$installed/Contents/MacOS/" 2>/dev/null || true
while pgrep -f "$installed/Contents/MacOS/" >/dev/null; do sleep 0.2; done

is_serving() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/portfolio/demo"; }

if is_serving; then
  open "$app"
  echo "$name is open. A server is already answering on port $port, so this leaves it alone."
  exit 0
fi

cd "$repo"
# The Top Up and Publish buttons open the web app's hardware wallet flow, which this server serves from the build.
{ pnpm install --frozen-lockfile && pnpm build; } || echo "Couldn't build the web app, so Top Up and Publish from a device won't open." >&2
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
