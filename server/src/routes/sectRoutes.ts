import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter } from '../middleware/auth.js';
import {
  acceptSectQuest,
  applyToSect,
  appointPosition,
  buyFromSectShop,
  cancelMyApplication,
  claimSectQuest,
  createSect,
  disbandSect,
  donate,
  getBuildings,
  getCharacterSect,
  getSectBonuses,
  getSectInfo,
  getSectLogs,
  getSectQuests,
  getSectShop,
  handleApplication,
  kickMember,
  leaveSect,
  listApplications,
  listMyApplications,
  searchSects,
  submitSectQuest,
  transferLeader,
  updateSectAnnouncement,
  upgradeBuilding,
} from '../services/sectService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();



const parseBodyNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

router.use(requireCharacter);

router.get('/me', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await getCharacterSect(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/search', async (req: Request, res: Response) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const page = typeof req.query.page === 'string' ? Number(req.query.page) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const result = await searchSects(keyword, page, limit);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/create', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { name?: unknown; description?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description : undefined;

    if (!name) return res.status(400).json({ success: false, message: '宗门名称不能为空' });
    if (name.length > 16) return res.status(400).json({ success: false, message: '宗门名称过长' });

    const result = await createSect(characterId, name, description);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/apply', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { sectId?: unknown; message?: unknown };
    const sectId = typeof body?.sectId === 'string' ? body.sectId : '';
    const message = typeof body?.message === 'string' ? body.message : undefined;
    const result = await applyToSect(characterId, sectId, message);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/applications/list', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await listApplications(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/applications/mine', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await listMyApplications(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/applications/handle', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { applicationId?: unknown; approve?: unknown };
    const applicationId = parseBodyNumber(body?.applicationId);
    const approve = typeof body?.approve === 'boolean' ? body.approve : body?.approve === 'true';
    if (!applicationId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await handleApplication(characterId, applicationId, approve);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/applications/cancel', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const body = req.body as { applicationId?: unknown };
    const applicationId = parseBodyNumber(body?.applicationId);
    if (!applicationId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await cancelMyApplication(characterId, applicationId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/leave', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const result = await leaveSect(characterId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/kick', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { targetId?: unknown };
    const targetId = parseBodyNumber(body?.targetId);
    if (!targetId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await kickMember(characterId, targetId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/appoint', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const body = req.body as { targetId?: unknown; position?: unknown };
    const targetId = parseBodyNumber(body?.targetId);
    const position = typeof body?.position === 'string' ? body.position : '';
    if (!targetId || !position) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await appointPosition(characterId, targetId, position);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/transfer', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const body = req.body as { newLeaderId?: unknown };
    const newLeaderId = parseBodyNumber(body?.newLeaderId);
    if (!newLeaderId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await transferLeader(characterId, newLeaderId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/disband', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await disbandSect(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/announcement/update', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { announcement?: unknown };
    const announcement = typeof body?.announcement === 'string' ? body.announcement : '';
    const result = await updateSectAnnouncement(characterId, announcement);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/donate', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { spiritStones?: unknown };
    const result = await donate(characterId, parseBodyNumber(body?.spiritStones));
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/buildings/list', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await getBuildings(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/buildings/upgrade', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const body = req.body as { buildingType?: unknown };
    const buildingType = typeof body?.buildingType === 'string' ? body.buildingType.trim() : '';
    if (!buildingType) return res.status(400).json({ success: false, message: '参数错误' });
    if (buildingType !== 'hall') {
      return res.status(400).json({ success: false, message: '当前仅开放宗门大殿升级' });
    }
    const result = await upgradeBuilding(characterId, buildingType);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/bonuses', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await getSectBonuses(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/quests', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await getSectQuests(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/quests/accept', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const body = req.body as { questId?: unknown };
    const questId = typeof body?.questId === 'string' ? body.questId : '';
    if (!questId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await acceptSectQuest(characterId, questId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/quests/claim', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { questId?: unknown };
    const questId = typeof body?.questId === 'string' ? body.questId : '';
    if (!questId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await claimSectQuest(characterId, questId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/quests/submit', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { questId?: unknown; quantity?: unknown };
    const questId = typeof body?.questId === 'string' ? body.questId : '';
    const quantity = parseBodyNumber(body?.quantity);
    if (!questId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await submitSectQuest(characterId, questId, quantity);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/shop', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const result = await getSectShop(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.post('/shop/buy', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const body = req.body as { itemId?: unknown; quantity?: unknown };
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const quantity = parseBodyNumber(body?.quantity) ?? 1;
    if (!itemId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await buyFromSectShop(characterId, itemId, quantity);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const characterId = req.characterId!;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const result = await getSectLogs(characterId, limit);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

router.get('/:sectId', async (req: Request, res: Response) => {
  try {
    const sectIdRaw = req.params.sectId;
    const sectId = Array.isArray(sectIdRaw) ? sectIdRaw[0] : sectIdRaw;
    if (!sectId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await getSectInfo(sectId);
    return res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    return withRouteError(res, 'sectRoutes 路由异常', error);
  }
});

export default router;
