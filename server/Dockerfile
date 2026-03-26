# ==========================================================
# 模块作用：
# 1) 在构建阶段完成 server 编译
# 2) 在独立阶段安装 server 生产依赖
# 3) 运行阶段仅复制构建产物、Prisma 同步所需文件与生产依赖，避免携带构建历史层
#
# 输入/输出：
# - 输入：workspace 清单、server 源码、Prisma schema
# - 输出：server/dist + 生产依赖 node_modules
#
# 数据流：
# base(工具链) -> builder(编译) + prod-deps(生产依赖) -> runner(运行镜像)
#
# 关键边界条件与坑点：
# 1) lockfile 配置必须与 Docker 内 pnpm 配置一致，否则 frozen-lockfile 会失败
# 2) Node 与 pnpm 版本都从单一入口收敛，避免 builder / prod-deps / runner 各自漂移
# 3) 仅保留 server 运行必需依赖，避免把未使用依赖打入生产镜像
# ==========================================================

ARG NODE_BASE_IMAGE=node:24.14.0-alpine

# =======================================
# 基础工具链阶段：统一 Node 24、pnpm 与 workspace 清单
# =======================================
FROM ${NODE_BASE_IMAGE} AS base

WORKDIR /app

# 复用根 packageManager 作为 pnpm 版本单点，避免多个 Dockerfile/阶段重复维护版本号
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 配置 pnpm 镜像源和 lockfile 相关配置，保证构建可复现
RUN corepack enable && \
    corepack install && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm config set auto-install-peers true

# =======================================
# 构建阶段：编译 server
# =======================================
FROM base AS builder

# base 已经携带 workspace 根清单，这里只补充服务端依赖解析所需的子包清单
COPY client/package.json ./client/
COPY server/package.json ./server/

# 仅安装 server 构建依赖，避免 client 依赖进入构建路径
RUN pnpm install --frozen-lockfile --filter jiuzhou-server...

# 再复制服务端源码，避免源码修改导致依赖层失效
COPY server ./server

# 仅执行 TypeScript 构建；数据库结构同步在运行阶段启动前自动执行
RUN pnpm --filter jiuzhou-server build

# =======================================
# 生产依赖阶段：仅安装运行所需依赖
# =======================================
FROM base AS prod-deps

# base 已经携带 workspace 根清单，这里只补充服务端依赖解析所需的子包清单
COPY client/package.json ./client/
COPY server/package.json ./server/

# 安装 server 生产依赖并清理 pnpm 缓存
RUN pnpm install --prod --frozen-lockfile --filter jiuzhou-server... --package-import-method=copy && \
    rm -rf /root/.local/share/pnpm/store /root/.cache

# =======================================
# 运行阶段：仅保留运行必需文件
# =======================================
FROM ${NODE_BASE_IMAGE} AS runner

WORKDIR /app

ENV NODE_ENV=production

# 复制生产依赖（workspace 根 + server 局部链接）
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules

WORKDIR /app/server

# 复制构建产物、Prisma 运行时文件与静态数据
COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/prisma ./prisma
COPY --from=builder /app/server/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/server/scripts/prismaCli.mjs ./scripts/prismaCli.mjs
COPY --from=builder /app/server/src/config/databaseConnection.ts ./src/config/databaseConnection.ts
COPY server/src/data ./src/data
COPY server/package.json ./package.json

# 预创建上传目录，供运行时写入与卷挂载
RUN mkdir -p uploads

EXPOSE 6011

CMD ["sh", "-c", "node scripts/prismaCli.mjs db push --schema prisma/schema.prisma && node dist/app.js"]
