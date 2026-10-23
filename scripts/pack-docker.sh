#!/usr/bin/env bash
# 打包一份「可直接拷到 NAS 上解压就能起」的最小 Docker 部署包。
#   bash scripts/pack-docker.sh
# 产物：dist/pagevault-docker-<版本>.tar.gz
# 内容：docker-compose.yml + server/（源码，无 node_modules）+ extension/ + DEPLOY.txt
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(node -p "require('./desktop/package.json').version")
OUT="dist/pagevault-docker-$VERSION.tar.gz"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

PKG="$STAGE/pagevault-docker"
mkdir -p "$PKG/server" "$PKG/extension"

# compose（NAS 上通常要改 volumes 的绝对路径与 PUID/PGID）
cp docker-compose.yml "$PKG/"
# 服务端源码：只带运行期需要的（零依赖，不需要 node_modules / data）
cp server/package.json server/server.js server/sync.js server/providers.js server/webdav.js server/zip.js \
   server/dnsx.js server/extws.js server/hotlist.js server/sources.js server/htmlish.js \
   server/Dockerfile server/docker-entrypoint.sh "$PKG/server/"
rsync -a --exclude '*.log' server/public "$PKG/server/"
# 扩展（容器里从 /api/extension.zip 分发，镜像构建也需要它）
rsync -a extension "$PKG/"

cat > "$PKG/DEPLOY.txt" <<'EOF'
网页收藏 PageVault —— Docker 部署包
====================================

1) 改 compose 里的两处：
   volumes:  /你的/绝对/路径/data:/data
   PUID/PGID 改成 NAS 上 `id` 看到的数值（飞牛通常是 1000）

2) 起服务：
   docker compose up -d --build
   docker compose ps          # 等到 (healthy)

3) 打开 http://<NAS的IP>:8731
   状态栏显示「Docker 版 v1.x.x」即为容器端

4) 装浏览器扩展：
   下载 http://<NAS的IP>:8731/api/extension.zip 并解压
   chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选该文件夹

5) 备份：打包 data/ 目录；迁移：把 data/ 拷到新机器即可。
EOF

mkdir -p dist
rm -f "$OUT"
# 用 tar 直接打包（gzip 不带时间戳更可复现）
tar -C "$STAGE" -czf "$OUT" pagevault-docker

echo "已生成：$OUT"
tar -tzf "$OUT" | head -12
echo "…"
echo "大小：$(du -h "$OUT" | cut -f1)"
