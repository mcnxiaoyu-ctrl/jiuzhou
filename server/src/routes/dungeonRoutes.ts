import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, getOptionalUserId } from '../middleware/auth.js';
import {
  dungeonService,
  type DungeonType,
} from '../domains/dungeon/index.js';
import { getSingleParam, getSingleQueryValue } from '../services/shared/httpParam.js';
import { sendSuccess, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';

const router = Router();



const toType = (v: unknown): DungeonType | undefined => {
  if (v === 'material' || v === 'equipment' || v === 'trial' || v === 'challenge' || v === 'event') return v;
  return undefined;
};

router.get('/categories', asyncHandler(async (_req, res) => {
  const categories = await dungeonService.getDungeonCategories();
  sendSuccess(res, { categories });
}));

router.get('/list', asyncHandler(async (req, res) => {
  const type = toType(getSingleQueryValue(req.query.type));
  const qValue = getSingleQueryValue(req.query.q).trim();
  const realmValue = getSingleQueryValue(req.query.realm).trim();
  const q = qValue || undefined;
  const realm = realmValue || undefined;
  const dungeons = await dungeonService.getDungeonList({ type, q, realm });
  sendSuccess(res, { dungeons });
}));

router.get('/preview/:id', asyncHandler(async (req, res) => {
  const id = getSingleParam(req.params.id);
  const rankRaw = getSingleQueryValue(req.query.rank).trim();
  const rankCandidate = rankRaw ? Number(rankRaw) : 1;
  const rank = Number.isFinite(rankCandidate) ? rankCandidate : 1;
  const userId = getOptionalUserId(req);
  const preview = await dungeonService.getDungeonPreview(id, rank, userId);
  if (!preview) {
    throw new BusinessError('秘境不存在', 404);
  }
  sendSuccess(res, preview);
}));

router.post('/instance/create', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const dungeonId = typeof req.body?.dungeonId === 'string' ? req.body.dungeonId : '';
  const difficultyRankRaw = req.body?.difficultyRank;
  const difficultyRank = typeof difficultyRankRaw === 'number' ? difficultyRankRaw : Number(difficultyRankRaw ?? 1);
  if (!dungeonId) {
    throw new BusinessError('缺少秘境ID');
  }
  const result = await dungeonService.createDungeonInstance(
    userId,
    dungeonId,
    Number.isFinite(difficultyRank) ? difficultyRank : 1
  );
  sendResult(res, result);
}));

router.post('/instance/join', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
  if (!instanceId) {
    throw new BusinessError('缺少实例ID');
  }
  const result = await dungeonService.joinDungeonInstance(userId, instanceId);
  sendResult(res, result);
}));

router.post('/instance/start', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
  if (!instanceId) {
    throw new BusinessError('缺少实例ID');
  }
  const result = await dungeonService.startDungeonInstance(userId, instanceId);
  sendResult(res, result);
}));

router.post('/instance/next', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
  if (!instanceId) {
    throw new BusinessError('缺少实例ID');
  }
  const result = await dungeonService.nextDungeonInstance(userId, instanceId);
  sendResult(res, result);
}));

router.get('/instance/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const id = getSingleParam(req.params.id);
  if (!id) {
    throw new BusinessError('缺少实例ID');
  }
  const result = await dungeonService.getDungeonInstance(userId, id);
  sendResult(res, result);
}));

export default router;
