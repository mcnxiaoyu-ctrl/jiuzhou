# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# CDN 静态资源地址（构建时传入，可选）
ARG VITE_CDN_BASE=""

# 安装 pnpm 并对齐 lockfile 相关配置
# 说明：
# 1) auto-install-peers 必须与 pnpm-lock.yaml.settings.autoInstallPeers 一致
# 否则 --frozen-lockfile 会触发配置不匹配错误并中断构建
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set auto-install-peers true

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter client

# Copy client source
COPY client ./client

# Build with CDN base URL
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
