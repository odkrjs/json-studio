#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="JSON Studio"
APP="build/${APP_NAME}.app"
BUNDLE_ID="com.zhipeng.jsonstudio"

echo "==> Building ${APP_NAME}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mkdir -p build/module-cache

# Build a universal binary when the SDK supports both slices.
CLANG_MODULE_CACHE_PATH="$PWD/build/module-cache" clang \
  -fobjc-arc \
  -fblocks \
  -fmodules \
  -fmodules-cache-path="$PWD/build/module-cache" \
  -mmacosx-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  -Wno-deprecated-declarations \
  -framework Cocoa \
  -framework WebKit \
  -framework UniformTypeIdentifiers \
  Native/main.m \
  -o "$APP/Contents/MacOS/JSONStudio"

cp Info.plist "$APP/Contents/Info.plist"
cp Resources/index.html "$APP/Contents/Resources/index.html"
cp Resources/styles.css "$APP/Contents/Resources/styles.css"
cp Resources/core.js "$APP/Contents/Resources/core.js"
cp Resources/app.js "$APP/Contents/Resources/app.js"
cp Resources/assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

chmod +x "$APP/Contents/MacOS/JSONStudio"

# Strip Finder metadata / resource forks before ad-hoc signing. The workspace
# may live on a file provider, which can reattach FinderInfo to the bundle root.
xattr -cr "$APP" 2>/dev/null || true

codesign --force --deep --sign - --strip-disallowed-xattrs --identifier "$BUNDLE_ID" "$APP" 2>&1 | sed 's/^/    /'

echo "==> Built $APP"
echo "    $(lipo -archs "$APP/Contents/MacOS/JSONStudio")"
