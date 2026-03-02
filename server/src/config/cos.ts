/**
 * 腾讯云 COS 客户端配置
 *
 * 作用：
 * - 初始化并导出 COS 客户端实例，供上传/删除等服务复用
 * - 集中管理 COS 相关配置（SecretId、SecretKey、Bucket、Region）
 *
 * 输入/输出：
 * - 输入：环境变量 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION / COS_AVATAR_PREFIX / COS_DOMAIN
 * - 输出：cosClient 实例、bucket / region / avatarPrefix 常量
 *
 * 数据流：
 * - 从 process.env 读取配置 → 初始化 COS SDK → 导出供 uploadService 等使用
 *
 * 关键边界条件：
 * 1) 缺少必要环境变量时会在启动阶段打印警告，但不会阻止服务启动（兼容本地开发不配置 COS 的场景）
 * 2) avatarPrefix 默认为 'avatars/'，最终 COS 对象键为 `avatars/avatar-{timestamp}-{rand}.{ext}`
 */
import COS from "cos-nodejs-sdk-v5";

export const COS_SECRET_ID = process.env.COS_SECRET_ID ?? "";
export const COS_SECRET_KEY = process.env.COS_SECRET_KEY ?? "";
export const COS_BUCKET = process.env.COS_BUCKET ?? "";
export const COS_REGION = process.env.COS_REGION ?? "";
/** COS 对象键前缀，末尾含 '/' */
export const COS_AVATAR_PREFIX = process.env.COS_AVATAR_PREFIX || "avatars/";

/**
 * 自定义域名（不含协议和末尾 /），例如 'oss.example.com'
 * 配置后 avatarUrl 会使用此域名而非默认的 bucket.cos.region.myqcloud.com
 */
export const COS_DOMAIN = (process.env.COS_DOMAIN ?? "").replace(/\/+$/, "");

/** COS 配置是否齐全，齐全时才启用 COS 上传 */
export const COS_ENABLED =
  COS_SECRET_ID !== "" &&
  COS_SECRET_KEY !== "" &&
  COS_BUCKET !== "" &&
  COS_REGION !== "";

if (!COS_ENABLED) {
  console.warn("⚠ 腾讯云 COS 环境变量未完整配置，头像上传将回退到本地磁盘存储");
}

export const cosClient = new COS({
  SecretId: COS_SECRET_ID,
  SecretKey: COS_SECRET_KEY,
});
