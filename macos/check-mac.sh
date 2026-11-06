#!/bin/sh
# `pnpm check:mac`: the queue's own tests, then the Swift tests, the app's build, and the shared packages' builds for iOS, as one turn in the Swift queue.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${SWIFT_QUEUE_TURN:-}" ]; then
  # Before its turn, because they use a queue of their own and compile nothing, so nobody has to wait behind them.
  (cd "$here/.." && pnpm --silent check:swift-queue) || {
    echo "[swift-queue] Its own tests didn't pass, so nothing was built. See above, or run pnpm check:swift-queue." >&2
    exit 1
  }
  exec "$here/swift-queue.sh" "$0" "$@"
fi

swift test --package-path "$here/PricetagKit"
swift test --package-path "$here/HotWalletKit"
"$here/run.sh" --build-only
(cd "$here/PricetagKit" && xcodebuild -quiet -scheme PricetagKit -destination 'generic/platform=iOS' -derivedDataPath ../build/ios build)
(cd "$here/HotWalletKit" && xcodebuild -quiet -scheme HotWalletKit -destination 'generic/platform=iOS' -derivedDataPath ../build/ios build)
