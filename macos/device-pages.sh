#!/bin/sh
# Builds the hardware wallet page for a Mac app that reads a hosted server. Run this before a build that sets PATINA_SERVER_HOST, which should also
# set REQUIRE_DEVICE_PAGES=YES. `pnpm mac` reads the server it runs on this Mac, which has the page, so it doesn't need this.
set -eu

repo=$(dirname "$(cd "$(dirname "$0")" && pwd)")
cd "$repo"
pnpm install --frozen-lockfile
pnpm build:device-pages
