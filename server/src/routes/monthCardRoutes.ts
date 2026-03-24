import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { monthCardService } from '../services/monthCardService.js';
import { DEFAULT_MONTH_CARD_ID } from '../services/shared/monthCardBenefits.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult } from '../middleware/response.js';

const router = Router();

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const monthCardId = typeof req.query.monthCardId === 'string' ? req.query.monthCardId : DEFAULT_MONTH_CARD_ID;
  const result = await monthCardService.getMonthCardStatus(userId, monthCardId);
  sendResult(res, result);
}));

router.post('/use-item', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const body = req.body as { monthCardId?: unknown; itemInstanceId?: unknown };
  const monthCardId = typeof body?.monthCardId === 'string' ? body.monthCardId : DEFAULT_MONTH_CARD_ID;
  const itemInstanceId =
    typeof body?.itemInstanceId === 'number'
      ? body.itemInstanceId
      : typeof body?.itemInstanceId === 'string'
        ? Number(body.itemInstanceId)
        : undefined;
  const result = await monthCardService.useMonthCardItem(userId, monthCardId, { itemInstanceId });
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  sendResult(res, result);
}));

router.post('/claim', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const body = req.body as { monthCardId?: unknown };
  const monthCardId = typeof body?.monthCardId === 'string' ? body.monthCardId : DEFAULT_MONTH_CARD_ID;
  const result = await monthCardService.claimMonthCardReward(userId, monthCardId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  sendResult(res, result);
}));

export default router;
