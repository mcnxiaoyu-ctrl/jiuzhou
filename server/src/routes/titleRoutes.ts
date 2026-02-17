import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter } from '../middleware/auth.js';
import { equipTitle, getTitleList } from '../services/achievementService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();


router.get('/list', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const data = await getTitleList(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'titleRoutes 路由异常', error);
  }
});

router.post('/equip', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { titleId?: unknown; title_id?: unknown };
    const titleId =
      typeof body?.titleId === 'string'
        ? body.titleId
        : typeof body?.title_id === 'string'
          ? body.title_id
          : '';

    const result = await equipTitle(characterId, titleId);
    if (!result.success) return res.status(400).json(result);

    await safePushCharacterUpdate(userId);

    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'titleRoutes 路由异常', error);
  }
});

export default router;
