#!/bin/sh
# Xcode's build phase: puts the pages device-pages.sh built in the app, where its signature covers them. A build with none still works with a server on this Mac.
set -eu

pages="$SRCROOT/build/device-pages"
into="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/DevicePages"

rm -rf "$into"
if [ -f "$pages/device.html" ]; then
  ditto "$pages" "$into"
elif [ "${REQUIRE_DEVICE_PAGES:-NO}" = YES ]; then
  echo "error: This build needs the device pages. Run macos/device-pages.sh first." >&2
  exit 1
fi
