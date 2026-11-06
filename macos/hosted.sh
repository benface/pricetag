#!/bin/sh
# `pnpm mac:hosted`: the whole app, for colleagues to install: Spending Money, Send, Buy, sites and hardware wallets, reading the hosted server.
# It archives the normal app with Config/Hosted.xcconfig, has Xcode sign it with Developer ID and a provisioning profile, which any Mac accepts
# and which the device-only Keychain needs, notarizes and staples the app through the account signed in to Xcode, and makes a .dmg.
# `pnpm check:hosted` tests what comes out. INSTALLING.md is what goes to people, and it's inside the .dmg too.
#
#   --local       Builds a copy that reads this Mac's server. It's signed, but never notarized.
#   --debug       A signed debug copy with the hooks macos/hosted-test.sh drives, in build/hosted/debug. It's never for anyone else.
#   --build-only  Stops after compiling, unsigned. check:mac uses this.
#
# PATINA_SERVER_HOST in the environment overrides the host in Config/App.xcconfig.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
version=$(sed -n 's/^MARKETING_VERSION = //p' "$here/Config/App.xcconfig")
team=R7TNNTC382
products="$here/build/hosted"

local_copy=
debug=
build_only=
for arg in "$@"; do
  case $arg in
    --local) local_copy=1 ;;
    --debug) debug=1 ;;
    --build-only) build_only=1 ;;
    *)
      echo "Usage: hosted.sh [--local | --debug] [--build-only]" >&2
      exit 64
      ;;
  esac
done

host=${PATINA_SERVER_HOST:-$(sed -n 's/^PATINA_HOSTED_SERVER_HOST = *//p' "$here/Config/App.xcconfig")}
[ -z "$local_copy$debug" ] || host=
# An empty setting quietly reads this Mac's server, which would be no use on anyone else's.
if [ -z "$host" ] && [ -z "$local_copy$debug$build_only" ]; then
  echo "No hosted server is named: PATINA_HOSTED_SERVER_HOST in Config/App.xcconfig is empty. To build a copy for testing here, add --local." >&2
  exit 1
fi

# In a file, because a setting on xcodebuild's command line loses to the same one in an -xcconfig file.
mkdir -p "$products"
printf '#include "%s"\nPATINA_SERVER_HOST = %s\n' "$here/Config/Hosted.xcconfig" "$host" >"$products/build.xcconfig"

if [ -n "$build_only" ]; then
  "$here/swift-queue.sh" xcodebuild -quiet \
    -project "$here/App.xcodeproj" -scheme App -configuration Release -xcconfig "$products/build.xcconfig" \
    -derivedDataPath "$products" -destination 'platform=macOS' \
    -onlyUsePackageVersionsFromResolvedFile CODE_SIGNING_ALLOWED=NO build
  echo "Built the hosted app."
  exit 0
fi

configuration=$([ -n "$debug" ] && echo Debug || echo Release)
archive="$products/$configuration.xcarchive"
rm -rf "$archive"
# Xcode signs for development here, and again for Developer ID when it exports. Leaving out the base entitlements drops get-task-allow,
# so a debugger can't attach and read its memory.
"$here/swift-queue.sh" xcodebuild -quiet \
  -project "$here/App.xcodeproj" -scheme App -configuration "$configuration" -xcconfig "$products/build.xcconfig" \
  -derivedDataPath "$products" -destination 'generic/platform=macOS' -archivePath "$archive" \
  -onlyUsePackageVersionsFromResolvedFile -allowProvisioningUpdates \
  APP_SIGN_STYLE=Automatic APP_TEAM="$team" APP_SIGN_IDENTITY="Apple Development" \
  APP_ENTITLEMENTS=Config/Hosted.entitlements BRIDGE_ENTITLEMENTS=Config/BridgeHost.entitlements APP_INJECT_BASE_ENTITLEMENTS=NO \
  archive

export_options() { # destination
  options="$products/export.plist"
  /usr/libexec/PlistBuddy -c "Add :method string developer-id" -c "Add :teamID string $team" -c "Add :signingStyle string automatic" \
    -c "Add :destination string $1" "$options" >/dev/null
}

rm -f "$products/export.plist"
export_options export
rm -rf "$products/export"
xcodebuild -quiet -exportArchive -archivePath "$archive" -exportOptionsPlist "$products/export.plist" -exportPath "$products/export" -allowProvisioningUpdates
app="$products/export/$name.app"

if [ -n "$debug" ]; then
  rm -rf "$products/debug"
  mkdir -p "$products/debug"
  ditto "$app" "$products/debug/$name.app"
  echo "Built $products/debug/$name.app"
  exit 0
fi

if [ -z "$local_copy" ]; then
  rm -f "$products/export.plist"
  export_options upload
  xcodebuild -quiet -exportArchive -archivePath "$archive" -exportOptionsPlist "$products/export.plist" -exportPath "$products/upload" -allowProvisioningUpdates >/dev/null
  # Apple usually takes a few minutes. This asks until it has an answer, and it's safe to run again if it gives up.
  rm -rf "$products/notarized"
  tries=0
  until xcodebuild -quiet -exportNotarizedApp -archivePath "$archive" -exportPath "$products/notarized" >"$products/notarized.log" 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 80 ]; then
      echo "Apple hasn't finished notarizing after 20 minutes. What it said last:" >&2
      cat "$products/notarized.log" >&2
      exit 1
    fi
    sleep 15
  done
  app="$products/notarized/$name.app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
fi

suffix=$([ -n "$host" ] && echo hosted || echo hosted-local-test)
dmg="$here/build/$name-$version-$suffix.dmg"
contents="$products/dmg"
rm -rf "$contents" "$dmg"
mkdir -p "$contents"
ditto "$app" "$contents/$name.app"
ln -s /Applications "$contents/Applications"
cp "$here/INSTALLING.md" "$contents/Read Me First.md"
# The browser extension, to load unpacked, since it isn't in a store. Its ID comes from the key in its manifest, so it's the one the app's host allows.
mkdir "$contents/Browser Extension"
(cd "$repo/extension" && find . -type f ! -name '*.d.ts' | while IFS= read -r file; do
  mkdir -p "$contents/Browser Extension/$(dirname "$file")"
  cp "$file" "$contents/Browser Extension/$file"
done)
# The app's own stapled ticket is what macOS checks. Signing the image too would ask for a separate notarization, which needs a notarytool login.
hdiutil create -quiet -volname "$name" -srcfolder "$contents" -fs APFS -format ULFO "$dmg"
echo "Built $dmg"
[ -n "$host" ] || echo "It reads this Mac's server, so it's only for testing here, and this doesn't notarize it."
