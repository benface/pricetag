#!/bin/sh
# `pnpm check:hosted`: tests the whole app as colleagues get it, with no real funds, and without opening a window or taking focus.
#
# The .dmg's release app: its signature, profile and entitlements, that it reads the hosted server, what's beside it in the image, and that it
# launches, finds a server's 401, tells a browser where its host is and leaves every manifest that's already there alone. Its first read and questions
# run if PATINA_TEST_ENV_FILE names a .env.local with Amp credentials, which stay in that server's environment.
#
# What launches of the release app goes by its own test ID, with no profile, Keychain group or app group, so it can't reach an installed copy's key, settings,
# records or socket, and this stops before launching if that isn't so. It can't write to a browser's manifest that's already there either, whoever wrote it,
# since it's signed without that browser's paths. So the release app under its real ID and profile first launches on someone's Mac, not here.
#
# A debug copy signed the same way, whose isolated wallet has its own Keychain service inside this build's own Keychain group: a new key in
# the real Secure Enclave and device-only Keychain, a sweep, and a site's transaction through the extension, all on a local fork of Base.
#
# Every copy that launches has its patina:// scheme taken out and is signed again, so it can't take that link from another build, and it never
# has a quarantine flag, whose first-launch dialog would land on someone's screen. Check Gatekeeper with spctl. Never launch a quarantined copy here.
#
# Usage: hosted-test.sh [--no-launch] [path to the .dmg]. With none, it builds a --local one first. --no-launch stops before anything runs, since
# even in the background a copy puts its icon in the menu bar, for a time when someone's presenting from this Mac.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
bundle_id=$(sed -n 's/^APP_BUNDLE_ID = //p' "$here/Config/Hosted.xcconfig")
test_id="$bundle_id.check"
probe_id="$test_id.keychain"
identity="Developer ID Application: Benface Inc. (R7TNNTC382)"
team=R7TNNTC382
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
fork_url=${BASE_RPC_URL:-https://mainnet.base.org}
support="$HOME/Library/Application Support"

no_launch=
if [ "${1:-}" = --no-launch ]; then
  no_launch=1
  shift
fi

if [ $# -ge 1 ]; then
  dmg=$1
else
  "$here/hosted.sh" --local
  dmg=$(ls -t "$here"/build/"$name"-*-hosted-local-test.dmg | head -n 1)
fi
[ -f "$dmg" ] || { echo "No .dmg at $dmg" >&2; exit 1; }

# Resolved, because the app reports where it is that way, and a manifest has to match it.
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/patina-hosted.XXXXXX")" && pwd -P)
mount="$work/mount"
started=
new_manifests=
new_folders=
cleanup() {
  set +e
  for pid in $started; do kill "$pid" 2>/dev/null; done
  pkill -f "$work/" 2>/dev/null
  [ -x "$work/debug/$name.app/Contents/MacOS/$name" ] && "$work/debug/$name.app/Contents/MacOS/$name" --isolated hosted-test --reset-isolated-wallet >/dev/null 2>&1
  # Only what this test's launch added, and is still this test's. A manifest that was already there can't have changed, since the copy isn't allowed to write it.
  printf '%s\n' "$new_manifests" | while IFS= read -r file; do
    if [ -n "$file" ] && /usr/bin/python3 -I -c 'import json,sys;assert json.load(open(sys.argv[1]))["path"].startswith(sys.argv[2]+"/")' "$file" "$work" 2>/dev/null; then rm -f "$file"; fi
  done
  printf '%s\n' "$new_folders" | while IFS= read -r folder; do [ -z "$folder" ] || rmdir "$folder" 2>/dev/null; done
  for app in "$work/release/$name.app" "$work/debug/$name.app"; do "$lsregister" -u "$app" 2>/dev/null; done
  hdiutil detach -quiet "$mount" 2>/dev/null
  rm -rf "$work"
  # Only the test IDs' folders. An installed copy's holds someone's wallet. macOS guards these, so this may not be allowed, and they hold no key either way.
  for id in "$test_id" "$probe_id"; do
    rm -rf "${HOME:?}/Library/Containers/$id" 2>/dev/null || echo "macOS wouldn't let this remove $HOME/Library/Containers/$id, which is left over from testing."
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

failures=0
pass() { echo "  ok: $*"; }
fail() {
  echo "  FAILED: $*" >&2
  failures=$((failures + 1))
}
check() { # what, command
  what=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

# A copy that's safe to launch here. See the top of this file.
launchable() { # from, to
  mkdir -p "$(dirname "$2")"
  ditto --noqtn "$1" "$2"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$2/Contents/Info.plist" 2>/dev/null || true
}
sign_with() { # app, entitlements
  codesign --force --options runtime --timestamp=none --entitlements "$2" --sign "$identity" "$1" 2>/dev/null
}

free_port() { node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

echo "The release app in the .dmg:"
mkdir -p "$mount"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$dmg"
app="$mount/$name.app"
binary="$app/Contents/MacOS/$name"
read_info() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Contents/Info.plist" 2>/dev/null; }

check "the app's signature holds" codesign --verify --deep --strict "$app"
codesign -dvvv "$app" 2>"$work/signature" || true
if grep -q "^Authority=$identity" "$work/signature"; then pass "signed with Developer ID for $team"; else fail "not signed with Developer ID for $team"; fi
if grep -q "flags=.*runtime" "$work/signature"; then pass "hardened runtime"; else fail "no hardened runtime"; fi
if grep -q "^Timestamp=" "$work/signature"; then pass "secure timestamp"; else fail "no secure timestamp"; fi
if [ "$(read_info CFBundleIdentifier)" = "$bundle_id" ]; then pass "its own bundle ID, $bundle_id"; else fail "bundle ID is $(read_info CFBundleIdentifier)"; fi
if [ "$(read_info LSMinimumSystemVersion)" = 27.0 ]; then pass "needs macOS 27.0"; else fail "minimum macOS is $(read_info LSMinimumSystemVersion)"; fi
served=$(read_info PatinaServerHost || true)
case $dmg in
  *-local-test.dmg) if [ -z "$served" ]; then pass "reads this Mac's server, as a local test copy should"; else fail "a local test copy reads $served"; fi ;;
  *)
    if [ "$served" = "$(sed -n 's/^PATINA_HOSTED_SERVER_HOST = *//p' "$here/Config/App.xcconfig")" ] && [ -n "$served" ]; then pass "reads the hosted server, $served"; else fail "reads \"$served\", not the hosted server"; fi
    check "its notarization ticket is stapled" xcrun stapler validate "$app"
    if spctl --assess --type execute --verbose=2 "$app" 2>&1 | grep -q 'source=Notarized Developer ID'; then pass "Gatekeeper accepts it as Notarized Developer ID"; else fail "Gatekeeper's answer: $(spctl --assess --type execute --verbose=2 "$app" 2>&1)"; fi
    ;;
esac

profile="$app/Contents/embedded.provisionprofile"
if [ -f "$profile" ]; then
  security cms -D -i "$profile" >"$work/profile.plist" 2>/dev/null
  read_profile() { /usr/libexec/PlistBuddy -c "Print :$1" "$work/profile.plist" 2>/dev/null; }
  if [ "$(read_profile ProvisionsAllDevices)" = true ]; then pass "its profile isn't tied to registered Macs"; else fail "its profile only runs on registered Macs"; fi
  if [ "$(read_profile Entitlements:com.apple.application-identifier)" = "$team.$bundle_id" ]; then pass "its profile is for this app"; else fail "its profile is for $(read_profile Entitlements:com.apple.application-identifier)"; fi
else
  fail "no provisioning profile, so it can't hold a key"
fi

codesign -d --entitlements - --xml "$app" 2>/dev/null >"$work/entitlements.plist"
/usr/bin/plutil -convert json -o "$work/entitlements.json" "$work/entitlements.plist"
entitlement_checks=$(/usr/bin/python3 -I - "$work/entitlements.json" "$here/Config/Hosted.entitlements" "$team" <<'PYTHON'
import json, plistlib, sys
have = json.load(open(sys.argv[1]))
want = plistlib.load(open(sys.argv[2], "rb"))
team = sys.argv[3]
exception = "com.apple.security.temporary-exception.files.home-relative-path.read-write"
def line(ok, what): print(("ok" if ok else "bad") + " " + what)
line(have.get("keychain-access-groups") == [f"{team}.com.benface.pricetag.hosted.hotwallet"], "its only Keychain group is its own")
line(have.get("com.apple.security.application-groups") == [f"{team}.com.benface.pricetag.bridge"], "its only app group is the extension's socket")
line(have.get("com.apple.security.app-sandbox") is True, "sandboxed")
line(have.get("com.apple.security.network.server") is True, "it can open the listener a hardware wallet page needs")
line("com.apple.security.get-task-allow" not in have, "a debugger can't attach")
line(have.get(exception) == want[exception], "outside its sandbox, it can only write what Hosted.entitlements names")
line(all(p.endswith(("/NativeMessagingHosts", "/NativeMessagingHosts/com.benface.patina.json")) for p in have.get(exception, [])), "and that's only the browsers' host manifest for this app")
known = {"com.apple.application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups", "com.apple.security.app-sandbox", "com.apple.security.application-groups", "com.apple.security.device.camera", "com.apple.security.files.user-selected.read-write", "com.apple.security.network.client", "com.apple.security.network.server", exception}
line(set(have) <= known, "nothing else: " + " ".join(sorted(set(have) - known)))
PYTHON
)
printf '%s\n' "$entitlement_checks" | while IFS= read -r line; do echo "  $line"; done
case $entitlement_checks in *bad\ *) failures=$((failures + 1)) ;; esac

host="$app/Contents/Helpers/pricetag-bridge"
if [ -x "$host" ]; then
  if codesign -d --entitlements - --xml "$host" 2>/dev/null | grep -q keychain-access-groups; then fail "the extension's host can reach the Keychain"; else pass "the extension's host can't reach the Keychain"; fi
  codesign -dvvv "$host" 2>&1 | grep -q "^Authority=$identity" && pass "the extension's host is signed the same way" || fail "the extension's host isn't signed with Developer ID"
else
  fail "no extension host"
fi

check "the hardware wallet pages, which a hosted server doesn't serve" test -f "$app/Contents/Resources/DevicePages/device.html"

nm -u "$binary" >"$work/imports" 2>/dev/null
if grep -qx _SecRandomCopyBytes "$work/imports"; then pass "its keys come from SecRandomCopyBytes"; else fail "doesn't import SecRandomCopyBytes"; fi
# A release build's symbols are stripped, but the library's own checks stay in it as text.
if strings -a "$binary" | grep -q secp256k1_context_is_proper; then pass "it signs with libsecp256k1"; else fail "no libsecp256k1 in it"; fi
if strings -a "$binary" | grep -qE -- '--hot-wallet-self-test|--create-wallet|--answer-site-requests-from'; then fail "still has debug hooks"; else pass "no debug hooks"; fi

echo "Beside it in the .dmg:"
check "the install note" test -f "$mount/Read Me First.md"
check "the install note says what it is on its first lines" sh -c "head -n 3 '$mount/Read Me First.md' | grep -q 'unreviewed build'"
check "the install note says macOS 27 first" sh -c "head -n 1 '$mount/Read Me First.md' | grep -q 'macOS 27'"
check "the extension" test -f "$mount/Browser Extension/manifest.json"
if [ "$(/usr/bin/python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["key"])' "$mount/Browser Extension/manifest.json")" = "$(/usr/bin/python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["key"])' "$repo/extension/manifest.json")" ]; then pass "the extension keeps the key its ID comes from"; else fail "the extension's key changed"; fi

if [ -n "$no_launch" ]; then
  if [ "$failures" -gt 0 ]; then
    echo "$failures failed." >&2
    exit 1
  fi
  echo "All passed, without launching anything."
  exit 0
fi

echo "A local server in hosted mode:"
invite=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
hash=$(printf '%s' "$invite" | shasum -a 256 | cut -d ' ' -f 1)
port=$(free_port)
requests="$work/requests"
: >"$requests"
env_file=${PATINA_TEST_ENV_FILE:-}
(cd "$repo" && PRICETAG_HOSTED=1 PRICETAG_INVITES="test:$hash" PRICETAG_CLIENT_IP_HEADER=x-test-client HOST=127.0.0.1 PORT=$port exec node ${env_file:+--env-file="$env_file"} server/index.ts) >"$work/server.log" 2>&1 &
started="$started $!"
tries=0
until curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$port/healthz" || [ "$tries" -ge 50 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
with_invite() { # curl arguments. The invite goes in over stdin, so it's never in a process list.
  curl -sS -K - "$@" <<CURL
header = "Authorization: Bearer $invite"
CURL
}
none=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/rules" || true)
with=$(with_invite -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/rules" || true)
if [ "$none" = 401 ]; then pass "with no invite, it answers 401"; else fail "with no invite, it answers $none"; fi
if [ "$with" = 200 ]; then pass "with the invite, it answers 200"; else fail "with the invite, it answers $with"; fi
# With no Coinbase key on the host, which is what Buy says until there is one.
if [ -z "$env_file" ]; then
  buy=$(with_invite -o "$work/buy" -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"address":"0x000000000000000000000000000000000000dEaD","asset":"ETH","cryptoAmount":"0.001"}' "http://127.0.0.1:$port/api/onramp/checkout" || true)
  if [ "$buy" = 503 ] && grep -q "Buying isn't set up on this server" "$work/buy"; then pass "Buy without a Coinbase key says: Buying isn't set up on this server."; else fail "Buy without a key answered $buy: $(cat "$work/buy")"; fi
fi

# Through something that writes down what the app asks for, because that's what proves the sandboxed copy got out.
proxy=$(free_port)
node -e '
const http = require("node:http"), fs = require("node:fs")
const [log, target, port] = process.argv.slice(1)
http.createServer((req, res) => {
  const forward = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, answer => {
    fs.appendFileSync(log, `${req.method} ${req.url.split("?")[0]} ${answer.statusCode}\n`)
    res.writeHead(answer.statusCode, answer.headers)
    answer.pipe(res)
  })
  forward.on("error", () => res.destroy())
  req.pipe(forward)
}).listen(port, "127.0.0.1")
' "$requests" "$port" "$proxy" &
started="$started $!"
sleep 0.5

echo "Launching the release app in the background:"
released="$work/release/$name.app"
browsers=$(sed -n 's/.*\/Library\/Application Support\/\(.*\)\/NativeMessagingHosts<\/string>.*/\1/p' "$here/Config/Hosted.entitlements")
snapshot() {
  printf '%s\n' "$browsers" | while IFS= read -r browser; do
    file="$support/$browser/NativeMessagingHosts/com.benface.patina.json"
    [ -f "$file" ] && printf '%s %s\n' "$(shasum -a 256 "$file" | cut -d ' ' -f 1)" "$browser" || printf 'none %s\n' "$browser"
  done
}
snapshot >"$work/manifests-before"
new_manifests=$(sed -n 's/^none //p' "$work/manifests-before" | while IFS= read -r browser; do if [ -d "$support/$browser" ]; then printf '%s\n' "$support/$browser/NativeMessagingHosts/com.benface.patina.json"; fi; done)
new_folders=$(sed -n 's/^none //p' "$work/manifests-before" | while IFS= read -r browser; do if [ -d "$support/$browser" ] && [ ! -d "$support/$browser/NativeMessagingHosts" ]; then printf '%s\n' "$support/$browser/NativeMessagingHosts"; fi; done)

# A sandboxed app's saved data goes by its bundle ID wherever it's launched from, and the Keychain groups it can reach by what it's signed with. What's left
# is what the app's own sandbox needs, without the paths of any browser that already has a manifest. The sandbox stops that write, whoever wrote the manifest.
launchable "$app" "$released"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $test_id" "$released/Contents/Info.plist"
rm -f "$released/Contents/embedded.provisionprofile"
/usr/bin/python3 -I - "$work/entitlements.plist" "$work/manifests-before" "$work/release-entitlements.plist" <<'PYTHON'
import plistlib, sys
have = plistlib.load(open(sys.argv[1], "rb"))
exception = "com.apple.security.temporary-exception.files.home-relative-path.read-write"
keep = {"com.apple.security.app-sandbox", "com.apple.security.device.camera", "com.apple.security.files.user-selected.read-write", "com.apple.security.network.client", "com.apple.security.network.server"}
theirs = [line.split(" ", 1)[1] for line in open(sys.argv[2]).read().splitlines() if not line.startswith("none ")]
out = {key: value for key, value in have.items() if key in keep}
out[exception] = [path for path in have.get(exception, []) if not any(path.startswith(f"/Library/Application Support/{browser}/NativeMessagingHosts") for browser in theirs)]
plistlib.dump(out, open(sys.argv[3], "wb"))
PYTHON
sign_with "$released" "$work/release-entitlements.plist"

# From what macOS will actually read, since a mistake above must never launch something that can reach a wallet.
codesign -d --entitlements - --xml "$released" 2>/dev/null >"$work/release-signed.plist"
isolation=$(/usr/bin/python3 -I - "$work/release-signed.plist" "$work/manifests-before" "$released/Contents/Info.plist" "$test_id" <<'PYTHON'
import plistlib, sys
have = plistlib.load(open(sys.argv[1], "rb"))
exception = "com.apple.security.temporary-exception.files.home-relative-path.read-write"
theirs = [line.split(" ", 1)[1] for line in open(sys.argv[2]).read().splitlines() if not line.startswith("none ")]
if plistlib.load(open(sys.argv[3], "rb")).get("CFBundleIdentifier") != sys.argv[4]: print("its bundle ID isn't the test ID")
if have.get("com.apple.security.app-sandbox") is not True: print("it isn't sandboxed")
for key in ("keychain-access-groups", "com.apple.security.application-groups", "com.apple.application-identifier", "com.apple.developer.team-identifier"):
    if key in have: print("it still has " + key)
for path in have.get(exception, []):
    if any(path.startswith(f"/Library/Application Support/{browser}/NativeMessagingHosts") for browser in theirs): print("it can still write " + path)
PYTHON
) || isolation="couldn't read how it's signed"
[ ! -e "$released/Contents/embedded.provisionprofile" ] || isolation="$isolation it still has a provisioning profile"
codesign -dv "$released" 2>&1 | grep -qx "Identifier=$test_id" || isolation="$isolation it isn't signed as the test ID"
if [ -n "$isolation" ]; then
  echo "Not launching the release app, because it could reach an installed copy's wallet or manifests: $isolation" >&2
  exit 1
fi
pass "it can't reach an installed copy's key, settings, records or socket, or a manifest that's already there"

front_app() { lsappinfo info -only bundleID "$(lsappinfo front)" | sed -n 's/.*bundleID="\([^"]*\)".*/\1/p'; }
front=$(front_app)
open -g -j -n "$released" --args -serverURL "http://127.0.0.1:$proxy" -launchesQuietly YES
tries=0
until grep -q 'GET /api/rules 401' "$requests" || [ "$tries" -ge 100 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
if grep -q 'GET /api/rules 401' "$requests"; then pass "launched, reached the server, and got the 401 that opens the invite prompt"; else fail "never asked the server: $(cat "$requests")"; fi
if pgrep -f "$released/Contents/MacOS/$name" >/dev/null; then pass "still running"; else fail "it quit"; fi
after=$(front_app)
if [ "$after" = "$test_id" ]; then fail "it took focus from $front"; else pass "left focus alone"; fi
if lsappinfo info -only bundleID "$(lsappinfo find bundleID="$test_id" | head -n 1)" 2>/dev/null | grep -qF "\"$test_id\""; then pass "macOS is running it as the test ID, $test_id"; else fail "macOS isn't running it as $test_id"; fi

sleep 1
snapshot >"$work/manifests-after"
theirs=$(grep -v '^none ' "$work/manifests-before" || true)
if [ -n "$theirs" ]; then
  if printf '%s\n' "$theirs" | while IFS= read -r line; do grep -qxF "$line" "$work/manifests-after" || exit 1; done; then pass "left every manifest that was already there exactly as it was, whichever build wrote it"; else fail "changed a manifest that was already there"; fi
fi
if [ -n "$new_manifests" ]; then
  if printf '%s\n' "$new_manifests" | while IFS= read -r file; do
    /usr/bin/python3 -I -c 'import json,sys;m=json.load(open(sys.argv[1]));assert m["path"]==sys.argv[2];assert m["allowed_origins"]==["chrome-extension://bidkgdhmaoccbkcccmijbppcfeicbllh/"]' "$file" "$released/Contents/Helpers/pricetag-bridge" 2>/dev/null || exit 1
  done; then pass "told the browsers with no host manifest yet where its host is, from inside the sandbox ($(printf '%s\n' "$new_manifests" | wc -l | tr -d ' '))"; else fail "a browser's manifest is missing or wrong"; fi
else
  echo "  note: every browser here already has a manifest, so writing a new one wasn't exercised"
fi
kill "$(pgrep -f "$released/Contents/MacOS/$name" | head -n 1)" 2>/dev/null || true

if [ -n "$env_file" ]; then
  echo "A first read and a question, with real data, through that server:"
  # A public address nobody holds real funds in, since its key is well known. This only reads what's public.
  wallet=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  body='{"method":"fifo","currency":"USD","linked":[],"book":{}}'
  read=$(with_invite -m 240 -o "$work/portfolio" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$body" "http://127.0.0.1:$port/api/portfolio/$wallet" || true)
  if [ "$read" = 200 ]; then pass "a wallet's first read, with the invite"; else fail "a wallet's first read answered $read: $(head -c 300 "$work/portfolio")"; fi
  asked=$(with_invite -m 240 -o "$work/explain" -w '%{http_code}' -X POST -H 'content-type: application/json' --data "$body" "http://127.0.0.1:$port/api/portfolio/demo/explain?metric=value" || true)
  if [ "$asked" = 200 ]; then pass "a question about a number, with the invite"; else fail "a question answered $asked: $(head -c 300 "$work/explain")"; fi
fi

echo "A debug copy signed the same way, with the real Keychain and a local fork:"
"$here/hosted.sh" --debug
debugged="$work/debug/$name.app"
launchable "$here/build/hosted/debug/$name.app" "$debugged"
codesign -d --entitlements - --xml "$here/build/hosted/debug/$name.app" 2>/dev/null >"$work/debug-entitlements.plist"
sign_with "$debugged" "$work/debug-entitlements.plist"
debug_binary="$debugged/Contents/MacOS/$name"
debug_id=$(sed -n 's/^APP_DEBUG_BUNDLE_ID = //p' "$here/Config/Hosted.xcconfig")
if "$debug_binary" --hot-wallet-self-test >"$work/self-test" 2>&1 && grep -q "KEYCHAIN SELF TEST PASSED" "$work/self-test" && grep -q "Accessible: cku. Synchronizable: false." "$work/self-test"; then
  pass "made a key in the Secure Enclave and device-only Keychain, signed with it, and deleted it"
else
  fail "the Keychain self test: $(cat "$work/self-test")"
fi

command -v anvil >/dev/null || { echo "This needs Foundry's anvil: https://getfoundry.sh" >&2; exit 1; }
rpc_port=$(free_port)
anvil --fork-url "$fork_url" --port "$rpc_port" --silent >"$work/anvil.log" 2>&1 &
started="$started $!"
rpc="http://127.0.0.1:$rpc_port"
call() { # method, params as JSON
  curl -fs -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$rpc"
}
tries=0
until call eth_chainId '[]' >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || { echo "anvil didn't start" >&2; exit 1; }
  sleep 0.3
done
balance() { call eth_getBalance "[\"$1\",\"latest\"]" | /usr/bin/python3 -I -c 'import json,sys;print(int(json.load(sys.stdin)["result"],16))'; }

"$debug_binary" --isolated hosted-test --reset-isolated-wallet >/dev/null
savings=0x000000000000000000000000000000000000dEaD
log="$work/debug.log"
open -g -j -n --stderr "$log" --stdout "$log" "$debugged" --args --quiet --isolated hosted-test --create-wallet --rpc "$rpc" --add-cold "$savings" --cap 25 --print-address -serverURL "http://127.0.0.1:$port"
tries=0
until grep -q '^ADDRESS 0x' "$log" 2>/dev/null || [ "$tries" -ge 100 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
address=$(sed -n 's/^ADDRESS //p' "$log" | head -n 1)
case $address in
  0x*)
    pass "a new wallet, from the app's own create call"
    before=$(balance "$savings")
    # 1 ETH on the fork, far above the cap.
    call anvil_setBalance "[\"$address\",\"0xde0b6b3a7640000\"]" >/dev/null
    tries=0
    until [ "$(balance "$savings")" != "$before" ] || [ "$tries" -ge 90 ]; do
      call evm_mine '[]' >/dev/null || true
      sleep 2
      tries=$((tries + 1))
    done
    if [ "$(balance "$savings")" != "$before" ]; then pass "swept what's above the cap to savings, signed from the real Keychain"; else fail "no sweep landed in 3 minutes: $(tail -n 5 "$log")"; fi
    ;;
  *) fail "the app didn't make a wallet: $(cat "$log")" ;;
esac
pid=$(sed -n 's/^PID //p' "$log" | head -n 1)
[ -z "$pid" ] || kill "$pid" 2>/dev/null || true

# That wallet stands in for an installed copy's: a real key in the hosted build's own Keychain group, and a sandbox folder that isn't the release launch's.
# A program signed the way that launch was asks for both. It asks only whether they're there, and never for what's in them.
cat >"$work/probe.swift" <<'SWIFT'
import Foundation
import Security

func status(_ query: [String: Any]) -> OSStatus {
    var result: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &result)
}
let arguments = CommandLine.arguments
let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecUseDataProtectionKeychain as String: true, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll, kSecAttrService as String: arguments[1]]
var inGroup = base
inGroup[kSecAttrAccessGroup as String] = arguments[2]
print("by-service", status(base))
print("in-group", status(inGroup))
print("sandbox", opendir(arguments[3]) == nil ? errno : 0)
SWIFT
probe="$work/probe.app"
mkdir -p "$probe/Contents/MacOS"
swiftc -O -o "$probe/Contents/MacOS/probe" "$work/probe.swift"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $probe_id" -c "Add :CFBundleExecutable string probe" -c "Add :CFBundlePackageType string APPL" "$probe/Contents/Info.plist" >/dev/null
sign_with "$probe" "$work/release-entitlements.plist"
"$probe/Contents/MacOS/probe" com.benface.pricetag.hot-wallet.isolated.hosted-test "$team.com.benface.pricetag.hosted.hotwallet" "$HOME/Library/Containers/${debug_id:-$bundle_id}/Data" >"$work/probe.out" 2>&1 || true
# -34018 is errSecMissingEntitlement, the Keychain refusing. Asked without naming a group, it only searches groups this has, of which there are none, so
# -25300, errSecItemNotFound, is the same answer. 1 is EPERM, the sandbox refusing.
answer=$(sed -n 's/^by-service //p' "$work/probe.out")
if [ "$answer" = -34018 ] || [ "$answer" = -25300 ]; then pass "signed like the release launch, it can't find an existing wallet's key by name ($answer)"; else fail "asking for an existing wallet's key answered ${answer:-nothing}: $(cat "$work/probe.out")"; fi
answer=$(sed -n 's/^in-group //p' "$work/probe.out")
if [ "$answer" = -34018 ]; then pass "or in the hosted build's Keychain group ($answer)"; else fail "asking in the hosted build's group answered ${answer:-nothing}: $(cat "$work/probe.out")"; fi
answer=$(sed -n 's/^sandbox //p' "$work/probe.out")
if [ "$answer" = 1 ]; then pass "or open another copy's sandbox folder ($answer)"; else fail "opening another copy's sandbox folder answered ${answer:-nothing}: $(cat "$work/probe.out")"; fi

# Signed like the release app, so this is what shows its sandbox lets the listener start. The page's flows are pnpm check:device-pages.
"$debug_binary" --isolated hosted-test --reset-isolated-wallet >/dev/null
pages_log="$work/pages.log"
open -g -j -n --stderr "$pages_log" --stdout "$pages_log" "$debugged" --args --quiet --isolated hosted-test --print-device-page
tries=0
until grep -q '^DEVICE_PAGE ' "$pages_log" 2>/dev/null || [ "$tries" -ge 100 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
page=$(sed -n 's/^DEVICE_PAGE //p' "$pages_log" | head -n 1)
case $page in
  http://127.0.0.1:*)
    if curl -fs -o /dev/null --max-time 5 "$page"; then pass "serves a hardware wallet page from inside its sandbox, on 127.0.0.1"; else fail "its page at $page didn't answer"; fi
    ;;
  *) fail "no hardware wallet page: $(cat "$pages_log")" ;;
esac
pid=$(sed -n 's/^PID //p' "$pages_log" | head -n 1)
[ -z "$pid" ] || kill "$pid" 2>/dev/null || true

if PATINA_TEST_APP="$debugged" "$here/extension-test.sh" >"$work/extension" 2>&1; then pass "a real site's transaction through the extension, its host and the socket"; else cat "$work/extension" >&2; fail "the extension's test"; fi

echo "Against the same server, the invite over a stand-in for HTTPS:"
if PATINA_TEST_SERVER="http://127.0.0.1:$port" PATINA_TEST_INVITE="$invite" "$here/swift-queue.sh" swift test --package-path "$here/PricetagKit" --scratch-path "$here/.build" --filter HostedServerTests >"$work/tests" 2>&1; then pass "HostedServerTests, with the real server"; else cat "$work/tests" >&2; fail "HostedServerTests"; fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed." >&2
  exit 1
fi
echo "All passed."
