import api from "./core";

// ─── 头像上传（COS 客户端直传 + 本地回退） ───

export interface UploadResponse {
  success: boolean;
  message: string;
  avatarUrl?: string;
}

/**
 * 预签名响应类型
 * - cosEnabled=true：返回预签名 URL，客户端直传到 COS
 * - cosEnabled=false：COS 未配置，客户端需走 FormData 本地上传
 */
type PresignResponse =
  | { success: true; cosEnabled: true; presignUrl: string; avatarUrl: string }
  | { success: true; cosEnabled: false }
  | { success: false; message: string };

/** 获取预签名 URL（同时探测 COS 是否启用） */
const getPresignUrl = (contentType: string): Promise<PresignResponse> => {
  return api.post("/upload/avatar/presign", { contentType });
};

/** 通知服务端客户端直传完成，更新 DB */
const confirmAvatarUpload = (avatarUrl: string): Promise<UploadResponse> => {
  return api.post("/upload/avatar/confirm", { avatarUrl });
};

/** 本地回退：FormData 上传到服务端 */
const uploadAvatarLocal = (file: File): Promise<UploadResponse> => {
  const formData = new FormData();
  formData.append("avatar", file);
  return api.post("/upload/avatar", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
};

/**
 * 上传头像（统一入口）
 *
 * 流程：
 * 1. 请求 presign 端点探测 COS 是否启用
 * 2. COS 启用：PUT 直传文件到预签名 URL → confirm 更新 DB
 * 3. COS 未启用：走 FormData 本地上传
 *
 * 被 PlayerInfo 上传头像处复用，是唯一的头像上传入口。
 */
export const uploadAvatar = async (file: File): Promise<UploadResponse> => {
  const presign = await getPresignUrl(file.type);

  if (!presign.success) {
    return {
      success: false,
      message: (presign as { message: string }).message,
    };
  }

  if (!presign.cosEnabled) {
    return uploadAvatarLocal(file);
  }

  // COS 客户端直传
  const putRes = await fetch(presign.presignUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });

  if (!putRes.ok) {
    return { success: false, message: `COS 上传失败 (${putRes.status})` };
  }

  return confirmAvatarUpload(presign.avatarUrl);
};

// 删除头像
export const deleteAvatar = (): Promise<{
  success: boolean;
  message: string;
}> => {
  return api.delete("/upload/avatar");
};

// 加点接口
export interface AddPointResponse {
  success: boolean;
  message: string;
  data?: {
    attribute: string;
    newValue: number;
    remainingPoints: number;
  };
}

export const addAttributePoint = (
  attribute: "jing" | "qi" | "shen",
  amount: number = 1,
): Promise<AddPointResponse> => {
  return api.post("/attribute/add", { attribute, amount });
};

// 减点
export const removeAttributePoint = (
  attribute: "jing" | "qi" | "shen",
  amount: number = 1,
): Promise<AddPointResponse> => {
  return api.post("/attribute/remove", { attribute, amount });
};

// 批量加点
export const batchAddPoints = (points: {
  jing?: number;
  qi?: number;
  shen?: number;
}): Promise<AddPointResponse> => {
  return api.post("/attribute/batch", points);
};

// 重置属性点
export const resetAttributePoints = (): Promise<{
  success: boolean;
  message: string;
  totalPoints?: number;
}> => {
  return api.post("/attribute/reset");
};
