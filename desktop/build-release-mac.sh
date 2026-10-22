#!/usr/bin/env bash
# 产出 macOS 发布件：
#   1) 网页收藏-macos-x64.zip —— 顶层就是 网页收藏.app（自动更新下载后直接解压替换）
#   2) WebVault-macos-x64.dmg —— 给人下载：双击拖到 Applications 即用
#      注意：dmg/zip 的**文件名必须全 ASCII**。GitHub Releases 上传时会把非 ASCII
#      字符整段剥掉（"网页收藏-macos-x64.dmg" 变成 "-macos-x64.dmg"，且以 - 开头还会
#      被 gh CLI 当成命令行参数，只能用 REST API 删）。app 包内部名保持中文没问题。
# 依赖 build-app.sh 先构建出 dist/网页收藏.app
set -e

ROOT=/Users/lovezjkxlove/WorkBuddy/2026-10-22-13-27-54/pagevault
DESKTOP=$ROOT/desktop
APP=$DESKTOP/dist/网页收藏.app
ZIP=$DESKTOP/dist/pagevault-macos-x64.zip
DMG=$DESKTOP/dist/WebVault-macos-x64.dmg

[ -d "$APP" ] || { echo "先跑 build-app.sh 生成 .app"; exit 1; }

# 1. zip（自动更新用）：顶层直接是 .app
#    必须用 Python 打：macOS 自带 zip 命令会把中文名写成非 UTF-8 字节且不打标志位，
#    Windows 资源管理器/部分解压工具会得到乱码文件名（Windows 端踩过同样的坑）。
rm -f "$ZIP"
/Users/lovezjkxlove/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - "$APP" "$ZIP" <<'PYEOF'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(src))  # dist/ 目录：zip 内条目相对它 → 顶层是 网页收藏.app/
count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort(); files.sort()
        rel = os.path.relpath(root, base)
        if rel != '.':
            zi = zipfile.ZipInfo(rel + '/')
            zi.create_system = 3
            zi.external_attr = (0o40755 << 16) | 0x10
            z.writestr(zi, '')
            count += 1
        for name in files:
            full = os.path.join(root, name)
            relf = os.path.relpath(full, base)
            if os.path.islink(full):
                zi = zipfile.ZipInfo(relf)
                zi.create_system = 3
                zi.external_attr = (0o120777 << 16)
                z.writestr(zi, os.readlink(full))
            else:
                z.write(full, relf)
            count += 1
print('zip entries:', count, 'size MB:', round(os.path.getsize(out)/1048576, 1))
PYEOF

# 2. dmg（人用）： staging 里放 .app + Applications 快捷方式
#    用 rsync 而非 cp：沙箱文件 broker 会拦截 cp/rename default_app.asar
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a "$APP/" "$STAGE/网页收藏.app/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "网页收藏" -srcfolder "$STAGE" -ov -format UDZO "$DMG" -quiet

ls -la "$ZIP" "$DMG"
echo ""
echo "zip: $ZIP"
echo "dmg: $DMG"
