/**
 * 头像上传服务
 *
 * 作用：
 * - COS 启用时：生成预签名 URL 供客户端直传，confirm 阶段更新 DB
 * - COS 未启用时：通过 multer 接收文件写入本地磁盘（本地开发回退方案）
 * - 删除头像（COS 对象或本地文件）
 *
 * 输入/输出：
 * - generatePresignUrl(filename, contentType) → { presignUrl, avatarUrl, cosKey }
 * - confirmAvatar(userId, avatarUrl) → { success, message, avatarUrl }
 * - updateAvatarLocal(userId, file) → { success, message, avatarUrl }（仅本地回退）
 * - deleteAvatar(userId) → { success, message }
 *
 * 数据流（COS 直传）：
 * - 客户端 → POST /presign 获取预签名 URL
 * - 客户端 → PUT 直传文件到 COS
 * - 客户端 → POST /confirm 通知服务端更新 DB、清理旧头像
 *
 * 数据流（本地回退）：
 * - 客户端 → POST /avatar（multipart） → multer 写入本地 → 更新 DB → 清理旧文件
 *
 * 关键边界条件：
 * 1) COS 未配置时自动回退本地磁盘存储，保证本地开发可用
 * 2) 删除旧头像时需兼容两种 URL 格式：COS 完整 URL 和本地 /uploads/ 相对路径
 */
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { query } from "../config/database.js";
import {
  cosClient,
  COS_BUCKET,
  COS_REGION,
  COS_AVATAR_PREFIX,
  COS_DOMAIN,
  COS_ENABLED,
} from "../config/cos.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 本地上传目录（COS 未配置时的回退方案）
const UPLOAD_DIR = path.join(__dirname, "../../uploads/avatars");

if (!COS_ENABLED && !fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── 文件校验 ───

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** MIME → 扩展名映射 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const fileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("只支持 JPG、PNG、GIF、WEBP 格式的图片"));
  }
};

/** 生成唯一文件名（不含目录前缀） */
const generateFilename = (ext: string): string => {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `avatar-${uniqueSuffix}${ext}`;
};

// ─── Multer 实例（仅本地回退使用） ───

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    cb(null, generateFilename(path.extname(file.originalname)));
  },
});

export const avatarUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
});

// ─── COS 操作 ───

/**
 * 生成预签名 PUT URL，供客户端直传。
 *
 * - presignUrl：带签名的 PUT URL（始终使用 COS 默认域名，因为签名与 Host 绑定）
 * - avatarUrl：最终存入 DB 的访问 URL（优先使用自定义域名 COS_DOMAIN）
 */
export const generatePresignUrl = (
  contentType: string,
): Promise<{ presignUrl: string; avatarUrl: string; cosKey: string }> => {
  const ext = MIME_TO_EXT[contentType] || ".jpg";
  const cosKey = `${COS_AVATAR_PREFIX}${generateFilename(ext)}`;

  return new Promise((resolve, reject) => {
    cosClient.getObjectUrl(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: cosKey,
        Method: "PUT",
        Sign: true,
        Expires: 300, // 5 分钟有效
      },
      (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        const presignUrl = data.Url;
        // avatarUrl 优先使用自定义域名
        const avatarUrl = COS_DOMAIN
          ? `https://${COS_DOMAIN}/${cosKey}`
          : presignUrl.split("?")[0];
        resolve({ presignUrl, avatarUrl, cosKey });
      },
    );
  });
};

/** 从腾讯云 COS 删除对象 */
const deleteFromCos = (key: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    cosClient.deleteObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
      },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      },
    );
  });
};

/**
 * 从 COS 完整 URL 中提取对象 Key
 * 例如：https://bucket.cos.region.myqcloud.com/avatars/avatar-123.png → avatars/avatar-123.png
 */
const extractCosKeyFromUrl = (url: string): string | null => {
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  try {
    const parsed = new URL(url);
    return parsed.pathname.slice(1) || null;
  } catch {
    return null;
  }
};

// ─── 删除旧头像（兼容 COS URL 和本地路径两种格式） ───

const deleteOldAvatar = async (avatarValue: string): Promise<void> => {
  if (!avatarValue) return;

  const cosKey = extractCosKeyFromUrl(avatarValue);
  if (cosKey) {
    await deleteFromCos(cosKey).catch((err) => {
      console.error("删除 COS 旧头像失败:", err);
    });
    return;
  }

  const localPath = path.join(__dirname, "../..", avatarValue);
  if (fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
  }
};

// ─── 校验 avatarUrl 合法性（防止客户端伪造） ───

/** 校验 avatarUrl 属于当前 COS Bucket 域名或自定义域名 */
const isValidCosAvatarUrl = (url: string): boolean => {
  if (!url.startsWith("https://")) return false;
  try {
    const parsed = new URL(url);
    const defaultHost = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const allowedHosts = COS_DOMAIN ? [defaultHost, COS_DOMAIN] : [defaultHost];
    if (!allowedHosts.includes(parsed.hostname)) return false;
    const key = parsed.pathname.slice(1);
    return key.startsWith(COS_AVATAR_PREFIX);
  } catch {
    return false;
  }
};

// ─── 对外接口 ───

export { COS_ENABLED };

type UploadResult = { success: boolean; message: string; avatarUrl?: string };

/**
 * 确认客户端直传完成，更新 DB 中的头像 URL 并清理旧头像。
 * 仅在 COS 模式下使用。
 */
export const confirmAvatar = async (
  userId: number,
  avatarUrl: string,
): Promise<UploadResult> => {
  if (!isValidCosAvatarUrl(avatarUrl)) {
    return { success: false, message: "头像地址不合法" };
  }

  const oldResult = await query(
    "SELECT avatar FROM characters WHERE user_id = $1",
    [userId],
  );
  const oldAvatar: string | undefined = oldResult.rows[0]?.avatar;

  await query(
    "UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
    [avatarUrl, userId],
  );

  if (oldAvatar) {
    void deleteOldAvatar(oldAvatar);
  }

  return { success: true, message: "头像更新成功", avatarUrl };
};

/** 更新用户头像（本地磁盘回退方案，仅 COS 未启用时使用） */
export const updateAvatarLocal = async (
  userId: number,
  file: Express.Multer.File,
): Promise<UploadResult> => {
  const oldResult = await query(
    "SELECT avatar FROM characters WHERE user_id = $1",
    [userId],
  );
  const oldAvatar: string | undefined = oldResult.rows[0]?.avatar;

  const avatarUrl = `/uploads/avatars/${file.filename}`;

  await query(
    "UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
    [avatarUrl, userId],
  );

  if (oldAvatar) {
    void deleteOldAvatar(oldAvatar);
  }

  return { success: true, message: "头像更新成功", avatarUrl };
};

/** 删除用户头像 */
export const deleteAvatar = async (
  userId: number,
): Promise<{ success: boolean; message: string }> => {
  const result = await query(
    "SELECT avatar FROM characters WHERE user_id = $1",
    [userId],
  );
  const avatar: string | undefined = result.rows[0]?.avatar;

  if (avatar) {
    await deleteOldAvatar(avatar);
  }

  await query(
    "UPDATE characters SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1",
    [userId],
  );

  return { success: true, message: "头像删除成功" };
};
