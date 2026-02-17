import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter } from '../middleware/auth.js';
import {
  getMainQuestProgress,
  startDialogue,
  advanceDialogue,
  selectDialogueChoice,
  completeCurrentSection,
  getChapterList,
  getSectionList,
  setMainQuestTracked
} from '../services/mainQuestService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();

// 获取主线进度
router.get('/progress', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const data = await getMainQuestProgress(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 获取章节列表
router.get('/chapters', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const data = await getChapterList(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 获取章节下的任务节列表
router.get('/chapters/:chapterId/sections', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const chapterId = typeof req.params.chapterId === 'string' ? req.params.chapterId : '';
    const data = await getSectionList(characterId, chapterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 开始对话
router.post('/dialogue/start', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { dialogueId?: string };
    const dialogueId = typeof body?.dialogueId === 'string' ? body.dialogueId : undefined;

    const result = await startDialogue(characterId, dialogueId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 推进对话
router.post('/dialogue/advance', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await advanceDialogue(userId, characterId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 选择对话选项
router.post('/dialogue/choice', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { choiceId?: string };
    const choiceId = typeof body?.choiceId === 'string' ? body.choiceId : '';

    if (!choiceId) {
      return res.status(400).json({ success: false, message: '选项ID不能为空' });
    }

    const result = await selectDialogueChoice(userId, characterId, choiceId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 完成任务节并领取奖励
router.post('/section/complete', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await completeCurrentSection(userId, characterId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

// 设置主线任务追踪状态
router.post('/track', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { tracked?: boolean };
    const tracked = body?.tracked === true;

    const result = await setMainQuestTracked(characterId, tracked);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mainQuestRoutes 路由异常', error);
  }
});

export default router;
