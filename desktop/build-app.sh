#!/usr/bin/env bash
# Build PageVault.app manually.
# Uses rsync (not cp -R) because the sandbox file broker intermittently blocks
# copying/removing default_app.asar. After assembly the bundle is ad-hoc signed —
# required on Apple Silicon, otherwise macOS flags the app as damaged/malware.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server
SRC_ELECTRON=$DESKTOP/node_modules/electron/dist/Electron.app
OUT=$DESKTOP/dist/网页收藏.app

# 0. 版本号单一来源：desktop/package.json → server/server.js、server/package.json、
#    extension/manifest.json（避免各端版本号错位导致更新判断失效）
node "$ROOT/scripts/stamp-version.js"

mkdir -p "$DESKTOP/dist"

# 1. Sync the vanilla Electron bundle (binary + frameworks + helpers).
#    IMPORTANT: keep default_app.asar — Electron's bootstrap uses it to locate and
#    load Contents/Resources/app. Removing it makes the binary fall back to a Node REPL.
rsync -a --delete "$SRC_ELECTRON/" "$OUT/"

# 2. Rename the executable to 网页收藏
cp "$OUT/Contents/MacOS/Electron" "$OUT/Contents/MacOS/网页收藏"
rm -f "$OUT/Contents/MacOS/Electron"
chmod +x "$OUT/Contents/MacOS/网页收藏"

# 3. Replace Info.plist（并把版本号写进去：访达「显示简介」/ 系统关于本机读的都是它）
cp "$DESKTOP/Info.plist" "$OUT/Contents/Info.plist"
APP_VER=$(node -p "require('$DESKTOP/package.json').version")
for KEY in CFBundleShortVersionString CFBundleVersion; do
  /usr/libexec/PlistBuddy -c "Set :$KEY $APP_VER" "$OUT/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$KEY string $APP_VER" "$OUT/Contents/Info.plist"
done

# 4. Install our app entry (main.js + package.json + updater/preload)
mkdir -p "$OUT/Contents/Resources/app"
cp "$DESKTOP/main.js" "$OUT/Contents/Resources/app/main.js"
cp "$DESKTOP/updater.js" "$OUT/Contents/Resources/app/updater.js"
cp "$DESKTOP/preload.js" "$OUT/Contents/Resources/app/preload.js"
cp "$DESKTOP/package.json" "$OUT/Contents/Resources/app/package.json"

# 4b. Install our own icon (AppIcon.icns) and drop Electron's default one
cp "$DESKTOP/AppIcon.icns" "$OUT/Contents/Resources/AppIcon.icns"
rm -f "$OUT/Contents/Resources/electron.icns"

# 5. Bundle the sync server (extra resource; exclude runtime data/)
rsync -a --delete --exclude=data "$SERVER/" "$OUT/Contents/Resources/server/"

# 5b. Bundle the browser extension (menu "安装浏览器扩展…" 定位到这里；
#     阅读器安装指引里显示的扩展路径也是它)
rsync -a --delete --exclude='.DS_Store' "$ROOT/extension/" "$OUT/Contents/Resources/extension/"

# 6. Ad-hoc sign (mandatory on Apple Silicon after modifying the bundle)
codesign --force --deep --sign - "$OUT" 2>&1 | tail -3 || true
codesign --verify --deep --strict "$OUT" && echo "SIGN OK"

echo "Built: $OUT"
