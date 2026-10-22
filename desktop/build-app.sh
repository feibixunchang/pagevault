#!/usr/bin/env bash
# Build PageVault.app manually.
# Uses rsync (not cp -R) because the sandbox file broker intermittently blocks
# copying/removing default_app.asar. After assembly the bundle is ad-hoc signed —
# required on Apple Silicon, otherwise macOS flags the app as damaged/malware.
set -e

ROOT=/Users/lovezjkxlove/WorkBuddy/2026-10-22-13-27-54/pagevault
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server
SRC_ELECTRON=$DESKTOP/node_modules/electron/dist/Electron.app
OUT=$DESKTOP/dist/网页收藏.app

mkdir -p "$DESKTOP/dist"

# 1. Sync the vanilla Electron bundle (binary + frameworks + helpers).
#    IMPORTANT: keep default_app.asar — Electron's bootstrap uses it to locate and
#    load Contents/Resources/app. Removing it makes the binary fall back to a Node REPL.
rsync -a --delete "$SRC_ELECTRON/" "$OUT/"

# 2. Rename the executable to 网页收藏
cp "$OUT/Contents/MacOS/Electron" "$OUT/Contents/MacOS/网页收藏"
rm -f "$OUT/Contents/MacOS/Electron"
chmod +x "$OUT/Contents/MacOS/网页收藏"

# 3. Replace Info.plist
cp "$DESKTOP/Info.plist" "$OUT/Contents/Info.plist"

# 4. Install our app entry (main.js + package.json)
mkdir -p "$OUT/Contents/Resources/app"
cp "$DESKTOP/main.js" "$OUT/Contents/Resources/app/main.js"
cp "$DESKTOP/package.json" "$OUT/Contents/Resources/app/package.json"

# 4b. Install our own icon (AppIcon.icns) and drop Electron's default one
cp "$DESKTOP/AppIcon.icns" "$OUT/Contents/Resources/AppIcon.icns"
rm -f "$OUT/Contents/Resources/electron.icns"

# 5. Bundle the sync server (extra resource)
rsync -a --delete "$SERVER/" "$OUT/Contents/Resources/server/"

# 6. Ad-hoc sign (mandatory on Apple Silicon after modifying the bundle)
codesign --force --deep --sign - "$OUT" 2>&1 | tail -3 || true
codesign --verify --deep --strict "$OUT" && echo "SIGN OK"

echo "Built: $OUT"
