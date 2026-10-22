#!/usr/bin/env bash
# Build the Windows (win32-x64) edition of 网页收藏.
# Runs on macOS or Linux (cross-assembly is pure file ops — no wine needed).
# Produces: desktop/dist/网页收藏-win32-x64/  (+ a .zip for easy copying)
set -e

ROOT=/Users/lovezjkxlove/WorkBuddy/2026-10-22-13-27-54/pagevault
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server

# 0. 版本号单一来源同步（与 macOS 端同一份脚本，保证两端版本一致）
node "$ROOT/scripts/stamp-version.js"
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
# 关键：必须整棵树复制，不能只 glob *.dll *.pak！
# icudtl.dat（ICU 数据）、snapshot_blob.bin / v8_context_snapshot.bin（V8 快照）
# 都不是 dll/pak 后缀，漏掉它们 Chromium 子进程起不来，表现为：
#   [ERROR:icu_util.cc] Invalid file descriptor to ICU data received.
#   双击后无窗口/闪退。
# rsync 而非 cp：沙箱文件 broker 会间歇性拦截 cp/rename 某些文件
# （default_app.asar 尤甚，macOS 构建踩过同样的坑）。
rsync -a --exclude='electron.exe' "$UNPACK/" "$OUT/"
cp "$UNPACK/electron.exe" "$OUT/WebVault.exe"
# 把 AppIcon.ico 嵌进 exe 资源（替换 Electron 默认图标，与 Mac 版完全一致；
# exe 旁边放 .ico 文件对资源管理器无效，必须嵌进 PE 资源区）
if [ -f "$DESKTOP/AppIcon.ico" ]; then
  node "$DESKTOP/set-win-icon.mjs" "$OUT/WebVault.exe" "$DESKTOP/AppIcon.ico"
fi

# 3. Our app entry + bundled sync server + icon
cp "$DESKTOP/main.js" "$OUT/resources/app/main.js"
cp "$DESKTOP/updater.js" "$OUT/resources/app/updater.js"
cp "$DESKTOP/preload.js" "$OUT/resources/app/preload.js"
cp "$DESKTOP/package.json" "$OUT/resources/app/package.json"
rsync -a --delete --exclude=data "$SERVER/" "$OUT/resources/server/"
# 浏览器扩展随包分发（菜单"安装浏览器扩展…"定位到这里）。
# 放两处：zip 根目录（用户直接看到）+ resources/extension（与 Mac 包布局一致，
# 服务端 extensionDir() 两个候选路径都能命中，防止布局调整后找不到）
rsync -a --delete --exclude='.DS_Store' "$ROOT/extension/" "$OUT/extension/"
mkdir -p "$OUT/resources/extension"
rsync -a --delete --exclude='.DS_Store' "$ROOT/extension/" "$OUT/resources/extension/"
[ -f "$DESKTOP/AppIcon.ico" ] && cp "$DESKTOP/AppIcon.ico" "$OUT/AppIcon.ico"
# 一键安装/卸载（用户级：装到 %LOCALAPPDATA%\Programs\WebVault，建快捷方式，注册卸载项）
cp "$DESKTOP/install-win.cmd" "$OUT/install.cmd"
cp "$DESKTOP/uninstall-win.cmd" "$OUT/uninstall.cmd"

# 3b. 使用说明（带 UTF-8 BOM，老版本记事本也能正确显示中文）
printf '\xEF\xBB\xBF' > "$OUT/README.txt"
cat >> "$OUT/README.txt" <<'EOF'
网页收藏 Windows 版使用说明
============================

一、安装（推荐：双击 install.cmd 一键安装）
  1. 把 WebVault-win32-x64.zip 完整解压到任意目录（建议纯英文路径，如 D:\WebVault）。
     注意：不要在资源管理器的 zip 预览窗口里直接双击 exe——
     必须"解压全部"到文件夹后再运行，否则程序必需的伴生文件
     （icudtl.dat、*.pak、locales 等）不在同目录，会报 ICU 错误且无窗口。
  2. 双击 install.cmd：
     - 自动装到 %LOCALAPPDATA%\Programs\WebVault（不需要管理员权限）
     - 自动创建桌面 + 开始菜单快捷方式（正式图标）
     - 注册"设置 -> 应用 -> 网页收藏"卸载入口，可像正常软件一样卸载
     - 安装完成自动启动
  3. 之后从桌面图标 / 开始菜单启动；安装目录里的 uninstall.cmd 也可卸载。
     （收藏数据保留在 %APPDATA%\pagevault-desktop，卸载/重装不丢）
  4. 不想安装也可以：直接双击 WebVault.exe 便携使用，功能完全一样。

二、首次运行被拦？
  1. SmartScreen 提示"Windows 已保护你的电脑"（未知发布者）：
     点"更多信息" -> "仍要运行"，只弹一次。
  2. 双击没反应：暂时退出杀毒软件/安全卫士；或右键 WebVault.exe -> 属性
     -> 勾选"解除锁定" -> 确定，再双击。
  3. 提示缺少 dll：安装微软 "VC++ Redistributable x64 (2015-2022)"。

三、自动更新
  - 启动 5 秒后自动检查 GitHub 最新版，状态栏出现"可更新"提示，点它即可。
  - 更新时会自动测速各下载渠道（官方 + 国内镜像），选最快的下载，
     下载完自动安装并重启。设置里可关闭自动检查。
  - 也可以手动：设置 -> 关于与更新 -> 检查更新。

四、排查
  - 诊断日志：%APPDATA%\pagevault-desktop\desktop.log
    （按 Win+R 输入 %APPDATA% 回车，进入 pagevault-desktop 文件夹）
  - 服务意外退出会自动重启（最多 3 次）。

五、保存网页（浏览器扩展已随安装包分发）
  本目录下的 extension 文件夹就是浏览器扩展，安装一次永久使用：
  - Chrome/Edge 打开 chrome://extensions -> 打开"开发者模式"
    -> "加载已解压的扩展程序" -> 选择本目录下的 extension 文件夹。
  - 也可以在阅读器里点底部状态栏的"安装扩展"，按弹窗步骤操作。
  - 安装后底部状态栏显示"扩展已连接"，在任意网页点扩展图标即可保存整页。

六、多端同步（账号）
  - 阅读器右下角"设置"图标 -> 账号与同步：填入你自己的 WebDAV
    （坚果云 / Nextcloud / 群晖等），保存后自动同步。
  - 多台电脑登录同一个 WebDAV 账号，收藏即实时互相同步（默认 30 秒一轮，
    本地保存/删除会立即推送）。
  - 设置里还可导出/导入整库 zip 备份。

七、数据与端口
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
