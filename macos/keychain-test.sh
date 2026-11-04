#!/bin/sh
# `pnpm check:keychain`: runs the Secure Enclave and device-only Keychain for real, from a signed debug build, which `swift test` can't do.
# It makes a throwaway key under its own Keychain service, signs with it and deletes it. It never touches a real hot wallet.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
CONFIGURATION=Debug "$here/run.sh" --build-only
"$here/build/Build/Products/Debug/$name.app/Contents/MacOS/$name" --hot-wallet-self-test
