#!/bin/sh
# `pnpm check:device-pages`: each hardware wallet page, the way a build that reads a hosted server opens them, with no real funds. A debug build
# carrying the pages serves them, and a headless Chromium goes through each flow with a stand-in browser wallet, whose transactions only
# reach a local fork of Base. A real Ledger or Keystone is still for a person: see HARDWARE-WALLETS.md. Needs Foundry and a Chromium
# (`CHROMIUM=…`, or Playwright's). Nothing opens on screen.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
port=${ANVIL_PORT:-18556}
fork_url=${BASE_RPC_URL:-https://mainnet.base.org}
isolated=device-pages-test

command -v anvil >/dev/null || { echo "This needs Foundry's anvil: https://getfoundry.sh" >&2; exit 1; }
chromium=${CHROMIUM:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/*/*.app/Contents/MacOS/* 2>/dev/null | tail -n 1)}
[ -x "$chromium" ] || { echo "No Chromium. Set CHROMIUM to one." >&2; exit 1; }

"$here/device-pages.sh"
REQUIRE_DEVICE_PAGES=YES CONFIGURATION=Debug "$here/run.sh" --build-only

work=$(mktemp -d "${TMPDIR:-/tmp}/patina-device-pages.XXXX")
anvil_pid=
chromium_pid=
app_pid=
binary="$work/$name.app/Contents/MacOS/$name"

# The tests' result is already decided by now, so nothing in here can change the exit status.
cleanup() {
  set +e
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null
  [ -n "$anvil_pid" ] && kill "$anvil_pid" 2>/dev/null
  # Chromium keeps writing to its profile as it shuts down, so its folder can't be removed until it's gone.
  if [ -n "$chromium_pid" ]; then
    kill "$chromium_pid" 2>/dev/null
    tries=0
    while kill -0 "$chromium_pid" 2>/dev/null && [ "$tries" -lt 50 ]; do
      tries=$((tries + 1))
      sleep 0.1
    done
    [ "$tries" -lt 50 ] || kill -9 "$chromium_pid" 2>/dev/null
    wait "$chromium_pid" 2>/dev/null
  fi
  [ -x "$binary" ] && "$binary" --isolated "$isolated" --reset-isolated-wallet >/dev/null 2>&1
  # Chromium's helpers can outlive it by a moment.
  rm -rf "$work" 2>/dev/null || { sleep 1; rm -rf "$work"; } || echo "Couldn't remove $work" >&2
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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
open -g -j -n --stderr "$work/app.log" --stdout "$work/app.log" "$work/$name.app" --args --quiet --isolated "$isolated" --print-device-page

tries=0
until grep -q '^DEVICE_PAGE ' "$work/app.log" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || { echo "The app didn't start" >&2; cat "$work/app.log" >&2; exit 1; }
  sleep 0.2
done
app_pid=$(sed -n 's/^PID //p' "$work/app.log")
page=$(sed -n 's/^DEVICE_PAGE //p' "$work/app.log")

"$chromium" --headless=new --no-first-run --no-default-browser-check --disable-gpu --remote-debugging-port=0 --user-data-dir="$work/profile" about:blank \
  >"$work/chromium.log" 2>&1 &
chromium_pid=$!

cd "$repo"
ANVIL_RPC_URL="$rpc" DEVICE_PAGE="$page" APP_PID="$app_pid" PAGES_FOLDER="$work/$name.app/Contents/Resources/DevicePages" DEVTOOLS_PORT_FILE="$work/profile/DevToolsActivePort" \
  node scripts/device-pages-e2e.ts
