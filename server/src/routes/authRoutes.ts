import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createQpsLimitMiddleware } from '../middleware/qpsLimit.js';
import {
  getPasswordPolicyError,
  login,
  register,
  verifyTokenAndSession,
} from '../services/authService.js';
import {
  assertActionAttemptAllowed,
  clearActionAttemptFailures,
  recordActionAttemptFailure,
} from '../services/attemptGuardService.js';
import { createCaptcha } from '../services/captchaService.js';
import { isTencentCaptchaProvider } from '../config/captchaConfig.js';
import { sendSuccess, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { resolveRequestIp } from '../shared/requestIp.js';
import { verifyCaptchaByProvider } from '../shared/verifyCaptchaByProvider.js';
import { checkCharacter } from '../domains/character/index.js';

const router = Router();

const AUTH_QPS_LIMIT_MESSAGE = '认证请求过于频繁，请稍后再试';

const registerQpsLimit = createQpsLimitMiddleware({
  keyPrefix: 'qps:auth:register',
  limit: 6,
  windowMs: 10 * 60 * 1000,
  message: AUTH_QPS_LIMIT_MESSAGE,
  resolveScope: (req) => resolveRequestIp(req),
});

const loginQpsLimit = createQpsLimitMiddleware({
  keyPrefix: 'qps:auth:login',
  limit: 12,
  windowMs: 60 * 1000,
  message: AUTH_QPS_LIMIT_MESSAGE,
  resolveScope: (req) => resolveRequestIp(req),
});

type AuthPayload = {
  username?: string;
  password?: string;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
};

// 获取图片验证码（仅 local 模式有效；tencent 模式下前端不需要此端点）
router.get('/captcha', asyncHandler(async (_req, res) => {
  if (isTencentCaptchaProvider) {
    throw new BusinessError('当前验证码模式不支持此操作');
  }
  const result = await createCaptcha();
  sendSuccess(res, result);
}));

// 注册接口
router.post('/register', registerQpsLimit, asyncHandler(async (req, res) => {
  const payload = (req.body ?? {}) as AuthPayload;
  const username = payload.username?.trim() ?? '';
  const password = payload.password ?? '';
  const requestIp = resolveRequestIp(req);

  if (!username || !password) {
    throw new BusinessError('用户名和密码不能为空');
  }

  if (username.length < 2 || username.length > 20) {
    throw new BusinessError('用户名长度需在2-20个字符之间');
  }

  const passwordPolicyError = getPasswordPolicyError(password);
  if (passwordPolicyError) {
    throw new BusinessError(passwordPolicyError);
  }

  await verifyCaptchaByProvider({ body: payload, userIp: requestIp });
  const result = await register(username, password);
  sendResult(res, result);
}));

// 登录接口
router.post('/login', loginQpsLimit, asyncHandler(async (req, res) => {
  const payload = (req.body ?? {}) as AuthPayload;
  const username = payload.username?.trim() ?? '';
  const password = payload.password ?? '';
  const requestIp = resolveRequestIp(req);

  if (!username || !password) {
    throw new BusinessError('用户名和密码不能为空');
  }

  const attemptScope = {
    action: 'login' as const,
    subject: username,
    ip: requestIp,
  };
  await assertActionAttemptAllowed(attemptScope);

  await verifyCaptchaByProvider({ body: payload, userIp: requestIp });
  const result = await login(username, password);
  if (result.success) {
    await clearActionAttemptFailures(attemptScope);
  } else {
    await recordActionAttemptFailure(attemptScope);
  }
  sendResult(res, result);
}));

// 验证会话接口（用于持久登录和单点登录检查）
router.get('/verify', asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }

  const token = authHeader.split(' ')[1];
  const result = await verifyTokenAndSession(token);

  if (!result.valid) {
    if (result.kicked) {
      res.status(401).json({ success: false, message: '账号已在其他设备登录', kicked: true });
    } else {
      throw new BusinessError('登录状态无效，请重新登录', 401);
    }
    return;
  }

  sendSuccess(res, { userId: result.decoded?.id });
}));

// 启动信息接口（用于持久登录恢复，合并 verify + character/check）
router.get('/bootstrap', asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }

  const token = authHeader.split(' ')[1];
  const result = await verifyTokenAndSession(token);

  if (!result.valid) {
    if (result.kicked) {
      res.status(401).json({ success: false, message: '账号已在其他设备登录', kicked: true });
    } else {
      throw new BusinessError('登录状态无效，请重新登录', 401);
    }
    return;
  }

  const userId = Number(result.decoded?.id ?? 0);
  const characterResult = await checkCharacter(userId);
  sendSuccess(res, {
    userId,
    hasCharacter: characterResult.data?.hasCharacter === true,
  });
}));

export default router;
