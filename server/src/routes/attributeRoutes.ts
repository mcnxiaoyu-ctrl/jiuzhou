import { Router, Request, Response } from 'express';
/**
 * 属性加点路由
 */
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth } from '../middleware/auth.js';
import { addAttributePoint, removeAttributePoint, batchAddPoints, resetAttributePoints } from '../services/attributeService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();

// 单属性加点
router.post('/add', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { attribute, amount = 1 } = req.body;

    if (!attribute) {
      res.status(400).json({ success: false, message: '请指定属性类型' });
      return;
    }

    const result = await addAttributePoint(userId, attribute, amount);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'attributeRoutes 路由异常', error);
  }
});

// 单属性减点
router.post('/remove', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { attribute, amount = 1 } = req.body;

    if (!attribute) {
      res.status(400).json({ success: false, message: '请指定属性类型' });
      return;
    }

    const result = await removeAttributePoint(userId, attribute, amount);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'attributeRoutes 路由异常', error);
  }
});

// 批量加点
router.post('/batch', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { jing, qi, shen } = req.body;

    const result = await batchAddPoints(userId, { jing, qi, shen });

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'attributeRoutes 路由异常', error);
  }
});

// 重置属性点
router.post('/reset', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await resetAttributePoints(userId);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    res.json(result);
  } catch (error) {
    return withRouteError(res, 'attributeRoutes 路由异常', error);
  }
});

export default router;
