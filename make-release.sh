#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="JSON Studio"
BUNDLE_ID="com.zhipeng.jsonstudio"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" Info.plist)
DIST="dist"
ZIP="${DIST}/JSONStudio-${VERSION}-macOS.zip"
RELEASE_NAME="JSON Studio ${VERSION}"

echo "==> Building app"
./build.sh

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/jsonstudio-release.XXXXXX")
VERIFY=$(mktemp -d "${TMPDIR:-/tmp}/jsonstudio-verify.XXXXXX")
cleanup() { rm -rf "$STAGE" "$VERIFY"; }
trap cleanup EXIT

RELEASE="$STAGE/$RELEASE_NAME"
mkdir -p "$RELEASE/docs/images" "$RELEASE/examples"

echo "==> Preparing a clean signed app outside the workspace"
ditto --norsrc --noextattr "build/${APP_NAME}.app" "$RELEASE/${APP_NAME}.app"
xattr -cr "$RELEASE/${APP_NAME}.app" 2>/dev/null || true
codesign --force --deep --sign - --strip-disallowed-xattrs \
    --identifier "$BUNDLE_ID" "$RELEASE/${APP_NAME}.app"
codesign --verify --deep --strict "$RELEASE/${APP_NAME}.app"

cp README.md README.zh.md LICENSE CHANGELOG.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md SUPPORT.md package.json "$RELEASE/"
cp docs/ARCHITECTURE.md "$RELEASE/docs/"
cp docs/images/format.png docs/images/compare.png "$RELEASE/docs/images/"
cp examples/README.md examples/compare-a.json examples/compare-b.json examples/escaped-payload.txt "$RELEASE/examples/"

mkdir -p "$DIST"
rm -f "$ZIP" "${ZIP}.sha256"

echo "==> Creating ZIP"
ditto -c -k --keepParent --norsrc --noextattr "$RELEASE" "$ZIP"
xattr -cr "$ZIP" 2>/dev/null || true

echo "==> Verifying archive contents"
ditto -x -k "$ZIP" "$VERIFY"
codesign --verify --deep --strict "$VERIFY/$RELEASE_NAME/${APP_NAME}.app"

shasum -a 256 "$ZIP" | tee "${ZIP}.sha256"

echo "==> Built ${ZIP}"
du -h "$ZIP"
