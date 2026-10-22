#!/usr/bin/env bash
# Build the Windows (win32-x64) edition of 网页收藏.
# Runs on macOS or Linux (cross-assembly is pure file ops — no wine needed).
# Produces: desktop/dist/网页收藏-win32-x64/  (+ a .zip for easy copying)
set -e

ROOT=/Users/lovenasuserlove/WorkBuddy/2026-10-22-13-27-54/pagevault
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server
WINBUILD=$DESKTOP/.win-build
ELECTRON_VER=31.7.7
ZIP=$WINBUILD/electron-v${ELECTRON_VER}-win32-x64.zip
UNPACK=$WINBUILD/electron-v${ELECTRON_VER}-win32-x64
# 注意：zip 内一律用 ASCII 文件名（文件夹/exe）。Windows 10 资源管理器按本地代码页
# 解压非 ASCII 名会乱码，用户可能因此找不到/点错文件。
OUT=$DESKTOP/dist/WebVault-win32-x64

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
cp "$UNPACK/electron.exe" "$OUT/WebVault.exe"
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

# 3b. 使用说明（带 UTF-8 BOM，老版本记事本也能正确显示中文）
printf '\xEF\xBB\xBF' > "$OUT/README.txt"
cat >> "$OUT/README.txt" <<'EOF'
网页收藏 Windows 版使用说明
============================

一、启动
  1. 把 WebVault-win32-x64.zip 解压到任意目录（建议纯英文路径，如 D:\WebVault）。
  2. 双击 WebVault.exe。
  3. 首次运行 Windows SmartScreen 可能提示"Windows 已保护你的电脑"（未知发布者）：
     点"更多信息" -> "仍要运行"即可，只弹一次。
  4. 如果双击后没反应：
     - 暂时退出杀毒软件/安全卫士再试；
     - 或右键 WebVault.exe -> 属性 -> 勾选"解除锁定" -> 确定，再双击；
     - 还不行就右键"以管理员身份运行"。
  5. 若提示缺少 dll：去微软官网安装 "VC++ Redistributable x64 (2015-2022)" 后重试。

二、排查
  - 诊断日志：%APPDATA%\pagevault-desktop\desktop.log
    （按 Win+R 输入 %APPDATA% 回车，进入 pagevault-desktop 文件夹）
  - 窗口显示"本地服务启动失败"时，日志里有具体原因。
  - 服务意外退出会自动重启（最多 3 次）。

三、保存网页
  - Chrome/Edge 打开 chrome://extensions -> 打开"开发者模式"
    -> "加载已解压的扩展程序" -> 选择 pagevault/extension 文件夹。
  - 在任意网页点扩展图标 -> "保存此页"。
  - 阅读器地址：http://127.0.0.1:8731/ （数据只存本机，不上传任何服务器）

四、数据与端口
  - 数据目录：%APPDATA%\pagevault-desktop（删掉该文件夹=清空收藏）
  - 端口：8731（被占用时自动复用已有服务）
EOF

# 4. Zip it up for transfer to a Windows machine
( cd "$DESKTOP/dist" && rm -f "WebVault-win32-x64.zip" && zip -q -r "WebVault-win32-x64.zip" "WebVault-win32-x64" )

echo "Built: $OUT"
echo "Zip   : $DESKTOP/dist/WebVault-win32-x64.zip"
echo ""
echo "Windows 使用说明："
echo "  1. 解压 zip 到任意目录（建议纯英文路径，如 D:\\WebVault）"
echo "  2. 双击 WebVault.exe（未代码签名，SmartScreen 会提示「未知发布者」→"
echo "     「更多信息」→「仍要运行」）"
echo "  3. 数据默认存 %APPDATA%\\pagevault-desktop，端口 8731"
echo "  4. Chrome/Edge 加载 pagevault/extension 即可保存"
