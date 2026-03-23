/**
 * 敏感操作尝试防护服务测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定兑换码失败计数达到阈值后会写入锁定状态，避免防爆破规则散落在路由里后被改漏。
 * 2. 做什么：验证成功清理时只删除主体相关计数，保留纯 IP 维度统计，确保复用到不同敏感操作时语义一致。
 * 3. 不做什么：不连接真实 Redis，不校验登录/兑换业务本身，也不验证 HTTP 路由响应。
 *
 * 输入/输出：
 * - 输入：模拟的 Redis `mget/incr/pexpire/psetex/del` 行为，以及兑换码尝试作用域。
 * - 输出：允许/拒绝结果、业务错误文案，以及 Redis 计数键的保留/清理断言。
 *
 * 数据流/状态流：
 * - 测试先用 `Map` 模拟 Redis 键值；
 * - 再调用共享防护服务执行“预检查 / 记录失败 / 成功清理”；
 * - 最后断言是否命中锁定，以及各维度键是否按统一规则保留或删除。
 *
 * 关键边界条件与坑点：
 * 1. 兑换码防爆破不能只看 `user + ip`，还要保留纯 IP 维度累计，否则同一出口 IP 可以通过切账号继续爆破。
 * 2. 成功清理不能顺手把纯 IP 维度也删掉，否则会把其他异常流量一起洗掉，破坏共享模块复用价值。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { redis } from '../../config/redis.js';
import { BusinessError } from '../../middleware/BusinessError.js';
import {
  assertActionAttemptAllowed,
  clearActionAttemptFailures,
  recordActionAttemptFailure,
} from '../attemptGuardService.js';

const REDEEM_ATTEMPT_SCOPE = {
  action: 'redeem-code' as const,
  subject: '7',
  ip: '127.0.0.1',
};

const REDEEM_SUBJECT_IP_FAILURE_KEY =
  'attempt-guard:redeem-code:failure:subject-ip:7:127.0.0.1';
const REDEEM_SUBJECT_FAILURE_KEY = 'attempt-guard:redeem-code:failure:subject:7';
const REDEEM_IP_FAILURE_KEY = 'attempt-guard:redeem-code:failure:ip:127.0.0.1';
const REDEEM_SUBJECT_IP_BLOCK_KEY =
  'attempt-guard:redeem-code:block:subject-ip:7:127.0.0.1';
const REDEEM_SUBJECT_BLOCK_KEY = 'attempt-guard:redeem-code:block:subject:7';

const mockAttemptGuardRedis = (t: TestContext): Map<string, string> => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'mget', async (...keys: string[]) => {
    return keys.map((key) => storage.get(key) ?? null);
  });
  t.mock.method(redis, 'incr', async (key: string) => {
    const nextCount = Number(storage.get(key) ?? '0') + 1;
    storage.set(key, String(nextCount));
    return nextCount;
  });
  t.mock.method(redis, 'pexpire', async () => 1);
  t.mock.method(redis, 'psetex', async (key: string, _ttlMs: number, value: string) => {
    storage.set(key, value);
    return 'OK';
  });
  t.mock.method(redis, 'del', async (...keys: string[]) => {
    let deletedCount = 0;
    for (const key of keys) {
      if (storage.delete(key)) {
        deletedCount += 1;
      }
    }
    return deletedCount;
  });

  return storage;
};

test.after(() => {
  redis.disconnect();
});

test('recordActionAttemptFailure: 兑换码连续失败达到阈值后应锁定后续请求', async (t) => {
  mockAttemptGuardRedis(t);

  await assert.doesNotReject(assertActionAttemptAllowed(REDEEM_ATTEMPT_SCOPE));

  for (let failureCount = 0; failureCount < 5; failureCount += 1) {
    await recordActionAttemptFailure(REDEEM_ATTEMPT_SCOPE);
  }

  await assert.rejects(
    assertActionAttemptAllowed(REDEEM_ATTEMPT_SCOPE),
    (error: unknown) =>
      error instanceof BusinessError
      && error.statusCode === 429
      && error.message === '兑换码尝试过于频繁，请15分钟后再试',
  );
});

test('clearActionAttemptFailures: 成功后应只清理主体相关计数并保留纯 IP 维度', async (t) => {
  const storage = mockAttemptGuardRedis(t);

  for (let failureCount = 0; failureCount < 5; failureCount += 1) {
    await recordActionAttemptFailure(REDEEM_ATTEMPT_SCOPE);
  }

  await clearActionAttemptFailures(REDEEM_ATTEMPT_SCOPE);

  assert.equal(storage.has(REDEEM_SUBJECT_IP_FAILURE_KEY), false);
  assert.equal(storage.has(REDEEM_SUBJECT_FAILURE_KEY), false);
  assert.equal(storage.has(REDEEM_SUBJECT_IP_BLOCK_KEY), false);
  assert.equal(storage.has(REDEEM_SUBJECT_BLOCK_KEY), false);
  assert.equal(storage.get(REDEEM_IP_FAILURE_KEY), '5');
});
