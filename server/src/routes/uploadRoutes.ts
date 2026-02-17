import { Router, NextFunction, Request, Response } from 'express';
/**
 * 头像上传路由
 */
import { requireAuth } from '../middleware/auth.js';
import { avatarUpload, updateAvatar, deleteAvatar } from '../services/uploadService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();

// 验证token中间件

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
  requireAuth,
  avatarUploadMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const file = req.file;

      if (!file) {
        res.status(400).json({ success: false, message: '请选择图片文件' });
        return;
      }

      const result = await updateAvatar(userId, file.filename);

      if (result.success) {
        await safePushCharacterUpdate(userId);
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
router.delete('/avatar', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await deleteAvatar(userId);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    console.error('删除头像错误:', error);
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

export default router;
