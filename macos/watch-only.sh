#!/bin/sh
# `pnpm mac:watch-only`: the version of the app colleagues can install. It builds a Release app with Config/WatchOnly.xcconfig, which has no
# key code in it, signs it with Developer ID and only Config/WatchOnly.entitlements, makes a .dmg, then notarizes and staples that.
# `pnpm check:watch-only` tests what comes out. See WATCH-ONLY.md for what to send people.
#
#   --local       Builds a test copy that reads this Mac's server. It's signed, but never notarized.
#   --build-only  Stops after compiling. check:mac uses this.
#
# PATINA_SERVER_HOST in the environment overrides the host in Config/App.xcconfig. NOTARY_PROFILE names the notarytool profile to use.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
version=$(sed -n 's/^MARKETING_VERSION = //p' "$here/Config/App.xcconfig")
config="$here/Config/WatchOnly.xcconfig"
entitlements="$here/Config/WatchOnly.entitlements"
identity="Developer ID Application: Benface Inc. (R7TNNTC382)"
profile=${NOTARY_PROFILE:-patina-notary}
products="$here/build/watch-only"

local_copy=
build_only=
for arg in "$@"; do
  case $arg in
    --local) local_copy=1 ;;
    --build-only) build_only=1 ;;
    *)
      echo "Usage: watch-only.sh [--local] [--build-only]" >&2
      exit 64
      ;;
  esac
done

host=${PATINA_SERVER_HOST:-$(sed -n 's/^PATINA_HOSTED_SERVER_HOST = *//p' "$here/Config/App.xcconfig")}
[ -z "$local_copy" ] || host=
# An empty setting quietly reads this Mac's server, which would be no use on anyone else's.
if [ -z "$host" ] && [ -z "$local_copy" ] && [ -z "$build_only" ]; then
  echo "No hosted server is named: PATINA_HOSTED_SERVER_HOST in Config/App.xcconfig is empty. To build a copy for testing here, add --local." >&2
  exit 1
fi

# Unsigned here, because Xcode would sign with what the project says. It's signed below, once, with one file saying what it may do.
"$here/swift-queue.sh" xcodebuild -quiet \
  -project "$here/App.xcodeproj" -scheme App -configuration Release -xcconfig "$config" \
  -derivedDataPath "$products" -destination 'platform=macOS' \
  -onlyUsePackageVersionsFromResolvedFile PATINA_SERVER_HOST="$host" CODE_SIGNING_ALLOWED=NO DEAD_CODE_STRIPPING=YES build
[ -z "$build_only" ] || { echo "Built the watch-only app."; exit 0; }

stage="$products/stage"
app="$stage/$name.app"
rm -rf "$stage"
mkdir -p "$stage"
ditto "$products/Build/Products/Release/$name.app" "$app"
built_host=$(/usr/libexec/PlistBuddy -c "Print :PatinaServerHost" "$app/Contents/Info.plist" 2>/dev/null || true)
if [ "$built_host" != "$host" ]; then
  echo "This build reads \"$built_host\", and it should read \"$host\"." >&2
  exit 1
fi

# The target is in the project for the normal build, and has no way to be left out of one build alone.
find "$app" -name pricetag-bridge -exec rm -f {} +

# From the inside out, since a signature covers what's inside it. Each is hardened and timestamped, which notarizing asks for.
find "$app/Contents" -depth -type f -perm -u+x ! -path "$app/Contents/MacOS/$name" | while IFS= read -r file; do
  if file -b "$file" | grep -q Mach-O; then
    codesign --force --options runtime --timestamp --sign "$identity" "$file"
  fi
done
codesign --force --options runtime --timestamp --sign "$identity" --entitlements "$entitlements" "$app"
codesign --verify --deep --strict "$app"

suffix=$([ -n "$host" ] && echo watch-only || echo watch-only-local-test)
dmg="$here/build/$name-$version-$suffix.dmg"
contents="$products/dmg"
rm -rf "$contents" "$dmg"
mkdir -p "$contents"
ditto "$app" "$contents/$name.app"
ln -s /Applications "$contents/Applications"
cp "$here/WATCH-ONLY.md" "$contents/Read Me First.md"
hdiutil create -quiet -volname "$name" -srcfolder "$contents" -fs APFS -format ULFO "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
codesign --verify --strict "$dmg"
echo "Built and signed $dmg"

if [ -z "$host" ]; then
  echo "It reads this Mac's server, so it's only for testing here, and this doesn't notarize it."
  exit 0
fi

if ! xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
  cat >&2 <<HELP
It isn't notarized, because this Mac has no notarytool profile named $profile. To fix that, once:

  1. Make an app-specific password for your Apple ID, at https://account.apple.com under Sign-In and Security.
  2. Run this in a terminal, and paste the password when it asks. It's saved in your Keychain, and nothing else ever sees it:

       xcrun notarytool store-credentials $profile --apple-id <your Apple ID> --team-id R7TNNTC382

  3. Run this script again.
HELP
  exit 2
fi

xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
echo "Notarized and stapled $dmg"
