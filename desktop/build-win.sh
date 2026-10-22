#!/usr/bin/env bash
# Build the Windows (win32-x64) edition of 网页收藏.
# Runs on macOS or Linux (cross-assembly is pure file ops — no wine needed).
# Produces: desktop/dist/网页收藏-win32-x64/  (+ a .zip for easy copying)
set -e

ROOT=/Users/lovezjkxlove/WorkBuddy/2026-10-22-13-27-54/pagevault
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server
WINBUILD=$DESKTOP/.win-build
ELECTRON_VER=31.7.7
ZIP=$WINBUILD/electron-v${ELECTRON_VER}-win32-x64.zip
UNPACK=$WINBUILD/electron-v${ELECTRON_VER}-win32-x64
OUT=$DESKTOP/dist/网页收藏-win32-x64

# 1. Fetch the Electron Windows runtime if not present (CN mirror, no auth)
if [ ! -d "$UNPACK" ]; then
  mkdir -p "$WINBUILD"
  [ -f "$ZIP" ] || curl -fL -o "$ZIP" \
    "https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-win32-x64.zip"
  rm -rf "$UNPACK"
  unzip -q -o "$ZIP" -d "$UNPACK"
fi
[ -f "$UNPACK/electron.exe" ] || { echo "ERROR: electron.exe not found in $UNPACK"; exit 1; }

# 2. Assemble our app on top of the vanilla runtime
rm -rf "$OUT"
mkdir -p "$OUT/resources/app"
cp "$UNPACK"/*.dll "$UNPACK"/*.pak "$OUT/" 2>/dev/null || true
cp "$UNPACK/electron.exe" "$OUT/网页收藏.exe"
# NOTE: rsync (not cp) for default_app.asar — the sandbox file broker intermittently
# blocks cp/rename of that file (same issue as the macOS build).
[ -f "$UNPACK/resources/default_app.asar" ] && rsync -a "$UNPACK/resources/default_app.asar" "$OUT/resources/"
[ -d "$UNPACK/locales" ] && cp -r "$UNPACK/locales" "$OUT/"
[ -f "$UNPACK/resources/electron.asar" ] && rsync -a "$UNPACK/resources/electron.asar" "$OUT/resources/"

# 3. Our app entry + bundled sync server + icon
cp "$DESKTOP/main.js" "$OUT/resources/app/main.js"
cp "$DESKTOP/package.json" "$OUT/resources/app/package.json"
rsync -a --delete --exclude=data "$SERVER/" "$OUT/resources/server/"
[ -f "$DESKTOP/AppIcon.ico" ] && cp "$DESKTOP/AppIcon.ico" "$OUT/AppIcon.ico"

# 4. Zip it up for transfer to a Windows machine
( cd "$DESKTOP/dist" && rm -f "网页收藏-win32-x64.zip" && zip -q -r "网页收藏-win32-x64.zip" "网页收藏-win32-x64" )

echo "Built: $OUT"
echo "Zip   : $DESKTOP/dist/网页收藏-win32-x64.zip"
echo ""
echo "Windows 使用说明："
echo "  1. 解压 zip 到任意目录（如 D:\\网页收藏）"
echo "  2. 双击 网页收藏.exe（未代码签名，SmartScreen 会提示「未知发布者」→"
echo "     「更多信息」→「仍要运行」）"
echo "  3. 数据默认存 %APPDATA%\\pagevault-desktop，端口 8731"
echo "  4. Chrome/Edge 加载 pagevault/extension 即可保存"
