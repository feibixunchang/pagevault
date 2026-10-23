#!/usr/bin/env bash
# 构建 Linux x64 版（原生安装包）。
#
# 产出（文件名一律带版本号）：
#   WebVault-<版本>-linux-x64.tar.gz        通用便携包（任何发行版解压即用）
#   WebVault-<版本>-linux-x64.deb           Debian / Ubuntu / Deepin / UOS / 麒麟
#   WebVault-<版本>-linux-x86_64.rpm        Fedora / RHEL / CentOS / openEuler
#   WebVault-<版本>-linux-x86_64.AppImage   免安装、双击就跑（需 appimagetool）
#
# 在哪个系统上跑都行：
#   - macOS：能出 tar.gz + deb（deb 用 scripts/mkdeb.py 纯 Python 生成），
#            rpm/AppImage 会跳过（缺 rpmbuild / appimagetool）
#   - Linux：四种全出。CI 里就是 Ubuntu，dpkg-deb 与 rpmbuild 都装得上
#
# 为什么要分两个阶段：Electron 的 Linux 运行时只是**文件组装**，不需要 wine；
# 而 deb/rpm 的元数据必须由目标平台的工具生成才可靠（尤其在 CI 里能真装一遍验证）。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP=$ROOT/desktop
SERVER=$ROOT/server
PY=${PYTHON:-python3}

ELECTRON_VER=31.7.7
OUTNAME=WebVault-linux-x64
OUT=$DESKTOP/dist/$OUTNAME
BUILD=$DESKTOP/.linux-build
SRC=$BUILD/electron-v$ELECTRON_VER-linux-x64
SRCZIP=$BUILD/electron-v$ELECTRON_VER-linux-x64.zip

# 0. 版本号单一来源（与 mac/win 同一份脚本）
node "$ROOT/scripts/stamp-version.js" >/dev/null
VER=$(node -p "require('$DESKTOP/package.json').version")
TARBALL=$DESKTOP/dist/WebVault-$VER-linux-x64.tar.gz
DEB=$DESKTOP/dist/WebVault-$VER-linux-x64.deb
RPMNAME=WebVault-$VER-linux-x86_64.rpm
RPM=$DESKTOP/dist/$RPMNAME

echo "== 版本 $VER =="

# 1. Electron Linux 运行时（国内镜像优先；已下载就复用）
if [ ! -d "$SRC" ]; then
  mkdir -p "$BUILD"
  if [ ! -s "$SRCZIP" ]; then
    for url in \
      "https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-linux-x64.zip" \
      "https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-linux-x64.zip" \
      "https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/electron-v${ELECTRON_VER}-linux-x64.zip"; do
      echo "-- 下载 $(echo "$url" | cut -d/ -f3)"
      rm -f "$SRCZIP"
      if curl -fL --retry 2 --connect-timeout 15 -o "$SRCZIP" "$url"; then
        [ -s "$SRCZIP" ] && break
      fi
    done
  fi
  [ -s "$SRCZIP" ] || { echo "ERROR: 拿不到 electron linux 运行时"; exit 1; }
  rm -rf "$SRC"
  mkdir -p "$SRC"
  unzip -q -o "$SRCZIP" -d "$SRC"
fi
[ -f "$SRC/electron" ] || { echo "ERROR: $SRC/electron 不存在"; exit 1; }

# 2. 组装应用目录
rm -rf "$OUT"
mkdir -p "$OUT/resources/app"
rsync -a "$SRC/" "$OUT/"
mv "$OUT/electron" "$OUT/webvault"
chmod +x "$OUT/webvault"

cp "$DESKTOP/main.js" "$OUT/resources/app/main.js"
cp "$DESKTOP/updater.js" "$OUT/resources/app/updater.js"
cp "$DESKTOP/preload.js" "$OUT/resources/app/preload.js"
cp "$DESKTOP/package.json" "$OUT/resources/app/package.json"

rsync -a --delete --exclude=data "$SERVER/" "$OUT/resources/server/"
# 扩展放两处：根目录（用户直接看得到）+ resources/extension（服务端 extensionDir() 的候选路径）
rsync -a --delete --exclude='.DS_Store' "$ROOT/extension/" "$OUT/extension/"
mkdir -p "$OUT/resources/extension"
rsync -a --delete --exclude='.DS_Store' "$ROOT/extension/" "$OUT/resources/extension/"

# 3. 图标 + 桌面入口 + 说明
if [ -d "$DESKTOP/linux-icons" ]; then
  cp "$DESKTOP/linux-icons/webvault-512.png" "$OUT/webvault.png"
fi
cat > "$OUT/webvault.desktop" <<'DESKTOPEOF'
[Desktop Entry]
Type=Application
Name=网页收藏
Name[en]=Web Vault
GenericName=网页收藏与多端同步
Comment=Save web pages for offline reading and sync them across devices
Exec=/opt/WebVault/webvault --class=webvault %U
TryExec=/opt/WebVault/webvault
Icon=webvault
Terminal=false
Categories=Utility;Network;
Keywords=bookmark;archive;readlater;webdav;sync;
StartupNotify=true
StartupWMClass=webvault
DESKTOPEOF

# 便携包启动器：解压出来的目录没有 root，chrome-sandbox 无法设 setuid，
# 这种情况下退回 --no-sandbox（Chromium 的 user namespace 沙箱在不少发行版上被禁）。
cat > "$OUT/webvault.sh" <<'SHEOF'
#!/bin/sh
# 网页收藏 便携版启动器
DIR=$(cd "$(dirname "$0")" && pwd)
BOX="$DIR/chrome-sandbox"
if [ -u "$BOX" ] && [ "$(stat -c %u "$BOX" 2>/dev/null)" = "0" ]; then
  exec "$DIR/webvault" --class=webvault "$@"
fi
exec "$DIR/webvault" --class=webvault --no-sandbox "$@"
SHEOF
chmod +x "$OUT/webvault.sh"

cat > "$OUT/README.txt" <<EOF
网页收藏 Linux 版使用说明（v$VER）
================================

三种装法，挑一种：

一、Debian / Ubuntu / Deepin / UOS / 麒麟  →  双击 deb 或用命令行
    sudo apt install ./WebVault-$VER-linux-x64.deb
    # 装完在应用菜单里搜「网页收藏」，或命令行执行 webvault
    # 卸载：sudo apt remove webvault

二、Fedora / RHEL / CentOS / openEuler  →  rpm
    sudo dnf install ./WebVault-$VER-linux-x86_64.rpm
    # 或者 sudo rpm -ivh ./WebVault-$VER-linux-x86_64.rpm

三、任何发行版  →  便携版（不解压到系统目录也能用）
    tar -xzf WebVault-$VER-linux-x64.tar.gz
    cd WebVault-linux-x64 && ./webvault.sh
    # 首次运行若提示缺少库，Debian 系执行：
    #   sudo apt install libgtk-3-0 libnss3 libnotify4 libxss1 libxtst6 \\
    #                    libatspi2.0-0 libsecret-1-0 libasound2 xdg-utils

AppImage：chmod +x 后直接双击（若系统没装 FUSE，加 --appimage-extract-and-run 运行）。

数据与端口
  数据目录：~/.config/pagevault-desktop（删掉=清空收藏）
  端口：8731，被占用时自动复用已在跑的那个实例

浏览器扩展
  安装目录下的 extension 文件夹就是扩展：
  Chrome / Edge 打开 chrome://extensions → 开启「开发者模式」
  → 「加载已解压的扩展程序」→ 选 extension 文件夹

同步
  设置 → 账号与同步：填自己的 WebDAV（坚果云 / Nextcloud / 群晖等），
  或多台机器互为同步源（填写对方地址 + 令牌）。
EOF

echo "== 组装完成: $OUT =="

# 4. tar.gz 便携包
rm -f "$TARBALL"
( cd "$DESKTOP/dist" && tar -czf "$TARBALL" "$OUTNAME" )
echo "tar.gz: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# 5. deb：优先 dpkg-deb（Linux），否则用 scripts/mkdeb.py 纯 Python 生成
STAGE=$BUILD/debroot
rm -rf "$STAGE"
mkdir -p "$STAGE/opt/WebVault" "$STAGE/usr/bin" "$STAGE/usr/share/applications"
rsync -a "$OUT/" "$STAGE/opt/WebVault/"
# chrome-sandbox 必须 setuid root，否则 Chromium 沙箱起不来
chmod 4755 "$STAGE/opt/WebVault/chrome-sandbox" 2>/dev/null || true
ln -sf /opt/WebVault/webvault "$STAGE/usr/bin/webvault"
cp "$OUT/webvault.desktop" "$STAGE/usr/share/applications/webvault.desktop"
for s in 16 32 48 64 128 256 512; do
  src=$DESKTOP/linux-icons/webvault-$s.png
  [ -f "$src" ] || continue
  d=$STAGE/usr/share/icons/hicolor/${s}x${s}/apps
  mkdir -p "$d"
  cp "$src" "$d/webvault.png"
done

cat > "$BUILD/postinst" <<'POSTEOF'
#!/bin/sh
set -e
# 桌面图标与菜单缓存：装完之后菜单里立刻能看到，不用等下次登录
if [ -x /usr/bin/update-desktop-database ]; then
  update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true
fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
exit 0
POSTEOF

cat > "$BUILD/desc.txt" <<'DESCOEF'
把网页整页保存到本地，随时离线阅读，并在多台设备之间同步。
 - 整页快照：正文、图片、样式一起存，断网也能看
 - 纯净阅读：自动抽出正文，去掉广告、侧栏、评论区
 - 多端同步：自己的 WebDAV（坚果云 / Nextcloud / 群晖）或对端直连同步
 - 界面字号 / 粗细 / 字体可调，对整屏生效
 - 自带浏览器扩展，一键保存当前页面
DESCOEF

DEB_DEPS="libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0, libasound2 | libasound2t64"

if command -v dpkg-deb >/dev/null 2>&1; then
  # dpkg-deb 要求元数据在包根的 DEBIAN/ 里（不是外部目录），且该目录不会被打进 data.tar
  rm -rf "$STAGE/DEBIAN"
  mkdir -p "$STAGE/DEBIAN"
  cp "$BUILD/postinst" "$STAGE/DEBIAN/postinst"
  chmod 755 "$STAGE/DEBIAN/postinst"
  cat > "$STAGE/DEBIAN/control" <<EOF
Package: webvault
Version: $VER
Section: utils
Priority: optional
Architecture: amd64
Maintainer: feibixunchang <feibixunchang@users.noreply.github.com>
Installed-Size: $(du -sk "$STAGE" | cut -f1)
Depends: $DEB_DEPS
Recommends: libayatana-appindicator3-1
Homepage: https://github.com/feibixunchang/pagevault
Description: 网页收藏 — 网页存档与多端同步
$(sed 's/^/ /' "$BUILD/desc.txt" | sed 's/^ $/ ./')
EOF
  # md5sums 的路径必须相对于包根（不带 ./ 前缀），且不含 DEBIAN 自身
  ( cd "$STAGE" && find . -path ./DEBIAN -prune -o -type f -print0 \
      | sort -z \
      | while IFS= read -r -d '' f; do
          printf '%s  %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "${f#./}"
        done > DEBIAN/md5sums )
  rm -f "$DEB"
  dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$DEB" >/dev/null
  echo "deb: $DEB (dpkg-deb)"
else
  rm -f "$DEB"
  # chrome-sandbox 必须 4755：macOS 上 chmod 设不上 setuid（沙箱里静默失败），
  # 所以在 tar 头里直接写死权限，别依赖文件系统属性。
  $PY "$ROOT/scripts/mkdeb.py" \
    --root "$STAGE" --package webvault --version "$VER" --arch amd64 \
    --output "$DEB" --depends "$DEB_DEPS" --recommends "libayatana-appindicator3-1" \
    --summary "网页收藏 — 网页存档与多端同步" \
    --mode "opt/WebVault/chrome-sandbox=4755" \
    --description-file "$BUILD/desc.txt" --postinst-file "$BUILD/postinst"
fi

# 6. rpm：只有装了 rpmbuild 才出
if command -v rpmbuild >/dev/null 2>&1; then
  RTOP=$BUILD/rpmtop
  rm -rf "$RTOP"
  mkdir -p "$RTOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
  cat > "$RTOP/SPECS/webvault.spec" <<EOF
Name:           webvault
Version:        $VER
Release:        1
Summary:        网页收藏 — 网页存档与多端同步
License:        MIT
URL:            https://github.com/feibixunchang/pagevault
BuildArch:      x86_64
Requires:       gtk3, libnotify, nss, libXScrnSaver, libXtst, xdg-utils, at-spi2-core, libuuid, libsecret, alsa-lib
AutoReqProv:    no

%description
把网页整页保存到本地，随时离线阅读，并在多台设备之间同步。
支持 WebDAV 或对端直连同步、纯净阅读、界面字号与字体调节。

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt/WebVault
cp -a $OUT/. %{buildroot}/opt/WebVault/
# Electron 官方 zip 里这个文件不一定是 setuid；Chromium 沙箱要求 root:root + 4755
chmod 4755 %{buildroot}/opt/WebVault/chrome-sandbox
mkdir -p %{buildroot}/usr/bin
ln -sf /opt/WebVault/webvault %{buildroot}/usr/bin/webvault
mkdir -p %{buildroot}/usr/share/applications
cp $OUT/webvault.desktop %{buildroot}/usr/share/applications/webvault.desktop
for s in 16 32 48 64 128 256 512; do
  if [ -f $DESKTOP/linux-icons/webvault-\$s.png ]; then
    mkdir -p %{buildroot}/usr/share/icons/hicolor/\${s}x\${s}/apps
    cp $DESKTOP/linux-icons/webvault-\$s.png %{buildroot}/usr/share/icons/hicolor/\${s}x\${s}/apps/webvault.png
  fi
done

%post
if [ -x /usr/bin/update-desktop-database ]; then update-desktop-database -q /usr/share/applications || :; fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :; fi

%postun
if [ -x /usr/bin/update-desktop-database ]; then update-desktop-database -q /usr/share/applications || :; fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :; fi

%files
# chrome-sandbox 的 4755 权限由 buildroot 里文件本身的属性带进去（%install 阶段已 chmod），
# 这里不再单独 %attr 声明——同一路径列两次 rpm 会判重复，反而容易把权限弄回 755。
/opt/WebVault
/usr/bin/webvault
/usr/share/applications/webvault.desktop
/usr/share/icons/hicolor/*/apps/webvault.png

%changelog
* $(date '+%a %b %d %Y') feibixunchang <feibixunchang@users.noreply.github.com> - $VER-1
- Release $VER
EOF
  rm -f "$RPM"
  rpmbuild -bb --define "_topdir $RTOP" "$RTOP/SPECS/webvault.spec" >/dev/null 2>&1 || \
    rpmbuild -bb --define "_topdir $RTOP" "$RTOP/SPECS/webvault.spec"
  cp "$(find "$RTOP/RPMS" -name '*.rpm' | head -1)" "$RPM"
  echo "rpm: $RPM"
else
  echo "rpm: 跳过（没有 rpmbuild；在 Linux 或 CI 上会生成）"
fi

# 7. AppImage：只有 appimagetool 在才出
if command -v appimagetool >/dev/null 2>&1; then
  APPDIR=$BUILD/WebVault.AppDir
  rm -rf "$APPDIR"
  mkdir -p "$APPDIR"
  rsync -a "$OUT/" "$APPDIR/"
  cat > "$APPDIR/AppRun" <<'AREOF'
#!/bin/sh
DIR=$(dirname "$(readlink -f "$0")")
exec "$DIR/webvault" --class=webvault "$@"
AREOF
  chmod +x "$APPDIR/AppRun"
  cp "$DESKTOP/linux-icons/webvault-512.png" "$APPDIR/webvault.png"
  cat > "$APPDIR/webvault.desktop" <<'ADEOF'
[Desktop Entry]
Type=Application
Name=网页收藏
Exec=webvault --class=webvault %U
Icon=webvault
Terminal=false
Categories=Utility;Network;
ADEOF
  rm -f "$DESKTOP/dist/WebVault-$VER-linux-x86_64.AppImage"
  ARCH=x86_64 appimagetool --no-appstream "$APPDIR" "$DESKTOP/dist/WebVault-$VER-linux-x86_64.AppImage" >/dev/null 2>&1 && \
    echo "AppImage: $DESKTOP/dist/WebVault-$VER-linux-x86_64.AppImage"
else
  echo "AppImage: 跳过（没有 appimagetool）"
fi

echo ""
echo "== 产物 =="
ls -lh "$DESKTOP/dist" | grep -Ei "linux|\.deb|\.rpm|AppImage" || true
