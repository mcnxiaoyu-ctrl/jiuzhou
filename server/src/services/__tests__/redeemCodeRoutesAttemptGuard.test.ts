/**
 * 兑换码路由防爆破测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定兑换码入口在连续失败达到阈值后会直接返回 429，避免后续改动把防爆破逻辑遗漏回 service 或前端。
 * 2. 做什么：验证命中锁定后不会继续调用兑换服务，确保真正减少爆破请求落到数据库与发奖链路。
 * 3. 不做什么：不验证真实兑换码发奖事务，不连接真实数据库，也不校验角色推送行为。
 *
 * 输入/输出：
 * - 输入：挂载了兑换码路由的最小 Express 应用、带登录态的请求头，以及固定失败的兑换服务 mock。
 * - 输出：标准 JSON 业务错误响应与兑换服务调用次数断言。
 *
 * 数据流/状态流：
 * - 测试先 mock 角色查询缓存所需的 Redis/数据库行为；
 * - 再 mock 兑换服务始终返回失败，让路由连续累积失败次数；
 * - 最后连续请求兑换接口并断言前 5 次业务失败、第 6 次直接被防爆破拦截。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“路由入口先做失败防护”，所以测试重点是第 6 次不会再进入 `redeemCodeService`，而不是兑换码表查询本身。
 * 2. 角色 ID 查询带有模块级缓存，测试要自己 mock Redis 读写并在结束时清理缓存，避免同进程其他测试被污染。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { type TestContext } from 'node:test';

import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';

import * as database from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import redeemCodeRoutes from '../../routes/redeemCodeRoutes.js';
import { redeemCodeService } from '../redeemCodeService.js';
import { invalidateCharacterIdByUserIdCache } from '../shared/characterId.js';

type JsonResponse = {
  status: number;
  body: {
    success: boolean;
    message: string;
  };
};

const TEST_USER_ID = 707;
const TEST_CHARACTER_ID = 1707;
const TEST_AUTH_TOKEN = jwt.sign(
  { id: TEST_USER_ID, username: 'redeem-guard-tester', sessionToken: 'redeem-guard-session' },
  process.env.JWT_SECRET || 'jiuzhou-xiuxian-secret-key',
);

const createRedeemCodeTestApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/redeem-code', redeemCodeRoutes);
  app.use(errorHandler);
  return app;
};

const startServer = async (app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};

const postRedeemCode = async (
  baseUrl: string,
  code: string,
): Promise<JsonResponse> => {
  const response = await fetch(`${baseUrl}/api/redeem-code/redeem`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });

  const body = (await response.json()) as JsonResponse['body'];
  return {
    status: response.status,
    body,
  };
};

const mockRedeemRouteRedis = (t: TestContext): void => {
  const storage = new Map<string, string>();

  t.mock.method(redis, 'get', async (key: string) => storage.get(key) ?? null);
  t.mock.method(redis, 'set', async (key: string, value: string, ..._rest: unknown[]) => {
    storage.set(key, value);
    return 'OK';
  });
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
};

test.after(() => {
  redis.disconnect();
});

test('兑换码入口连续失败达到阈值后第 6 次应直接返回 429', async (t) => {
  mockRedeemRouteRedis(t);

  t.mock.method(database, 'query', async (sql: string, _params?: readonly unknown[]) => {
    if (sql.includes('FROM characters')) {
      return { rows: [{ id: TEST_CHARACTER_ID }] };
    }
    throw new Error(`unexpected query in redeem route test: ${sql}`);
  });

  const redeemMock = t.mock.method(
    redeemCodeService,
    'redeemCode',
    async (_userId: number, _characterId: number, _code: string) => ({
      success: false,
      message: '兑换码不存在',
    }),
  );

  await invalidateCharacterIdByUserIdCache(TEST_USER_ID);
  const app = createRedeemCodeTestApp();
  const server = await startServer(app);

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postRedeemCode(server.baseUrl, 'INVALID-CODE');
      assert.equal(response.status, 400);
      assert.equal(response.body.success, false);
      assert.equal(response.body.message, '兑换码不存在');
    }

    const blockedResponse = await postRedeemCode(server.baseUrl, 'INVALID-CODE');
    assert.equal(blockedResponse.status, 429);
    assert.equal(blockedResponse.body.success, false);
    assert.equal(blockedResponse.body.message, '兑换码尝试过于频繁，请15分钟后再试');
    assert.equal(redeemMock.mock.callCount(), 5);
  } finally {
    await server.close();
    await invalidateCharacterIdByUserIdCache(TEST_USER_ID);
  }
});
