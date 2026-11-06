#!/bin/sh
# `pnpm check:watch-only`: tests a built watch-only .dmg: that it has no way to hold a key, from its entitlements and its symbols, that the
# Keychain is closed to what it's signed with, and that it launches from a clean folder and reads a server. It never opens a window or takes
# focus. It only ever asks the Keychain whether an item's there. All it leaves behind is the sandbox folder macOS makes for this build.
#
# Usage: watch-only-test.sh [path to the .dmg]. With none, it builds a --local one first.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
bundle_id=$(sed -n 's/^APP_BUNDLE_ID = //p' "$here/Config/WatchOnly.xcconfig")
identity="Developer ID Application: Benface Inc. (R7TNNTC382)"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ $# -ge 1 ]; then
  dmg=$1
else
  "$here/watch-only.sh" --local
  dmg=$(ls -t "$here"/build/"$name"-*-watch-only-local-test.dmg | head -n 1)
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/patina-watch-only.XXXXXX")
mount="$work/mount"
started=
cleanup() {
  for pid in $started; do kill "$pid" 2>/dev/null || true; done
  pkill -f "$work/clean/$name.app/Contents/MacOS/" 2>/dev/null || true
  "$lsregister" -u "$work/clean/$name.app" 2>/dev/null || true
  hdiutil detach -quiet "$mount" 2>/dev/null || true
  rm -rf "$work"
  # macOS guards a sandbox's folder, so this may not be allowed. It's only this build's, and holds no invite or wallet from this run.
  rm -rf "$HOME/Library/Containers/$bundle_id" 2>/dev/null || echo "macOS wouldn't let this remove $HOME/Library/Containers/$bundle_id, which is left over from launching it."
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

echo "From the .dmg, copied to a clean folder:"
mkdir -p "$mount" "$work/clean"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$dmg"
ditto "$mount/$name.app" "$work/clean/$name.app"
app="$work/clean/$name.app"
binary="$app/Contents/MacOS/$name"
info="$app/Contents/Info.plist"
read_info() { /usr/libexec/PlistBuddy -c "Print :$1" "$info" 2>/dev/null; }

echo "Signature:"
check "the .dmg's signature holds" codesign --verify --strict "$dmg"
check "the app's signature holds" codesign --verify --deep --strict "$app"
codesign -dvvv "$app" 2>"$work/signature" || true
if grep -q "^Authority=Developer ID Application: Benface Inc. (R7TNNTC382)" "$work/signature"; then pass "signed with Developer ID for R7TNNTC382"; else fail "not signed with Developer ID for R7TNNTC382"; fi
if grep -q "flags=.*runtime" "$work/signature"; then pass "hardened runtime"; else fail "no hardened runtime"; fi
if grep -q "^Timestamp=" "$work/signature"; then pass "secure timestamp"; else fail "no secure timestamp"; fi
if [ "$(read_info CFBundleIdentifier)" = "$bundle_id" ]; then pass "its own bundle ID, $bundle_id"; else fail "bundle ID is $(read_info CFBundleIdentifier)"; fi
served=$(read_info PatinaServerHost || true)
case $dmg in
  *-local-test.dmg) if [ -z "$served" ]; then pass "reads this Mac's server, as a local test copy should"; else fail "a local test copy reads $served"; fi ;;
  *) if [ "$served" = "$(sed -n 's/^PATINA_HOSTED_SERVER_HOST = *//p' "$here/Config/App.xcconfig")" ] && [ -n "$served" ]; then pass "reads the hosted server, $served"; else fail "reads \"$served\", not the hosted server"; fi ;;
esac
if [ "$(read_info LSMinimumSystemVersion)" = 27.0 ]; then pass "needs macOS 27.0"; else fail "minimum macOS is $(read_info LSMinimumSystemVersion)"; fi

echo "What it's allowed to do:"
codesign -d --entitlements - --xml "$app" 2>/dev/null >"$work/entitlements.plist"
keys=$(/usr/bin/plutil -convert json -o - "$work/entitlements.plist" | /usr/bin/python3 -c 'import json, sys; print(" ".join(sorted(json.load(sys.stdin))))')
expected="com.apple.security.app-sandbox com.apple.security.files.user-selected.read-write com.apple.security.network.client"
if [ "$keys" = "$expected" ]; then pass "entitlements are exactly: $keys"; else fail "entitlements are: $keys"; fi
if [ -e "$app/Contents/embedded.provisionprofile" ]; then fail "has a provisioning profile"; else pass "no provisioning profile, so it can't be given Keychain access"; fi
if find "$app" -name pricetag-bridge | grep -q .; then fail "has the extension's host"; else pass "no extension host"; fi
if read_info CFBundleURLTypes >/dev/null; then fail "registers a URL scheme"; else pass "registers no URL scheme"; fi
if read_info NSCameraUsageDescription | grep -q .; then fail "asks for the camera"; else pass "doesn't ask for the camera"; fi

echo "What's in the binary:"
nm -u "$binary" >"$work/imports" 2>/dev/null
nm "$binary" >"$work/symbols" 2>/dev/null || true
for symbol in _SecRandomCopyBytes _SecItemAdd _SecItemCopyMatching _SecItemDelete _SecItemUpdate _SecKeyCreateRandomKey _SecKeyCreateSignature _SecAccessControlCreateWithFlags; do
  if grep -qx "$symbol" "$work/imports"; then fail "imports $symbol"; else pass "no $symbol"; fi
done
if grep -q secp256k1_ "$work/symbols"; then fail "has libsecp256k1 in it"; else pass "no libsecp256k1"; fi
if grep -q SecureEnclave "$work/imports"; then fail "uses the Secure Enclave"; else pass "doesn't use the Secure Enclave"; fi
for text in com.benface.pricetag.hot-wallet com.benface.pricetag.hotwallet patina.hot-wallet.v1; do
  if strings -a "$binary" | grep -qF "$text"; then fail "still names $text"; else pass "doesn't name $text"; fi
done
if "$here/swift-queue.sh" swift test --package-path "$here/HotWalletKit" --scratch-path "$here/.build" --filter WatchOnlyTests >"$work/tests" 2>&1; then pass "WatchOnlyTests"; else cat "$work/tests" >&2; fail "WatchOnlyTests"; fi

echo "The Keychain, from a program signed the same way:"
cat >"$work/probe.swift" <<'SWIFT'
import Foundation
import Security

// Asks only whether an item's there, and never for its contents. What matters is the answer: errSecMissingEntitlement means the Keychain refused.
func status(_ query: [String: Any]) -> OSStatus {
    var result: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &result)
}
let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecUseDataProtectionKeychain as String: true, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
var named = base
named[kSecAttrService as String] = "com.benface.pricetag.hot-wallet"
var inGroup = named
inGroup[kSecAttrAccessGroup as String] = "R7TNNTC382.com.benface.pricetag.hotwallet"
print("read-normal-build-keys", status(named))
print("read-normal-build-group", status(inGroup))
// A made-up name, removed right after in case it ever works.
let service = "com.benface.pricetag.watch-only-probe"
let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecUseDataProtectionKeychain as String: true, kSecAttrService as String: service, kSecAttrAccount as String: "probe", kSecValueData as String: Data([0])]
let added = SecItemAdd(add as CFDictionary, nil)
print("add-a-new-item", added)
if added == errSecSuccess { SecItemDelete(add as CFDictionary) }
SWIFT
# A sandboxed program has to be in a bundle, or macOS stops it as it starts.
probe="$work/probe.app"
mkdir -p "$probe/Contents/MacOS"
swiftc -O -o "$probe/Contents/MacOS/probe" "$work/probe.swift"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $bundle_id" -c "Add :CFBundleExecutable string probe" -c "Add :CFBundlePackageType string APPL" "$probe/Contents/Info.plist" >/dev/null
codesign --force --options runtime --timestamp --entitlements "$here/Config/WatchOnly.entitlements" --sign "$identity" "$probe" 2>/dev/null
"$probe/Contents/MacOS/probe" >"$work/probe.out" 2>&1 || true
# -34018 is errSecMissingEntitlement, the Keychain refusing. Asked without naming a group, it only searches groups this program has, of which there are none,
# so -25300, errSecItemNotFound, is the same answer: whatever the normal build keeps there, this can't see it.
answer=$(sed -n 's/^read-normal-build-keys //p' "$work/probe.out")
if [ "$answer" = -34018 ] || [ "$answer" = -25300 ]; then pass "asking for the normal build's keys by service finds nothing ($answer)"; else fail "asking for the normal build's keys answered ${answer:-nothing}: $(cat "$work/probe.out")"; fi
for question in read-normal-build-group add-a-new-item; do
  answer=$(sed -n "s/^$question //p" "$work/probe.out")
  if [ "$answer" = -34018 ]; then pass "$question refused with errSecMissingEntitlement"; else fail "$question answered ${answer:-nothing}: $(cat "$work/probe.out")"; fi
done

echo "Launching it, in the background, against a local server in hosted mode:"
invite=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')
hash=$(printf '%s' "$invite" | shasum -a 256 | cut -d ' ' -f 1)
free_port() { node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port=$(free_port)
log="$work/requests"
: >"$log"
(cd "$repo" && PRICETAG_HOSTED=1 PRICETAG_INVITES="test:$hash" PRICETAG_CLIENT_IP_HEADER=x-test-client HOST=127.0.0.1 PORT=$port exec node server/index.ts) >"$work/server.log" 2>&1 &
started="$started $!"
tries=0
until curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$port/healthz" || [ "$tries" -ge 50 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
none=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/rules")
with=$(curl -s -o /dev/null -w '%{http_code}' -K - "http://127.0.0.1:$port/api/rules" <<CURL
header = "Authorization: Bearer $invite"
CURL
)
if [ "$none" = 401 ]; then pass "with no invite, the server answers 401"; else fail "with no invite, the server answers $none"; fi
if [ "$with" = 200 ]; then pass "with the invite, the server answers 200"; else fail "with the invite, the server answers $with"; fi

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
' "$log" "$port" "$proxy" &
started="$started $!"
sleep 0.5

front_app() { lsappinfo info -only bundleID "$(lsappinfo front)" | sed -n 's/.*bundleID="\([^"]*\)".*/\1/p'; }
front=$(front_app)
open -g -j -n "$app" --args -serverURL "http://127.0.0.1:$proxy" -launchesQuietly YES
tries=0
until grep -q 'GET /api/rules 401' "$log" || [ "$tries" -ge 100 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
if grep -q 'GET /api/rules 401' "$log"; then pass "launched from a clean folder, reached the server, and got the 401 that opens the invite prompt"; else fail "never asked the server: $(cat "$log")"; fi
if pgrep -f "$binary" >/dev/null; then pass "still running"; else fail "it quit"; fi
after=$(front_app)
if [ "$after" = "$bundle_id" ]; then fail "it took focus from $front"; else pass "left focus alone: ${after:-nothing} is in front, and ${front:-nothing} was before"; fi

echo "Against the same server, the invite over a stand-in for HTTPS:"
if PATINA_TEST_SERVER="http://127.0.0.1:$port" PATINA_TEST_INVITE="$invite" "$here/swift-queue.sh" swift test --package-path "$here/PricetagKit" --scratch-path "$here/.build" --filter HostedServerTests >"$work/tests" 2>&1; then pass "HostedServerTests, with the real server"; else cat "$work/tests" >&2; fail "HostedServerTests"; fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed." >&2
  exit 1
fi
echo "All passed."
