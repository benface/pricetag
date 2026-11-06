#!/bin/sh
# Tells each Chromium browser on this Mac where the extension's native messaging host is. Only the extension with this ID can start it.
# `macos/run.sh` runs this, and a test keeps this ID and the host's the same as what `extension/manifest.json`'s key gives.
set -eu

extension_id=bidkgdhmaoccbkcccmijbppcfeicbllh
app=$1
host="$app/Contents/Helpers/pricetag-bridge"
[ -x "$host" ] || { echo "No host at $host" >&2; exit 1; }
# Goes in a JSON string below.
case "$host" in *[[:cntrl:]]*) echo "Can't install from a path with control characters: $host" >&2; exit 1 ;; esac
json_host=$(printf '%s' "$host" | sed 's/[\\"]/\\&/g')

support="$HOME/Library/Application Support"
for browser in \
  "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Chromium" \
  "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data" "Dia/User Data"; do
  [ -d "$support/$browser" ] || continue
  mkdir -p "$support/$browser/NativeMessagingHosts"
  cat > "$support/$browser/NativeMessagingHosts/com.benface.patina.json" <<JSON
{
  "name": "com.benface.patina",
  "description": "Connects the extension to the Mac app",
  "path": "$json_host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$extension_id/"]
}
JSON
done
