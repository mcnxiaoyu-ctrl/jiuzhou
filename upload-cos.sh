#!/bin/bash
# 上传静态资源到腾讯云 COS
# 使用前需要安装 coscmd: pip install coscmd
# 并配置认证: coscmd config -a <SecretId> -s <SecretKey> -b <Bucket> -r <Region>

set -e

# 配置
COS_BUCKET=${COS_BUCKET:-""}
COS_REGION=${COS_REGION:-"ap-guangzhou"}
COS_PATH=${COS_PATH:-"/jiuzhou"}
LOCAL_DIST="client/dist"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 coscmd 是否安装
check_coscmd() {
    if ! command -v coscmd &> /dev/null; then
        log_error "coscmd 未安装，请先执行: pip install coscmd"
        log_info "然后配置认证: coscmd config -a <SecretId> -s <SecretKey> -b <Bucket> -r <Region>"
        exit 1
    fi
}

# 检查构建产物是否存在
check_dist() {
    if [ ! -d "$LOCAL_DIST" ]; then
        log_error "构建产物不存在: $LOCAL_DIST"
        log_info "请先执行构建: pnpm --filter client build"
        exit 1
    fi

    if [ ! -d "$LOCAL_DIST/assets" ]; then
        log_error "assets 目录不存在: $LOCAL_DIST/assets"
        exit 1
    fi
}

# 上传到 COS
upload_to_cos() {
    local cos_dest="${COS_PATH}/assets"

    log_info "开始上传静态资源到 COS..."
    log_info "  源目录: $LOCAL_DIST/assets"
    log_info "  目标: cos://${COS_BUCKET}${cos_dest}"

    # 上传 assets 目录（带哈希的文件，可以长期缓存）
    coscmd upload -rs --delete "$LOCAL_DIST/assets/" "$cos_dest/" \
        -H "Cache-Control:public, max-age=31536000, immutable"

    log_info "✅ 静态资源上传完成"

    # 返回 CDN 地址
    if [ -n "$CDN_DOMAIN" ]; then
        echo "https://${CDN_DOMAIN}${COS_PATH}"
    else
        echo "https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com${COS_PATH}"
    fi
}

# 显示使用帮助
show_help() {
    echo "用法: $0 [选项]"
    echo ""
    echo "上传前端静态资源到腾讯云 COS"
    echo ""
    echo "环境变量:"
    echo "  COS_BUCKET    COS 存储桶名称 (必需，如: my-bucket-1234567890)"
    echo "  COS_REGION    COS 区域 (默认: ap-guangzhou)"
    echo "  COS_PATH      COS 上的路径前缀 (默认: /jiuzhou)"
    echo "  CDN_DOMAIN    CDN 加速域名 (可选，如: cdn.example.com)"
    echo ""
    echo "示例:"
    echo "  COS_BUCKET=my-bucket-1234567890 $0"
    echo "  COS_BUCKET=my-bucket-1234567890 CDN_DOMAIN=cdn.example.com $0"
    echo ""
    echo "前置条件:"
    echo "  1. 安装 coscmd: pip install coscmd"
    echo "  2. 配置认证: coscmd config -a <SecretId> -s <SecretKey> -b <Bucket> -r <Region>"
    echo "  3. 已执行前端构建: pnpm --filter client build"
}

# 主函数
main() {
    if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
        show_help
        exit 0
    fi

    if [ -z "$COS_BUCKET" ]; then
        log_error "未设置 COS_BUCKET 环境变量"
        echo ""
        show_help
        exit 1
    fi

    check_coscmd
    check_dist
    upload_to_cos
}

main "$@"
