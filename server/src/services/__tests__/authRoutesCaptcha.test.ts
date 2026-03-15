/**
 * 鉴权路由验证码参数回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定登录与注册必须先提供图片验证码参数，避免在路由层遗漏校验后把同一规则拆到多个 service 里兜底。
 * 2. 做什么：验证缺少验证码参数时会被统一拦截，不会继续进入后续鉴权逻辑。
 * 3. 不做什么：不验证真实数据库登录注册流程，不覆盖验证码生成图片内容。
 *
 * 输入/输出：
 * - 输入：挂载了 `authRoutes` 的最小 Express 应用，以及缺少验证码参数的请求体。
 * - 输出：标准 JSON 业务错误响应。
 *
 * 数据流/状态流：
 * - 测试创建仅挂载鉴权路由与错误处理中间件的应用；
 * - 发送缺少验证码字段的登录/注册请求；
 * - 断言路由层在进入 service 前直接返回 400。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“路由入口必须校验完整参数”，不是 service 层兜底，因此测试不需要连真实数据库。
 * 2. 登录和注册都必须共享同一条验证码参数规则，避免一个入口拦截、另一个入口漏掉。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express, { type Express } from 'express';

import { redis } from '../../config/redis.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import authRoutes from '../../routes/authRoutes.js';

type JsonResponse = {
  status: number;
  body: {
    success: boolean;
    message: string;
  };
};

const createAuthTestApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
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

const postJson = async (
  baseUrl: string,
  path: string,
  payload: Record<string, string>,
): Promise<JsonResponse> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as JsonResponse['body'];
  return {
    status: response.status,
    body,
  };
};

test.after(() => {
  redis.disconnect();
});

test('登录与注册缺少图片验证码参数时应在路由层直接拦截', async () => {
  const app = createAuthTestApp();
  const server = await startServer(app);

  try {
    const loginResponse = await postJson(server.baseUrl, '/api/auth/login', {
      username: 'tester',
      password: '123456',
    });
    assert.equal(loginResponse.status, 400);
    assert.equal(loginResponse.body.success, false);
    assert.equal(loginResponse.body.message, '图片验证码不能为空');

    const registerResponse = await postJson(server.baseUrl, '/api/auth/register', {
      username: 'tester',
      password: '123456',
    });
    assert.equal(registerResponse.status, 400);
    assert.equal(registerResponse.body.success, false);
    assert.equal(registerResponse.body.message, '图片验证码不能为空');
  } finally {
    await server.close();
  }
});
