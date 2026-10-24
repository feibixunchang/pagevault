#!/usr/bin/env bash
# 部署到 NAS（飞牛 fnOS / 群晖等）——上传、换代码、重建、验证一条龙。
#
#   NAS_PASS=你的ssh密码 bash scripts/deploy-nas.sh <NAS_IP> <SSH端口> <用户名> <部署目录>
#
# 例：
#   NAS_PASS=xxx bash scripts/deploy-nas.sh 192.168.100.3 2580 zjkx /vol1/1000/docker/pagevault
#
# ⚠️ 这个脚本的核心原则：**只换代码，不碰配置，不碰数据**
#   部署目录里的 docker-compose.yml 是用户自己配过的（volumes 绝对路径、PUID/PGID、
#   extra_hosts、时区……），一旦被安装包里的通用 compose 覆盖，容器就会挂到 ./data
#   这个空目录上，表现为「服务起来了但库是空的」——数据其实还在，只是挂错地方了。
#   所以这里：compose 只在"远端不存在"时才拷贝，存在就只改镜像 tag。
#   旧代码 mv 成 server.old-<时间戳> 而不是直接删，出问题能立刻回滚。
set -e

NAS_IP=${1:-}
NAS_PORT=${2:-22}
NAS_USER=${3:-}
NAS_DIR=${4:-}
NAS_PASS=${NAS_PASS:-}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -z "$NAS_IP" ] || [ -z "$NAS_USER" ] || [ -z "$NAS_PASS" ] || [ -z "$NAS_DIR" ]; then
  echo "用法：NAS_PASS=密码 bash scripts/deploy-nas.sh <NAS_IP> <SSH端口> <用户名> <部署目录>"
  echo "例：  NAS_PASS=xxx bash scripts/deploy-nas.sh 192.168.100.3 2580 zjkx /vol1/1000/docker/pagevault"
  exit 1
fi

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
# ⚠️ scp 的端口是 -P（大写），-p 在 scp 里是"保留时间戳"。直接复用 SSH_OPTS 会把端口当文件名。
SCP_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o PreferredAuthentications=password -o PubkeyAuthentication=no -P $NAS_PORT"

cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

VER=$(node -p "require('./desktop/package.json').version")
PKG="pagevault-docker-$VER.tar.gz"
R() { ssh $SSH_OPTS "$NAS_USER@$NAS_IP" "$@"; }

echo "== 1/5 打包 v$VER =="
bash scripts/pack-docker.sh > /dev/null
ls -lh "dist/$PKG" | awk '{print "   " $9 "  " $5}'

echo "== 2/5 上传 =="
R "mkdir -p '$NAS_DIR'"
scp $SCP_OPTS "dist/$PKG" "$NAS_USER@$NAS_IP:/tmp/" > /dev/null
echo "   已传到 /tmp/$PKG"

# 防呆：部署目录写错层级（典型是少写一层，把代码铺到了上级目录）后果很隐蔽——
# 新容器对着空目录起，或者 project 名撞车、旧容器照旧跑，看着"部署成功"其实没换版本。
# 这里认一下：目标目录自己要有 server/；如果只有子目录里有，说明路径少写了一层。
LAYOUT=$(R "cd '$NAS_DIR' 2>/dev/null || { echo NODIR; exit 0; }
  if [ -d server ]; then echo OK
  elif ls -d */server >/dev/null 2>&1; then echo NESTED:\$(ls -d */server | head -3 | tr '\\n' ' ')
  else echo EMPTY; fi" 2>/dev/null | tr -d '\r')
case "$LAYOUT" in
  NESTED:*)
    echo "❌ 部署目录不对：$NAS_DIR 里没有 server/，但子目录里有："
    echo "     ${LAYOUT#NESTED:}"
    echo "   多半是少写了一层，把 <NAS_DIR> 改成 ${NAS_DIR%/}/\$(上面的子目录名) 再跑。已中止，什么都没改。"
    exit 1 ;;
  NODIR) echo "   （目标目录不存在，将创建）" ;;
esac

echo "== 3/5 备份现有代码并换上新代码 =="
R "
  set -e
  cd '$NAS_DIR'
  TS=\$(date +%Y%m%d-%H%M%S)
  mkdir -p backup
  # 只备份代码与配置，data 目录不动（也不该动）
  tar czf backup/code-\$TS.tar.gz docker-compose.yml server extension 2>/dev/null || true
  echo '   代码已备份到 backup/code-'\$TS'.tar.gz'

  rm -rf /tmp/pvnew && mkdir -p /tmp/pvnew
  tar xzf '/tmp/$PKG' -C /tmp/pvnew
  NEW=/tmp/pvnew/pagevault-docker

  # 旧代码改名保留，方便回滚
  [ -d server ] && mv server server.old-\$TS
  [ -d extension ] && mv extension extension.old-\$TS
  cp -R \$NEW/server .
  cp -R \$NEW/extension .
  cp -R \$NEW/scripts . 2>/dev/null || true
  # 飞牛 NAS 的 trimafs 在 cp/解包后会把权限位写成 000，node 读不到源码就起不来
  # （表现是容器一直 restart，日志里 EACCES）。这一步不能省。
  chmod -R u+rwX,go+rX server extension scripts 2>/dev/null || true

  # compose：远端有就只改镜像 tag，绝不覆盖
  if [ -f docker-compose.yml ]; then
    sed -i 's|image: pagevault/server:[^ ]*|image: pagevault/server:$VER|' docker-compose.yml
    echo '   已更新 compose 的镜像 tag（其余配置原样保留）'
  else
    cp \$NEW/docker-compose.yml .
    echo '   ⚠️ 远端没有 compose，用了包里的通用版——请检查 volumes 是否指向真实数据目录'
  fi
"

echo "== 4/5 重建容器 =="
# project 名由目录名决定：目录对了，容器名才不会撞车（撞上会报
# 「container name /pagevault is already in use」，然后一声不响地继续跑旧容器）
R "cd '$NAS_DIR' && docker compose up -d --build --remove-orphans 2>&1 | tail -4"

echo "== 5/5 验证 =="
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  ST=$(R "docker ps --filter name=pagevault --format '{{.Status}}'" 2>/dev/null | tr -d '\r')
  case "$ST" in
    *healthy*) echo "   容器状态：$ST"; break ;;
    *) [ $i -eq 10 ] && echo "   ⚠️ 容器状态：${ST:-（没起来）}" ;;
  esac
done

API=$(curl -s --noproxy '*' -m 15 "http://$NAS_IP:8731/api/status" 2>/dev/null)
if [ -z "$API" ]; then
  echo "   ⚠️ 接口没响应，看日志：ssh -p $NAS_PORT $NAS_USER@$NAS_IP 'docker logs --tail 40 pagevault'"
  exit 1
fi
echo "$API" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('   版本 %s / %s，库内 %s 条页面' % (d.get('version'), d.get('platform'), (d.get('counts') or {}).get('total')))
"

echo ""
echo "部署完成。旧代码留在 $NAS_DIR/server.old-* 和 extension.old-*，确认没问题后可以删。"
