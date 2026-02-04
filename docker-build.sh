#!/bin/bash

set -e

REGISTRY="ccr.ccs.tencentyun.com/tcb-100001011660-qtgo"
VERSION=${1:-latest}

# COS 配置（可通过环境变量覆盖）
COS_BUCKET=${COS_BUCKET:-""}
COS_REGION=${COS_REGION:-"ap-guangzhou"}
COS_PATH=${COS_PATH:-"/jiuzhou"}
CDN_DOMAIN=${CDN_DOMAIN:-""}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo "🚀 Building and pushing to $REGISTRY..."

# 如果配置了 COS，先本地构建并上传静态资源
CDN_BASE=""
if [ -n "$COS_BUCKET" ]; then
    log_info "📦 检测到 COS 配置，将上传静态资源到 CDN"

    # 检查 coscmd
    if ! command -v coscmd &> /dev/null; then
        log_error "coscmd 未安装，请先执行: pip install coscmd"
        exit 1
    fi

    # 检查 pnpm
    if ! command -v pnpm &> /dev/null; then
        log_error "pnpm 未安装"
        exit 1
    fi

    # 计算 CDN 地址
    if [ -n "$CDN_DOMAIN" ]; then
        CDN_BASE="https://${CDN_DOMAIN}${COS_PATH}"
    else
        CDN_BASE="https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com${COS_PATH}"
    fi

    log_info "📡 CDN Base URL: $CDN_BASE"

    # 本地构建前端（使用 CDN 地址）
    log_info "📦 Building client locally with CDN..."
    VITE_CDN_BASE="$CDN_BASE" pnpm --filter client build

    # 上传到 COS
    log_info "☁️  Uploading assets to COS..."
    COS_DEST="${COS_PATH}/assets"

    # 注意：-H 参数在某些 coscmd 版本有 bug，移除后 CDN 侧配置缓存策略
    coscmd upload -rsf --delete "client/dist/assets/" "$COS_DEST/"

    log_info "✅ Assets uploaded to COS"

    # 构建 Docker 镜像（直接复制已构建的文件）
    log_info "📦 Building client Docker image..."
    docker build \
        --build-arg VITE_CDN_BASE="$CDN_BASE" \
        -t $REGISTRY/jiuzhou-client:$VERSION \
        -f client/Dockerfile .
else
    log_warn "⚠️  未配置 COS_BUCKET，跳过 CDN 上传"
    log_info "📦 Building client..."
    docker build \
        -t $REGISTRY/jiuzhou-client:$VERSION \
        -f client/Dockerfile .
fi

log_info "📦 Building server..."
docker build -t $REGISTRY/jiuzhou-server:$VERSION -f server/Dockerfile .

# Push to registry
log_info "⬆️  Pushing client..."
docker push $REGISTRY/jiuzhou-client:$VERSION

log_info "⬆️  Pushing server..."
docker push $REGISTRY/jiuzhou-server:$VERSION

# Tag as latest if version specified
if [ "$VERSION" != "latest" ]; then
    log_info "🏷️  Tagging as latest..."
    docker tag $REGISTRY/jiuzhou-client:$VERSION $REGISTRY/jiuzhou-client:latest
    docker tag $REGISTRY/jiuzhou-server:$VERSION $REGISTRY/jiuzhou-server:latest
    docker push $REGISTRY/jiuzhou-client:latest
    docker push $REGISTRY/jiuzhou-server:latest
fi

echo ""
log_info "✅ Done! Images pushed to $REGISTRY"
echo "   - $REGISTRY/jiuzhou-client:$VERSION"
echo "   - $REGISTRY/jiuzhou-server:$VERSION"
if [ -n "$CDN_BASE" ]; then
    echo "   - CDN: $CDN_BASE"
fi
