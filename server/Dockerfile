# 网页收藏 PageVault —— 自托管服务端（6 端里的 "Docker 端"）
#
# 设计要点：
#   1. 服务端是**零第三方依赖**的纯 JS（只用 Node 内置模块），所以不需要 npm install，
#      镜像里没有任何 node_modules，构建秒级完成、体积小、也没有供应链风险。
#   2. 用 tini 做 1 号进程：否则 `docker stop` 要等 10 秒超时才 SIGKILL。
#   3. 用 su-exec 以 PUID:PGID 降权：NAS 上卷目录的属主通常是 1000（飞牛）或 1026（群晖），
#      写不进去就会表现为"保存成功但重启后数据全没了"。
#   4. 扩展整包随镜像分发：容器端没有本地安装目录，用户从 /api/extension.zip 下载。
#
# 构建（在仓库根目录）：
#   docker build -f server/Dockerfile -t pagevault/server:1.0.0 .
FROM node:22-alpine

LABEL org.opencontainers.image.title="PageVault 网页收藏" \
      org.opencontainers.image.description="多端网页收藏：Web 阅读器 + 浏览器扩展 + WebDAV 同步" \
      org.opencontainers.image.source="https://github.com/feibixunchang/pagevault" \
      org.opencontainers.image.version="1.5.0" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache tini su-exec

WORKDIR /app

# 只拷运行期需要的东西；server 源码全部用 Node 内置模块，无 node_modules
COPY server/package.json server/server.js server/sync.js server/providers.js server/webdav.js server/zip.js server/dnsx.js ./
COPY server/public ./public
COPY extension ./extension
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8731 \
    PAGEVAULT_DATA=/data \
    PAGEVAULT_PLATFORM=docker \
    PUID=1000 \
    PGID=1000

# 注意 chmod 这步不能省：飞牛 NAS 的 trimafs 在解压 tar 时会把权限位写成 000，
# Docker COPY 会原样带进镜像，node 读 /app/server.js 就报 EACCES（实测踩过）。
# 在这里统一修正，宿主文件系统怎么怪都不影响。
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chmod -R a+rX /app \
 && mkdir -p /data/pages \
 && chown -R node:node /app /data

# 数据（页面 HTML + index.json + prefs.json）必须在容器外持久化
VOLUME ["/data"]
EXPOSE 8731

# 用 node 自己探活，避免额外安装 curl/wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8731)+'/api/status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
