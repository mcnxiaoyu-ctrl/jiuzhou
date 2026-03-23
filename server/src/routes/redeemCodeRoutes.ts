/**
 * 兑换码路由
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为游戏内已登录且已创建角色的玩家提供真实服务端兑换入口。
 * 2. 做什么：统一复用兑换码服务、失败尝试防护与角色刷新推送，避免页面直接伪造成功状态或在路由里散落防爆破判断。
 * 3. 不做什么：不拼奖励内容、不做本地缓存去重，也不处理爱发电回调。
 *
 * 输入/输出：
 * - 输入：请求体中的兑换码字符串。
 * - 输出：标准业务响应 `{ success, message, data? }`。
 *
 * 数据流/状态流：
 * 前端设置页 -> 本路由 -> attemptGuardService -> redeemCodeService -> safePushCharacterUpdate。
 *
 * 关键边界条件与坑点：
 * 1. 兑换必须要求角色上下文，因为奖励会直接发到角色背包。
 * 2. 路由层只校验“非空”和失败尝试防护，具体幂等与发奖事务必须交给服务层。
 * 3. 防爆破只统计真实兑换失败，不把系统异常误记成用户失败，避免 Redis 锁定掩盖服务端故障。
 */
import { Router } from 'express';

import { requireCharacter } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult } from '../middleware/response.js';
import { resolveRequestIp } from '../shared/requestIp.js';
import {
  assertActionAttemptAllowed,
  clearActionAttemptFailures,
  recordActionAttemptFailure,
} from '../services/attemptGuardService.js';
import { redeemCodeService } from '../services/redeemCodeService.js';

const router = Router();

router.use(requireCharacter);

router.post('/redeem', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code.trim()) {
    throw new BusinessError('兑换码不能为空');
  }
  const requestIp = resolveRequestIp(req);
  const attemptScope = {
    action: 'redeem-code' as const,
    subject: String(userId),
    ip: requestIp,
  };
  await assertActionAttemptAllowed(attemptScope);

  const result = await redeemCodeService.redeemCode(userId, characterId, code);
  if (result.success) {
    await clearActionAttemptFailures(attemptScope);
    await safePushCharacterUpdate(userId);
  } else {
    await recordActionAttemptFailure(attemptScope);
  }
  sendResult(res, result);
}));

export default router;
