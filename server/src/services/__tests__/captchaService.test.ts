/**
 * 图形验证码服务回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定图形验证码统一由 `captchaService` 生成、写入 Redis、校验并一次性消费，避免登录与注册各自复制验证码规则。
 * 2. 做什么：验证验证码错误、过期、重复提交都会被明确拒绝，确保服务端是唯一真值来源。
 * 3. 不做什么：不连接真实 Redis，不验证 HTTP 路由层参数组装，也不测试前端展示细节。
 *
 * 输入/输出：
 * - 输入：模拟的 Redis `set/get/del` 行为、生成后的 `captchaId` 与用户输入验证码。
 * - 输出：验证码创建结果，以及 `verifyCaptcha` 成功或抛出的业务错误。
 *
 * 数据流/状态流：
 * - 测试先用内存 Map 模拟 Redis；
 * - 再调用 `createCaptcha` 写入验证码记录；
 * - 最后通过 `verifyCaptcha` 断言“成功消费 / 失败消费 / 过期拒绝”三类状态流。
 *
 * 关键边界条件与坑点：
 * 1. 验证码必须一次性消费，因此无论校验成功还是失败，Redis 记录都必须删除，避免在登录与注册接口里重复维护重试口径。
 * 2. 过期判断必须基于服务端保存的过期时间，而不是依赖前端展示倒计时，避免客户端时间漂移导致规则不一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BusinessError } from '../../middleware/BusinessError.js';
import { redis } from '../../config/redis.js';
import { createCaptcha, verifyCaptcha } from '../captchaService.js';

type StoredCaptchaRecord = {
  answer: string;
  expiresAt: number;
};

const parseStoredCaptchaRecord = (raw: string | undefined): StoredCaptchaRecord => {
  assert.ok(raw, '应已写入验证码 Redis 记录');
  const parsed = JSON.parse(raw) as StoredCaptchaRecord;
  assert.equal(typeof parsed.answer, 'string');
  assert.equal(typeof parsed.expiresAt, 'number');
  return parsed;
};

test.after(() => {
  redis.disconnect();
});

test('createCaptcha: 应生成验证码图片并写入 Redis', async (t) => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'set', async (key: string, value: string, mode: string, ttl: number) => {
    storage.set(key, value);
    assert.equal(mode, 'EX');
    assert.equal(ttl, 300);
    return 'OK';
  });

  const now = Date.now();
  const result = await createCaptcha();

  assert.match(result.captchaId, /^[0-9a-f-]{36}$/i);
  assert.match(result.imageData, /^data:image\/svg\+xml;base64,/);
  assert.ok(result.expiresAt > now);

  const redisKey = `auth:captcha:${result.captchaId}`;
  const record = parseStoredCaptchaRecord(storage.get(redisKey));
  assert.equal(record.answer.length, 4);
  assert.ok(record.expiresAt >= result.expiresAt);
});

test('verifyCaptcha: 正确验证码应通过并消费 Redis 记录', async (t) => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'set', async (key: string, value: string) => {
    storage.set(key, value);
    return 'OK';
  });
  t.mock.method(redis, 'get', async (key: string) => storage.get(key) ?? null);
  t.mock.method(redis, 'del', async (...keys: string[]) => {
    let deleted = 0;
    keys.forEach((key) => {
      if (storage.delete(key)) {
        deleted += 1;
      }
    });
    return deleted;
  });

  const created = await createCaptcha();
  const key = `auth:captcha:${created.captchaId}`;
  const { answer } = parseStoredCaptchaRecord(storage.get(key));

  await verifyCaptcha(created.captchaId, answer.toLowerCase());

  assert.equal(storage.has(key), false);
});

test('verifyCaptcha: 错误验证码也应消费 Redis 记录并抛出业务错误', async (t) => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'set', async (key: string, value: string) => {
    storage.set(key, value);
    return 'OK';
  });
  t.mock.method(redis, 'get', async (key: string) => storage.get(key) ?? null);
  t.mock.method(redis, 'del', async (...keys: string[]) => {
    let deleted = 0;
    keys.forEach((key) => {
      if (storage.delete(key)) {
        deleted += 1;
      }
    });
    return deleted;
  });

  const created = await createCaptcha();
  const key = `auth:captcha:${created.captchaId}`;

  await assert.rejects(
    verifyCaptcha(created.captchaId, 'ZZZZ'),
    (error: unknown) =>
      error instanceof BusinessError && error.message === '图片验证码错误，请重新获取',
  );

  assert.equal(storage.has(key), false);
});

test('verifyCaptcha: 过期或不存在的验证码应被拒绝', async (t) => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'get', async (key: string) => storage.get(key) ?? null);
  t.mock.method(redis, 'del', async (...keys: string[]) => {
    let deleted = 0;
    keys.forEach((key) => {
      if (storage.delete(key)) {
        deleted += 1;
      }
    });
    return deleted;
  });

  storage.set(
    'auth:captcha:expired',
    JSON.stringify({
      answer: 'ABCD',
      expiresAt: Date.now() - 1_000,
    } satisfies StoredCaptchaRecord),
  );

  await assert.rejects(
    verifyCaptcha('missing', 'ABCD'),
    (error: unknown) =>
      error instanceof BusinessError && error.message === '图片验证码已失效，请重新获取',
  );

  await assert.rejects(
    verifyCaptcha('expired', 'ABCD'),
    (error: unknown) =>
      error instanceof BusinessError && error.message === '图片验证码已失效，请重新获取',
  );

  assert.equal(storage.has('auth:captcha:expired'), false);
});
