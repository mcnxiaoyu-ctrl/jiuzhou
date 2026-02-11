import { Router, Request, Response } from 'express';
import {
  checkCharacter,
  createCharacter,
  getCharacter,
  updateCharacterAutoCastSkills,
  updateCharacterAutoDisassembleSettings,
  updateCharacterPosition,
} from '../services/characterService.js';
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

// 检查是否有角色
router.get('/check', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const result = await checkCharacter(userId);
    res.json(result);
  } catch (error) {
    console.error('检查角色接口错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 创建角色
router.post('/create', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const { nickname, gender } = req.body;

    // 参数验证
    if (!nickname || !gender) {
      res.status(400).json({ success: false, message: '道号和性别不能为空' });
      return;
    }

    if (nickname.length < 2 || nickname.length > 12) {
      res.status(400).json({ success: false, message: '道号长度需在2-12个字符之间' });
      return;
    }

    if (!['male', 'female'].includes(gender)) {
      res.status(400).json({ success: false, message: '性别参数错误' });
      return;
    }

    const result = await createCharacter(userId, nickname, gender);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('创建角色接口错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 获取角色信息
router.get('/info', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const result = await getCharacter(userId);
    res.json(result);
  } catch (error) {
    console.error('获取角色接口错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 更新玩家位置
router.post('/updatePosition', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const { currentMapId, currentRoomId } = req.body as { currentMapId?: string; currentRoomId?: string };

    const result = await updateCharacterPosition(userId, currentMapId ?? '', currentRoomId ?? '');

    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {
        // 忽略
      }
    }

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('更新位置接口错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/updateAutoCastSkills', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);

    const result = await updateCharacterAutoCastSkills(userId, enabled);

    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {
        // 忽略
      }
    }

    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('更新自动释放技能开关接口错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/updateAutoDisassemble', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId: number }).userId;
    const body = req.body as { enabled?: unknown; maxQualityRank?: unknown };

    const enabled = Boolean(body?.enabled);
    const parsedRank =
      body?.maxQualityRank === undefined || body?.maxQualityRank === null
        ? undefined
        : Number(body.maxQualityRank);

    if (parsedRank !== undefined && (!Number.isInteger(parsedRank) || parsedRank < 1 || parsedRank > 4)) {
      return res.status(400).json({ success: false, message: 'maxQualityRank参数错误' });
    }

    const result = await updateCharacterAutoDisassembleSettings(userId, enabled, parsedRank);

    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {
        // 忽略
      }
    }

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('更新自动分解设置接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

export default router;
