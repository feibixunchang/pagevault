#!/usr/bin/env bash
# 构建安卓 APK（不依赖 Gradle / Maven，只用 Android SDK 自带工具链）。
#
# 为什么不用 Gradle：这个项目要求「零第三方依赖」，用 aapt2 + javac + d8 + apksigner
# 直接拼 APK，既不用下载 Gradle 发行包，也不用联网解析 Maven 依赖，
# 在任何一台装了 Android SDK 的机器上都能一条命令出包。
#
# 用法：
#   bash android/build.sh
# 环境变量：
#   ANDROID_HOME  Android SDK 根目录（默认 /tmp/androidsdk）
#   JAVA_HOME     JDK 17 目录
#   VERSION       版本号（默认取 desktop/package.json 的 version）
#
# 产物：android/dist/PageVault-<版本>-android.apk
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ANDROID_HOME=${ANDROID_HOME:-/tmp/androidsdk}
JAVA_HOME=${JAVA_HOME:-/tmp/jdk-17.0.20.1+1/Contents/Home}
BUILD_TOOLS=$ANDROID_HOME/build-tools/34.0.0
PLATFORM=$ANDROID_HOME/platforms/android-34
if [ -x "$BUILD_TOOLS/aapt2" ]; then
  AAPT2=$BUILD_TOOLS/aapt2
else
  AAPT2=$ANDROID_HOME/build-tools/*/aapt2
fi
D8=$BUILD_TOOLS/d8
APKSIGNER=$BUILD_TOOLS/apksigner
ZIPALIGN=$BUILD_TOOLS/zipalign
ANDROID_JAR=$PLATFORM/android.jar

VER=${VERSION:-$(node -p "require('$ROOT/desktop/package.json').version")}
NAME=PageVault
VERCODE=$(echo "$VER" | tr -d '.' | cut -c1-8)
[ -z "$VERCODE" ] && VERCODE=1

WORK=$ROOT/android/.build
DIST=$ROOT/android/dist
rm -rf "$WORK"
mkdir -p "$WORK/compiled" "$WORK/gen" "$WORK/classes" "$WORK/dex" "$DIST"

export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

echo "[1/6] 编译资源"
"$AAPT2" compile --dir "$ROOT/android/res" -o "$WORK/compiled/res.zip"

echo "[2/6] 链接资源 + 生成 R.java"
"$AAPT2" link \
  -o "$WORK/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  -R "$WORK/compiled/res.zip" \
  --java "$WORK/gen" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code "$VERCODE" \
  --version-name "$VER" \
  --auto-add-overlay

echo "[3/6] 编译 Java"
find "$ROOT/android/java" "$WORK/gen" -name '*.java' > "$WORK/sources.txt"
# 用 --release 8 而不是 -source/-target + bootclasspath：
# android.jar 里没有 java.lang.invoke.LambdaMetafactory（那是 ART 运行时的），
# 用 android.jar 当 bootclasspath 编译 lambda 会报「找不到方法 metafactory」。
# --release 8 用 JDK 自己的 java.* 签名，android.jar 只当 classpath，
# lambda 的 invokedynamic 交给 d8 去脱糖。
set +e
javac --release 8 \
  -encoding UTF-8 \
  -nowarn \
  -classpath "$ANDROID_JAR" \
  -d "$WORK/classes" \
  @"$WORK/sources.txt" 2>&1 | grep -v "^Note:" | grep -v "deprecat" | grep -v "^警告" || true
JAVAC_RC=${PIPESTATUS[0]}
set -e
if [ "$JAVAC_RC" != "0" ] || [ ! -d "$WORK/classes/com" ]; then echo "编译失败"; exit 1; fi

echo "[4/6] 转 dex"
find "$WORK/classes" -name '*.class' > "$WORK/classes.txt"
"$D8" --lib "$ANDROID_JAR" --min-api 21 --release --output "$WORK/dex" @"$WORK/classes.txt"

echo "[5/6] 打包"
# dex 必须放在 APK 根目录（classes.dex），放进子目录会装不上/起不来
cd "$WORK/dex"
for f in *.dex; do
  cp "$f" "$WORK/$f"
  (cd "$WORK" && zip -q -X base.apk "$f")
done
cd "$ROOT"

echo "[6/6] 对齐 + 签名"
cp "$WORK/base.apk" "$WORK/unsigned.apk"
"$ZIPALIGN" -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# 签名密钥要固定在一个稳定位置：每次构建都换密钥的话，
# 已装的旧包就装不上（INSTALL_FAILED_UPDATE_INCOMPATIBLE），用户也得先卸载再装。
KS=$ROOT/android/keys/debug.keystore
mkdir -p "$ROOT/android/keys"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=PageVault Debug,O=PageVault,C=CN" >/dev/null 2>&1
fi
APK=$DIST/$NAME-$VER-android.apk
"$APKSIGNER" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$APK" "$WORK/aligned.apk"
"$APKSIGNER" verify --print-certs "$APK" | head -3

ls -la "$APK"
echo "完成：$APK"
