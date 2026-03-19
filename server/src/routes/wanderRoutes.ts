import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { sendResult } from '../middleware/response.js';
import { wanderService } from '../services/wander/service.js';

/**
 * 云游奇遇路由
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供云游奇遇概览、当日生成与选项确认接口。
 * 2. 做什么：只负责角色鉴权、读取参数并透传到云游服务。
 * 3. 不做什么：不重复实现每日校验、AI 调用或正式称号发放逻辑。
 *
 * 输入/输出：
 * - 输入：已登录且已创建角色的请求；确认接口额外接收 `episodeId` 与 `optionIndex`。
 * - 输出：统一 `{ success, message, data }` 响应。
 *
 * 数据流/状态流：
 * 前端弹窗 -> `/api/wander/*` -> `wanderService` -> 返回云游概览/剧情结果。
 *
 * 关键边界条件与坑点：
 * 1. 所有接口都依赖 `requireCharacter`，因此游客态和未建角账号不会进入云游逻辑。
 * 2. 选项确认只接受显式 `optionIndex`，不做字符串别名兼容，避免接口语义继续发散。
 */

const router = Router();

router.get('/overview', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await wanderService.getOverview(characterId);
  sendResult(res, result);
}));

router.post('/generate', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await wanderService.generateTodayEpisode(characterId);
  sendResult(res, result);
}));

router.post('/choose', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { episodeId?: string; optionIndex?: number | string };
  const episodeId = typeof body.episodeId === 'string' ? body.episodeId.trim() : '';
  const optionIndex = typeof body.optionIndex === 'string' ? Number(body.optionIndex) : Number(body.optionIndex);
  const result = await wanderService.chooseEpisode(characterId, episodeId, optionIndex);
  sendResult(res, result);
}));

export default router;
