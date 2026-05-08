import { redis } from '../config/redis.js';
import { query } from '../config/database.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  sendAliyunSmsVerificationCode,
  verifyAliyunSmsVerificationCode,
} from './aliyunSmsVerificationService.js';
import { ACCOUNT_PHONE_VERIFICATION_CONFIG } from './accountPhoneVerificationConfig.js';
import {
  assertPhoneBindingSendLimitAvailable,
  recordPhoneBindingSendSuccess,
} from './shared/phoneBindingSendLimit.js';
import { maskPhoneNumber, normalizeMainlandPhoneNumber } from './shared/phoneNumber.js';

/**
 * 账号手机号验证码服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理未登录态手机号验证码发送、短信验证码校验、手机号唯一性检查和脱敏展示。
 * 2. 做什么：为手机号登录、注册、老账号绑定、找回密码和登录后绑定提供同一条手机号规则入口，避免各路由重复归一化和查库。
 * 3. 不做什么：不签发登录 token，不创建用户，也不渲染前端倒计时。
 *
 * 输入/输出：
 * - 输入：原始手机号、发码用途、请求 IP、短信验证码。
 * - 输出：规范化手机号、脱敏手机号、发送冷却秒数或验证码校验结果。
 *
 * 数据流/状态流：
 * 鉴权路由/账号路由 -> 本服务归一化手机号 -> 查库校验场景 -> Redis 频控 -> 阿里云短信发送/核验 -> 返回业务服务继续登录或绑定。
 *
 * 复用设计说明：
 * - 手机号格式、手机号唯一性、未登录态发码频控都是登录/注册/绑定/找回密码的共同规则，因此集中在这里。
 * - `purpose + phoneNumber + ip` 作为未登录态限流主体，避免把注册和登录验证码混用，也避免没有 userId 时退化成全局线性限制。
 *
 * 关键边界条件与坑点：
 * 1. `users.phone_number` 是手机号归属唯一真值来源，注册和绑定发码前必须先查库，不能只靠最终写库唯一索引兜底。
 * 2. 阿里云验证码由供应商生成和核验，服务端不保存明文验证码；本服务只保存发送冷却与窗口计数。
 */

export type AuthPhoneCodePurpose = 'login' | 'register' | 'legacy-bind' | 'reset-password';

type UserPhoneLookupRow = {
  id: number;
  status: number | null;
};

export type SendAuthPhoneCodeResult = {
  cooldownSeconds: number;
  maskedPhoneNumber: string;
};

const normalizeAuthPhoneNumber = (rawPhoneNumber: string): string => {
  try {
    return normalizeMainlandPhoneNumber(rawPhoneNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : '手机号格式错误，请输入正确的大陆手机号';
    throw new BusinessError(message);
  }
};

export const parseAuthPhoneCodePurpose = (
  rawPurpose: string | undefined,
): AuthPhoneCodePurpose => {
  const normalized = rawPurpose?.trim();
  if (
    normalized === 'login'
    || normalized === 'register'
    || normalized === 'legacy-bind'
    || normalized === 'reset-password'
  ) {
    return normalized;
  }
  throw new BusinessError('验证码用途无效');
};

const assertFeatureEnabled = (): void => {
  if (!ACCOUNT_PHONE_VERIFICATION_CONFIG.enabled) {
    throw new BusinessError('手机号验证码功能未开启');
  }
};

const buildCooldownKey = (
  purpose: AuthPhoneCodePurpose,
  phoneNumber: string,
  requestIp: string,
): string => `auth:phone-code:cooldown:${purpose}:${phoneNumber}:${requestIp}`;

const buildSendLimitSubject = (
  purpose: AuthPhoneCodePurpose,
  phoneNumber: string,
  requestIp: string,
): string => `auth:${purpose}:${phoneNumber}:${requestIp}`;

const getUserByPhoneNumber = async (phoneNumber: string): Promise<UserPhoneLookupRow | null> => {
  const result = await query(
    'SELECT id, status FROM users WHERE phone_number = $1 LIMIT 1',
    [phoneNumber],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as UserPhoneLookupRow;
};

export const assertPhoneNumberAvailableForBinding = async (
  phoneNumber: string,
  currentUserId?: number,
): Promise<void> => {
  const result = currentUserId
    ? await query(
      'SELECT id FROM users WHERE phone_number = $1 AND id <> $2 LIMIT 1',
      [phoneNumber, currentUserId],
    )
    : await query(
      'SELECT id FROM users WHERE phone_number = $1 LIMIT 1',
      [phoneNumber],
    );

  if (result.rows.length > 0) {
    throw new BusinessError('该手机号已绑定其他账号');
  }
};

const assertPurposeAllowsPhone = async (
  purpose: AuthPhoneCodePurpose,
  phoneNumber: string,
): Promise<void> => {
  const user = await getUserByPhoneNumber(phoneNumber);

  if (purpose === 'login' || purpose === 'reset-password') {
    if (!user) {
      throw new BusinessError('手机号未注册');
    }
    if (user.status === 0) {
      throw new BusinessError('账号已被禁用');
    }
    return;
  }

  if (user) {
    throw new BusinessError('该手机号已绑定其他账号');
  }
};

export const normalizeAuthPhoneNumberOrThrow = normalizeAuthPhoneNumber;

export const sendAuthPhoneCode = async (
  rawPhoneNumber: string,
  purpose: AuthPhoneCodePurpose,
  requestIp: string,
): Promise<SendAuthPhoneCodeResult> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeAuthPhoneNumber(rawPhoneNumber);
  await assertPurposeAllowsPhone(purpose, phoneNumber);

  const cooldownKey = buildCooldownKey(purpose, phoneNumber, requestIp);
  const cooldownTtl = await redis.ttl(cooldownKey);
  if (cooldownTtl > 0) {
    throw new BusinessError(`验证码发送过于频繁，请${cooldownTtl}秒后重试`);
  }

  const requestTime = new Date();
  const sendLimitConfig = {
    hourlyLimit: ACCOUNT_PHONE_VERIFICATION_CONFIG.sendHourlyLimit,
    dailyLimit: ACCOUNT_PHONE_VERIFICATION_CONFIG.sendDailyLimit,
  };
  const sendLimitSubject = buildSendLimitSubject(purpose, phoneNumber, requestIp);

  await assertPhoneBindingSendLimitAvailable(sendLimitSubject, sendLimitConfig, requestTime);
  await sendAliyunSmsVerificationCode(phoneNumber);
  await recordPhoneBindingSendSuccess(sendLimitSubject, sendLimitConfig, requestTime);

  await redis.set(
    cooldownKey,
    phoneNumber,
    'EX',
    ACCOUNT_PHONE_VERIFICATION_CONFIG.sendCooldownSeconds,
  );

  return {
    cooldownSeconds: ACCOUNT_PHONE_VERIFICATION_CONFIG.sendCooldownSeconds,
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
  };
};

export const verifyAuthPhoneCode = async (
  rawPhoneNumber: string,
  verificationCode: string,
): Promise<string> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeAuthPhoneNumber(rawPhoneNumber);
  const normalizedCode = verificationCode.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new BusinessError('验证码格式错误');
  }

  const verified = await verifyAliyunSmsVerificationCode(phoneNumber, normalizedCode);
  if (!verified) {
    throw new BusinessError('验证码错误');
  }

  return phoneNumber;
};
