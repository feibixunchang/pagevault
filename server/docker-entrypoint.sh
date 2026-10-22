#!/bin/sh
# 容器入口：把 /data 的属主修正成 PUID:PGID，然后降权运行 node。
#
# 为什么需要这一层：
#   NAS 上把宿主目录挂到 /data 时，容器内的 root 未必能写，
#   非 root 用户（node，uid 1000）也未必是卷的属主。
#   统一做法：以 root 进来 → chown 一次 → su-exec 到 PUID:PGID 跑业务进程。
set -e

DATA="${PAGEVAULT_DATA:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p "$DATA/pages"

if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$DATA" 2>/dev/null || true
  exec su-exec "$PUID:$PGID" "$@"
fi

# compose 里显式写了 user: 时已经是非 root，直接跑
exec "$@"
