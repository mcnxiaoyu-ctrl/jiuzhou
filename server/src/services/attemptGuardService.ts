/**
 * 敏感操作尝试防护服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于 Redis 维护登录、改密、兑换码等敏感操作的失败计数与临时锁定，拦截撞库和爆破。
 * 2. 做什么：把“主体 + IP”“主体”“IP”三种维度的失败统计集中管理，避免每条路由重复拼 Redis key 和阈值判断。
 * 3. 不做什么：不负责验证码校验、不负责密码或兑换码真值校验，也不负责业务成功后的后续流程。
 *
 * 输入/输出：
 * - 输入：敏感操作类型、主体标识（用户名或用户 ID）与请求 IP。
 * - 输出：允许继续尝试时正常返回；超出阈值时抛出 429 BusinessError；失败/成功后负责更新或清理 Redis 计数。
 *
 * 数据流/状态流：
 * 路由层构造尝试作用域 -> `assertActionAttemptAllowed` 检查锁定状态 -> 业务失败 `recordActionAttemptFailure` ->
 * 达阈值后写入 block key -> 后续请求直接 429；业务成功 `clearActionAttemptFailures` 清理主体相关失败计数。
 *
 * 关键边界条件与坑点：
 * 1. Redis key 里的操作类型、主体和 IP 都要做编码，避免特殊字符污染 key 结构，确保不同入口共享同一套键规则。
 * 2. 成功后只清理“主体 + IP / 主体”维度，不清理纯 IP 维度，避免同一出口 IP 上其他异常流量被无意重置。
 */
import { redis } from '../config/redis.js';
import { BusinessError } from '../middleware/BusinessError.js';

export type ActionAttemptAction = 'login' | 'password-change' | 'redeem-code';

export type ActionAttemptScope = {
  action: ActionAttemptAction;
  subject: string;
  ip: string;
};

type AttemptGuardPolicy = {
  failureWindowMs: number;
  blockWindowMs: number;
  subjectIpFailureLimit: number;
  subjectFailureLimit: number;
  ipFailureLimit: number;
  blockedMessage: string;
};

const LOGIN_POLICY: AttemptGuardPolicy = {
  failureWindowMs: 15 * 60 * 1000,
  blockWindowMs: 15 * 60 * 1000,
  subjectIpFailureLimit: 5,
  subjectFailureLimit: 10,
  ipFailureLimit: 20,
  blockedMessage: '登录尝试过于频繁，请15分钟后再试',
};

const PASSWORD_CHANGE_POLICY: AttemptGuardPolicy = {
  failureWindowMs: 10 * 60 * 1000,
  blockWindowMs: 10 * 60 * 1000,
  subjectIpFailureLimit: 5,
  subjectFailureLimit: 8,
  ipFailureLimit: 16,
  blockedMessage: '密码验证失败次数过多，请10分钟后再试',
};

const REDEEM_CODE_POLICY: AttemptGuardPolicy = {
  failureWindowMs: 15 * 60 * 1000,
  blockWindowMs: 15 * 60 * 1000,
  subjectIpFailureLimit: 5,
  subjectFailureLimit: 10,
  ipFailureLimit: 20,
  blockedMessage: '兑换码尝试过于频繁，请15分钟后再试',
};

const ATTEMPT_GUARD_POLICY_MAP: Record<ActionAttemptAction, AttemptGuardPolicy> = {
  login: LOGIN_POLICY,
  'password-change': PASSWORD_CHANGE_POLICY,
  'redeem-code': REDEEM_CODE_POLICY,
};

const normalizeAttemptKeyPart = (value: string, fieldName: string): string => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`${fieldName} 不能为空`);
  }
  return encodeURIComponent(normalizedValue.toLowerCase());
};

const buildAttemptGuardKeys = (scope: ActionAttemptScope) => {
  const normalizedAction = normalizeAttemptKeyPart(scope.action, 'action');
  const normalizedSubject = normalizeAttemptKeyPart(scope.subject, 'subject');
  const normalizedIp = normalizeAttemptKeyPart(scope.ip, 'ip');
  const baseKey = `attempt-guard:${normalizedAction}`;

  return {
    subjectIpFailureKey: `${baseKey}:failure:subject-ip:${normalizedSubject}:${normalizedIp}`,
    subjectFailureKey: `${baseKey}:failure:subject:${normalizedSubject}`,
    ipFailureKey: `${baseKey}:failure:ip:${normalizedIp}`,
    subjectIpBlockKey: `${baseKey}:block:subject-ip:${normalizedSubject}:${normalizedIp}`,
    subjectBlockKey: `${baseKey}:block:subject:${normalizedSubject}`,
    ipBlockKey: `${baseKey}:block:ip:${normalizedIp}`,
  };
};

const getAttemptGuardPolicy = (action: ActionAttemptAction): AttemptGuardPolicy => {
  return ATTEMPT_GUARD_POLICY_MAP[action];
};

const touchFailureCounter = async (redisKey: string, windowMs: number): Promise<number> => {
  const currentCount = await redis.incr(redisKey);
  if (currentCount === 1) {
    await redis.pexpire(redisKey, windowMs);
  }
  return currentCount;
};

const writeBlockKey = async (redisKey: string, blockWindowMs: number): Promise<void> => {
  await redis.psetex(redisKey, blockWindowMs, '1');
};

export const assertActionAttemptAllowed = async (
  scope: ActionAttemptScope,
): Promise<void> => {
  const policy = getAttemptGuardPolicy(scope.action);
  const keys = buildAttemptGuardKeys(scope);
  const blockFlags = await redis.mget(
    keys.subjectIpBlockKey,
    keys.subjectBlockKey,
    keys.ipBlockKey,
  );

  if (blockFlags.some((value) => value === '1')) {
    throw new BusinessError(policy.blockedMessage, 429);
  }
};

export const recordActionAttemptFailure = async (
  scope: ActionAttemptScope,
): Promise<void> => {
  const policy = getAttemptGuardPolicy(scope.action);
  const keys = buildAttemptGuardKeys(scope);
  const [subjectIpFailureCount, subjectFailureCount, ipFailureCount] = await Promise.all([
    touchFailureCounter(keys.subjectIpFailureKey, policy.failureWindowMs),
    touchFailureCounter(keys.subjectFailureKey, policy.failureWindowMs),
    touchFailureCounter(keys.ipFailureKey, policy.failureWindowMs),
  ]);

  const blockTasks: Promise<void>[] = [];
  if (subjectIpFailureCount >= policy.subjectIpFailureLimit) {
    blockTasks.push(writeBlockKey(keys.subjectIpBlockKey, policy.blockWindowMs));
  }
  if (subjectFailureCount >= policy.subjectFailureLimit) {
    blockTasks.push(writeBlockKey(keys.subjectBlockKey, policy.blockWindowMs));
  }
  if (ipFailureCount >= policy.ipFailureLimit) {
    blockTasks.push(writeBlockKey(keys.ipBlockKey, policy.blockWindowMs));
  }

  await Promise.all(blockTasks);
};

export const clearActionAttemptFailures = async (
  scope: ActionAttemptScope,
): Promise<void> => {
  const keys = buildAttemptGuardKeys(scope);
  await redis.del(
    keys.subjectIpFailureKey,
    keys.subjectFailureKey,
    keys.subjectIpBlockKey,
    keys.subjectBlockKey,
  );
};
