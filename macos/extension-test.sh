#!/bin/sh
# `pnpm check:extension`: the whole path for real, with no real funds. A headless Chromium loads the extension and opens a real site, and
# its requests go through the native host and the socket to a debug build of the app, whose isolated wallet has a throwaway key and only
# holds anything on a local fork of Base. The test's local server stands in for the person at the approval window. Needs Foundry and a Chromium that can
# load unpacked extensions (`CHROMIUM=…`, or Playwright's). Nothing opens on screen.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
port=${ANVIL_PORT:-18546}
fork_url=${BASE_RPC_URL:-https://mainnet.base.org}
isolated=extension-test

command -v anvil >/dev/null || { echo "This needs Foundry's anvil: https://getfoundry.sh" >&2; exit 1; }
chromium=${CHROMIUM:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/*/*.app/Contents/MacOS/* 2>/dev/null | tail -n 1)}
[ -x "$chromium" ] || { echo "No Chromium. Set CHROMIUM to one that can load unpacked extensions: branded Chrome can't." >&2; exit 1; }

CONFIGURATION=Debug "$here/run.sh" --build-only

work=$(mktemp -d "${TMPDIR:-/tmp}/patina-extension.XXXX")
answers_port=${ANSWERS_PORT:-18547}
anvil_pid=
chromium_pid=
app_pid=
binary="$work/$name.app/Contents/MacOS/$name"

cleanup() {
  [ -n "$chromium_pid" ] && kill "$chromium_pid" 2>/dev/null || true
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  [ -n "$anvil_pid" ] && kill "$anvil_pid" 2>/dev/null || true
  [ -x "$binary" ] && "$binary" --isolated "$isolated" --reset-isolated-wallet >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

ditto "$here/build/Build/Products/Debug/$name.app" "$work/$name.app"

anvil --fork-url "$fork_url" --port "$port" --silent >"$work/anvil.log" 2>&1 &
anvil_pid=$!
rpc="http://127.0.0.1:$port"
tries=0
until curl -fs -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc"; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || { echo "anvil didn't start" >&2; exit 1; }
  sleep 0.3
done

"$binary" --isolated "$isolated" --reset-isolated-wallet >/dev/null
open -g -j -n --stderr "$work/app.log" --stdout "$work/app.log" "$work/$name.app" --args \
  --quiet --isolated "$isolated" --create-wallet --rpc "$rpc" --print-address --answer-site-requests-from "http://127.0.0.1:$answers_port/"

tries=0
until grep -q '^ADDRESS 0x' "$work/app.log" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || { echo "The app didn't start" >&2; cat "$work/app.log" >&2; exit 1; }
  sleep 0.2
done
address=$(sed -n 's/^ADDRESS //p' "$work/app.log")
app_pid=$(sed -n 's/^PID //p' "$work/app.log")

extension_id=$(sed -n 's/^extension_id=//p' "$here/install-bridge.sh")
mkdir -p "$work/profile/NativeMessagingHosts"
cat > "$work/profile/NativeMessagingHosts/com.benface.patina.json" <<JSON
{
  "name": "com.benface.patina",
  "description": "Connects the extension to the Mac app",
  "path": "$work/$name.app/Contents/Helpers/pricetag-bridge",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$extension_id/"]
}
JSON

"$chromium" --headless=new --no-first-run --no-default-browser-check --disable-gpu --remote-debugging-port=0 \
  --user-data-dir="$work/profile" --disable-extensions-except="$repo/extension" --load-extension="$repo/extension" about:blank \
  >"$work/chromium.log" 2>&1 &
chromium_pid=$!

cd "$repo"
ANVIL_RPC_URL="$rpc" EXTENSION_ID="$extension_id" HOT_WALLET="$address" ANSWERS_PORT="$answers_port" APP_LOG="$work/app.log" DEVTOOLS_PORT_FILE="$work/profile/DevToolsActivePort" \
  node scripts/extension-e2e.ts "$@"
