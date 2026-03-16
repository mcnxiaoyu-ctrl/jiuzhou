import { Router } from 'express';
/**
 * 九州修仙录 - 邮件路由
 */
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { mailService } from '../services/mailService.js';
import { sendSuccess, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';

const router = Router();

// 兼容前端把 BIGINT 主键当成字符串传回来的情况
const parseMailId = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
};

const parseAutoDisassemble = (raw: unknown): boolean => {
  if (raw === undefined) return false;
  if (typeof raw === 'boolean') return raw;
  throw new BusinessError('参数错误');
};

router.use(requireCharacter);

// ============================================
// 获取邮件列表
// ============================================
router.get('/list', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 100);

    const result = await mailService.getMailList(userId, characterId, page, pageSize);

    return sendSuccess(res, {
      mails: result.mails,
      total: result.total,
      unreadCount: result.unreadCount,
      unclaimedCount: result.unclaimedCount,
      page,
      pageSize
    });
}));

// ============================================
// 获取未读数量（红点）
// ============================================
router.get('/unread', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await mailService.getUnreadCount(userId, characterId);

    return sendSuccess(res, result);
}));

// ============================================
// 阅读邮件
// ============================================
router.post('/read', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      throw new BusinessError('参数错误');
    }

    const result = await mailService.readMail(userId, characterId, parsedMailId);
    return sendResult(res, result);
}));

// ============================================
// 领取附件
// ============================================
router.post('/claim', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      throw new BusinessError('参数错误');
    }

    const autoDisassemble = parseAutoDisassemble((req.body as { autoDisassemble?: unknown })?.autoDisassemble);
    const result = await mailService.claimAttachments(userId, characterId, parsedMailId, true, autoDisassemble);
    return sendResult(res, result);
}));

// ============================================
// 一键领取所有附件
// ============================================
router.post('/claim-all', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const autoDisassemble = parseAutoDisassemble((req.body as { autoDisassemble?: unknown })?.autoDisassemble);
    const result = await mailService.claimAllAttachments(userId, characterId, autoDisassemble);
    return sendResult(res, result);
}));

// ============================================
// 删除邮件
// ============================================
router.post('/delete', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedMailId = parseMailId((req.body as { mailId?: unknown })?.mailId);
    if (!parsedMailId) {
      throw new BusinessError('参数错误');
    }

    const result = await mailService.deleteMail(userId, characterId, parsedMailId);
    return sendResult(res, result);
}));

// ============================================
// 一键删除所有邮件
// ============================================
router.post('/delete-all', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { onlyRead } = req.body;
    const result = await mailService.deleteAllMails(userId, characterId, !!onlyRead);
    return sendResult(res, result);
}));

// ============================================
// 标记全部已读
// ============================================
router.post('/read-all', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const result = await mailService.markAllRead(userId, characterId);
    return sendResult(res, result);
}));

export default router;
