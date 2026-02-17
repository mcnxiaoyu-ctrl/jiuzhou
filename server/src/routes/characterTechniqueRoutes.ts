import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
/**
 * 九州修仙录 - 角色功法路由
 * 提供功法学习、修炼、装备、技能配置等API
 */
import { requireAuth } from '../middleware/auth.js';
import {
  getCharacterTechniques,
  getEquippedTechniques,
  learnTechnique,
  getTechniqueUpgradeCost,
  upgradeTechnique,
  equipTechnique,
  unequipTechnique,
  getAvailableSkills,
  getEquippedSkills,
  equipSkill,
  unequipSkill,
  calculateTechniquePassives,
  getCharacterTechniqueStatus
} from '../services/characterTechniqueService.js';
import { query } from '../config/database.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();

// 扩展Request类型以包含user和params
interface AuthRequest extends Request<{ characterId: string; techniqueId?: string }> {
  userId?: number;
}

// 辅助函数：安全获取字符串参数
const getStringParam = (param: string | string[] | undefined): string => {
  if (Array.isArray(param)) return param[0] || '';
  return param || '';
};


const characterOwnershipMiddleware = async (req: Request, res: Response, next: () => void) => {
  const characterId = parseInt(getStringParam(req.params.characterId));
  if (isNaN(characterId)) {
    res.status(400).json({ success: false, message: '无效的角色ID' });
    return;
  }

  const userId = req.userId!;
  if (!userId) {
    res.status(401).json({ success: false, message: '登录状态无效，请重新登录' });
    return;
  }

  const result = await query('SELECT id FROM characters WHERE id = $1 AND user_id = $2 LIMIT 1', [characterId, userId]);
  if (result.rows.length === 0) {
    res.status(403).json({ success: false, message: '无权限访问该角色' });
    return;
  }

  next();
};

router.use('/:characterId', requireAuth, characterOwnershipMiddleware);


// ============================================
// 获取角色功法完整状态
// GET /api/character/:characterId/technique/status
// ============================================
router.get('/:characterId/technique/status', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getCharacterTechniqueStatus(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取角色已学习的功法列表
// GET /api/character/:characterId/techniques
// ============================================
router.get('/:characterId/techniques', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getCharacterTechniques(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取角色已装备的功法
// GET /api/character/:characterId/techniques/equipped
// ============================================
router.get('/:characterId/techniques/equipped', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getEquippedTechniques(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 学习功法
// POST /api/character/:characterId/technique/learn
// Body: { techniqueId: string, obtainedFrom?: string, obtainedRefId?: string }
// ============================================
router.post('/:characterId/technique/learn', async (req: AuthRequest, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const { techniqueId, obtainedFrom, obtainedRefId } = req.body;
    if (!techniqueId) {
      res.status(400).json({ success: false, message: '缺少功法ID' });
      return;
    }
    const result = await learnTechnique(characterId, techniqueId, obtainedFrom, obtainedRefId);

    if (result.success) {
      const userId = req.userId!;
      if (userId && Number.isFinite(userId)) {
        await safePushCharacterUpdate(userId);
      }
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取功法升级消耗
// GET /api/character/:characterId/technique/:techniqueId/upgrade-cost
// ============================================
router.get('/:characterId/technique/:techniqueId/upgrade-cost', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    const techniqueId = getStringParam(req.params.techniqueId);
    
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getTechniqueUpgradeCost(characterId, techniqueId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});


// ============================================
// 修炼升级功法
// POST /api/character/:characterId/technique/:techniqueId/upgrade
// ============================================
router.post('/:characterId/technique/:techniqueId/upgrade', async (req: AuthRequest, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    const techniqueId = getStringParam(req.params.techniqueId);
    
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const userId = req.userId! || 0;
    if (!userId) {
      res.status(401).json({ success: false, message: '登录状态无效，请重新登录' });
      return;
    }
    const result = await upgradeTechnique(characterId, techniqueId);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 装备功法
// POST /api/character/:characterId/technique/equip
// Body: { techniqueId: string, slotType: 'main' | 'sub', slotIndex?: number }
// ============================================
router.post('/:characterId/technique/equip', async (req: AuthRequest, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const { techniqueId, slotType, slotIndex } = req.body;
    if (!techniqueId || !slotType) {
      res.status(400).json({ success: false, message: '缺少必要参数' });
      return;
    }
    
    if (slotType !== 'main' && slotType !== 'sub') {
      res.status(400).json({ success: false, message: '无效的槽位类型' });
      return;
    }
    const result = await equipTechnique(characterId, techniqueId, slotType, slotIndex);

    if (result.success) {
      const userId = req.userId!;
      if (userId && Number.isFinite(userId)) {
        await safePushCharacterUpdate(userId);
      }
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 卸下功法
// POST /api/character/:characterId/technique/unequip
// Body: { techniqueId: string }
// ============================================
router.post('/:characterId/technique/unequip', async (req: AuthRequest, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const { techniqueId } = req.body;
    if (!techniqueId) {
      res.status(400).json({ success: false, message: '缺少功法ID' });
      return;
    }
    const result = await unequipTechnique(characterId, techniqueId);

    if (result.success) {
      const userId = req.userId!;
      if (userId && Number.isFinite(userId)) {
        await safePushCharacterUpdate(userId);
      }
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取可用技能列表
// GET /api/character/:characterId/skills/available
// ============================================
router.get('/:characterId/skills/available', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getAvailableSkills(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取已装备的技能槽
// GET /api/character/:characterId/skills/equipped
// ============================================
router.get('/:characterId/skills/equipped', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await getEquippedSkills(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});


// ============================================
// 装备技能
// POST /api/character/:characterId/skill/equip
// Body: { skillId: string, slotIndex: number }
// ============================================
router.post('/:characterId/skill/equip', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const { skillId, slotIndex } = req.body;
    if (!skillId || slotIndex === undefined) {
      res.status(400).json({ success: false, message: '缺少必要参数' });
      return;
    }
    
    const result = await equipSkill(characterId, skillId, slotIndex);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 卸下技能
// POST /api/character/:characterId/skill/unequip
// Body: { slotIndex: number }
// ============================================
router.post('/:characterId/skill/unequip', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const { slotIndex } = req.body;
    if (slotIndex === undefined) {
      res.status(400).json({ success: false, message: '缺少槽位索引' });
      return;
    }
    
    const result = await unequipSkill(characterId, slotIndex);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

// ============================================
// 获取功法被动加成
// GET /api/character/:characterId/technique/passives
// ============================================
router.get('/:characterId/technique/passives', async (req: Request, res: Response) => {
  try {
    const characterId = parseInt(getStringParam(req.params.characterId));
    if (isNaN(characterId)) {
      res.status(400).json({ success: false, message: '无效的角色ID' });
      return;
    }
    
    const result = await calculateTechniquePassives(characterId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'characterTechniqueRoutes 路由异常', error);
  }
});

export default router;
