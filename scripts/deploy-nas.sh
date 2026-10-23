#!/usr/bin/env bash
# 部署到 NAS（飞牛 fnOS / 群晖等）——上传、解压、重建、验证一条龙。
#
#   NAS_PASS=你的ssh密码 bash scripts/deploy-nas.sh <NAS_IP> <SSH端口> <用户名> [数据目录]
#
# 例：
#   NAS_PASS=xxx bash scripts/deploy-nas.sh 192.168.1.10 22 myuser /volume1/docker/pagevault
#
# 参数说明：
#   NAS_IP      NAS 的局域网地址
#   SSH端口     NAS 的 sshd 端口（默认 22）
#   用户名      NAS 上的用户名
#   数据目录    pagevault 在 NAS 上的存放位置（默认 ~/pagevault）
#
# ⚠️ 两个必须做的动作（漏了都会出事）：
#   1) 把 NAS 专用的 compose-new.yml 复制成 docker-compose.yml
#      ——否则用的是仓库里那份通用 compose（挂 ./data，容器里是空目录），
#        表现为「服务起来了但库是空的」（数据没丢，只是挂错地方了）
#   2) 把镜像标签改成当前版本
#      ——compose-new.yml 里的 tag 可能是旧的，会把容器降级回老版本
set -e

NAS_IP=${1:-}
NAS_PORT=${2:-22}
NAS_USER=${3:-}
NAS_DIR=${4:-}
NAS_PASS=${NAS_PASS:-}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -z "$NAS_IP" ] || [ -z "$NAS_USER" ] || [ -z "$NAS_PASS" ]; then
  echo "用法：NAS_PASS=你的ssh密码 bash scripts/deploy-nas.sh <NAS_IP> [SSH端口] [用户名] [数据目录]"
  echo "例：  NAS_PASS=xxx bash scripts/deploy-nas.sh 192.168.1.10 22 myuser /volume1/docker/pagevault"
  exit 1
fi
[ -z "$NAS_DIR" ] && NAS_DIR="$HOME/pagevault"

# 用 SSH_ASKPASS 免交互：NAS 的 sshd 在公钥协商上可能卡住，
# 强制只用密码认证反而稳（expect 也行，但输出容易丢）。
ASKPASS=$(mktemp)
cat > "$ASKPASS" <<EOF
#!/bin/sh
echo "$NAS_PASS"
EOF
chmod +x "$ASKPASS"
export DISPLAY=:0 SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o PreferredAuthentications=password -o PubkeyAuthentication=no -p $NAS_PORT"

cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

VER=$(node -p "require('./desktop/package.json').version")
PKG="pagevault-docker-$VER.tar.gz"

echo "== 打包 =="
bash scripts/pack-docker.sh

echo "== 上传到 NAS =="
ssh $SSH_OPTS "$NAS_USER@$NAS_IP" "mkdir -p '$NAS_DIR'"
scp $SSH_OPTS "dist/$PKG" "$NAS_USER@$NAS_IP:$NAS_DIR/"

echo "== 解压并重建容器 =="
ssh $SSH_OPTS "$NAS_USER@$NAS_IP" "
  cd '$NAS_DIR' &&
  tar xzf '$PKG' &&
  cp compose-new.yml pagevault-docker/docker-compose.yml &&
  sed -i 's|image: pagevault/server:1.[0-9.]*|image: pagevault/server:$VER|' pagevault-docker/docker-compose.yml &&
  cd pagevault-docker &&
  docker compose up -d --build 2>&1 | tail -2 &&
  sleep 10 &&
  docker ps --filter name=pagevault --format '{{.Names}} {{.Status}}' &&
  echo '数据目录里的页面文件数:' \$(ls '$NAS_DIR'/data/pages 2>/dev/null | wc -l)
"

echo "== 验证 =="
sleep 3
COUNT=$(curl -s --noproxy '*' -m 15 "http://$NAS_IP:8731/api/pages" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "NAS 现有 $COUNT 个页面"
if [ "$COUNT" = "0" ]; then
  echo "⚠️ 库是空的？先看 data/pages 里文件在不在："
  echo "   在 → compose 的 volumes 没指向真实数据目录，重跑一次上面带 cp compose-new.yml 的那步"
  echo "   不在 → 数据真的没了，快看备份/快照"
fi
