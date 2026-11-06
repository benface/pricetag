#!/bin/sh
# `pnpm check:mac`: the Swift tests, the app's build, and the shared packages' builds for iOS, as one turn in the Swift queue.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
[ -n "${SWIFT_QUEUE_TURN:-}" ] || exec "$here/swift-queue.sh" "$0" "$@"

swift test --package-path "$here/PricetagKit"
swift test --package-path "$here/HotWalletKit"
"$here/run.sh" --build-only
(cd "$here/PricetagKit" && xcodebuild -quiet -scheme PricetagKit -destination 'generic/platform=iOS' -derivedDataPath ../build/ios build)
(cd "$here/HotWalletKit" && xcodebuild -quiet -scheme HotWalletKit -destination 'generic/platform=iOS' -derivedDataPath ../build/ios build)
