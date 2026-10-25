#!/usr/bin/env bash
# 产出 macOS 发布件（文件名一律带版本号，用户下载下来一眼能认出是哪个版本）：
#   1) WebVault-<版本>-macos-<arch>.zip —— 顶层就是 网页收藏.app（自动更新下载后直接解压替换）
#   2) WebVault-<版本>-macos-<arch>.dmg —— 给人下载：双击拖到 Applications 即用
#      <arch> 从**产物的真实二进制**读（lipo/file），不猜 uname —— 在 M 系列机器上
#      之前一律写成 x64，实际是 arm64，Intel 用户下下来直接 "bad CPU type" 起不来。
#      注意：dmg/zip 的**文件名必须全 ASCII**。GitHub Releases 上传时会把非 ASCII
#      字符整段剥掉（"网页收藏-1.4.0-macos-x64.dmg" 变成 "-1.4.0-macos-x64.dmg"，且以 -
#      开头还会被 gh CLI 当成命令行参数，只能用 REST API 删）。app 包内部名保持中文没问题。
# 依赖 build-app.sh 先构建出 dist/网页收藏.app  （用 ARCH=x64/arm64 可交叉构建）
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DESKTOP=$ROOT/desktop
APP=$DESKTOP/dist/网页收藏.app
VER=$(node -p "require('$DESKTOP/package.json').version")

# 真实架构：优先读 Mach-O 头，读不到再退回 uname
ARCH_RAW=$(lipo -archs "$APP/Contents/MacOS/网页收藏" 2>/dev/null | awk '{print $1}')
[ -n "$ARCH_RAW" ] || ARCH_RAW=$(uname -m)
case "$ARCH_RAW" in
  arm64) ARCH=arm64 ;;
  x86_64|x64) ARCH=x64 ;;
  *) ARCH=$ARCH_RAW ;;
esac

ZIP=$DESKTOP/dist/WebVault-$VER-macos-$ARCH.zip
DMG=$DESKTOP/dist/WebVault-$VER-macos-$ARCH.dmg

[ -d "$APP" ] || { echo "先跑 build-app.sh 生成 .app"; exit 1; }
echo "架构：$ARCH_RAW → 文件名后缀 -macos-$ARCH"

# 1. zip（自动更新用）：顶层直接是 .app
#    必须用 Python 打：macOS 自带 zip 命令会把中文名写成非 UTF-8 字节且不打标志位，
#    Windows 资源管理器/部分解压工具会得到乱码文件名（Windows 端踩过同样的坑）。
rm -f "$ZIP"
$(command -v python3) - "$APP" "$ZIP" <<'PYEOF'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(src))  # dist/ 目录：zip 内条目相对它 → 顶层是 网页收藏.app/
count = 0
def link_entry(z, full):
    # 符号链接条目：mode 置成 S_IFLNK，内容是链接目标（unzip/ditto 都认这个）
    zi = zipfile.ZipInfo(os.path.relpath(full, base))
    zi.create_system = 3
    zi.external_attr = (0o120777 << 16)
    z.writestr(zi, os.readlink(full))
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
        # ⚠️ os.walk 把"指向目录的符号链接"（如 Electron Framework.framework/Versions/Current）
        # 归到 dirs 里、并且不会走进去。原来只处理 files 中的链接，这些整环被静默丢掉 →
        # 自动更新装出来的 app 里框架断链，dyld 报 Library not loaded，双击直接打不开
        # （v1.5.7/v1.5.8 两次自动更新都是这么炸的）。这里把 dirs 里的链接也写成条目，
        # 并且不再把它们当目录走下取。
        real_dirs = []
        for d in dirs:
            full = os.path.join(root, d)
            if os.path.islink(full):
                link_entry(z, full); count += 1
            else:
                real_dirs.append(d)
        dirs[:] = real_dirs
        for name in files:
            full = os.path.join(root, name)
            if os.path.islink(full):
                link_entry(z, full)
            else:
                z.write(full, os.path.relpath(full, base))
            count += 1
    # 自检：源里有几个符号链接，zip 里就必须有几个，缺一个就报错退出——
    # 宁可构建失败，也不要再产出"装上去打不开"的包
import subprocess
n_src = len([l for l in subprocess.run(['find', src, '-type', 'l'], capture_output=True, text=True).stdout.splitlines() if l.strip()])
with zipfile.ZipFile(out) as z:
    n_zip = sum(1 for i in z.infolist() if (i.external_attr >> 16) & 0o170000 == 0o120000)
if n_src != n_zip:
    print('FATAL: 符号链接丢失 %d -> %d，打包中止' % (n_src, n_zip)); sys.exit(1)
print('zip entries:', count, '| symlinks:', n_zip, '| size MB:', round(os.path.getsize(out)/1048576, 1))
PYEOF

# 2. dmg（人用）： staging 里放 .app + Applications 快捷方式
#    用 rsync 而非 cp：沙箱文件 broker 会拦截 cp/rename default_app.asar
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a "$APP/" "$STAGE/网页收藏.app/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# 卷名也带版本号：挂载后窗口标题就能看出是哪个版本
hdiutil create -volname "网页收藏 $VER" -srcfolder "$STAGE" -ov -format UDZO "$DMG" -quiet

ls -la "$ZIP" "$DMG"
echo ""
echo "zip: $ZIP"
echo "dmg: $DMG"
