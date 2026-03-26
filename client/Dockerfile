# ==========================================================
# 模块作用：
# 1) 在构建阶段完成 client 依赖安装与静态资源构建
# 2) 在运行阶段仅保留 caddy 与前端产物，避免把 Node 构建工具链带入生产镜像
#
# 输入/输出：
# - 输入：workspace 清单、client 源码、Vite 构建时环境变量
# - 输出：client/dist 静态产物
#
# 数据流：
# node24-builder(安装 pnpm + 依赖 + 构建) -> caddy-runner(仅托管产物)
#
# 关键边界条件与坑点：
# 1) pnpm 版本必须与根 package.json 的 packageManager 单点配置一致，否则不同环境下 lockfile 行为会漂移
# 2) 只有根清单和 client/package.json 参与依赖解析，源码复制必须放在依赖安装之后，避免频繁失效缓存层
# ==========================================================

ARG NODE_BASE_IMAGE=node:24.14.0-alpine

# Build stage
FROM ${NODE_BASE_IMAGE} AS builder

WORKDIR /app

# Vite 构建时环境变量（通过 --build-arg 传入，可选）
ARG VITE_API_BASE=""
ARG VITE_CDN_BASE=""

# 先复制 workspace 根清单，用 packageManager 单点激活 pnpm
# 这样 Docker 与本地都复用同一版本来源，避免在多个 Dockerfile 手写版本号
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 配置 pnpm 镜像源与 lockfile 相关配置
# 说明：
# 1) auto-install-peers 必须与 pnpm-lock.yaml.settings.autoInstallPeers 一致
# 否则 --frozen-lockfile 会触发配置不匹配错误并中断构建
RUN corepack enable && \
    corepack install && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set auto-install-peers true

COPY client/package.json ./client/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter client

# Copy client source
COPY client ./client

# Build with Vite env vars
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_CDN_BASE=${VITE_CDN_BASE}
RUN pnpm --filter client build

# Production stage
FROM caddy:alpine

# Copy built files
COPY --from=builder /app/client/dist /srv

# Copy Caddyfile
COPY client/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
