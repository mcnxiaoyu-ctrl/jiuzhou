import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { createQpsLimitMiddleware } from '../middleware/qpsLimit.js';
import { sendResult, sendSuccess } from '../middleware/response.js';
import {
  bindPhoneNumber,
  getPhoneBindingStatus,
  sendPhoneBindingCode,
} from '../services/marketPhoneBindingService.js';
import {
  changePassword,
  getPasswordPolicyError,
} from '../services/authService.js';
import {
  assertActionAttemptAllowed,
  clearActionAttemptFailures,
  recordActionAttemptFailure,
} from '../services/attemptGuardService.js';
import { resolveRequestIp } from '../shared/requestIp.js';
import { verifyCaptchaByProvider } from '../shared/verifyCaptchaByProvider.js';

const router = Router();

const ACCOUNT_SECURITY_QPS_LIMIT_MESSAGE = '账号安全请求过于频繁，请稍后再试';

const changePasswordQpsLimit = createQpsLimitMiddleware({
  keyPrefix: 'qps:account:password-change',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  message: ACCOUNT_SECURITY_QPS_LIMIT_MESSAGE,
  resolveScope: (req) => resolveRequestIp(req),
});

type PhoneBindingSendCodePayload = {
  phoneNumber?: string;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
};

type ChangePasswordPayload = {
  currentPassword?: string;
  newPassword?: string;
};

router.get('/phone-binding/status', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const status = await getPhoneBindingStatus(userId);
  return sendSuccess(res, status);
}));

router.get('/current-ip', requireAuth, asyncHandler(async (req, res) => {
  const requestIp = resolveRequestIp(req);
  return sendSuccess(res, { ip: requestIp });
}));

router.post('/phone-binding/send-code', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const payload = (req.body ?? {}) as PhoneBindingSendCodePayload;
  const { phoneNumber } = payload;
  const requestIp = resolveRequestIp(req);

  if (!phoneNumber || !phoneNumber.trim()) {
    throw new BusinessError('手机号不能为空');
  }

  await verifyCaptchaByProvider({ body: payload, userIp: requestIp });
  const result = await sendPhoneBindingCode(userId, phoneNumber);
  return sendSuccess(res, result);
}));

router.post('/phone-binding/bind', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { phoneNumber, code } = req.body as { phoneNumber?: string; code?: string };

  if (!phoneNumber || !phoneNumber.trim()) {
    throw new BusinessError('手机号不能为空');
  }

  if (!code || !code.trim()) {
    throw new BusinessError('验证码不能为空');
  }

  const result = await bindPhoneNumber(userId, phoneNumber, code);
  return sendSuccess(res, result);
}));

router.post('/password/change', requireAuth, changePasswordQpsLimit, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const payload = (req.body ?? {}) as ChangePasswordPayload;
  const currentPassword = payload.currentPassword ?? '';
  const newPassword = payload.newPassword ?? '';
  const requestIp = resolveRequestIp(req);

  if (!currentPassword || !newPassword) {
    throw new BusinessError('当前密码和新密码不能为空');
  }

  if (currentPassword === newPassword) {
    throw new BusinessError('新密码不能与当前密码相同');
  }

  const passwordPolicyError = getPasswordPolicyError(newPassword);
  if (passwordPolicyError) {
    throw new BusinessError(passwordPolicyError);
  }

  const attemptScope = {
    action: 'password-change' as const,
    subject: String(userId),
    ip: requestIp,
  };
  await assertActionAttemptAllowed(attemptScope);

  const result = await changePassword(userId, currentPassword, newPassword);
  if (result.success) {
    await clearActionAttemptFailures(attemptScope);
  } else {
    await recordActionAttemptFailure(attemptScope);
  }
  return sendResult(res, result);
}));

export default router;
