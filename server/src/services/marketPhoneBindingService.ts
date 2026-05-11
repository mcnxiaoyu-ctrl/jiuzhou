import crypto from 'crypto';
import { redis } from '../config/redis.js';
import { query } from '../config/database.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  sendAliyunSmsVerificationCode,
  verifyAliyunSmsVerificationCode,
} from './aliyunSmsVerificationService.js';
import {
  assertPhoneNumberAvailableForBinding,
  normalizeAuthPhoneNumberOrThrow,
} from './accountPhoneVerificationService.js';
import { MARKET_PHONE_BINDING_CONFIG } from './marketPhoneBindingConfig.js';
import {
  assertPhoneBindingSendLimitAvailable,
  recordPhoneBindingSendSuccess,
} from './shared/phoneBindingSendLimit.js';
import { maskPhoneNumber } from './shared/phoneNumber.js';

/**
 * 账号手机号绑定服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理手机号绑定状态读取、验证码发送、验证码校验、首次绑定与两步式更换绑定写库逻辑。
 * 2. 做什么：把 `users.phone_number` 的账号级绑定口径与 Redis 发送冷却统一收敛，供账号接口复用。
 * 3. 不做什么：不处理 HTTP 响应，不直接挂载路由，也不负责前端倒计时展示。
 *
 * 输入/输出：
 * - 输入：用户 ID、手机号、原手机号验证码、新手机号验证码、换绑凭证。
 * - 输出：绑定状态 DTO、发送成功结果、换绑凭证、绑定/换绑成功后的脱敏手机号。
 *
 * 数据流/状态流：
 * 账号接口 -> 本服务 -> 读配置/Redis/数据库 -> 返回状态或抛业务异常。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `users.phone_number` 是最终真值来源；验证码真值由阿里云生成并核验，服务端本地只保留发送冷却，不保留验证码明文。
 * 2. 游戏内坊市/聊天已不再读取绑定状态；账号接口仍集中在本服务，避免状态、发码与换绑规则散落到路由层。
 */

type UserPhoneBindingRow = {
  phone_number: string | null;
};

export type PhoneBindingStatusDto = {
  enabled: boolean;
  isBound: boolean;
  maskedPhoneNumber: string | null;
};

type SendPhoneBindingCodeResult = {
  cooldownSeconds: number;
};

type BindPhoneNumberResult = {
  maskedPhoneNumber: string;
};

type VerifyCurrentPhoneForChangeResult = {
  changeToken: string;
  expiresSeconds: number;
};

const PHONE_CHANGE_TOKEN_EXPIRE_SECONDS = 10 * 60;

const buildCooldownKey = (
  userId: number,
  scene: 'bind' | 'change-current' | 'change-new',
): string => `market:phone-binding:cooldown:${scene}:${userId}`;
const buildPhoneChangeTokenKey = (
  userId: number,
  changeToken: string,
): string => `market:phone-binding:change-token:${userId}:${changeToken}`;

const assertFeatureEnabled = (): void => {
  if (!MARKET_PHONE_BINDING_CONFIG.enabled) {
    throw new BusinessError('坊市手机号绑定功能未开启');
  }
};

const getUserPhoneBindingRow = async (userId: number): Promise<UserPhoneBindingRow | null> => {
  const result = await query(
    'SELECT phone_number FROM users WHERE id = $1 LIMIT 1',
    [userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as UserPhoneBindingRow;
};

const assertUserExists = async (userId: number): Promise<UserPhoneBindingRow> => {
  const row = await getUserPhoneBindingRow(userId);
  if (!row) {
    throw new BusinessError('账号不存在', 404);
  }
  return row;
};

const assertPhoneNotBoundByOtherUser = async (userId: number, phoneNumber: string): Promise<void> => {
  await assertPhoneNumberAvailableForBinding(phoneNumber, userId);
};

const assertPhoneBindingWritable = async (userId: number, phoneNumber: string): Promise<void> => {
  const user = await assertUserExists(userId);
  const currentPhone = user.phone_number;

  if (currentPhone && currentPhone !== phoneNumber) {
    throw new BusinessError('当前账号已绑定其他手机号，暂不支持换绑');
  }

  await assertPhoneNotBoundByOtherUser(userId, phoneNumber);
};

const assertPhoneChangeTargetWritable = async (
  userId: number,
  newPhoneNumber: string,
): Promise<UserPhoneBindingRow> => {
  const user = await assertUserExists(userId);
  const currentPhone = user.phone_number;

  if (!currentPhone) {
    throw new BusinessError('当前账号尚未绑定手机号');
  }

  if (currentPhone === newPhoneNumber) {
    throw new BusinessError('新手机号不能与当前手机号相同');
  }

  await assertPhoneNotBoundByOtherUser(userId, newPhoneNumber);
  return user;
};

const sendPhoneCodeWithUserLimit = async (
  userId: number,
  phoneNumber: string,
  scene: 'bind' | 'change-current' | 'change-new',
): Promise<SendPhoneBindingCodeResult> => {
  const cooldownKey = buildCooldownKey(userId, scene);
  const cooldownTtl = await redis.ttl(cooldownKey);
  if (cooldownTtl > 0) {
    throw new BusinessError(`验证码发送过于频繁，请${cooldownTtl}秒后重试`);
  }

  const requestTime = new Date();
  const sendLimitConfig = {
    hourlyLimit: MARKET_PHONE_BINDING_CONFIG.sendHourlyLimit,
    dailyLimit: MARKET_PHONE_BINDING_CONFIG.sendDailyLimit,
  };

  await assertPhoneBindingSendLimitAvailable(userId, sendLimitConfig, requestTime);
  await sendAliyunSmsVerificationCode(phoneNumber);
  await recordPhoneBindingSendSuccess(userId, sendLimitConfig, requestTime);

  await redis.set(
    cooldownKey,
    phoneNumber,
    'EX',
    MARKET_PHONE_BINDING_CONFIG.sendCooldownSeconds,
  );

  return {
    cooldownSeconds: MARKET_PHONE_BINDING_CONFIG.sendCooldownSeconds,
  };
};

export const getPhoneBindingStatus = async (userId: number): Promise<PhoneBindingStatusDto> => {
  const user = await assertUserExists(userId);
  const phoneNumber = user.phone_number;

  return {
    enabled: MARKET_PHONE_BINDING_CONFIG.enabled,
    isBound: typeof phoneNumber === 'string' && phoneNumber.length > 0,
    maskedPhoneNumber: phoneNumber ? maskPhoneNumber(phoneNumber) : null,
  };
};

export const sendPhoneBindingCode = async (
  userId: number,
  rawPhoneNumber: string,
): Promise<SendPhoneBindingCodeResult> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeAuthPhoneNumberOrThrow(rawPhoneNumber);
  await assertPhoneBindingWritable(userId, phoneNumber);

  return sendPhoneCodeWithUserLimit(userId, phoneNumber, 'bind');
};

export const sendCurrentPhoneChangeCode = async (
  userId: number,
): Promise<SendPhoneBindingCodeResult> => {
  assertFeatureEnabled();

  const user = await assertUserExists(userId);
  if (!user.phone_number) {
    throw new BusinessError('当前账号尚未绑定手机号');
  }

  return sendPhoneCodeWithUserLimit(userId, user.phone_number, 'change-current');
};

export const sendNewPhoneChangeCode = async (
  userId: number,
  rawNewPhoneNumber: string,
): Promise<SendPhoneBindingCodeResult> => {
  assertFeatureEnabled();

  const newPhoneNumber = normalizeAuthPhoneNumberOrThrow(rawNewPhoneNumber);
  await assertPhoneChangeTargetWritable(userId, newPhoneNumber);

  return sendPhoneCodeWithUserLimit(userId, newPhoneNumber, 'change-new');
};

export const bindPhoneNumber = async (
  userId: number,
  rawPhoneNumber: string,
  verificationCode: string,
): Promise<BindPhoneNumberResult> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeAuthPhoneNumberOrThrow(rawPhoneNumber);
  const normalizedCode = verificationCode.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new BusinessError('验证码格式错误');
  }

  await assertPhoneBindingWritable(userId, phoneNumber);

  const verified = await verifyAliyunSmsVerificationCode(phoneNumber, normalizedCode);
  if (!verified) {
    throw new BusinessError('验证码错误');
  }

  await query(
    'UPDATE users SET phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [phoneNumber, userId],
  );

  return {
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
  };
};

export const verifyCurrentPhoneForChange = async (
  userId: number,
  currentPhoneVerificationCode: string,
): Promise<VerifyCurrentPhoneForChangeResult> => {
  assertFeatureEnabled();

  const normalizedCode = currentPhoneVerificationCode.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new BusinessError('原手机号验证码格式错误');
  }

  const user = await assertUserExists(userId);
  const currentPhoneNumber = user.phone_number;
  if (!currentPhoneNumber) {
    throw new BusinessError('当前账号尚未绑定手机号');
  }

  const currentVerified = await verifyAliyunSmsVerificationCode(currentPhoneNumber, normalizedCode);
  if (!currentVerified) {
    throw new BusinessError('原手机号验证码错误');
  }

  const changeToken = crypto.randomBytes(32).toString('hex');
  await redis.set(
    buildPhoneChangeTokenKey(userId, changeToken),
    currentPhoneNumber,
    'EX',
    PHONE_CHANGE_TOKEN_EXPIRE_SECONDS,
  );

  return {
    changeToken,
    expiresSeconds: PHONE_CHANGE_TOKEN_EXPIRE_SECONDS,
  };
};

export const changeBoundPhoneNumber = async (
  userId: number,
  rawNewPhoneNumber: string,
  changeToken: string,
  newPhoneVerificationCode: string,
): Promise<BindPhoneNumberResult> => {
  assertFeatureEnabled();

  const newPhoneNumber = normalizeAuthPhoneNumberOrThrow(rawNewPhoneNumber);
  const normalizedChangeToken = changeToken.trim();
  const newCode = newPhoneVerificationCode.trim();

  if (!normalizedChangeToken) {
    throw new BusinessError('请先完成原手机号验证');
  }

  if (!/^\d{6}$/.test(newCode)) {
    throw new BusinessError('新手机号验证码格式错误');
  }

  const user = await assertPhoneChangeTargetWritable(userId, newPhoneNumber);
  const currentPhoneNumber = user.phone_number;

  if (!currentPhoneNumber) {
    throw new BusinessError('当前账号尚未绑定手机号');
  }

  const changeTokenKey = buildPhoneChangeTokenKey(userId, normalizedChangeToken);
  const verifiedCurrentPhoneNumber = await redis.get(changeTokenKey);
  if (!verifiedCurrentPhoneNumber) {
    throw new BusinessError('原手机号验证已失效，请重新验证');
  }

  if (verifiedCurrentPhoneNumber !== currentPhoneNumber) {
    throw new BusinessError('当前绑定手机号已变化，请重新验证');
  }

  const newVerified = await verifyAliyunSmsVerificationCode(newPhoneNumber, newCode);
  if (!newVerified) {
    throw new BusinessError('新手机号验证码错误');
  }

  await query(
    'UPDATE users SET phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [newPhoneNumber, userId],
  );
  await redis.del(changeTokenKey);

  return {
    maskedPhoneNumber: maskPhoneNumber(newPhoneNumber),
  };
};
