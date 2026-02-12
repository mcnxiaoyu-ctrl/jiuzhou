/**
 * 头像上传路由
 */
import { Router, NextFunction, Request, Response } from 'express';
import { avatarUpload, updateAvatar, deleteAvatar } from '../services/uploadService.js';
import { verifyToken } from '../services/authService.js';
import { getGameServer } from '../game/GameServer.js';

const router = Router();

// 验证token中间件
const authMiddleware = (req: Request, res: Response, next: () => void) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: '未登录' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const { valid, decoded } = verifyToken(token);

  if (!valid || !decoded) {
    res.status(401).json({ success: false, message: '登录已过期' });
    return;
  }

  (req as Request & { userId: number }).userId = decoded.id;
  next();
};

const avatarUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  avatarUpload.single('avatar')(req, res, (error?: Error | string | null) => {
    if (!error) {
      next();
      return;
    }

    if (typeof error === 'string') {
      res.status(400).json({ success: false, message: error });
      return;
    }

    const uploadError = error as Error & { name?: string; code?: string };
    if (uploadError.name === 'MulterError' && uploadError.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ success: false, message: '图片大小不能超过2MB' });
      return;
    }

    if (uploadError.message.includes('只支持')) {
      res.status(400).json({ success: false, message: uploadError.message });
      return;
    }

    console.error('上传头像错误:', uploadError);
    res.status(500).json({ success: false, message: '上传失败' });
  });
};

// 上传头像
router.post(
  '/avatar',
  authMiddleware,
  avatarUploadMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as Request & { userId: number }).userId;
      const file = req.file;

      if (!file) {
        res.status(400).json({ success: false, message: '请选择图片文件' });
        return;
      }

      const result = await updateAvatar(userId, file.filename);

      if (result.success) {
        // 推送角色更新
        try {
          const gameServer = getGameServer();
          await gameServer.pushCharacterUpdate(userId);
        } catch {
          // 游戏服务器可能未初始化，忽略
        }
      }

      res.json(result);
    } catch (error) {
      console.error('上传头像错误:', error);
      if ((error as Error).message?.includes('只支持')) {
        res.status(400).json({ success: false, message: (error as Error).message });
      } else {
        res.status(500).json({ success: false, message: '上传失败' });
      }
    }
  }
);

// 删除头像
router.delete('/avatar', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const result = await deleteAvatar(userId);

    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {
        // 忽略
      }
    }

    res.json(result);
  } catch (error) {
    console.error('删除头像错误:', error);
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

export default router;
