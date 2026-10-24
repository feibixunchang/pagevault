#!/usr/bin/env bash
# 重新拉起安卓构建环境（重启后 /tmp 里的 JDK / SDK 都没了）。
# 复用仓库里稳定的 debug.keystore，保证能覆盖安装。
#
# ⚠️ 沙箱的文件代理会拦跨目录复制（JDK 里有些文件读不得），
#    所以这里一律"直接解包到最终位置"：tar --strip-components / unzip + 软链接，
#    不用 cp -R / mv。
set -e

ARCH=$(uname -m)
case "$ARCH" in
  arm64) JDK_ARCH=aarch64 ;;
  *)     JDK_ARCH=x64 ;;
esac

JDK_DIR=/tmp/jdk-17
SDK=/tmp/androidsdk
DL=/tmp/dl
mkdir -p "$DL"

# ---------- 1. JDK 17 ----------
if [ ! -x "$JDK_DIR/Contents/Home/bin/javac" ]; then
  echo "[1/4] 下载 JDK 17 ($JDK_ARCH)"
  URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_${JDK_ARCH}_mac_hotspot_17.0.13_11.tar.gz"
  [ -f "$DL/jdk.tar.gz" ] || curl -fL --retry 3 -o "$DL/jdk.tar.gz" "$URL"
  mkdir -p "$JDK_DIR"
  # 直接解到目标目录：解出来是 jdk-17.0.13+11/Contents/...，剥掉第一层
  tar xzf "$DL/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
fi
"$JDK_DIR/Contents/Home/bin/javac" -version

# ---------- 2. cmdline-tools ----------
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "[2/4] 下载 Android cmdline-tools"
  [ -f "$DL/cmdline.zip" ] || curl -fL --retry 3 -o "$DL/cmdline.zip" \
    "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
  mkdir -p "$SDK/cmdline-tools"
  unzip -q -o "$DL/cmdline.zip" -d "$SDK/cmdline-tools"
  # 解出来是 cmdline-tools/cmdline-tools/...，用软链接当 "latest"
  ln -sfn cmdline-tools "$SDK/cmdline-tools/latest"
fi

export JAVA_HOME="$JDK_DIR/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$SDK"

# ---------- 3. 平台与构建工具 ----------
echo "[3/4] 安装 platform-34 / build-tools 34.0.0"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" \
  "platforms;android-34" "build-tools;34.0.0" "platform-tools" 2>&1 | tail -3

# ---------- 4. 出包 ----------
echo "[4/4] 构建 APK"
cd "$(dirname "$0")/.."
JAVA_HOME="$JAVA_HOME" ANDROID_HOME="$SDK" bash android/build.sh

echo "完成：$(ls -la android/dist/PageVault-*-android.apk | tail -1)"
