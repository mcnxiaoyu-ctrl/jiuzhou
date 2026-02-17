import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter } from '../middleware/auth.js';
import {
  claimAchievement,
  claimAchievementPointsReward,
  getAchievementDetail,
  getAchievementList,
  getAchievementPointsRewards,
  type AchievementListStatusFilter,
} from '../services/achievementService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();


router.get('/list', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as AchievementListStatusFilter) : undefined;
    const page = typeof req.query.page === 'string' ? Number(req.query.page) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    const data = await getAchievementList(characterId, { category, status, page, limit });
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'achievementRoutes 路由异常', error);
  }
});

router.get('/:achievementId', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const achievementId = typeof req.params.achievementId === 'string' ? req.params.achievementId : '';
    const achievement = await getAchievementDetail(characterId, achievementId);
    if (!achievement) return res.status(404).json({ success: false, message: '成就不存在' });

    return res.json({ success: true, message: 'ok', data: { achievement, progress: achievement.progress } });
  } catch (error) {
    return withRouteError(res, 'achievementRoutes 路由异常', error);
  }
});

router.post('/claim', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { achievementId?: unknown; achievement_id?: unknown };
    const achievementId =
      typeof body?.achievementId === 'string'
        ? body.achievementId
        : typeof body?.achievement_id === 'string'
          ? body.achievement_id
          : '';

    const result = await claimAchievement(userId, characterId, achievementId);
    if (!result.success) return res.status(400).json(result);

    await safePushCharacterUpdate(userId);

    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'achievementRoutes 路由异常', error);
  }
});

router.get('/points/rewards', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const data = await getAchievementPointsRewards(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'achievementRoutes 路由异常', error);
  }
});

router.post('/points/claim', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { threshold?: unknown; points_threshold?: unknown };
    const threshold =
      typeof body?.threshold === 'number'
        ? body.threshold
        : typeof body?.points_threshold === 'number'
          ? body.points_threshold
          : typeof body?.threshold === 'string'
            ? Number(body.threshold)
            : typeof body?.points_threshold === 'string'
              ? Number(body.points_threshold)
              : NaN;

    const result = await claimAchievementPointsReward(userId, characterId, threshold);
    if (!result.success) return res.status(400).json(result);

    await safePushCharacterUpdate(userId);

    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'achievementRoutes 路由异常', error);
  }
});

export default router;
